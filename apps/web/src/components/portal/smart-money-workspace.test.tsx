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
  OpenbbChanges13fOutput,
  OpenbbInsiderClustersOutput,
  OpenbbStatusOutput,
  SmartMoneyRankingOutput,
  SmartMoneyRankingRow,
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

import type { SmartMoneyGateway } from "./smart-money-client.ts";
import {
  parseSmartMoneyParams,
  type SmartMoneySettings,
} from "./smart-money-params.ts";
import {
  coverageText,
  formatNetPremium,
  formatPremium,
  historyText,
  SmartMoneyWorkspace,
  sessionsText,
} from "./smart-money-workspace.tsx";

const browserRanking = vi.hoisted(() => vi.fn());
vi.mock("./smart-money-client.ts", () => ({
  createBrowserSmartMoneyGateway: () => ({ ranking: browserRanking }),
}));

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
  return document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

type Coverage = SmartMoneyRankingOutput["coverage"];
type Session = SmartMoneyRankingOutput["sessions"][number];

// 19:45 UTC is 15:45 in New York (daylight time).
const CAPTURED = new Date("2026-10-30T19:45:00.000Z");

const row = (
  overrides: Partial<SmartMoneyRankingRow> = {}
): SmartMoneyRankingRow => ({
  bearishPremium: 450_000,
  bullishPremium: 1_650_000,
  netPremium: 1_200_000,
  premium: 2_100_000,
  rank: 1,
  sessionsPresent: 3,
  ticker: "EXWD",
  tradeCount: 12,
  volume: 4500,
  ...overrides,
});

const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({
  capturedAt: CAPTURED,
  lastAttemptAt: CAPTURED,
  lastMessage: null,
  overdueSince: null,
  sessionDate: "2026-10-30",
  state: "fresh",
  status: "partial",
  ...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  capturedAt: CAPTURED,
  sessionDate: "2026-10-30",
  status: "partial",
  ...overrides,
});

const rankingOf = (
  rows: SmartMoneyRankingRow[],
  overrides: Partial<SmartMoneyRankingOutput> = {}
): SmartMoneyRankingOutput => ({
  capturedAt: CAPTURED,
  coverage: coverage(),
  delay: "Intraday, about 15 minutes behind",
  history: {
    from: "2025-09-25",
    noData: 8,
    pending: 20,
    stored: 1312,
    weekdays: 1340,
  },
  receivedAt: new Date("2026-10-30T19:50:00.000Z"),
  rows,
  sessions: [session()],
  source: "Demo options ledger",
  totals: {
    bearishPremium: 450_000,
    bullishPremium: 1_650_000,
    netPremium: 1_200_000,
    premium: 2_100_000,
    tickers: 7,
  },
  ...overrides,
});

const sample = rankingOf([
  row(),
  row({
    bearishPremium: 2_000_000,
    bullishPremium: 0,
    netPremium: -2_000_000,
    premium: 2_000_000,
    rank: 2,
    sessionsPresent: 1,
    ticker: "BRK.B",
    tradeCount: 1,
    volume: 900,
  }),
]);

const defaults: SmartMoneySettings = {
  sessions: 1,
  sort: "net_bullish",
  ticker: "",
};

const render = async (
  gateway: SmartMoneyGateway,
  initial?: SmartMoneySettings
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      initial === undefined ? (
        <SmartMoneyWorkspace gateway={gateway} />
      ) : (
        <SmartMoneyWorkspace gateway={gateway} initial={initial} />
      )
    );
    return await flush();
  });
  return container;
};

const kpi = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-kpi="${id}"]`)?.textContent;

const status = (container: HTMLElement) =>
  container
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace(/^Status:/u, "");

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name
  ) as HTMLButtonElement;

const press = async (element: HTMLElement) =>
  await act(async () => {
    element.click();
    return await flush();
  });

const choose = async (select: HTMLSelectElement, value: string) =>
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value"
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return await flush();
  });

const selects = (container: HTMLElement) =>
  [...container.querySelectorAll("select")] as [
    HTMLSelectElement,
    HTMLSelectElement,
  ];

const typeTicker = async (container: HTMLElement, value: string) =>
  await act(async () => {
    const input = container.querySelector("input") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (input.form as HTMLFormElement).requestSubmit();
    return await flush();
  });

const headers = (container: HTMLElement) =>
  [...container.querySelectorAll("thead th")].map((cell) => cell.textContent);

const tableRows = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr")].map((tableRow) =>
    [...tableRow.children].map((cell) => cell.textContent)
  );

const coverageLine = (container: HTMLElement) =>
  container.querySelector('[aria-label="Data coverage"]')?.textContent;

describe("smart money workspace", () => {
  it("shows coverage, history, totals and the ranked tickers", async () => {
    const ranking = vi.fn(async () => sample);
    const container = await render({ ranking });
    expect(ranking).toHaveBeenCalledWith(defaults);
    expect(container.querySelector("h1")?.textContent).toBe("Smart money");
    expect(status(container)).toBe("7 tickers");
    expect(
      container.querySelector('a[href="/insider-clusters"]')?.textContent
    ).toBe("Insider cluster buys (SEC Form 4)");
    expect(coverageLine(container)).toContain(
      "QuantData, intraday · captured 15:45 ET · session partial"
    );
    expect(container.textContent).toContain("Session 2026-10-30, partial");
    expect(container.textContent).toContain(
      "History: 1,312 of 1,340 weekdays stored, 8 without data, 20 pending"
    );
    expect(kpi(container, "tickers")).toContain("7");
    expect(kpi(container, "bullish")).toContain("$1.7M");
    expect(kpi(container, "bearish")).toContain("$450K");
    expect(kpi(container, "net")).toContain("+$1.2M");
    expect(container.textContent).toContain(
      "Top 2 of 7 tickers, sorted by net bullish"
    );
    expect(headers(container)).toEqual([
      "Rank",
      "Ticker",
      "Bullish",
      "Bearish",
      "Net",
      "Total",
      "Trades",
      "Volume",
    ]);
    expect(tableRows(container)).toEqual([
      ["1", "EXWD", "$1.7M", "$450K", "+$1.2M", "$2.1M", "12", "4,500"],
      ["2", "BRK.B", "$0", "$2M", "-$2M", "$2M", "1", "900"],
    ]);
    const link = container.querySelector("tbody a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/stock/EXWD");
    expect(link.getAttribute("aria-label")).toBe("Open EXWD stock page");
    return expect(container.textContent).toContain(
      "Source: Demo options ledger · Delay: Intraday, about 15 minutes behind · Read 15:50 ET"
    );
  });

  it("adds the sessions column and the summed range over several sessions", async () => {
    const ranking = vi.fn(async () =>
      rankingOf([row({ ticker: "^VIX" })], {
        coverage: coverage({
          overdueSince: new Date(CAPTURED.getTime() + 30 * 60_000),
          state: "stale",
        }),
        sessions: [
          session(),
          session({ sessionDate: "2026-10-29", status: "complete" }),
          session({ sessionDate: "2026-10-28", status: "complete" }),
        ],
        totals: { ...sample.totals, tickers: 1 },
      })
    );
    const container = await render(
      { ranking },
      parseSmartMoneyParams({ sessions: "5", sort: "total" })
    );
    expect(ranking).toHaveBeenCalledWith({
      ...defaults,
      sessions: 5,
      sort: "total",
    });
    expect(status(container)).toBe("1 ticker");
    expect(headers(container).at(-1)).toBe("Sessions");
    expect(tableRows(container)[0]?.at(-1)).toBe("3");
    expect(container.querySelector("tbody a")?.getAttribute("href")).toBe(
      "/stock/%5EVIX"
    );
    expect(container.textContent).toContain(
      "3 of 5 sessions: 2026-10-28 to 2026-10-30, newest partial"
    );
    expect(container.textContent).toContain(
      "Top 1 of 1 ticker, sorted by total premium"
    );
    expect(
      container.querySelector(
        '[aria-label="Data coverage"] [data-status="warning"]'
      )?.textContent
    ).toContain("Today's capture is overdue since 16:15 ET");
    return expect(kpi(container, "bullish")).toContain(
      "Over the newest 5 sessions"
    );
  });

  it("shows the empty states", async () => {
    const empty = rankingOf([], {
      capturedAt: null,
      coverage: coverage({
        capturedAt: null,
        lastAttemptAt: null,
        state: "never",
        status: null,
      }),
      sessions: [],
      totals: {
        bearishPremium: 0,
        bullishPremium: 0,
        netPremium: 0,
        premium: 0,
        tickers: 0,
      },
    });
    const container = await render({ ranking: async () => empty });
    expect(status(container)).toBe("0 tickers");
    expect(
      container.querySelector(
        '[aria-label="Data coverage"] [data-status="neutral"]'
      )?.textContent
    ).toBe("Status:No capture yet today");
    expect(container.textContent).toContain("No session stored yet");
    expect(kpi(container, "net")).toContain("$0");
    expect(container.textContent).toContain(
      "No large-trade premium stored yet."
    );
    await typeTicker(container, "exwd");
    return expect(container.textContent).toContain(
      "No large-trade premium stored for EXWD in the newest 1 session."
    );
  });

  it("sends each filter to the server and keeps the URL in sync", async () => {
    window.history.replaceState(null, "", "/smart-money?theme=dark");
    const ranking = vi.fn(async () => sample);
    const container = await render({ ranking });
    const [sessions, sort] = selects(container);
    expect([...sessions.options].map((option) => option.textContent)).toEqual([
      "1 session",
      "5 sessions",
      "20 sessions",
    ]);
    expect([...sort.options].map((option) => option.textContent)).toEqual([
      "Net bullish",
      "Net bearish",
      "Total premium",
    ]);
    await choose(sessions, "20");
    expect(ranking).toHaveBeenLastCalledWith({ ...defaults, sessions: 20 });
    await choose(sort, "net_bearish");
    expect(ranking).toHaveBeenLastCalledWith({
      ...defaults,
      sessions: 20,
      sort: "net_bearish",
    });
    await typeTicker(container, " exwd ");
    expect(ranking).toHaveBeenLastCalledWith({
      sessions: 20,
      sort: "net_bearish",
      ticker: "EXWD",
    });
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      "EXWD"
    );
    const calls = ranking.mock.calls.length;
    await typeTicker(container, "exwd");
    expect(ranking).toHaveBeenCalledTimes(calls);
    expect(window.location.search).toBe(
      "?theme=dark&sessions=20&sort=net_bearish&ticker=EXWD"
    );
    await typeTicker(container, "bad ticker");
    expect(ranking).toHaveBeenLastCalledWith({
      sessions: 20,
      sort: "net_bearish",
      ticker: "",
    });
    return expect(window.location.search).toBe(
      "?theme=dark&sessions=20&sort=net_bearish"
    );
  });

  it("shows a load failure and retries; refresh reloads", async () => {
    const ranking = vi
      .fn<SmartMoneyGateway["ranking"]>()
      .mockRejectedValueOnce(new Error("Database not configured"))
      .mockResolvedValue(sample);
    const container = await render({ ranking });
    expect(status(container)).toBe("Load failed");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Ranking not loaded: Database not configured"
    );
    await press(buttonNamed(container, "Try again"));
    expect(status(container)).toBe("7 tickers");
    await press(buttonNamed(container, "Refresh"));
    return expect(ranking).toHaveBeenCalledTimes(3);
  });

  it("ignores a slower, older response", async () => {
    // Promise.withResolvers is outside the ES2023 lib of this package.
    let resolveFirst: (value: SmartMoneyRankingOutput) => void = () =>
      undefined;
    const ranking = vi
      .fn<SmartMoneyGateway["ranking"]>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockResolvedValue(
        rankingOf([], { totals: { ...sample.totals, tickers: 0 } })
      );
    const container = await render({ ranking });
    expect(container.textContent).toContain("Loading ranking…");
    expect(status(container)).toBe("Loading");
    await choose(selects(container)[0], "5");
    expect(status(container)).toBe("0 tickers");
    await act(async () => {
      resolveFirst(sample);
      return await flush();
    });
    return expect(status(container)).toBe("0 tickers");
  });

  return it("uses the browser gateway when none is supplied", async () => {
    browserRanking.mockResolvedValue(sample);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<SmartMoneyWorkspace />);
      return await flush();
    });
    expect(browserRanking).toHaveBeenCalledWith(defaults);
    return expect(status(container)).toBe("7 tickers");
  });
});

describe("smart money text", () => {
  it("formats premium as compact US dollars, net with a sign", () => {
    expect(formatPremium(1_234_567)).toBe("$1.2M");
    expect(formatPremium(3_400_000_000)).toBe("$3.4B");
    expect(formatNetPremium(1_234_567)).toBe("+$1.2M");
    expect(formatNetPremium(-450_000)).toBe("-$450K");
    return expect(formatNetPremium(0)).toBe("$0");
  });

  it("describes each coverage state", () => {
    const text = (
      overrides: Partial<Coverage>,
      sessions: readonly Session[] = []
    ) =>
      coverageText({ coverage: coverage(overrides), sessions: [...sessions] });
    expect(text({ status: null })).toBe(
      "QuantData, intraday · captured 15:45 ET"
    );
    expect(text({ status: "complete" })).toBe(
      "QuantData, intraday · captured 15:45 ET · session complete"
    );
    expect(text({ capturedAt: null, state: "fresh" })).toBe(
      "No capture yet today"
    );
    expect(
      text({
        capturedAt: null,
        lastMessage: "QuantData answered 502",
        overdueSince: new Date(CAPTURED.getTime() - 345 * 60_000),
        state: "stale",
      })
    ).toBe(
      "Today's capture is overdue since 10:00 ET · last attempt 15:45 ET: QuantData answered 502"
    );
    expect(
      text({
        lastMessage: "Timed out",
        overdueSince: new Date(CAPTURED.getTime() + 30 * 60_000),
        state: "stale",
      })
    ).toBe(
      "Today's capture is overdue since 16:15 ET · last capture 15:45 ET · last attempt 15:45 ET: Timed out"
    );
    expect(text({ lastAttemptAt: null, state: "stale" })).toBe(
      "Today's capture is overdue · last capture 15:45 ET"
    );
    expect(
      text({
        capturedAt: null,
        lastAttemptAt: null,
        lastMessage: "Not run yet",
        state: "never",
      })
    ).toBe("No capture yet today");
    expect(text({ state: "closed" })).toBe(
      "QuantData · market closed · nothing stored yet"
    );
    return expect(
      text({ state: "closed" }, [
        session({
          capturedAt: new Date("2026-10-31T13:05:00.000Z"),
          sessionDate: "2026-10-30",
          status: "complete",
        }),
      ])
    ).toBe(
      "QuantData · market closed · newest session 2026-10-30 · captured 2026-10-31 09:05 ET · session complete"
    );
  });

  it("names the summed sessions", () => {
    expect(sessionsText([], 5)).toBe("No session stored yet");
    expect(sessionsText([session({ status: "complete" })], 1)).toBe(
      "Session 2026-10-30, complete"
    );
    expect(sessionsText([session({ status: "complete" })], 20)).toBe(
      "1 of 20 sessions: 2026-10-30"
    );
    return expect(
      sessionsText(
        [
          session({ status: "complete" }),
          session({ sessionDate: "2026-10-29", status: "complete" }),
        ],
        5
      )
    ).toBe("2 of 5 sessions: 2026-10-29 to 2026-10-30");
  });

  it("counts the history", () =>
    expect(
      historyText({
        from: "2025-09-25",
        noData: 0,
        pending: 3,
        stored: 2,
        weekdays: 5,
      })
    ).toBe("History: 2 of 5 weekdays stored, 0 without data, 3 pending"));
});

describe("SmartMoneyWorkspace unified multi-source panels and freshness strip", () => {
  const sampleStatus = (overdue = false): OpenbbStatusOutput => ({
    checkedAt: new Date("2026-11-23T16:00:00.000Z"),
    overdueCount: overdue ? 2 : 0,
    runs: [],
    sources: [
      {
        kind: "flow",
        label: "Large options premium (QuantData)",
        lastOkAt: new Date("2026-11-23T15:50:00.000Z"),
        lastRunAt: new Date("2026-11-23T15:50:00.000Z"),
        lastStatus: "partial",
        maxAgeSeconds: 1800,
        overdue,
        overdueSince: overdue ? new Date("2026-11-23T15:30:00.000Z") : null,
        reason: overdue ? "stale" : null,
        retired: false,
        smartMoney: true,
        source: "market_premium",
      },
      {
        kind: "openbb",
        label: "SEC Form 4",
        lastOkAt: null,
        lastRunAt: null,
        lastStatus: null,
        maxAgeSeconds: 108_000,
        overdue,
        overdueSince: null,
        reason: overdue ? "no usable run" : null,
        retired: false,
        smartMoney: true,
        source: "sec-form4",
      },
      {
        kind: "openbb",
        label: "Congress (House)",
        lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
        lastRunAt: new Date("2026-11-23T12:00:00.000Z"),
        lastStatus: "ok",
        maxAgeSeconds: 108_000,
        overdue: false,
        overdueSince: null,
        reason: null,
        retired: false,
        smartMoney: true,
        source: "congress-house",
      },
    ],
    tables: [],
  });

  const sampleInsiders = (
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
      {
        filings: [],
        firstAcceptedAt: "2026-11-18T21:00:00.000Z",
        issuerCik: "0000999999",
        issuerName: null,
        issuerSymbol: null,
        lastAcceptedAt: "2026-11-20T21:00:00.000Z",
        persons: 4,
        shares: 5000,
        value: 200_000,
        valueIncomplete: true,
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
    days: 7,
    delay: "Previous business day",
    receivedAt: "2026-11-23T15:00:00.000Z",
    source: "SEC Form 4",
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
        delayDays: 10,
        docId: "20012345",
        filedOn: "2026-11-20",
        holder: "self",
        member: "Jane Example",
        rowNumber: 1,
        ticker: "EXWD",
        transactionDate: "2026-11-10",
        transactionType: "purchase",
        url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf",
      },
      {
        amends: false,
        amountHigh: 15_000,
        amountLabel: "$1,001 - $15,000",
        amountLow: 1001,
        asset: "Other Bond",
        assetType: "Bond",
        chamber: "senate",
        delayDays: null,
        docId: "11111111-1111-1111-1111-111111111111",
        filedOn: "2026-11-19",
        holder: "spouse",
        member: "John Sample",
        rowNumber: 2,
        ticker: null,
        transactionDate: null,
        transactionType: "sale",
        url: "javascript:alert(1)",
      },
    ],
    unparsed: {
      byReason: { layout_unknown: 0, no_transactions: 1, scanned_image: 1 },
      total: 2,
    },
    ...overrides,
  });

  const sample13f = (
    overrides: Partial<OpenbbChanges13fOutput> = {}
  ): OpenbbChanges13fOutput => ({
    changes: [
      {
        accessionNumber: "0001193125-26-000001",
        change: "new",
        cusip: "037833100",
        delayDays: 42,
        filedOn: "2026-11-11",
        filerCik: "1067983",
        filerName: "Example Fund LP",
        issuer: "Example Wind Corp",
        optionType: "",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: null,
        previousValue: null,
        shares: 5000,
        symbol: "EXWD",
        value: 1_000_000,
      },
      {
        accessionNumber: "0001193125-26-000002",
        change: "sold",
        cusip: "999999100",
        delayDays: 41,
        filedOn: "2026-11-10",
        filerCik: "1350694",
        filerName: "Second Fund LP",
        issuer: "Private Trust",
        optionType: "call",
        period: "2026-09-30",
        previousPeriod: "2026-06-30",
        previousShares: 2000,
        previousValue: 400_000,
        shares: null,
        symbol: null,
        value: null,
      },
    ],
    coverage: {
      filersWithTwoBooks: 12,
      lastOkAt: "2026-11-23T12:00:00.000Z",
      lastRunAt: "2026-11-23T12:00:00.000Z",
      lastStatus: "ok",
      overdue: false,
      overdueSince: null,
      totalFilers: 23,
    },
    delay: "SEC Form 13F-HR, due 45 days after quarter end",
    receivedAt: "2026-11-23T15:00:00.000Z",
    source: "SEC Form 13F-HR",
    ...overrides,
  });

  const mountFull = async (
    gateway: SmartMoneyGateway,
    initial?: Partial<SmartMoneySettings>
  ) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <SmartMoneyWorkspace
          gateway={gateway}
          {...(initial === undefined
            ? {}
            : { initial: parseSmartMoneyParams({ ticker: initial.ticker }) })}
        />
      );
      await flush();
    });
    return container;
  };

  it("renders freshness strip, all 4 source panels, Congress Purchases/All toggle, and Refresh", async () => {
    const gw: SmartMoneyGateway = {
      changes13f: vi.fn(async () => sample13f()),
      congressFeed: vi.fn(async () => sampleCongress()),
      insiderClusters: vi.fn(async () => sampleInsiders()),
      ranking: vi.fn(async () => rankingOf([row()])),
      status: vi.fn(async () => sampleStatus(true)),
    };
    const container = await mountFull(gw);
    expect(container.textContent).toContain("overdue since");
    expect(container.textContent).toContain("overdue (no usable run yet)");
    expect(container.textContent).toContain("Congress (House): current");
    expect(container.textContent).toContain("Example Wind Corp");
    expect(container.textContent).toContain("CIK 0000999999");
    expect(container.textContent).toContain("Example Fund LP");
    expect(container.textContent).toContain("Second Fund LP");
    expect(container.textContent).toContain("No ticker");

    // Default Congress filter is Purchases only (Jane Example shown, John Sample sale hidden)
    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("John Sample");

    // Switch to All trades -> John Sample appears with safe No link guard
    const allBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "All trades"
    ) as HTMLButtonElement;
    await act(async () => {
      allBtn.click();
      await flush();
    });
    expect(container.textContent).toContain("John Sample");
    expect(container.textContent).toContain("No link");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();

    // Switch back to Purchases
    const purchBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Purchases"
    ) as HTMLButtonElement;
    await act(async () => {
      purchBtn.click();
      await flush();
    });
    expect(container.textContent).not.toContain("John Sample");

    // Refresh reloads all 5 loaders
    const refreshBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Refresh")
    ) as HTMLButtonElement;
    await act(async () => {
      refreshBtn.click();
      await flush();
    });
    expect(gw.status).toHaveBeenCalledTimes(2);
    expect(gw.insiderClusters).toHaveBeenCalledTimes(2);
    expect(gw.congressFeed).toHaveBeenCalledTimes(2);
    expect(gw.changes13f).toHaveBeenCalledTimes(2);
  });

  it("renders empty states (all and ticker-filtered), overdue badges, and isolated errors with retry", async () => {
    const emptyGw: SmartMoneyGateway = {
      changes13f: vi.fn(async () =>
        sample13f({
          changes: [],
          coverage: { ...sample13f().coverage, overdue: true },
        })
      ),
      congressFeed: vi.fn(async () => sampleCongress({ trades: [] })),
      insiderClusters: vi.fn(async () =>
        sampleInsiders({
          clusters: [],
          coverage: {
            ...sampleInsiders().coverage,
            newestCompleteDay: null,
            overdue: true,
          },
        })
      ),
      ranking: vi.fn(async () => rankingOf([])),
      status: vi.fn(async () => ({ ...sampleStatus(false), sources: [] })),
    };
    const emptyAll = await mountFull(emptyGw);
    expect(emptyAll.textContent).toContain(
      "No insider cluster buys in the last 7 days."
    );
    expect(emptyAll.textContent).toContain(
      "No Congress purchases filed in the last 30 days."
    );
    expect(emptyAll.textContent).toContain(
      "No 13F quarter-over-quarter changes stored"
    );
    expect(emptyAll.textContent).toContain("SEC 13F: overdue");
    expect(emptyAll.textContent).toContain("Form 4 index overdue");

    // Toggle All trades on empty Congress panel
    const allEmpty = Array.from(emptyAll.querySelectorAll("button")).find(
      (b) => b.textContent === "All trades"
    ) as HTMLButtonElement;
    await act(async () => {
      allEmpty.click();
      await flush();
    });
    expect(emptyAll.textContent).toContain(
      "No Congress trades filed in the last 30 days."
    );

    // Ticker-filtered empty states + non-overdue null newestCompleteDay
    const emptyTicker = await mountFull(
      {
        ...emptyGw,
        insiderClusters: vi.fn(async () =>
          sampleInsiders({
            clusters: [],
            coverage: {
              ...sampleInsiders().coverage,
              newestCompleteDay: null,
              overdue: false,
            },
          })
        ),
      },
      { ticker: "EXWD" }
    );
    expect(emptyTicker.textContent).toContain("Form 4 index current");
    expect(emptyTicker.textContent).toContain(
      "No insider cluster buys for EXWD"
    );
    expect(emptyTicker.textContent).toContain("No Congress purchases for EXWD");
    expect(emptyTicker.textContent).toContain(
      "No tracked 13F quarter-over-quarter changes for EXWD"
    );
    const allTickerEmpty = Array.from(
      emptyTicker.querySelectorAll("button")
    ).find((b) => b.textContent === "All trades") as HTMLButtonElement;
    await act(async () => {
      allTickerEmpty.click();
      await flush();
    });
    expect(emptyTicker.textContent).toContain("No Congress trades for EXWD");

    // Isolated errors + Retry on all 4 optional loaders
    const errGw: SmartMoneyGateway = {
      changes13f: vi
        .fn<NonNullable<SmartMoneyGateway["changes13f"]>>()
        .mockRejectedValueOnce(new Error("13f boom"))
        .mockResolvedValueOnce(sample13f()),
      congressFeed: vi
        .fn<NonNullable<SmartMoneyGateway["congressFeed"]>>()
        .mockRejectedValueOnce(new Error("congress boom"))
        .mockResolvedValueOnce(sampleCongress()),
      insiderClusters: vi
        .fn<NonNullable<SmartMoneyGateway["insiderClusters"]>>()
        .mockRejectedValueOnce(new Error("insiders boom"))
        .mockResolvedValueOnce(sampleInsiders()),
      ranking: vi.fn(async () => rankingOf([row()])),
      status: vi.fn(async () => {
        throw new Error("status boom");
      }),
    };
    const errored = await mountFull(errGw);
    expect(errored.textContent).toContain("status boom");
    expect(errored.textContent).toContain("insiders boom");
    expect(errored.textContent).toContain("congress boom");
    expect(errored.textContent).toContain("13f boom");
    const retries = Array.from(errored.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Try again")
    );
    expect(retries).toHaveLength(3);
    for (const btn of retries) {
      await act(async () => {
        btn.click();
        await flush();
      });
    }
    expect(errored.textContent).toContain("Example Fund LP");
    expect(errored.textContent).toContain("Jane Example");
  });

  it("ignores stale section responses when refreshed before completion", async () => {
    const first = deferred<OpenbbStatusOutput>();
    const second = deferred<OpenbbStatusOutput>();
    const status = vi
      .fn<NonNullable<SmartMoneyGateway["status"]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const container = await mountFull({
      ranking: vi.fn(async () => rankingOf([row()])),
      status,
    });
    expect(container.textContent).toContain("Checking per-source freshness");
    const refreshBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Refresh")
    ) as HTMLButtonElement;
    await act(async () => {
      refreshBtn.click();
      await flush();
    });
    await act(async () => {
      second.resolve(sampleStatus(false));
      await flush();
    });
    await act(async () => {
      first.resolve(sampleStatus(true));
      await flush();
    });
    expect(container.textContent).not.toContain("overdue since");
  });
});
