// @vitest-environment jsdom

import type {
  MarketNewsHours,
  MarketNewsTicker,
  MarketNewsWatchlistOutput,
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

import type { MarketNewsGateway } from "./market-news-client.ts";

const browser = vi.hoisted(() => ({
  watchlist: vi.fn(async () => ({
    receivedAt: new Date("2026-10-14T00:00:00.000Z"),
    tickers: [],
  })),
}));
vi.mock("./market-news-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-news-client.ts")>()),
  createBrowserMarketNewsGateway: () => browser,
}));

import {
  formatNewsTime,
  HEADLINE_PREVIEW_COUNT,
  MARKET_NEWS_TAG_LABELS,
  MarketNewsWorkspace,
  parseNewsDays,
} from "./market-news-workspace.tsx";

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

const receivedAt = new Date("2026-10-14T00:00:00.000Z");

const aapl: MarketNewsTicker = {
  errors: [],
  filings: [
    {
      filedAt: new Date("2026-10-12T20:30:28.000Z"),
      form: "8-K",
      important: true,
      items: [
        { code: "2.02", label: "earnings results" },
        { code: "9.01", label: "exhibits" },
      ],
      title: "Apple Inc. filed a 8-K: earnings results",
      url: "https://www.sec.gov/Archives/a-index.htm",
    },
    {
      filedAt: new Date("2026-10-11T20:30:28.000Z"),
      form: "8-K",
      important: false,
      items: [],
      title: "Apple Inc. filed a 8-K",
      url: "https://www.sec.gov/Archives/b-index.htm",
    },
  ],
  headlines: [
    {
      publishedAt: new Date("2026-10-13T20:36:44.000Z"),
      publisher: "Reuters",
      source: "yahoo",
      tags: ["legal", "deal"],
      title: "Judge orders OpenAI to turn over hiring records",
      url: "https://finance.yahoo.com/news/judge.html",
    },
    {
      publishedAt: new Date("2026-10-13T19:46:52.000Z"),
      publisher: null,
      source: "yahoo",
      tags: [],
      title: "Apple may have a way to dominate the smart home space",
      url: "https://finance.yahoo.com/video/home.html",
    },
  ],
  symbol: "AAPL",
};

const spy: MarketNewsTicker = {
  errors: [
    "headlines: Yahoo headlines returned HTTP 429",
    "filings: no SEC filer matches this symbol",
  ],
  filings: [],
  headlines: [],
  symbol: "SPY",
};

const news = (tickers: MarketNewsTicker[]): MarketNewsWatchlistOutput => ({
  receivedAt,
  tickers,
});

const render = async (gateway?: MarketNewsGateway, initialDays?: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <MarketNewsWorkspace
        {...(gateway === undefined ? {} : { gateway })}
        {...(initialDays === undefined ? {} : { initialDays })}
      />
    );
    await flush();
  });
  return container;
};

/** Heading of the first symbol panel. */
const firstSymbol = (container: HTMLElement) =>
  container.querySelector("[data-news-symbol] h3")?.textContent;

/** Header chip text without StatusBadge's screen-reader "Status:" prefix. */
const chipTone = (container: HTMLElement) =>
  container.querySelector('[data-slot="page-status"] [data-slot="badge"]')
    ?.className;

const chip = (container: HTMLElement) =>
  container
    .querySelector('[data-slot="page-status"]')
    ?.textContent?.replace(/^Status:\s*/u, "");

const choose = async (container: HTMLElement, hours: MarketNewsHours) => {
  const select = container.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    select.value = String(hours);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
};

const click = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(label)
  );
  await act(async () => {
    button?.click();
    await flush();
  });
};

describe("news monitor workspace", () => {
  it("renders one section per ticker with filings, headlines and tag chips", async () => {
    const watchlist = vi.fn(async () => news([aapl, spy]));
    const container = await render({ watchlist });
    expect(watchlist).toHaveBeenCalledWith(72);
    expect(container.querySelector("h1")?.textContent).toBe("News monitor");
    expect(chip(container)).toBe("2 symbols watched");
    // SPY's failed sources turn the chip amber.
    expect(chipTone(container)).toContain("text-warning-foreground");
    const kpi = (name: string) =>
      container.querySelector(`[data-kpi="${name}"]`)?.textContent;
    expect(kpi("symbols")).toBe("Symbols21 with source gaps");
    expect(kpi("headlines")).toBe("Headlines2In the last 3 days");
    expect(kpi("filings")).toBe("8-K filings21 important");
    const sections = container.querySelectorAll("[data-news-symbol]");
    expect(
      [...sections].map((section) => section.querySelector("h3")?.textContent)
    ).toEqual(["AAPL", "SPY"]);
    expect(
      sections[0]
        ?.querySelector('h3 a[data-slot="ticker-link"]')
        ?.getAttribute("href")
    ).toBe("/stock/AAPL");
    const first = sections[0] as HTMLElement;
    expect(first.textContent).toContain("2 headlines · 2 8-K (1 important)");
    const important = first.querySelector('[data-important="true"]');
    expect(important?.textContent).toContain("Important");
    expect(important?.textContent).toContain(
      "Items: 2.02 earnings results, 9.01 exhibits"
    );
    expect(first.querySelectorAll('[data-important="false"]')).toHaveLength(1);
    expect(first.textContent).toContain("2026-10-13 20:36 UTC");
    expect(first.textContent).toContain("Reuters");
    expect(first.textContent).toContain(MARKET_NEWS_TAG_LABELS.legal);
    expect(first.textContent).toContain(MARKET_NEWS_TAG_LABELS.deal);
    const links = [...container.querySelectorAll("a[target]")];
    // Two filings, two headlines and the Earnings dates link to AAPL's 2.02 filing.
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    const second = sections[1] as HTMLElement;
    expect(second.textContent).toContain("0 headlines · 0 8-K");
    // A failed source says so instead of claiming there was no news.
    expect(second.textContent).toContain(
      "8-K filings unavailable: no SEC filer matches this symbol"
    );
    expect(second.textContent).toContain(
      "Headlines unavailable: Yahoo headlines returned HTTP 429"
    );
    expect(second.textContent).not.toContain("No 8-K filings");
    expect(second.textContent).not.toContain("No headlines");
    expect(second.textContent).not.toContain("Source gaps");
    return expect(container.textContent).toContain(
      `Updated ${formatNewsTime(receivedAt)}.`
    );
  });

  it("lists the latest 8-K item 2.02 filing date per symbol under Earnings dates", async () => {
    const msft: MarketNewsTicker = {
      errors: [],
      filings: [
        {
          filedAt: new Date("2026-10-10T12:00:00.000Z"),
          form: "8-K",
          important: true,
          items: [{ code: "5.02", label: "officer change" }],
          title: "Microsoft filed a 8-K: officer change",
          url: "https://www.sec.gov/Archives/m-index.htm",
        },
      ],
      headlines: [],
      symbol: "MSFT",
    };
    const container = await render({
      watchlist: async () => news([aapl, msft, spy]),
    });
    const panel = container.querySelector(
      '[aria-labelledby="news-earnings-dates"]'
    );
    expect(panel?.querySelector("h2")?.textContent).toBe("Earnings dates");
    expect(panel?.textContent).toContain(
      "Latest SEC 8-K item 2.02 (earnings results) filing per symbol in the last 3 days."
    );
    expect(panel?.querySelector('a[href="/calendar"]')?.textContent).toBe(
      "Open calendar"
    );
    const row = (symbol: string) =>
      panel?.querySelector(`[data-earnings-symbol="${symbol}"]`);
    const filed = row("AAPL")?.querySelector('a[target="_blank"]');
    expect(filed?.getAttribute("href")).toBe(
      "https://www.sec.gov/Archives/a-index.htm"
    );
    expect(filed?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(filed?.textContent).toBe(
      "Filed 2026-10-12 20:30 UTC (opens SEC filing)"
    );
    expect(row("MSFT")?.textContent).toBe(
      "MSFTNo earnings filing in the last 3 days"
    );
    // A failed SEC source is not reported as "no earnings".
    expect(row("SPY")?.textContent).toBe("SPYSEC filings unavailable");
  });

  it("links to the watchlist when it is empty, via the browser gateway by default", async () => {
    const container = await render();
    expect(browser.watchlist).toHaveBeenCalledWith(72);
    expect(container.textContent).toContain("Your watchlist is empty");
    expect(chip(container)).toBe("No symbols");
    expect(container.querySelector("[data-kpi]")).toBeNull();
    return expect(
      container.querySelector('a[href="/watchlist"]')?.textContent
    ).toBe("Open watchlist");
  });

  it("shows the newest 5 headlines with a toggle for the rest", async () => {
    const many: MarketNewsTicker = {
      ...aapl,
      errors: ["quotes: ignored source"],
      headlines: Array.from({ length: 7 }, (_, index) => ({
        publishedAt: new Date(Date.UTC(2026, 9, 13, 20 - index)),
        publisher: null,
        source: "yahoo",
        tags: [],
        title: `Headline ${index + 1}`,
        url: `https://finance.yahoo.com/news/${index + 1}.html`,
      })),
      symbol: "TSLA",
    };
    const container = await render({
      watchlist: vi.fn(async () => news([many])),
    });
    const items = () =>
      [...container.querySelectorAll("li")]
        .map((item) => item.textContent ?? "")
        .filter((text) => text.startsWith("Headline"));
    expect(items()).toHaveLength(HEADLINE_PREVIEW_COUNT);
    expect(container.textContent).toContain("7 headlines");
    expect(container.textContent).toContain(
      "Source gaps: quotes: ignored source"
    );
    const toggle = () =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Show")
      );
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    await click(container, "Show all 7 headlines");
    expect(items()).toHaveLength(7);
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    await click(container, "Show the newest 5 only");
    return expect(items()).toHaveLength(HEADLINE_PREVIEW_COUNT);
  });

  it("labels each headline with its source and lists every failed headline source", async () => {
    const merged: MarketNewsTicker = {
      errors: [
        "headlines: Seeking Alpha headlines returned HTTP 503",
        "headlines: Reuters headlines: not an RSS 2.0 document",
      ],
      filings: [],
      headlines: [
        {
          publishedAt: new Date("2026-10-13T22:00:00.000Z"),
          publisher: "Dow Jones Newsletters",
          source: "ibkr",
          tags: ["executive"],
          title: "Coca-Cola names new CFO",
          url: null,
        },
        {
          publishedAt: new Date("2026-10-13T21:05:00.000Z"),
          publisher: "Reuters",
          source: "reuters",
          tags: [],
          title: "Coca-Cola beats quarterly profit estimates",
          url: "https://news.google.com/rss/articles/CBMiKO1?oc=5",
        },
        {
          publishedAt: new Date("2026-10-13T18:50:00.000Z"),
          publisher: "Dividend Desk",
          source: "seekingalpha",
          tags: [],
          title: "Coca-Cola Has Raised Dividends for 63 Years",
          url: "https://seekingalpha.com/article/2-coca-cola-dividends",
        },
        {
          publishedAt: new Date("2026-10-13T12:40:02.000Z"),
          publisher: null,
          source: "yahoo",
          tags: [],
          title: "Is Coca-Cola (KO) Stock Outpacing Its Peers?",
          url: "https://finance.yahoo.com/news/ko.html",
        },
      ],
      symbol: "KO",
    };
    const container = await render({
      watchlist: vi.fn(async () => news([merged])),
    });
    const labels = [...container.querySelectorAll("[data-news-source]")];
    expect(labels.map((label) => label.textContent)).toEqual([
      "IBKR",
      "Reuters",
      "Seeking Alpha",
      "Yahoo Finance",
    ]);
    expect(
      labels.map((label) => label.getAttribute("data-news-source"))
    ).toEqual(["ibkr", "reuters", "seekingalpha", "yahoo"]);
    // Theme tokens only, so the label reads in light and dark mode.
    expect(labels[0]?.className).toContain("text-foreground");
    const rows = labels.map((label) => label.closest("li"));
    // IBKR headlines have no public link: plain text, not an anchor.
    expect(rows[0]?.querySelector("a")).toBeNull();
    expect(rows[0]?.textContent).toContain("Coca-Cola names new CFO");
    expect(rows[0]?.textContent).toContain("Dow Jones Newsletters");
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://news.google.com/rss/articles/CBMiKO1?oc=5"
    );
    // A publisher equal to the source label is not repeated.
    expect(rows[1]?.textContent?.match(/Reuters/gu)).toHaveLength(1);
    expect(rows[2]?.textContent).toContain("Dividend Desk");
    // Other sources answered, so the failure is partial.
    expect(container.textContent).not.toContain("Headlines unavailable");
    expect(container.textContent).toContain(
      "Headlines from IBKR, Reuters, Seeking Alpha and Yahoo Finance"
    );
    return expect(container.textContent).toContain(
      "Some sources failed: Seeking Alpha headlines returned HTTP 503; Reuters headlines: not an RSS 2.0 document"
    );
  });

  it("reloads for a new window and on refresh", async () => {
    const watchlist = vi.fn(async (hours: MarketNewsHours) =>
      news([{ ...spy, errors: [], symbol: `H${hours}` }])
    );
    const container = await render({ watchlist });
    await choose(container, 24);
    expect(watchlist).toHaveBeenLastCalledWith(24);
    expect(window.location.search).toBe("?days=1");
    expect(firstSymbol(container)).toBe("H24");
    expect(chip(container)).toBe("1 symbol watched");
    expect(container.textContent).toContain(
      "No headlines in the last 24 hours."
    );
    await click(container, "Refresh");
    expect(watchlist).toHaveBeenCalledTimes(3);
    expect(watchlist).toHaveBeenLastCalledWith(24);
    await choose(container, 720);
    expect(watchlist).toHaveBeenLastCalledWith(720);
    expect(window.location.search).toBe("?days=30");
    return expect(container.textContent).toContain(
      "No headlines in the last 30 days."
    );
  });

  it("drops a superseded answer", async () => {
    const pending: Array<{
      hours: MarketNewsHours;
      settle: (value: MarketNewsWatchlistOutput) => void;
      fail: (error: unknown) => void;
    }> = [];
    const watchlist = vi.fn(
      (hours: MarketNewsHours) =>
        new Promise<MarketNewsWatchlistOutput>((settle, fail) => {
          pending.push({ fail, hours, settle });
        })
    );
    window.history.replaceState(null, "", "/news?days=3#top");
    const container = await render({ watchlist });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading news…"
    );
    expect(chip(container)).toBe("Loading");
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh"
    );
    expect(refresh?.disabled).toBe(true);
    await choose(container, 168);
    await act(async () => {
      pending[1]?.settle(news([{ ...spy, symbol: "NEW" }]));
      pending[0]?.settle(news([{ ...spy, symbol: "OLD" }]));
      await flush();
    });
    expect(firstSymbol(container)).toBe("NEW");
    await choose(container, 24);
    await choose(container, 72);
    // The default window keeps a clean address.
    expect(window.location.search).toBe("");
    await act(async () => {
      pending[2]?.fail({ code: "STORAGE_ERROR" });
      pending[3]?.settle(news([{ ...spy, symbol: "WEEK" }]));
      await flush();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    return expect(firstSymbol(container)).toBe("WEEK");
  });

  it("opens the window named by ?days= and falls back to 3 days", async () => {
    expect(parseNewsDays("1")).toBe(24);
    expect(parseNewsDays("7")).toBe(168);
    expect(parseNewsDays("30")).toBe(720);
    expect(parseNewsDays("3")).toBe(72);
    expect(parseNewsDays(undefined)).toBe(72);
    expect(parseNewsDays("2")).toBe(72);
    expect(parseNewsDays("7d")).toBe(72);
    const watchlist = vi.fn(async () => news([aapl]));
    const container = await render({ watchlist }, "7");
    expect(watchlist).toHaveBeenCalledWith(168);
    expect(container.querySelector("select")?.value).toBe("168");
    expect(chip(container)).toBe("1 symbol watched");
    expect(chipTone(container)).toContain("text-success-foreground");
    return expect(
      container.querySelector('[data-kpi="headlines"]')?.textContent
    ).toContain("In the last 7 days");
  });

  return it("shows a failure with a retry", async () => {
    const watchlist = vi
      .fn<MarketNewsGateway["watchlist"]>()
      .mockRejectedValueOnce({ code: "UNAUTHORIZED" })
      .mockResolvedValueOnce(news([aapl]));
    const container = await render({ watchlist });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "News unavailable: Session expired. Sign in again."
    );
    expect(chip(container)).toBe("Unavailable");
    await click(container, "Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    return expect(firstSymbol(container)).toBe("AAPL");
  });
});
