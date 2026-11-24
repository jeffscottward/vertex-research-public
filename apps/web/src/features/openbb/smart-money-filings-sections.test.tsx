// @vitest-environment jsdom
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

import type {
  CongressTradesFeedOutput,
  OpenbbInsiderClustersOutput,
  SmartMoneyRankingOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { OpenbbGateway } from "./gateway.ts";
import { StockSmartMoneySections } from "./smart-money-filings-sections.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const flush = async () => {
  for (let idx = 0; idx < 20; idx += 1) await Promise.resolve();
};

const render = async (node: React.ReactElement) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
    await flush();
  });
  return { container, root };
};

const baseGateway = (overrides: Partial<OpenbbGateway> = {}): OpenbbGateway =>
  ({
    cot: vi.fn(),
    events: vi.fn(),
    ivHistory: vi.fn(),
    macro: vi.fn(),
    sec: vi.fn(),
    shorts: vi.fn(),
    status: vi.fn(),
    volContext: vi.fn(),
    ...overrides,
  }) as unknown as OpenbbGateway;

const sampleRanking = (
  overrides: Partial<SmartMoneyRankingOutput> = {}
): SmartMoneyRankingOutput => ({
  capturedAt: new Date("2026-11-23T19:45:00.000Z"),
  coverage: {
    capturedAt: new Date("2026-11-23T19:45:00.000Z"),
    lastAttemptAt: new Date("2026-11-23T19:45:00.000Z"),
    lastMessage: null,
    overdueSince: null,
    sessionDate: "2026-11-23",
    state: "fresh",
    status: "partial",
  },
  delay: "QuantData, intraday",
  history: {
    from: "2025-11-01",
    noData: 0,
    pending: 0,
    stored: 200,
    weekdays: 200,
  },
  receivedAt: new Date("2026-11-23T19:46:00.000Z"),
  rows: [
    {
      bearishPremium: 300_000,
      bullishPremium: 1_500_000,
      netPremium: 1_200_000,
      premium: 1_800_000,
      rank: 4,
      sessionsPresent: 5,
      ticker: "EXWD",
      tradeCount: 9,
      volume: 3000,
    },
  ],
  sessions: [],
  source: "QuantData",
  totals: {
    bearishPremium: 300_000,
    bullishPremium: 1_500_000,
    netPremium: 1_200_000,
    premium: 1_800_000,
    tickers: 1,
  },
  ...overrides,
});

const sampleClusters = (
  overrides: Partial<OpenbbInsiderClustersOutput> = {}
): OpenbbInsiderClustersOutput => ({
  clusters: [
    {
      filings: [
        {
          acceptedAt: "2026-11-20T21:00:00.000Z",
          accessionNumber: "0001193125-26-000001",
          owners: [{ cik: "1", name: "Alex Doe", title: "CEO" }],
          plan10b51: false,
          shares: 1000,
          url: "https://www.sec.gov/Archives/edgar/data/1/1.xml",
          value: 150_000,
          valueIncomplete: false,
        },
      ],
      firstAcceptedAt: "2026-11-18T21:00:00.000Z",
      issuerCik: "0000320193",
      issuerName: "Example Wind Corp",
      issuerSymbol: "EXWD",
      lastAcceptedAt: "2026-11-20T21:00:00.000Z",
      persons: 3,
      shares: 3000,
      value: 450_000,
      valueIncomplete: false,
    },
  ],
  coverage: {
    incompleteDays: [],
    lastOkAt: "2026-11-23T12:00:00.000Z",
    lastRunAt: "2026-11-23T12:00:00.000Z",
    lastStatus: "ok",
    newestCompleteDay: "2026-11-20",
    overdue: false,
  },
  days: 30,
  delay: "Previous business day",
  receivedAt: "2026-11-23T15:00:00.000Z",
  source: "SEC EDGAR Form 4",
  ...overrides,
});

const sampleCongress = (
  overrides: Partial<CongressTradesFeedOutput> = {}
): CongressTradesFeedOutput => ({
  coverage: [
    {
      chamber: "house",
      lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
      lastRunAt: new Date("2026-11-23T12:00:00.000Z"),
      lastStatus: "ok",
      overdue: false,
    },
    {
      chamber: "senate",
      lastOkAt: null,
      lastRunAt: null,
      lastStatus: null,
      overdue: true,
    },
  ],
  filings: [],
  members: ["Jane Example"],
  receivedAt: new Date("2026-11-23T15:00:00.000Z"),
  source: "House Clerk and Senate eFD",
  trades: [
    {
      amends: false,
      amountHigh: 50_000,
      amountLabel: "$15,001 - $50,000",
      amountLow: 15_001,
      asset: "Example Wind Corp",
      assetType: "Stock",
      chamber: "house",
      delayDays: 12,
      docId: "20012345",
      filedOn: "2026-11-20",
      holder: "self",
      member: "Jane Example",
      rowNumber: 1,
      ticker: "EXWD",
      transactionDate: "2026-11-08",
      transactionType: "purchase",
      url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf",
    },
    {
      amends: false,
      amountHigh: 15_000,
      amountLabel: "$1,001 - $15,000",
      amountLow: 1001,
      asset: "Example Wind Corp",
      assetType: "Stock",
      chamber: "senate",
      delayDays: null,
      docId: "11111111-1111-1111-1111-111111111111",
      filedOn: "2026-11-18",
      holder: "spouse",
      member: "John Sample",
      rowNumber: 2,
      ticker: "EXWD",
      transactionDate: null,
      transactionType: "sale_partial",
      url: "javascript:alert(1)",
    },
  ],
  unparsed: {
    byReason: { layout_unknown: 0, no_transactions: 1, scanned_image: 2 },
    total: 3,
  },
  ...overrides,
});

describe("StockSmartMoneySections", () => {
  it("returns null when optional smart-money loaders are absent", async () => {
    const { container } = await render(
      <StockSmartMoneySections gateway={baseGateway()} symbol="EXWD" />
    );
    expect(container.innerHTML).toBe("");
    const { container: onlyPremium } = await render(
      <StockSmartMoneySections
        gateway={baseGateway({
          smartMoneyRanking: vi.fn(async () => sampleRanking()),
        })}
        symbol="EXWD"
      />
    );
    expect(
      onlyPremium.querySelector('[data-smart-money-block="options-premium"]')
    ).not.toBeNull();
    expect(
      onlyPremium.querySelector('[data-smart-money-block="insider-clusters"]')
    ).toBeNull();
  });

  it("renders all three smart-money sections with data, links, and https URL guard", async () => {
    const { container } = await render(
      <StockSmartMoneySections
        gateway={baseGateway({
          congressFeed: vi.fn(async () => sampleCongress()),
          insiderClusters: vi.fn(async () => sampleClusters()),
          smartMoneyRanking: vi.fn(async () => sampleRanking()),
        })}
        symbol="EXWD"
      />
    );
    expect(
      container.querySelector('[data-smart-money-block="options-premium"]')
        ?.textContent
    ).toContain("#4");
    expect(
      container.querySelector('[data-smart-money-block="insider-clusters"]')
        ?.textContent
    ).toContain("Example Wind Corp");
    const congress = container.querySelector(
      '[data-smart-money-block="congress-trades"]'
    );
    expect(congress?.textContent).toContain("Jane Example");
    expect(congress?.textContent).toContain("Purchase");
    expect(congress?.textContent).toContain("Partial sale");
    expect(congress?.textContent).not.toContain("sale_partial");
    expect(congress?.textContent).toContain("Not reported");
    expect(congress?.textContent).toContain("No link");
    expect(congress?.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(congress?.querySelector('a[href^="https://"]')).not.toBeNull();
  });

  it("renders empty states, overdue badges, and partial/null fields", async () => {
    const { container } = await render(
      <StockSmartMoneySections
        gateway={baseGateway({
          congressFeed: vi.fn(async () => sampleCongress({ trades: [] })),
          insiderClusters: vi.fn(async () =>
            sampleClusters({
              clusters: [],
              coverage: {
                incompleteDays: ["2026-11-20"],
                lastOkAt: null,
                lastRunAt: null,
                lastStatus: null,
                newestCompleteDay: null,
                overdue: true,
              },
            })
          ),
          smartMoneyRanking: vi.fn(async () =>
            sampleRanking({
              coverage: {
                capturedAt: null,
                lastAttemptAt: null,
                lastMessage: null,
                overdueSince: new Date("2026-11-23T15:00:00.000Z"),
                sessionDate: "2026-11-23",
                state: "stale",
                status: null,
              },
              rows: [],
            })
          ),
        })}
        symbol="EXWD"
      />
    );
    expect(container.textContent).toContain(
      "QuantData intraday capture overdue"
    );
    expect(container.textContent).toContain("No large options trades");
    expect(container.textContent).toContain("Form 4 index overdue");
    expect(container.textContent).toContain("No insider cluster buy");
    expect(container.textContent).toContain(
      "No Congress periodic transaction reports"
    );

    // Non-overdue with null newestCompleteDay and valueIncomplete + null issuerName
    const { container: partial } = await render(
      <StockSmartMoneySections
        gateway={baseGateway({
          insiderClusters: vi.fn(async () =>
            sampleClusters({
              clusters: [
                {
                  ...sampleClusters().clusters[0]!,
                  issuerName: null,
                  valueIncomplete: true,
                },
              ],
              coverage: {
                ...sampleClusters().coverage,
                newestCompleteDay: null,
                overdue: false,
              },
            })
          ),
        })}
        symbol="EXWD"
      />
    );
    expect(partial.textContent).toContain("Form 4 index current");
    expect(partial.textContent).toContain("CIK 0000320193");
    expect(partial.textContent).toContain("partial");
  });

  it("isolates errors per section, supports Retry, and ignores stale responses", async () => {
    const firstDeferred = deferred<SmartMoneyRankingOutput>();
    const ranking = vi
      .fn<NonNullable<OpenbbGateway["smartMoneyRanking"]>>()
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockRejectedValueOnce("raw-string-error")
      .mockResolvedValueOnce(sampleRanking());
    const insiders = vi
      .fn<NonNullable<OpenbbGateway["insiderClusters"]>>()
      .mockRejectedValue(new Error("form4 down"));
    const congress = vi
      .fn<NonNullable<OpenbbGateway["congressFeed"]>>()
      .mockRejectedValue(new Error("congress down"));

    const gw = baseGateway({
      congressFeed: congress,
      insiderClusters: insiders,
      smartMoneyRanking: ranking,
    });
    const { container, root } = await render(
      <StockSmartMoneySections gateway={gw} symbol="EXWD" />
    );
    // Rerender with new symbol before first ranking resolves -> stale first response ignored
    await act(async () => {
      root.render(<StockSmartMoneySections gateway={gw} symbol="NVDA" />);
      await flush();
    });
    await act(async () => {
      firstDeferred.resolve(sampleRanking());
      await flush();
    });
    expect(container.textContent).toContain("raw-string-error");
    expect(container.textContent).toContain("form4 down");
    expect(container.textContent).toContain("congress down");

    // Click Try again on the options premium section -> recovers
    const retryBtn = container.querySelector(
      '[data-smart-money-block="options-premium"] button'
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
      await flush();
    });
    expect(
      container.querySelector('[data-smart-money-block="options-premium"]')
        ?.textContent
    ).toContain("#4");
  });
});
