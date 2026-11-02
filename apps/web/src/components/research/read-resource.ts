import {
  classifyVertexFailure,
  VertexReadError,
  type VertexFailure,
} from "./vertex-client.ts";
import type { ResearchReadScope } from "./read-scope.tsx";

export type ReadState<Value> =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; value: Value }>
  | Readonly<{ type: "error"; failure: VertexFailure }>;

export interface ReadResource<Input, Value> {
  readonly getSnapshot: () => ReadState<Value>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: (input: Input) => Promise<void>;
  readonly clear: () => void;
}

// Request-local, memory-only state. No artifact is retained when a new read begins,
// when its input changes, or after an authorization/transport failure.
export const createReadResource = <Input, Value>(
  read: (input: Input, signal: AbortSignal) => Promise<Value>,
  timeoutMs = 12_000,
  scope?: ResearchReadScope
): ReadResource<Input, Value> => {
  let state: ReadState<Value> = { type: "idle" };
  let stateScopeRevision = scope?.getRevision();
  const suspended: ReadState<Value> = {
    type: "error",
    failure: classifyVertexFailure(new VertexReadError("suspended")),
  };
  let sequence = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ReadState<Value>): void => {
    state = next;
    stateScopeRevision = scope?.getRevision();
    for (const listener of listeners) listener();
  };
  const cancel = (): void => {
    sequence += 1;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    getSnapshot: () =>
      scope?.isCurrent() === false ||
      scope?.getRevision() !== stateScopeRevision
        ? suspended
        : state,
    subscribe: (listener) => {
      listeners.add(listener);
      const unsubscribeScope = scope?.subscribe(() => {
        cancel();
        return publish(suspended);
      });
      return () => {
        unsubscribeScope?.();
        return listeners.delete(listener);
      };
    },
    clear: () => {
      cancel();
      return publish({ type: "idle" });
    },
    load: async (input) => {
      cancel();
      if (scope?.isCurrent() === false) {
        publish(suspended);
        return;
      }
      const request = sequence;
      const scopeRevision = scope?.getRevision();
      const active = new AbortController();
      controller = active;
      publish({ type: "loading" });
      timer = setTimeout(() => {
        if (request !== sequence) return;
        cancel();
        return publish({
          type: "error",
          failure: classifyVertexFailure(new VertexReadError("unavailable")),
        });
      }, timeoutMs);
      try {
        const value = await read(input, active.signal);
        if (
          request !== sequence ||
          active.signal.aborted ||
          scope?.isCurrent() === false ||
          scope?.getRevision() !== scopeRevision
        )
          return;
        return publish({ type: "ready", value });
      } catch (error) {
        if (
          request !== sequence ||
          active.signal.aborted ||
          scope?.isCurrent() === false ||
          scope?.getRevision() !== scopeRevision
        )
          return;
        const failure = classifyVertexFailure(error);
        if (failure.kind === "unauthorized") scope?.invalidate();
        return publish({ type: "error", failure });
      } finally {
        if (request === sequence) {
          clearTimeout(timer);
          timer = undefined;
          controller = undefined;
        }
      }
    },
  };
};
