// @vitest-environment jsdom
import type { CongressTradesFeedOutput } from "@darkfactory/api";
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

import type { CongressTradesGateway } from "./congress-trades-client.ts";
import {
  type CongressTradesSettings,
  parseCongressTradesParams,
} from "./congress-trades-params.ts";
import {
  CONGRESS_TRADES_PAGE_SIZE,
  CongressTradesWorkspace,
  unparsedByReason,
} from "./congress-trades-workspace.tsx";

const browserFeed = vi.hoisted(() => vi.fn());
vi.mock("./congress-trades-client.ts", () => ({
  createBrowserCongressTradesGateway: () => ({ feed: browserFeed }),
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

type Trade = CongressTradesFeedOutput["trades"][number];
type Filing = CongressTradesFeedOutput["filings"][number];

const HOUSE_URL =
  "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/";

const trade = (overrides: Partial<Trade> = {}): Trade => ({
  amends: false,
  amountHigh: 15_000,
  amountLabel: "$1,001 - $15,000",
  amountLow: 1001,
  asset: "Example Widgets Inc. common stock",
  assetType: "ST",
  chamber: "house",
  delayDays: 12,
  docId: "90000001",
  filedOn: "2026-10-12",
  holder: "spouse",
  member: "Hon. Avery Example",
  rowNumber: 1,
  ticker: "EXWD",
  transactionDate: "2026-09-30",
  transactionType: "purchase",
  url: `${HOUSE_URL}90000001.pdf`,
  ...overrides,
});

const unparsedFiling = (overrides: Partial<Filing> = {}): Filing => ({
  amends: false,
  chamber: "senate",
  docId: "00000000-0000-4000-8000-000000000001",
  filedOn: "2026-10-05",
  member: "Sen. Jordan Sample",
  parserVersion: "1",
  reason: "scanned_image",
  rowCount: 0,
  stateDistrict: null,
  status: "unparsed",
  url: "https://efdsearch.senate.gov/search/view/paper/00000000-0000-4000-8000-000000000001/",
  ...overrides,
});

const feedOf = (
  trades: Trade[],
  filings: Filing[] = [],
  coverage: CongressTradesFeedOutput["coverage"] = [
    {
      chamber: "house",
      lastOkAt: new Date("2026-10-13T11:00:00.000Z"),
      lastRunAt: new Date("2026-10-13T10:55:00.000Z"),
      lastStatus: "ok",
      overdue: false,
    },
    {
      chamber: "senate",
      lastOkAt: new Date("2026-10-11T11:00:00.000Z"),
      lastRunAt: new Date("2026-10-13T09:00:00.000Z"),
      lastStatus: "failed",
      overdue: true,
    },
  ]
): CongressTradesFeedOutput => ({
  coverage,
  filings,
  members: [...new Set(trades.map((row) => row.member))].sort(),
  receivedAt: new Date("2026-10-13T15:04:00.000Z"),
  source: "Congress disclosure ledger",
  trades,
  unparsed: {
    byReason: { layout_unknown: 0, no_transactions: 0, scanned_image: 0 },
    total: filings.filter((row) => row.status === "unparsed").length,
  },
});

const defaults: CongressTradesSettings = {
  chamber: "",
  days: 30,
  member: "",
  ticker: "",
};

const sample = feedOf(
  [
    trade(),
    trade({
      amends: true,
      chamber: "senate",
      delayDays: null,
      docId: "00000000-0000-4000-8000-000000000002",
      holder: null,
      member: "Sen. Jordan Sample",
      rowNumber: 2,
      ticker: null,
      transactionDate: null,
      transactionType: "sale_partial",
    }),
  ],
  [
    unparsedFiling(),
    unparsedFiling({ chamber: "house", docId: "90000009", reason: null }),
    unparsedFiling({
      docId: "90000010",
      reason: null,
      rowCount: 1,
      status: "parsed",
    }),
  ]
);

const render = async (
  gateway: CongressTradesGateway,
  initial?: CongressTradesSettings
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      initial === undefined ? (
        <CongressTradesWorkspace gateway={gateway} />
      ) : (
        <CongressTradesWorkspace gateway={gateway} initial={initial} />
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

const pager = (container: HTMLElement) =>
  container.querySelector('[aria-label="Trade pages"] p')?.textContent;

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

const tableRows = (table: Element | null | undefined) =>
  [...(table?.querySelectorAll("tbody tr") ?? [])].map((row) =>
    [...row.children].map((cell) => cell.textContent)
  );

const tables = (container: HTMLElement) => [
  ...container.querySelectorAll("table"),
];

describe("congress trades workspace", () => {
  it("shows coverage, trades and unparsed filings", async () => {
    const feed = vi.fn(async () => sample);
    const container = await render({ feed });
    expect(feed).toHaveBeenCalledWith(defaults);
    expect(status(container)).toBe("2 trades");
    expect(kpi(container, "trades")).toContain("2");
    expect(kpi(container, "unparsed")).toContain("2");
    const coverage = container.querySelector(
      '[aria-label="Data coverage by chamber"]'
    )?.textContent;
    expect(coverage).toContain("House: updated 2026-10-13 11:00 UTC");
    expect(coverage).toContain("Senate: overdue since 2026-10-11 11:00 UTC");
    expect(tableRows(tables(container)[0])).toEqual([
      [
        "2026-10-12",
        "Hon. Avery Example",
        "House",
        "Spouse",
        "EXWD",
        "Example Widgets Inc. common stock",
        "Purchase",
        "$1,001 - $15,000",
        "2026-09-30",
        "12 d",
      ],
      [
        "2026-10-12",
        "Sen. Jordan SampleStatus:Amendment",
        "Senate",
        "—",
        "—",
        "Example Widgets Inc. common stock",
        "Partial sale",
        "$1,001 - $15,000",
        "—",
        "—",
      ],
    ]);
    expect(tableRows(tables(container)[1])).toEqual([
      [
        "Sen. Jordan Sample",
        "2026-10-05",
        "Scanned image, no text",
        "Senate 00000000-0000-4000-8000-000000000001",
      ],
      ["Sen. Jordan Sample", "2026-10-05", "—", "House 90000009"],
    ]);
    const link = container.querySelector("tbody a") as HTMLAnchorElement;
    expect(link.href).toBe(`${HOUSE_URL}90000001.pdf`);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe(
      "Filing: Hon. Avery Example 2026-10-12, opens in a new tab"
    );
    return expect(container.textContent).toContain(
      "2 trades · Congress disclosure ledger · read 2026-10-13 15:04 UTC"
    );
  });

  it("reports an empty window, a chamber with no successful run and a fully parsed window", async () => {
    const container = await render({
      feed: async () =>
        feedOf(
          [],
          [],
          [
            {
              chamber: "house",
              lastOkAt: null,
              lastRunAt: new Date("2026-10-13T09:00:00.000Z"),
              lastStatus: "failed",
              overdue: true,
            },
          ]
        ),
    });
    expect(status(container)).toBe("0 trades");
    expect(container.textContent).toContain("House: no successful run");
    expect(container.textContent).toContain(
      "No parsed trades match these filters in the last 30 days."
    );
    return expect(container.textContent).toContain(
      "Every filing in this window was parsed."
    );
  });

  it("sends each filter to the server and keeps the URL in sync", async () => {
    window.history.replaceState(null, "", "/congress-trades?theme=dark");
    const feed = vi.fn(async () => sample);
    const container = await render({ feed });
    const [days, chamber, member] = selects(container);
    await choose(days, "90");
    expect(feed).toHaveBeenLastCalledWith({ ...defaults, days: 90 });
    await choose(chamber, "senate");
    expect(feed).toHaveBeenLastCalledWith({
      ...defaults,
      chamber: "senate",
      days: 90,
    });
    await typeTicker(container, " exwd ");
    expect(feed).toHaveBeenLastCalledWith({
      chamber: "senate",
      days: 90,
      member: "",
      ticker: "EXWD",
    });
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      "EXWD"
    );
    const calls = feed.mock.calls.length;
    await typeTicker(container, "exwd");
    expect(feed).toHaveBeenCalledTimes(calls);
    await choose(member, "Sen. Jordan Sample");
    expect(feed).toHaveBeenLastCalledWith({
      chamber: "senate",
      days: 90,
      member: "Sen. Jordan Sample",
      ticker: "EXWD",
    });
    expect(window.location.search).toBe(
      "?theme=dark&days=90&chamber=senate&ticker=EXWD&member=Sen.+Jordan+Sample"
    );
    await typeTicker(container, "bad ticker");
    return expect(feed).toHaveBeenLastCalledWith({
      chamber: "senate",
      days: 90,
      member: "Sen. Jordan Sample",
      ticker: "",
    });
  });

  it("restores settings from the URL and keeps a chosen member listed", async () => {
    const feed = vi.fn(async () => feedOf([]));
    const initial = parseCongressTradesParams({
      chamber: "house",
      days: "7",
      member: "Hon. Riley Placeholder",
      ticker: "exwd",
    });
    const container = await render({ feed }, initial);
    expect(feed).toHaveBeenCalledWith(initial);
    const [, , member] = selects(container);
    expect(member.value).toBe("Hon. Riley Placeholder");
    return expect(
      [...member.options].map((option) => option.textContent)
    ).toEqual(["All members", "Hon. Riley Placeholder"]);
  });

  it("keeps the member select enabled and listed while loading and after an error", async () => {
    let resolvePending: (value: CongressTradesFeedOutput) => void = () =>
      undefined;
    const feed = vi
      .fn<CongressTradesGateway["feed"]>()
      .mockResolvedValueOnce(sample)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("Database not configured"))
      .mockResolvedValue(sample);
    const container = await render({ feed });
    const [days, , member] = selects(container);
    member.focus();
    await choose(member, "Sen. Jordan Sample");
    expect(container.textContent).toContain("Loading trades…");
    expect(member.disabled).toBe(false);
    expect(document.activeElement).toBe(member);
    expect([...member.options].map((option) => option.value)).toEqual([
      "",
      "Sen. Jordan Sample",
      "Hon. Avery Example",
    ]);
    await choose(days, "7");
    await act(async () => {
      resolvePending(sample);
      return await flush();
    });
    expect(status(container)).toMatch(/^Load failed \d{2}:\d{2} UTC$/);
    expect(member.disabled).toBe(false);
    expect(member.value).toBe("Sen. Jordan Sample");
    await choose(member, "");
    expect(feed).toHaveBeenLastCalledWith({ ...defaults, days: 7 });
    expect(member.value).toBe("");
    return expect(status(container)).toBe("2 trades");
  });

  it("lists a member from the URL before the first load ends", async () => {
    const feed = vi.fn<CongressTradesGateway["feed"]>(
      () => new Promise(() => undefined)
    );
    const container = await render(
      { feed },
      parseCongressTradesParams({ member: "  Hon. Riley Placeholder  " })
    );
    const [, , member] = selects(container);
    expect(member.disabled).toBe(false);
    expect(member.value).toBe("Hon. Riley Placeholder");
    return expect(feed).toHaveBeenCalledWith({
      ...defaults,
      member: "Hon. Riley Placeholder",
    });
  });

  it("uses the singular for one trade", async () => {
    const container = await render({ feed: async () => feedOf([trade()]) });
    expect(status(container)).toBe("1 trade");
    return expect(container.textContent).toContain("1 trade · Congress");
  });

  it("pages long feeds", async () => {
    const many = feedOf(
      Array.from({ length: CONGRESS_TRADES_PAGE_SIZE + 3 }, (_, index) =>
        trade({ rowNumber: index + 1 })
      )
    );
    const container = await render({ feed: async () => many });
    expect(pager(container)).toBe(
      `Showing 1–50 of ${CONGRESS_TRADES_PAGE_SIZE + 3}`
    );
    expect(buttonNamed(container, "Previous").disabled).toBe(true);
    await press(buttonNamed(container, "Next"));
    expect(pager(container)).toBe("Showing 51–53 of 53");
    expect(buttonNamed(container, "Next").disabled).toBe(true);
    await press(buttonNamed(container, "Previous"));
    return expect(pager(container)).toBe("Showing 1–50 of 53");
  });

  it("shows a load failure and retries; refresh reloads", async () => {
    const feed = vi
      .fn<CongressTradesGateway["feed"]>()
      .mockRejectedValueOnce(new Error("Database not configured"))
      .mockResolvedValue(sample);
    const container = await render({ feed });
    expect(status(container)).toMatch(/^Load failed \d{2}:\d{2} UTC$/);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Trades not loaded: Database not configured"
    );
    await press(buttonNamed(container, "Try again"));
    expect(status(container)).toBe("2 trades");
    await press(buttonNamed(container, "Refresh"));
    return expect(feed).toHaveBeenCalledTimes(3);
  });

  it("ignores a slower, older response", async () => {
    let resolveFirst: (value: CongressTradesFeedOutput) => void = () =>
      undefined;
    const feed = vi
      .fn<CongressTradesGateway["feed"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue(feedOf([]));
    const container = await render({ feed });
    expect(container.textContent).toContain("Loading trades…");
    await choose(selects(container)[0], "7");
    expect(status(container)).toBe("0 trades");
    await act(async () => {
      resolveFirst(sample);
      return await flush();
    });
    return expect(status(container)).toBe("0 trades");
  });

  return it("uses the browser gateway when none is supplied", async () => {
    browserFeed.mockResolvedValue(sample);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<CongressTradesWorkspace />);
      return await flush();
    });
    expect(browserFeed).toHaveBeenCalledWith(defaults);
    return expect(status(container)).toBe("2 trades");
  });
});

describe("unparsedByReason", () => {
  it("lists only the reasons with filings, in label order", () => {
    expect(
      unparsedByReason({
        byReason: { layout_unknown: 1, no_transactions: 0, scanned_image: 4 },
        total: 5,
      })
    ).toBe("Layout not recognized: 1 · Scanned image, no text: 4");
  });

  it("says none when nothing is unparsed", () => {
    expect(
      unparsedByReason({
        byReason: { layout_unknown: 0, no_transactions: 0, scanned_image: 0 },
        total: 0,
      })
    ).toBe("None in this window");
  });
});
