import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  type MarketBarsOutput,
  type MarketBarsParsedInput,
  MarketBarsRequestEchoSchema,
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
import { parseHistoryBarsAnswer } from "./history-answer.ts";
import { redactIbkrAccounts } from "./ibkr-account-redaction.ts";
import { requireOperator } from "./operator-access.ts";

// Bounded, read-only fetch of IBKR historical bars, historical ticks, one-shot depth snapshots and
// the streamed tape from the QuantVPS tailnet history service (VERTEX_HISTORY_URL, bearer
// VERTEX_DEPLOY_STATUS_TOKEN).
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
// Tape: the service reads its memory ring and sends no IBKR request, so an answer takes well below
// one second. 10 s lets the collector follow several answers inside one run.
export const MARKET_TAPE_TIMEOUT_MS = 10_000;
const MARKET_DEPTH_HISTORY_TIMEOUT_MS = 10_000;
export const MARKET_DOM_TIMEOUT_MS = 4000;
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
  signal?: AbortSignal;
  notFoundOn404?: boolean;
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
    // IBKR has no TRADES data for forex; CASH is always MIDPOINT. The history service applies the same
    // rule; it is repeated here so that the contract does not depend on an upstream side effect.
    whatToShow: input.secType === "CASH" ? "MIDPOINT" : input.whatToShow,
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

// The streamed tape of one futures symbol from the exchange second `since` (epoch seconds).
export const buildMarketDepthHistoryUrl = (
  base: string,
  input: Readonly<{ symbol: string; since: number }>
): string => {
  const params = new URLSearchParams();
  params.set("symbol", input.symbol.toUpperCase());
  params.set("since", String(input.since));
  return `${base.replace(/\/+$/, "")}/depth-history?${params.toString()}`;
};

export type MarketDomFetchInput = Readonly<{
  symbol: "ES" | "NQ";
  rows: number;
  windowSeconds: number;
  since?: number;
}>;

export const buildMarketDomUrl = (
  base: string,
  input: MarketDomFetchInput
): string => {
  const params = new URLSearchParams({
    rows: String(input.rows),
    symbol: input.symbol,
    windowSeconds: String(input.windowSeconds),
  });
  if (input.since !== undefined) params.set("since", String(input.since));
  return `${base.replace(/\/+$/, "")}/dom?${params.toString()}`;
};

export const buildMarketTapeUrl = (
  base: string,
  input: Readonly<{ symbol: string; since: number }>
): string => {
  const params = new URLSearchParams({
    symbol: input.symbol.toUpperCase(),
    since: String(input.since),
  });
  return `${base.replace(/\/+$/, "")}/tape?${params.toString()}`;
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

// The cause text of a tape feed: the answer may hold up to 2,000 characters; the output keeps 200.
const MARKET_TAPE_ERROR_UPSTREAM_MAX = 2000;
export const MARKET_TAPE_ERROR_MAX = 200;

// The streamed tape (vertex-history 1.5.0, GET /tape). A print is [exchange second, price, size,
// bid, ask]; bid and ask are null before the first quote message. A covered pair is an inclusive
// range [from, to] of exchange seconds. contract is null before the first subscription.
const VertexTapeUpstreamSchema = z
  .object({
    client_id: z.literal(77),
    contract: MarketContractSchema.nullable(),
    covered: z.array(z.tuple([z.number().int(), z.number().int()])),
    fetchedAt: isoUtc,
    minTick: z.number().positive().nullable(),
    more: z.boolean(),
    // The newest price before `since` that differs from previousPrice: the tick-rule reference of
    // a first print at previousPrice.
    previousDifferentPrice: z.number().positive().nullable(),
    previousPrice: z.number().nullable(),
    schema: z.literal("vertex-history-tape-v1"),
    since: z.number().int(),
    source: z.literal("ibkr-gateway"),
    stream: z
      .object({
        // Free text of the service. The output holds it redacted and cut (tapeStreamError).
        error: z.string().max(MARKET_TAPE_ERROR_UPSTREAM_MAX).nullable(),
        state: z.enum(["live", "down", "off"]),
      })
      .strict(),
    symbol: z.enum(["ES", "NQ"]),
    trades: z.array(
      z.tuple([
        z.number().int(),
        z.number(),
        z.number(),
        z.number().nullable(),
        z.number().nullable(),
      ])
    ),
    until: z.number().int(),
  })
  .strict();

/**
 * One answer of the streamed tape, in the form of the ticks output: the envelope keys schema and
 * client_id are checked and dropped, receivedAt is added. stream.error is the cause text of the
 * service with IBKR account ids redacted, cut to MARKET_TAPE_ERROR_MAX characters. Not part of an
 * oRPC contract; only the flow collector reads it.
 */
export type MarketTape = Readonly<
  Omit<z.infer<typeof VertexTapeUpstreamSchema>, "client_id" | "schema"> & {
    receivedAt: string;
  }
>;

const VertexDepthHistorySnapshotSchema = z
  .object({
    asks: z.array(z.tuple([z.number(), z.number()])),
    bestAsk: z.number().positive().nullable(),
    bestBid: z.number().positive().nullable(),
    bids: z.array(z.tuple([z.number(), z.number()])),
    t: z.number().int(),
  })
  .strict();

const VertexDepthHistoryUpstreamSchema = z
  .object({
    client_id: z.literal(77),
    contract: MarketContractSchema.nullable(),
    fetchedAt: isoUtc,
    minTick: z.number().positive().nullable(),
    rows: z.number().int().positive(),
    sampleSeconds: z.number().int().positive(),
    schema: z.literal("vertex-history-depth-history-v1"),
    since: z.number().int(),
    snapshots: z.array(VertexDepthHistorySnapshotSchema),
    source: z.literal("ibkr-gateway"),
    stream: z
      .object({
        error: z.string().max(MARKET_TAPE_ERROR_UPSTREAM_MAX).nullable(),
        state: z.enum(["live", "starting", "down", "off", "halted"]),
      })
      .strict(),
    symbol: z.enum(["ES", "NQ"]),
  })
  .strict();

export type MarketDepthHistory = Readonly<
  Omit<
    z.infer<typeof VertexDepthHistoryUpstreamSchema>,
    "client_id" | "schema"
  > & {
    receivedAt: string;
  }
>;

const VertexDomStreamHealthSchema = z
  .object({
    error: z.string().max(MARKET_TAPE_ERROR_UPSTREAM_MAX).nullable(),
    lastAt: isoUtc.nullable(),
    state: z.enum(["live", "starting", "down", "off", "halted"]),
  })
  .strict();

const VertexDomUpstreamSchema = z
  .object({
    asks: z
      .array(z.tuple([z.number().positive(), z.number().positive()]))
      .max(10),
    bids: z
      .array(z.tuple([z.number().positive(), z.number().positive()]))
      .max(10),
    client_id: z.literal(77),
    contract: MarketContractSchema.nullable(),
    depthStream: VertexDomStreamHealthSchema,
    depthUpdates: z.number().int().nonnegative(),
    fetchedAt: isoUtc,
    lastTrade: z
      .object({
        price: z.number().positive(),
        side: z.enum(["buy", "sell", "unsigned"]),
        size: z.number().positive(),
        t: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    minTick: z.number().positive().nullable(),
    schema: z.literal("vertex-history-dom-v1"),
    seq: z.number().int().nonnegative(),
    since: z.number().int().positive().nullable(),
    source: z.literal("ibkr-gateway"),
    symbol: z.enum(["ES", "NQ"]),
    tapeSeq: z.number().int().nonnegative(),
    tapeStream: VertexDomStreamHealthSchema,
    volumeByPrice: z
      .array(
        z.tuple([
          z.number().positive(),
          z.number().nonnegative(),
          z.number().nonnegative(),
          z.number().nonnegative(),
          z.number().int().positive(),
        ])
      )
      .max(200),
    windowSeconds: z.number().int().positive(),
  })
  .strict();

export type MarketDom = Readonly<
  Omit<z.infer<typeof VertexDomUpstreamSchema>, "client_id" | "schema"> & {
    receivedAt: string;
  }
>;

const UpstreamErrorSchema = z.object({
  error: z.string().max(40),
  message: z.string().max(400).optional(),
  ibkr_code: z.number().int().optional(),
  retry_after_seconds: z.number().int().nonnegative().optional(),
});

const clean = (text: string): string => {
  return redactIbkrAccounts(text)
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
        message ||
          `IBKR history service returned HTTP ${response.status} with no message; retry`
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
  // Bars v1 and v2 (history-answer.ts): v2 volume as sent when its unit is shares or contracts; v1 stock,
  // index and Forex volume is null (ibapi 9.81 stock volume has no fixed unit). The /charts request echo
  // keeps its narrower lists (STK, FUT, CONTFUT, CASH; TRADES, MIDPOINT; no end date), so it refuses IND.
  const document = parseHistoryBarsAnswer(raw, "v1-or-v2");
  const request =
    document === null
      ? null
      : MarketBarsRequestEchoSchema.safeParse(document.request);
  if (document === null || request === null || !request.success)
    throw new MarketDataError(
      "UPSTREAM_ERROR",
      "History response failed schema validation"
    );
  return {
    source: document.source,
    request: request.data,
    contract: document.contract,
    bars: document.bars,
    count: document.count,
    fetchedAt: document.fetchedAt,
    asOf: document.asOf,
    cache: {
      hit: document.cache.hit,
      ageSeconds: document.cache.age_seconds,
      ttlSeconds: document.cache.ttl_seconds,
      stale: document.cache.stale,
    },
    receivedAt: receivedAt.toISOString(),
  };
};

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
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", abortFromCaller, { once: true });
  }
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
        externalSignal?.aborted
          ? "History request cancelled"
          : controller.signal.aborted
            ? "History request timed out"
            : "History request failed"
      );
    }
    if (options.notFoundOn404 === true && response.status === 404) {
      void response.body?.cancel();
      throw new MarketDataError(
        "NOT_FOUND",
        "Market DOM endpoint not found on history service (HTTP 404)"
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
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", abortFromCaller);
    }
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

/** Upstream free text for a stored sample message: redacted like other upstream messages, cut. */
const tapeStreamError = (error: string | null): string | null =>
  error === null ? null : clean(error).slice(0, MARKET_TAPE_ERROR_MAX);

export const fetchMarketTape = async (
  config: DeployStatusConfig | null,
  input: Readonly<{ symbol: string; since: number }>,
  options: FetchMarketBarsOptions = {}
): Promise<MarketTape> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketTapeUrl(base, input),
    MARKET_TAPE_TIMEOUT_MS,
    options
  );
  const parsed = VertexTapeUpstreamSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  const { schema: _schema, client_id: _clientId, ...document } = parsed.data;
  return {
    ...document,
    receivedAt: receivedNow(options).toISOString(),
    stream: {
      ...document.stream,
      error: tapeStreamError(document.stream.error),
    },
  };
};

export const fetchMarketDepthHistory = async (
  config: DeployStatusConfig | null,
  input: Readonly<{ symbol: string; since: number }>,
  options: FetchMarketBarsOptions = {}
): Promise<MarketDepthHistory> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketDepthHistoryUrl(base, input),
    MARKET_DEPTH_HISTORY_TIMEOUT_MS,
    options
  );
  const parsed = VertexDepthHistoryUpstreamSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  const { schema: _schema, client_id: _clientId, ...document } = parsed.data;
  return {
    ...document,
    receivedAt: receivedNow(options).toISOString(),
    stream: {
      ...document.stream,
      error: tapeStreamError(document.stream.error),
    },
  };
};

export const fetchMarketDom = async (
  config: DeployStatusConfig | null,
  input: MarketDomFetchInput,
  options: FetchMarketBarsOptions = {}
): Promise<MarketDom> => {
  const raw = await fetchHistoryDocument(
    config,
    (base) => buildMarketDomUrl(base, input),
    MARKET_DOM_TIMEOUT_MS,
    { ...options, notFoundOn404: true }
  );
  const parsed = VertexDomUpstreamSchema.safeParse(raw);
  if (!parsed.success) throw schemaFailure();
  const { schema: _schema, client_id: _clientId, ...document } = parsed.data;
  return {
    ...document,
    depthStream: {
      ...document.depthStream,
      error: tapeStreamError(document.depthStream.error),
    },
    receivedAt: receivedNow(options).toISOString(),
    tapeStream: {
      ...document.tapeStream,
      error: tapeStreamError(document.tapeStream.error),
    },
  };
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
