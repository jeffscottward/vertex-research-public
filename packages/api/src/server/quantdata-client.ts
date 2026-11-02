// Read-only QuantData HTTP client (port of Gamma Forge QuantDataProvider).
// - POST JSON with a bearer key; the key and URL never appear in messages.
// - One request start per `minIntervalMs` (default 1 s) per client, serialized.
// - HTTP 429 starts a cooldown (Retry-After seconds, else 60 s); requests during it fail fast.
// - Successful bodies are cached per endpoint+payload for `ttlMs`.
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
}>;

export interface QuantDataClient {
  readonly request: (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>,
    ttlMs: number
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
  const cache = new Map<
    string,
    { expires: number; body: Record<string, unknown> }
  >();
  let cooldownUntil = 0;
  let lastStart: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const cooldownSeconds = (): number =>
    Math.max(0, (cooldownUntil - now()) / 1000);

  const failure = (
    reason: QuantDataFailureReason,
    message: string,
    retryAfterSeconds: number | null = null
  ): QuantDataResult => ({ message, ok: false, reason, retryAfterSeconds });

  const cooling = (label: string): QuantDataResult =>
    failure(
      "rate_limited",
      `QuantData ${label}: provider cooldown is active.`,
      cooldownSeconds()
    );

  const send = async (
    endpoint: QuantDataEndpoint,
    payload: Readonly<Record<string, unknown>>
  ): Promise<QuantDataResult> => {
    if (cooldownSeconds() > 0) return cooling(endpoint);
    if (lastStart !== null) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now();
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
    ttlMs
  ) => {
    const key = `${endpoint} ${JSON.stringify(payload)}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expires > now())
      return { body: hit.body, data: hit.body["data"], ok: true };
    if (cooldownSeconds() > 0) return cooling(endpoint);
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
