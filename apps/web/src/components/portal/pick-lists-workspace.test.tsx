// @vitest-environment jsdom
import type {
  PickListMemberOutput,
  PickListOutput,
  PickListProposalOutput,
  PickListScreenMemberOutput,
  PickListScreenOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createBrowserPickListGateway,
  createPickListGateway,
  defaultBucketSymbol,
  describePickListFailure,
  type PickListBucketResult,
  type PickListGateway,
} from "./pick-lists-client.ts";
import { PickListsWorkspace } from "./pick-lists-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const settle = async () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await settle();
  return container;
};
const setValue = async (element: Element | null | undefined, value: string) => {
  const input = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const submit = async (form: Element | null | undefined) => {
  await act(async () => (form as HTMLFormElement).requestSubmit());
  await settle();
};
const buttonByText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text)
  );
const card = (container: HTMLElement, name: string) =>
  container.querySelector(`[role="region"][aria-label="${name}"]`);
const row = (root: ParentNode | null, symbol: string) =>
  [...(root?.querySelectorAll("tbody tr") ?? [])].find(
    (entry) => entry.querySelector("th")?.textContent === symbol
  );

// The web tsconfig lib predates Promise.withResolvers, so build the same shape here.
const deferred = <Value,>() => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
};

const member = (
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

const pickList = (overrides: Partial<PickListOutput> = {}): PickListOutput => ({
  bucketSymbol: null,
  id: "list-1",
  latest: {
    asOf: "2026-11-04",
    id: "snap-1",
    importedAt: "2026-11-04T12:00:00.000Z",
    members: [
      member("NVDA", {
        rank: 1,
        rating: "Strong buy",
        sector: "Technology",
        targetPrice: 210.5,
        thesis: "Data center demand",
      }),
      member("XOM", { rank: 2, sector: "Energy" }),
      member("ZZZ"),
    ],
    method: "manual",
  },
  name: "Wish list",
  slug: "wish-list",
  snapshotCount: 1,
  source: "wishlist",
  sourceLabel: "Owner wish list",
  ...overrides,
});

const gate = (ok: boolean | null, detail: string) => ({ detail, ok });
const screened = (
  symbol: string,
  overrides: Partial<PickListScreenMemberOutput> = {}
): PickListScreenMemberOutput => ({
  gates: {
    aboveVwap20: gate(true, "close 100.00 >= VWAP20 98.00"),
    emaTrend: gate(true, "close 100.00 > EMA20 95.00 > EMA50 90.00"),
    notOverextended: gate(true, "close 100.00 <= 105.00"),
  },
  last: 100,
  lastDate: "2026-11-04",
  quadrant: "leading",
  reason: null,
  sector: "Technology",
  sectorEtf: "XLK",
  sectorQuadrant: "improving",
  status: "pass",
  symbol,
  ...overrides,
});
const screenResult: PickListScreenOutput = {
  computedAt: "2026-11-05T14:00:00.000Z",
  listId: "list-1",
  members: [
    screened("NVDA"),
    screened("XOM", {
      gates: {
        aboveVwap20: gate(true, "close 80.00 >= VWAP20 79.00"),
        emaTrend: gate(false, "close 80.00 < EMA20 85.00"),
        notOverextended: gate(true, "close 80.00 <= 90.00"),
      },
      quadrant: null,
      sector: "Energy",
      sectorEtf: null,
      sectorQuadrant: null,
      status: "fail",
    }),
  ],
  snapshotId: "snap-1",
};

const proposalResult: PickListProposalOutput = {
  buckets: [],
  computedAt: "2026-11-05T14:00:00.000Z",
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

const fakeGateway = (overrides: Partial<PickListGateway> = {}) => {
  const gateway = {
    import: vi.fn<PickListGateway["import"]>(async () => pickList()),
    list: vi.fn<PickListGateway["list"]>(async () => [pickList()]),
    proposal: vi.fn<PickListGateway["proposal"]>(async () => proposalResult),
    screen: vi.fn<PickListGateway["screen"]>(async () => screenResult),
    syncBucket: vi.fn<PickListGateway["syncBucket"]>(
      async (id, bucketSymbol): Promise<PickListBucketResult> => ({
        basketId: "basket-1",
        list: pickList({ bucketSymbol, id }),
        memberCount: 3,
        omitted: [],
      })
    ),
    ...overrides,
  };
  return gateway;
};

describe("pick lists client", () => {
  it("maps each failure code to a message", () => {
    for (const [code, text] of [
      ["UNAUTHORIZED", "Session expired"],
      ["FORBIDDEN", "Operator access"],
      ["NOT_FOUND", "no longer exists"],
      ["CONFLICT", "Another basket"],
      ["VALIDATION_ERROR", "invalid input"],
      ["BAD_REQUEST", "invalid input"],
      ["STORAGE_ERROR", "503"],
      ["OTHER", "Request failed"],
    ] as const) {
      expect(describePickListFailure({ code })).toContain(text);
    }
    expect(
      describePickListFailure({
        code: "STORAGE_ERROR",
        message:
          " Pick list storage: the database returned an error at 14:05 UTC. Nothing was changed. Try again. ",
      })
    ).toBe(
      "Storage error (503): Pick list storage: the database returned an error at 14:05 UTC. Nothing was changed. Try again."
    );
    expect(
      describePickListFailure(
        { code: "STORAGE_ERROR", message: " " },
        "2026-11-16T14:05:00.000Z"
      )
    ).toBe(
      "Pick list storage gave no cause for a failure at 14:05 UTC (503). Reload to check whether the change was saved, then retry."
    );
    expect(describePickListFailure(null)).toBe("Request failed. Retry.");
    expect(describePickListFailure("boom")).toBe("Request failed. Retry.");
  });

  it("derives the default bucket symbol from the slug", () => {
    expect(defaultBucketSymbol("wish-list")).toBe("WISHLIST");
    expect(defaultBucketSymbol("growth-picks-2026-q4")).toBe("GROWTHPICK");
  });

  it("maps gateway calls to the oRPC client", async () => {
    const client = {
      pickLists: {
        import: vi.fn(async () => pickList()),
        list: vi.fn(async () => ({ items: [pickList()] })),
        proposal: vi.fn(async () => proposalResult),
        screen: vi.fn(async () => screenResult),
        syncBucket: vi.fn(async () => ({
          basketId: "b",
          list: pickList(),
          memberCount: 3,
          omitted: [],
        })),
      },
    };
    const gateway = createPickListGateway(
      client as unknown as Parameters<typeof createPickListGateway>[0]
    );
    expect(await gateway.list()).toHaveLength(1);
    const input = {
      asOf: "2026-11-05",
      list: { name: "Top", slug: "top" },
      members: [{ symbol: "AAPL" }],
      method: "manual" as const,
      source: "moby",
      sourceLabel: "Moby",
    };
    await gateway.import(input);
    expect(client.pickLists.import).toHaveBeenCalledWith(input);
    await gateway.screen("list-1");
    await gateway.syncBucket("list-1", "WISH");
    expect(await gateway.proposal()).toBe(proposalResult);
    expect(client.pickLists.proposal).toHaveBeenCalledWith({});
    expect(client.pickLists.list).toHaveBeenCalledWith({});
    expect(client.pickLists.screen).toHaveBeenCalledWith({ id: "list-1" });
    expect(client.pickLists.syncBucket).toHaveBeenCalledWith({
      bucketSymbol: "WISH",
      id: "list-1",
    });
  });

  it("creates the browser gateway lazily against the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("offline"));
    const gateway = createBrowserPickListGateway();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const call of [
      () => gateway.list(),
      () =>
        gateway.import({
          asOf: "2026-11-05",
          list: { name: "Top", slug: "top" },
          members: [{ symbol: "AAPL" }],
          method: "manual",
          source: "moby",
          sourceLabel: "Moby",
        }),
      () => gateway.screen("x"),
      () => gateway.syncBucket("x", "WISH"),
      () => gateway.proposal(),
    ]) {
      await expect(call()).rejects.toBeDefined();
    }
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("PickListsWorkspace", () => {
  it("shows a loading status, then each list with provenance and members", async () => {
    const pending = deferred<PickListOutput[]>();
    const gateway = fakeGateway({ list: () => pending.promise });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading pick lists…"
    );
    expect(container.textContent).toContain("Research only — not an order");
    await act(async () =>
      pending.resolve([
        pickList(),
        pickList({
          bucketSymbol: "MOMO",
          id: "list-2",
          latest: { ...pickList().latest, method: "adapter" },
          name: "Momentum",
          slug: "momentum",
          snapshotCount: 4,
          sourceLabel: "Strategy holdings",
        }),
      ])
    );
    await settle();
    expect(container.textContent).not.toContain("Loading pick lists");
    const wish = card(container, "Wish list");
    expect(wish?.querySelector("h2")?.textContent).toBe("Wish list");
    expect(wish?.textContent).toContain(
      "Owner wish list · as of 2026-11-04 · Manual import · 1 snapshot"
    );
    const momentum = card(container, "Momentum");
    expect(momentum?.textContent).toContain("Adapter import · 4 snapshots");
    const nvda = row(wish, "NVDA");
    expect(
      [...(nvda?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent)
    ).toEqual([
      "1",
      "Strong buy",
      "210.50",
      "Technology",
      "Not screened yet. Select Run screen.",
    ]);
    expect(nvda?.querySelector("th span")?.getAttribute("title")).toBe(
      "Data center demand"
    );
    const zzz = row(wish, "ZZZ");
    expect(zzz?.querySelector("th span")?.hasAttribute("title")).toBe(false);
    expect(
      [...(zzz?.querySelectorAll("td") ?? [])]
        .slice(0, 4)
        .map((cell) => cell.textContent)
    ).toEqual([
      "No rank in import",
      "No rating in import",
      "No target in import",
      "Not in import",
    ]);
  });

  it("explains how to import when there are no lists", async () => {
    const container = await render(
      <PickListsWorkspace gateway={fakeGateway({ list: async () => [] })} />
    );
    expect(container.textContent).toContain("No pick lists. Import one above.");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("reloads the lists after a manual import", async () => {
    const gateway = fakeGateway({ list: vi.fn(async () => []) });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    await setValue(container.querySelector('input[maxlength="80"]'), "Wish");
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(area, "AAPL");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonByText(container, "Preview"));
    await click(buttonByText(container, "Save list"));
    expect(gateway.import).toHaveBeenCalledTimes(1);
    expect(gateway.list).toHaveBeenCalledTimes(2);
  });

  it("reports a list failure and retries", async () => {
    const list = vi
      .fn<PickListGateway["list"]>()
      .mockRejectedValueOnce({ code: "FORBIDDEN" })
      .mockResolvedValueOnce([pickList()]);
    const container = await render(
      <PickListsWorkspace gateway={fakeGateway({ list })} />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Operator access required."
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click(buttonByText(container, "Retry"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(card(container, "Wish list")).not.toBeNull();
  });

  it("uses the browser gateway when none is supplied", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const container = await render(<PickListsWorkspace />);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Request failed. Retry."
    );
  });

  it("runs the screen and shows gates, status and quadrants per member", async () => {
    const pending = deferred<PickListScreenOutput>();
    const gateway = fakeGateway({ screen: () => pending.promise });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    const wish = card(container, "Wish list");
    await click(buttonByText(wish as Element, "Run screen"));
    const running = buttonByText(wish as Element, "Screening");
    expect(running?.disabled).toBe(true);
    expect(running?.getAttribute("aria-busy")).toBe("true");
    expect(row(wish, "NVDA")?.querySelectorAll("td")[4]?.textContent).toBe(
      "Screening now."
    );
    await act(async () =>
      pending.resolve({
        ...screenResult,
        members: [
          ...screenResult.members,
          screened("ZZZ", {
            gates: {
              aboveVwap20: gate(null, "no bars"),
              emaTrend: gate(null, "no bars"),
              notOverextended: gate(null, "no bars"),
            },
            last: null,
            lastDate: null,
            quadrant: null,
            reason: "Yahoo chart returned HTTP 404",
            sectorEtf: null,
            sectorQuadrant: null,
            status: "no_data",
          }),
        ],
      })
    );
    await settle();
    expect(wish?.textContent).toContain(
      "Screened 2026-11-05T14:00:00.000Z from daily bars."
    );
    expect(buttonByText(wish as Element, "Run screen")?.disabled).toBe(false);
    expect(buttonByText(wish as Element, "Screening")).toBeUndefined();

    const nvda = row(wish, "NVDA");
    expect(
      [...(nvda?.querySelectorAll("[data-gate]") ?? [])].map((badge) => [
        badge.getAttribute("data-gate"),
        badge.getAttribute("data-verdict"),
      ])
    ).toEqual([
      ["emaTrend", "pass"],
      ["aboveVwap20", "pass"],
      ["notOverextended", "pass"],
    ]);
    const ema = nvda?.querySelector('[data-gate="emaTrend"]');
    expect(ema?.getAttribute("title")).toBe(
      "EMA 20 over EMA 50 trend: close 100.00 > EMA20 95.00 > EMA50 90.00"
    );
    expect(ema?.textContent).toBe(
      "EMA 20 over EMA 50 trend pass: close 100.00 > EMA20 95.00 > EMA50 90.00"
    );
    expect(nvda?.textContent).toContain("TechnologyXLK");
    expect(nvda?.querySelector('[data-status="success"]')?.textContent).toBe(
      "Status:Pass"
    );
    const nvdaCells = nvda?.querySelectorAll("td");
    expect(nvdaCells?.[6]?.textContent).toBe("Leading");
    expect(nvdaCells?.[7]?.textContent).toBe("Improving");

    const xom = row(wish, "XOM");
    expect(
      xom?.querySelector('[data-gate="emaTrend"]')?.getAttribute("data-verdict")
    ).toBe("fail");
    const xomStatus = xom?.querySelector('[data-status="destructive"]');
    expect(xomStatus?.textContent).toBe("Status:Fail");
    expect(xomStatus?.hasAttribute("title")).toBe(false);
    expect(xom?.querySelectorAll("td")[6]?.textContent).toBe(
      "Not computed; the server sent no reason"
    );
    expect(xom?.querySelectorAll("td")[3]?.textContent).toBe("Energy");

    const zzz = row(wish, "ZZZ");
    expect(
      zzz
        ?.querySelector('[data-gate="aboveVwap20"]')
        ?.getAttribute("data-verdict")
    ).toBe("not-evaluated");
    const zzzStatus = zzz?.querySelector('[data-status="neutral"]');
    expect(zzzStatus?.textContent).toBe("Status:No daily bars");
    expect(zzzStatus?.getAttribute("title")).toBe(
      "Yahoo chart returned HTTP 404"
    );
    expect(zzz?.textContent).toContain("Yahoo chart returned HTTP 404");
  });

  it("names the cause of each state without a verdict and of a missing quadrant", async () => {
    const gateway = fakeGateway({
      screen: async () => ({
        ...screenResult,
        members: [
          screened("NVDA", {
            gates: {
              aboveVwap20: gate(true, "close 100.00 >= VWAP20 98.00"),
              emaTrend: gate(null, "Not enough history (28 bars, needs 50)"),
              notOverextended: gate(true, "close 100.00 <= 105.00"),
            },
            quadrant: null,
            quadrantReason: "Too few daily bars shared with SPY",
            sectorQuadrant: null,
            sectorQuadrantReason: "XLK bars not loaded",
            status: "not_evaluated",
          }),
          screened("ZZZ", {
            gates: {
              aboveVwap20: gate(null, "No volume in the last 20 bars"),
              emaTrend: gate(true, "close 100.00 > EMA20 95.00 > EMA50 90.00"),
              notOverextended: gate(true, "close 100.00 <= 105.00"),
            },
            status: "not_evaluated",
          }),
          screened("XOM", {
            reason: "Not screened: first 60 members per run",
            status: "not_screened",
          }),
        ],
      }),
    });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    const wish = card(container, "Wish list");
    await click(buttonByText(wish as Element, "Run screen"));
    const nvda = [...(row(wish, "NVDA")?.querySelectorAll("td") ?? [])].map(
      (cell) => cell.textContent
    );
    expect(nvda.slice(5)).toEqual([
      "Status:Gate not evaluatedEMA 20 over EMA 50 trend: Not enough history (28 bars, needs 50)",
      "Too few daily bars shared with SPY",
      "XLK bars not loaded",
    ]);
    expect(row(wish, "XOM")?.querySelectorAll("td")[5]?.textContent).toBe(
      "Status:Not screened (over run limit)Not screened: first 60 members per run"
    );
    // Enough bars but no volume: the badge detail gives that cause, not a history cause.
    expect(row(wish, "ZZZ")?.querySelectorAll("td")[5]?.textContent).toBe(
      "Status:Gate not evaluatedAbove 20-day VWAP: No volume in the last 20 bars"
    );
  });

  it("leaves members missing from the screen result unscreened", async () => {
    const container = await render(
      <PickListsWorkspace gateway={fakeGateway()} />
    );
    const wish = card(container, "Wish list");
    await click(buttonByText(wish as Element, "Run screen"));
    expect(row(wish, "ZZZ")?.querySelectorAll("td")[4]?.textContent).toBe(
      "Not screened: this member is not in the last screen result. Run the screen again."
    );
  });

  it("reports a screen failure", async () => {
    const gateway = fakeGateway({
      screen: async () => {
        throw { code: "NOT_FOUND" };
      },
    });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    const wish = card(container, "Wish list");
    await click(buttonByText(wish as Element, "Run screen"));
    expect(wish?.querySelector('[role="alert"]')?.textContent).toBe(
      "Pick list no longer exists. Reload the page."
    );
    expect(row(wish, "NVDA")?.querySelectorAll("td")[4]?.textContent).toBe(
      "Not screened: the last screen run failed. See the message above this table."
    );
  });

  it("makes a bucket from the list and then links to it", async () => {
    const pending = deferred<PickListBucketResult>();
    const gateway = fakeGateway({
      list: async () => [
        pickList(),
        pickList({ id: "list-2", name: "Momentum", slug: "momentum" }),
      ],
      syncBucket: vi.fn(() => pending.promise),
    });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    const wish = card(container, "Wish list");
    const form = wish?.querySelector(
      'form[aria-label="Make bucket from Wish list"]'
    );
    const input = form?.querySelector("input");
    expect(input?.value).toBe("WISHLIST");

    await setValue(input, "1bad");
    expect(input?.value).toBe("1BAD");
    await submit(form);
    expect(gateway.syncBucket).not.toHaveBeenCalled();
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Use a letter, then up to 9 letters or digits."
    );

    await setValue(input, "wish");
    await submit(form);
    expect(gateway.syncBucket).toHaveBeenCalledWith("list-1", "WISH");
    expect(input?.hasAttribute("aria-invalid")).toBe(false);
    expect(buttonByText(form as Element, "Making bucket")?.disabled).toBe(true);

    await act(async () =>
      pending.resolve({
        basketId: "basket-1",
        list: pickList({ bucketSymbol: "WISH", snapshotCount: 2 }),
        memberCount: 50,
        omitted: ["AAA", "BBB"],
      })
    );
    await settle();
    expect(wish?.querySelector('[role="status"]')?.textContent).toBe(
      "Bucket WISH holds 50 members. 2 omitted (a basket holds at most 50): AAA, BBB."
    );
    const link = wish?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/baskets?symbol=WISH");
    expect(link?.textContent).toBe("Bucket WISH");
    expect(wish?.textContent).toContain("2 snapshots");
    expect(wish?.querySelector("form")).toBeNull();
    expect(
      card(container, "Momentum")?.querySelector("form input")
    ).toHaveProperty("value", "MOMENTUM");
  });

  it("refreshes an existing bucket and reports a conflict", async () => {
    const syncBucket = vi
      .fn<PickListGateway["syncBucket"]>()
      .mockResolvedValueOnce({
        basketId: "basket-1",
        list: pickList({ bucketSymbol: "MOMO" }),
        memberCount: 3,
        omitted: [],
      })
      .mockRejectedValueOnce({ code: "CONFLICT" });
    const gateway = fakeGateway({
      list: async () => [pickList({ bucketSymbol: "MOMO" })],
      syncBucket,
    });
    const container = await render(<PickListsWorkspace gateway={gateway} />);
    const wish = card(container, "Wish list");
    const refresh = wish?.querySelector(
      'button[aria-label="Refresh bucket MOMO from the latest snapshot"]'
    );
    await click(refresh);
    expect(syncBucket).toHaveBeenCalledWith("list-1", "MOMO");
    expect(wish?.querySelector('[role="status"]')?.textContent).toBe(
      "Bucket MOMO holds 3 members."
    );
    await click(refresh);
    expect(wish?.querySelector('[role="alert"]')?.textContent).toBe(
      "Another basket already uses this symbol. Choose another."
    );
  });
});
