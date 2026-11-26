import { describe, expect, it } from "vitest";

import { FLOW_SOURCE_METADATA } from "./contracts/flow.ts";
import {
  GEX_WALL_DRIFT_CODES,
  GEX_WALL_DRIFT_READS,
  GEX_WALL_DRIFT_RULES,
  type GexDriftInput,
  type GexDriftPoint,
  type GexWallDriftInput,
  type GexWallLevelsInput,
  gexDriftWindow,
  gradeGexWallDrift,
} from "./gex-wall-drift-rules.ts";

const NOW = new Date("2026-11-25T15:00:00.000Z");
const MINUTE = 60_000;
const ago = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * MINUTE).toISOString();

const levels = (
  overrides: Partial<Extract<GexWallLevelsInput, { kind: "levels" }>> = {}
): GexWallLevelsInput => ({
  at: ago(10),
  callWall: 610,
  flip: 590,
  kind: "levels",
  putWall: 600,
  source: "flow_gex",
  spot: 600.4,
  ticker: "SPY",
  ...overrides,
});

/**
 * A settled series of `count` points one minute apart, the newest `newestAgo` minutes before
 * NOW + 1 minute of settling. Each step adds `call` and `put` USD to the cumulative lines.
 */
const points = ({
  call = 0,
  count = 16,
  newestAgo = 2,
  price = 600.5 as number | null,
  put = 0,
}: Partial<{
  call: number;
  count: number;
  newestAgo: number;
  price: number | null;
  put: number;
}> = {}): readonly GexDriftPoint[] =>
  Array.from({ length: count }, (_, index) => ({
    minute: ago(newestAgo + count - 1 - index),
    total: { netCallPremiumUsd: index * call, netPutPremiumUsd: index * put },
    underlyingPrice: price,
  }));

const series = (
  overrides: Parameters<typeof points>[0] = {}
): GexDriftInput => ({
  kind: "series",
  points: points(overrides),
  ticker: "SPY",
});

const grade = (input: Partial<GexWallDriftInput> = {}) =>
  gradeGexWallDrift({
    drift: series(),
    levels: levels(),
    now: NOW,
    ...input,
  });

// Gross per step: |call| + |put|. A step of 100k on one side and 0 on the other gives share 1.
const RISING_CALL = { call: 100_000 };
const RISING_PUT = { put: 100_000 };

describe("GEX_WALL_DRIFT_RULES", () => {
  it("is frozen, versioned and no looser than the source freshness limits", () => {
    expect(Object.isFrozen(GEX_WALL_DRIFT_RULES)).toBe(true);
    expect(GEX_WALL_DRIFT_RULES).toEqual({
      maxDriftAgeMinutes: 5,
      maxGexAgeMinutes: 30,
      maxScaleGapPct: 2,
      minBuckets: 10,
      nearWallPct: 0.25,
      risingShare: 0.3,
      version: "gex-wall-drift-rules.v1",
      windowMinutes: 15,
      windowToleranceMinutes: 3,
    });
    expect(GEX_WALL_DRIFT_RULES.maxDriftAgeMinutes * 60).toBeLessThanOrEqual(
      FLOW_SOURCE_METADATA.net_drift.maxAgeSeconds
    );
    expect(GEX_WALL_DRIFT_RULES.maxGexAgeMinutes * 60).toBeLessThanOrEqual(
      FLOW_SOURCE_METADATA.gex.maxAgeSeconds
    );
    expect(GEX_WALL_DRIFT_READS).toEqual([
      "hold-A",
      "break-risk",
      "no-read",
      "no-data",
    ]);
    expect(new Set(GEX_WALL_DRIFT_CODES).size).toBe(
      GEX_WALL_DRIFT_CODES.length
    );
  });
});

describe("gradeGexWallDrift truth table at the put wall", () => {
  it("grades hold-A for rising call drift above the flip, with its inputs", () => {
    const read = grade({ drift: series(RISING_CALL) });
    expect(read).toMatchObject({
      callShare: 1,
      code: null,
      flip: 590,
      flipSide: "above",
      levelsAt: ago(10),
      levelsSource: "flow_gex",
      price: 600.5,
      priceAt: ago(2),
      putShare: 0,
      read: "hold-A",
      rulesVersion: "gex-wall-drift-rules.v1",
      ticker: "SPY",
      wall: "put",
      wallStrike: 600,
    });
    expect(read.distancePct).toBeCloseTo((0.5 / 600.5) * 100, 10);
    expect(read.window).toMatchObject({ buckets: 15, spanMinutes: 15 });
    expect(read.reason).toBe(
      "call drift rising at put wall 600, above gamma flip 590; call +$1.50M, put $0.00M in 15 min"
    );
  });

  it("grades break-risk for rising put drift in both flip sides", () => {
    expect(grade({ drift: series(RISING_PUT) })).toMatchObject({
      code: null,
      flipSide: "above",
      read: "break-risk",
    });
    const below = grade({
      drift: series(RISING_PUT),
      levels: levels({ flip: 605 }),
    });
    expect(below).toMatchObject({ flipSide: "below", read: "break-risk" });
    expect(below.reason).toContain(
      "put drift rising at put wall 600, below gamma flip 605"
    );
  });

  it("does not grade a hold below the flip or without a flip", () => {
    expect(
      grade({ drift: series(RISING_CALL), levels: levels({ flip: 605 }) })
    ).toMatchObject({ code: "hold_below_flip", read: "no-read" });
    const noFlip = grade({
      drift: series(RISING_CALL),
      levels: levels({ flip: null }),
    });
    expect(noFlip).toMatchObject({
      code: "hold_no_flip",
      flipSide: "no_flip",
      read: "no-read",
    });
    expect(noFlip.reason).toContain(
      "no gamma flip in the GEX estimate; a hold is graded above the flip only"
    );
  });

  it("gives no-read when both sides rise or the drift is flat", () => {
    expect(
      grade({ drift: series({ call: 100_000, put: 100_000 }) })
    ).toMatchObject({ code: "both_rising", read: "no-read" });
    const flat = grade({ drift: series({ call: 20_000, put: -80_000 }) });
    expect(flat).toMatchObject({
      code: "flat",
      putShare: -0.8,
      read: "no-read",
    });
    expect(flat.reason).toBe(
      "drift flat at put wall 600, above gamma flip 590; call +$0.30M, put -$1.20M in 15 min"
    );
  });
});

describe("gradeGexWallDrift truth table at the call wall", () => {
  const atCall = levels({ spot: 609.6 });
  const nearCall = (overrides: Parameters<typeof points>[0]) =>
    series({ price: 609.5, ...overrides });

  it("grades hold-A for rising put drift above the flip", () => {
    expect(
      grade({ drift: nearCall(RISING_PUT), levels: atCall })
    ).toMatchObject({ read: "hold-A", wall: "call", wallStrike: 610 });
  });

  it("grades break-risk for rising call drift", () => {
    expect(
      grade({ drift: nearCall(RISING_CALL), levels: atCall })
    ).toMatchObject({ read: "break-risk", wall: "call" });
  });

  it("does not grade a hold below the flip", () => {
    expect(
      grade({
        drift: nearCall(RISING_PUT),
        levels: levels({ flip: 615, spot: 609.6 }),
      })
    ).toMatchObject({ code: "hold_below_flip", flipSide: "below" });
  });
});

describe("gradeGexWallDrift boundaries and remaining cells", () => {
  it("counts a share of exactly 0.30 as rising and a price at the flip as above", () => {
    // Per step: call 30k, put -70k: call share 0.3, put share -0.7.
    expect(
      grade({ drift: series({ call: 30_000, put: -70_000 }) })
    ).toMatchObject({ callShare: 0.3, read: "hold-A" });
    expect(
      grade({ drift: series(RISING_CALL), levels: levels({ flip: 600.5 }) })
    ).toMatchObject({ flipSide: "above", read: "hold-A" });
  });

  it("accepts a span of exactly 18 minutes, exactly 10 buckets and a scale gap under 2%", () => {
    const span18: GexDriftInput = {
      kind: "series",
      points: [
        ...points({ count: 1, newestAgo: 20 }),
        ...points({ ...RISING_CALL, count: 10 }),
      ],
      ticker: "SPY",
    };
    // Baseline 20 minutes ago, newest 2 minutes ago: 18 minutes, 10 buckets.
    expect(grade({ drift: span18 })).toMatchObject({
      read: "hold-A",
      window: { buckets: 10, spanMinutes: 18 },
    });
    expect(
      grade({
        drift: series({ ...RISING_CALL, price: 612.408 }),
        levels: levels({ callWall: 640, putWall: 612, spot: 600.4 }),
      }).code
    ).not.toBe("price_scale_mismatch");
  });

  it("covers the call wall cells without a flip, both rising and flat", () => {
    const atCall = { levels: levels({ flip: null, spot: 609.6 }) };
    const near = (o: Parameters<typeof points>[0]) =>
      series({ price: 609.5, ...o });
    expect(grade({ ...atCall, drift: near(RISING_CALL) })).toMatchObject({
      flipSide: "no_flip",
      read: "break-risk",
      wall: "call",
    });
    expect(grade({ ...atCall, drift: near(RISING_PUT) }).code).toBe(
      "hold_no_flip"
    );
    expect(
      grade({ ...atCall, drift: near({ call: 50_000, put: 50_000 }) }).code
    ).toBe("both_rising");
    expect(
      grade({ ...atCall, drift: near({ call: -50_000, put: -50_000 }) }).code
    ).toBe("flat");
    expect(
      grade({ drift: series(RISING_PUT), levels: levels({ flip: null }) })
    ).toMatchObject({ read: "break-risk", wall: "put" });
  });
});

describe("gradeGexWallDrift wall location", () => {
  const rising = series(RISING_CALL);

  it("gives no-read away from both walls", () => {
    const read = grade({
      drift: series({ ...RISING_CALL, price: 605 }),
      levels: levels({ spot: 605 }),
    });
    expect(read).toMatchObject({
      code: "not_at_wall",
      distancePct: null,
      read: "no-read",
      wall: "none",
    });
    expect(read.reason).toContain("price 605 is not within 0.25% of a wall");
  });

  it("uses the band edge inclusively", () => {
    // Band: 0.25% of 601.5 = 1.50375; the put wall is 1.5 away.
    expect(
      grade({
        drift: series({ ...RISING_CALL, price: 601.5 }),
        levels: levels({ spot: 601.5 }),
      }).wall
    ).toBe("put");
  });

  it("stops on inverted or adjacent walls and on both walls in the band", () => {
    expect(
      grade({ drift: rising, levels: levels({ callWall: 600, putWall: 601 }) })
    ).toMatchObject({ code: "wall_geometry", read: "no-read" });
    expect(
      grade({ drift: rising, levels: levels({ callWall: 600, putWall: 600 }) })
        .code
    ).toBe("wall_geometry");
    expect(
      grade({ drift: rising, levels: levels({ callWall: 601, putWall: 600 }) })
    ).toMatchObject({ code: "both_walls_near", read: "no-read" });
  });

  it("reads a missing wall as absent", () => {
    expect(
      grade({ drift: rising, levels: levels({ callWall: null }) }).wall
    ).toBe("put");
    expect(
      grade({
        drift: series({ ...RISING_CALL, price: 609.5 }),
        levels: levels({ putWall: null, spot: 609.5 }),
      }).wall
    ).toBe("call");
  });
});

describe("gradeGexWallDrift no-data", () => {
  it("passes on missing levels and missing drift", () => {
    expect(
      grade({
        levels: {
          code: "gex_missing",
          detail: "no GEX snapshot yet",
          kind: "missing",
        },
      })
    ).toEqual({
      callShare: null,
      code: "gex_missing",
      distancePct: null,
      flip: null,
      flipSide: "not_read",
      levelsAt: null,
      levelsSource: null,
      price: null,
      priceAt: null,
      putShare: null,
      read: "no-data",
      reason: "no GEX snapshot yet",
      rulesVersion: "gex-wall-drift-rules.v1",
      ticker: null,
      wall: "none",
      wallStrike: null,
      window: null,
    });
    expect(
      grade({
        drift: { code: "drift_missing", detail: "HTTP 401", kind: "missing" },
      })
    ).toMatchObject({
      code: "drift_missing",
      levelsAt: ago(10),
      read: "no-data",
      reason: "HTTP 401",
      ticker: "SPY",
    });
  });

  it("reads stale, unparsable or spotless GEX as no-data", () => {
    expect(grade({ levels: levels({ at: ago(31) }) })).toMatchObject({
      code: "gex_stale",
      reason: "GEX levels are older than 30 min",
    });
    expect(grade({ levels: levels({ at: "not a time" }) }).code).toBe(
      "gex_stale"
    );
    expect(grade({ levels: levels({ spot: null }) }).code).toBe("gex_no_spot");
    expect(
      grade({ levels: levels({ callWall: null, putWall: null }) })
    ).toMatchObject({
      code: "gex_no_walls",
      flipSide: "not_read",
      reason: "GEX has neither a call nor a put wall",
    });
  });

  it("refuses a drift series of another ticker", () => {
    expect(
      grade({ drift: { kind: "series", points: points(), ticker: "SPX" } })
    ).toMatchObject({
      code: "ticker_mismatch",
      reason: "GEX is for SPY, net drift for SPX",
    });
  });

  it("names short, stale, gapped and thin windows", () => {
    expect(grade({ drift: series({ count: 15 }) })).toMatchObject({
      code: "window_short",
      reason: "net drift has less than 15 min this session",
    });
    // Settled at the end of the newest minute: 6 minutes ago is stale, 5 minutes ago is not.
    expect(grade({ drift: series({ newestAgo: 7 }) })).toMatchObject({
      code: "drift_stale",
      reason: "net drift is older than 5 min",
    });
    expect(
      grade({ drift: series({ ...RISING_CALL, newestAgo: 6 }) }).read
    ).toBe("hold-A");
    const gap: GexDriftInput = {
      kind: "series",
      points: [
        ...points({ count: 1, newestAgo: 21 }),
        ...points({ count: 12 }),
      ],
      ticker: "SPY",
    };
    expect(grade({ drift: gap })).toMatchObject({
      code: "window_gap",
      reason: "net drift has a gap: the window spans 19 min",
    });
    const thin: GexDriftInput = {
      kind: "series",
      points: [...points({ count: 1, newestAgo: 17 }), ...points({ count: 9 })],
      ticker: "SPY",
    };
    expect(grade({ drift: thin })).toMatchObject({
      code: "thin_window",
      reason: "net drift has 9 of 10 minutes in the window",
    });
  });

  it("needs a price near the GEX spot and some premium", () => {
    expect(grade({ drift: series({ price: null }) })).toMatchObject({
      code: "no_price",
      priceAt: null,
    });
    // The newest minute must carry the price; an older priced minute does not count.
    const lastUnpriced: GexDriftInput = {
      kind: "series",
      points: [
        ...points({ count: 15, newestAgo: 3 }),
        ...points({ count: 1, price: null }),
      ],
      ticker: "SPY",
    };
    expect(grade({ drift: lastUnpriced }).code).toBe("no_price");
    expect(grade({ drift: series({ price: 6005 }) })).toMatchObject({
      code: "price_scale_mismatch",
      flipSide: "above",
      price: 6005,
      reason: "price 6005 and GEX spot 600.4 differ by more than 2%",
    });
    expect(grade()).toMatchObject({
      callShare: null,
      code: "zero_premium",
      flipSide: "above",
      putShare: null,
      read: "no-data",
    });
  });
});

describe("gexDriftWindow", () => {
  it("is null without points or before a full window", () => {
    expect(gexDriftWindow([])).toBeNull();
    expect(gexDriftWindow(points({ count: 15 }))).toBeNull();
  });

  it("measures the changes and gross premium from the baseline point", () => {
    const at = (
      minute: number,
      call: number,
      put: number,
      price: number | null
    ) => ({
      minute: new Date(Date.UTC(2026, 10, 25, 14, 30 + minute)).toISOString(),
      total: { netCallPremiumUsd: call, netPutPremiumUsd: put },
      underlyingPrice: price,
    });
    // Baseline: minute 5 (newest 20 - 15). Steps: (−50, +30), (+250, +30).
    expect(
      gexDriftWindow([
        at(0, 100, 50, 1),
        at(4, 200, 60, 2),
        at(5, 300, 40, 3),
        at(12, 250, 70, 4),
        at(20, 500, 100, null),
      ])
    ).toEqual({
      baselineMinute: "2026-11-25T14:35:00.000Z",
      buckets: 2,
      callChange: 200,
      gross: 360,
      newestMinute: "2026-11-25T14:50:00.000Z",
      price: null,
      putChange: 60,
      spanMinutes: 15,
    });
  });
});
