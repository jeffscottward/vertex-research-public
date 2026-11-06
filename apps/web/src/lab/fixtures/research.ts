// What: UI lab fixtures for the Markets & Research pages: research chat, dossiers, watchlist,
// price alerts, news, baskets, pick lists and papers. Every value is fictional and deterministic.
// Used by: apps/web/src/lab/entries/research.tsx.
import type {
  BasketOutput,
  BasketValuationOutput,
  MarketNewsHours,
  MarketNewsTicker,
  MarketNewsWatchlistOutput,
  PickListMemberOutput,
  PickListOutput,
  PickListProposalOutput,
  PickListScreenMemberOutput,
  PickListScreenOutput,
  PriceAlertListOutput,
  PriceAlertRule,
  ResearchPaperOutput,
  ResearchReportDatasetName,
  ResearchReportDatasetOutput,
  ResearchReportSummary,
  ResearchReportsListOutput,
  WatchlistItemOutput,
} from "@darkfactory/api";
import type {
  VertexResearchChatListThreadsOutput,
  VertexResearchChatReadTranscriptPageOutput,
  VertexResearchChatRosterOutput,
  VertexResearchChatThread,
} from "@darkfactory/api/vertex";

import {
  createSeededRandom,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  roundTo,
} from "./core.ts";

const at = (minutes: number): Date => new Date(labMinutesAgo(minutes));

/** A fake 64-hex digest derived from one hex character. */
const digest = (character: string): string => character.repeat(64);

// ---------------------------------------------------------------------------
// Research chat (/research)

export const LAB_RESEARCH_SCOPE = Object.freeze({
  accountAlias: "demo-capital-research",
  environment: "research",
} as const);

const chatRecord = {
  executionAuthorized: false,
  schemaVersion: "1.0.0",
} as const;
const chatEnvelope = { ...chatRecord, ...LAB_RESEARCH_SCOPE } as const;

export const LAB_RESEARCH_ROSTER: VertexResearchChatRosterOutput = {
  ...chatEnvelope,
  participants: [
    {
      availability: "ready",
      corpus: {
        collectionId: "demo-collection-macro",
        reviewId: "demo-review-macro",
        snapshotSha256: digest("a"),
        status: "reviewed",
      },
      displayName: "Demo macro analyst",
      kind: "expert",
      participantId: "demo-macro-analyst",
      reasonCodes: [],
      specialty: "Index breadth and rates (fictional corpus)",
    },
    {
      availability: "unavailable",
      corpus: {
        collectionId: null,
        reviewId: null,
        snapshotSha256: null,
        status: "incomplete",
      },
      displayName: "Demo options analyst",
      kind: "expert",
      participantId: "demo-options-analyst",
      reasonCodes: ["corpus-not-qualified"],
      specialty: "Volatility surfaces (fictional corpus)",
    },
  ],
};

const LAB_RESEARCH_OWNER = "demo-analyst";

const LAB_RESEARCH_MESSAGES = [
  "Demo question: SPY breadth narrowed this week while QQQ kept rising. Is the rally concentrated in a few large caps?",
  "Demo note: NVDA, MSFT and AMZN carry most of the QQQ gain in the fake data; equal-weight IWM is flat over the same window.",
  "Demo follow-up: compare GLD and SLV against the 20-day range before the next review. Research only; no orders.",
] as const;

/** The thread the lab opens first. */
export const LAB_RESEARCH_THREAD_ID = "demo-thread-breadth";

const LAB_RESEARCH_MAIN_THREAD: VertexResearchChatThread = {
  ...chatEnvelope,
  createdAt: labMinutesAgo(240),
  ownerActorId: LAB_RESEARCH_OWNER,
  participantIds: ["demo-macro-analyst", "demo-options-analyst"],
  revision: String(LAB_RESEARCH_MESSAGES.length + 1),
  threadId: LAB_RESEARCH_THREAD_ID,
  title: "Demo: SPY breadth vs. QQQ concentration",
  updatedAt: labMinutesAgo(30),
};

const LAB_RESEARCH_THREADS: readonly VertexResearchChatThread[] = [
  LAB_RESEARCH_MAIN_THREAD,
  {
    ...chatEnvelope,
    createdAt: labMinutesAgo(4320),
    ownerActorId: LAB_RESEARCH_OWNER,
    participantIds: ["demo-macro-analyst"],
    revision: "1",
    threadId: "demo-thread-metals",
    title: "Demo: gold and silver ratio watch",
    updatedAt: labMinutesAgo(2880),
  },
];

export const LAB_RESEARCH_THREAD_PAGE: VertexResearchChatListThreadsOutput = {
  ...chatEnvelope,
  items: LAB_RESEARCH_THREADS,
  nextCursor: null,
};

/** The first thread's transcript: human statements only, one complete page. */
export const labResearchTranscript = (
  threadId: string
): VertexResearchChatReadTranscriptPageOutput => {
  const thread: VertexResearchChatThread = {
    ...LAB_RESEARCH_MAIN_THREAD,
    threadId,
  };
  return {
    ...chatRecord,
    highWaterSequence: String(LAB_RESEARCH_MESSAGES.length),
    items: LAB_RESEARCH_MESSAGES.map((body, index) => ({
      ...chatRecord,
      author: { actorId: LAB_RESEARCH_OWNER, kind: "user" },
      body,
      citations: [],
      kind: "statement",
      messageId: `demo-message-${index + 1}`,
      recordedAt: labMinutesAgo(200 - index * 60),
      sequence: String(index + 1),
      threadId,
    })),
    nextCursor: null,
    snapshotRevision: thread.revision,
    thread,
  };
};

// ---------------------------------------------------------------------------
// Research dossiers (/research/reports)

const report = (
  id: string,
  name: string,
  assetType: string,
  exchange: string,
  revision: string,
  research: boolean
): ResearchReportSummary => ({
  assetType,
  companyResearch: research
    ? {
        acceptedAt: at(1440),
        reportRevision: digest(revision),
        revision: digest("e"),
      }
    : null,
  currency: "USD",
  dataRevision: digest(revision),
  exchange,
  id,
  identityStatus: "verified",
  importedAt: at(720),
  name,
  providerSymbol: `${id}.DEMO`,
  sourceUpdatedAt: at(1440 * 2),
  status: "complete",
  symbol: id,
});

export const LAB_RESEARCH_REPORTS: ResearchReportsListOutput = {
  categories: [
    {
      description: "Fictional dossiers for the broad-market ETFs.",
      id: "demo-core-etfs",
      label: "Demo core ETFs",
      reportIds: ["SPY", "QQQ", "GLD"],
    },
    {
      description: "Fictional dossiers for large-cap equities.",
      id: "demo-large-caps",
      label: "Demo large caps",
      reportIds: ["NVDA", "MSFT"],
    },
  ],
  reports: [
    report(
      "SPY",
      "Demo S&P 500 tracker dossier",
      "ETF",
      "DEMO-ARCA",
      "1",
      false
    ),
    report(
      "QQQ",
      "Demo Nasdaq-100 tracker dossier",
      "ETF",
      "DEMO-NMS",
      "2",
      false
    ),
    report("GLD", "Demo gold trust dossier", "ETF", "DEMO-ARCA", "3", false),
    report("NVDA", "Demo GPU maker dossier", "Equity", "DEMO-NMS", "4", true),
    report(
      "MSFT",
      "Demo software major dossier",
      "Equity",
      "DEMO-NMS",
      "5",
      true
    ),
    report("TSLA", "Demo EV maker dossier", "Equity", "DEMO-NMS", "6", false),
  ],
};

/** The dossier /lab/research-report opens without ?id=. */
export const LAB_RESEARCH_DEFAULT_REPORT = "SPY";

/** One dataset of a dossier: summary, metrics, sections, news items and sources. */
export const labResearchDataset = (
  reportId: string,
  dataset: ResearchReportDatasetName
): ResearchReportDatasetOutput => {
  const price = labBasePrice(reportId);
  const data = {
    asOf: labDaysAgo(1),
    items: [
      {
        date: labDaysAgo(2),
        source: "Demo Wire",
        summary: `Fictional headline summary for ${reportId}.`,
        title: `${reportId} demo story: guidance unchanged`,
        url: "https://example.test/news/demo-guidance",
      },
    ],
    metrics: [
      { label: "Demo P/E", period: "TTM", value: roundTo(price / 7.5, 1) },
      { label: "Demo 20-day return", period: "20D", value: "+2.4%" },
      { label: "Demo analyst rating", period: null, value: "Hold (fictional)" },
    ],
    quote: { asOf: labDaysAgo(1), price },
    sections: [
      {
        body: [`${reportId} sits in the upper half of its fake 52-week range.`],
        bullets: [
          "Demo point: volume near average",
          "Demo point: no fake earnings this week",
        ],
        id: "demo-overview",
        title: "Demo overview",
      },
    ],
    sources: [
      {
        id: "demo-source",
        title: "Demo data vendor",
        url: "https://example.test/sources/demo",
      },
    ],
    summary: `Fictional ${dataset} summary for ${reportId}. Research only.`,
    title: `${reportId} ${dataset} (demo)`,
    warnings: ["Demo data: values are invented for the UI lab."],
  };
  return {
    byteLength: JSON.stringify(data).length,
    data,
    dataRevision: digest("1"),
    dataset,
    reportId,
    revisions: [digest("1"), digest("0")],
    sha256: digest("f"),
  };
};

// ---------------------------------------------------------------------------
// Watchlist (/watchlist)

const WATCH = [
  ["SPY", "Demo: core index, watch breadth", "560", "575"],
  ["QQQ", "Demo: concentration risk", null, null],
  ["NVDA", "Demo: buy zone after earnings", "125", "132.5"],
  ["MSFT", null, "400", null],
  ["GLD", "Demo: hedge sleeve", "240", "246"],
  ["TSLA", "Demo: high volatility, small size", null, null],
] as const;

export const LAB_WATCHLIST: WatchlistItemOutput[] = WATCH.map(
  ([symbol, note, low, high], index) => ({
    buyZoneHigh: high,
    buyZoneLow: low,
    createdAt: at(1440 * (10 - index)),
    id: `demo-watch-${symbol.toLowerCase()}`,
    note,
    symbol,
    updatedAt: at(60 * (index + 1)),
  })
);

// ---------------------------------------------------------------------------
// Price alerts (/price-alerts)

const LAB_PRICE_ALERT_RULES: PriceAlertRule[] = [
  {
    createdAt: at(2880),
    id: "demo-alert-spy",
    kind: "above",
    level: "590",
    note: "Demo: breakout above the fake range",
    role: "price",
    state: { lastCheckedAt: at(5), status: "active" },
    symbol: "SPY",
  },
  {
    createdAt: at(4320),
    id: "demo-alert-nvda",
    kind: "below",
    level: "126.5",
    note: "Demo: protective stop",
    role: "stop",
    state: { lastCheckedAt: at(5), status: "active" },
    symbol: "NVDA",
  },
  {
    createdAt: at(10_080),
    id: "demo-alert-gld",
    kind: "above",
    level: "245",
    note: null,
    role: "target",
    state: {
      delivery: "sent",
      status: "triggered",
      triggeredAt: at(180),
      triggerPrice: "245.62",
    },
    symbol: "GLD",
  },
  {
    createdAt: at(1440),
    id: "demo-alert-tsla",
    kind: "below",
    level: "240",
    note: null,
    role: "price",
    state: { lastCheckedAt: null, status: "active" },
    symbol: "TSLA",
  },
];

export const LAB_PRICE_ALERTS: PriceAlertListOutput = {
  notifications: "configured",
  rules: LAB_PRICE_ALERT_RULES,
  symbols: LAB_WATCHLIST.map((item) => item.symbol),
};

// ---------------------------------------------------------------------------
// News monitor (/news)

const HEADLINES = [
  ["Demo Wire", ["earnings"], "beats fictional estimates on demo revenue"],
  ["Example Markets Daily", ["analyst"], "gets a fictional upgrade to Buy"],
  [null, ["guidance", "deal"], "raises demo guidance after a fake partnership"],
] as const;

const newsTicker = (
  symbol: string,
  offset: number,
  hours: number
): MarketNewsTicker => ({
  errors: [],
  filings:
    offset === 0
      ? [
          {
            filedAt: at(600),
            form: "8-K",
            important: true,
            items: [
              {
                code: "2.02",
                label: "Results of Operations and Financial Condition",
              },
            ],
            title: `${symbol} demo current report`,
            url: `https://example.test/filings/${symbol.toLowerCase()}-8k`,
          },
        ]
      : [],
  headlines: HEADLINES.map(([publisher, tags, text], index) => ({
    publishedAt: at(((index + 1) * hours * 60) / 4 + offset * 37),
    publisher,
    tags: [...tags],
    title: `${symbol} ${text}`,
    url: `https://example.test/news/${symbol.toLowerCase()}-${index + 1}`,
  })),
  symbol,
});

export const labMarketNews = (
  hours: MarketNewsHours
): MarketNewsWatchlistOutput => ({
  receivedAt: at(1),
  tickers: [
    ...["NVDA", "SPY", "MSFT", "GLD"].map((symbol, index) =>
      newsTicker(symbol, index, hours)
    ),
    {
      errors: ["Demo feed timeout (fictional)"],
      filings: [],
      headlines: [],
      symbol: "TSLA",
    },
  ],
});

// ---------------------------------------------------------------------------
// Baskets (/baskets, /watchlist)

const basket = (
  id: string,
  symbol: string,
  name: string,
  members: readonly (readonly [string, string])[]
): BasketOutput => ({
  baseDate: labDaysAgo(60),
  baseValue: "100",
  createdAt: at(1440 * 61),
  id,
  members: members.map(([member, weight]) => ({
    basePrice: String(labBasePrice(member)),
    sharesAtBase: String(
      roundTo((Number(weight) * 100) / labBasePrice(member), 6)
    ),
    symbol: member,
    weight,
  })),
  name,
  symbol,
  updatedAt: at(1440 * 3),
});

const LAB_AI_BASKET = basket("demo-basket-ai", "DEMOAI", "Demo AI leaders", [
  ["NVDA", "0.4"],
  ["MSFT", "0.3"],
  ["AMZN", "0.2"],
  ["AAPL", "0.1"],
]);

export const LAB_BASKETS: BasketOutput[] = [
  LAB_AI_BASKET,
  basket("demo-basket-metals", "DEMOMTL", "Demo metals sleeve", [
    ["GLD", "0.6"],
    ["SLV", "0.4"],
  ]),
  basket("demo-basket-core", "DEMOCORE", "Demo core indexes", [
    ["SPY", "0.5"],
    ["QQQ", "0.3"],
    ["IWM", "0.2"],
  ]),
];

const VALUATION_DAYS = 60;

/** A seeded random walk for the basket and SPY, with member returns. Unknown ids use the first basket. */
export const labBasketValuation = (id: string): BasketValuationOutput => {
  const chosen = LAB_BASKETS.find((entry) => entry.id === id) ?? LAB_AI_BASKET;
  const random = createSeededRandom(`basket:${chosen.id}`);
  let value = 100;
  let benchmark = 100;
  let previousValue = value;
  const points = Array.from({ length: VALUATION_DAYS }, (_, index) => {
    previousValue = value;
    value *= 1 + (random() - 0.46) * 0.02;
    benchmark *= 1 + (random() - 0.48) * 0.012;
    return {
      benchmark: roundTo(benchmark, 2),
      date: labDaysAgo(VALUATION_DAYS - 1 - index),
      missing: [],
      stale: false,
      value: roundTo(value, 2),
    };
  });
  const lastDate = labDaysAgo(0);
  const lastValue = roundTo(value, 2);
  const members = chosen.members.map((member) => {
    const returnPct = roundTo((random() - 0.35) * 24, 2);
    const weight = Number(member.weight);
    const basePrice = labBasePrice(member.symbol);
    return {
      basePrice,
      contribution: roundTo(weight * returnPct, 2),
      lastDate,
      lastPrice: roundTo(basePrice * (1 + returnPct / 100), 2),
      returnPct,
      stale: false,
      symbol: member.symbol,
      weight,
    };
  });
  return {
    baseDate: chosen.baseDate,
    baseState: "fixed",
    basket: chosen,
    benchmarkSymbol: "SPY",
    computedAt: labMinutesAgo(2),
    latest: {
      benchmark: roundTo(benchmark, 2),
      changePct: roundTo(lastValue - 100, 2),
      date: lastDate,
      dayChangePct: roundTo((value / previousValue - 1) * 100, 2),
      value: lastValue,
    },
    members,
    points,
    staleSymbols: [],
    unavailable: [],
  };
};

// ---------------------------------------------------------------------------
// Papers (/papers)

export const LAB_PAPERS: ResearchPaperOutput[] = [
  {
    authors: "Demo Analyst, Example Researcher",
    blockers: null,
    createdAt: at(1440 * 20),
    id: "demo-paper-momentum",
    identifier: "demo:2601.00001",
    kind: "paper",
    notes: "Demo momentum v1 reproduces the headline Sharpe on fake data.",
    reportedMetrics: { cagr: "12.4%", sharpe: 1.21 },
    reproducedMetrics: { cagr: "10.9%", sharpe: 1.04 },
    sourceUrl: "https://example.test/papers/demo-momentum",
    stage: "verdict",
    title: "Demo: Time-series momentum across ETF sleeves",
    updatedAt: at(1440 * 2),
    verdict: "promising",
    year: 2025,
  },
  {
    authors: "Example Quant Group",
    blockers:
      "Demo blocker: needs intraday options data not in the fake vendor.",
    createdAt: at(1440 * 12),
    id: "demo-paper-vol",
    identifier: null,
    kind: "paper",
    notes: null,
    reportedMetrics: { sharpe: 0.9 },
    reproducedMetrics: {},
    sourceUrl: null,
    stage: "spec_extracted",
    title: "Demo: Volatility risk premium in index options",
    updatedAt: at(1440 * 5),
    verdict: "pending",
    year: 2024,
  },
  {
    authors: null,
    blockers: null,
    createdAt: at(1440 * 8),
    id: "demo-paper-breadth",
    identifier: null,
    kind: "article",
    notes: "Fictional article; the effect vanished out of sample.",
    reportedMetrics: { hitRate: "61%" },
    reproducedMetrics: { hitRate: "49%" },
    sourceUrl: "https://example.test/articles/demo-breadth",
    stage: "backtested",
    title: "Demo: Market breadth thrusts as entry signals",
    updatedAt: at(1440),
    verdict: "rejected",
    year: null,
  },
  {
    authors: "Demo Analyst",
    blockers: null,
    createdAt: at(1440 * 1),
    id: "demo-paper-queued",
    identifier: "demo:2610.00042",
    kind: "paper",
    notes: null,
    reportedMetrics: {},
    reproducedMetrics: {},
    sourceUrl: null,
    stage: "queued",
    title: "Demo: Seasonality in gold and silver ETFs",
    updatedAt: at(1440 * 1),
    verdict: "pending",
    year: 2026,
  },
];

const pickMember = (
  symbol: string,
  overrides: Partial<PickListMemberOutput> = {}
): PickListMemberOutput => ({
  addedOn: null,
  rank: null,
  rating: null,
  sector: null,
  symbol,
  targetPrice: null,
  thesis: null,
  weight: null,
  ...overrides,
});

export const LAB_PICK_LISTS: PickListOutput[] = [
  {
    bucketSymbol: null,
    id: "demo-pick-list",
    latest: {
      asOf: "2026-11-02",
      id: "demo-pick-snapshot",
      importedAt: "2026-11-02T12:00:00.000Z",
      members: [
        pickMember("NVDA", {
          rank: 1,
          rating: "Demo buy",
          sector: "Technology",
          targetPrice: 210,
          thesis: "Demo thesis: data center demand",
        }),
        pickMember("XOM", { rank: 2, sector: "Energy" }),
        pickMember("GLD", { rank: 3, sector: "Materials" }),
      ],
      method: "manual",
    },
    name: "Demo pick list",
    slug: "demo-picks",
    snapshotCount: 1,
    source: "demo",
    sourceLabel: "Demo source",
  },
];

const pickGate = (ok: boolean | null, detail: string) => ({ detail, ok });
const screenedPick = (
  symbol: string,
  overrides: Partial<PickListScreenMemberOutput> = {}
): PickListScreenMemberOutput => ({
  gates: {
    aboveVwap20: pickGate(true, "close 100.00 >= VWAP20 98.00"),
    emaTrend: pickGate(true, "close 100.00 > EMA20 95.00 > EMA50 90.00"),
    notOverextended: pickGate(true, "close 100.00 <= 105.00"),
  },
  last: 100,
  lastDate: "2026-11-02",
  quadrant: "leading",
  reason: null,
  sector: "Technology",
  sectorEtf: "XLK",
  sectorQuadrant: "improving",
  status: "pass",
  symbol,
  ...overrides,
});

export const labPickListScreen = (listId: string): PickListScreenOutput => ({
  computedAt: "2026-11-02T14:00:00.000Z",
  listId,
  members: [
    screenedPick("NVDA"),
    screenedPick("XOM", {
      gates: {
        aboveVwap20: pickGate(true, "close 80.00 >= VWAP20 79.00"),
        emaTrend: pickGate(false, "close 80.00 < EMA20 85.00"),
        notOverextended: pickGate(true, "close 80.00 <= 90.00"),
      },
      quadrant: null,
      sector: "Energy",
      sectorEtf: null,
      sectorQuadrant: null,
      status: "fail",
    }),
  ],
  snapshotId: "demo-pick-snapshot",
});

export const LAB_PICK_LIST_PROPOSAL: PickListProposalOutput = {
  buckets: [],
  computedAt: "2026-11-02T14:00:00.000Z",
  notProposed: [],
  proposalOnly: true,
  rows: [],
  rules: {
    dteMax: 180,
    dteMin: 90,
    fullMaxLossPct: 0.5,
    halfMaxLossPct: 0.25,
    longDelta: 0.6,
    maxLossGatePct: 2,
    namePremiumCapPct: 2,
    riskFreeRate: 0.04,
    shortDelta: 0.3,
    targetDte: 120,
  },
  totalMaxLossPct: 0,
};
