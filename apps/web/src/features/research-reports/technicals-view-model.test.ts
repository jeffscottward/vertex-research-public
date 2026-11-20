import type { ResearchReportTechnicals } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import { labResearchTechnicals } from "../../lab/fixtures/research.ts";
import {
  priceFormatFor,
  toTechnicalsViewModel,
} from "./technicals-view-model.ts";

const base = labResearchTechnicals("SPY");
const withStored = (
  stored: Partial<ResearchReportTechnicals["stored"]>
): ResearchReportTechnicals => ({
  ...base,
  stored: { ...base.stored, ...stored },
});

describe("toTechnicalsViewModel", () => {
  it("formats the stored indicators, the check and the bars line", () => {
    const view = toTechnicalsViewModel(base);
    expect(view.revision).toBe(base.dataRevision.slice(0, 12));
    expect(view.barsLine).toMatch(
      /^2,513 stored daily bars, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}; collected .+Z\.$/u
    );
    expect(view.check).toEqual({
      text: "Recomputed from 2,513 stored daily bars: all 9 checked values equal the stored values.",
      tone: "success",
    });
    expect(view.indicators.map((row) => row.label)).toEqual([
      "Close",
      "RSI 14",
      "ATR 14",
      "SMA 20",
      "SMA 50",
      "SMA 150",
      "SMA 200",
      "SMA 200 change, 20 sessions",
      "52-week low",
      "52-week high",
      "Maximum observed high",
    ]);
    expect(view.indicators[1]).toEqual({
      detail: "Wilder, 14 sessions",
      label: "RSI 14",
      value: "55.4",
    });
    expect(view.indicators[2]?.detail).toBe("2.10% of the close");
    expect(view.indicators[7]?.detail).toMatch(/^\+1\.60%, .+ to .+$/u);
    expect(view.indicators[10]?.detail).toMatch(/, close -9\.10% from it$/u);
    expect(view.trendChecks[0]).toEqual({
      label: "Close above SMA 20",
      status: "pass",
    });
    expect(view.methodNote).toContain("Method version 1.");
    expect(view.warnings).toEqual(base.warnings);
  });

  it("shows Unavailable for missing stored values and leaves empty details out", () => {
    const view = toTechnicalsViewModel(
      withStored({
        atr14: null,
        latestClose: null,
        maximumObservedHigh: { date: null, drawdownPct: null, price: 5 },
        range52Week: null,
        rsi14: null,
        sma200: null,
        sma200Slope: {
          change: -1,
          changePct: null,
          fromDate: null,
          toDate: "2026-01-02",
        },
      })
    );
    const byLabel = Object.fromEntries(
      view.indicators.map((row) => [row.label, row])
    );
    expect(byLabel["Close"]?.value).toBe("Not in the stored dataset");
    expect(byLabel["RSI 14"]?.value).toBe("Not in the stored dataset");
    expect(byLabel["ATR 14"]).toMatchObject({
      detail: null,
      value: "Not in the stored dataset",
    });
    expect(byLabel["SMA 200"]?.value).toBe("Not in the stored dataset");
    expect(byLabel["SMA 200 change, 20 sessions"]).toEqual({
      detail: null,
      label: "SMA 200 change, 20 sessions",
      value: "-1.00",
    });
    expect(byLabel["52-week low"]).toMatchObject({
      detail: null,
      value: "Not in the stored dataset",
    });
    expect(byLabel["Maximum observed high"]).toMatchObject({
      detail: null,
      value: "5.00",
    });
    const none = toTechnicalsViewModel(
      withStored({
        atr14: 2,
        latestClose: 0,
        maximumObservedHigh: null,
        sma200Slope: null,
      })
    );
    expect(none.indicators[2]?.detail).toBeNull();
    expect(none.indicators[7]?.value).toBe("Not in the stored dataset");
    expect(none.indicators[10]).toMatchObject({
      detail: null,
      value: "Not in the stored dataset",
    });
    expect(
      toTechnicalsViewModel(
        withStored({
          maximumObservedHigh: { date: "2026-01-02", drawdownPct: 0, price: 5 },
          range52Week: null,
          sma200Slope: {
            change: 1,
            changePct: 0,
            fromDate: null,
            toDate: null,
          },
        })
      )
        .indicators.map((row) => row.detail)
        .slice(7)
    ).toEqual(["0.00%", null, null, "2026-01-02, close 0.00% from it"]);
  });

  it("names differing fields and explains an unavailable check", () => {
    expect(
      toTechnicalsViewModel({
        ...base,
        check: { mismatches: ["rsi14", "sma200", "other"], status: "mismatch" },
      }).check
    ).toEqual({
      text: "Recomputed values differ from the stored values: RSI 14, SMA 200, other.",
      tone: "warning",
    });
    const unavailable = {
      text: "Not checked: this revision has no stored daily bars or no stored bar count to compare.",
      tone: "neutral",
    };
    expect(
      toTechnicalsViewModel({
        ...base,
        check: { mismatches: [], status: "unavailable" },
      }).check
    ).toEqual(unavailable);
    expect(toTechnicalsViewModel({ ...base, recomputed: null }).check).toEqual(
      unavailable
    );
  });

  it("shows trend checks that failed or are unknown", () => {
    const [first, second] = toTechnicalsViewModel(
      withStored({
        trendChecks: [
          { key: "closeAboveSma50", passed: false },
          { key: "sma200Rising20Sessions", passed: null },
        ],
      })
    ).trendChecks;
    expect(first).toEqual({ label: "Close above SMA 50", status: "fail" });
    expect(second).toEqual({
      label: "SMA 200 rising over 20 sessions",
      status: "missing",
    });
  });

  it("formats the Weinstein stage, pivots, Fibonacci levels and the volume profile", () => {
    const view = toTechnicalsViewModel(base);
    expect(view.weinstein?.stage).toBe("Stage 2: advancing");
    expect(view.weinstein?.rows[1]?.detail).toBe("+2.10% over 4 weeks");
    expect(view.weinstein?.rows[2]?.value).toBe("520");
    expect(view.pivots?.rows[0]?.label).toBe("Support pivot");
    expect(view.pivots?.listLabel).toBe(
      "All pivots of the last 60 sessions (2)"
    );
    expect(view.pivots?.items[0]?.kind).toBe("Support");
    expect(view.pivots?.items[1]?.kind).toBe("Resistance");
    expect(view.fibonacci?.heading).toMatch(
      /^Up swing over 252 sessions: low /u
    );
    expect(view.fibonacci?.rows.map((row) => row.mark)).toEqual([
      null,
      "Nearest above the close",
      "Nearest below the close",
      null,
      null,
      null,
      null,
    ]);
    expect(view.fibonacci?.rows[1]?.ratio).toBe("23.6%");
    const profile = view.volumeProfile;
    expect(profile?.rows.map((row) => row.label)).toEqual([
      "Point of control (POC)",
      "Value area (VAL to VAH)",
      "Close location",
      "Window",
    ]);
    expect(profile?.rows[2]?.value).toBe("Inside the value area");
    expect(profile?.bins).toHaveLength(50);
    expect(profile?.bins.filter((bin) => bin.mark === "POC")).toHaveLength(1);
    expect(profile?.bins.some((bin) => bin.mark === "Value area")).toBe(true);
    expect(profile?.bins[0]?.mark).toBeNull();
    expect(
      Math.max(...(profile?.bins.map((bin) => bin.width) ?? []))
    ).toBeLessThanOrEqual(200);
  });

  it("covers a down swing, missing pivots, other close locations and an empty profile", () => {
    const fibonacci = base.fibonacci as NonNullable<
      ResearchReportTechnicals["fibonacci"]
    >;
    const pivots = base.pivots as NonNullable<
      ResearchReportTechnicals["pivots"]
    >;
    const profile = base.volumeProfile as NonNullable<
      ResearchReportTechnicals["volumeProfile"]
    >;
    const view = toTechnicalsViewModel({
      ...base,
      fibonacci: {
        ...fibonacci,
        direction: "down",
        nearestAbove: null,
        nearestBelow: null,
      },
      pivots: { ...pivots, candidateResistance: null, candidateSupport: null },
      volumeProfile: {
        ...profile,
        bins: profile.bins.map((bin) => ({ ...bin, volume: 0 })),
        closeLocation: "above",
        poc: { ...profile.poc, volume: 0 },
      },
    });
    expect(view.fibonacci?.heading).toMatch(/^Down swing/u);
    expect(view.fibonacci?.rows.every((row) => row.mark === null)).toBe(true);
    expect(view.pivots?.rows[0]?.value).toBe("None in the last 60 sessions");
    expect(view.volumeProfile?.rows[2]?.value).toBe("Above the value area");
    expect(view.volumeProfile?.bins.every((bin) => bin.width === 0)).toBe(true);
    expect(
      toTechnicalsViewModel({
        ...base,
        volumeProfile: { ...profile, closeLocation: "below" },
      }).volumeProfile?.rows[2]?.value
    ).toBe("Below the value area");
  });

  it("leaves out markers and bar details that the server did not compute", () => {
    const view = toTechnicalsViewModel({
      ...base,
      bars: null,
      fibonacci: null,
      pivots: null,
      volumeProfile: null,
      weinstein: null,
    });
    expect(view.barsLine).toBe("No stored daily bars in this revision.");
    expect(view.fibonacci).toBeNull();
    expect(view.pivots).toBeNull();
    expect(view.volumeProfile).toBeNull();
    expect(view.weinstein).toBeNull();
    const bars = base.bars as NonNullable<ResearchReportTechnicals["bars"]>;
    expect(
      toTechnicalsViewModel({ ...base, bars: { ...bars, collectedAt: null } })
        .barsLine
    ).toMatch(/to \d{4}-\d{2}-\d{2}\.$/u);
  });

  it("keeps narrow price ranges apart with more decimals", () => {
    expect(priceFormatFor(581.4).format(1.08)).toBe("1.08");
    expect(priceFormatFor(1.0842).format(1.084_21)).toBe("1.0842");
    expect(priceFormatFor(0.05).format(0.051_234_5)).toBe("0.051235");
    expect(priceFormatFor(null).format(3)).toBe("3.00");
    expect(priceFormatFor(100, 0.002).format(100.0123)).toBe("100.0123");
    expect(priceFormatFor(100, 5).format(100.0123)).toBe("100.01");
    expect(priceFormatFor(100, 1e-9).format(1)).toBe("1.000000");
    const profile = base.volumeProfile as NonNullable<
      ResearchReportTechnicals["volumeProfile"]
    >;
    const narrow = toTechnicalsViewModel({
      ...base,
      recomputed: null,
      stored: { ...base.stored, latestClose: null },
      volumeProfile: {
        ...profile,
        bins: profile.bins.map((_, index) => ({
          high: 1.08 + (index + 1) * 0.0004,
          low: 1.08 + index * 0.0004,
          volume: 1,
        })),
      },
    });
    expect(narrow.indicators[0]?.value).toBe("Not in the stored dataset");
    expect(
      toTechnicalsViewModel({
        ...base,
        recomputed: {
          ...(base.recomputed as NonNullable<
            ResearchReportTechnicals["recomputed"]
          >),
          latestClose: 1.09,
        },
        stored: { ...base.stored, latestClose: null },
        volumeProfile:
          narrow.volumeProfile === null
            ? null
            : {
                ...profile,
                bins: profile.bins.map((_, index) => ({
                  high: 1.08 + (index + 1) * 0.0004,
                  low: 1.08 + index * 0.0004,
                  volume: 1,
                })),
              },
      })
        .volumeProfile?.bins.map((bin) => bin.range)
        .filter((range, index, all) => all.indexOf(range) === index)
    ).toHaveLength(50);
  });
});
