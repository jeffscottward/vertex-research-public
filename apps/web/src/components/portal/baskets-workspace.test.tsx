// @vitest-environment jsdom
import type {
  BasketCreateInput,
  BasketOutput,
  BasketUpdateInput,
  BasketValuationOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BasketChart, linePath } from "./basket-chart.tsx";
import { BasketWatchlistSection } from "./basket-watchlist-section.tsx";
import {
  type BasketGateway,
  createBasketGateway,
  createBrowserBasketGateway,
  describeBasketFailure,
  equalWeights,
  formatIndex,
  formatPct,
} from "./baskets-client.ts";
import { BasketsWorkspace } from "./baskets-workspace.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/baskets");
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  return container;
};
const settle = async () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

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
const buttonByText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text)
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

const at = new Date("2026-10-23T00:00:00Z");
const basket = (
  symbol: string,
  baseDate: string | null = null
): BasketOutput => ({
  baseDate,
  baseValue: "100",
  createdAt: at,
  id: `id-${symbol}`,
  members: [
    { basePrice: null, sharesAtBase: null, symbol: "VSCO", weight: "0.5" },
    { basePrice: null, sharesAtBase: null, symbol: "AVTR", weight: "0.5" },
  ],
  name: `${symbol} name`,
  symbol,
  updatedAt: at,
});
const valuation = (
  item: BasketOutput,
  overrides: Partial<BasketValuationOutput> = {}
): BasketValuationOutput => ({
  baseDate: "2026-10-21",
  baseState: "fixed",
  basket: item,
  benchmarkSymbol: "SPY",
  computedAt: at.toISOString(),
  latest: {
    benchmark: 102,
    changePct: 4,
    date: "2026-10-23",
    dayChangePct: -1.5,
    value: 104,
  },
  members: [
    {
      basePrice: 20,
      contribution: 5,
      lastDate: "2026-10-23",
      lastPrice: 22,
      returnPct: 10,
      stale: false,
      symbol: "VSCO",
      weight: 0.5,
    },
    {
      basePrice: 10,
      contribution: -1,
      lastDate: "2026-10-22",
      lastPrice: 9.8,
      returnPct: -2,
      stale: true,
      symbol: "AVTR",
      weight: 0.5,
    },
  ],
  points: [
    {
      benchmark: 100,
      date: "2026-10-21",
      missing: [],
      stale: false,
      value: 100,
    },
    {
      benchmark: 101,
      date: "2026-10-22",
      missing: ["AVTR"],
      stale: true,
      value: null,
    },
    {
      benchmark: 102,
      date: "2026-10-23",
      missing: [],
      stale: false,
      value: 104,
    },
  ],
  staleSymbols: ["AVTR"],
  unavailable: [{ reason: "pacing", symbol: "SPY" }],
  ...overrides,
});

const fakeGateway = (items: BasketOutput[]) => {
  const rows = [...items];
  const gateway = {
    create: vi.fn(async (input: BasketCreateInput) => {
      const created = { ...basket(input.symbol), name: input.name };
      rows.push(created);
      return created;
    }),
    list: vi.fn(async () => [...rows]),
    remove: vi.fn(async (id: string) => {
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1
      );
    }),
    update: vi.fn(async (input: BasketUpdateInput) => {
      const found = rows.find((row) => row.id === input.id) as BasketOutput;
      return { ...found, name: input.name ?? found.name };
    }),
    valuation: vi.fn(async (id: string) =>
      valuation(
        rows.find((row) => row.id === id) ?? basket(id.replace("id-", ""))
      )
    ),
  };
  return gateway satisfies BasketGateway;
};

describe("basket client helpers", () => {
  it("formats values and builds equal weights that sum to exactly 1", () => {
    expect(equalWeights(3)).toEqual(["0.33333333", "0.33333333", "0.33333334"]);
    expect(equalWeights(0)).toEqual([]);
    expect(formatIndex(null)).toBe("—");
    expect(formatIndex(104.256)).toBe("104.26");
    expect(formatPct(null)).toBe("—");
    expect(formatPct(4)).toBe("+4.00%");
    expect(formatPct(-1.5)).toBe("-1.50%");
  });

  it("describes typed failures", () => {
    const cases: [unknown, string][] = [
      [{ code: "UNAUTHORIZED" }, "Session expired"],
      [{ code: "FORBIDDEN" }, "Operator access"],
      [{ code: "NOT_FOUND" }, "no longer exists"],
      [{ code: "CONFLICT" }, "already exists"],
      [
        { code: "VALIDATION_ERROR", message: "weights must sum to 1" },
        "weights must sum to 1",
      ],
      [{ code: "BAD_REQUEST", message: "" }, "invalid input"],
      [{ code: "STORAGE_ERROR" }, "503"],
      [new Error("x"), "Request failed"],
      [null, "Request failed"],
    ];
    for (const [error, text] of cases) {
      expect(describeBasketFailure(error)).toContain(text);
    }
  });

  it("maps gateway calls to the oRPC client", async () => {
    const client = {
      baskets: {
        create: vi.fn(async () => basket("TITY")),
        list: vi.fn(async () => ({ items: [basket("TITY")] })),
        remove: vi.fn(async () => ({ id: "id-TITY", removed: true })),
        update: vi.fn(async () => basket("TITY")),
        valuation: vi.fn(async () => valuation(basket("TITY"))),
      },
    };
    const gateway = createBasketGateway(
      client as unknown as Parameters<typeof createBasketGateway>[0]
    );
    expect(await gateway.list()).toHaveLength(1);
    await gateway.create({ members: [], name: "T", symbol: "TITY" });
    await gateway.update({ id: "id-TITY", name: "T" });
    await expect(gateway.remove("id-TITY")).resolves.toBeUndefined();
    await gateway.valuation("id-TITY");
    expect(client.baskets.valuation).toHaveBeenCalledWith({ id: "id-TITY" });
  });

  it("creates the browser gateway lazily against the page origin", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("offline"));
    const gateway = createBrowserBasketGateway();
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const call of [
      () => gateway.list(),
      () => gateway.create({ members: [], name: "T", symbol: "T" }),
      () => gateway.update({ id: "x", name: "n" }),
      () => gateway.remove("x"),
      () => gateway.valuation("x"),
    ]) {
      await expect(call()).rejects.toBeDefined();
    }
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("BasketChart", () => {
  it("draws gaps for stale dates and handles flat or single-point series", () => {
    expect(linePath([1, null, 3], 1, 3)).toMatch(/^M8\.0,232\.0 M632\.0,8\.0$/);
    expect(linePath([5], 5, 5)).toBe("M8.0,232.0");
  });

  it("renders an empty message without data", async () => {
    const container = await render(
      <BasketChart
        benchmarkSymbol="SPY"
        points={[
          {
            benchmark: null,
            date: "d",
            missing: ["A"],
            stale: true,
            value: null,
          },
        ]}
        symbol="TITY"
      />
    );
    expect(container.textContent).toContain("No index history yet");
    const none = await render(
      <BasketChart benchmarkSymbol="SPY" points={[]} symbol="X" />
    );
    expect(none.textContent).toContain("No index history yet");
  });
});

describe("BasketsWorkspace", () => {
  it("opens the requested basket and shows value, staleness, chart and contributions", async () => {
    const gateway = fakeGateway([basket("AAA"), basket("TITY", "2026-10-21")]);
    const container = await render(
      <BasketsWorkspace gateway={gateway} initialBasket="tity" />
    );
    expect(gateway.valuation).toHaveBeenCalledWith("id-TITY");
    expect(
      container.querySelector('[data-testid="basket-latest-value"]')
        ?.textContent
    ).toContain("104.00");
    expect(container.textContent).toContain("Since base+4.00%");
    expect(container.textContent).toContain("Day change-1.50%");
    expect(container.textContent).toContain("SPY 102.00");
    expect(
      container.querySelector('[data-testid="baskets-status"]')?.textContent
    ).toContain("2 baskets");
    expect(container.querySelector("h1")?.textContent).toBe("Baskets");
    expect(window.location.search).toBe("?basket=TITY");
    expect(
      [
        ...container.querySelectorAll(
          '[data-slot="table-scroll"] [data-slot="ticker-link"]'
        ),
      ].map((link) => link.getAttribute("href"))
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-slot="panel"] h2')?.textContent
    ).toContain("TITY");
    expect(container.textContent).toContain("Stale: AVTR");
    expect(container.textContent).toContain(
      "History unavailable: SPY (pacing)"
    );
    expect(container.textContent).toContain("Base date 2026-10-21");
    expect(
      container.querySelector('svg[role="img"]')?.getAttribute("aria-label")
    ).toContain("TITY index versus SPY");
    const rows = [...container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent
    );
    expect(rows[0]).toContain("VSCO");
    expect(rows[0]).toContain("+5.00");
    expect(rows[1]).toContain("stale");
    expect(rows[1]).toContain("-1.00");
  });

  it("selects from ?basket= by id or name, defaults to the first and keeps the URL in sync", async () => {
    window.history.replaceState(null, "", "/baskets?symbol=OLD&view=x");
    const gateway = fakeGateway([basket("AAA"), basket("BBB")]);
    await render(<BasketsWorkspace gateway={gateway} initialBasket="id-BBB" />);
    expect(gateway.valuation).toHaveBeenLastCalledWith("id-BBB");
    expect(window.location.search).toBe("?view=x&basket=BBB");

    await render(
      <BasketsWorkspace gateway={gateway} initialBasket="bbb NAME" />
    );
    expect(gateway.valuation).toHaveBeenLastCalledWith("id-BBB");

    const fallback = await render(
      <BasketsWorkspace gateway={gateway} initialBasket="   " />
    );
    expect(gateway.valuation).toHaveBeenLastCalledWith("id-AAA");
    await click(buttonByText(fallback, "BBB"));
    expect(window.location.search).toBe("?view=x&basket=BBB");
    expect(buttonByText(fallback, "BBB")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
  });

  it("shows Loading and Unavailable in the status chip", async () => {
    const gateway = fakeGateway([]);
    gateway.list.mockReturnValueOnce(new Promise(() => undefined));
    const loading = await render(<BasketsWorkspace gateway={gateway} />);
    expect(
      loading.querySelector('[data-testid="baskets-status"]')?.textContent
    ).toContain("Loading");
    gateway.list.mockRejectedValueOnce({ code: "STORAGE_ERROR" });
    const failed = await render(<BasketsWorkspace gateway={gateway} />);
    expect(
      failed.querySelector('[data-testid="baskets-status"]')?.textContent
    ).toContain("Unavailable");
    const one = await render(
      <BasketsWorkspace gateway={fakeGateway([basket("ONE")])} />
    );
    expect(
      one.querySelector('[data-testid="baskets-status"]')?.textContent
    ).toContain("1 basket");
  });

  it("shows provisional and pending states and null contributions", async () => {
    const item = basket("TITY");
    const gateway = fakeGateway([item]);
    gateway.valuation.mockResolvedValueOnce(
      valuation(item, {
        baseDate: null,
        baseState: "provisional",
        latest: null,
        members: [
          {
            basePrice: null,
            contribution: null,
            lastDate: null,
            lastPrice: null,
            returnPct: null,
            stale: false,
            symbol: "VSCO",
            weight: 1,
          },
        ],
        staleSymbols: [],
        unavailable: [],
      })
    );
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    expect(container.textContent).toContain("Provisional base");
    expect(container.textContent).toContain("Last close —");
    expect(container.querySelector('[data-slot="kpi-row"]')).toBeNull();
    expect(container.querySelector("tbody tr")?.textContent).toContain("—");
    gateway.valuation.mockResolvedValueOnce(
      valuation(item, { baseDate: null, baseState: "pending" })
    );
    await click(buttonByText(container, "TITY"));
    expect(container.textContent).toContain("Base pending");
  });

  it("reports list and valuation failures", async () => {
    const gateway = fakeGateway([basket("TITY")]);
    gateway.list.mockRejectedValueOnce({ code: "FORBIDDEN" });
    const failed = await render(<BasketsWorkspace gateway={gateway} />);
    expect(failed.textContent).toContain("Operator access required.");

    gateway.valuation.mockRejectedValueOnce({ code: "STORAGE_ERROR" });
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "503"
    );
  });

  it("ignores valuation responses for a basket that is no longer selected", async () => {
    for (const settleLate of ["resolve", "reject"] as const) {
      const gateway = fakeGateway([basket("AAA"), basket("BBB")]);
      const slow = deferred<BasketValuationOutput>();
      gateway.valuation.mockReturnValueOnce(slow.promise);
      const container = await render(<BasketsWorkspace gateway={gateway} />);
      await click(buttonByText(container, "BBB"));
      await act(async () => {
        if (settleLate === "resolve") slow.resolve(valuation(basket("AAA")));
        else slow.reject({ code: "STORAGE_ERROR" });
      });
      await settle();
      expect(container.querySelector("h2")?.textContent).toContain("BBB");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
  });

  it("shows loading while the valuation is pending and an empty state without baskets", async () => {
    const gateway = fakeGateway([basket("TITY")]);
    gateway.valuation.mockReturnValueOnce(new Promise(() => undefined));
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    expect(container.textContent).toContain("Loading index");
    const empty = await render(<BasketsWorkspace gateway={fakeGateway([])} />);
    expect(empty.textContent).toContain("No baskets yet.");
  });

  it("creates a basket with equal weights and validates the weight sum", async () => {
    const gateway = fakeGateway([]);
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    await click(buttonByText(container, "New basket"));
    const form = container.querySelector("form") as HTMLFormElement;
    const inputs = () => [...form.querySelectorAll("input")];
    await setValue(inputs()[0], "tity");
    await setValue(inputs()[1], "TITY");
    await setValue(inputs()[2], "vsco");
    await setValue(inputs()[3], "0.4");
    await setValue(inputs()[4], "esta");
    await setValue(inputs()[5], "abc");
    await click(buttonByText(container, "Add member"));
    await setValue(inputs()[6], "avtr");
    await setValue(inputs()[7], "0.1");
    await act(async () => form.requestSubmit());
    await settle();
    expect(container.textContent).toContain("Weights must sum to 1");
    expect(gateway.create).not.toHaveBeenCalled();

    await click(buttonByText(container, "Equal weights"));
    expect(inputs()[7]?.value).toBe("0.33333334");
    await click(container.querySelector('[aria-label="Remove member 3"]'));
    await click(buttonByText(container, "Equal weights"));
    await act(async () => form.requestSubmit());
    await settle();
    expect(gateway.create).toHaveBeenCalledWith({
      members: [
        { symbol: "VSCO", weight: "0.50000000" },
        { symbol: "ESTA", weight: "0.50000000" },
      ],
      name: "TITY",
      symbol: "TITY",
    });
    expect(container.querySelector("form")).toBeNull();
    expect(gateway.valuation).toHaveBeenCalledWith("id-TITY");
  });

  it("shows a save failure and can cancel the form", async () => {
    const gateway = fakeGateway([]);
    gateway.create.mockRejectedValueOnce({ code: "CONFLICT" });
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    await click(buttonByText(container, "New basket"));
    const form = container.querySelector("form") as HTMLFormElement;
    const inputs = [...form.querySelectorAll("input")];
    await setValue(inputs[0], "TITY");
    await setValue(inputs[1], "TITY");
    await setValue(inputs[2], "A");
    await setValue(inputs[3], "0.5");
    await setValue(inputs[4], "B");
    await setValue(inputs[5], "0.5");
    await act(async () => form.requestSubmit());
    await settle();
    expect(container.textContent).toContain("already exists");
    await click(buttonByText(container, "Cancel"));
    expect(container.querySelector("form")).toBeNull();
  });

  it("edits an existing basket and deletes after confirmation", async () => {
    const gateway = fakeGateway([basket("TITY", "2026-10-21"), basket("ZZZ")]);
    const container = await render(<BasketsWorkspace gateway={gateway} />);
    await click(container.querySelector('[aria-label="Edit TITY"]'));
    expect(container.textContent).toContain("Changing members resets the base");
    const form = container.querySelector("form") as HTMLFormElement;
    await setValue(form.querySelectorAll("input")[1], "Renamed");
    await act(async () => form.requestSubmit());
    await settle();
    // Unchanged members are not sent, so a rename keeps the fixed base.
    expect(gateway.update).toHaveBeenCalledWith({
      id: "id-TITY",
      name: "Renamed",
    });
    await click(container.querySelector('[aria-label="Edit TITY"]'));
    const again = container.querySelector("form") as HTMLFormElement;
    await setValue(again.querySelectorAll("input")[3], "0.4");
    await setValue(again.querySelectorAll("input")[5], "0.6");
    await act(async () => again.requestSubmit());
    await settle();
    expect(gateway.update).toHaveBeenLastCalledWith({
      id: "id-TITY",
      members: [
        { symbol: "VSCO", weight: "0.4" },
        { symbol: "AVTR", weight: "0.6" },
      ],
      name: "TITY name",
    });

    await click(container.querySelector('[aria-label="Delete ZZZ"]'));
    await click(container.querySelector('[aria-label="Confirm delete ZZZ"]'));
    expect(gateway.remove).toHaveBeenCalledWith("id-ZZZ");
    expect(container.querySelector('[aria-label="Delete ZZZ"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="basket-latest-value"]')
    ).not.toBeNull();

    await click(container.querySelector('[aria-label="Delete TITY"]'));
    await click(container.querySelector('[aria-label="Confirm delete TITY"]'));
    expect(
      container.querySelector('[data-testid="basket-latest-value"]')
    ).toBeNull();
    expect(window.location.search).toBe("");

    gateway.list.mockResolvedValueOnce([basket("QQQ")]);
    gateway.remove.mockRejectedValueOnce({ code: "NOT_FOUND" });
    const other = await render(<BasketsWorkspace gateway={gateway} />);
    await click(other.querySelector('[aria-label="Delete QQQ"]'));
    await click(other.querySelector('[aria-label="Confirm delete QQQ"]'));
    expect(other.textContent).toContain("no longer exists");
  });
});

describe("BasketWatchlistSection", () => {
  it("lists baskets with their latest index value and stale flag", async () => {
    const gateway = fakeGateway([basket("TITY"), basket("ZZZ")]);
    gateway.valuation.mockImplementation(async (id: string) =>
      id === "id-ZZZ"
        ? Promise.reject(new Error("down"))
        : valuation(basket("TITY"))
    );
    const container = await render(
      <BasketWatchlistSection gateway={gateway} />
    );
    const items = [...container.querySelectorAll("li")].map(
      (li) => li.textContent
    );
    expect(items[0]).toContain("104.00 (+4.00%)");
    expect(items[0]).toContain("stale");
    expect(items[1]).toContain("— (—)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/baskets?symbol=TITY"
    );
  });

  it("shows loading, nothing without baskets, and list failures", async () => {
    const pending = fakeGateway([basket("TITY")]);
    pending.valuation.mockReturnValue(new Promise(() => undefined));
    const loading = await render(<BasketWatchlistSection gateway={pending} />);
    expect(loading.querySelector("li")?.textContent).toContain("…");

    const fresh = fakeGateway([basket("TITY")]);
    fresh.valuation.mockResolvedValue(
      valuation(basket("TITY"), { staleSymbols: [] })
    );
    const clean = await render(<BasketWatchlistSection gateway={fresh} />);
    expect(clean.textContent).not.toContain("stale");

    const empty = await render(
      <BasketWatchlistSection gateway={fakeGateway([])} />
    );
    expect(empty.textContent).toBe("");

    const forbidden = fakeGateway([]);
    forbidden.list.mockRejectedValue({ code: "FORBIDDEN" });
    const hidden = await render(<BasketWatchlistSection gateway={forbidden} />);
    expect(hidden.textContent).toBe("");

    const failing = fakeGateway([]);
    failing.list.mockRejectedValue({ code: "STORAGE_ERROR" });
    const failed = await render(<BasketWatchlistSection gateway={failing} />);
    expect(failed.textContent).toContain("Baskets: Basket storage unavailable");
  });

  it("stops updating after unmount", async () => {
    const listed = deferred<BasketOutput[]>();
    const listGate = fakeGateway([]);
    listGate.list.mockReturnValue(listed.promise);
    const first = await render(<BasketWatchlistSection gateway={listGate} />);
    await act(async () => roots.at(-1)?.unmount());
    roots.pop();
    listed.resolve([basket("TITY")]);
    await settle();
    expect(first.textContent).toBe("");

    const valued = deferred<BasketValuationOutput>();
    const valueGate = fakeGateway([basket("TITY")]);
    valueGate.valuation.mockReturnValue(valued.promise);
    const second = await render(<BasketWatchlistSection gateway={valueGate} />);
    await act(async () => roots.at(-1)?.unmount());
    roots.pop();
    valued.resolve(valuation(basket("TITY")));
    await settle();
    expect(second.textContent).toBe("");

    const rejectGate = fakeGateway([]);
    const failing = deferred<BasketOutput[]>();
    rejectGate.list.mockReturnValue(failing.promise);
    await render(<BasketWatchlistSection gateway={rejectGate} />);
    await act(async () => roots.at(-1)?.unmount());
    roots.pop();
    failing.reject({ code: "FORBIDDEN" });
    await settle();
  });
});

describe("default browser gateway", () => {
  it("is used when no gateway is supplied", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("offline"));
    const workspace = await render(<BasketsWorkspace />);
    const section = await render(<BasketWatchlistSection />);
    await settle();
    expect(fetchSpy).toHaveBeenCalled();
    expect(workspace.textContent).toContain("Request failed");
    expect(section.textContent).toContain("Baskets: Request failed");
    fetchSpy.mockRestore();
  });
});
