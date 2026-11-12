// What: the `leveraged-etf-universe-v1` document, as a Zod schema. The Python fetcher
// (research/backtests/leveraged-etf/universe.py) prints one document; the import CLI (import.ts in
// this folder) reads it from stdin and checks it with this schema before it writes to Postgres.
// Why here: the import CLI is the only reader of the document. No oRPC route takes or returns it,
// so it is not a contract in packages/api, and packages/db stores values that its callers validated.
// The schema checks every field, and these rules across fields:
// - the `gate` block is exactly the constants of its `version` (LEVERAGED_ETF_GATE_CONSTANTS);
// - funds are sorted by symbol and no symbol repeats;
// - `options` is null exactly when `optionsListed` is false;
// - `bandOpenInterest` and `twoSidedQuotes` are null exactly when `windowExpiry` is null, and
//   `halfSpreadPct` is null exactly when there is no two-sided quote;
// - `quotedAt` is not after `generatedAt` (5 minutes of clock difference are allowed);
// - session "regular" needs a chain of the New York day of `generatedAt` whose quotes (`quotedAt`
//   minus the 15 minutes of the Cboe delay) are from Monday to Friday, 09:45 to before 16:00 in
//   New York. The schema has no exchange calendar: a NYSE holiday and the 13:00 close of a half
//   day stay with the fetcher (`session_of` in liquidity.py), which never writes "regular" then;
// - `optionGate` and `optionGateReasons` are the result of the gate rule (`evaluateOptionGate`
//   below) for the fund's `options`, the constants of the gate version and `generatedAt`.
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
  "no-standard-contract",
  "stale-chain",
  "no-window-expiry",
  "open-interest-below-minimum",
  "no-two-sided-quote",
  "too-few-two-sided-quotes",
  "spread-above-maximum",
  "market-closed-at-quote",
] as const;

type OptionGateReason = (typeof OPTION_GATE_REASONS)[number];

type GateConstants = Readonly<{
  bandPct: number;
  maxHalfSpreadPct: number;
  maxWindowDays: number;
  minBandOpenInterest: number;
  minTwoSidedQuotes: number;
  minWindowDays: number;
}>;

/**
 * The gate constants of every gate version. A document names a version and repeats its constants;
 * the schema refuses a document whose `gate` block differs from the constants here, and the gate
 * rule reads these constants, not the numbers of the document. A change of a constant needs a new
 * version here and in GATE of services/research/strategies/leveraged_etf/liquidity.py.
 */
export const LEVERAGED_ETF_GATE_CONSTANTS = {
  1: {
    bandPct: 10,
    maxHalfSpreadPct: 4,
    maxWindowDays: 21,
    minBandOpenInterest: 1000,
    minTwoSidedQuotes: 3,
    minWindowDays: 5,
  },
} as const satisfies Readonly<Record<number, GateConstants>>;

const GATE_VERSIONS: Readonly<Record<number, GateConstants>> =
  LEVERAGED_ETF_GATE_CONSTANTS;
const GATE_CONSTANT_KEYS = [
  "bandPct",
  "maxHalfSpreadPct",
  "maxWindowDays",
  "minBandOpenInterest",
  "minTwoSidedQuotes",
  "minWindowDays",
] as const satisfies readonly (keyof GateConstants)[];

/**
 * A chain of more New York calendar days than this before `generatedAt` is not judged: the label
 * is "fail" with the one reason "stale-chain". MAX_CHAIN_AGE_DAYS in liquidity.py.
 */
const MAX_CHAIN_AGE_DAYS = 4;
/** `quotedAt` may be this much after `generatedAt`: Cboe and the fetcher have two clocks. */
const MAX_CLOCK_SKEW_MS = 300_000;
/** The quotes of a chain are this much older than `quotedAt`. QUOTE_DELAY in liquidity.py. */
const QUOTE_DELAY_MS = 900_000;
/** 09:45 and 16:00 as minutes of the New York day. SESSION_START and SESSION_CLOSE in liquidity.py. */
const SESSION_START_MINUTE = 585;
const SESSION_CLOSE_MINUTE = 960;
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
    bandPct: z.number(),
    maxHalfSpreadPct: z.number(),
    maxWindowDays: z.number(),
    minBandOpenInterest: z.number(),
    minTwoSidedQuotes: z.number(),
    minWindowDays: z.number(),
    version: z.int().min(1).max(INT4_MAX),
  })
  .superRefine((gate, context) => {
    const constants = GATE_VERSIONS[gate.version];
    if (constants === undefined) {
      context.addIssue({
        code: "custom",
        message: `gate version ${gate.version} is not known (known: ${Object.keys(GATE_VERSIONS).join(", ")})`,
        path: ["version"],
      });
      return;
    }
    for (const key of GATE_CONSTANT_KEYS)
      if (gate[key] !== constants[key])
        context.addIssue({
          code: "custom",
          message: `must be ${constants[key]} in gate version ${gate.version}; the document has ${gate[key]}`,
          path: [key],
        });
  });

const OptionsSchema = z.strictObject({
  bandOpenInterest: CountSchema.nullable(),
  halfSpreadPct: PercentSchema.nullable(),
  nearestExpiries: z.array(z.iso.date()).min(1).max(4),
  quotedAt: UtcDateTimeSchema,
  session: z.enum(["regular", "closed"]),
  spot: z.number().positive(),
  totalOpenInterest: CountSchema,
  twoSidedQuotes: CountSchema.nullable(),
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

type Options = z.infer<typeof OptionsSchema>;
type Fund = z.infer<typeof FundSchema>;
type Problem = Readonly<{ field: string; message: string }>;

const NEW_YORK_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});
/** The New York calendar day of an instant, as an ISO date. */
const newYorkDay = (instant: Date): string => NEW_YORK_DAY.format(instant);
/** Days from one ISO date to another; both are dates, so the result is a whole number. */
const daysBetween = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / MS_PER_DAY;
/** New York calendar days from the chain to the document; 0 = the same New York day. */
const chainAgeDays = (options: Options, generatedAt: Date): number =>
  daysBetween(newYorkDay(new Date(options.quotedAt)), newYorkDay(generatedAt));

/** The spread reason of a chain in the regular session, or null when the spread is inside the gate. */
const spreadReason = (
  options: Options,
  gate: GateConstants
): OptionGateReason | null => {
  const quotes = options.twoSidedQuotes ?? 0;
  if (quotes === 0 || options.halfSpreadPct === null)
    return "no-two-sided-quote";
  // The median of one or two quotes does not stand for the spread of the fund: it is not judged.
  if (quotes < gate.minTwoSidedQuotes) return "too-few-two-sided-quotes";
  return options.halfSpreadPct > gate.maxHalfSpreadPct
    ? "spread-above-maximum"
    : null;
};

/**
 * The gate rule of schema v1 for a fund with option facts: a function of `options`, the constants
 * of the gate version and `generatedAt`. The same rule as `gate` in liquidity.py.
 * A chain of more than MAX_CHAIN_AGE_DAYS before `generatedAt` is "fail" with the one reason
 * "stale-chain": its facts are not judged. Else the fail reasons, every one that applies: no
 * window expiry; band open interest below the minimum; and, only in session "regular", no
 * two-sided quote, fewer two-sided quotes than the minimum, or a half spread above the maximum.
 * Any fail reason gives "fail". With no fail reason, session "closed" gives "spread-not-measured"
 * (the quotes are stale and wide: the chain cannot pass and it does not prove a fail) and session
 * "regular" gives "pass". Session "regular" needs a chain of the New York day of `generatedAt`
 * with quotes from Monday to Friday, 09:45 to before 16:00 in New York (`timeProblems` checks
 * both), so a pass always has quotes of that day and of those hours. The schema does not know a
 * NYSE holiday or the 13:00 close of a half day; the fetcher does.
 */
const evaluateOptionGate = (
  options: Options,
  gate: GateConstants,
  generatedAt: Date
): Readonly<{
  optionGate: Fund["optionGate"];
  reasons: readonly OptionGateReason[];
}> => {
  if (chainAgeDays(options, generatedAt) > MAX_CHAIN_AGE_DAYS)
    return { optionGate: "fail", reasons: ["stale-chain"] };
  const reasons: OptionGateReason[] = [];
  if (options.windowExpiry === null) reasons.push("no-window-expiry");
  if (
    options.bandOpenInterest !== null &&
    options.bandOpenInterest < gate.minBandOpenInterest
  )
    reasons.push("open-interest-below-minimum");
  const spread =
    options.session === "regular" ? spreadReason(options, gate) : null;
  if (spread !== null) reasons.push(spread);
  if (reasons.length > 0) return { optionGate: "fail", reasons };
  return options.session === "closed"
    ? { optionGate: "spread-not-measured", reasons: ["market-closed-at-quote"] }
    : { optionGate: "pass", reasons: [] };
};

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
  weekday: "short",
});

/**
 * Why the quotes of a chain are not from the regular session of a weekday, or null when they are.
 * The time of the quotes is `quotedAt` minus the Cboe delay, read on the New York clock (so summer
 * time is right). The rule of `session_of` in liquidity.py without its exchange calendar.
 */
const outsideSession = (options: Options): string | null => {
  const clock: Readonly<Record<string, string>> = Object.fromEntries(
    NEW_YORK_CLOCK.formatToParts(
      new Date(Date.parse(options.quotedAt) - QUOTE_DELAY_MS)
    ).map(({ type, value }) => [type, value])
  );
  const minute = Number(clock["hour"]) * 60 + Number(clock["minute"]);
  const weekend = clock["weekday"] === "Sat" || clock["weekday"] === "Sun";
  return !weekend &&
    minute >= SESSION_START_MINUTE &&
    minute < SESSION_CLOSE_MINUTE
    ? null
    : `the quotes are of ${clock["weekday"]} ${clock["hour"]}:${clock["minute"]} in New York (quotedAt minus the 15 minutes of the Cboe delay), outside Monday to Friday from 09:45 to before 16:00`;
};

/** Checks `quotedAt` and `session` against `generatedAt` and against the New York clock. */
const timeProblems = (options: Options, generatedAt: Date): Problem[] => {
  const problems: Problem[] = [];
  if (Date.parse(options.quotedAt) - generatedAt.getTime() > MAX_CLOCK_SKEW_MS)
    problems.push({
      field: "options.quotedAt",
      message: `must not be more than 5 minutes after generatedAt ${generatedAt.toISOString()}`,
    });
  if (options.session !== "regular") return problems;
  if (chainAgeDays(options, generatedAt) !== 0)
    problems.push({
      field: "options.session",
      message: `must be "closed": the chain is of ${newYorkDay(new Date(options.quotedAt))}, and generatedAt is on ${newYorkDay(generatedAt)} (New York days)`,
    });
  const outside = outsideSession(options);
  if (outside !== null)
    problems.push({
      field: "options.session",
      message: `must be "closed": ${outside}`,
    });
  return problems;
};

/** Checks the facts of the window expiry against each other. */
const windowProblems = (options: Options): Problem[] => {
  const { bandOpenInterest, halfSpreadPct, twoSidedQuotes, windowExpiry } =
    options;
  if (windowExpiry === null)
    return (
      [
        ["bandOpenInterest", bandOpenInterest],
        ["halfSpreadPct", halfSpreadPct],
        ["twoSidedQuotes", twoSidedQuotes],
      ] as const
    )
      .filter(([, value]) => value !== null)
      .map(([field]) => ({
        field: `options.${field}`,
        message: "must be null when windowExpiry is null",
      }));
  const problems: Problem[] = [];
  if (bandOpenInterest === null)
    problems.push({
      field: "options.bandOpenInterest",
      message: "must be a count when windowExpiry is set",
    });
  if (twoSidedQuotes === null)
    problems.push({
      field: "options.twoSidedQuotes",
      message: "must be a count when windowExpiry is set",
    });
  else if ((halfSpreadPct === null) !== (twoSidedQuotes === 0))
    problems.push({
      field: "options.halfSpreadPct",
      message: "must be null exactly when twoSidedQuotes is 0",
    });
  return problems;
};

/**
 * Checks the option facts against each other, against the quote day and against `generatedAt`.
 * The document does not say which time zone the "quote day" uses, and the New York day and the UTC
 * day of `quotedAt` differ for a chain read in the New York evening. So a rule about the quote day
 * fails only when it fails for both days.
 */
const optionsProblems = (
  options: Options,
  gate: GateConstants,
  generatedAt: Date
): Problem[] => {
  const problems = timeProblems(options, generatedAt);
  const quotedAt = new Date(options.quotedAt);
  // New York is behind UTC, so its day is the earlier (or the same) day.
  const quoteDay = newYorkDay(quotedAt);
  const utcDay = quotedAt.toISOString().slice(0, 10);
  const expiries = options.nearestExpiries;
  // The empty string sorts before every date, so the first expiry always passes.
  if (expiries.some((expiry, index) => expiry <= (expiries[index - 1] ?? "")))
    problems.push({
      field: "options.nearestExpiries",
      message: "must be in ascending order without a repeated date",
    });
  if (expiries.some((expiry) => expiry < quoteDay))
    problems.push({
      field: "options.nearestExpiries",
      message: `must not hold an expiry before the quote day ${quoteDay}`,
    });
  problems.push(...windowProblems(options));
  const { windowExpiry } = options;
  if (windowExpiry === null) return problems;
  const inWindow = [quoteDay, utcDay].some((day) => {
    const days = daysBetween(day, windowExpiry);
    return days >= gate.minWindowDays && days <= gate.maxWindowDays;
  });
  if (!inWindow)
    problems.push({
      field: "options.windowExpiry",
      message: `must be ${gate.minWindowDays} to ${gate.maxWindowDays} calendar days after the quote day ${quoteDay}`,
    });
  return problems;
};

const fundProblems = (
  fund: Fund,
  gate: GateConstants,
  generatedAt: Date
): Problem[] => {
  const problems: Problem[] = [];
  const { optionGate, optionGateReasons: reasons, options } = fund;
  if (fund.optionsListed !== (options !== null))
    problems.push({
      field: "options",
      message: "must be null exactly when optionsListed is false",
    });
  const stated = `the document has "${optionGate}" with reasons ${JSON.stringify(reasons)}`;
  if (options === null) {
    // Cboe has no chain file, or the chain has no standard contract on or after the quote day.
    // Only the fetcher knows which one; the document must name exactly one of the two.
    const [reason] = reasons;
    const named =
      reasons.length === 1 &&
      (reason === "no-listed-options" || reason === "no-standard-contract");
    if (optionGate !== "fail" || !named)
      problems.push({
        field: "optionGate",
        message: `a fund without option facts is "fail" with the one reason "no-listed-options" or "no-standard-contract"; ${stated}`,
      });
    return problems;
  }
  problems.push(...optionsProblems(options, gate, generatedAt));
  const expected = evaluateOptionGate(options, gate, generatedAt);
  // The same set of reasons, in any order, with no reason repeated.
  const sameReasons =
    reasons.length === expected.reasons.length &&
    new Set(reasons).size === reasons.length &&
    reasons.every((reason) => expected.reasons.includes(reason));
  if (optionGate !== expected.optionGate || !sameReasons)
    problems.push({
      field: "optionGate",
      message: `the gate rule gives "${expected.optionGate}" with reasons ${JSON.stringify(expected.reasons)}; ${stated}`,
    });
  const generatedDay = newYorkDay(generatedAt);
  if (
    optionGate !== "fail" &&
    options.windowExpiry !== null &&
    options.windowExpiry < generatedDay
  )
    problems.push({
      field: "options.windowExpiry",
      message: `must be on or after the generatedAt day ${generatedDay} for a fund that is not "fail"`,
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
    const generatedAt = new Date(document.generatedAt);
    // The rule reads the constants of the version. An unknown version is reported at `gate`.
    const gate = GATE_VERSIONS[document.gate.version];
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
      const problems =
        gate === undefined ? [] : fundProblems(fund, gate, generatedAt);
      for (const problem of problems)
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
