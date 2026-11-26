import { describe, expect, it } from "vitest";
import type { DisplayCandle } from "./types.ts";
import {
  addVolumes,
  hasVolume,
  volumeField,
  withoutVolumeStudies,
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

  it("reports no volume only when there are bars and none has a volume", () => {
    expect(hasVolume([])).toBe(true);
    expect(hasVolume([bar("1"), bar("2")])).toBe(false);
    expect(hasVolume([bar("1"), bar("2", 0)])).toBe(true);
    return expect(hasVolume([bar("1", 10)])).toBe(true);
  });

  it("turns off the volume pane, VWAP, RVOL and OBV and keeps the rest", () => {
    expect(
      withoutVolumeStudies({
        ema: [20],
        extra: ["vwap", "alphatrend", "rvol"],
        panes: ["OBV", "WR"],
        sma: [20, 50],
        volume: true,
      })
    ).toEqual({
      ema: [20],
      extra: ["alphatrend"],
      panes: ["WR"],
      sma: [20, 50],
      volume: false,
    });
    return expect(
      withoutVolumeStudies({ ema: [], sma: [], volume: true })
    ).toEqual({ ema: [], sma: [], volume: false });
  });
});
