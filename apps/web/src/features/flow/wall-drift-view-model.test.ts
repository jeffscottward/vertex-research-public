import type {
  FlowControl,
  FlowSnapshot,
  OptionsAnalyticsOutput,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import { LAB_NOW } from "../../lab/fixtures/core.ts";
import { labFlowControl, labFlowSnapshot } from "../../lab/fixtures/flow.ts";
import {
  flowWallDriftView,
  isWallDriftTicker,
  stockWallDriftView,
  WALL_DRIFT_HELP,
  WALL_DRIFT_STUDY_STATUS,
  wallDriftGroupOf,
} from "./wall-drift-view-model.ts";

const MINUTE = 60_000;
const minutesAgo = (minutes: number): string =>
  new Date(LAB_NOW.getTime() - minutes * MINUTE).toISOString();

/** 16 settled minutes, the newest 2 minutes ago: call drift +$100,000 a minute at price 600.5. */
const risingCallPoints = Array.from({ length: 16 }, (_, index) => ({
  longer: null,
  minute: minutesAgo(17 - index),
  total: { netCallPremiumUsd: index * 100_000, netPutPremiumUsd: 0 },
  underlyingPrice: 600.5,
  zeroDte: null,
}));

const controlWith = (
  ticker: FlowControl["netDrift"][number]["ticker"],
  points: FlowControl["netDrift"][number]["points"],
  freshness: Partial<FlowControl["freshness"][number]> = {}
): FlowControl => {
  const base = labFlowControl(
    ticker === "SPY" || ticker === "SPX" ? "sp500" : "nasdaq100"
  );
  return {
    ...base,
    freshness: base.freshness.map((row) =>
      row.source === "net_drift" && row.instrument === ticker
        ? { ...row, ...freshness }
        : row
    ),
    netDrift: base.netDrift.map((series) =>
      series.ticker === ticker ? { ...series, points } : series
    ),
  };
};

const snapshotAt = (
  overrides: Partial<NonNullable<FlowSnapshot["gex"]>> = {}
): FlowSnapshot => {
  const base = labFlowSnapshot("SPY", 30);
  const gex = base.gex as NonNullable<FlowSnapshot["gex"]>;
  return {
    ...base,
    gex: {
      ...gex,
      at: minutesAgo(5),
      levels: { callWall: 620, flip: 590, maxPain: 600, putWall: 600 },
      spot: 600.4,
      ticker: "SPY",
      ...overrides,
    },
  };
};

const ready = (control: FlowControl) => ({ control, kind: "ready" }) as const;

describe("wall drift copy", () => {
  it("describes and never advises", () => {
    const advice =
      /\b(do not|don't|wait|buy|sell|enter|exit|catch|should|must)\b/iu;
    const reads = [
      flowWallDriftView(
        snapshotAt(),
        null,
        ready(controlWith("SPY", risingCallPoints)),
        LAB_NOW
      ),
      flowWallDriftView(
        snapshotAt({
          levels: { callWall: 601, flip: null, maxPain: null, putWall: 590 },
        }),
        null,
        ready(controlWith("SPY", risingCallPoints)),
        LAB_NOW
      ),
      flowWallDriftView(null, null, { kind: "loading" }, LAB_NOW),
    ];
    for (const view of reads) {
      expect(view.reason).not.toMatch(advice);
      expect(view.label).not.toMatch(advice);
    }
    expect(WALL_DRIFT_HELP).not.toMatch(advice);
  });
});

describe("wall drift tickers", () => {
  it("covers the four net drift tickers and maps them to their group", () => {
    expect(
      ["SPY", "SPX", "QQQ", "NDX", "AAPL", "IWM"].map(isWallDriftTicker)
    ).toEqual([true, true, true, true, false, false]);
    expect(wallDriftGroupOf("SPY")).toBe("sp500");
    expect(wallDriftGroupOf("SPX")).toBe("sp500");
    expect(wallDriftGroupOf("QQQ")).toBe("nasdaq100");
    expect(wallDriftGroupOf("NDX")).toBe("nasdaq100");
    expect(WALL_DRIFT_STUDY_STATUS).toBe("Unvalidated: study accruing");
    expect(WALL_DRIFT_HELP).toContain("A is the only hold grade");
  });
});

describe("flowWallDriftView", () => {
  it("reads hold-A with the GEX ticker's net drift and names its inputs", () => {
    const view = flowWallDriftView(
      snapshotAt(),
      null,
      ready(controlWith("SPY", risingCallPoints)),
      LAB_NOW
    );
    expect(view).toMatchObject({
      code: null,
      collectorNote: null,
      context: "Put wall 600 · above flip 590",
      label: "Hold (A)",
      read: "hold-A",
      rulesVersion: "gex-wall-drift-rules.v1",
      ticker: "SPY",
      tone: "success",
    });
    const et = (iso: string) =>
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        timeZone: "America/New_York",
      }).format(new Date(iso));
    expect(view.inputs).toBe(
      `levels flow_gex at ${et(minutesAgo(5))} ET · price at ${et(minutesAgo(2))} ET · gex-wall-drift-rules.v1`
    );
  });

  it("labels break risk, a wall without a flip and no-read without a wall", () => {
    const callWall = snapshotAt({
      levels: { callWall: 601, flip: null, maxPain: null, putWall: 590 },
    });
    expect(
      flowWallDriftView(
        callWall,
        null,
        ready(controlWith("SPY", risingCallPoints)),
        LAB_NOW
      )
    ).toMatchObject({
      context: "Call wall 601 · no flip",
      label: "Break risk",
      tone: "warning",
    });
    const away = flowWallDriftView(
      snapshotAt({
        levels: { callWall: 620, flip: 590, maxPain: null, putWall: 580 },
      }),
      null,
      ready(controlWith("SPY", risingCallPoints)),
      LAB_NOW
    );
    expect(away).toMatchObject({
      code: "not_at_wall",
      context: "No wall in band",
      label: "No read",
      tone: "neutral",
    });
  });

  it("names a failed snapshot", () => {
    expect(
      flowWallDriftView(
        null,
        "STORAGE_ERROR: down",
        { kind: "loading" },
        LAB_NOW
      ).reason
    ).toBe("flow snapshot not loaded: STORAGE_ERROR: down");
  });

  it("passes a stale or never-collected net drift feed through", () => {
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        ready(
          controlWith("SPY", risingCallPoints, {
            message: "QuantData answered HTTP 401",
            state: "stale",
          })
        ),
        LAB_NOW
      )
    ).toMatchObject({
      code: "drift_missing",
      collectorNote: "QuantData answered HTTP 401",
      reason: "net drift collector is stale",
    });
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        ready(controlWith("SPY", [], { message: null, state: "never" })),
        LAB_NOW
      )
    ).toMatchObject({
      collectorNote: null,
      reason: "net drift collector is without a successful sample yet",
    });
  });

  it("names both-walls and inverted-wall no-reads on the context line", () => {
    const control = ready(controlWith("SPY", risingCallPoints));
    expect(
      flowWallDriftView(
        snapshotAt({
          levels: { callWall: 601, flip: 590, maxPain: null, putWall: 600 },
        }),
        null,
        control,
        LAB_NOW
      ).context
    ).toBe("Both walls in band");
    expect(
      flowWallDriftView(
        snapshotAt({
          levels: { callWall: 600, flip: 590, maxPain: null, putWall: 601 },
        }),
        null,
        control,
        LAB_NOW
      ).context
    ).toBe("Call wall not above put wall");
  });

  it("shows no data while the snapshot loads or has no GEX", () => {
    const loading = flowWallDriftView(null, null, { kind: "loading" }, LAB_NOW);
    expect(loading).toMatchObject({
      code: "gex_missing",
      context: "Wall not read",
      inputs:
        "no GEX levels read · no drift price read · gex-wall-drift-rules.v1",
      label: "No data",
      reason: "flow snapshot is loading",
      ticker: null,
      tone: "info",
    });
    expect(
      flowWallDriftView(
        { ...labFlowSnapshot("SPY", 30), gex: null },
        null,
        { kind: "loading" },
        LAB_NOW
      ).reason
    ).toBe("no GEX snapshot yet for this symbol");
  });

  it("shows no data while net drift loads, failed or has no series", () => {
    expect(
      flowWallDriftView(snapshotAt(), null, { kind: "loading" }, LAB_NOW).reason
    ).toBe("net drift is loading");
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        { kind: "failed", message: "STORAGE_ERROR: retry" },
        LAB_NOW
      ).reason
    ).toBe("net drift not loaded: STORAGE_ERROR: retry");
    const control = controlWith("SPY", []);
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        ready({
          ...control,
          netDrift: control.netDrift.filter((row) => row.ticker !== "SPY"),
        }),
        LAB_NOW
      ).reason
    ).toBe("no net drift series for SPY");
  });

  it("adds the collector message of a failing feed to a no-data read only", () => {
    const failing = flowWallDriftView(
      snapshotAt(),
      null,
      ready(
        controlWith("SPY", [], {
          message: "QuantData answered HTTP 401",
          state: "closed",
        })
      ),
      LAB_NOW
    );
    expect(failing).toMatchObject({
      code: "window_short",
      collectorNote: "QuantData answered HTTP 401",
      read: "no-data",
    });
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        ready(controlWith("SPY", [], { message: "ok", state: "fresh" })),
        LAB_NOW
      ).collectorNote
    ).toBeNull();
    expect(
      flowWallDriftView(
        snapshotAt(),
        null,
        ready(
          controlWith("SPY", risingCallPoints, {
            message: "late answer",
            state: "closed",
          })
        ),
        LAB_NOW
      )
    ).toMatchObject({ collectorNote: null, read: "hold-A" });
  });
});

const analytics = (): OptionsAnalyticsOutput =>
  ({
    context: { levels: { callWall: 620, flip: 590, putWall: 600 } },
    receivedAt: minutesAgo(1),
    spot: 600.4,
    symbol: "spy",
  }) as unknown as OptionsAnalyticsOutput;

describe("stockWallDriftView", () => {
  it("reads the options analytics levels with the ticker's net drift", () => {
    const view = stockWallDriftView(
      "SPY",
      { analytics: analytics(), kind: "ready" },
      ready(controlWith("SPY", risingCallPoints)),
      LAB_NOW
    );
    expect(view).toMatchObject({ read: "hold-A", ticker: "SPY" });
    expect(view.inputs).toContain("levels options_analytics at");
  });

  it("refuses analytics of another symbol", () => {
    expect(
      stockWallDriftView(
        "QQQ",
        { analytics: analytics(), kind: "ready" },
        { kind: "loading" },
        LAB_NOW
      )
    ).toMatchObject({
      code: "ticker_mismatch",
      reason: "options analytics is for spy, not QQQ",
    });
  });

  it("names missing analytics as the no-data reason", () => {
    expect(
      stockWallDriftView(
        "QQQ",
        { detail: "options analytics is loading", kind: "missing" },
        { kind: "loading" },
        LAB_NOW
      )
    ).toMatchObject({
      code: "gex_missing",
      reason: "options analytics is loading",
      ticker: null,
    });
  });
});
