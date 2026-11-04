// @vitest-environment jsdom
import type {
  SectorRotationMapInput,
  SectorRotationMapOutput,
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

import {
  SECTORS_PRESET,
  type SectorRotationGateway,
  type SectorRotationUniversePreset,
} from "./sector-rotation-client.ts";
import {
  laggardSeries,
  leaderSeries,
  mapFixture,
} from "./sector-rotation-test-fixtures.ts";
import {
  formatPeriods,
  PLAY_STEP_MS,
  rowsAt,
  SectorRotationWorkspace,
  unionDates,
} from "./sector-rotation-workspace.tsx";

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
  vi.useRealTimers();
  return document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const WATCHLIST: SectorRotationUniversePreset = {
  id: "watchlist",
  label: "Watchlist (2)",
  universe: { kind: "custom", symbols: ["AAPL", "MSFT"] },
};

const gatewayWith = (
  map: (input: SectorRotationMapInput) => Promise<SectorRotationMapOutput>,
  universes: SectorRotationGateway["universes"] = async () => [
    SECTORS_PRESET,
    WATCHLIST,
  ]
): SectorRotationGateway => ({ map: vi.fn(map), universes: vi.fn(universes) });

const render = async (gateway: SectorRotationGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<SectorRotationWorkspace gateway={gateway} />);
    return await flush();
  });
  return container;
};

const act$ = async (run: () => void) =>
  await act(async () => {
    run();
    return await flush();
  });

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent === text ||
      element.getAttribute("aria-label") === text
  );

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  return await act$(() => (element as HTMLElement).click());
};

const setValue = async (
  element: Element | null | undefined,
  value: string,
  event: "change" | "input"
) => {
  expect(element).toBeTruthy();
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  return await act$(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element?.dispatchEvent(new Event(event, { bubbles: true }));
  });
};

const selects = (container: HTMLElement) => [
  ...container.querySelectorAll("select"),
];
const scrub = (container: HTMLElement, index: number) =>
  setValue(
    container.querySelector('input[type="range"]'),
    String(index),
    "input"
  );
const row = (container: HTMLElement, symbol: string) =>
  [...(container.querySelector(`[data-row="${symbol}"]`)?.children ?? [])].map(
    (cell) => cell.textContent
  );

describe("sector rotation workspace helpers", () => {
  it("lists every date once, oldest first", () => {
    expect(unionDates([laggardSeries(), leaderSeries()])).toEqual([
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ]);
    return expect(unionDates([])).toEqual([]);
  });

  it("computes values and the quadrant streak at a date", () => {
    const series = [leaderSeries(), laggardSeries()];
    expect(rowsAt(series, null)).toEqual([
      expect.objectContaining({
        periods: 2,
        since: "2026-10-23",
        symbol: "XLK",
      }),
      expect.objectContaining({
        periods: 1,
        since: "2026-10-30",
        symbol: "XLE",
      }),
    ]);
    expect(rowsAt(series, "2026-10-23")).toEqual([
      expect.objectContaining({ periods: 1, since: "2026-10-23" }),
      expect.objectContaining({ periods: 2, since: "2026-10-16" }),
    ]);
    return expect(rowsAt(series, "2026-10-09")[1]).toEqual({
      name: null,
      periods: 0,
      point: null,
      since: null,
      symbol: "XLE",
    });
  });

  return it("formats streak lengths with their unit", () => {
    expect(formatPeriods(1, "daily")).toBe("1 day");
    expect(formatPeriods(3, "daily")).toBe("3 days");
    expect(formatPeriods(1, "weekly")).toBe("1 week");
    return expect(formatPeriods(2, "weekly")).toBe("2 weeks");
  });
});

describe("SectorRotationWorkspace", () => {
  it("renders the stored weekly sector map, the table and the method note", async () => {
    const gateway = gatewayWith(async () => mapFixture());
    const container = await render(gateway);
    expect(gateway.map).toHaveBeenCalledWith({
      timeframe: "weekly",
      universe: { kind: "sectors" },
    });
    const text = container.textContent;
    expect(text).toContain(
      "Our own relative strength ratio and momentum, both centered on 100. Not the RRG® / JdK algorithm. Research only."
    );
    expect(text).toContain(
      "Stored nightly. As of 2026-10-30 against SPY. Generated 2026-10-30T22:00:00.000Z."
    );
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
    expect(row(container, "XLK")).toEqual([
      "XLK",
      "Technology",
      "101.25",
      "101.50",
      "Leading",
      "2 weeks",
      "2026-10-23",
    ]);
    expect(row(container, "XLE")).toEqual([
      "XLE",
      "–",
      "98.60",
      "100.20",
      "Improving",
      "1 week",
      "2026-10-30",
    ]);
    expect(button(container, "Weekly")?.getAttribute("aria-selected")).toBe(
      "true"
    );
    return expect(
      selects(container)[0]?.querySelectorAll("option")
    ).toHaveLength(3);
  });

  it("reloads on a timeframe switch", async () => {
    const gateway = gatewayWith(async (input) =>
      mapFixture({ timeframe: input.timeframe ?? "weekly" })
    );
    const container = await render(gateway);
    await click(button(container, "Daily"));
    expect(gateway.map).toHaveBeenLastCalledWith({
      timeframe: "daily",
      universe: { kind: "sectors" },
    });
    expect(button(container, "Daily")?.getAttribute("aria-selected")).toBe(
      "true"
    );
    return expect(row(container, "XLK")[5]).toBe("2 days");
  });

  it("switches to a preset list and to a typed custom list", async () => {
    const gateway = gatewayWith(async () =>
      mapFixture({
        errors: [{ reason: "No bars", symbol: "ZZZZ" }],
        source: "computed",
        universe: "custom",
      })
    );
    const container = await render(gateway);
    await setValue(selects(container)[0], "watchlist", "change");
    expect(gateway.map).toHaveBeenLastCalledWith({
      timeframe: "weekly",
      universe: { kind: "custom", symbols: ["AAPL", "MSFT"] },
    });
    expect(container.textContent).toContain("Computed now.");
    expect(container.textContent).toContain("ZZZZ: No bars");
    await setValue(selects(container)[0], "custom", "change");
    expect(container.textContent).toContain(
      "Type up to 30 tickers and select Apply to draw them."
    );
    expect(gateway.map).toHaveBeenCalledTimes(2);
    const input = container.querySelector("form input");
    await click(button(container, "Apply"));
    expect(container.textContent).toContain("Type at least one ticker.");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(input?.getAttribute("aria-describedby")).toBe(
      "sector-rotation-custom-error"
    );
    await setValue(input, "nvda, amd", "input");
    await click(button(container, "Apply"));
    expect(container.textContent).not.toContain("Type at least one ticker.");
    return expect(gateway.map).toHaveBeenLastCalledWith({
      timeframe: "weekly",
      universe: { kind: "custom", symbols: ["NVDA", "AMD"] },
    });
  });

  it("falls back to the sector ETFs when the preset lists fail or omit them", async () => {
    const failing = gatewayWith(
      async () => mapFixture(),
      async () => {
        throw new Error("offline");
      }
    );
    const container = await render(failing);
    expect(selects(container)[0]?.querySelectorAll("option")).toHaveLength(2);
    const empty = gatewayWith(
      async () => mapFixture(),
      async () => []
    );
    await render(empty);
    return expect(empty.map).toHaveBeenLastCalledWith({
      timeframe: "weekly",
      universe: { kind: "sectors" },
    });
  });

  it("ignores presets that arrive after the page closed", async () => {
    let resolve: (presets: readonly SectorRotationUniversePreset[]) => void =
      () => undefined;
    const gateway = gatewayWith(
      async () => mapFixture(),
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await render(gateway);
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      resolve([SECTORS_PRESET]);
      return await flush();
    });
    return expect(gateway.universes).toHaveBeenCalledTimes(1);
  });

  it("changes table values with the scrubber and the tail length", async () => {
    const container = await render(gatewayWith(async () => mapFixture()));
    await scrub(container, 1);
    expect(container.textContent).toContain("Date 2026-10-16");
    expect(row(container, "XLK").slice(2)).toEqual([
      "99.80",
      "100.80",
      "Improving",
      "2 weeks",
      "2026-10-09",
    ]);
    expect(row(container, "XLE").slice(4)).toEqual([
      "Lagging",
      "1 week",
      "2026-10-16",
    ]);
    await scrub(container, 0);
    expect(row(container, "XLE")[2]).toBe("No data on this date");
    await setValue(selects(container)[1], "5", "change");
    return expect(container.querySelector("figcaption")?.textContent).toContain(
      "Tails show up to 5 weeks to 2026-10-09"
    );
  });

  it("plays one date per step, pauses, stops at the end and restarts", async () => {
    vi.useFakeTimers();
    const container = await render(gatewayWith(async () => mapFixture()));
    const range = () =>
      container.querySelector('input[type="range"]') as HTMLInputElement;
    // At the latest date, Play starts again from the first date.
    await click(button(container, "Play"));
    expect(range().value).toBe("0");
    await act$(() => vi.advanceTimersByTime(PLAY_STEP_MS));
    expect(range().value).toBe("1");
    await click(button(container, "Pause"));
    await act$(() => vi.advanceTimersByTime(PLAY_STEP_MS * 3));
    expect(range().value).toBe("1");
    await click(button(container, "Play"));
    await act$(() => vi.advanceTimersByTime(PLAY_STEP_MS));
    await act$(() => vi.advanceTimersByTime(PLAY_STEP_MS));
    expect(range().value).toBe("3");
    expect(button(container, "Play")).toBeTruthy();
    // Moving the scrubber stops playback.
    await click(button(container, "Play"));
    await scrub(container, 2);
    await act$(() => vi.advanceTimersByTime(PLAY_STEP_MS * 2));
    return expect(range().value).toBe("2");
  });

  it("highlights a series from its table row", async () => {
    const container = await render(gatewayWith(async () => mapFixture()));
    const xle = container.querySelector('[data-row="XLE"]');
    await act$(() =>
      xle?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    );
    expect(xle?.className).toContain("bg-muted");
    expect(container.querySelector("[data-tooltip]")).not.toBeNull();
    await act$(() =>
      xle?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    );
    expect(container.querySelector("[data-tooltip]")).toBeNull();
    const ticker = button(container, "XLK");
    await act$(() => ticker?.focus());
    expect(ticker?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-tooltip]")?.textContent).toContain(
      "XLK"
    );
    await act$(() => ticker?.blur());
    return expect(container.querySelector("[data-tooltip]")).toBeNull();
  });

  it("reports an empty map", async () => {
    const container = await render(
      gatewayWith(async () => mapFixture({ series: [] }))
    );
    expect(container.textContent).toContain(
      "No points to draw for this list yet."
    );
    return expect(container.querySelector("svg")).toBeNull();
  });

  it("shows loading, the not-collected notice and retries", async () => {
    let fail = true;
    const gateway = gatewayWith(async () => {
      if (fail)
        throw Object.assign(new Error("Sector rotation not yet collected"), {
          code: "NOT_FOUND",
        });
      return mapFixture();
    });
    const container = await render(gateway);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Sector rotation unavailable: Sector rotation not yet collected. The nightly job fills it after the US close."
    );
    fail = false;
    await click(button(container, "Try again"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const loading = await render(
      gatewayWith(() => new Promise<never>(() => undefined))
    );
    return expect(
      loading.querySelector('[role="status"]')?.textContent
    ).toContain("Loading sector rotation…");
  });

  it("keeps only the answer of the newest request", async () => {
    const pending: {
      resolve: (map: SectorRotationMapOutput) => void;
      reject: (error: Error) => void;
    }[] = [];
    const gateway = gatewayWith(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ reject, resolve });
        })
    );
    const container = await render(gateway);
    await click(button(container, "Daily"));
    await click(button(container, "Weekly"));
    await act$(() => {
      pending[0]?.resolve(mapFixture({ asOf: "2026-01-01" }));
      pending[1]?.reject(new Error("stale failure"));
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act$(() => pending[2]?.resolve(mapFixture()));
    expect(container.textContent).toContain("As of 2026-10-30");
    return expect(container.textContent).not.toContain("stale failure");
  });

  return it("creates the browser gateway when none is supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => {
        root.render(<SectorRotationWorkspace />);
        for (let index = 0; index < 200; index += 1) await Promise.resolve();
      });
      return expect(container.textContent).toMatch(
        /Loading sector rotation|Sector rotation unavailable/u
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
