// What: UI lab fixtures for the research lens pages: rotation matrix, sector rotation, deep value,
// congress trades, risk caps and market context (volatility, GEX, macro, news).
// Every value is fictional and deterministic. Never put real account data or real people here.
// Used by: apps/web/src/lab/entries/lenses.tsx.
import {
  type CongressTradeFiling,
  type CongressTradesFeedOutput,
  type CongressTradeWindow,
  type DeepValueOutput,
  type DeepValueRow,
  type DeepValueScoreOutput,
  type GexIndexRow,
  type MacroSeries,
  type MarketContextOutput,
  type MarketVolatilityOutput,
  type RotationCell,
  type RotationIndustry,
  type RotationMatrixOutput,
  type RotationPeriod,
  SECTOR_ROTATION_SECTORS,
  type SectorRotationMapInput,
  type SectorRotationMapOutput,
  type SectorRotationPoint,
  type SectorRotationQuadrant,
  type SectorRotationSeries,
  type VolatilitySeries,
} from "@darkfactory/api";

import type { SectorRotationUniversePreset } from "../../components/portal/sector-rotation-client.ts";
import {
  createSeededRandom,
  LAB_NOW,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

// ---------------------------------------------------------------- rotation matrix

const PERIOD_BARS: Readonly<Record<RotationPeriod, number>> = {
  "1D": 1,
  "1M": 21,
  "3M": 63,
  "6M": 126,
};

/** Fictional sectors -> industries -> [large, mid, small] symbols. */
const LAB_ROTATION_TREE = [
  {
    industries: [
      {
        large: "NVDA",
        mid: "MSFT",
        name: "Demo Semiconductors",
        small: "AAPL",
      },
      { large: "MSFT", mid: "AAPL", name: "Demo Software", small: "NVDA" },
    ],
    sector: "Technology",
  },
  {
    industries: [
      { large: "TSLA", mid: "AMZN", name: "Demo Autos", small: "IWM" },
      { large: "AMZN", mid: "TSLA", name: "Demo Online Retail", small: "QQQ" },
    ],
    sector: "Consumer Discretionary",
  },
  {
    industries: [
      { large: "GLD", mid: "SLV", name: "Demo Precious Metals", small: "DIA" },
    ],
    sector: "Materials",
  },
  {
    industries: [
      { large: "USO", mid: "SPY", name: "Demo Oil Producers", small: "IWM" },
    ],
    sector: "Energy",
  },
] as const;

const CAP_SIZES = { large: 180e9, mid: 6e9, small: 900e6 } as const;

export const labRotationMatrix = (
  period: RotationPeriod
): RotationMatrixOutput => {
  const random = createSeededRandom(`rotation-${period}`);
  const scale = Math.sqrt(PERIOD_BARS[period]);
  const ret = () => roundTo((random() - 0.45) * 4 * scale, 1);
  const industries: RotationIndustry[] = [];
  for (const branch of LAB_ROTATION_TREE)
    for (const industry of branch.industries) {
      const cells: RotationIndustry["cells"] = {};
      for (const cap of ["large", "mid", "small"] as const) {
        const value = ret();
        const brief = {
          marketCap: CAP_SIZES[cap],
          ret: value,
          symbol: industry[cap],
        };
        const cell: RotationCell = {
          breadth: roundTo(35 + random() * 40, 1),
          laggards: [],
          leaders: [brief],
          n: 6,
          retCapWeighted: roundTo(value * 1.1, 1),
          retMedian: value,
          symbols: [brief],
        };
        cells[cap] = cell;
      }
      const median = ret();
      industries.push({
        breadth: roundTo(30 + random() * 50, 1),
        cells,
        industry: industry.name,
        laggards: [],
        leaders: [],
        n: 12,
        retCapWeighted: roundTo(median * 1.2, 1),
        retMedian: median,
        sector: branch.sector,
        standouts: [],
      });
    }
  const ranked = [...industries]
    .sort((left, right) => Number(right.retMedian) - Number(left.retMedian))
    .map((industry, index) => ({
      ...industry,
      quintile: Math.min(5, index + 1),
      rank: index + 1,
    }));
  const brief = (industry: RotationIndustry) => ({
    industry: industry.industry,
    n: industry.n,
    retMedian: industry.retMedian,
    sector: industry.sector,
  });
  return {
    asOf: labDaysAgo(0),
    bars: PERIOD_BARS[period],
    bottom: ranked.slice(-2).map(brief),
    capLabels: {
      large: "Mega/Large (≥$10B)",
      mid: "Mid ($2–10B)",
      small: "Small ($0.3–2B)",
    },
    generatedAt: labMinutesAgo(90),
    industries: ranked,
    n: ranked.length * 12,
    ours: [
      {
        cap: "large",
        cell1M: "leading",
        cell3M: "leading",
        covered: true,
        industry: "Demo Semiconductors",
        opportunity: true,
        roles: ["wish"],
        sector: "Technology",
        symbol: "NVDA",
      },
      { covered: true, roles: ["held"], symbol: "GLD" },
    ],
    period,
    receivedAt: labMinutesAgo(5),
    sectors: LAB_ROTATION_TREE.map((branch) => {
      const value = ret();
      return {
        breadth: roundTo(30 + random() * 50, 1),
        industries: branch.industries.map((industry) => industry.name),
        laggards: [],
        leaders: [],
        n: branch.industries.length * 12,
        retCapWeighted: roundTo(value * 1.15, 1),
        retMedian: value,
        sector: branch.sector,
      };
    }),
    source: {
      bars: "Demo daily closes (fake data)",
      metadata: "Demo screener (fake data)",
    },
    standouts: [
      {
        cap: "large",
        industry: "Demo Semiconductors",
        marketCap: 180e9,
        ret: roundTo(12 * scale, 1),
        sector: "Technology",
        symbol: "NVDA",
        z: 2.8,
      },
    ],
    top: ranked.slice(0, 2).map(brief),
    universeSize: 1200,
  };
};

// ---------------------------------------------------------------- sector rotation

/** Ratio and momentum above or below 100 pick the quadrant. */
export const labQuadrant = (
  ratio: number,
  momentum: number
): SectorRotationQuadrant => {
  if (ratio >= 100) return momentum >= 100 ? "leading" : "weakening";
  return momentum >= 100 ? "improving" : "lagging";
};

/** Twelve points that drift around 100/100, one per week (or day). */
const labRotationSeries = (
  symbol: string,
  name: string | null,
  step: number
): SectorRotationSeries => {
  const random = createSeededRandom(`sector-${symbol}`);
  let ratio = 98 + random() * 4;
  let momentum = 98 + random() * 4;
  const points: SectorRotationPoint[] = [];
  for (let index = 11; index >= 0; index -= 1) {
    ratio = roundTo(ratio + (random() - 0.5) * 0.8, 2);
    momentum = roundTo(momentum + (random() - 0.5) * 0.8, 2);
    points.push({
      date: labDaysAgo(index * step),
      momentum,
      quadrant: labQuadrant(ratio, momentum),
      ratio,
    });
  }
  return {
    latest: {
      date: labDaysAgo(0),
      momentum,
      periods: 1,
      quadrant: labQuadrant(ratio, momentum),
      ratio,
      since: labDaysAgo(0),
    },
    name,
    points,
    symbol,
  };
};

export const labSectorRotationMap = (
  input: SectorRotationMapInput
): SectorRotationMapOutput => {
  const timeframe = input.timeframe ?? "weekly";
  const step = timeframe === "daily" ? 1 : 7;
  const universe = input.universe ?? { kind: "sectors" };
  const series =
    universe.kind === "custom"
      ? universe.symbols.map((symbol) => labRotationSeries(symbol, null, step))
      : SECTOR_ROTATION_SECTORS.map((sector) =>
          labRotationSeries(sector.symbol, sector.name, step)
        );
  return {
    asOf: labDaysAgo(0),
    benchmark: input.benchmark ?? "SPY",
    errors: [],
    generatedAt: labMinutesAgo(60),
    params: {
      momentumLag: 4,
      momentumSmoothing: 3,
      rsSmoothing: 4,
      trendWindow: 26,
    },
    series,
    source: universe.kind === "custom" ? "computed" : "stored",
    timeframe,
    universe: universe.kind,
  };
};

export const LAB_SECTOR_UNIVERSES: readonly SectorRotationUniversePreset[] = [
  {
    id: "sectors",
    label: `Sector ETFs (${SECTOR_ROTATION_SECTORS.length})`,
    universe: { kind: "sectors" },
  },
  {
    id: "watchlist",
    label: "Watchlist: Demo watchlist (6)",
    universe: {
      kind: "custom",
      symbols: ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN", "QQQ"],
    },
  },
  {
    id: "basket-demo",
    label: "Basket: Demo metals basket (3)",
    universe: { kind: "custom", symbols: ["GLD", "SLV", "USO"] },
  },
];

// ---------------------------------------------------------------- deep value

const labDeepValueRow = (
  symbol: string,
  rank: number,
  total: number
): DeepValueRow => {
  const price = roundTo(labBasePrice(symbol) / 20, 2);
  return {
    asOf: labDaysAgo(1),
    coverage: 4,
    criteria: {
      entry: { evidence: "Demo: near 52-week low.", score: total > 6 ? 2 : 0 },
      risk: { evidence: "Demo: debt ÷ equity 0.40.", score: total > 5 ? 2 : 1 },
      timeHorizon: { evidence: "Demo: 30 months of cash runway.", score: 2 },
      upside: { evidence: "Demo: EV/sales below peer median.", score: 1 },
    },
    errors: [],
    flags: price < 5 ? [{ id: "low-price", label: "Low price (< $5)" }] : [],
    industry: "Demo Industrials",
    marketCap: roundTo(price * 60e6, 0),
    metrics: { evSales: roundTo(0.4 + rank * 0.3, 2) },
    name: `Demo ${symbol} Holdings (fake)`,
    normalized: roundTo((total / 8) * 16, 1),
    price,
    rank,
    reasons: [`Time horizon: Demo runway for ${symbol} (fake).`],
    roles:
      rank === 1 ? ["wish list", "low-price universe"] : ["low-price universe"],
    symbol,
    total,
  };
};

const DEEP_VALUE_SYMBOLS = ["SLV", "IWM", "USO", "AMZN", "NVDA", "AAPL"];

export const labDeepValue = (): DeepValueOutput => ({
  counts: {
    ours: 1,
    scored: DEEP_VALUE_SYMBOLS.length,
    universe: DEEP_VALUE_SYMBOLS.length,
    withErrors: 0,
  },
  criteria: [
    { id: "timeHorizon", label: "Time horizon", lens: "TRUE", proxy: "Runway" },
    { id: "risk", label: "Risk", lens: "TRUE", proxy: "Debt ÷ equity" },
    { id: "upside", label: "Upside", lens: "TRUE", proxy: "Peer median" },
    { id: "entry", label: "Entry", lens: "TRUE", proxy: "52-week range" },
  ],
  cutoffs: {
    flags: { penny: 1 },
    note: "Demo cutoffs for the UI lab.",
    scoring: { runwayMonths: [12, 24] },
    universe: {
      maxMarketCap: 1e9,
      maxPrice: 10,
      minDollarVolume: 100e3,
      minMarketCap: 50e6,
    },
  },
  generatedAt: labMinutesAgo(120),
  method: "Demo TRUE SLAP lens (fake data)",
  receivedAt: labMinutesAgo(5),
  rows: DEEP_VALUE_SYMBOLS.map((symbol, index) =>
    labDeepValueRow(symbol, index + 1, 8 - index)
  ),
  sources: { fundamentals: "Demo filings", prices: "Demo prices" },
});

export const labDeepValueScore = (symbol: string): DeepValueScoreOutput => {
  const {
    rank: _rank,
    errors: _errors,
    ...row
  } = labDeepValueRow(symbol, 2, 6);
  return { ...row, errors: [], peerMedian: { evSales: 1.3, n: 9 }, roles: [] };
};

// ---------------------------------------------------------------- congress trades

const LAB_MEMBERS = [
  { district: "ZZ01", first: "Demo", last: "Member" },
  { district: "ZZ02", first: "Sample", last: "Legislator" },
  { district: "ZZ03", first: "Fixture", last: "Representative" },
  { district: "ZZ04", first: "Test", last: "Delegate" },
] as const;

export const labCongressFeed = (
  days: CongressTradeWindow
): CongressTradesFeedOutput => {
  const count = Math.max(3, Math.round(days / 3));
  const filings: CongressTradeFiling[] = [];
  const roster = Array.from({ length: 8 }, () => LAB_MEMBERS)
    .flat()
    .slice(0, count);
  for (const [index, person] of roster.entries()) {
    const docId = String(90_000_000 + index);
    filings.push({
      docId,
      filedOn: labDaysAgo(Math.floor((index * days) / count)),
      firstName: person.first,
      lastName: person.last,
      member: `Rep. ${person.first} ${person.last} (fake)`,
      // The contract only accepts House Clerk PDF links; these document ids do not exist.
      pdfUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`,
      stateDistrict: person.district,
      year: 2026,
    });
  }
  return {
    filings,
    members: [...new Set(filings.map((filing) => filing.member))].sort(),
    receivedAt: LAB_NOW,
    source: "Demo disclosure index (fake data)",
  };
};

// ---------------------------------------------------------------- market context

const volSeries = (value: number, change1d: number, pct1y: number) =>
  ({
    asOf: labDaysAgo(0),
    change1d,
    pct1y,
    stale: false,
    value,
  }) satisfies VolatilitySeries;

export const LAB_MARKET_VOLATILITY: MarketVolatilityOutput = {
  implied: { band: "normal", impliedPct: 1.1, multiple: 0.38 },
  sourceErrors: [],
  spread: volSeries(6.5, -1, 70),
  spx: { movePct: -0.42, price: 5812.4, sessionOpen: false },
  vix: volSeries(17.4, 0.6, 58),
  vixeq: volSeries(23.9, -0.4, 61),
  vvix: volSeries(94.2, 1.8, 47),
};

const gexRow = (symbol: "SPY" | "QQQ", spot: number, net: number) =>
  ({
    callWall: roundTo(spot * 1.02, 0),
    fadeNote: null,
    flip: roundTo(spot * 1.01, 2),
    netChex: -4e8,
    netDex: 2.5e9,
    netGex: net,
    netVex: 1.2e9,
    notes: [`Demo note for ${symbol} (fake data)`],
    putWall: roundTo(spot * 0.97, 0),
    regime: net < 0 ? "amplified" : "dampened",
    spot,
    spotVsFlip: "below",
    status: "ok",
    symbol,
    zeroDte: {
      callWall: roundTo(spot * 1.01, 0),
      expiry: labDaysAgo(0),
      flip: roundTo(spot * 1.005, 2),
      netGex: roundTo(net / 10, 0),
      putWall: roundTo(spot * 0.99, 0),
    },
  }) satisfies GexIndexRow;

const macro = (
  id: string,
  label: string,
  value: number,
  group: MacroSeries["group"]
): MacroSeries => ({
  change1d: -0.02,
  change1m: 0.12,
  change1w: 0.05,
  change1y: -0.3,
  date: labDaysAgo(1),
  group,
  id,
  label,
  pct1y: 64,
  source: "Demo macro feed",
  sourceUrl: "https://example.test/macro",
  stale: false,
  status: "ok",
  units: "%",
  value,
});

export const LAB_MARKET_CONTEXT: MarketContextOutput = {
  generatedAt: labMinutesAgo(2),
  gex: {
    asOf: labMinutesAgo(10),
    index: [
      gexRow("SPY", labBasePrice("SPY"), -8.4e9),
      gexRow("QQQ", labBasePrice("QQQ"), 3.1e9),
    ],
    label: "Demo GEX estimate (fake data).",
    oiSession: labDaysAgo(1),
  },
  macro: {
    asOf: labMinutesAgo(20),
    events: [{ date: labDaysAgo(-2), name: "Demo jobs report", time: "08:30" }],
    regimes: [{ id: "curve", label: "normal", rule: "10y-2y < 0 inverted" }],
    series: [
      macro("DEMO10Y", "Demo 10-year yield", 4.21, "rates"),
      macro("DEMO2Y", "Demo 2-year yield", 3.94, "rates"),
    ],
  },
  missing: [],
  news: {
    asOf: labMinutesAgo(4),
    headlines: [
      {
        materiality: "medium",
        publishedAt: labMinutesAgo(30),
        publisher: "Demo Wire",
        sentiment: 0.2,
        theme: "Demo rates theme",
        title: "Demo headline: index drifts in quiet session (fake)",
        url: "https://example.test/news/1",
      },
    ],
    themes: [
      {
        count24h: 14,
        count72h: 31,
        id: "demo_rates",
        label: "Demo rates theme",
        sentiment24h: 0.12,
        shock: false,
      },
    ],
  },
  stale: false,
};
