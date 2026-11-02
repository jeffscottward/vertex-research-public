import type {
  EventEnvelope,
  PaperAdmission,
  NativeBootstrapCommand,
  WorkerLease,
  WorkerKind,
  WorkerClaimInput,
  WorkerClaimOutput,
  VertexWorkerBindingSelection,
  VertexNotificationSelection,
  VertexWorkerBoundaryValues,
  VertexWorkerDispatchBoundary,
} from "./contracts.ts";
import type {
  VertexOutboxLease,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import type {
  NotificationDispatch,
  NotificationDispatchEvent,
} from "@darkfactory/notifications/server/dispatch";

export type VertexWorkerCommand =
  | Readonly<{ kind: "queued-agent"; event: EventEnvelope }>
  | Readonly<{ kind: "paper-admission"; admission: PaperAdmission }>
  | Readonly<{ kind: "native-bootstrap"; bootstrap: NativeBootstrapCommand }>;
export type {
  VertexWorkerBindingSelection,
  VertexNotificationSelection,
} from "./contracts.ts";
export type VertexWorkerBindingResolver = (
  input: Readonly<{
    identity: WorkerServiceIdentity;
    lease: VertexOutboxLease;
    command: VertexWorkerCommand;
    signal: AbortSignal;
  }>
) => Promise<VertexWorkerBindingSelection | null>;
export type VertexWorkerDispatcherDependencies<Context> = Readonly<{
  boundary: VertexWorkerDispatchBoundary;
  outboxStore: Pick<VertexStore, "claimOutbox" | "settleOutbox">;
  workerStore: Pick<VertexWorkerStore, "bindOutbox">;
  // Required configuration. No default policy head, role-to-task mapping,
  // artifact ID, deadline, research principal or execution grant is invented.
  resolveBinding: VertexWorkerBindingResolver;
  notifications?: Readonly<{
    dispatch: NotificationDispatch<Context>;
    contextFor: (
      identity: WorkerServiceIdentity,
      lease: VertexOutboxLease
    ) => Context;
    select: (
      input: Readonly<{
        identity: WorkerServiceIdentity;
        lease: VertexOutboxLease;
        event: EventEnvelope;
        signal: AbortSignal;
      }>
    ) => Promise<VertexNotificationSelection | null>;
    dryRun: boolean;
  }>;
  clock: Readonly<{ now: () => string }>;
}>;
export type VertexWorkerDispatchOutcome = Readonly<{
  eventId: string;
  status:
    | "admitted"
    | "already-admitted"
    | "terminal"
    | "unknown"
    | "rejected"
    | "unavailable"
    | "notification-handled"
    | "notification-unknown";
  settled: boolean;
  // Outbox published is an admission/handling ACK, NEVER engine completion.
  lease: WorkerLease | null;
}>;
export type VertexWorkerDispatchOptions = Readonly<{
  workerInstanceId: string;
  kinds: readonly WorkerKind[];
  signal?: AbortSignal;
}>;
export type VertexWorkerDispatcher = Readonly<{
  claim: (
    identity: WorkerServiceIdentity,
    input: WorkerClaimInput,
    options?: Readonly<{ signal?: AbortSignal }>
  ) => Promise<WorkerClaimOutput>;
  dispatchClaimed: (
    identity: WorkerServiceIdentity,
    lease: VertexOutboxLease,
    options: VertexWorkerDispatchOptions
  ) => Promise<VertexWorkerDispatchOutcome>;
}>;
export class VertexWorkerDispatchError extends Error {
  readonly code: "denied" | "invalid" | "unavailable";
  constructor(code: VertexWorkerDispatchError["code"]) {
    super(`Worker dispatch ${code}`);
    this.name = "VertexWorkerDispatchError";
    this.code = code;
  }
}

const sameScope = (
  left: { accountAlias: string; environment: string },
  right: { accountAlias: string; environment: string }
): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
const outcome = (
  lease: VertexOutboxLease,
  status: VertexWorkerDispatchOutcome["status"],
  settled = false,
  workerLease: WorkerLease | null = null
): VertexWorkerDispatchOutcome =>
  Object.freeze({
    eventId: lease.eventId,
    status,
    settled,
    lease: workerLease,
  });

export const createVertexWorkerDispatcher = <Context>(
  dependencies: VertexWorkerDispatcherDependencies<Context>
): VertexWorkerDispatcher => {
  const parse = <Name extends keyof VertexWorkerBoundaryValues>(
    name: Name,
    value: unknown
  ): VertexWorkerBoundaryValues[Name] =>
    dependencies.boundary.validate(
      name,
      value
    ) as VertexWorkerBoundaryValues[Name];
  const hashArtifact = dependencies.boundary.hash;
  const timestampToEpochNanoseconds = dependencies.boundary.epochNanoseconds;
  const nowAt = (
    clock: VertexWorkerDispatcherDependencies<unknown>["clock"]
  ): string => {
    try {
      return parse("Timestamp", clock.now());
    } catch {
      throw new VertexWorkerDispatchError("unavailable");
    }
  };
  const future = (timestamp: string, at: string): boolean =>
    timestampToEpochNanoseconds(timestamp) > timestampToEpochNanoseconds(at);
  const capturedIdentity = (
    identity: WorkerServiceIdentity,
    at: string
  ): VertexWorkerBoundaryValues["WorkerServiceIdentity"] => {
    try {
      const result = parse("WorkerServiceIdentity", identity);
      if (!future(result.expiresAt, at))
        throw new VertexWorkerDispatchError("denied");
      // Preserve the exact DB-issued capability through claim and bindOutbox.
      // The validated view narrows scope but is NOT a replacement credential.
      return identity as VertexWorkerBoundaryValues["WorkerServiceIdentity"];
    } catch {
      throw new VertexWorkerDispatchError("denied");
    }
  };
  // Only existing command shapes are candidates. Recorded results are not
  // commands, so terminal AgentRun events can never start another run.
  const commandFor = async (
    lease: VertexOutboxLease
  ): Promise<
    Readonly<{
      command: VertexWorkerCommand | null;
      event: EventEnvelope | null;
    }>
  > => {
    if (lease.eventType === "vertex.native-bootstrap.requested") {
      const bootstrap = parse("WorkerBootstrapCommand", lease.payload);
      if (
        lease.scope.environment !== "paper" ||
        !sameScope(bootstrap, lease.scope) ||
        lease.eventId !== `bootstrap-${await hashArtifact(bootstrap)}`
      )
        throw new VertexWorkerDispatchError("invalid");
      if (
        bootstrap.payloadSha256 !== (await hashArtifact(bootstrap["payload"]))
      )
        throw new VertexWorkerDispatchError("invalid");
      return { command: { kind: "native-bootstrap", bootstrap }, event: null };
    }
    if (lease.eventType === "vertex.paper-simulation.admitted") {
      const admission = parse("PaperSimulationAdmission", lease.payload);
      if (
        lease.scope.environment !== "paper" ||
        !sameScope(admission, lease.scope) ||
        lease.eventId !== `simulation-${await hashArtifact(admission)}`
      )
        throw new VertexWorkerDispatchError("invalid");
      return { command: { kind: "paper-admission", admission }, event: null };
    }
    const event = parse("EventEnvelope", lease.payload);
    const {
      eventId: omittedId,
      receivedAt: omittedReceived,
      ...eventIdentity
    } = event;
    if (
      event.eventId !== `event-${await hashArtifact(eventIdentity)}` ||
      event.eventId !== lease.eventId ||
      event.eventType !== lease.eventType ||
      event.environment !== lease.scope.environment
    )
      throw new VertexWorkerDispatchError("invalid");
    const payload = event.payload;
    if (
      (payload["accountAlias"] !== undefined &&
        payload["accountAlias"] !== lease.scope.accountAlias) ||
      (payload["collectionId"] !== undefined &&
        payload["collectionId"] !== lease.collectionId)
    )
      throw new VertexWorkerDispatchError("invalid");
    if (
      event.eventType === "agent.recorded" &&
      event.payload["status"] === "queued"
    ) {
      return { command: { kind: "queued-agent", event }, event };
    }
    return { command: null, event };
  };
  // No timer, scheduler registration, claim loop, provider client or second
  // queue. The existing server control route calls this bounded dispatcher once.
  const dispatchClaimed: VertexWorkerDispatcher["dispatchClaimed"] = async (
    rawIdentity,
    rawLease,
    options
  ) => {
    const initialAt = nowAt(dependencies.clock);
    const identity = capturedIdentity(rawIdentity, initialAt);
    let lease: VertexOutboxLease;
    try {
      lease = parse("VertexOutboxLease", rawLease);
    } catch {
      throw new VertexWorkerDispatchError("invalid");
    }
    const signal = options.signal ?? new AbortController().signal;
    if (
      !sameScope(identity.scope, lease.scope) ||
      lease.leaseOwner !== options.workerInstanceId
    )
      throw new VertexWorkerDispatchError("denied");
    if (signal.aborted || !future(lease.leaseExpiresAt, initialAt))
      return outcome(lease, "unavailable");
    let classified: Awaited<ReturnType<typeof commandFor>>;
    try {
      classified = await commandFor(lease);
    } catch {
      return outcome(lease, "rejected");
    }
    const principal = Object.freeze({ actorId: identity.servicePrincipalId });
    const settle = async (): Promise<boolean> => {
      try {
        // Exact original owner/fence, never a newly generated owner, epoch or
        // delivery key. The store reauthorizes and fences this ACK transaction.
        return await dependencies.outboxStore.settleOutbox(
          principal,
          identity.scope,
          {
            eventId: lease.eventId,
            leaseOwner: lease.leaseOwner,
            leaseFence: lease.leaseFence,
            result: "published",
            availableAt: nowAt(dependencies.clock),
          }
        );
      } catch {
        return false;
      }
    };
    if (classified.command === null) {
      if (!(classified.event && dependencies.notifications))
        return outcome(lease, "unavailable");
      const notification = dependencies.notifications;
      let selected: VertexNotificationSelection;
      let context: Context;
      try {
        const candidate = await notification.select({
          identity,
          lease,
          event: classified.event,
          signal,
        });
        if (candidate === null) return outcome(lease, "unavailable");
        selected = parse("WorkerNotificationSelection", candidate);
        context = notification.contextFor(identity, lease);
      } catch {
        return outcome(lease, "unavailable");
      }
      const at = nowAt(dependencies.clock);
      if (
        signal.aborted ||
        !future(lease.leaseExpiresAt, at) ||
        !future(identity.expiresAt, at)
      )
        return outcome(lease, "unavailable");
      const event: NotificationDispatchEvent = Object.freeze({
        eventId: lease.eventId,
        accountAlias: identity.scope.accountAlias,
        environment: identity.scope.environment,
        kind: selected.kind,
        occurredAt: classified.event.occurredAt,
        expiresAt: selected.expiresAt,
      });
      try {
        // Handler admission has its own durable no-retry tombstone. This path
        // never binds a native lease, and never copies raw event text to alerts.
        const result = await notification.dispatch.handle(context, event, {
          dryRun: notification.dryRun,
          signal,
        });
        const settled = notification.dryRun ? false : await settle();
        return outcome(
          lease,
          result.status === "unavailable"
            ? "notification-unknown"
            : "notification-handled",
          settled
        );
      } catch {
        // An exception after provider admission is unknown, not retryable. Even
        // if ACK is lost, the same handler's durable tombstone prevents resend.
        return outcome(
          lease,
          "notification-unknown",
          notification.dryRun ? false : await settle()
        );
      }
    }
    let selected: VertexWorkerBindingSelection;
    try {
      const candidate = await dependencies.resolveBinding({
        identity,
        lease,
        command: classified.command,
        signal,
      });
      if (candidate === null) return outcome(lease, "unavailable");
      selected = parse("WorkerDispatchSelection", candidate);
    } catch {
      return outcome(lease, "unavailable");
    }
    const command = classified.command;
    const actorId =
      command.kind === "queued-agent"
        ? command.event.actorId
        : command.kind === "paper-admission"
          ? command.admission.actorId
          : command.bootstrap.researchPrincipalId;
    if (
      selected.researchPrincipalId !== actorId ||
      (command.kind === "paper-admission") !==
        (selected.kind === "paper-simulation") ||
      (command.kind === "native-bootstrap") !==
        (selected.kind === "native-bootstrap")
    )
      return outcome(lease, "rejected");
    if (command.kind === "native-bootstrap") {
      for (const field of [
        "payloadArtifactId",
        "payloadSha256",
        "policySelectionId",
        "policySelectionSha256",
        "deadlineAt",
      ] as const) {
        if (selected[field] !== command.bootstrap[field])
          return outcome(lease, "rejected");
      }
    }
    if (!options.kinds.includes(selected.kind))
      return outcome(lease, "unavailable");
    if (
      command.kind === "paper-admission" &&
      timestampToEpochNanoseconds(selected.deadlineAt) >
        timestampToEpochNanoseconds(command.admission.expiresAt)
    )
      return outcome(lease, "rejected");
    const beforeBind = nowAt(dependencies.clock);
    if (
      command.kind === "native-bootstrap" &&
      timestampToEpochNanoseconds(command.bootstrap.issuedAt) >
        timestampToEpochNanoseconds(beforeBind)
    )
      return outcome(lease, "rejected");
    if (
      signal.aborted ||
      !future(identity.expiresAt, beforeBind) ||
      !future(lease.leaseExpiresAt, beforeBind)
    )
      return outcome(lease, "unavailable");
    if (!future(selected.deadlineAt, beforeBind))
      return outcome(lease, "rejected");
    try {
      // DB derives stable job identity from scoped event+immutable selection,
      // rechecks current grant/scope, and binds this exact outbox owner/fence.
      // bindOutbox is admission only. It may reconcile but NEVER reruns effects.
      const result = parse(
        "WorkerResult",
        await dependencies.workerStore.bindOutbox(identity, lease, {
          ...selected,
          workerInstanceId: options.workerInstanceId,
        })
      );
      if (result.status === "rejected") return outcome(lease, "rejected");
      const bound = result.lease;
      const runnable =
        (result.status === "accepted" || result.status === "duplicate") &&
        result.state === "leased" &&
        bound !== null;
      if (
        runnable &&
        bound !== null &&
        (bound.jobId !== result.jobId ||
          bound.eventId !== lease.eventId ||
          !sameScope(bound, identity.scope) ||
          bound.leaseId !== lease.leaseOwner ||
          bound.leaseEpoch !== lease.leaseFence ||
          bound.kind !== selected.kind ||
          bound.researchPrincipalId !== selected.researchPrincipalId ||
          bound.payloadArtifactId !== selected.payloadArtifactId ||
          bound.payloadSha256 !== selected.payloadSha256 ||
          bound.policySelectionId !== selected.policySelectionId ||
          bound.policySelectionSha256 !== selected.policySelectionSha256 ||
          bound.deadlineAt !== selected.deadlineAt ||
          timestampToEpochNanoseconds(bound.leaseExpiresAt) >
            timestampToEpochNanoseconds(lease.leaseExpiresAt) ||
          !future(bound.leaseExpiresAt, nowAt(dependencies.clock)))
      )
        return outcome(lease, "unknown");
      // Running/unknown/completed duplicate binding is never a runnable lease.
      // ACK those stable receipts too, so no automatic rearm can occur.
      const settled = await settle();
      if (!settled) return outcome(lease, "unknown");
      const afterAck = nowAt(dependencies.clock);
      if (
        signal.aborted ||
        !future(identity.expiresAt, afterAck) ||
        (bound !== null && !future(bound.leaseExpiresAt, afterAck))
      )
        return outcome(lease, "unknown", true);
      if (runnable)
        return outcome(
          lease,
          result.status === "duplicate" ? "already-admitted" : "admitted",
          true,
          bound
        );
      return outcome(
        lease,
        result.status === "completed" ? "terminal" : "unknown",
        true
      );
    } catch {
      // No engine call happened here. A future explicit claim may reconcile the
      // idempotent DB admission, but must not reset running/expired/unknown jobs.
      return outcome(lease, "unknown");
    }
  };
  const claim: VertexWorkerDispatcher["claim"] = async (
    rawIdentity,
    rawInput,
    options = {}
  ) => {
    const input = parse("WorkerClaimInput", rawInput);
    const at = nowAt(dependencies.clock);
    const identity = capturedIdentity(rawIdentity, at);
    if (!sameScope(identity.scope, input))
      throw new VertexWorkerDispatchError("denied");
    if (options.signal?.aborted) return { status: "rejected", leases: [] };
    const atNs = timestampToEpochNanoseconds(at);
    const expiresNs = atNs + BigInt(input.leaseDurationMs) * 1_000_000n;
    // The worker grant bounds admission as well as every subsequent operation.
    const ceilingNs = timestampToEpochNanoseconds(identity.expiresAt);
    const leaseNs = expiresNs < ceilingNs ? expiresNs : ceilingNs;
    const milliseconds = Number(
      leaseNs / 1_000_000n -
        (leaseNs < 0n && leaseNs % 1_000_000n !== 0n ? 1n : 0n)
    );
    const leaseExpiresAt = new Date(milliseconds).toISOString();
    if (!future(leaseExpiresAt, at)) return { status: "rejected", leases: [] };
    let rows: readonly VertexOutboxLease[];
    try {
      rows = await dependencies.outboxStore.claimOutbox(
        { actorId: identity.servicePrincipalId },
        identity.scope,
        {
          leaseOwner: input.workerInstanceId,
          limit: input.limit,
          leaseExpiresAt,
        }
      );
    } catch {
      throw new VertexWorkerDispatchError("unavailable");
    }
    if (!Array.isArray(rows) || rows.length > input.limit)
      throw new VertexWorkerDispatchError("unavailable");
    const leases: WorkerLease[] = [];
    const events = new Set<string>();
    let blocked = false;
    for (const row of rows) {
      if (events.has(row.eventId))
        throw new VertexWorkerDispatchError("unavailable");
      events.add(row.eventId);
      const result = await dispatchClaimed(identity, row, {
        workerInstanceId: input.workerInstanceId,
        kinds: input.kinds,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (
        ["unavailable", "rejected", "unknown", "notification-unknown"].includes(
          result.status
        )
      )
        blocked = true;
      if (result.lease !== null) leases.push(result.lease);
    }
    return parse("WorkerClaimOutput", {
      status: blocked && leases.length === 0 ? "rejected" : "accepted",
      leases,
    });
  };
  return Object.freeze({ claim, dispatchClaimed });
};
