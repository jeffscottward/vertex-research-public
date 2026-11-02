import type {
  NotificationNotSentReason,
  NotificationResult,
} from "../index.ts";
import {
  dataRecord,
  isTimestamp,
  MAX_NOTIFICATION_TTL_MS,
  snapshotNotificationRequest,
} from "../validation.ts";
import type {
  NotificationGrant,
  NotificationMessage,
  NotificationOutcomeInput,
  NotificationProviderOutcome,
  NotificationService,
  NotificationServiceOptions,
} from "./contracts.ts";
import {
  boundedCall,
  digest,
  snapshotAdmission,
  snapshotGrant,
  snapshotProviderOutcome,
  validTimeout,
} from "./safety.ts";

const notSent = (reason: NotificationNotSentReason): NotificationResult => {
  return Object.freeze({
    status: "not-sent",
    reason,
    receipt: "unconfirmed",
    retryable: false,
  });
};

export const createNotificationService = <Context>(
  options: NotificationServiceOptions<Context>
): NotificationService<Context> => {
  const enabled = options.enabled === true;
  const timeoutMs = options.timeoutMs ?? 5000;
  const clock = options.now ?? Date.now;
  const resolver = options.resolver;
  const store = options.store;
  const adapters = Object.freeze({ ...options.adapters });

  return Object.freeze({
    notify: async (
      context: Context,
      input: unknown
    ): Promise<NotificationResult> => {
      let dispatched = false;
      try {
        const request = snapshotNotificationRequest(input);
        if (!request) return notSent("invalid-request");
        if (!enabled) return notSent("disabled");
        if (!(validTimeout(timeoutMs) && resolver && store)) {
          return notSent("unavailable");
        }
        const startedAt = clock();
        if (!isTimestamp(startedAt)) return notSent("unavailable");
        if (request.expiresAt <= startedAt) return notSent("expired");
        if (request.expiresAt - startedAt > MAX_NOTIFICATION_TTL_MS) {
          return notSent("invalid-request");
        }

        const selector = Object.freeze({
          recipientRef: request.recipientRef,
          channel: request.channel,
          purpose: request.purpose,
        });
        const resolved = await boundedCall(
          (signal) => resolver.resolve(context, selector, signal),
          Math.min(timeoutMs, request.expiresAt - startedAt)
        );
        if (!resolved.ok) return notSent("unavailable");
        const grant = snapshotGrant(resolved.value);
        if (
          !grant ||
          grant.recipientRef !== request.recipientRef ||
          grant.channel !== request.channel ||
          grant.purpose !== request.purpose
        ) {
          return notSent("denied");
        }
        if (!grant.enabled) return notSent("disabled");
        const deadline = Math.min(request.expiresAt, grant.expiresAt);
        const resolvedAt = clock();
        if (!isTimestamp(resolvedAt) || resolvedAt < startedAt)
          return notSent("unavailable");
        if (deadline <= resolvedAt) return notSent("expired");

        const adapter = adapters[request.channel];
        if (!adapter) return notSent("unavailable");
        const preparation = await boundedCall(
          (signal) => adapter.prepare(grant, signal),
          Math.min(timeoutMs, deadline - resolvedAt)
        );
        if (!preparation.ok) return notSent("unavailable");
        const unavailable = dataRecord(preparation.value, ["status"]);
        if (unavailable?.["status"] === "disabled") return notSent("disabled");
        const ready = dataRecord(preparation.value, ["status", "send"]);
        if (
          ready?.["status"] !== "ready" ||
          typeof ready["send"] !== "function"
        ) {
          return notSent("unavailable");
        }
        const send = ready["send"] as (
          message: NotificationMessage,
          signal: AbortSignal
        ) => Promise<NotificationProviderOutcome>;
        const scope = Object.freeze({
          tenantKey: grant.tenantKey,
          recipientKey: grant.recipientKey,
          channel: grant.channel,
          purpose: grant.purpose,
        });
        // Fingerprint excludes dryRun and mutable grant/config/cooldown state. The
        // same logical recipient reached by different aliases still deduplicates.
        const fingerprint = await digest(
          JSON.stringify([request.title, request.body, request.expiresAt])
        );
        const providerIdempotencyKey = await digest(
          JSON.stringify([
            scope.tenantKey,
            scope.recipientKey,
            scope.channel,
            scope.purpose,
            request.idempotencyKey,
          ])
        );
        const attemptId = crypto.randomUUID();
        const admittedAt = clock();
        if (!isTimestamp(admittedAt) || admittedAt < resolvedAt)
          return notSent("unavailable");
        if (deadline <= admittedAt) return notSent("expired");
        const admissionResult = await boundedCall(
          () =>
            store.admit(
              Object.freeze({
                scope,
                idempotencyKey: request.idempotencyKey,
                fingerprint,
                attemptId,
                now: admittedAt,
                expiresAt: deadline,
                cooldownMs: grant.cooldownMs,
                mode: request.dryRun ? "observe" : "commit",
              })
            ),
          Math.min(timeoutMs, deadline - admittedAt)
        );
        // A store timeout may still have committed pending. Never dispatch without
        // the confirmed reservation, never release/retry it speculatively.
        if (!admissionResult.ok) return notSent("unavailable");
        const admission = snapshotAdmission(admissionResult.value);
        if (!admission) return notSent("unavailable");
        if (admission.status === "duplicate") return notSent("duplicate");
        if (admission.status === "conflict")
          return notSent("idempotency-conflict");
        if (admission.status === "cooldown") return notSent("cooldown");
        if (admission.status === "expired") return notSent("expired");
        if (request.dryRun) {
          if (admission.status !== "eligible") return notSent("unavailable");
          const observedAt = clock();
          if (!isTimestamp(observedAt) || observedAt < admittedAt)
            return notSent("unavailable");
          if (deadline <= observedAt) return notSent("expired");
          return Object.freeze({
            status: "dry-run",
            receipt: "unconfirmed",
            retryable: false,
          });
        }
        if (
          admission.status !== "admitted" ||
          admission.attemptId !== attemptId
        ) {
          return notSent("unavailable");
        }

        const record = async (
          outcomeAcceptance: NotificationOutcomeInput["acceptance"]
        ): Promise<"recorded" | "uncertain"> => {
          const finishedAt = clock();
          if (!isTimestamp(finishedAt) || finishedAt < admittedAt)
            return "uncertain";
          const recorded = await boundedCall(
            () =>
              store.recordOutcome(
                Object.freeze({
                  scope,
                  idempotencyKey: request.idempotencyKey,
                  attemptId,
                  acceptance: outcomeAcceptance,
                  now: finishedAt,
                })
              ),
            timeoutMs
          );
          const result = recorded.ok
            ? dataRecord(recorded.value, ["status"])
            : undefined;
          return result?.["status"] === "recorded" ? "recorded" : "uncertain";
        };

        const beforeSend = clock();
        if (!isTimestamp(beforeSend) || beforeSend < admittedAt) {
          await record("not-sent");
          return notSent("unavailable");
        }
        if (deadline <= beforeSend) {
          await record("not-sent");
          return notSent("expired");
        }
        // Refresh current authorization after potentially slow persistence work.
        // Resolver is side-effect-free and MUST observe revocation. Any changed
        // destination/policy requires a new request, not an implicit redirect.
        const refreshed = await boundedCall(
          (signal) => resolver.resolve(context, selector, signal),
          Math.min(timeoutMs, deadline - beforeSend)
        );
        const fresh: NotificationGrant | undefined = refreshed.ok
          ? snapshotGrant(refreshed.value)
          : undefined;
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(grant)) {
          await record("not-sent");
          return notSent(refreshed.ok ? "denied" : "unavailable");
        }
        const dispatchAt = clock();
        if (!isTimestamp(dispatchAt) || dispatchAt < beforeSend) {
          await record("not-sent");
          return notSent("unavailable");
        }
        if (deadline <= dispatchAt) {
          await record("not-sent");
          return notSent("expired");
        }

        dispatched = true;
        const delivery = await boundedCall(
          (signal) =>
            send(
              Object.freeze({
                title: request.title,
                body: request.body,
                providerIdempotencyKey,
              }),
              signal
            ),
          Math.min(timeoutMs, deadline - dispatchAt)
        );
        const outcome = delivery.ok
          ? snapshotProviderOutcome(delivery.value)
          : undefined;
        const acceptance = outcome?.acceptance ?? "unknown";
        const persistence = await record(acceptance);
        if (acceptance === "not-sent") return notSent("unavailable");
        return Object.freeze({
          status: acceptance,
          persistence,
          receipt: "unconfirmed",
          retryable: false,
        });
      } catch {
        // Never propagate exception text, request content, endpoint or secret.
        if (dispatched) {
          return Object.freeze({
            status: "unknown",
            persistence: "uncertain",
            receipt: "unconfirmed",
            retryable: false,
          });
        }
        return notSent("unavailable");
      }
    },
  });
};
