import { describe, expect, it } from "vitest";
import {
  indicatorTemplate,
  isVertexStudyId,
  paneStudyCount,
  studyPaneId,
  VERTEX_STUDIES,
  VERTEX_STUDY_IDS,
  zipRows,
} from "./vertex-studies.ts";

// 40 daily bars with a rise and a fall, so every study has defined values.
const bars = Array.from({ length: 40 }, (_, index) => {
  const close = 100 + 8 * Math.sin(index / 4) + index * 0.2;
  return {
    close,
    high: close + 1,
    low: close - 1,
    timestamp: Date.UTC(2026, 0, 5 + index, 21),
    volume: 1000 + 100 * (index % 7),
  };
});

describe("Vertex chart studies", () => {
  it("lists nine studies with unique names and valid ids", () => {
    expect(VERTEX_STUDY_IDS).toHaveLength(9);
    const names = VERTEX_STUDY_IDS.map((id) => VERTEX_STUDIES[id].name);
    expect(new Set(names).size).toBe(9);
    for (const id of VERTEX_STUDY_IDS) {
      expect(VERTEX_STUDIES[id].id).toBe(id);
      expect(isVertexStudyId(id)).toBe(true);
    }
    expect(isVertexStudyId("ichimoku")).toBe(false);
    expect(isVertexStudyId(1)).toBe(false);
    expect(studyPaneId("atr")).toBe("vx_atr_pane");
    expect(paneStudyCount(["boll", "sar", "atr", "macd"])).toBe(2);
    expect(paneStudyCount([])).toBe(0);
  });

  it.each(VERTEX_STUDY_IDS)(
    "%s returns one row per bar with values only for its figures",
    (id) => {
      const study = VERTEX_STUDIES[id];
      const rows = study.calc(bars, study.calcParams);
      expect(rows).toHaveLength(bars.length);
      const keys = new Set(study.figures.map((figure) => figure.key));
      const last = rows.at(-1) ?? {};
      expect(Object.keys(last).sort()).toEqual([...keys].sort());
      for (const row of rows)
        for (const [key, value] of Object.entries(row)) {
          expect(keys.has(key)).toBe(true);
          expect(Number.isFinite(value)).toBe(true);
        }
      // Bar 0 is warmup for every study.
      expect(rows[0]).toEqual({});
    }
  );

  it("bounds oscillators to 0..100 and keeps SAR off the bar", () => {
    expect(VERTEX_STUDIES.stoch.minValue).toBe(0);
    expect(VERTEX_STUDIES.adx.maxValue).toBe(100);
    const sar = VERTEX_STUDIES.sar.calc(bars, VERTEX_STUDIES.sar.calcParams);
    for (const [index, row] of sar.entries()) {
      const value = row["sar"];
      const bar = bars[index];
      if (value !== undefined && bar !== undefined)
        expect(value > bar.high || value < bar.low).toBe(true);
    }
  });

  it("computes with calcParams, the values the tooltip shows", () => {
    const study = VERTEX_STUDIES.smma;
    const standard = study.calc(bars, study.calcParams);
    const shorter = study.calc(bars, [5]);
    expect(standard[10]).toEqual({});
    expect(shorter[10]).toHaveProperty("smma");
    expect(shorter.at(-1)).not.toEqual(standard.at(-1));
    // A missing parameter fails validation instead of using a hidden default.
    expect(() => study.calc(bars, [])).toThrow("period");
  });

  it("zipRows leaves gaps for null and non-finite values", () => {
    expect(zipRows(3, { a: [null, 1, Number.NaN], b: [2] })).toEqual([
      { b: 2 },
      { a: 1 },
      {},
    ]);
  });

  it("builds a KLineCharts template that never throws into the renderer", () => {
    const template = indicatorTemplate(VERTEX_STUDIES.macd, 4);
    expect(template).toMatchObject({
      calcParams: [12, 26, 9],
      maxValue: null,
      minValue: null,
      name: "VX_MACD",
      precision: 4,
      shortName: "MACD",
      shouldOhlc: false,
    });
    expect(template.figures[2]).toEqual({
      baseValue: 0,
      key: "histogram",
      title: "Hist: ",
      type: "bar",
    });
    expect(template.calc(bars)).toHaveLength(40);
    // Low above high fails bar validation; the study shows nothing.
    const bad = [{ close: 1.5, high: 1, low: 2 }];
    expect(indicatorTemplate(VERTEX_STUDIES.atr, 2).calc(bad)).toEqual([{}]);
    // Oscillators keep two decimals whatever the price precision is.
    expect(indicatorTemplate(VERTEX_STUDIES.stoch, 6)).toMatchObject({
      maxValue: 100,
      minValue: 0,
      precision: 2,
    });
  });

  it("registers RVOL at time as a pane study and needs volume", () => {
    expect(indicatorTemplate(VERTEX_STUDIES.rvol, 4)).toMatchObject({
      calcParams: [20],
      maxValue: null,
      minValue: 0,
      name: "VX_RVOL",
      precision: 2,
      shortName: "RVOL",
    });
    expect(VERTEX_STUDIES.rvol.label).toBe("RVOL at time 20");
    expect(VERTEX_STUDIES.rvol.placement).toBe("pane");
    const rows = VERTEX_STUDIES.rvol.calc(bars, [20]);
    expect(rows[19]).toEqual({});
    // Daily bars: volume over the mean of the previous 20 volumes.
    const previous = bars
      .slice(0, 20)
      .reduce((sum, bar) => sum + bar.volume, 0);
    expect(rows[20]?.["rvol"]).toBeCloseTo(
      (bars[20]?.volume ?? 0) / (previous / 20),
      12
    );
    // Bars without volume or timestamp give an empty study.
    const noVolume = [{ close: 1.5, high: 2, low: 1, timestamp: 0 }];
    expect(indicatorTemplate(VERTEX_STUDIES.rvol, 2).calc(noVolume)).toEqual([
      {},
    ]);
    const noTime = [{ close: 1.5, high: 2, low: 1, volume: 1 }];
    expect(indicatorTemplate(VERTEX_STUDIES.rvol, 2).calc(noTime)).toEqual([
      {},
    ]);
  });
});
