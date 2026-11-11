// @vitest-environment jsdom

import type {
  MarketContextOutput,
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

import type { MarketFeedsGateway } from "./market-feeds-workspace.tsx";
import type { MarketNewsGateway } from "./market-news-client.ts";

const browser = vi.hoisted(() => ({
  feeds: { context: vi.fn() },
  news: { watchlist: vi.fn() },
}));
vi.mock("./market-feeds-workspace.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-feeds-workspace.tsx")>()),
  createBrowserMarketFeedsGateway: () => browser.feeds,
}));
vi.mock("./market-news-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-news-client.ts")>()),
  createBrowserMarketNewsGateway: () => browser.news,
}));

import { CalendarWorkspace } from "./calendar-workspace.tsx";

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
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

// Friday 2026-11-06, 15:00 in New York.
const NOW = new Date("2026-11-06T20:00:00.000Z");

const context = (
  overrides: Partial<MarketContextOutput> = {}
): MarketContextOutput => ({
  generatedAt: "2026-11-06T19:55:00.000Z",
  gex: null,
  macro: {
    asOf: "2026-11-06T19:55:00.000Z",
    events: [
      { date: "2026-11-06", name: "Nonfarm payrolls", time: "08:30 ET" },
      { date: "2026-11-10", name: "CPI", time: "08:30 ET" },
      { date: "2026-11-12", name: "Treasury refunding", time: null },
    ],
    regimes: [],
    series: [],
  },
  missing: [],
  news: null,
  stale: false,
  ...overrides,
});

const aapl: MarketNewsTicker = {
  errors: [],
  filings: [
    {
      filedAt: new Date("2026-10-30T20:31:00.000Z"),
      form: "8-K",
      important: true,
      items: [
        { code: "2.02", label: "earnings results" },
        { code: "9.01", label: "exhibits" },
      ],
      title: "Apple Inc. filed a 8-K: earnings results",
      url: "https://www.sec.gov/Archives/aapl-q4-index.htm",
    },
    {
      filedAt: new Date("2026-10-20T12:00:00.000Z"),
      form: "8-K",
      important: true,
      items: [{ code: "5.02", label: "officer change" }],
      title: "Apple Inc. filed a 8-K: officer change",
      url: "https://www.sec.gov/Archives/aapl-502-index.htm",
    },
  ],
  headlines: [],
  symbol: "AAPL",
};

const spy: MarketNewsTicker = {
  errors: ["filings: no SEC filer matches this symbol"],
  filings: [],
  headlines: [],
  symbol: "SPY",
};

const news = (tickers: MarketNewsTicker[]): MarketNewsWatchlistOutput => ({
  receivedAt: new Date("2026-11-06T19:59:00.000Z"),
  tickers,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

// Promise.withResolvers is outside the ES2023 lib of this package.
const deferred = <T,>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
};

const gateways = (
  contextResult: () => Promise<MarketContextOutput>,
  newsResult: () => Promise<MarketNewsWatchlistOutput>
) => ({
  contextGateway: { context: vi.fn(contextResult) },
  newsGateway: { watchlist: vi.fn(newsResult) },
});

const render = async (
  props: Readonly<{
    contextGateway?: MarketFeedsGateway;
    newsGateway?: MarketNewsGateway;
    now?: () => Date;
  }>
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<CalendarWorkspace {...props} />);
    await flush();
  });
  return container;
};

const chip = (container: HTMLElement) =>
  container
    .querySelector("[data-calendar-status]")
    ?.getAttribute("data-calendar-status");

const click = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await flush();
  });
};

/** Text nodes joined by spaces, as a reader hears the row. */
const words = (element: Element): string => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    parts.push(node.textContent?.trim() ?? "");
  return parts.filter((part) => part.length > 0).join(" ");
};

const agenda = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-calendar-day]")].map((day) => [
    day.getAttribute("data-calendar-day"),
    day.getAttribute("data-calendar-when"),
    [...day.querySelectorAll("[data-calendar-entry]")].map(words),
  ]);

describe("calendar workspace", () => {
  it("merges economic releases and earnings filings into one agenda grouped by day", async () => {
    const props = gateways(
      async () => context(),
      async () => news([aapl, spy])
    );
    const container = await render({ ...props, now: () => NOW });

    expect(container.querySelector("h1")?.textContent).toBe("Calendar");
    expect(props.newsGateway.watchlist).toHaveBeenCalledWith(720, "filings");
    // SPY's SEC source failed, so the earnings side is partial.
    expect(chip(container)).toBe("Partial");
    expect(agenda(container)).toEqual([
      [
        "2026-10-30",
        "past",
        [
          "16:31 ET Earnings AAPL 8-K item 2.02 earnings results filed (opens SEC filing)",
        ],
      ],
      ["2026-11-06", "today", ["08:30 ET Economic Nonfarm payrolls"]],
      ["2026-11-10", "upcoming", ["08:30 ET Economic CPI"]],
      ["2026-11-12", "upcoming", ["All day Economic Treasury refunding"]],
    ]);
    expect(
      container.querySelector('[data-calendar-day="2026-11-06"] h3')
        ?.textContent
    ).toBe("Fri, Nov 6, 2026Today");
    const filingLink = container.querySelector(
      '[data-calendar-entry="earnings"] a[target="_blank"]'
    );
    expect(filingLink?.getAttribute("href")).toBe(
      "https://www.sec.gov/Archives/aapl-q4-index.htm"
    );
    expect(filingLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      container
        .querySelector(
          '[data-calendar-entry="earnings"] [data-slot="ticker-link"]'
        )
        ?.getAttribute("href")
    ).toContain("AAPL");
    expect(container.querySelector("[data-calendar-gaps]")?.textContent).toBe(
      "SEC filings unavailable for SPY."
    );
    expect(
      container.querySelector('[data-calendar-source="economic"] [role="note"]')
        ?.textContent
    ).toContain("pushed 2026-11-06 19:55 UTC");
    expect(container.querySelector("[data-calendar-stale]")).toBeNull();
    expect(container.querySelector("[data-calendar-missing]")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("filters the agenda to economic or earnings entries", async () => {
    const container = await render({
      ...gateways(
        async () => context(),
        async () => news([aapl])
      ),
      now: () => NOW,
    });
    expect(chip(container)).toBe("Live");
    const pressed = () =>
      container.querySelector('[role="group"] [aria-pressed="true"]')
        ?.textContent;
    expect(pressed()).toBe("All");

    await click(container, "Economic");
    expect(pressed()).toBe("Economic");
    expect(
      [...container.querySelectorAll("[data-calendar-entry]")].map((entry) =>
        entry.getAttribute("data-calendar-entry")
      )
    ).toEqual(["economic", "economic", "economic"]);

    await click(container, "Earnings");
    expect(agenda(container).map(([date]) => date)).toEqual(["2026-10-30"]);

    await click(container, "All");
    expect(container.querySelectorAll("[data-calendar-entry]")).toHaveLength(4);
  });

  it("says when a filter has nothing to show", async () => {
    const container = await render({
      ...gateways(
        async () => context({ macro: { ...context().macro!, events: [] } }),
        async () => news([spy])
      ),
      now: () => NOW,
    });
    expect(container.querySelector("[data-calendar-empty]")?.textContent).toBe(
      "No economic releases or earnings filings to show."
    );
    await click(container, "Economic");
    expect(container.querySelector("[data-calendar-empty]")?.textContent).toBe(
      "No economic releases to show."
    );
    await click(container, "Earnings");
    expect(container.querySelector("[data-calendar-empty]")?.textContent).toBe(
      "No earnings filings to show for your watchlist."
    );
  });

  it("flags a stale push", async () => {
    const container = await render({
      ...gateways(
        async () => context({ stale: true }),
        async () => news([aapl])
      ),
      now: () => NOW,
    });
    expect(chip(container)).toBe("Stale");
    expect(
      container.querySelector("[data-calendar-stale]")?.textContent
    ).toContain("more than 15 minutes");
  });

  it("flags missing macro data, whether listed as missing or sent as null", async () => {
    const listed = await render({
      ...gateways(
        async () => context({ missing: ["macro"] }),
        async () => news([aapl])
      ),
      now: () => NOW,
    });
    expect(chip(listed)).toBe("Partial");
    expect(listed.querySelector("[data-calendar-missing]")).not.toBeNull();

    const absent = await render({
      ...gateways(
        async () => context({ macro: null }),
        async () => news([aapl])
      ),
      now: () => NOW,
    });
    expect(absent.querySelector("[data-calendar-missing]")).not.toBeNull();
    expect(
      [...absent.querySelectorAll("[data-calendar-entry]")].map((entry) =>
        entry.getAttribute("data-calendar-entry")
      )
    ).toEqual(["earnings"]);
  });

  it("keeps the earnings side when economic releases are operator only", async () => {
    const container = await render({
      ...gateways(
        async () => {
          throw { code: "FORBIDDEN", message: "Forbidden", status: 403 };
        },
        async () => news([aapl])
      ),
      now: () => NOW,
    });
    expect(
      container
        .querySelector("[data-operator-access]")
        ?.getAttribute("data-operator-feature")
    ).toBe("market-context");
    expect(chip(container)).toBe("Partial");
    expect(agenda(container).map(([date]) => date)).toEqual(["2026-10-30"]);
  });

  it("retries only the economic source after it fails", async () => {
    let fail = true;
    const props = gateways(
      async () => {
        if (fail) throw { code: "UPSTREAM_ERROR", message: "Rig unreadable" };
        return context();
      },
      async () => news([aapl])
    );
    const container = await render({ ...props, now: () => NOW });
    const alert = container.querySelector(
      '[data-calendar-source="economic"][role="alert"]'
    );
    expect(alert?.textContent).toContain(
      "Economic releases unavailable. UPSTREAM_ERROR: Rig unreadable"
    );
    fail = false;
    await click(container, "Try again");
    expect(props.contextGateway.context).toHaveBeenCalledTimes(2);
    expect(props.newsGateway.watchlist).toHaveBeenCalledTimes(1);
    expect(chip(container)).toBe("Live");
  });

  it("retries only the earnings source after it fails", async () => {
    let fail = true;
    const props = gateways(
      async () => context(),
      async () => {
        if (fail) throw { code: "UNAUTHORIZED" };
        return news([aapl]);
      }
    );
    const container = await render({ ...props, now: () => NOW });
    expect(chip(container)).toBe("Partial");
    expect(
      container.querySelector('[data-calendar-source="earnings"][role="alert"]')
        ?.textContent
    ).toContain(
      "Earnings filings unavailable. Session expired. Sign in again."
    );
    fail = false;
    await click(container, "Try again");
    expect(props.contextGateway.context).toHaveBeenCalledTimes(1);
    expect(props.newsGateway.watchlist).toHaveBeenCalledTimes(2);
    expect(chip(container)).toBe("Live");
  });

  it("shows Unavailable when both sources fail", async () => {
    const container = await render({
      ...gateways(
        async () => {
          throw new Error("offline");
        },
        async () => {
          throw new Error("offline");
        }
      ),
      now: () => NOW,
    });
    expect(chip(container)).toBe("Unavailable");
    expect(container.querySelector("[data-calendar-empty]")).not.toBeNull();
  });

  it("points an empty watchlist at the watchlist page", async () => {
    const container = await render({
      ...gateways(
        async () => context(),
        async () => news([])
      ),
      now: () => NOW,
    });
    const note = container.querySelector("[data-calendar-watchlist-empty]");
    expect(note?.textContent).toContain("Your watchlist is empty");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/watchlist");
    expect(container.querySelector("[data-calendar-gaps]")).toBeNull();
  });

  it("shows loading until both sources answer, then Refresh reloads both and drops late answers", async () => {
    const contextCalls: Deferred<MarketContextOutput>[] = [];
    const newsCalls: Deferred<MarketNewsWatchlistOutput>[] = [];
    const props = {
      contextGateway: {
        context: vi.fn(() => {
          const call = deferred<MarketContextOutput>();
          contextCalls.push(call);
          return call.promise;
        }),
      },
      newsGateway: {
        watchlist: vi.fn(() => {
          const call = deferred<MarketNewsWatchlistOutput>();
          newsCalls.push(call);
          return call.promise;
        }),
      },
      now: () => NOW,
    };
    const container = await render(props);
    const refresh = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Refresh"
      );
    expect(chip(container)).toBe("Loading");
    expect(refresh()?.disabled).toBe(true);
    expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe(
      "Loading calendar…"
    );
    expect(container.querySelector("[data-calendar-empty]")).toBeNull();

    await act(async () => {
      contextCalls[0]?.resolve(context());
      newsCalls[0]?.resolve(news([aapl]));
      await flush();
    });
    expect(refresh()?.disabled).toBe(false);
    expect(chip(container)).toBe("Live");

    await click(container, "Refresh");
    expect(props.contextGateway.context).toHaveBeenCalledTimes(2);
    expect(props.newsGateway.watchlist).toHaveBeenCalledTimes(2);
    expect(chip(container)).toBe("Loading");

    // Unmount before the second answers arrive: they must not write.
    await act(async () => roots.splice(0)[0]?.unmount());
    await act(async () => {
      contextCalls[1]?.resolve(context({ stale: true }));
      newsCalls[1]?.resolve(news([]));
      await flush();
    });

    // Failures that land after unmount are dropped too.
    await render(props);
    await act(async () => roots.splice(0)[0]?.unmount());
    await act(async () => {
      contextCalls[2]?.reject(new Error("late"));
      newsCalls[2]?.reject(new Error("late"));
      await flush();
    });
    expect(props.contextGateway.context).toHaveBeenCalledTimes(3);
  });

  it("uses the browser gateways and the system clock by default", async () => {
    browser.feeds.context.mockResolvedValue(context());
    browser.news.watchlist.mockResolvedValue(news([aapl]));
    const container = await render({});
    expect(browser.feeds.context).toHaveBeenCalledTimes(1);
    expect(browser.news.watchlist).toHaveBeenCalledWith(720, "filings");
    expect(container.querySelectorAll("[data-calendar-entry]")).toHaveLength(4);
  });
});
