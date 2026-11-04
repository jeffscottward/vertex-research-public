// Read-only QuantData HTTP client (port of Gamma Forge QuantDataProvider).
// - POST JSON with a bearer key; the key and URL never appear in messages.
// - One request start per `minIntervalMs` (default 1 s) per client, serialized.
// - At most `maxRequestsPerMinute` (default 30) request starts in any 60 s window. The budget,
//   the quota wait and the cooldown live in this client, so they hold per server instance
//   (one `vite preview` process on QuantVPS); keep the key out of other deployments.
// - QuantData allows 240 requests per 60 s per user, shared by every key and job on the
//   account (the market-watch-bot GEX and flow jobs use the same key). When a response
//   reports fewer than `quotaReserve` (default 120) requests left (X-RateLimit-Remaining),
//   the client waits until X-RateLimit-Reset (held to 1-60 s, else 60 s) so those jobs keep
//   headroom. A low reading counts only when the counter is live: it fell since the previous
//   response, or the response is HTTP 429. QuantData was seen to send a constant
//   "remaining 19, reset 55" on every response (2026-11-03 UTC), which must not stop all
//   calls. Accepted gap: the first reading of a process has no baseline, so a fresh process
//   can make one more request before it waits; the 429 cooldown still applies.
// - HTTP 429 starts a cooldown (Retry-After seconds, else 60 s); requests during it fail fast.
// - Successful bodies are cached per endpoint+payload (or endpoint+cacheKey) for `ttlMs`.
// - Timeout, 2 MiB body cap, redirects never followed.

const QUANTDATA_DEFAULT_BASE_URL = "https://api.quantdata.us";
export const QUANTDATA_ENDPOINTS = {
  termStructure: "/v1/options/tool/term-structure",
  openInterest: "/v1/options/tool/open-interest-by-strike",
  orderFlow: "/v1/options/tool/order-flow/consolidated",
} as const;
export type QuantDataEndpoint = keyof typeof QUANTDATA_ENDPOINTS;

const DEFAULT_COOLDOWN_S = 60;
const MAX_COOLDOWN_S = 3600;
const MAX_CACHE_ENTRIES = 200;
const WINDOW_S = 60;
const WINDOW_MS = WINDOW_S * 1000;
const DEFAULT_MAX_PER_MINUTE = 30;
const DEFAULT_QUOTA_RESERVE = 120;
const WHOLE_NUMBER = /^\d+$/u;

export type QuantDataConfig = Readonly<{ baseUrl: string; apiKey: string }>;

export type QuantDataFailureReason =
  | "rate_limited"
  | "http"
  | "timeout"
  | "invalid";

export type QuantDataResult =
  | Readonly<{
      ok: true;
      data: unknown;
      body: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      reason: QuantDataFailureReason;
      message: string;
      retryAfterSeconds: number | null;
    }>;

export type QuantDataFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export type QuantDataClientOptions = Readonly<{
  fetch?: QuantDataFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRequestsPerMinute?: number;
  quotaReserve?: number;
}>;

export interface QuantDataClient {
  readonly request: (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>,
    ttlMs: number,
    cacheKey?: string
  ) => Promise<QuantDataResult>;
  readonly cooldownSeconds: () => number;
}

// Accepts only https URLs without credentials; returns null otherwise or when no key.
export const resolveQuantDataConfig = (
  baseUrl: string | undefined,
  apiKey: string | undefined
): QuantDataConfig | null => {
  const key = apiKey?.trim() ?? "";
  if (key.length === 0) return null;
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || QUANTDATA_DEFAULT_BASE_URL);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  return { apiKey: key, baseUrl: url.origin };
};

export const parseRetryAfter = (
  value: string | null,
  nowMs: number
): number => {
  if (value === null || value.trim() === "") return DEFAULT_COOLDOWN_S;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds, MAX_COOLDOWN_S);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return DEFAULT_COOLDOWN_S;
  return Math.min(Math.max(0, (at - nowMs) / 1000), MAX_COOLDOWN_S);
};

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createQuantDataClient = (
  config: QuantDataConfig,
  options: QuantDataClientOptions = {}
): QuantDataClient => {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const minInterval = options.minIntervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxPerMinute = Math.max(
    1,
    options.maxRequestsPerMinute ?? DEFAULT_MAX_PER_MINUTE
  );
  const reserve = options.quotaReserve ?? DEFAULT_QUOTA_RESERVE;
  const cache = new Map<
    string,
    { expires: number; body: Record<string, unknown> }
  >();
  let cooldownUntil = 0;
  let yieldUntil = 0;
  const starts: number[] = [];
  let lastStart: number | null = null;
  let lastRemaining: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const cooldownSeconds = (): number =>
    Math.max(0, (Math.max(cooldownUntil, yieldUntil) - now()) / 1000);

  const failure = (
    reason: QuantDataFailureReason,
    message: string,
    retryAfterSeconds: number | null = null
  ): QuantDataResult => ({ message, ok: false, reason, retryAfterSeconds });

  // A provider cooldown (HTTP 429) or a low shared quota stops requests before they start.
  const blocked = (endpoint: QuantDataEndpoint): QuantDataResult | null => {
    const at = now();
    const until = Math.max(cooldownUntil, yieldUntil);
    if (until <= at) return null;
    return failure(
      "rate_limited",
      cooldownUntil >= yieldUntil
        ? `QuantData ${endpoint}: provider cooldown is active.`
        : `QuantData ${endpoint}: the shared QuantData quota is low; vertex-web waits so trading jobs keep headroom.`,
      (until - at) / 1000
    );
  };

  // QuantData responses carry the account-wide quota; wait before it runs low. A constant
  // header is not evidence of use, so only a falling counter (or a 429) makes the client wait.
  const noteQuota = (headers: Headers, limited: boolean): void => {
    const text = headers.get("x-ratelimit-remaining")?.trim() ?? "";
    if (!WHOLE_NUMBER.test(text)) return;
    const remaining = Number(text);
    const previous = lastRemaining;
    lastRemaining = remaining;
    const live = limited || (previous !== null && remaining < previous);
    if (!live || remaining >= reserve) return;
    const reset = headers.get("x-ratelimit-reset")?.trim() ?? "";
    const seconds = WHOLE_NUMBER.test(reset)
      ? Math.min(Math.max(Number(reset), 1), WINDOW_S)
      : WINDOW_S;
    yieldUntil = Math.max(yieldUntil, now() + seconds * 1000);
  };

  const send = async (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>
  ): Promise<QuantDataResult> => {
    const held = blocked(endpoint);
    if (held !== null) return held;
    if (lastStart !== null) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    const startAt = now();
    for (;;) {
      const first = starts[0];
      if (first === undefined || first > startAt - WINDOW_MS) break;
      starts.shift();
    }
    const oldest = starts[0];
    if (oldest !== undefined && starts.length >= maxPerMinute)
      return failure(
        "rate_limited",
        `QuantData ${endpoint}: the vertex-web budget of ${maxPerMinute} requests per minute is used.`,
        (oldest + WINDOW_MS - startAt) / 1000
      );
    lastStart = startAt;
    starts.push(startAt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(
          config.baseUrl + QUANTDATA_ENDPOINTS[endpoint],
          {
            body: JSON.stringify(payload),
            headers: {
              accept: "application/json",
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "manual",
            signal: controller.signal,
          }
        );
      } catch {
        return controller.signal.aborted
          ? failure("timeout", `QuantData ${endpoint}: request timed out.`)
          : failure("http", `QuantData ${endpoint}: request failed.`);
      }
      noteQuota(response.headers, response.status === 429);
      if (response.status === 429) {
        const seconds = parseRetryAfter(
          response.headers.get("retry-after"),
          now()
        );
        cooldownUntil = Math.max(cooldownUntil, now() + seconds * 1000);
        return failure(
          "rate_limited",
          `QuantData ${endpoint}: HTTP 429.`,
          seconds
        );
      }
      if (response.status !== 200)
        return failure(
          "http",
          `QuantData ${endpoint}: HTTP ${response.status}.`
        );
      let text: string | null;
      try {
        text = await readCapped(response, maxBytes);
      } catch {
        return controller.signal.aborted
          ? failure("timeout", `QuantData ${endpoint}: request timed out.`)
          : failure(
              "http",
              `QuantData ${endpoint}: response could not be read.`
            );
      }
      if (text === null)
        return failure("invalid", `QuantData ${endpoint}: response too large.`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return failure(
          "invalid",
          `QuantData ${endpoint}: response is not JSON.`
        );
      }
      if (!(isRecord(parsed) && "data" in parsed))
        return failure(
          "invalid",
          `QuantData ${endpoint}: unsupported response format.`
        );
      return { body: parsed, data: parsed["data"], ok: true };
    } finally {
      clearTimeout(timer);
    }
  };

  const request: QuantDataClient["request"] = async (
    endpoint,
    payload,
    ttlMs,
    cacheKey
  ) => {
    const key = `${endpoint} ${cacheKey === undefined ? JSON.stringify(payload) : `key ${cacheKey}`}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expires > now())
      return { body: hit.body, data: hit.body["data"], ok: true };
    const held = blocked(endpoint);
    if (held !== null) return held;
    const run = queue.then(() => send(endpoint, payload));
    // Keep the queue alive even if `send` throws unexpectedly (for example an injected clock).
    queue = run.catch(() => undefined);
    const result = await run;
    if (result.ok) {
      cache.delete(key);
      cache.set(key, { body: result.body, expires: now() + ttlMs });
      for (const oldest of cache.keys()) {
        if (cache.size <= MAX_CACHE_ENTRIES) break;
        cache.delete(oldest);
      }
    }
    return result;
  };

  return Object.freeze({ cooldownSeconds, request });
};
