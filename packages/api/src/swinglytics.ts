import { z } from "zod";

// Swinglytics context of the research screen: a pure parser of the public start page of a
// third-party website. Display-only context: not an input of the screen, not an order signal.

export const SWINGLYTICS_URL = "https://www.swinglytics.com/";

export const SWINGLYTICS_WARNING =
  "Third-party context only. Swinglytics is not Vertex research, not a market measurement of the platform, not an input of the screen and not an order signal.";

export const SWINGLYTICS_LIMITS = {
  /** Bytes one argument of a matching script element may hold. */
  maxChunkBytes: 400_000,
  /** Matching script elements one page may hold. */
  maxChunks: 100,
  /** Values the search for the dashboard object may visit. */
  maxNodes: 20_000,
  maxSetupCandidatesPerDirection: 15,
  maxSetupsPerDirection: 5,
  maxThemeCandidates: 20,
  maxThemes: 10,
} as const;

export const SWINGLYTICS_PARSE_ERRORS = {
  chunkTooLarge: "Swinglytics page chunk exceeds the size limit",
  noDashboard: "Swinglytics page has no dashboard object",
  noRegimeLabel: "Swinglytics page has no regime label",
  tooManyChunks: "Swinglytics page has too many chunks",
  tooManyNodes: "Swinglytics page data exceeds the search limit",
} as const;

export class SwinglyticsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwinglyticsParseError";
  }
}

const SETUP_DIRECTIONS = ["bullish", "bearish"] as const;
type SetupDirection = (typeof SETUP_DIRECTIONS)[number];

const TICKER_PATTERN = /^[A-Z0-9.-]{1,12}$/;

const shortText = z.string().min(1).max(60);
const percent = z.number().min(-100).max(100).nullable();
const count = z.number().int().min(0).max(1_000_000).nullable();

const ThemeSchema = z.strictObject({
  bias: z.string().min(1).max(40).nullable(),
  changePercent: percent,
  name: shortText,
});

const SetupSchema = z.strictObject({
  direction: z.enum(SETUP_DIRECTIONS),
  name: shortText.nullable(),
  pattern: z.string().min(1).max(80).nullable(),
  sector: shortText.nullable(),
  ticker: z.string().regex(TICKER_PATTERN),
});

export const SwinglyticsSnapshotSchema = z.strictObject({
  breadth: z.strictObject({
    above20DayPercent: percent,
    above50DayPercent: percent,
    above200DayPercent: percent,
    regime: shortText.nullable(),
    score: z.number().min(0).max(100).nullable(),
  }),
  regime: z.strictObject({
    label: shortText,
    riskLevel: shortText.nullable(),
    trendStrength: shortText.nullable(),
  }),
  scanner: z.strictObject({
    bearish: count,
    bullish: count,
    total: count,
    withSetups: count,
  }),
  setups: z
    .array(SetupSchema)
    .max(SWINGLYTICS_LIMITS.maxSetupsPerDirection * SETUP_DIRECTIONS.length)
    .refine(
      (setups) =>
        SETUP_DIRECTIONS.every(
          (direction) =>
            setups.filter((setup) => setup.direction === direction).length <=
            SWINGLYTICS_LIMITS.maxSetupsPerDirection
        ),
      "At most 5 setups per direction"
    ),
  themes: z
    .array(ThemeSchema)
    .max(SWINGLYTICS_LIMITS.maxThemes)
    .refine(
      (themes) =>
        new Set(themes.map((theme) => theme.name)).size === themes.length,
      "Theme names must be unique"
    ),
  vix: z.strictObject({
    level: z.number().min(0).max(1000).nullable(),
    percentile1Year: z.number().min(0).max(100).nullable(),
    regime: shortText.nullable(),
    trend: shortText.nullable(),
  }),
});

export type SwinglyticsSnapshot = z.infer<typeof SwinglyticsSnapshotSchema>;
type SwinglyticsTheme = SwinglyticsSnapshot["themes"][number];
type SwinglyticsSetup = SwinglyticsSnapshot["setups"][number];

/** The keys the parser reads from the objects of the page data. */
type FieldKey =
  | "avg_change_1d"
  | "bearish"
  | "bearish_candidates"
  | "bias"
  | "breadth"
  | "breadth_regime"
  | "breadth_score"
  | "bullish"
  | "bullish_candidates"
  | "current"
  | "generated_at"
  | "level"
  | "market_regime"
  | "name"
  | "pct_above_200d"
  | "pct_above_20d"
  | "pct_above_50d"
  | "percentile_1y"
  | "regime"
  | "risk_level"
  | "scan_stats"
  | "scanner"
  | "sector"
  | "setup_label"
  | "themes"
  | "ticker"
  | "top_pattern"
  | "total_scanned"
  | "trend"
  | "trend_strength"
  | "vix"
  | "with_setups";

/** An object of the page data: every read key is unknown until it is checked. */
type Fields = Partial<Record<FieldKey, unknown>>;

const SCRIPT_OPEN = /<script(?:\s[^>]*)?>/i;
const SCRIPT_CLOSE = /<\/script>/i;
const PUSH_PREFIX = "self.__next_f.push(";
// Control characters and the direction marks and isolates.
const UNSAFE_CHARACTERS =
  /[\p{Cc}\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;

const PushSchema = z.tuple([z.unknown(), z.string()], z.unknown());

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fields = (value: unknown): Fields => (isFields(value) ? value : {});

/** The parsed JSON value, or undefined when the text is not JSON. */
const jsonOrUndefined = (value: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
};

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(UNSAFE_CHARACTERS, "").trim().slice(0, limit);
  return cleaned === "" ? null : cleaned;
};

const numberIn = (
  value: unknown,
  minimum: number,
  maximum: number
): number | null =>
  typeof value === "number" && value >= minimum && value <= maximum
    ? value
    : null;

const percentOf = (value: unknown): number | null => numberIn(value, -100, 100);

const countOf = (value: unknown): number | null => {
  const candidate = numberIn(value, 0, 1_000_000);
  return candidate === null ? null : Math.trunc(candidate);
};

const timeOf = (value: unknown): Date | null => {
  const candidate = new Date(Date.parse(text(value, 64) ?? ""));
  return Number.isNaN(candidate.getTime()) ? null : candidate;
};

/** Steps 1 to 3: the JSON values of the lines of the page data. */
const pageValues = (html: string): unknown[] => {
  const strings: string[] = [];
  let chunks = 0;
  for (const piece of html.split(SCRIPT_OPEN).slice(1)) {
    const end = piece.search(SCRIPT_CLOSE);
    const body = piece.slice(0, Math.max(end, 0)).trim();
    if (!(body.startsWith(PUSH_PREFIX) && body.endsWith(")"))) {
      continue;
    }
    chunks += 1;
    if (chunks > SWINGLYTICS_LIMITS.maxChunks) {
      throw new SwinglyticsParseError(SWINGLYTICS_PARSE_ERRORS.tooManyChunks);
    }
    const argument = body.slice(PUSH_PREFIX.length, -1);
    if (
      new TextEncoder().encode(argument).byteLength >
      SWINGLYTICS_LIMITS.maxChunkBytes
    ) {
      throw new SwinglyticsParseError(SWINGLYTICS_PARSE_ERRORS.chunkTooLarge);
    }
    // The decoded string is never longer than its JSON text, so it is within the same limit.
    const push = PushSchema.safeParse(jsonOrUndefined(argument));
    if (push.success) {
      strings.push(push.data[1]);
    }
  }
  const values: unknown[] = [];
  for (const line of strings.join("").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }
    const value = jsonOrUndefined(line.slice(separator + 1));
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
};

interface Dashboard {
  breadth: Fields;
  generatedAt: Date;
  regime: Fields;
  scanner: Fields;
  source: Fields;
  vix: Fields;
}

const dashboardOf = (candidate: Fields): Dashboard | null => {
  const generatedAt = timeOf(candidate.generated_at);
  const { breadth, market_regime: regime, scanner, vix } = candidate;
  return generatedAt !== null &&
    isFields(regime) &&
    isFields(breadth) &&
    isFields(vix) &&
    isFields(scanner)
    ? { breadth, generatedAt, regime, scanner, source: candidate, vix }
    : null;
};

/** Step 4: depth-first search, in document order, for the first dashboard object. */
const findDashboard = (values: unknown[]): Dashboard => {
  const stack = [...values].reverse();
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    if (visited > SWINGLYTICS_LIMITS.maxNodes) {
      throw new SwinglyticsParseError(SWINGLYTICS_PARSE_ERRORS.tooManyNodes);
    }
    const value = stack.pop();
    if (Array.isArray(value)) {
      const children: unknown[] = [...value];
      stack.push(...children.reverse());
    } else if (isFields(value)) {
      const dashboard = dashboardOf(value);
      if (dashboard !== null) {
        return dashboard;
      }
      stack.push(...Object.values(value).reverse());
    }
  }
  throw new SwinglyticsParseError(SWINGLYTICS_PARSE_ERRORS.noDashboard);
};

const list = (value: unknown, limit: number): unknown[] =>
  z.array(z.unknown()).catch([]).parse(value).slice(0, limit);

const themesOf = (value: unknown): SwinglyticsTheme[] => {
  const themes = new Map<string, SwinglyticsTheme>();
  for (const item of list(value, SWINGLYTICS_LIMITS.maxThemeCandidates)) {
    const source = fields(item);
    const name = text(source.name, 60);
    if (name === null || themes.has(name)) {
      continue;
    }
    themes.set(name, {
      bias: text(source.bias, 40),
      changePercent: percentOf(source.avg_change_1d),
      name,
    });
  }
  return [...themes.values()].slice(0, SWINGLYTICS_LIMITS.maxThemes);
};

const setupsOf = (
  value: unknown,
  direction: SetupDirection
): SwinglyticsSetup[] => {
  const setups = new Map<string, SwinglyticsSetup>();
  for (const item of list(
    value,
    SWINGLYTICS_LIMITS.maxSetupCandidatesPerDirection
  )) {
    const source = fields(item);
    const ticker = (text(source.ticker, 12) ?? "").toUpperCase();
    if (!TICKER_PATTERN.test(ticker) || setups.has(ticker)) {
      continue;
    }
    setups.set(ticker, {
      direction,
      name: text(source.name, 60),
      pattern: text(source.setup_label ?? source.top_pattern, 80),
      sector: text(source.sector, 60),
      ticker,
    });
  }
  return [...setups.values()].slice(
    0,
    SWINGLYTICS_LIMITS.maxSetupsPerDirection
  );
};

export const parseSwinglyticsHtml = (
  html: string
): { generatedAt: Date; snapshot: SwinglyticsSnapshot } => {
  const { breadth, generatedAt, regime, scanner, source, vix } = findDashboard(
    pageValues(html)
  );
  const label = text(regime.regime, 60);
  if (label === null) {
    throw new SwinglyticsParseError(SWINGLYTICS_PARSE_ERRORS.noRegimeLabel);
  }
  const stats = isFields(scanner.scan_stats)
    ? scanner.scan_stats
    : fields(source.scan_stats);
  const snapshot: SwinglyticsSnapshot = {
    breadth: {
      above20DayPercent: percentOf(fields(breadth.pct_above_20d).current),
      above50DayPercent: percentOf(fields(breadth.pct_above_50d).current),
      above200DayPercent: percentOf(fields(breadth.pct_above_200d).current),
      regime: text(breadth.breadth_regime, 60),
      score: numberIn(breadth.breadth_score, 0, 100),
    },
    regime: {
      label,
      riskLevel: text(regime.risk_level, 60),
      trendStrength: text(regime.trend_strength, 60),
    },
    scanner: {
      bearish: countOf(stats.bearish_candidates),
      bullish: countOf(stats.bullish_candidates),
      total: countOf(stats.total_scanned),
      withSetups: countOf(stats.with_setups),
    },
    setups: [
      ...setupsOf(scanner.bullish, "bullish"),
      ...setupsOf(scanner.bearish, "bearish"),
    ],
    themes: themesOf(source.themes),
    vix: {
      level: numberIn(vix.level, 0, 1000),
      percentile1Year: numberIn(vix.percentile_1y, 0, 100),
      regime: text(vix.regime, 60),
      trend: text(vix.trend, 60),
    },
  };
  return { generatedAt, snapshot };
};
