import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  MARKET_BAR_SIZES,
  MARKET_BARS_MAX,
  MARKET_SEC_TYPES,
  MARKET_WHAT_TO_SHOW,
  MarketBarSchema,
  type MarketBarsOutput,
  type MarketBarsParsedInput,
  MarketContractSchema,
  type MarketDepthOutput,
  MarketDepthOutputSchema,
  type MarketDepthParsedInput,
  type MarketTicksOutput,
  MarketTicksOutputSchema,
  type MarketTicksParsedInput,
} from "../contracts/market-data.ts";
import type { ApiContext } from "./context.ts";
import {
  resolveDeployStatusConfig,
  type DeployStatusConfig,
  type DeployStatusFetch,
} from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";

// Bounded, read-only fetch of IBKR historical bars, historical ticks and one-shot depth snapshots
// from the QuantVPS tailnet history service (VERTEX_HISTORY_URL, bearer VERTEX_DEPLOY_STATUS_TOKEN).
// GET only, per-endpoint timeout, 2 MiB cap, redirects never followed, strict schema parse.
// Messages never include the token or the URL.

export const MARKET_HISTORY_TIMEOUT_MS = 30_000;
// Ticks: the service spends at most 35 s per request (lock, pacing for TRADES then BID_ASK, the
// contract lookup and both IB requests). 40 s leaves headroom and stays under the tailnet Caddy
// response_header_timeout (45 s).
export const MARKET_TICKS_TIMEOUT_MS = 40_000;
// Depth: the service spends at most 25 s per request (the one depth slot and its 3 s spacing, the
// contract lookup, about 2 s of book collection). 35 s stays under the Caddy 45 s limit.
export const MARKET_DEPTH_TIMEOUT_MS = 35_000;
export const MARKET_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 4 * 1024;

export type MarketDataErrorCode =
  | "NOT_CONFIGURED"
  | "PACED"
  | "ENTITLEMENT"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "BAD_REQUEST";

export class MarketDataError extends Error {
  code: MarketDataErrorCode;
  // PACED only: the service's wait, when it sent one.
  retryAfterSeconds: number | null;
  constructor(
    code: MarketDataErrorCode,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "MarketDataError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type FetchMarketBarsOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}>;

// Same rules as the status endpoints (https, no credentials, token of at least 32 characters), plus
// loopback http: on QuantVPS the history service runs on the web app's own host.
export const resolveMarketHistoryConfig = (
  url: string | undefined,
  token: string | undefined
): DeployStatusConfig | null => {
  return resolveDeployStatusConfig(url, token, { allowLoopbackHttp: true });
};

export const buildMarketBarsUrl = (
  base: string,
  input: MarketBarsParsedInput
): string => {
  const params = new URLSearchParams({
    symbol: input.symbol.toUpperCase(),
    secType: input.secType,
    exchange: (input.exchange ?? "SMART").toUpperCase(),
    currency: input.currency.toUpperCase(),
    barSize: input.barSize,
    duration: input.duration,
    whatToShow: input.whatToShow,
    useRTH: input.useRTH ? "1" : "0",
  });
  if (input.contractMonth !== undefined)
    params.set("contractMonth", input.contractMonth);
  return `${base.replace(/\/+$/, "")}/bars?${params.toString()}`;
};

type InstrumentInput = Readonly<{
  symbol: string;
  secType: MarketTicksParsedInput["secType"];
  exchange?: string | undefined;
  currency: string;
  contractMonth?: string | undefined;
}>;

const instrumentParams = (input: InstrumentInput): URLSearchParams => {
  return new URLSearchParams({
    symbol: input.symbol.toUpperCase(),
    secType: input.secType,
    exchange: (input.exchange ?? "SMART").toUpperCase(),
    currency: input.currency.toUpperCase(),
  });
};

export const buildMarketTicksUrl = (
  base: string,
  input: MarketTicksParsedInput
): string => {
  const params = instrumentParams(input);
  params.set("count", String(input.count));
  params.set("useRTH", input.useRTH ? "1" : "0");
  params.set("quotes", input.quotes ? "1" : "0");
  if (input.contractMonth !== undefined)
    params.set("contractMonth", input.contractMonth);
  return `${base.replace(/\/+$/, "")}/ticks?${params.toString()}`;
};

// Stocks always use IBKR SMART depth (aggregated across venues); futures use the exchange's book.
export const buildMarketDepthUrl = (
  base: string,
  input: MarketDepthParsedInput
): string => {
  const params = instrumentParams(
    input.secType === "STK" ? { ...input, exchange: "SMART" } : input
  );
  params.set("rows", String(input.rows));
  if (input.contractMonth !== undefined)
    params.set("contractMonth", input.contractMonth);
  return `${base.replace(/\/+$/, "")}/depth?${params.toString()}`;
};

const isoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

const VertexHistoryUpstreamSchema = z
  .object({
    schema: z.literal("vertex-history-bars-v1"),
    source: z.literal("ibkr-gateway"),
    client_id: z.literal(77),
    request: z
      .object({
        symbol: z.string().max(12),
        secType: z.enum(MARKET_SEC_TYPES),
        exchange: z.string().max(16),
        currency: z.string().max(3),
        barSize: z.enum(MARKET_BAR_SIZES),
        duration: z.string().max(8),
        whatToShow: z.enum(MARKET_WHAT_TO_SHOW),
        useRTH: z.boolean(),
        contractMonth: z.string().max(8).nullable(),
      })
      .strict(),
    contract: MarketContractSchema,
    bars: z.array(MarketBarSchema).max(MARKET_BARS_MAX),
    count: z.number().int().nonnegative(),
    fetched_at: isoUtc,
    as_of: isoUtc.nullable(),
    cache: z
      .object({
        hit: z.boolean(),
        age_seconds: z.number().int().nonnegative(),
        ttl_seconds: z.number().int().nonnegative(),
        stale: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine((document) => document.count === document.bars.length, {
    message: "count mismatch",
  });

// Ticks and depth documents already use the API field names; the server checks the envelope
// (schema, source, client id 77) and passes the rest through.
const VertexTicksUpstreamSchema = MarketTicksOutputSchema.omit({
  receivedAt: true,
})
  .extend({
    asOf: isoUtc.nullable(),
    client_id: z.literal(77),
    fetchedAt: isoUtc,
    schema: z.literal("vertex-history-ticks-v1"),
  })
  .strict();

const VertexDepthUpstreamSchema = MarketDepthOutputSchema.omit({
  receivedAt: true,
})
  .extend({
    client_id: z.literal(77),
    fetchedAt: isoUtc,
    schema: z.literal("vertex-history-depth-v1"),
  })
  .strict();

const UpstreamErrorSchema = z.object({
  error: z.string().max(40),
  message: z.string().max(400).optional(),
  ibkr_code: z.number().int().optional(),
  retry_after_seconds: z.number().int().nonnegative().optional(),
});

const ACCOUNT_PATTERN = /\b(?:D?U|F|I)\d{5,}\b/g;
const clean = (text: string): string => {
  return text
    .replace(ACCOUNT_PATTERN, "[account]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 300);
};

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "History response exceeds the size cap"
    );
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MarketDataError(
        "UPSTREAM_ERROR",
        "History response exceeds the size cap"
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "History response is not valid UTF-8"
    );
  }
};

const readErrorBody = async (
  response: Response
): Promise<z.infer<typeof UpstreamErrorSchema> | null> => {
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? ""))
    return null;
  try {
    const parsed = UpstreamErrorSchema.safeParse(
      JSON.parse(await readCapped(response, ERROR_BODY_MAX_BYTES))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const upstreamFailure = async (
  response: Response
): Promise<MarketDataError> => {
  const body = await readErrorBody(response);
  const message = body?.message === undefined ? "" : clean(body.message);
  const withCode =
    body?.ibkr_code === undefined
      ? message
      : `IBKR ${body.ibkr_code}: ${message}`;
  if (response.status === 429) {
    const header = Number(response.headers.get("retry-after") ?? "");
    const retry =
      body?.retry_after_seconds ??
      (Number.isFinite(header) && header > 0 ? Math.ceil(header) : null);
    return new MarketDataError(
      "PACED",
      retry === null
        ? "IBKR history pacing: retry later"
        : `IBKR history pacing: retry in ${retry} s`,
      retry
    );
  }
  if (body !== null) {
    if (response.status === 422 || body.error === "no_contract")
      return new MarketDataError(
        "NOT_FOUND",
        withCode || "No IBKR contract matched the request"
      );
    if (body.error === "entitlement")
      return new MarketDataError(
        "ENTITLEMENT",
        withCode || "IBKR market data permissions missing"
      );
    if (response.status === 503 || response.status === 504)
      return new MarketDataError(
        "UNAVAILABLE",
        message || "IBKR history service unavailable"
      );
    if (response.status === 400)
      return new MarketDataError(
        "BAD_REQUEST",
        message || "History service rejected the request"
      );
    if (response.status === 502 && message !== "")
      return new MarketDataError("UPSTREAM_ERROR", withCode);
  }
  if (response.status === 503 || response.status === 504)
    return new MarketDataError(
      "UNAVAILABLE",
      `History endpoint returned HTTP ${response.status}`
    );
  return new MarketDataError(
    "UPSTREAM_ERROR",
    `History endpoint returned HTTP ${response.status}`
  );
};

const toMarketBarsOutput = (
  raw: unknown,
  receivedAt: Date
): MarketBarsOutput => {
  const parsed = VertexHistoryUpstreamSchema.safeParse(raw);
  if (!parsed.success)
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "History response failed schema validation"
    );
  const document = parsed.data;
  return {
    source: document.source,
    request: document.request,
    contract: document.contract,
    bars: document.bars,
    count: document.count,
    fetchedAt: document.fetched_at,
    asOf: document.as_of,
    cache: {
      hit: document.cache.hit,
      ageSeconds: document.cache.age_seconds,
      ttlSeconds: document.cache.ttl_seconds,
      stale: document.cache.stale,
    },
    receivedAt: receivedAt.toISOString(),
  };
};

// GET one history document (bearer, timeout, size cap, no redirects); also used by ibkr-history.ts.
export const fetchHistoryDocument = async (
  config: DeployStatusConfig | null,
  buildUrl: (base: string) => string,
  defaultTimeoutMs: number,
  options: FetchMarketBarsOptions
): Promise<unknown> => {
  if (config === null)
    throw new MarketDataError(
      "NOT_CONFIGURED",
      "Market data history endpoint not configured (VERTEX_HISTORY_URL)"
    );
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? defaultTimeoutMs
  );
  try {
    let response: Response;
    try {
      response = await doFetch(buildUrl(config.url), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new MarketDataError(
        "UNAVAILABLE",
        controller.signal.aborted
          ? "History request timed out"
          : "History request failed"
      );
    }
    if (response.status !== 200) throw await upstreamFailure(response);
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    ) {
      throw new MarketDataError(
        "UPSTREAM_ERROR",
        "History endpoint returned an unexpected content type"
      );
    }
    let body: string;
    try {
      body = await readCapped(
        response,
        options.maxBytes ?? MARKET_HISTORY_MAX_BYTES
      );
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        controller.signal.aborted ? "UNAVAILABLE" : "UPSTREAM_ERROR",
        controller.signal.aborted
          ? "History request timed out"
          : "History response could not be read"
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new MarketDataError(
        "UPSTREAM_ERROR",
        "History response is not valid JSON"
      );
    }
  } finally {
    clearTimeout(timer);
  }
};

const receivedNow = (options: FetchMarketBarsOptions): Date =>
  (options.now ?? (() => new Date()))();

export const fetchMarketBars = async (
  config: DeployStatusConfig | null,
  input: MarketBarsParsedInput,
  options: FetchMarketBarsOptions = {}
): Promise<MarketBarsOutput> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketBarsUrl(base, input),
    MARKET_HISTORY_TIMEOUT_MS,
    options
  );
  return toMarketBarsOutput(raw, receivedNow(options));
};

const schemaFailure = (): MarketDataError =>
  new MarketDataError(
    "UPSTREAM_ERROR",
    "History response failed schema validation"
  );

export const fetchMarketTicks = async (
  config: DeployStatusConfig | null,
  input: MarketTicksParsedInput,
  options: FetchMarketBarsOptions = {}
): Promise<MarketTicksOutput> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketTicksUrl(base, input),
    MARKET_TICKS_TIMEOUT_MS,
    options
  );
  const parsed = VertexTicksUpstreamSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  const { schema: _schema, client_id: _clientId, ...document } = parsed.data;
  return { ...document, receivedAt: receivedNow(options).toISOString() };
};

export const fetchMarketDepth = async (
  config: DeployStatusConfig | null,
  input: MarketDepthParsedInput,
  options: FetchMarketBarsOptions = {}
): Promise<MarketDepthOutput> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketDepthUrl(base, input),
    MARKET_DEPTH_TIMEOUT_MS,
    options
  );
  const parsed = VertexDepthUpstreamSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  const { schema: _schema, client_id: _clientId, ...document } = parsed.data;
  return { ...document, receivedAt: receivedNow(options).toISOString() };
};

const HistoryHealthSchema = z.object({
  pacing: z.object({
    backoff_seconds: z.number().int().nonnegative(),
    recent_requests: z.number().int().nonnegative(),
  }),
});

export const MARKET_HISTORY_HEALTH_TIMEOUT_MS = 5000;

/** Historical requests IBKR saw in the last 120 s (shared by /charts and the flow collector). */
export type MarketHistoryPacing = Readonly<{
  recentRequests: number;
  backoffSeconds: number;
}>;

export const fetchMarketHistoryPacing = async (
  config: DeployStatusConfig | null,
  options: FetchMarketBarsOptions = {}
): Promise<MarketHistoryPacing> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => `${base.replace(/\/+$/, "")}/health`,
    MARKET_HISTORY_HEALTH_TIMEOUT_MS,
    options
  );
  const parsed = HistoryHealthSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  return {
    backoffSeconds: parsed.data.pacing.backoff_seconds,
    recentRequests: parsed.data.pacing.recent_requests,
  };
};

const api = implement(appContract).$context<ApiContext>();

type MarketDataErrorFactories = Readonly<
  Record<MarketDataErrorCode, (options?: { message?: string }) => Error>
>;

let marketDataFetchOptions: FetchMarketBarsOptions = {};
export const setMarketDataFetchOptionsForTesting = (
  options: FetchMarketBarsOptions
): void => {
  marketDataFetchOptions = options;
};

const toTypedError = (errors: unknown, error: unknown): Error => {
  const failures = errors as MarketDataErrorFactories;
  if (error instanceof MarketDataError)
    return failures[error.code]({ message: error.message });
  return failures.UPSTREAM_ERROR({ message: "History request failed" });
};

const marketDataBars = api.marketData.bars
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    try {
      return await fetchMarketBars(
        context.marketHistory ?? null,
        input,
        marketDataFetchOptions
      );
    } catch (error) {
      throw toTypedError(errors, error);
    }
  });

const marketDataTicks = api.marketData.ticks
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    try {
      return await fetchMarketTicks(
        context.marketHistory ?? null,
        input,
        marketDataFetchOptions
      );
    } catch (error) {
      throw toTypedError(errors, error);
    }
  });

const marketDataDepth = api.marketData.depth
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    try {
      return await fetchMarketDepth(
        context.marketHistory ?? null,
        input,
        marketDataFetchOptions
      );
    } catch (error) {
      throw toTypedError(errors, error);
    }
  });

export const marketDataRouter = {
  bars: marketDataBars,
  depth: marketDataDepth,
  ticks: marketDataTicks,
};
