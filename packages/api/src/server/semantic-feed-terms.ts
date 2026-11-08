import type {
  PortfolioMonitorOutput,
  PortfolioMonitorPosition,
} from "../contracts/portfolio-monitor.ts";
import type {
  SemanticParamValue,
  SemanticRow,
} from "../contracts/semantic-terms.ts";

// Feed terms of the agent semantic layer (docs/vertex-rebuild/agent-semantic-layer.md). Each reads the
// live IBKR account through the vertex-portfolio snapshot (portfolio-monitor.ts). The QuantVPS exec
// node (deployment_status) is the paper account and is never read here. A disconnected gateway, a stale
// snapshot or a missing value gives status "unknown", never 0. Pure functions: the caller fetches.

/** A snapshot older than this is stale: the feed term answers "unknown". */
export const SEMANTIC_FEED_MAX_AGE_MS = 5 * 60_000;
/** A dataAsOf further ahead of the server clock than this is untrustworthy. */
export const SEMANTIC_FEED_MAX_FUTURE_SKEW_MS = 60_000;
const DEFAULT_OPTION_MULTIPLIER = 100;

export type FeedTermStatus = "ok" | "unknown";
export type FeedTermResult = Readonly<{
  status: FeedTermStatus;
  rows: readonly SemanticRow[];
  answer: string;
}>;
export type FeedTermParams = Readonly<Record<string, SemanticParamValue>>;
export type FeedTermReader = (
  snapshot: PortfolioMonitorOutput,
  params: FeedTermParams
) => FeedTermResult;

const usd = (value: number): string =>
  `${value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })} USD`;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const LIVE = "the live IBKR account (vertex-portfolio feed)";

const unknown = (answer: string): FeedTermResult => ({
  answer,
  rows: [],
  status: "unknown",
});

/**
 * Why the snapshot cannot be trusted now, or null when it is live and fresh. The as-of time is the
 * snapshot's dataAsOf (generatedAt while the IB session is live).
 */
export const feedProblem = (
  snapshot: PortfolioMonitorOutput,
  now: Date
): string | null => {
  const { connected, dataAsOf, gateway } = snapshot.status;
  if (gateway !== "live" || !connected) {
    return `The IB gateway is ${gateway}${connected ? "" : " and disconnected"}; live account values are unknown.`;
  }
  if (dataAsOf === null)
    return "The feed has no data time; values are unknown.";
  const ageMs = now.getTime() - Date.parse(dataAsOf);
  if (Number.isNaN(ageMs)) {
    return `The feed data time ${dataAsOf} is not a valid time; values are unknown.`;
  }
  if (ageMs < -SEMANTIC_FEED_MAX_FUTURE_SKEW_MS) {
    return `The feed data time ${dataAsOf} is in the future; values are unknown.`;
  }
  if (ageMs > SEMANTIC_FEED_MAX_AGE_MS) {
    return `The feed data is ${Math.round(ageMs / 60_000)} minutes old (as of ${dataAsOf}); live account values are unknown.`;
  }
  return null;
};

const netLiquidation: FeedTermReader = (snapshot) => {
  const value = snapshot.summary.netLiquidation;
  if (value === null)
    return unknown("The feed reports no net liquidation value.");
  return {
    answer: `Net liquidation of ${LIVE}: ${usd(value)}.`,
    rows: [{ currency: "USD", net_liquidation: value }],
    status: "ok",
  };
};

const PNL_WINDOWS = ["daily", "unrealized", "realized"] as const;
type PnlWindow = (typeof PNL_WINDOWS)[number];

const pnl: FeedTermReader = (snapshot, params) => {
  const window = params["window"];
  const windows: readonly PnlWindow[] =
    typeof window === "string" &&
    (PNL_WINDOWS as readonly string[]).includes(window)
      ? [window as PnlWindow]
      : PNL_WINDOWS;
  const missing = windows.filter((name) => snapshot.pnl[name] === null);
  if (missing.length > 0) {
    return unknown(`The feed reports no ${missing.join(", ")} P&L.`);
  }
  const rows = windows.map((name) => ({
    currency: "USD",
    pnl: snapshot.pnl[name] as number,
    window: name,
  }));
  return {
    answer: `P&L of ${LIVE}: ${rows.map((row) => `${row.window} ${usd(row.pnl)}`).join("; ")}.`,
    rows,
    status: "ok",
  };
};

const positionRow = (row: PortfolioMonitorPosition): SemanticRow => ({
  avg_price: row.avgPrice,
  cost_basis: row.costBasis,
  description: row.description,
  expiry: row.option?.expiry ?? null,
  last: row.last,
  market_value: row.marketValue,
  quantity: row.position,
  right: row.option?.right ?? null,
  sec_type: row.secType,
  strike: row.option?.strike ?? null,
  symbol: row.symbol,
  unrealized: row.unrealized,
});

const position: FeedTermReader = (snapshot, params) => {
  const symbol = String(params["symbol"] ?? "").toUpperCase();
  const secType = params["sec_type"];
  const rows = snapshot.positions
    .filter(
      (row) =>
        row.symbol.toUpperCase() === symbol &&
        row.position !== 0 &&
        (typeof secType !== "string" || row.secType === secType.toUpperCase())
    )
    .map(positionRow);
  const scope = typeof secType === "string" ? ` ${secType.toUpperCase()}` : "";
  return {
    answer:
      rows.length === 0
        ? `${LIVE} holds no ${symbol}${scope} position.`
        : `${symbol}${scope} positions in ${LIVE}: ${rows.length} row(s).`,
    rows,
    status: "ok",
  };
};

// ---------------------------------------------------------------------------
// open_risk: owner definition (2026-11-05). Long option or debit spread = debit paid; defined-width
// credit spread = width x multiplier x contracts - net credit. Legs are paired within one underlying,
// expiry and right; any short leg left without a long leg has no defined maximum loss.

interface Leg {
  description: string;
  key: string;
  /** Side from the sign of the position (a zero-cost short is still a short). */
  long: boolean;
  multiplier: number;
  /** Contracts still unpaired (absolute). */
  open: number;
  /** Premium per contract in USD: sign(position) * costBasis / contracts. */
  premium: number;
  right: "C" | "P";
  strike: number;
}

export type OpenRiskStructure = Readonly<{
  structure: "long option" | "debit spread" | "credit spread";
  description: string;
  contracts: number;
  max_loss: number;
}>;

export type OpenRiskResult =
  | Readonly<{
      kind: "defined";
      structures: readonly OpenRiskStructure[];
      total: number;
    }>
  | Readonly<{ kind: "undefined"; legs: readonly string[] }>;

const rightOf = (value: string): "C" | "P" | null => {
  const upper = value.toUpperCase();
  if (upper === "C" || upper === "CALL") return "C";
  if (upper === "P" || upper === "PUT") return "P";
  return null;
};

const toLeg = (row: PortfolioMonitorPosition): Leg | null => {
  const option = row.option;
  const right = option === undefined ? null : rightOf(option.right);
  if (option === undefined || right === null || row.costBasis === null) {
    return null;
  }
  const contracts = Math.abs(row.position);
  const perShare = row.avgPrice === null ? 0 : Math.abs(row.avgPrice);
  const multiplier =
    perShare > 0
      ? Math.round(row.costBasis / (perShare * contracts))
      : DEFAULT_OPTION_MULTIPLIER;
  const long = row.position > 0;
  const premium = row.costBasis / contracts;
  return {
    description: row.description,
    key: `${row.symbol.toUpperCase()}|${option.expiry}|${right}`,
    long,
    multiplier,
    open: contracts,
    premium: long ? premium : -premium,
    right,
    strike: option.strike,
  };
};

/** Maximum loss of a long/short vertical per contract: net premium plus the width the short side can lose. */
const verticalLoss = (long: Leg, short: Leg): number => {
  const width =
    long.right === "C"
      ? long.strike - short.strike
      : short.strike - long.strike;
  return Math.max(
    0,
    long.premium + short.premium + Math.max(0, width) * long.multiplier
  );
};

export const computeOpenRisk = (
  positions: readonly PortfolioMonitorPosition[]
): OpenRiskResult => {
  const optionRows = positions.filter(
    (row) => row.secType === "OPT" && row.position !== 0
  );
  const legs = optionRows.map(toLeg);
  const unreadable = optionRows
    .filter((_, index) => legs[index] === null)
    .map((row) => row.description);
  if (unreadable.length > 0) return { kind: "undefined", legs: unreadable };
  const known = legs as Leg[];
  const structures: OpenRiskStructure[] = [];
  const longs = known.filter((leg) => leg.long);
  for (const short of known.filter((leg) => !leg.long)) {
    const candidates = longs
      .filter((leg) => leg.key === short.key)
      .sort(
        (left, right) =>
          Math.abs(left.strike - short.strike) -
          Math.abs(right.strike - short.strike)
      );
    for (const long of candidates) {
      const contracts = Math.min(long.open, short.open);
      if (contracts === 0) continue;
      const perContract = verticalLoss(long, short);
      structures.push({
        contracts,
        description: `${long.description} / ${short.description}`,
        max_loss: round2(perContract * contracts),
        structure:
          long.premium + short.premium > 0 ? "debit spread" : "credit spread",
      });
      long.open -= contracts;
      short.open -= contracts;
    }
  }
  const naked = known.filter((leg) => !leg.long && leg.open > 0);
  if (naked.length > 0) {
    return { kind: "undefined", legs: naked.map((leg) => leg.description) };
  }
  for (const long of longs.filter((leg) => leg.open > 0)) {
    structures.push({
      contracts: long.open,
      description: long.description,
      max_loss: round2(long.premium * long.open),
      structure: "long option",
    });
  }
  return {
    kind: "defined",
    structures,
    total: round2(structures.reduce((sum, row) => sum + row.max_loss, 0)),
  };
};

const openRisk: FeedTermReader = (snapshot) => {
  const result = computeOpenRisk(snapshot.positions);
  if (result.kind === "undefined") {
    return unknown(
      `Open risk is unknown: these option legs have no defined maximum loss under the certified definition: ${result.legs.join("; ")}.`
    );
  }
  const nlv = snapshot.summary.netLiquidation;
  const percent =
    nlv === null || nlv <= 0 ? null : round2((result.total / nlv) * 100);
  return {
    answer: `Open options risk of ${LIVE}: ${usd(result.total)} maximum loss across ${result.structures.length} structure(s)${
      percent === null
        ? "; percent of NLV unknown (no NLV)"
        : `, ${percent}% of NLV ${usd(nlv as number)}`
    }.`,
    rows: [
      ...result.structures,
      {
        contracts: null,
        description: "all open option structures",
        max_loss: result.total,
        percent_of_nlv: percent,
        structure: "total",
      },
    ],
    status: "ok",
  };
};

/** Feed term readers by term id. A feed term without a reader here answers "not available". */
export const FEED_TERM_READERS: Readonly<Record<string, FeedTermReader>> = {
  net_liquidation: netLiquidation,
  open_risk: openRisk,
  pnl,
  position,
};
