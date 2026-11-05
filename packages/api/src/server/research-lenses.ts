import { implement } from "@orpc/server";
import type { z } from "zod";
import { appContract } from "../contract.ts";
import {
  type DeepValueDocument,
  DeepValueDocumentSchema,
  type DeepValueOutput,
  type DeepValueScoreOutput,
  type RotationMatrixDocument,
  RotationMatrixDocumentSchema,
  type RotationMatrixOutput,
  type RotationPeriod,
} from "../contracts/research-lenses.ts";
import {
  barsFromYahooChart,
  CompanyFactsSchema,
  factsFromBars,
  factsFromCompanyFacts,
  YahooChartSchema,
} from "../deep-value-facts.ts";
import {
  type DeepValueFacts,
  scoreDeepValueTicker,
  withDeepValuePeers,
} from "../deep-value-score.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { readCappedText } from "./portfolio-monitor.ts";
import { researchUserAgent } from "./research-contact.ts";

// Read-only research lenses. The rig data jobs (vertex-research collect-rotation-matrix.mjs and
// collect-deep-value.mjs) write JSON documents; they are served on the QuantVPS tailnet under
// VERTEX_RESEARCH_LENSES_URL (bearer VERTEX_DEPLOY_STATUS_TOKEN). GET only, bounded time and size,
// redirects never followed, schema parse, 60 s in-process cache. The on-demand TRUE SLAP score reads
// Yahoo Finance daily bars and SEC EDGAR XBRL facts directly. Messages never include the token or URL.

const LENS_TIMEOUT_MS = 20_000;
const LENS_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
const LENS_CACHE_TTL_MS = 60_000;
// Large filers publish big companyfacts documents (tens of MiB).
const SEC_FACTS_MAX_BYTES = 64 * 1024 * 1024;
const SEC_TICKERS_MAX_BYTES = 8 * 1024 * 1024;
const SEC_TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
const YAHOO_MAX_BYTES = 4 * 1024 * 1024;
// SEC asks automated clients for a descriptive User-Agent with a contact address.
export const secUserAgent = (): string => researchUserAgent("deep-value");
const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/deep-value";

export type ResearchLensErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR";

export class ResearchLensError extends Error {
  code: ResearchLensErrorCode;
  constructor(code: ResearchLensErrorCode, message: string) {
    super(message);
    this.name = "ResearchLensError";
    this.code = code;
  }
}

export type ResearchLensOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}>;

type JsonRequest = Readonly<{
  url: string;
  label: string;
  headers: Record<string, string>;
  maxBytes: number;
}>;

/** One bounded GET returning parsed JSON. HTTP 404 => NOT_FOUND; gateway errors and timeouts => UNAVAILABLE. */
export const fetchBoundedJson = async (
  request: JsonRequest,
  options: ResearchLensOptions = {}
): Promise<unknown> => {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LENS_TIMEOUT_MS
  );
  const fail = (code: ResearchLensErrorCode, detail: string) =>
    new ResearchLensError(code, `${request.label} ${detail}`);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        headers: { accept: "application/json", ...request.headers },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw fail(
        "UNAVAILABLE",
        controller.signal.aborted ? "request timed out" : "request failed"
      );
    }
    if (response.status === 404) throw fail("NOT_FOUND", "returned HTTP 404");
    if ([502, 503, 504].includes(response.status))
      throw fail("UNAVAILABLE", `returned HTTP ${response.status}`);
    if (response.status !== 200)
      throw fail("UPSTREAM_ERROR", `returned HTTP ${response.status}`);
    if (
      !/^application\/json\b/iu.test(response.headers.get("content-type") ?? "")
    )
      throw fail("UPSTREAM_ERROR", "returned an unexpected content type");
    let body: string;
    try {
      body = await readCappedText(response, request.maxBytes, (message) =>
        fail("UPSTREAM_ERROR", message.toLowerCase())
      );
    } catch (error) {
      if (error instanceof ResearchLensError) throw error;
      throw controller.signal.aborted
        ? fail("UNAVAILABLE", "request timed out")
        : fail("UPSTREAM_ERROR", "response could not be read");
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw fail("UPSTREAM_ERROR", "response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
};

const parseWith = <T extends z.ZodType>(
  schema: T,
  raw: unknown,
  label: string
): z.infer<T> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ResearchLensError(
      "UPSTREAM_ERROR",
      `${label} failed schema validation`
    );
  return parsed.data;
};

type CachedDocument = Readonly<{ at: number; value: unknown }>;
const documentCache = new Map<string, CachedDocument>();
let tickerCache: Readonly<{ at: number; map: Map<string, SecTicker> }> | null =
  null;

export const clearResearchLensCacheForTesting = (): void => {
  documentCache.clear();
  tickerCache = null;
};

const LENS_DOCUMENTS = {
  deepValue: {
    file: "deep-value.json",
    label: "Deep value scorecard",
    schema: DeepValueDocumentSchema,
  },
  rotation: {
    file: "rotation-matrix.json",
    label: "Rotation matrix",
    schema: RotationMatrixDocumentSchema,
  },
} as const;

interface LensDocuments {
  deepValue: DeepValueDocument;
  rotation: RotationMatrixDocument;
}

/** Loads one lens document from the tailnet service, with a 60 s cache. `at` is the fetch time. */
const loadLensDocument = async <K extends keyof LensDocuments>(
  config: DeployStatusConfig | null,
  kind: K,
  options: ResearchLensOptions
): Promise<{ at: Date; document: LensDocuments[K] }> => {
  const spec = LENS_DOCUMENTS[kind];
  if (config === null)
    throw new ResearchLensError(
      "NOT_CONFIGURED",
      "Research lens endpoint not configured (VERTEX_RESEARCH_LENSES_URL)"
    );
  const now = (options.now ?? (() => new Date()))().getTime();
  const key = `${config.url}|${kind}`;
  const cached = documentCache.get(key);
  if (cached !== undefined && now - cached.at < LENS_CACHE_TTL_MS)
    return {
      at: new Date(cached.at),
      document: cached.value as LensDocuments[K],
    };
  let raw: unknown;
  try {
    raw = await fetchBoundedJson(
      {
        headers: { authorization: `Bearer ${config.token}` },
        label: spec.label,
        maxBytes: options.maxBytes ?? LENS_DOCUMENT_MAX_BYTES,
        url: `${config.url.replace(/\/+$/u, "")}/${spec.file}`,
      },
      options
    );
  } catch (error) {
    // A missing file means the data job has not published yet.
    if (error instanceof ResearchLensError && error.code === "NOT_FOUND")
      throw new ResearchLensError(
        "NOT_FOUND",
        `${spec.label} not yet collected`
      );
    throw error;
  }
  const document = parseWith(spec.schema, raw, spec.label);
  documentCache.set(key, { at: now, value: document });
  return { at: new Date(now), document: document as LensDocuments[K] };
};

export const fetchRotationMatrix = async (
  config: DeployStatusConfig | null,
  period: RotationPeriod,
  options: ResearchLensOptions = {}
): Promise<RotationMatrixOutput> => {
  const { at, document } = await loadLensDocument(config, "rotation", options);
  return {
    ...document.periods[period],
    asOf: document.asOf,
    capLabels: document.capLabels,
    generatedAt: document.generatedAt,
    ours: document.ours,
    period,
    receivedAt: at.toISOString(),
    source: document.source ?? null,
    universeSize: document.universeSize,
  };
};

export const fetchDeepValue = async (
  config: DeployStatusConfig | null,
  options: ResearchLensOptions = {}
): Promise<DeepValueOutput> => {
  const { at, document } = await loadLensDocument(config, "deepValue", options);
  // Peer tables stay server-side; they feed the on-demand score only.
  const {
    industryMedians: _medians,
    industryBySymbol: _industries,
    ...view
  } = document;
  return { ...view, receivedAt: at.toISOString() };
};

export type SecTicker = Readonly<{ cik: number; title: string }>;

/** SEC ticker -> { cik, title } map (company_tickers.json), cached for 24 h. */
export const secTickers = async (
  options: ResearchLensOptions
): Promise<Map<string, SecTicker>> => {
  const now = (options.now ?? (() => new Date()))().getTime();
  if (tickerCache !== null && now - tickerCache.at < SEC_TICKERS_TTL_MS)
    return tickerCache.map;
  const raw = await fetchBoundedJson(
    {
      headers: { "user-agent": secUserAgent() },
      label: "SEC ticker list",
      maxBytes: SEC_TICKERS_MAX_BYTES,
      url: "https://www.sec.gov/files/company_tickers.json",
    },
    options
  );
  const rows =
    typeof raw === "object" && raw !== null ? Object.values(raw) : [];
  const map = new Map<string, SecTicker>();
  for (const row of rows) {
    const { cik_str: cik, ticker, title } = row as Record<string, unknown>;
    if (
      typeof cik === "number" &&
      typeof ticker === "string" &&
      typeof title === "string"
    )
      map.set(ticker.toUpperCase(), { cik, title });
  }
  tickerCache = { at: now, map };
  return map;
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "request failed";

/** Gather Yahoo price facts and SEC fundamentals for one ticker. Errors per source are recorded. */
export const gatherDeepValueFacts = async (
  symbol: string,
  industry: string | undefined,
  options: ResearchLensOptions = {}
): Promise<{ facts: DeepValueFacts; errors: string[] }> => {
  const errors: string[] = [];
  let facts: DeepValueFacts = {
    roles: ["requested"],
    symbol,
    ...(industry === undefined ? {} : { industry }),
  };
  try {
    const yahooSymbol = symbol.replace(/[./]/gu, "-");
    const raw = await fetchBoundedJson(
      {
        headers: { "user-agent": YAHOO_USER_AGENT },
        label: "Yahoo chart",
        maxBytes: YAHOO_MAX_BYTES,
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1y&interval=1d`,
      },
      options
    );
    const chart = barsFromYahooChart(
      parseWith(YahooChartSchema, raw, "Yahoo chart")
    );
    if (chart.bars.length === 0)
      throw new ResearchLensError("NOT_FOUND", "Yahoo chart has no daily bars");
    facts = {
      ...facts,
      ...factsFromBars(chart.bars),
      asOf: chart.asOf,
      ...(chart.name === null ? {} : { name: chart.name }),
    };
  } catch (error) {
    errors.push(`prices: ${reason(error)}`);
  }
  try {
    const tickers = await secTickers(options);
    const hit = tickers.get(symbol.replace(".", "-")) ?? tickers.get(symbol);
    if (hit !== undefined) {
      facts = { ...facts, cik: hit.cik, name: facts.name ?? hit.title };
      const raw = await fetchBoundedJson(
        {
          headers: { "user-agent": secUserAgent() },
          label: "SEC companyfacts",
          maxBytes: SEC_FACTS_MAX_BYTES,
          url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(hit.cik).padStart(10, "0")}.json`,
        },
        options
      ).catch((error: unknown) => {
        // A listed issuer without XBRL facts answers 404: score from prices only.
        if (error instanceof ResearchLensError && error.code === "NOT_FOUND")
          return null;
        throw error;
      });
      if (raw !== null)
        facts = {
          ...facts,
          ...factsFromCompanyFacts(
            parseWith(CompanyFactsSchema, raw, "SEC companyfacts"),
            (options.now ?? (() => new Date()))()
          ),
        };
    }
  } catch (error) {
    errors.push(`sec: ${reason(error)}`);
  }
  return { errors, facts };
};

export const scoreDeepValueSymbol = async (
  config: DeployStatusConfig | null,
  symbol: string,
  options: ResearchLensOptions = {}
): Promise<DeepValueScoreOutput> => {
  // Peer medians and industry come from the last stored run, when present; otherwise score without peers.
  let stored: DeepValueDocument | null = null;
  try {
    stored = (await loadLensDocument(config, "deepValue", options)).document;
  } catch {
    stored = null;
  }
  const { facts, errors } = await gatherDeepValueFacts(
    symbol,
    stored?.industryBySymbol?.[symbol],
    options
  );
  if (errors.length === 2)
    throw new ResearchLensError(
      "NOT_FOUND",
      `No price or SEC data for ${symbol} (${errors.join("; ")})`
    );
  const peered = withDeepValuePeers(facts, stored?.industryMedians);
  const median =
    peered.peerEvSales === undefined
      ? null
      : { evSales: peered.peerEvSales, n: peered.peerCount as number };
  return { ...scoreDeepValueTicker(peered), errors, peerMedian: median };
};

const api = implement(appContract).$context<ApiContext>();

type ResearchLensErrorFactories = Readonly<
  Record<ResearchLensErrorCode, (options?: { message?: string }) => Error>
>;

let researchLensOptions: ResearchLensOptions = {};
export const setResearchLensOptionsForTesting = (
  options: ResearchLensOptions
): void => {
  researchLensOptions = options;
};

const mapFailure = (
  errors: unknown,
  error: unknown,
  fallback: string
): Error => {
  const failures = errors as ResearchLensErrorFactories;
  if (error instanceof ResearchLensError)
    return failures[error.code]({ message: error.message });
  return failures.UPSTREAM_ERROR({ message: fallback });
};

const rotationMatrix = api.researchLenses.rotationMatrix
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    try {
      return await fetchRotationMatrix(
        context.researchLenses ?? null,
        input.period,
        researchLensOptions
      );
    } catch (error) {
      throw mapFailure(errors, error, "Rotation matrix request failed");
    }
  });

const deepValue = api.researchLenses.deepValue
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    try {
      return await fetchDeepValue(
        context.researchLenses ?? null,
        researchLensOptions
      );
    } catch (error) {
      throw mapFailure(errors, error, "Deep value request failed");
    }
  });

const deepValueScore = api.researchLenses.deepValueScore
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    try {
      return await scoreDeepValueSymbol(
        context.researchLenses ?? null,
        input.symbol,
        researchLensOptions
      );
    } catch (error) {
      throw mapFailure(errors, error, "Scoring failed");
    }
  });

export const researchLensesRouter = {
  deepValue,
  deepValueScore,
  rotationMatrix,
};
