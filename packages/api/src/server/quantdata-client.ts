// Read-only QuantData HTTP client (port of Gamma Forge QuantDataProvider).
// - POST JSON with a bearer key; the key and URL never appear in messages.
// - One request start per `minIntervalMs` (default 1 s) per client, serialized.
// - At most `maxRequestsPerMinute` (default 54) request starts in any 60 s window. Measured over
//   10 trading days (2026-11-10 to 2026-11-23): market-watch-gex peaks at 122 req / 60 s at the
//   open, leaving 240 - 122 - 60 (25% margin) = 58 req / 60 s; cap 54 keeps 64 req / 60 s (26.7%)
//   margin while allowing 48 collector starts + 6 reserved for /charts. The budget, the quota wait
//   and the cooldown live in this client, so they hold per server instance (one `vite preview`
//   process on QuantVPS); keep the key out of other deployments.
// - QuantData allows 240 requests per 60 s per user, shared by every key and job on the
//   account (the market-watch-bot GEX and flow jobs use the same key). When a response
//   reports fewer than `quotaReserve` (default 60, 25% of 240) requests left (X-RateLimit-Remaining),
//   the client waits until X-RateLimit-Reset (held to 1-60 s, else 60 s) so those jobs keep
//   headroom. A low reading counts only when the counter is live: it fell since the previous
//   response, or the response is HTTP 429. QuantData was seen to send a constant
//   "remaining 19, reset 55" on every response (2026-11-03 UTC), which must not stop all
//   calls. Accepted gap: the first reading of a process has no baseline, so a fresh process
//   can make one more request before it waits; the 429 cooldown still applies.
// - Caller reserve: a caller may pass `keepFree` (held to 0 to maxRequestsPerMinute − 1); its start is
//   refused with the reason "reserved" when fewer than `keepFree` starts of the window would stay free.
//   The flow collector uses `withCallerReserve(client, 6)`, so /charts option reads (keepFree 0) always
//   find 6 starts free; `freeStarts()` reports the starts left in the current 60 s window. One
//   uncached symbol costs 5 of them: 3 for the options snapshot and 2 for the Greek heatmap. The
//   options chain reads the same term structure and 24 h order flow as the snapshot, so it adds
//   none, also when the three read at the same time (see the cache line below).
// - HTTP 429 starts a cooldown (Retry-After seconds, else 60 s); requests during it fail fast.
// - HTTP 401/403 starts an auth-failure cooldown (default 300 s) and classifies as "auth_failed"
//   so repeated ticks and UI loads fail fast instead of hammering QuantData with a rejected key,
//   while keeping `cooldownSeconds()` dedicated to rate-limit waits.
// - Successful bodies are cached per endpoint+payload (or endpoint+cacheKey) for `ttlMs`. A read
//   checks the cache when it is called and again when it reaches the head of the queue, so two
//   identical reads that overlap make one request start: the second gets the answer of the first
//   (a failure is not cached, so a failed first read does not feed the second). `ttlMs` 0 never
//   gives a cache hit.
// - Timeout, 2 MiB body cap, redirects never followed.

const QUANTDATA_DEFAULT_BASE_URL = "https://api.quantdata.us";
export const QUANTDATA_ENDPOINTS = {
  gainersLosers: "/v1/options/tool/gainers-losers",
  heatMap: "/v1/options/tool/heat-map",
  netDrift: "/v1/options/tool/net-drift",
  openInterest: "/v1/options/tool/open-interest-by-strike",
  orderFlow: "/v1/options/tool/order-flow/consolidated",
  termStructure: "/v1/options/tool/term-structure",
} as const;
export type QuantDataEndpoint = keyof typeof QUANTDATA_ENDPOINTS;

const DEFAULT_COOLDOWN_S = 60;
const DEFAULT_AUTH_COOLDOWN_S = 300;
const MAX_COOLDOWN_S = 3600;
const MAX_CACHE_ENTRIES = 200;
const WINDOW_S = 60;
const WINDOW_MS = WINDOW_S * 1000;
export const DEFAULT_MAX_PER_MINUTE = 54;
const DEFAULT_QUOTA_RESERVE = 60;
const WHOLE_NUMBER = /^\d+$/u;

export type QuantDataConfig = Readonly<{ baseUrl: string; apiKey: string }>;

export type QuantDataFailureReason =
  | "auth_failed"
  | "rate_limited"
  | "reserved"
  | "http"
  | "timeout"
  | "invalid";

export type QuantDataResult =
  | Readonly<{
      ok: true;
      data: unknown;
      body: Readonly<Record<string, unknown>>;
      // Epoch ms when QuantData answered (kept on cache hits); test fakes may omit it.
      fetchedAt?: number;
    }>
  | Readonly<{
      ok: false;
      reason: QuantDataFailureReason;
      message: string;
      retryAfterSeconds: number | null;
      // The HTTP status of an answer that was not 200 (reasons "http" and "rate_limited"); absent when
      // no answer arrived. 422 is QuantData's "data-unavailable" (no data for those inputs).
      httpStatus?: number;
    }>;

export type QuantDataFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export type QuantDataClientOptions = Readonly<{
  authCooldownSeconds?: number;
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
  readonly cooldownSeconds: () => number;
  /** maxRequestsPerMinute minus the request starts of the last 60 s. */
  readonly freeStarts: () => number;
  readonly request: (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>,
    ttlMs: number,
    cacheKey?: string,
    keepFree?: number
  ) => Promise<QuantDataResult>;
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
  const authCooldownS = Math.min(
    Math.max(0, options.authCooldownSeconds ?? DEFAULT_AUTH_COOLDOWN_S),
    MAX_COOLDOWN_S
  );
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
    { expires: number; fetchedAt: number; body: Record<string, unknown> }
  >();
  let authCooldownUntil = 0;
  let lastAuthStatus: 401 | 403 | null = null;
  let cooldownUntil = 0;
  let yieldUntil = 0;
  const starts: number[] = [];
  let lastStart: number | null = null;
  let lastRemaining: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const cooldownSeconds = (): number =>
    Math.max(0, (Math.max(cooldownUntil, yieldUntil) - now()) / 1000);

  const authMessage = (
    endpoint: QuantDataEndpoint,
    status: 401 | 403
  ): string =>
    status === 401
      ? `QuantData ${endpoint}: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).`
      : `QuantData ${endpoint}: HTTP 403 (access forbidden — check QUANTDATA_API_KEY or subscription).`;

  const failure = (
    reason: QuantDataFailureReason,
    message: string,
    retryAfterSeconds: number | null = null,
    httpStatus?: number
  ): QuantDataResult => ({
    message,
    ok: false,
    reason,
    retryAfterSeconds,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

  // An auth-failure cooldown (HTTP 401/403), provider cooldown (HTTP 429) or low shared quota
  // stops requests before they start.
  const blocked = (endpoint: QuantDataEndpoint): QuantDataResult | null => {
    const at = now();
    if (authCooldownUntil > at && lastAuthStatus !== null) {
      return failure(
        "auth_failed",
        authMessage(endpoint, lastAuthStatus),
        (authCooldownUntil - at) / 1000,
        lastAuthStatus
      );
    }
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

  const freeStarts = (): number => {
    const at = now();
    return (
      maxPerMinute - starts.filter((start) => start > at - WINDOW_MS).length
    );
  };

  const send = async (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>,
    keepFree: number
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
    if (
      oldest !== undefined &&
      keepFree > 0 &&
      starts.length >= maxPerMinute - keepFree &&
      starts.length < maxPerMinute
    )
      return failure(
        "reserved",
        `QuantData ${endpoint}: ${keepFree} request starts per minute are kept free for other callers.`,
        (oldest + WINDOW_MS - startAt) / 1000
      );
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
          seconds,
          429
        );
      }
      if (response.status === 401 || response.status === 403) {
        const authStatus = response.status;
        lastAuthStatus = authStatus;
        if (authCooldownS > 0) {
          authCooldownUntil = Math.max(
            authCooldownUntil,
            now() + authCooldownS * 1000
          );
        }
        return failure(
          "auth_failed",
          authMessage(endpoint, authStatus),
          authCooldownS > 0 ? authCooldownS : null,
          authStatus
        );
      }
      if (response.status !== 200)
        return failure(
          "http",
          `QuantData ${endpoint}: HTTP ${response.status}.`,
          null,
          response.status
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
      authCooldownUntil = 0;
      lastAuthStatus = null;
      return { body: parsed, data: parsed["data"], fetchedAt: now(), ok: true };
    } finally {
      clearTimeout(timer);
    }
  };

  // A live cache entry of `key`, as the answer QuantData gave (it keeps its `fetchedAt`).
  const cached = (key: string): QuantDataResult | null => {
    const hit = cache.get(key);
    if (hit === undefined || hit.expires <= now()) return null;
    return {
      body: hit.body,
      data: hit.body["data"],
      fetchedAt: hit.fetchedAt,
      ok: true,
    };
  };

  const store = (
    key: string,
    body: Record<string, unknown>,
    ttlMs: number
  ): void => {
    cache.delete(key);
    cache.set(key, { body, expires: now() + ttlMs, fetchedAt: now() });
    for (const oldest of cache.keys()) {
      if (cache.size <= MAX_CACHE_ENTRIES) break;
      cache.delete(oldest);
    }
  };

  const request: QuantDataClient["request"] = async (
    endpoint,
    payload,
    ttlMs,
    cacheKey,
    keepFree = 0
  ) => {
    const key = `${endpoint} ${cacheKey === undefined ? JSON.stringify(payload) : `key ${cacheKey}`}`;
    const hit = cached(key);
    if (hit !== null) return hit;
    const held = blocked(endpoint);
    if (held !== null) return held;
    const kept = Math.min(Math.max(0, keepFree), maxPerMinute - 1);
    // At the head of the queue, check the cache again: an identical read queued ahead of this
    // one may have filled it while this one waited. Its entry keeps its expiry time. The queued
    // step fills the cache itself, so the next queued read sees the answer.
    const run = queue.then(async () => {
      const filled = cached(key);
      if (filled !== null) return filled;
      const result = await send(endpoint, payload, kept);
      if (result.ok) store(key, result.body, ttlMs);
      return result;
    });
    // Keep the queue alive even if the queued step throws unexpectedly (for example an injected
    // clock).
    queue = run.catch(() => undefined);
    return await run;
  };

  return Object.freeze({ cooldownSeconds, freeStarts, request });
};

/**
 * A view of a shared client that keeps `keepFree` starts per minute free for other callers. It
 * shares the one window of the client; `freeStarts()` leaves out the reserve.
 */
export const withCallerReserve = (
  client: QuantDataClient,
  keepFree: number
): QuantDataClient => ({
  cooldownSeconds: client.cooldownSeconds,
  freeStarts: () => Math.max(0, client.freeStarts() - keepFree),
  request: (endpoint, payload, ttlMs, cacheKey) =>
    client.request(endpoint, payload, ttlMs, cacheKey, keepFree),
});
