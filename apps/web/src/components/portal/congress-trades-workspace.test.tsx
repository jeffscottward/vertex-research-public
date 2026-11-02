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
import { CongressTradesWorkspace } from "./congress-trades-workspace.tsx";

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

const render = async (gateway: CongressTradesGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<CongressTradesWorkspace gateway={gateway} />);
    return await flush();
  });
  return container;
};

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
});
