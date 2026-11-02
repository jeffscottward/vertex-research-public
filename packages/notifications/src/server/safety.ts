import {
  dataRecord,
  isChannel,
  isOpaqueKey,
  isPurpose,
  isTimestamp,
  MAX_NOTIFICATION_COOLDOWN_MS,
  MAX_NOTIFICATION_TIMEOUT_MS,
} from "../validation.ts";
import type {
  NotificationAcceptance,
  NotificationAdmission,
  NotificationGrant,
  NotificationProviderOutcome,
} from "./contracts.ts";

export const validTimeout = (value: unknown): value is number => {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_NOTIFICATION_TIMEOUT_MS
  );
};

export type BoundedResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false }>;

// A timeout never implies non-acceptance. The caller retains its pending admission.
// Abort is best effort; a late promise is observed but cannot cause a resend.
export const boundedCall = async <T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<BoundedResult<T>> => {
  if (parentSignal?.aborted) return { ok: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<BoundedResult<T>>((resolve) => {
    abort = () => {
      resolve({ ok: false });
      return controller.abort();
    };
    timer = setTimeout(abort, timeoutMs);
    return parentSignal?.addEventListener("abort", abort, { once: true });
  });
  const operation = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) throw new Error("NOTIFICATION_ABORTED");
      return call(controller.signal);
    })
    .then(
      (value): BoundedResult<T> => ({ ok: true, value }),
      (): BoundedResult<T> => ({ ok: false })
    );
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) parentSignal?.removeEventListener("abort", abort);
  }
};

export const snapshotGrant = (
  input: unknown
): NotificationGrant | undefined => {
  const record = dataRecord(input, [
    "authenticated",
    "tenantKey",
    "recipientKey",
    "recipientRef",
    "channel",
    "purpose",
    "configurationRef",
    "enabled",
    "expiresAt",
    "cooldownMs",
  ]);
  if (!record) return undefined;
  const {
    authenticated,
    tenantKey,
    recipientKey,
    recipientRef,
    channel,
    purpose,
    configurationRef,
    enabled,
    expiresAt,
    cooldownMs,
  } = record;
  if (
    authenticated !== true ||
    !isOpaqueKey(tenantKey) ||
    !isOpaqueKey(recipientKey) ||
    !isOpaqueKey(recipientRef) ||
    !isOpaqueKey(configurationRef) ||
    !isChannel(channel) ||
    !isPurpose(purpose) ||
    typeof enabled !== "boolean" ||
    !isTimestamp(expiresAt) ||
    typeof cooldownMs !== "number" ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 1000 ||
    cooldownMs > MAX_NOTIFICATION_COOLDOWN_MS
  )
    return undefined;
  return Object.freeze({
    authenticated,
    tenantKey,
    recipientKey,
    recipientRef,
    channel,
    purpose,
    configurationRef,
    enabled,
    expiresAt,
    cooldownMs,
  });
};

const acceptances: readonly NotificationAcceptance[] = [
  "pending",
  "accepted",
  "rejected",
  "unknown",
  "not-sent",
];

export const snapshotAdmission = (
  input: unknown
): NotificationAdmission | undefined => {
  const admitted = dataRecord(input, ["status", "attemptId"]);
  if (
    admitted &&
    admitted["status"] === "admitted" &&
    isOpaqueKey(admitted["attemptId"])
  ) {
    return Object.freeze({
      status: "admitted",
      attemptId: admitted["attemptId"],
    });
  }
  const duplicate = dataRecord(input, ["status", "acceptance"]);
  if (
    duplicate &&
    duplicate["status"] === "duplicate" &&
    acceptances.includes(duplicate["acceptance"] as NotificationAcceptance)
  ) {
    return Object.freeze({
      status: "duplicate",
      acceptance: duplicate["acceptance"] as NotificationAcceptance,
    });
  }
  const simple = dataRecord(input, ["status"]);
  const status = simple?.["status"];
  if (
    status === "eligible" ||
    status === "conflict" ||
    status === "cooldown" ||
    status === "expired"
  ) {
    return Object.freeze({ status });
  }
  return undefined;
};

export const snapshotProviderOutcome = (
  input: unknown
): NotificationProviderOutcome | undefined => {
  const record = dataRecord(input, ["acceptance"]);
  const acceptance = record?.["acceptance"];
  if (
    acceptance === "accepted" ||
    acceptance === "rejected" ||
    acceptance === "unknown" ||
    acceptance === "not-sent"
  ) {
    return Object.freeze({ acceptance });
  }
  return undefined;
};

export const digest = async (value: string): Promise<string> => {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(result))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const readBoundedJson = async (
  response: Response,
  signal: AbortSignal
): Promise<unknown> => {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const maxBytes = 8192;
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d{1,10}$/.test(length) || Number(length) > maxBytes)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const cancel = () => ({ catch: void reader.cancel().catch(() => undefined) });
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) return undefined;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown;
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
