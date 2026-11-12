// What: the `leveraged-etf-universe-v1` document, as a Zod schema. The Python fetcher
// (research/backtests/leveraged-etf/universe.py) prints one document; the import CLI (import.ts in
// this folder) reads it from stdin and checks it with this schema before it writes to Postgres.
// Why here: the import CLI is the only reader of the document. No oRPC route takes or returns it,
// so it is not a contract in packages/api, and packages/db stores values that its callers validated.
// The schema checks every field, and these rules across fields:
// - funds are sorted by symbol and no symbol repeats;
// - `options` is null exactly when `optionsListed` is false;
// - `bandOpenInterest` is null exactly when `windowExpiry` is null, and `halfSpreadPct` is null
//   when `windowExpiry` is null;
// - `optionGate` and `optionGateReasons` are the result of the gate rule (`evaluateOptionGate`
//   below) for the fund's `options` and the document's gate constants.
// See: docs/vertex-rebuild/leveraged-etf-universe.md. Research only: no order path.
import { z } from "zod";

/** The gate labels, in the order the import CLI prints their counts. */
export const LEVERAGED_ETF_OPTION_GATES = [
  "pass",
  "fail",
  "spread-not-measured",
] as const;

const OPTION_GATE_REASONS = [
  "no-listed-options",
  "no-window-expiry",
  "open-interest-below-minimum",
  "no-two-sided-quote",
  "spread-above-maximum",
  "market-closed-at-quote",
] as const;

type OptionGateReason = (typeof OPTION_GATE_REASONS)[number];

/** Largest value of a Postgres `integer` column. */
const INT4_MAX = 2_147_483_647;
const MS_PER_DAY = 86_400_000;

const UtcDateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z") || value.endsWith("+00:00"), {
    error: "must be a UTC datetime (ends with Z or +00:00)",
  });
const CountSchema = z.int().min(0).max(INT4_MAX);
const PercentSchema = z.number().min(0).max(100);

const GateSchema = z
  .strictObject({
    bandPct: PercentSchema.positive(),
    maxHalfSpreadPct: PercentSchema.positive(),
    maxWindowDays: z.int().min(0).max(365),
    minBandOpenInterest: CountSchema,
    minWindowDays: z.int().min(0).max(365),
    version: z.int().min(1).max(INT4_MAX),
  })
  .refine((gate) => gate.minWindowDays <= gate.maxWindowDays, {
    error: "minWindowDays must not be larger than maxWindowDays",
    path: ["minWindowDays"],
  });

const OptionsSchema = z.strictObject({
  bandOpenInterest: CountSchema.nullable(),
  halfSpreadPct: PercentSchema.nullable(),
  nearestExpiries: z.array(z.iso.date()).min(1).max(4),
  quotedAt: UtcDateTimeSchema,
  session: z.enum(["regular", "closed"]),
  spot: z.number().positive(),
  totalOpenInterest: CountSchema,
  windowExpiry: z.iso.date().nullable(),
});

const FundSchema = z.strictObject({
  // The column is numeric(4,2): a third decimal would be rounded without notice, so it is refused.
  leverage: z
    .number()
    .min(-5)
    .max(5)
    .refine((value) => value !== 0 && value !== 1, {
      error: "must not be 0 or 1 (not a leveraged or inverse fund)",
    })
    .refine((value) => Number.isInteger(Number((value * 100).toFixed(6))), {
      error: "must have at most 2 decimals",
    }),
  listingExchange: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  optionGate: z.enum(LEVERAGED_ETF_OPTION_GATES),
  optionGateReasons: z.array(z.enum(OPTION_GATE_REASONS)),
  options: OptionsSchema.nullable(),
  optionsListed: z.boolean(),
  productType: z.enum(["etf", "etn"]),
  symbol: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/u),
  underlying: z.string().min(1).max(20).nullable(),
});

type Gate = z.infer<typeof GateSchema>;
type Options = z.infer<typeof OptionsSchema>;
type Fund = z.infer<typeof FundSchema>;
type Problem = Readonly<{ field: string; message: string }>;

/**
 * The gate rule of schema v1: a function of `options` and the gate constants only.
 * Fail reasons, every one that applies: no listed options; no window expiry; band open interest
 * below the minimum; and, only for a chain read in the regular session, no two-sided quote (half
 * spread is null) or a half spread above the maximum. Any fail reason gives "fail". With no fail
 * reason, a chain read after the close gives "spread-not-measured" (its quotes are stale and wide:
 * it cannot pass and it does not prove a fail) and a chain read in the regular session gives "pass".
 */
const evaluateOptionGate = (
  options: Options | null,
  gate: Gate
): Readonly<{
  optionGate: Fund["optionGate"];
  reasons: readonly OptionGateReason[];
}> => {
  if (options === null)
    return { optionGate: "fail", reasons: ["no-listed-options"] };
  const reasons: OptionGateReason[] = [];
  if (options.windowExpiry === null) reasons.push("no-window-expiry");
  if (
    options.bandOpenInterest !== null &&
    options.bandOpenInterest < gate.minBandOpenInterest
  )
    reasons.push("open-interest-below-minimum");
  if (options.session === "regular") {
    if (options.halfSpreadPct === null) reasons.push("no-two-sided-quote");
    else if (options.halfSpreadPct > gate.maxHalfSpreadPct)
      reasons.push("spread-above-maximum");
  }
  if (reasons.length > 0) return { optionGate: "fail", reasons };
  return options.session === "closed"
    ? { optionGate: "spread-not-measured", reasons: ["market-closed-at-quote"] }
    : { optionGate: "pass", reasons: [] };
};

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

/**
 * Checks the option facts against each other and against the quote day. The document does not say
 * which time zone the "quote day" uses, and the New York day and the UTC day of `quotedAt` differ
 * for a chain read in the New York evening. So a date rule fails only when it fails for both days.
 */
const optionsProblems = (options: Options, gate: Gate): Problem[] => {
  const problems: Problem[] = [];
  const quotedAt = new Date(options.quotedAt);
  // New York is behind UTC, so its day is the earlier (or the same) day.
  const newYorkDay = NEW_YORK_DAY.format(quotedAt);
  const utcDay = quotedAt.toISOString().slice(0, 10);
  const expiries = options.nearestExpiries;
  // The empty string sorts before every date, so the first expiry always passes.
  if (expiries.some((expiry, index) => expiry <= (expiries[index - 1] ?? "")))
    problems.push({
      field: "options.nearestExpiries",
      message: "must be in ascending order without a repeated date",
    });
  if (expiries.some((expiry) => expiry < newYorkDay))
    problems.push({
      field: "options.nearestExpiries",
      message: `must not hold an expiry before the quote day ${newYorkDay}`,
    });
  const { bandOpenInterest, halfSpreadPct, windowExpiry } = options;
  if (windowExpiry === null) {
    if (bandOpenInterest !== null)
      problems.push({
        field: "options.bandOpenInterest",
        message: "must be null when windowExpiry is null",
      });
    if (halfSpreadPct !== null)
      problems.push({
        field: "options.halfSpreadPct",
        message: "must be null when windowExpiry is null",
      });
    return problems;
  }
  if (bandOpenInterest === null)
    problems.push({
      field: "options.bandOpenInterest",
      message: "must be a count when windowExpiry is set",
    });
  const inWindow = [newYorkDay, utcDay].some((day) => {
    // Both are ISO dates, so the difference is a whole number of days.
    const days = (Date.parse(windowExpiry) - Date.parse(day)) / MS_PER_DAY;
    return days >= gate.minWindowDays && days <= gate.maxWindowDays;
  });
  if (!inWindow)
    problems.push({
      field: "options.windowExpiry",
      message: `must be ${gate.minWindowDays} to ${gate.maxWindowDays} calendar days after the quote day ${newYorkDay}`,
    });
  return problems;
};

const fundProblems = (fund: Fund, gate: Gate): Problem[] => {
  const problems: Problem[] = [];
  if (fund.optionsListed !== (fund.options !== null))
    problems.push({
      field: "options",
      message: "must be null exactly when optionsListed is false",
    });
  if (fund.options !== null)
    problems.push(...optionsProblems(fund.options, gate));
  const expected = evaluateOptionGate(fund.options, gate);
  // The same set of reasons, in any order, with no reason repeated.
  const reasons = fund.optionGateReasons;
  const sameReasons =
    reasons.length === expected.reasons.length &&
    new Set(reasons).size === reasons.length &&
    reasons.every((reason) => expected.reasons.includes(reason));
  if (fund.optionGate !== expected.optionGate || !sameReasons)
    problems.push({
      field: "optionGate",
      message: `the gate rule gives "${expected.optionGate}" with reasons ${JSON.stringify(expected.reasons)}; the document has "${fund.optionGate}" with reasons ${JSON.stringify(fund.optionGateReasons)}`,
    });
  return problems;
};

export const LeveragedEtfUniverseDocumentSchema = z
  .strictObject({
    funds: z.array(FundSchema).min(1).max(2000),
    gate: GateSchema,
    generatedAt: UtcDateTimeSchema,
    schema: z.literal("leveraged-etf-universe-v1"),
  })
  .superRefine((document, context) => {
    document.funds.forEach((fund, index) => {
      const previous = document.funds[index - 1]?.symbol;
      if (previous !== undefined && previous >= fund.symbol)
        context.addIssue({
          code: "custom",
          message:
            previous === fund.symbol
              ? `symbol ${fund.symbol} appears more than once`
              : `funds must be sorted by symbol: ${fund.symbol} comes after ${previous}`,
          path: ["funds", index, "symbol"],
        });
      for (const problem of fundProblems(fund, document.gate))
        context.addIssue({
          code: "custom",
          message: `${fund.symbol}: ${problem.message}`,
          path: ["funds", index, ...problem.field.split(".")],
        });
    });
  });

export type LeveragedEtfUniverseDocument = z.infer<
  typeof LeveragedEtfUniverseDocumentSchema
>;
