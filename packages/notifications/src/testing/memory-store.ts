import type {
  NotificationAcceptance,
  NotificationAdmission,
  NotificationAdmissionInput,
  NotificationOutcomeInput,
  NotificationScope,
  NotificationStore,
} from "../server/contracts.ts";

// TEST FIXTURE ONLY. Not exported by /server; never selected by production code.
// Synchronous map mutations model the required DB transaction within one process,
// not durability or distributed/concurrent database guarantees.
export type MemoryNotificationFixture = Readonly<{
  store: NotificationStore;
  inspect: () => Readonly<{
    reservations: number;
    cooldowns: number;
    outcomes: readonly NotificationAcceptance[];
  }>;
}>;

interface Entry {
  fingerprint: string;
  attemptId: string;
  acceptance: NotificationAcceptance;
  admittedAt: number;
}

const scopeKey = (scope: NotificationScope): string => {
  return JSON.stringify([
    scope.tenantKey,
    scope.recipientKey,
    scope.channel,
    scope.purpose,
  ]);
};
const cooldownKey = (scope: NotificationScope): string => {
  return JSON.stringify([scope.tenantKey, scope.recipientKey, scope.channel]);
};
const entryKey = (scope: NotificationScope, idempotencyKey: string): string => {
  return JSON.stringify([scopeKey(scope), idempotencyKey]);
};

export const createMemoryNotificationFixture =
  (): MemoryNotificationFixture => {
    const entries = new Map<string, Entry>();
    const cooldowns = new Map<string, number>();
    const store: NotificationStore = Object.freeze({
      // biome-ignore lint/suspicious/useAwait: the in-memory double keeps the promise-returning store contract.
      admit: async (
        input: NotificationAdmissionInput
      ): Promise<NotificationAdmission> => {
        if (input.expiresAt <= input.now) return { status: "expired" };
        const key = entryKey(input.scope, input.idempotencyKey);
        const current = entries.get(key);
        if (current) {
          if (current.fingerprint !== input.fingerprint)
            return { status: "conflict" };
          return { status: "duplicate", acceptance: current.acceptance };
        }
        const cooldown = cooldownKey(input.scope);
        if ((cooldowns.get(cooldown) ?? 0) > input.now)
          return { status: "cooldown" };
        if (input.mode === "observe") return { status: "eligible" };
        entries.set(key, {
          fingerprint: input.fingerprint,
          attemptId: input.attemptId,
          acceptance: "pending",
          admittedAt: input.now,
        });
        cooldowns.set(cooldown, input.now + input.cooldownMs);
        return { status: "admitted", attemptId: input.attemptId };
      },
      // biome-ignore lint/suspicious/useAwait: the in-memory double keeps the promise-returning store contract.
      recordOutcome: async (input: NotificationOutcomeInput) => {
        const entry = entries.get(entryKey(input.scope, input.idempotencyKey));
        if (
          !entry ||
          entry.attemptId !== input.attemptId ||
          input.now < entry.admittedAt
        ) {
          return { status: "stale" as const };
        }
        if (entry.acceptance === input.acceptance)
          return { status: "recorded" as const };
        if (entry.acceptance !== "pending") return { status: "stale" as const };
        entry.acceptance = input.acceptance;
        return { status: "recorded" as const };
      },
    });
    return Object.freeze({
      store,
      inspect: () =>
        Object.freeze({
          reservations: entries.size,
          cooldowns: cooldowns.size,
          outcomes: Object.freeze(
            Array.from(entries.values()).map((entry) => entry.acceptance)
          ),
        }),
    });
  };
