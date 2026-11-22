// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type FuturesOiBar,
  futuresOiBars,
} from "../../features/charts/futures-oi.ts";
import type { DisplayCandle } from "../../features/charts/types.ts";
import {
  FuturesOiPanel,
  type FuturesOiPanelProps,
} from "./futures-oi-panel.tsx";
import type { FuturesOiSeries } from "./use-futures-oi.ts";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const mount = async (props: FuturesOiPanelProps) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<FuturesOiPanel {...props} />));
  return container;
};

const candles = (...dates: string[]): DisplayCandle[] =>
  dates.map((date) => ({
    close: 101,
    high: 102,
    id: date,
    low: 99,
    open: 100,
    timestamp: Date.parse(`${date}T00:00:00Z`),
    volume: 1000,
  }));

const POINTS = [
  { date: "2026-11-17", value: 2_119_067 },
  { date: "2026-11-18", value: 2_115_253 },
  { date: "2026-11-19", value: 2_127_055 },
];
const series = (
  points: FuturesOiSeries["points"] = POINTS
): FuturesOiSeries => ({
  firstDate: points[0]?.date ?? "2025-11-20",
  frequency: "daily",
  id: "CME_ES_OI",
  lastDate: points.at(-1)?.date ?? "2026-11-19",
  name: "ES open interest (made-up)",
  pointCount: points.length,
  points,
  source: "CME",
  unit: "contracts",
  updatedAt: new Date("2026-11-20T10:02:41Z"),
});
const ready = (
  shown: readonly DisplayCandle[],
  stored: FuturesOiSeries = series()
): FuturesOiPanelProps => ({
  bars: futuresOiBars(shown, stored.points),
  candles: shown,
  market: "ES",
  state: { series: stored, type: "ready" },
});
const texts = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((node) => node.textContent);

describe("FuturesOiPanel states", () => {
  const empty = { bars: [], candles: [], market: "ES" } as const;

  it("renders nothing when the pane is off", async () => {
    const container = await mount({ ...empty, state: { type: "off" } });
    expect(container.childElementCount).toBe(0);
  });

  it("shows the loading text", async () => {
    const container = await mount({ ...empty, state: { type: "loading" } });
    expect(texts(container)).toEqual(["Loading open interest"]);
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Futures open interest"
    );
  });

  it("shows the read failure as an alert", async () => {
    const container = await mount({ ...empty, state: { type: "error" } });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Open interest could not be read. The price chart is not affected."
    );
  });

  it("names the job when no figures are stored", async () => {
    const container = await mount({
      ...empty,
      market: "NQ",
      state: { series: null, type: "ready" },
    });
    expect(texts(container)).toEqual([
      "No CME open-interest figures are stored for NQ. The daily job cme-futures-oi stores them.",
    ]);
    expect(container.querySelector("table")).toBeNull();
  });
});

describe("FuturesOiPanel with figures", () => {
  it("states the newest figure with its change and the last write", async () => {
    const container = await mount(
      ready(candles("2026-11-17", "2026-11-18", "2026-11-19"))
    );
    expect(texts(container)).toEqual([
      "Open interest, ES futures, all contract months (CME, preliminary): 2,127,055 contracts on 2026-11-19, +11,802 against 2026-11-18.",
      "Figures last written 2026-11-20 10:02 UTC.",
    ]);
    expect(
      container
        .querySelector("[data-futures-oi]")
        ?.getAttribute("data-futures-oi")
    ).toBe("ES");
  });

  it("states the newest figure without a change", async () => {
    const container = await mount(ready(candles("2026-11-17")));
    expect(texts(container)[0]).toBe(
      "Open interest, ES futures, all contract months (CME, preliminary): 2,119,067 contracts on 2026-11-17."
    );
  });

  it("counts the loaded trading days after the newest figure", async () => {
    const one = await mount(
      ready(candles("2026-11-18", "2026-11-19", "2026-11-20"))
    );
    expect(texts(one)).toContain(
      "1 loaded trading day after 2026-11-19 has no CME figure yet."
    );
    const three = await mount(
      ready(candles("2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24"))
    );
    expect(texts(three)).toContain(
      "3 loaded trading days after 2026-11-19 have no CME figure yet."
    );
  });

  it("says from which date figures are stored when candles are older", async () => {
    const container = await mount(
      ready(candles("2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"))
    );
    expect(texts(container)).toContain(
      "CME figures are stored from 2026-11-17. Earlier candles have no bar."
    );
  });

  it("keeps the lines and the key, without a table, when no stored date has a candle", async () => {
    const container = await mount(ready(candles("2026-11-20")));
    expect(texts(container)).toEqual([
      "Figures last written 2026-11-20 10:02 UTC.",
      "1 loaded trading day after 2026-11-19 has no CME figure yet.",
    ]);
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("holds the reading key in a closed details element", async () => {
    const container = await mount(ready(candles("2026-11-19")));
    const key = container.querySelector("details");
    expect(key?.open).toBe(false);
    expect(key?.querySelector("summary")?.textContent).toBe(
      "How to read the bars"
    );
    expect(
      [...(key?.querySelectorAll("li") ?? [])].map((node) => node.textContent)
    ).toEqual([
      "A bar above the line: open interest rose that day. A bar below the line: it fell.",
      "The textbook reading of price and open interest together (J. J. Murphy, Technical Analysis of the Financial Markets):",
      "Price up, open interest up: new buying.",
      "Price up, open interest down: short covering.",
      "Price down, open interest up: new selling.",
      "Price down, open interest down: long liquidation.",
      "This is a reading aid, not a signal. The CME figure is preliminary; on a day with a small change the final figure can show the other direction.",
      "The first figure after a quarterly expiry (the third Friday of March, June, September and December) has no bar: the expired contract leaves the total.",
    ]);
  });

  it("lists the last 10 stored days, newest first, with words for a day without a change", async () => {
    // 2026-09-10 has a candle and no figure; 2026-09-18 is the third Friday.
    const dates = [
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ];
    const stored = series(
      dates
        .filter((date) => date !== "2026-09-10")
        .map((date, index) => ({ date, value: 1000 + index * 10 }))
    );
    const container = await mount(ready(candles(...dates), stored));
    expect(container.querySelector("caption")?.textContent).toBe(
      "Open interest by trading day (last 10 stored days)"
    );
    expect(
      container.querySelector("table")?.closest("[data-futures-oi-table]")
        ?.className
    ).toContain("overflow-x-auto");
    expect(
      [...container.querySelectorAll("thead th")].map(
        (node) => node.textContent
      )
    ).toEqual(["Date", "Open interest", "Change"]);
    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.children].map((node) => node.textContent)
    );
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual(["2026-09-23", "1,100", "+10"]);
    expect(rows[2]).toEqual(["2026-09-21", "1,080", "quarterly expiry"]);
    expect(rows[8]).toEqual([
      "2026-09-11",
      "1,020",
      "no figure for the trading day before",
    ]);
    expect(rows[9]).toEqual(["2026-09-09", "1,010", "+10"]);
  });

  it("names the first stored day in the table", async () => {
    const container = await mount(ready(candles("2026-11-17", "2026-11-18")));
    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.children].map((node) => node.textContent)
    );
    expect(rows).toEqual([
      ["2026-11-18", "2,115,253", "-3,814"],
      ["2026-11-17", "2,119,067", "first stored day"],
    ]);
  });

  it("uses the words of the first stored day for a bar without a change and without a reason", async () => {
    const bar: FuturesOiBar = {
      change: null,
      date: "2026-11-19",
      figure: 5,
      noChange: null,
      previousDate: null,
      timestamp: Date.parse("2026-11-19T00:00:00Z"),
    };
    const container = await mount({
      ...ready(candles("2026-11-19")),
      bars: [bar],
    });
    expect(container.querySelector("tbody td:last-child")?.textContent).toBe(
      "first stored day"
    );
  });
});
