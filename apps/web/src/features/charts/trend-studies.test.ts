import { readFileSync } from "node:fs";
import {
  alphaTrend,
  chandelierExit,
  slingshot,
  supertrend,
  ultimateMa,
} from "@darkfactory/shared/indicators";
import { describe, expect, it } from "vitest";
import { OVERLAY_OPTIONS } from "./chart-indicators.ts";
import { TREND_STUDIES, TREND_STUDY_IDS } from "./trend-studies.ts";
import {
  indicatorTemplate,
  VERTEX_STUDIES,
  type VertexStudy,
} from "./vertex-studies.ts";

type Reference = Readonly<{
  bars: Readonly<Record<"high" | "low" | "close" | "volume", number[]>>;
}>;
const { bars: columns } = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../services/research/tests/fixtures/trend-indicator-reference.json",
      import.meta.url
    ),
    "utf8"
  )
) as Reference;
const { high, low, close, volume } = columns;
const bars = close.map((value, index) => ({
  close: value,
  high: Number(high[index]),
  low: Number(low[index]),
  timestamp: index * 60_000,
  volume: Number(volume[index]),
}));

// Expected column: the value where `keep` holds, else left out (undefined).
const column = (
  values: Float64Array,
  keep: (index: number) => boolean = () => true
): (number | undefined)[] =>
  Array.from(values, (value, index) =>
    keep(index) && Number.isFinite(value) ? value : undefined
  );
const pick = (
  id: (typeof TREND_STUDY_IDS)[number],
  key: string,
  input: Parameters<VertexStudy["calc"]>[0] = bars
): (number | undefined)[] =>
  TREND_STUDIES[id]
    .calc(input, TREND_STUDIES[id].calcParams)
    .map((row) => row[key]);

describe("trend chart studies", () => {
  it("joins the Vertex studies and the overlay menu", () => {
    for (const id of TREND_STUDY_IDS) {
      expect(VERTEX_STUDIES[id]).toBe(TREND_STUDIES[id]);
      expect(VERTEX_STUDIES[id].placement).toBe("candle");
    }
    const labels = OVERLAY_OPTIONS.map((option) => option.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "SuperTrend 10, 3",
        "Ultimate MA SMA 20",
        "AlphaTrend 14, 1 (MFI)",
        "Chandelier Exit 22, 3",
        "Slingshot EMA 38, 62",
      ])
    );
  });

  it("SuperTrend splits the line by direction", () => {
    const st = supertrend(high, low, close, 10, 3);
    const up = (i: number) => st.direction[i] === 1;
    expect(pick("supertrend", "up")).toEqual(column(st.line, up));
    expect(pick("supertrend", "down")).toEqual(
      column(st.line, (i) => st.direction[i] === -1)
    );
    expect(pick("supertrend", "up").some((v) => v !== undefined)).toBe(true);
    expect(pick("supertrend", "down").some((v) => v !== undefined)).toBe(true);
  });

  it("Ultimate MA splits the SMA by direction", () => {
    const uma = ultimateMa(close, null, "sma", 20, 2);
    expect(pick("ultma", "rising")).toEqual(
      column(uma.value, (i) => uma.direction[i] === 1)
    );
    expect(pick("ultma", "falling")).toEqual(
      column(uma.value, (i) => uma.direction[i] === -1)
    );
  });

  it("AlphaTrend uses MFI with volume and RSI without", () => {
    const mfiLine = alphaTrend(high, low, close, volume, 14, 1, "mfi").line;
    expect(pick("alphatrend", "at")).toEqual(column(mfiLine));
    expect(pick("alphatrend", "at2")).toEqual(
      column(Float64Array.from(mfiLine, (_, i) => Number(mfiLine[i - 2])))
    );
    const noVolume = bars.map(({ volume: _, ...bar }) => bar);
    const rsiLine = alphaTrend(high, low, close, null, 14, 1, "rsi").line;
    expect(pick("alphatrend", "at", noVolume)).toEqual(column(rsiLine));
  });

  it("Chandelier Exit shows the stop of the current side", () => {
    const ce = chandelierExit(high, low, close, 22, 3);
    expect(pick("chandelier", "long")).toEqual(
      column(ce.longStop, (i) => ce.direction[i] === 1)
    );
    expect(pick("chandelier", "short")).toEqual(
      column(ce.shortStop, (i) => ce.direction[i] === -1)
    );
  });

  it("Slingshot draws both averages", () => {
    const sling = slingshot(close, 38, 62);
    expect(pick("slingshot", "fast")).toEqual(column(sling.fast));
    expect(pick("slingshot", "slow")).toEqual(column(sling.slow));
  });

  it.each(TREND_STUDY_IDS)("%s is empty for bad parameters", (id) => {
    expect(() => TREND_STUDIES[id].calc(bars.slice(0, 2), [])).toThrow(
      RangeError
    );
    const template = indicatorTemplate(
      { ...TREND_STUDIES[id], calcParams: [0, 0] },
      2
    );
    expect(template.calc(bars.slice(0, 2))).toEqual([{}, {}]);
  });
});
