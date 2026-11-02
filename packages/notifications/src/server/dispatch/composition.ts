import type { NotificationPurpose, NotificationResult } from "../../index.ts";
import { snapshotNotificationResult } from "../../validation.ts";
import type {
  NotificationAdapter,
  NotificationGrant,
  NotificationPreparation,
  NotificationMessage,
  NotificationProviderOutcome,
} from "../contracts.ts";
import { createNotificationService } from "../service.ts";
import { createNtfyNotificationAdapter } from "../ntfy.ts";
import { createEmailNotificationAdapter } from "../email.ts";
import { boundedCall, validTimeout } from "../safety.ts";
import type {
  NotificationDispatch,
  NotificationDispatchFactoryOptions,
  NotificationDispatchResult,
  NotificationRecipientGrant,
} from "./contracts.ts";
import {
  notificationEpochMilliseconds,
  notificationEventKey,
  notificationFields,
  notificationMilliseconds,
  snapshotNotificationDispatchEvent,
  snapshotNotificationRecipientGrant,
} from "./validation.ts";

// Approved fixed templates. Event text, symbols, documents, portfolio values,
// account labels, destinations and URLs are never interpolated into a message.
const templates = Object.freeze({
  "market-alert": Object.freeze({
    purpose: "market-alert" as NotificationPurpose,
    title: "Market research alert",
    body: "An informational market research alert is available in Vertex. Open the application to review it. This is not an instruction to trade.",
  }),
  "research-completed": Object.freeze({
    purpose: "research-update" as NotificationPurpose,
    title: "Research update",
    body: "A research task has completed. Open Vertex to review the results. No trading action has been authorized.",
  }),
  "research-failed": Object.freeze({
    purpose: "research-update" as NotificationPurpose,
    title: "Research needs attention",
    body: "A research task could not complete. Open Vertex to review its status. No trading action has been authorized.",
  }),
  "operational-alert": Object.freeze({
    purpose: "operational-alert" as NotificationPurpose,
    title: "Vertex needs attention",
    body: "An operational event requires review. Open Vertex to review its status. This notification does not authorize an account or trading action.",
  }),
});
const stopped = (
  reason: Exclude<NotificationDispatchResult["reason"], "processed">
): NotificationDispatchResult =>
  Object.freeze({
    status:
      reason === "unavailable" || reason === "cancelled"
        ? "unavailable"
        : "rejected",
    reason,
    retryable: false,
    results: Object.freeze([]),
  });
const same = (
  left: NotificationRecipientGrant,
  right: NotificationRecipientGrant
): boolean => JSON.stringify(left) === JSON.stringify(right);
const legacyGrant = (value: NotificationRecipientGrant): NotificationGrant =>
  Object.freeze({
    authenticated: true,
    tenantKey: value.tenantKey,
    recipientKey: value.recipientKey,
    recipientRef: value.recipientRef,
    channel: value.channel,
    purpose: value.purpose,
    configurationRef: value.configurationRef,
    enabled: true,
    expiresAt: value.expiresAt,
    cooldownMs: value.cooldownMs,
  });

// No polling, second outbox, fallback channel, provider probing or automatic
// retry. Register this one handler in the existing durable control dispatcher.
export const createNotificationDispatch = <Context>(
  options: NotificationDispatchFactoryOptions<Context>
): NotificationDispatch<Context> => {
  const enabled = options.enabled === true;
  const timeoutMs = options.timeoutMs ?? 5000;
  return Object.freeze<NotificationDispatch<Context>>({
    handle: async (
      context,
      rawEvent,
      rawOptions
    ): Promise<NotificationDispatchResult> => {
      if (!enabled) return stopped("disabled");
      let event: ReturnType<typeof snapshotNotificationDispatchEvent>;
      let mode: ReturnType<typeof notificationFields>;
      try {
        event = snapshotNotificationDispatchEvent(rawEvent);
        mode = notificationFields(rawOptions, ["dryRun", "signal"]);
        if (
          typeof mode["dryRun"] !== "boolean" ||
          !(mode["signal"] instanceof AbortSignal)
        )
          return stopped("invalid-event");
      } catch {
        return stopped("invalid-event");
      }
      const signal = mode["signal"] as AbortSignal;
      const dryRun = mode["dryRun"] as boolean;
      if (signal.aborted) return stopped("cancelled");
      if (
        !(
          validTimeout(timeoutMs) &&
          options.grants &&
          options.store &&
          options.configurations
        ) ||
        typeof options.clock?.now !== "function"
      )
        return stopped("unavailable");
      try {
        const started = notificationMilliseconds(options.clock.now());
        const expiresAt = notificationEpochMilliseconds(event.expiresAt);
        if (expiresAt <= started) return stopped("expired");
        if (
          notificationEpochMilliseconds(event.occurredAt) > started ||
          expiresAt - started > 86_400_000
        )
          return stopped("invalid-event");
        const template = templates[event.kind];
        const budget = Math.min(30_000, expiresAt - started);
        const completed = await boundedCall(
          async (outer): Promise<NotificationDispatchResult> => {
            const listed = await options.grants.listCurrent(
              context,
              {
                accountAlias: event.accountAlias,
                environment: event.environment,
                purpose: template.purpose,
              },
              outer
            );
            if (!Array.isArray(listed) || listed.length > 32)
              return stopped("unavailable");
            const grants = listed.map(snapshotNotificationRecipientGrant);
            const identities = new Set<string>();
            for (const grant of grants) {
              if (
                grant.accountAlias !== event.accountAlias ||
                grant.environment !== event.environment ||
                grant.purpose !== template.purpose ||
                grant.templateVersion !== "vertex-notification-v1"
              )
                return stopped("unavailable");
              const identity = JSON.stringify([grant.tenantKey, grant.grantId]);
              if (identities.has(identity)) return stopped("unavailable");
              identities.add(identity);
            }
            const idempotencyKey = await notificationEventKey(
              event,
              event.eventId
            );
            const results: Array<{
              grantId: string;
              version: string;
              result: NotificationResult;
            }> = [];
            for (const captured of grants) {
              if (outer.aborted)
                return Object.freeze({
                  status: "unavailable",
                  reason: "cancelled",
                  retryable: false,
                  results: Object.freeze(results),
                });
              const current = async (
                inner: AbortSignal
              ): Promise<NotificationRecipientGrant | null> => {
                if (outer.aborted || inner.aborted) return null;
                const value = await options.grants.resolveCurrent(
                  context,
                  {
                    accountAlias: captured.accountAlias,
                    environment: captured.environment,
                    grantId: captured.grantId,
                    version: captured.version,
                  },
                  inner
                );
                if (!value) return null;
                const fresh = snapshotNotificationRecipientGrant(value);
                return !(outer.aborted || inner.aborted) &&
                  same(captured, fresh)
                  ? fresh
                  : null;
              };
              const adapter: NotificationAdapter =
                Object.freeze<NotificationAdapter>({
                  prepare: async (
                    _grant,
                    inner
                  ): Promise<NotificationPreparation> => {
                    if (outer.aborted || inner.aborted)
                      return { status: "unavailable" };
                    if (captured.channel === "phone" && !options.fetcher)
                      return { status: "unavailable" };
                    const readiness = await options.configurations.readiness(
                      context,
                      captured,
                      inner
                    );
                    if (readiness !== "ready")
                      return {
                        status:
                          readiness === "disabled" ? "disabled" : "unavailable",
                      };
                    return Object.freeze({
                      status: "ready",
                      send: async (
                        message: NotificationMessage,
                        sendSignal: AbortSignal
                      ): Promise<NotificationProviderOutcome> => {
                        if (dryRun || outer.aborted || sendSignal.aborted)
                          return { acceptance: "not-sent" };
                        const attempt = await boundedCall(
                          async (
                            transportSignal
                          ): Promise<NotificationProviderOutcome> => {
                            const fresh = await current(transportSignal);
                            if (!fresh)
                              return { acceptance: "not-sent" as const };
                            // Reuse the existing transports, with no URL/topic/email in
                            // the event. Private config is resolved here, after admission.
                            const transport =
                              fresh.channel === "phone"
                                ? createNtfyNotificationAdapter({
                                    enabled: true,
                                    fetcher: options.fetcher,
                                    timeoutMs,
                                    resolveConfiguration: async (
                                      _reference,
                                      configSignal
                                    ) =>
                                      options.configurations.resolvePhone(
                                        context,
                                        fresh,
                                        configSignal
                                      ),
                                  })
                                : createEmailNotificationAdapter({
                                    enabled: true,
                                    timeoutMs,
                                    resolveConfiguration: async (
                                      _reference,
                                      configSignal
                                    ) =>
                                      options.configurations.resolveEmail(
                                        context,
                                        fresh,
                                        configSignal
                                      ),
                                  });
                            const prepared = await transport.prepare(
                              legacyGrant(fresh),
                              transportSignal
                            );
                            if (
                              prepared.status !== "ready" ||
                              !(await current(transportSignal)) ||
                              transportSignal.aborted ||
                              sendSignal.aborted
                            )
                              return { acceptance: "not-sent" as const };
                            return prepared.send(message, transportSignal);
                          },
                          timeoutMs,
                          AbortSignal.any([outer, sendSignal])
                        );
                        // Once this send closure starts, ambiguity is retained even
                        // when config resolution times out. Never signal retry.
                        return attempt.ok
                          ? attempt.value
                          : { acceptance: "unknown" };
                      },
                    });
                  },
                });
              const service = createNotificationService<Context>({
                enabled: true,
                timeoutMs,
                now: () => options.clock.now(),
                resolver: {
                  resolve: async (_context, selector, inner) => {
                    if (
                      selector.recipientRef !== captured.recipientRef ||
                      selector.channel !== captured.channel ||
                      selector.purpose !== captured.purpose
                    )
                      return null;
                    const fresh = await current(inner);
                    return fresh ? legacyGrant(fresh) : null;
                  },
                },
                store: {
                  admit: async (input) => {
                    if (outer.aborted || !(await current(outer)))
                      throw new Error("Notification admission unavailable");
                    return options.store.admit(input);
                  },
                  // Outcome persistence must remain possible after revocation or
                  // cancellation; it cannot authorize a new admission or send.
                  recordOutcome: (input) => options.store.recordOutcome(input),
                },
                adapters: { [captured.channel]: adapter },
              });
              const result = snapshotNotificationResult(
                await service.notify(context, {
                  recipientRef: captured.recipientRef,
                  channel: captured.channel,
                  purpose: captured.purpose,
                  idempotencyKey,
                  expiresAt,
                  title: template.title,
                  body: template.body,
                  dryRun,
                })
              );
              if (!result) return stopped("unavailable");
              results.push(
                Object.freeze({
                  grantId: captured.grantId,
                  version: captured.version,
                  result,
                })
              );
            }
            return Object.freeze({
              status: "completed",
              reason: "processed",
              retryable: false,
              results: Object.freeze(results),
            });
          },
          budget,
          signal
        );
        return completed.ok
          ? completed.value
          : stopped(signal.aborted ? "cancelled" : "unavailable");
      } catch {
        return stopped("unavailable");
      }
    },
  });
};
