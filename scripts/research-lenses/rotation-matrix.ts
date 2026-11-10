// Rotation matrix: sector -> industry -> cap bucket performance grid (Finviz Maps "matrix" idea, computed locally).
// Pure functions only. Input: securities with metadata and adjusted daily closes. No network, no orders.
// Ported from vertex-research packages/reporting/rotation-matrix.mjs (main 1f2b8d4).

export const PERIODS = { "1D": 1, "1M": 21, "3M": 63, "6M": 126 } as const;
export type RotationPeriod = keyof typeof PERIODS;
export const CAP_BUCKETS = ["large", "mid", "small"] as const;
export type CapBucket = (typeof CAP_BUCKETS)[number];
export const CAP_LABELS: Readonly<Record<CapBucket, string>> = {
  large: "Mega/Large (≥$10B)",
  mid: "Mid ($2–10B)",
  small: "Small ($0.3–2B)",
};

type Maybe<T> = T | null | undefined;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Index into a list the caller knows is long enough. */
const at = (values: readonly number[], index: number): number =>
  values[index] as number;

const sortedFinite = (values: readonly Maybe<number>[]): number[] =>
  values.filter(finite).sort((a, b) => a - b);

export const capBucket = (marketCap: Maybe<number>): CapBucket | null => {
  if (!finite(marketCap) || marketCap < 3e8) return null;
  if (marketCap >= 1e10) return "large";
  if (marketCap >= 2e9) return "mid";
  return "small";
};

/** Percent return over `bars` trading days from an ascending close series. Null when history is too short. */
export const periodReturn = (
  closes: Maybe<readonly Maybe<number>[]>,
  bars: number
): number | null => {
  if (!Array.isArray(closes) || closes.length <= bars) return null;
  const end = closes.at(-1);
  const start = closes.at(-1 - bars);
  if (!(finite(end) && finite(start)) || start <= 0) return null;
  return (end / start - 1) * 100;
};

export const median = (values: readonly Maybe<number>[]): number | null => {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? at(sorted, middle)
    : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
};

/** Linear-interpolated quantile of a non-empty ascending list. */
const quantileOfSorted = (sorted: readonly number[], q: number): number => {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return (
    at(sorted, low) + (at(sorted, high) - at(sorted, low)) * (position - low)
  );
};

export const quantile = (
  values: readonly Maybe<number>[],
  q: number
): number | null => {
  const sorted = sortedFinite(values);
  return sorted.length === 0 ? null : quantileOfSorted(sorted, q);
};

const stdev = (values: readonly number[]): number | null => {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  );
};

const roundTo = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

export type RotationBrief = Readonly<{
  symbol: string;
  ret: number;
  marketCap: number | null;
}>;

type Member = Readonly<{
  symbol: string;
  marketCap: number | null;
  ret: number;
}>;

const brief = (member: Member): RotationBrief => ({
  marketCap: member.marketCap,
  ret: roundTo(member.ret),
  symbol: member.symbol,
});

export type CellStats = Readonly<{
  n: number;
  retMedian: number | null;
  retCapWeighted: number | null;
  breadth: number | null;
  leaders: RotationBrief[];
  laggards: RotationBrief[];
}>;

const capOf = (member: Member): number =>
  finite(member.marketCap) ? member.marketCap : 0;

/** Aggregate one group of {symbol, marketCap, ret}; members without a finite return are ignored. */
export const cellStats = (
  members: readonly Readonly<{
    symbol: string;
    marketCap: number | null;
    ret: Maybe<number>;
  }>[]
): CellStats => {
  const rows = members.filter((member): member is Member => finite(member.ret));
  const capSum = rows.reduce((sum, member) => sum + capOf(member), 0);
  const sorted = [...rows].sort((a, b) => b.ret - a.ret);
  const retMedian = median(rows.map((member) => member.ret));
  return {
    breadth:
      rows.length > 0
        ? roundTo(
            (rows.filter((member) => member.ret > 0).length / rows.length) *
              100,
            1
          )
        : null,
    laggards: sorted.slice(-3).reverse().map(brief),
    leaders: sorted.slice(0, 3).map(brief),
    n: rows.length,
    retCapWeighted:
      capSum > 0
        ? roundTo(
            rows.reduce((sum, member) => sum + capOf(member) * member.ret, 0) /
              capSum
          )
        : null,
    retMedian: retMedian === null ? null : roundTo(retMedian),
  };
};

export type RotationSecurity = Readonly<{
  symbol: string;
  sector?: Maybe<string>;
  industry?: Maybe<string>;
  marketCap: Maybe<number>;
  closes: readonly Maybe<number>[];
}>;

/** Role name -> tickers, e.g. {wish: [...], reentry: [...], held: [...]}. */
export type OursInput = Readonly<Record<string, Maybe<readonly unknown[]>>>;

export type RotationCell = CellStats & Readonly<{ symbols: RotationBrief[] }>;

export type RotationStandout = RotationBrief &
  Readonly<{ z: number; sector: string; industry: string; cap: CapBucket }>;

export type RotationIndustry = CellStats & {
  sector: string;
  industry: string;
  cells: Partial<Record<CapBucket, RotationCell>>;
  standouts: RotationStandout[];
  rank?: number;
  quintile?: number;
};

export type RotationSector = CellStats &
  Readonly<{ sector: string; industries: string[] }>;

export type RotationRanked = Readonly<{
  sector: string;
  industry: string;
  retMedian: number | null;
  n: number;
}>;

export type RotationPeriodResult = Readonly<{
  bars: number;
  n: number;
  sectors: RotationSector[];
  industries: RotationIndustry[];
  top: RotationRanked[];
  bottom: RotationRanked[];
  standouts: RotationStandout[];
}>;

export type RotationPeriodView = Readonly<{
  ret: number | null;
  industryRet: number | null;
  quintile: number | null;
  leaderInIndustry: boolean;
}>;

type CellState = "leading" | "lagging" | "middle" | "unranked";

export type RotationOurName =
  | Readonly<{
      symbol: string;
      roles: string[];
      covered: false;
      opportunity?: never;
    }>
  | Readonly<{
      symbol: string;
      roles: string[];
      covered: true;
      sector: string;
      industry: string;
      cap: CapBucket;
      periods: Record<RotationPeriod, RotationPeriodView>;
      cell1M: CellState;
      cell3M: CellState;
      opportunity: boolean;
    }>;

export type RotationSource = Readonly<Record<string, unknown>>;

export interface RotationMatrix {
  asOf: string | null;
  capLabels: Readonly<Record<CapBucket, string>>;
  generatedAt: string;
  ours: RotationOurName[];
  periods: Record<RotationPeriod, RotationPeriodResult>;
  source?: RotationSource;
  universeSize: number;
}

type UniverseEntry = Readonly<{
  symbol: string;
  sector: string;
  industry: string;
  cap: CapBucket;
  marketCap: number | null;
  closes: readonly Maybe<number>[];
}>;

type Row = Member &
  Readonly<{ sector: string; industry: string; cap: CapBucket }>;

type IndustryWork = RotationIndustry & { p75: number; rows: Row[] };

type PeriodIndex = Readonly<{
  rows: Map<string, Readonly<{ ret: number; industry: IndustryWork }>>;
  industries: Map<string, IndustryWork>;
}>;

const industryKey = (sector: string, industry: string): string =>
  `${sector}\u0000${industry}`;

const byRetMedianDesc = (
  a: Readonly<{ retMedian: number | null }>,
  b: Readonly<{ retMedian: number | null }>
): number => Number(b.retMedian) - Number(a.retMedian);

const ranked = (industry: RotationIndustry): RotationRanked => ({
  industry: industry.industry,
  n: industry.n,
  retMedian: industry.retMedian,
  sector: industry.sector,
});

type StandoutOptions = Readonly<{
  standoutSigma: number;
  minStandoutN: number;
}>;

const standoutsOf = (
  group: Readonly<{ sector: string; industry: string; rows: readonly Row[] }>,
  options: StandoutOptions
): RotationStandout[] => {
  const returns = group.rows.map((row) => row.ret);
  const sd = stdev(returns);
  if (group.rows.length < options.minStandoutN || sd === null || sd <= 0)
    return [];
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  return group.rows
    .filter((row) => Math.abs(row.ret - mean) > options.standoutSigma * sd)
    .map((row) => ({
      ...brief(row),
      cap: row.cap,
      industry: group.industry,
      sector: group.sector,
      z: roundTo((row.ret - mean) / sd),
    }));
};

const industryOf = (
  group: Readonly<{ sector: string; industry: string; rows: Row[] }>,
  options: StandoutOptions
): IndustryWork => {
  const cells: Partial<Record<CapBucket, RotationCell>> = {};
  for (const cap of CAP_BUCKETS) {
    const members = group.rows.filter((row) => row.cap === cap);
    if (members.length > 0)
      cells[cap] = {
        ...cellStats(members),
        symbols: members.sort((a, b) => b.ret - a.ret).map(brief),
      };
  }
  return {
    industry: group.industry,
    sector: group.sector,
    ...cellStats(group.rows),
    cells,
    p75: quantileOfSorted(sortedFinite(group.rows.map((row) => row.ret)), 0.75),
    rows: group.rows,
    standouts: standoutsOf(group, options),
  };
};

const publicIndustry = ({
  p75: _p75,
  rows: _rows,
  ...rest
}: IndustryWork): RotationIndustry => rest;

const buildPeriod = (
  universe: readonly UniverseEntry[],
  bars: number,
  options: StandoutOptions
): Readonly<{ result: RotationPeriodResult; index: PeriodIndex }> => {
  const rows: Row[] = [];
  for (const entry of universe) {
    const ret = periodReturn(entry.closes, bars);
    if (finite(ret))
      rows.push({
        cap: entry.cap,
        industry: entry.industry,
        marketCap: entry.marketCap,
        ret,
        sector: entry.sector,
        symbol: entry.symbol,
      });
  }
  const groups = new Map<
    string,
    { sector: string; industry: string; rows: Row[] }
  >();
  for (const row of rows) {
    const key = industryKey(row.sector, row.industry);
    const group = groups.get(key) ?? {
      industry: row.industry,
      rows: [],
      sector: row.sector,
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const industryList = [...groups.values()]
    .map((group) => industryOf(group, options))
    .sort(byRetMedianDesc);
  // Rank industries with at least 3 names; quintile 1 = leading, 5 = lagging.
  const rankedList = industryList.filter((industry) => industry.n >= 3);
  rankedList.forEach((industry, i) => {
    industry.rank = i + 1;
    industry.quintile = Math.min(
      5,
      Math.floor((i / rankedList.length) * 5) + 1
    );
  });
  const sectors = new Map<string, IndustryWork[]>();
  for (const industry of industryList)
    sectors.set(industry.sector, [
      ...(sectors.get(industry.sector) ?? []),
      industry,
    ]);
  const sectorList = [...sectors]
    .map(([sector, industries]) => ({
      sector,
      ...cellStats(industries.flatMap((industry) => industry.rows)),
      industries: industries.map((industry) => industry.industry),
    }))
    .sort(byRetMedianDesc);
  const index: PeriodIndex = {
    industries: new Map(
      industryList.map((industry) => [
        industryKey(industry.sector, industry.industry),
        industry,
      ])
    ),
    rows: new Map(),
  };
  for (const industry of industryList)
    for (const row of industry.rows)
      index.rows.set(row.symbol, { industry, ret: row.ret });
  return {
    index,
    result: {
      bars,
      bottom: rankedList.slice(-5).reverse().map(ranked),
      industries: industryList.map(publicIndustry),
      n: rows.length,
      sectors: sectorList,
      standouts: industryList
        .flatMap((industry) => industry.standouts)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, 40),
      top: rankedList.slice(0, 5).map(ranked),
    },
  };
};

export type RotationMatrixOptions = Readonly<{
  ours?: OursInput;
  asOf?: string | null;
  standoutSigma?: number;
  minStandoutN?: number;
  now?: () => Date;
}>;

/**
 * Build the matrix for every period.
 * securities: [{symbol, sector, industry, marketCap, closes: number[] ascending}]
 * ours: {wish: string[], reentry: string[], held: string[]}
 */
export const buildRotationMatrix = (
  securities: readonly RotationSecurity[],
  {
    ours = {},
    asOf = null,
    standoutSigma = 2,
    minStandoutN = 5,
    now = () => new Date(),
  }: RotationMatrixOptions = {}
): RotationMatrix => {
  const universe: UniverseEntry[] = [];
  for (const security of securities) {
    const cap = capBucket(security.marketCap);
    if (cap === null) continue;
    universe.push({
      cap,
      closes: security.closes,
      industry: security.industry || "Unclassified",
      // A cap bucket implies a finite market cap.
      marketCap: security.marketCap as number,
      sector: security.sector || "Unclassified",
      symbol: security.symbol,
    });
  }
  const periods = {} as Record<RotationPeriod, RotationPeriodResult>;
  const indexes = new Map<RotationPeriod, PeriodIndex>();
  for (const [period, bars] of Object.entries(PERIODS) as [
    RotationPeriod,
    number,
  ][]) {
    const { result, index } = buildPeriod(universe, bars, {
      minStandoutN,
      standoutSigma,
    });
    periods[period] = result;
    indexes.set(period, index);
  }
  return {
    asOf,
    capLabels: CAP_LABELS,
    generatedAt: now().toISOString(),
    ours: buildOurNames(universe, indexes, ours),
    periods,
    universeSize: universe.length,
  };
};

const cellState = (quintile: number | null): CellState => {
  if (quintile === 1) return "leading";
  if (quintile === 5) return "lagging";
  return quintile ? "middle" : "unranked";
};

const periodView = (
  index: PeriodIndex,
  symbol: string,
  entry: UniverseEntry
): RotationPeriodView => {
  const hit = index.rows.get(symbol);
  const industry =
    hit?.industry ??
    index.industries.get(industryKey(entry.sector, entry.industry));
  return {
    industryRet: industry === undefined ? null : industry.retMedian,
    leaderInIndustry:
      hit !== undefined && hit.industry.n >= 3 && hit.ret >= hit.industry.p75,
    quintile: industry?.quintile ?? null,
    ret: hit === undefined ? null : roundTo(hit.ret),
  };
};

/** Tag our names with their industry's quintile per period; flag opportunity candidates. */
const buildOurNames = (
  universe: readonly UniverseEntry[],
  indexes: ReadonlyMap<RotationPeriod, PeriodIndex>,
  ours: OursInput
): RotationOurName[] => {
  const roles = new Map<string, Set<string>>();
  for (const [role, list] of Object.entries(ours))
    for (const symbol of list ?? []) {
      const key = String(symbol).toUpperCase();
      roles.set(key, (roles.get(key) ?? new Set()).add(role));
    }
  const bySymbol = new Map(universe.map((entry) => [entry.symbol, entry]));
  const out: RotationOurName[] = [];
  for (const [symbol, roleSet] of roles) {
    const entry = bySymbol.get(symbol);
    const roleList = [...roleSet].sort();
    if (entry === undefined) {
      out.push({ covered: false, roles: roleList, symbol });
      continue;
    }
    const periods = {} as Record<RotationPeriod, RotationPeriodView>;
    for (const [period, index] of indexes)
      periods[period] = periodView(index, symbol, entry);
    const candidateRole = roleSet.has("wish") || roleSet.has("reentry");
    const strong = (["1M", "3M"] as const).every(
      (key) =>
        periods[key].quintile === 1 &&
        Number(periods[key].industryRet) > 0 &&
        periods[key].leaderInIndustry
    );
    out.push({
      cap: entry.cap,
      cell1M: cellState(periods["1M"].quintile),
      cell3M: cellState(periods["3M"].quintile),
      covered: true,
      industry: entry.industry,
      opportunity: candidateRole && strong,
      periods,
      roles: roleList,
      sector: entry.sector,
      symbol,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.opportunity === true) - Number(a.opportunity === true) ||
      a.symbol.localeCompare(b.symbol)
  );
};

export type RotationMonitorSummary = Readonly<{
  asOf: string | null;
  generatedAt: string;
  universeSize: number;
  source: RotationSource | null;
  periods: Record<
    string,
    Readonly<{
      n: number;
      top: RotationRanked[];
      bottom: RotationRanked[];
      standouts: RotationStandout[];
    }>
  >;
  ours: Readonly<{
    symbol: string;
    roles: string[];
    industry: string;
    cell1M: CellState;
    cell3M: CellState;
    ret1M: number | null;
    ret3M: number | null;
    opportunity: boolean;
  }>[];
  uncovered: string[];
}>;

/** Compact summary (the optional --summary-out file). */
export const monitorSummary = (
  matrix: RotationMatrix
): RotationMonitorSummary => {
  const periods: RotationMonitorSummary["periods"] = {};
  for (const [key, period] of Object.entries(matrix.periods))
    periods[key] = {
      bottom: period.bottom,
      n: period.n,
      standouts: period.standouts.slice(0, 10),
      top: period.top,
    };
  const ours: RotationMonitorSummary["ours"] = [];
  const uncovered: string[] = [];
  for (const name of matrix.ours) {
    if (!name.covered) {
      uncovered.push(name.symbol);
      continue;
    }
    ours.push({
      cell1M: name.cell1M,
      cell3M: name.cell3M,
      industry: name.industry,
      opportunity: name.opportunity,
      ret1M: name.periods["1M"].ret,
      ret3M: name.periods["3M"].ret,
      roles: name.roles,
      symbol: name.symbol,
    });
  }
  return {
    asOf: matrix.asOf,
    generatedAt: matrix.generatedAt,
    ours,
    periods,
    source: matrix.source ?? null,
    uncovered,
    universeSize: matrix.universeSize,
  };
};
