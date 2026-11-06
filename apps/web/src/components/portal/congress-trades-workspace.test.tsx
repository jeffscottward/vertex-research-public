// @vitest-environment jsdom
import type {
  CongressTradeFiling,
  CongressTradesFeedOutput,
  CongressTradeWindow,
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

import type { CongressTradesGateway } from "./congress-trades-client.ts";
import {
  CONGRESS_TRADES_PAGE_SIZE,
  type CongressTradesSettings,
  CongressTradesWorkspace,
  congressTradesSearch,
  parseCongressTradesParams,
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

const filing = (
  docId: string,
  member: string,
  filedOn: string,
  stateDistrict = "CA11"
): CongressTradeFiling => {
  const [firstName = "", lastName = ""] = member.split(" ");
  return {
    docId,
    filedOn,
    firstName,
    lastName,
    member,
    pdfUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`,
    stateDistrict,
    year: 2026,
  };
};

const feedOf = (
  filings: CongressTradeFiling[],
  members = [...new Set(filings.map((row) => row.member))].sort()
): CongressTradesFeedOutput => ({
  filings,
  members,
  receivedAt: new Date("2026-10-13T15:04:00.000Z"),
  source: "U.S. House Clerk financial disclosure index 2026FD.zip",
});

const thirtyDays = feedOf([
  filing("20035635", "Rick Larsen", "2026-10-12", "WA02"),
  filing("20035553", "Nancy Pelosi", "2026-10-02"),
  filing("20035143", "Nancy Pelosi", "2026-09-21", ""),
]);

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
  container.querySelector('[aria-label="Filing pages"] p')?.textContent;

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

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr")].map((row) =>
    [...row.children].map((cell) => cell.textContent)
  );

describe("congress trades workspace", () => {
  it("lists the 30 day feed with PDF links that open in a new tab", async () => {
    const feed = vi.fn(async () => thirtyDays);
    const container = await render({ feed });
    expect(feed).toHaveBeenCalledWith(30);
    expect(container.textContent).toContain("up to 45 days after the trade");
    expect(container.textContent).toContain("in each linked PDF");
    expect(rows(container)).toEqual([
      ["2026-10-12", "Rick Larsen", "WA02", "PTR 20035635"],
      ["2026-10-02", "Nancy Pelosi", "CA11", "PTR 20035553"],
      ["2026-09-21", "Nancy Pelosi", "–", "PTR 20035143"],
    ]);
    const link = container.querySelector("tbody a") as HTMLAnchorElement;
    expect(link.href).toBe(
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035635.pdf"
    );
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    const cards = [
      ...container.querySelectorAll('[aria-label="Filings, newest first"] li'),
    ];
    expect(cards.map((card) => card.textContent)).toEqual([
      "Rick LarsenWA02 · filed 2026-10-12Report PDF",
      "Nancy PelosiCA11 · filed 2026-10-02Report PDF",
      "Nancy Pelosi– · filed 2026-09-21Report PDF",
    ]);
    const cardLink = cards[0]?.querySelector("a") as HTMLAnchorElement;
    expect(cardLink.href).toBe(link.href);
    expect(cardLink.target).toBe("_blank");
    expect(cardLink.rel).toContain("noopener");
    expect(cardLink.className).toContain("min-h-11");
    expect(cardLink.getAttribute("aria-label")).toBe(
      "Report PDF: Rick Larsen 2026-10-12, opens in a new tab"
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "3 filings · U.S. House Clerk financial disclosure index 2026FD.zip · read 2026-10-13 15:04 UTC"
    );
    const [windowSelect, memberSelect] = selects(container);
    expect([...windowSelect.options].map((option) => option.value)).toEqual([
      "7",
      "30",
      "90",
    ]);
    return expect(
      [...memberSelect.options].map((option) => option.textContent)
    ).toEqual(["All members", "Nancy Pelosi", "Rick Larsen"]);
  });

  it("filters by member and resets the filter when the member leaves the window", async () => {
    const sevenDays = feedOf([
      filing("20035635", "Rick Larsen", "2026-10-12", "WA02"),
    ]);
    const feed = vi.fn(async (days: CongressTradeWindow) =>
      days === 7 ? sevenDays : thirtyDays
    );
    const container = await render({ feed });
    const [windowSelect, memberSelect] = selects(container);
    await choose(memberSelect, "Nancy Pelosi");
    const pelosi = ["PTR 20035553", "PTR 20035143"];
    expect(rows(container).map((row) => row[3])).toEqual(pelosi);
    await choose(windowSelect, "90");
    expect(memberSelect.value).toBe("Nancy Pelosi");
    expect(rows(container).map((row) => row[3])).toEqual(pelosi);
    await choose(windowSelect, "7");
    expect(feed).toHaveBeenLastCalledWith(7);
    expect(memberSelect.value).toBe("");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(
      /^1 filing ·/u
    );
    await choose(windowSelect, "30");
    return expect(memberSelect.value).toBe("");
  });

  it("uses the browser gateway when none is supplied", async () => {
    browserFeed.mockResolvedValueOnce(thirtyDays);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<CongressTradesWorkspace />);
      return await flush();
    });
    expect(browserFeed).toHaveBeenCalledWith(30);
    return expect(rows(container)).toHaveLength(3);
  });

  it("says when a window has no filings", async () => {
    const container = await render({ feed: async () => feedOf([]) });
    expect(container.querySelector("table")).toBeNull();
    return expect(container.textContent).toContain(
      "No periodic transaction reports were filed in the last 30 days."
    );
  });

  it("shows loading, then a retryable error with the server message", async () => {
    const feed = vi
      .fn<CongressTradesGateway["feed"]>()
      .mockRejectedValueOnce({ message: "House Clerk disclosures unavailable" })
      .mockResolvedValueOnce(thirtyDays);
    const container = await render({ feed });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Filings unavailable: House Clerk disclosures unavailable"
    );
    expect(selects(container)[1].disabled).toBe(true);
    // The named feed region appears only once filings have loaded.
    expect(
      container.querySelector('section[aria-label="PTR filings"]')
    ).toBeNull();
    await act(async () => {
      alert?.querySelector("button")?.click();
      return await flush();
    });
    expect(feed).toHaveBeenCalledTimes(2);
    return expect(rows(container)).toHaveLength(3);
  });

  it("keeps the newest window when an older response arrives late", async () => {
    // The tsconfig lib predates Promise.withResolvers.
    let releaseSlow: (feed: CongressTradesFeedOutput) => void = () => undefined;
    const slow = new Promise<CongressTradesFeedOutput>((resolve) => {
      releaseSlow = resolve;
    });
    const ninetyDays = feedOf([
      filing("20033725", "Nancy Pelosi", "2026-07-23"),
    ]);
    const feed = vi.fn(async (days: CongressTradeWindow) =>
      days === 30 ? slow : ninetyDays
    );
    const container = await render({ feed });
    expect(container.textContent).toContain("Loading filings…");
    await choose(selects(container)[0], "90");
    await act(async () => {
      releaseSlow(thirtyDays);
      return await flush();
    });
    return expect(rows(container).map((row) => row[3])).toEqual([
      "PTR 20033725",
    ]);
  });

  it("shows the header, KPIs and the feed panel controls by default", async () => {
    const feed = vi.fn(async () => thirtyDays);
    const container = await render({ feed });
    expect(container.querySelector("h1")?.textContent).toBe("Congress trades");
    expect(status(container)).toBe("3 filings");
    expect(kpi(container, "filings")).toBe("Filings3Filed in the last 30 days");
    expect(kpi(container, "members")).toBe("Members2With at least one filing");
    expect(kpi(container, "latest")).toBe("Latest filing2026-10-12Rick Larsen");
    expect(window.location.search).toBe("");
    const header = container.querySelector(
      '[aria-labelledby="congress-feed-heading"] [data-slot="panel-header"]'
    );
    expect(header?.querySelectorAll("select")).toHaveLength(2);
    expect(header?.querySelector("h2")?.textContent).toBe("Filings");
    expect(
      container.querySelector('section[aria-label="PTR filings"]')
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-slot="table-scroll"]')
        ?.getAttribute("aria-label")
    ).toBe("Periodic transaction report filings");
    // Three filings fit on one page: no pager.
    expect(container.querySelector('[aria-label="Filing pages"]')).toBeNull();
    await press(buttonNamed(container, "Refresh"));
    expect(feed).toHaveBeenCalledTimes(2);
    return expect(feed).toHaveBeenLastCalledWith(30);
  });

  it("writes the window and member to the URL and starts from URL settings", async () => {
    window.history.replaceState(null, "", "/congress-trades#feed");
    const feed = vi.fn(async () => thirtyDays);
    const container = await render({ feed });
    const [windowSelect, memberSelect] = selects(container);
    await choose(windowSelect, "90");
    expect(window.location.search).toBe("?days=90");
    await choose(memberSelect, "Nancy Pelosi");
    expect(window.location.pathname).toBe("/congress-trades");
    expect(window.location.search).toBe("?days=90&member=Nancy+Pelosi");
    expect(window.location.hash).toBe("#feed");
    await choose(windowSelect, "30");
    await choose(memberSelect, "");
    expect(window.location.search).toBe("");
    const restored = await render({ feed }, { days: 7, member: "Rick Larsen" });
    expect(feed).toHaveBeenLastCalledWith(7);
    expect(selects(restored)[1].value).toBe("Rick Larsen");
    expect(window.location.search).toBe("?days=7&member=Rick+Larsen");
    return expect(rows(restored).map((row) => row[3])).toEqual([
      "PTR 20035635",
    ]);
  });

  it("keeps foreign URL params such as ?theme= on mount and on change", async () => {
    window.history.replaceState(
      null,
      "",
      "/congress-trades?theme=light&days=90"
    );
    const feed = vi.fn(async () => thirtyDays);
    const container = await render({ feed }, { days: 90, member: "" });
    expect(window.location.search).toBe("?theme=light&days=90");
    await choose(selects(container)[0], "30");
    expect(window.location.search).toBe("?theme=light");
    await choose(selects(container)[1], "Nancy Pelosi");
    return expect(window.location.search).toBe(
      "?theme=light&member=Nancy+Pelosi"
    );
  });

  it("pages a long feed and returns to the first page when the filter changes", async () => {
    const long = feedOf(
      Array.from({ length: 120 }, (_, index) =>
        filing(
          String(20_030_000 + index),
          index % 2 === 0 ? "Rick Larsen" : "Nancy Pelosi",
          "2026-10-01"
        )
      )
    );
    const container = await render({ feed: async () => long });
    expect(CONGRESS_TRADES_PAGE_SIZE).toBe(50);
    expect(rows(container)).toHaveLength(50);
    expect(
      container.querySelectorAll('[aria-label="Filings, newest first"] li')
    ).toHaveLength(50);
    expect(pager(container)).toBe("Showing 1–50 of 120");
    expect(buttonNamed(container, "Previous").disabled).toBe(true);
    await press(buttonNamed(container, "Next"));
    expect(pager(container)).toBe("Showing 51–100 of 120");
    expect(rows(container)[0]?.[3]).toBe("PTR 20030050");
    await press(buttonNamed(container, "Next"));
    expect(pager(container)).toBe("Showing 101–120 of 120");
    expect(rows(container)).toHaveLength(20);
    expect(buttonNamed(container, "Next").disabled).toBe(true);
    await press(buttonNamed(container, "Previous"));
    expect(pager(container)).toBe("Showing 51–100 of 120");
    await choose(selects(container)[1], "Nancy Pelosi");
    expect(pager(container)).toBe("Showing 1–50 of 60");
    await press(buttonNamed(container, "Next"));
    expect(pager(container)).toBe("Showing 51–60 of 60");
    // A new window starts again at the first page (the member keeps filings in it).
    await choose(selects(container)[0], "90");
    return expect(pager(container)).toBe("Showing 1–50 of 60");
  });

  it("finds the latest filing in any order and counts a single filing", async () => {
    const unsorted = feedOf([
      filing("20035143", "Nancy Pelosi", "2026-09-21"),
      filing("20035635", "Rick Larsen", "2026-10-12", "WA02"),
    ]);
    const container = await render({ feed: async () => unsorted });
    expect(kpi(container, "latest")).toBe("Latest filing2026-10-12Rick Larsen");
    const single = await render({
      feed: async () =>
        feedOf([filing("20035553", "Nancy Pelosi", "2026-10-02")]),
    });
    expect(status(single)).toBe("1 filing");
    const empty = await render({ feed: async () => feedOf([]) });
    expect(status(empty)).toBe("0 filings");
    return expect(kpi(empty, "latest")).toBe(
      "Latest filing–No filing in this window"
    );
  });
});

describe("congress trades URL settings", () => {
  it("reads and writes ?days= and ?member=", () => {
    expect(parseCongressTradesParams({})).toEqual({ days: 30, member: "" });
    expect(
      parseCongressTradesParams({ days: "90", member: "Nancy Pelosi" })
    ).toEqual({ days: 90, member: "Nancy Pelosi" });
    expect(
      parseCongressTradesParams({ days: "14", member: "x".repeat(201) })
    ).toEqual({ days: 30, member: "" });
    expect(
      parseCongressTradesParams({ days: ["7"], member: ["Rick Larsen"] })
    ).toEqual({ days: 30, member: "" });
    expect(congressTradesSearch({ days: 30, member: "" })).toBe("");
    return expect(
      congressTradesSearch({ days: 7, member: "Rick Larsen" })
    ).toBe("?days=7&member=Rick+Larsen");
  });
});
