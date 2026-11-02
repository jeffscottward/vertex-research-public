import type {
  DeepValueOutput,
  DeepValueRow,
  DeepValueScoreOutput,
  RotationCell,
  RotationIndustry,
  RotationMatrixOutput,
  RotationPeriod,
} from "@darkfactory/api";

// Synthetic research lens outputs for the workspace tests only.

const cell = (retMedian: number | null, symbols: string[]): RotationCell => ({
  n: symbols.length,
  retMedian,
  retCapWeighted: retMedian,
  breadth: retMedian === null ? null : 50,
  leaders: [],
  laggards: [],
  symbols: symbols.map((symbol, index) => ({
    symbol,
    ret: retMedian === null ? null : retMedian + index,
    marketCap: [12e9, 800e6][index] ?? null,
  })),
});

const withoutSymbols = ({ symbols: _symbols, ...rest }: RotationCell) => rest;

const industry = (
  sector: string,
  name: string,
  retMedian: number,
  quintile: number | undefined,
  cells: RotationIndustry["cells"]
): RotationIndustry => ({
  n: 3,
  retMedian,
  retCapWeighted: retMedian,
  breadth: 66.7,
  leaders: [],
  laggards: [],
  sector,
  industry: name,
  ...(quintile === undefined ? {} : { rank: quintile, quintile }),
  cells,
  standouts: [],
});

export const rotationFixture = (
  period: RotationPeriod = "1M",
  overrides: Partial<RotationMatrixOutput> = {}
): RotationMatrixOutput => ({
  period,
  bars: 21,
  n: 6,
  asOf: "2026-10-21",
  generatedAt: "2026-10-21T17:10:32.981Z",
  universeSize: 3022,
  sectors: [
    {
      n: 3,
      retMedian: 4.6,
      retCapWeighted: 9.5,
      breadth: 62.9,
      leaders: [],
      laggards: [],
      sector: "Energy",
      industries: ["Oil & Gas Production"],
    },
    {
      n: 3,
      retMedian: -2,
      retCapWeighted: -2,
      breadth: 30,
      leaders: [],
      laggards: [],
      sector: "Utilities",
      industries: ["Water Supply"],
    },
    {
      n: 0,
      retMedian: null,
      retCapWeighted: null,
      breadth: null,
      leaders: [],
      laggards: [],
      sector: "Empty Sector",
      industries: [],
    },
  ],
  industries: [
    industry("Energy", "Oil & Gas Production", 6, 1, {
      large: cell(5, ["XOM", "CVX", "OXY"]),
      // A cell without its symbol list (older job output).
      small: withoutSymbols(cell(9, ["HPK"])),
    }),
    industry("Utilities", "Water Supply", -2.5, 5, {
      mid: cell(-3, ["AWK"]),
    }),
    industry("Energy", "Oil Refining", 1, undefined, {
      large: cell(2, ["MPC"]),
      mid: cell(null, ["PSX"]),
      small: cell(null, ["DK"]),
    }),
  ],
  top: [
    { sector: "Energy", industry: "Oil & Gas Production", retMedian: 6, n: 3 },
  ],
  bottom: [
    { sector: "Utilities", industry: "Water Supply", retMedian: -2.5, n: 3 },
  ],
  standouts: [
    {
      symbol: "HPK",
      ret: 42.4,
      marketCap: 1.4e9,
      z: 3.1,
      sector: "Energy",
      industry: "Oil & Gas Production",
      cap: "small",
    },
  ],
  ours: [
    {
      symbol: "XOM",
      roles: ["wish"],
      covered: true,
      sector: "Energy",
      industry: "Oil & Gas Production",
      cap: "large",
      cell1M: "leading",
      cell3M: "leading",
      opportunity: true,
    },
    { symbol: "OLD", roles: ["held"], covered: true },
    { symbol: "ZZZ", roles: ["reentry"], covered: false },
  ],
  capLabels: {
    large: "Mega/Large (≥$10B)",
    mid: "Mid ($2–10B)",
    small: "Small ($0.3–2B)",
  },
  source: {
    metadata: "Nasdaq stock screener",
    bars: "Yahoo Finance daily closes",
    finvizMap: "https://finviz.com/map.ashx?t=sec_all",
  },
  receivedAt: "2026-10-21T20:30:00.000Z",
  ...overrides,
});

export const deepValueRow = (
  symbol: string,
  overrides: Partial<DeepValueRow> = {}
): DeepValueRow => ({
  symbol,
  name: `${symbol} Corp`,
  industry: "Metal Fabrications",
  roles: ["low-price universe"],
  price: 7.96,
  marketCap: 278e6,
  metrics: {},
  criteria: {
    timeHorizon: { score: 2, evidence: "Operating cash flow is positive." },
    risk: { score: 1, evidence: "Debt ÷ equity 0.90." },
    upside: { score: 0, evidence: "Fallback: 5% to the high." },
    entry: { score: null, evidence: "No data: 52-week range" },
  },
  total: 3,
  coverage: 3,
  normalized: 10,
  reasons: ["Time horizon: Operating cash flow is positive."],
  flags: [],
  asOf: "2026-10-21",
  rank: 1,
  errors: [],
  ...overrides,
});

const unranked = ({ rank: _rank, ...rest }: DeepValueRow): DeepValueRow => rest;

export const deepValueFixture = (
  overrides: Partial<DeepValueOutput> = {}
): DeepValueOutput => ({
  generatedAt: "2026-10-21T20:28:25.921Z",
  method: "TRUE SLAP (IG reel Dew5OAejyOH, @willbchou)",
  criteria: [
    { id: "timeHorizon", lens: "TRUE", label: "Time horizon", proxy: "Runway" },
    { id: "risk", lens: "TRUE", label: "Risk", proxy: "Debt ÷ equity" },
    { id: "upside", lens: "TRUE", label: "Upside", proxy: "Peer median" },
    { id: "entry", lens: "TRUE", label: "Entry", proxy: "52-week range" },
  ],
  cutoffs: {
    scoring: { runwayMonths: [12, 24] },
    flags: { penny: 1 },
    universe: {
      maxPrice: 10,
      minMarketCap: 50e6,
      maxMarketCap: 1e9,
      minDollarVolume: 100e3,
    },
    note: "All numeric cutoffs and proxies are ours.",
  },
  sources: { prices: "Yahoo Finance", fundamentals: "SEC EDGAR" },
  counts: { scored: 3, ours: 2, universe: 1, withErrors: 0 },
  rows: [
    deepValueRow("TG"),
    deepValueRow("SIRI", {
      name: null,
      industry: null,
      roles: ["wish list", "low-price universe"],
      price: null,
      marketCap: 12.5e9,
      total: 9,
      rank: 2,
      reasons: [],
      flags: [{ id: "penny", label: "Penny stock (price < $1)" }],
      errors: ["sec: SEC companyfacts returned HTTP 500"],
    }),
    unranked(
      deepValueRow("REN", {
        roles: ["re-entry"],
        marketCap: null,
        total: 6,
        flags: [{ id: "low-price", label: "Low price (< $5)" }],
        asOf: null,
      })
    ),
  ],
  receivedAt: "2026-10-21T20:30:00.000Z",
  ...overrides,
});

export const deepValueScore = (
  overrides: Partial<DeepValueScoreOutput> = {}
): DeepValueScoreOutput => {
  const { rank: _rank, errors: _errors, ...row } = deepValueRow("SIRI");
  return {
    ...row,
    roles: [],
    marketCap: 5e5,
    errors: [],
    peerMedian: { evSales: 1.3, n: 9 },
    ...overrides,
  };
};
