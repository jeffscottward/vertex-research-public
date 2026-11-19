// Allowlist parser of the dossier payoff lab (merge plan P1-6). It is the only code that reads the
// stored `options-analysis` JSON for the lab. Its output has no field for a stored string except a
// checked expiry date, a kind from the closed list and a three-letter currency code, so no later
// code can render stored text.
// A stock row is kept only when the dossier marks it hypothetical. It reads the stored id of no row.
// Research only.
import {
  type OptionKind,
  type PayoffKind,
  type PayoffLeg,
  type PayoffReason,
  type PayoffStrategy,
  prepareExpiryPayoff,
  readMultiplier,
} from "./payoff.ts";

/** Reports whose option legs without a stored multiplier use 100 shares per contract, as in the old app. */
export const LEGACY_MULTIPLIER_REPORT_IDS: readonly string[] = ["APP"];
/** Reports that pass the asset-type gate without a catalog asset type, as in the old lab. */
export const UNTYPED_REPORT_IDS: readonly string[] = ["APP", "SIVE"];
const LEGACY_MULTIPLIER = 100;
/** A strike, basis, breakeven or net premium above this is refused: the axis and labels stay bounded. */
const MAX_PRICE = 1e12;
const MAX_LEGS = 2;

/** What the lab needs from the catalog read that the dossier page already makes. */
export type CatalogFacts =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{
      status: "ready";
      /** `null` also when the catalog does not list the report. */
      assetType: string | null;
      currency: string | null;
    }>;

export type AssetGate = "allowed" | "refused" | "unread";

const LAB_ASSET_TYPES: readonly string[] = ["equity", "etf"];

/**
 * The asset-type gate (owner decision 2026-11-18, the gate of the old lab): the lab draws lines
 * only for an equity or ETF dossier. A report without a stated type passes only when it is in
 * `UNTYPED_REPORT_IDS`; a catalog that could not be read refuses every line.
 */
export const assetGate = (
  reportId: string,
  facts: Exclude<CatalogFacts, { status: "loading" }>
): AssetGate => {
  if (facts.status === "failed") return "unread";
  const assetType = (facts.assetType ?? "").trim().toLowerCase();
  const allowed =
    assetType === ""
      ? UNTYPED_REPORT_IDS.includes(reportId)
      : LAB_ASSET_TYPES.includes(assetType);
  return allowed ? "allowed" : "refused";
};

export type RowReason =
  | "row-shape"
  | "asset-type"
  | "asset-type-unread"
  | "expiry"
  | "leg-shape"
  | PayoffReason;

export type LabLine = Readonly<{
  /** `line-<position of the first stored row>`; never the stored id. */
  key: string;
  kind: PayoffKind;
  /** A real `YYYY-MM-DD` date for an option kind; `null` for stock. */
  expiry: string | null;
  /** Ascending; empty for stock. */
  strikes: readonly number[];
  /** Per share: above 0 is a debit, below 0 a credit; the entry basis for stock. */
  netPremium: number;
  /** Breakeven prices and the start of each breakeven range; they do not depend on the size. */
  breakevens: readonly number[];
  strategy: PayoffStrategy;
  /** 1 contract for an option kind; the stored hypothetical share count for stock. */
  defaultUnits: number;
  /** Stored rows merged into this line. */
  rows: number;
}>;

export type ParsedStrategies =
  | Readonly<{ state: "no-strategies" }>
  | Readonly<{ state: "malformed" }>
  | Readonly<{
      state: "parsed";
      stored: number;
      drawableRows: number;
      lines: readonly LabLine[];
      notDrawable: readonly Readonly<{ reason: RowReason; rows: number }>[];
      notShown: number;
      currency: string | null;
    }>;

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

const OPTION_KINDS: readonly OptionKind[] = [
  "long-call",
  "cash-secured-put",
  "bull-call-spread",
  "put-credit-spread",
];
const optionKind = (value: unknown): OptionKind | null =>
  OPTION_KINDS.find((kind) => kind === value) ?? null;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** A real calendar date in `YYYY-MM-DD` form, or `null`. */
const expiryDate = (value: unknown): string | null => {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (match === null) return null;
  const [text, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === text ? text : null;
};

const CURRENCY = /^[A-Z]{3}$/u;
const currencyCode = (value: unknown): string | null =>
  typeof value === "string" && CURRENCY.test(value) ? value : null;

const numberOr = <T>(value: unknown, fallback: T): number | T =>
  typeof value === "number" ? value : fallback;

const side = (value: unknown): PayoffLeg["side"] | null =>
  value === "buy" || value === "sell" ? value : null;
const optionType = (value: unknown): PayoffLeg["type"] | null =>
  value === "call" || value === "put" ? value : null;

/** The legs of an option row, or the reason why the row has none that the model can read. */
const readLegs = (value: unknown): readonly PayoffLeg[] | RowReason => {
  if (!Array.isArray(value) || value.length === 0) return "no-legs";
  if (value.length > MAX_LEGS) return "leg-shape";
  const legs: PayoffLeg[] = [];
  for (const entry of value) {
    const leg = record(entry);
    const legSide = side(leg?.["side"]);
    const legType = optionType(leg?.["type"]);
    if (leg === null || legSide === null || legType === null)
      return "leg-shape";
    legs.push({
      multiplier: readMultiplier(leg["multiplier"]),
      premium: numberOr(leg["premium"], null),
      side: legSide,
      strike: numberOr(leg["strike"], Number.NaN),
      type: legType,
    });
  }
  return legs;
};

type Candidate = Readonly<{
  kind: PayoffKind;
  expiry: string | null;
  strategy: PayoffStrategy;
  defaultUnits: number;
}>;
type RowResult =
  | Readonly<{
      outcome: "line";
      candidate: Candidate;
      netPremium: number;
      breakevens: readonly number[];
    }>
  | Readonly<{ outcome: "not-drawable"; reason: RowReason }>
  | Readonly<{ outcome: "not-shown" }>;

const refuse = (reason: RowReason): RowResult => ({
  outcome: "not-drawable",
  reason,
});

/** A candidate becomes a line when the model accepts it at its default size. */
const decide = (candidate: Candidate): RowResult => {
  const payoff = prepareExpiryPayoff(
    candidate.strategy,
    candidate.defaultUnits
  );
  if (!payoff.available) return refuse(payoff.reason);
  const breakevens = [
    ...payoff.breakevens,
    ...payoff.breakevenRanges.map((range) => range.from),
  ];
  return [
    ...payoff.knots,
    ...breakevens,
    Math.abs(payoff.netPremiumPerShare),
  ].some((price) => price > MAX_PRICE)
    ? refuse("range")
    : {
        breakevens,
        candidate,
        netPremium: payoff.netPremiumPerShare,
        outcome: "line",
      };
};

/** A stock row that the dossier does not mark as hypothetical with shares above 0 is not shown. */
const hypotheticalShares = (row: Json): number | null => {
  const shares = row["stockShares"];
  return row["hypothetical"] === true &&
    typeof shares === "number" &&
    Number.isFinite(shares) &&
    shares > 0
    ? shares
    : null;
};

const readOptionRow = (
  row: Json,
  kind: OptionKind,
  context: ParseContext
): RowResult => {
  const legs = readLegs(row["legs"]);
  if (typeof legs === "string") return refuse(legs);
  const expiry = expiryDate(row["expiry"]);
  if (expiry === null) return refuse("expiry");
  return decide({
    defaultUnits: 1,
    expiry,
    kind,
    strategy: {
      assumedMultiplier: LEGACY_MULTIPLIER_REPORT_IDS.includes(context.reportId)
        ? LEGACY_MULTIPLIER
        : null,
      kind,
      legs,
      multiplier: readMultiplier(row["multiplier"]),
    },
  });
};

export type ParseContext = Readonly<{
  reportId: string;
  gate: AssetGate;
  catalogCurrency: string | null;
}>;

/** The refusal of the asset-type gate for a row that could be drawn; `null` when the gate allows it. */
const gateRefusal = (gate: AssetGate): RowResult | null => {
  if (gate === "refused") return refuse("asset-type");
  return gate === "unread" ? refuse("asset-type-unread") : null;
};

const readRow = (value: unknown, context: ParseContext): RowResult => {
  const row = record(value);
  if (row === null) return refuse("row-shape");
  if (row["kind"] === "stock") {
    const shares = hypotheticalShares(row);
    if (shares === null) return { outcome: "not-shown" };
    return (
      gateRefusal(context.gate) ??
      decide({
        defaultUnits: shares,
        expiry: null,
        kind: "stock",
        strategy: { basis: numberOr(row["stockEntry"], null), kind: "stock" },
      })
    );
  }
  const kind = optionKind(row["kind"]);
  if (kind === null) return refuse("row-shape");
  return gateRefusal(context.gate) ?? readOptionRow(row, kind, context);
};

/** Rows that differ only in fields outside the line share this text and become one line. */
const mergeKey = (candidate: Candidate): string =>
  JSON.stringify([
    candidate.kind,
    candidate.expiry,
    candidate.strategy,
    candidate.defaultUnits,
  ]);

const strikesOf = (strategy: PayoffStrategy): readonly number[] =>
  strategy.kind === "stock"
    ? []
    : [...new Set(strategy.legs.map((leg) => leg.strike))].sort(
        (a, b) => a - b
      );

export const parsePayoffStrategies = (
  data: unknown,
  context: ParseContext
): ParsedStrategies => {
  const dataset = record(data);
  const strategies = dataset?.["strategies"];
  if (dataset === null || strategies === undefined)
    return { state: "no-strategies" };
  if (!Array.isArray(strategies)) return { state: "malformed" };
  if (strategies.length === 0) return { state: "no-strategies" };

  const lines = new Map<string, LabLine>();
  const reasons = new Map<RowReason, number>();
  let notShown = 0;
  let drawableRows = 0;
  for (const [position, value] of strategies.entries()) {
    const result = readRow(value, context);
    if (result.outcome === "not-shown") notShown += 1;
    else if (result.outcome === "not-drawable")
      reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
    else {
      drawableRows += 1;
      const { candidate } = result;
      const key = mergeKey(candidate);
      const merged = lines.get(key);
      lines.set(
        key,
        merged === undefined
          ? {
              ...candidate,
              breakevens: result.breakevens,
              key: `line-${position}`,
              netPremium: result.netPremium,
              rows: 1,
              strikes: strikesOf(candidate.strategy),
            }
          : { ...merged, rows: merged.rows + 1 }
      );
    }
  }
  return {
    currency:
      currencyCode(dataset["currency"]) ??
      currencyCode(context.catalogCurrency),
    drawableRows,
    lines: [...lines.values()],
    notDrawable: [...reasons.entries()]
      .map(([reason, rows]) => ({ reason, rows }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    notShown,
    state: "parsed",
    stored: strategies.length,
  };
};
