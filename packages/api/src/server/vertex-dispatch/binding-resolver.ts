import type {
  VertexWorkerBindingSelection,
  VertexWorkerBoundaryValues,
  VertexWorkerDispatchBoundary,
  WorkerScope,
} from "./contracts.ts";
import {
  VertexWorkerDispatchError,
  type VertexWorkerBindingResolver,
  type VertexWorkerCommand,
} from "./dispatcher.ts";

export type VertexWorkerConfiguredPin = Readonly<{
  scope: WorkerScope;
  eventId: string;
  commandSha256: string;
  binding: VertexWorkerBindingSelection;
}>;
export type VertexWorkerPinnedBindingOptions = Readonly<{
  boundary: VertexWorkerDispatchBoundary;
  pins: readonly VertexWorkerConfiguredPin[];
}>;
const key = (scope: WorkerScope, eventId: string): string =>
  JSON.stringify([scope.accountAlias, scope.environment, eventId]);

// The immutable command hash excludes only consumer-local receivedAt. Its event
// ID already commits every producer field. Paper admission is a separate real
// command, not a fabricated public envelope or a hash of its worker bundle.
// command must already have passed the injected authoritative event/admission
// validator (the dispatcher guarantees this before calling its resolver).
export const hashVertexWorkerCommand = async (
  boundary: VertexWorkerDispatchBoundary,
  command: VertexWorkerCommand
): Promise<string> => {
  if (command.kind === "paper-admission")
    return await boundary.hash({
      kind: command.kind,
      admission: command.admission,
    });
  if (command.kind === "native-bootstrap")
    return await boundary.hash({
      kind: command.kind,
      bootstrap: command.bootstrap,
    });
  const { receivedAt: omittedReceived, ...event } = command.event;
  return await boundary.hash({ kind: command.kind, event });
};

export const createVertexWorkerPinnedBindingResolver = (
  options: VertexWorkerPinnedBindingOptions
): VertexWorkerBindingResolver => {
  if (!Array.isArray(options.pins) || options.pins.length > 512)
    throw new VertexWorkerDispatchError("invalid");
  const boundary = Object.freeze({ ...options.boundary });
  const parse = <Name extends keyof VertexWorkerBoundaryValues>(
    name: Name,
    value: unknown
  ): VertexWorkerBoundaryValues[Name] =>
    boundary.validate(name, value) as VertexWorkerBoundaryValues[Name];
  const pinned = new Map<
    string,
    Readonly<{ commandSha256: string; binding: VertexWorkerBindingSelection }>
  >();
  for (const input of options.pins) {
    // Trusted server configuration is snapshotted once. Duplicate exact keys
    // are configuration conflicts, never last-writer-wins policy selection.
    const scope = parse("WorkerScope", input.scope);
    const eventId = parse("Identifier", input.eventId);
    const commandSha256 = parse("Digest", input.commandSha256);
    const binding = parse("WorkerDispatchSelection", input.binding);
    const identity = key(scope, eventId);
    if (pinned.has(identity)) throw new VertexWorkerDispatchError("invalid");
    pinned.set(identity, Object.freeze({ commandSha256, binding }));
  }
  return async ({ identity, lease, command, signal }) => {
    if (signal.aborted) return null;
    const scope = parse("WorkerScope", lease.scope);
    if (
      identity.scope.accountAlias !== scope.accountAlias ||
      identity.scope.environment !== scope.environment
    )
      throw new VertexWorkerDispatchError("denied");
    const selected = pinned.get(key(scope, lease.eventId));
    if (!selected) return null;
    if (
      (await hashVertexWorkerCommand(boundary, command)) !==
      selected.commandSha256
    )
      throw new VertexWorkerDispatchError("invalid");
    if (signal.aborted) return null;
    return selected.binding;
  };
};
