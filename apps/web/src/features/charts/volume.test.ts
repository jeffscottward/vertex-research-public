import { describe, expect, it } from "vitest";
import type { ChartStudies, DisplayCandle } from "./types.ts";
import {
  addVolumes,
  studiesForVolume,
  VOLUME_NOTES,
  volumeCoverage,
  volumeField,
} from "./volume.ts";

const bar = (id: string, volume?: number): DisplayCandle => ({
  close: 1,
  high: 1,
  id,
  low: 1,
  open: 1,
  timestamp: Number(id),
  ...volumeField(volume),
});

const studies: ChartStudies = {
  ema: [20],
  extra: ["vwap", "alphatrend", "rvol"],
  panes: ["OBV", "WR"],
  sma: [20, 50],
  volume: true,
};

describe("chart volume", () => {
  it("adds the volume field only when there is a volume", () => {
    expect(volumeField(undefined)).toEqual({});
    expect(volumeField(0)).toEqual({ volume: 0 });
    return expect(volumeField(5)).toEqual({ volume: 5 });
  });

  it("sums volumes and leaves the sum out when either side has none", () => {
    expect(addVolumes(2, 3)).toBe(5);
    expect(addVolumes(undefined, 3)).toBeUndefined();
    return expect(addVolumes(2, undefined)).toBeUndefined();
  });

  it("reports whether all, some or none of the bars have a volume", () => {
    expect(volumeCoverage([])).toBe("all");
    expect(volumeCoverage([bar("1", 10), bar("2", 0)])).toBe("all");
    expect(volumeCoverage([bar("1"), bar("2", 0)])).toBe("some");
    return expect(volumeCoverage([bar("1"), bar("2")])).toBe("none");
  });

  it("keeps every study when all bars have a volume", () =>
    expect(studiesForVolume(studies, "all")).toBe(studies));

  it("turns off VWAP and RVOL when only some bars have a volume", () =>
    expect(studiesForVolume(studies, "some")).toEqual({
      ...studies,
      extra: ["alphatrend"],
    }));

  it("also turns off the volume pane and OBV when no bar has a volume", () => {
    expect(studiesForVolume(studies, "none")).toEqual({
      ema: [20],
      extra: ["alphatrend"],
      panes: ["WR"],
      sma: [20, 50],
      volume: false,
    });
    expect(
      studiesForVolume({ ema: [], sma: [], volume: true }, "none")
    ).toEqual({ ema: [], sma: [], volume: false });
    return expect(
      studiesForVolume({ ema: [], sma: [], volume: true }, "some")
    ).toEqual({ ema: [], sma: [], volume: true });
  });

  it("explains what is off for some and for no volume", () => {
    expect(VOLUME_NOTES.none).toContain("No volume for this instrument");
    return expect(VOLUME_NOTES.some).toContain("Some bars have no volume");
  });
});
