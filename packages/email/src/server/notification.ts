import { normalizeRecipient } from "../recipient.ts";
import type { ResendMessage } from "./provider.ts";

// Additive, server-only communications port. Password reset, verification, contact
// renderers and their existing delivery/retry contracts are deliberately untouched.
export type NotificationEmailInput = Readonly<{
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}>;

export type NotificationEmailResult = Readonly<{
  acceptance: "accepted" | "rejected" | "unknown" | "not-sent";
}>;

export interface NotificationEmailPort {
  readonly availability: "ready" | "disabled" | "unavailable";
  send: (
    input: NotificationEmailInput,
    signal: AbortSignal
  ) => Promise<NotificationEmailResult>;
}

export type ResendNotificationEmailPortOptions = Readonly<{
  enabled?: boolean | undefined;
  apiKey?: string | undefined;
  from?: string | undefined;
  // Explicitly injected, no environment discovery or ambient network fallback.
  fetcher?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  timeoutMs?: number | undefined;
}>;

const fixedPort = (
  availability: "disabled" | "unavailable"
): NotificationEmailPort => {
  return Object.freeze({
    availability,
    send: async () => ({ acceptance: "not-sent" as const }),
  });
};

// A single conservative sender, not an RFC address-list/header parser. Keep this
// separate from recipient/auth/contact parsing. Configured brand text is retained.
const normalizeNotificationSender = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ||
    new TextEncoder().encode(value).byteLength > 512
  )
    return null;
  const trimmed = value.trim();
  const mailbox = normalizeRecipient(trimmed);
  if (mailbox) return mailbox;
  const envelope = /^([^<>]+)<([^<>]+)>$/.exec(trimmed);
  if (!envelope) return null;
  const name = envelope[1]?.trim();
  const address = envelope[2];
  if (
    !name ||
    address === undefined ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._'&-]{0,159}$/u.test(name) ||
    new TextEncoder().encode(name).byteLength > 160
  )
    return null;
  const recipient = normalizeRecipient(address);
  return recipient ? `${name} <${recipient}>` : null;
};

// Fire-and-forget body release for responses whose content is never read.
const discardResponseBody = (response: Response): void => {
  void response.body?.cancel().catch(() => undefined);
};

const escapeHtml = (text: string): string => {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

const parseBoundedResponse = async (
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
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) return undefined;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(total);
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

const snapshotInput = (input: unknown): NotificationEmailInput | undefined => {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 4) return undefined;
    const record: Record<string, unknown> = {};
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !["to", "subject", "text", "idempotencyKey"].includes(key)
      )
        return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!(descriptor?.enumerable && "value" in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    const { to, subject, text, idempotencyKey } = record;
    if (
      typeof to !== "string" ||
      to.length > 254 ||
      typeof subject !== "string" ||
      subject.length > 160 ||
      subject.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/.test(subject) ||
      new TextEncoder().encode(subject).byteLength > 160 ||
      typeof text !== "string" ||
      text.length > 4096 ||
      text.trim().length === 0 ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) ||
      new TextEncoder().encode(text).byteLength > 4096 ||
      typeof idempotencyKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(idempotencyKey)
    )
      return undefined;
    const recipient = normalizeRecipient(to);
    if (!recipient) return undefined;
    return Object.freeze({ to: recipient, subject, text, idempotencyKey });
  } catch {
    return undefined;
  }
};

export const createResendNotificationEmailPort = (
  options: ResendNotificationEmailPortOptions
): NotificationEmailPort => {
  if (options.enabled !== true) return fixedPort("disabled");
  const key = options.apiKey;
  const from = normalizeNotificationSender(options.from);
  const fetcher = options.fetcher;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(key) ||
    !from ||
    !fetcher ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    return fixedPort("unavailable");

  return Object.freeze({
    availability: "ready",
    send: async (
      raw: NotificationEmailInput,
      parent: AbortSignal
    ): Promise<NotificationEmailResult> => {
      const input = snapshotInput(raw);
      if (!input || parent.aborted) return { acceptance: "not-sent" };
      const message: ResendMessage = Object.freeze({
        from,
        to: Object.freeze([input.to]),
        subject: input.subject,
        text: input.text,
        html: `<div style="white-space:pre-wrap">${escapeHtml(input.text)}</div>`,
      });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const deadline = new Promise<NotificationEmailResult>((resolve) => {
        abort = () => {
          resolve({ acceptance: "unknown" });
          return controller.abort();
        };
        timer = setTimeout(abort, timeoutMs);
        return parent.addEventListener("abort", abort, { once: true });
      });
      const operation = Promise.resolve()
        .then(async (): Promise<NotificationEmailResult> => {
          if (controller.signal.aborted) return { acceptance: "not-sent" };
          const response = await fetcher("https://api.resend.com/emails", {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "Idempotency-Key": input.idempotencyKey,
            },
            body: JSON.stringify(message),
          });
          if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) {
            discardResponseBody(response);
            return { acceptance: "rejected" };
          }
          if (response.status < 200 || response.status >= 300) {
            discardResponseBody(response);
            return { acceptance: "unknown" };
          }
          const data = await parseBoundedResponse(response, controller.signal);
          if (typeof data !== "object" || data === null || Array.isArray(data))
            return { acceptance: "unknown" };
          const id: unknown = Reflect.get(data, "id");
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
            return { acceptance: "unknown" };
          // Provider accepted for processing, NOT delivered to a mailbox.
          return { acceptance: "accepted" };
        })
        .catch((): NotificationEmailResult => ({ acceptance: "unknown" }));
      try {
        return Object.freeze(await Promise.race([operation, deadline]));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort) parent.removeEventListener("abort", abort);
      }
    },
  });
};
