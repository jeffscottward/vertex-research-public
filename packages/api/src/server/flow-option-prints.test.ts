import type {
  FlowOptionGapRecord,
  FlowOptionPrintRecord,
  FlowOptionTapeSummaryRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import {
  FLOW_OPTION_PRINTS_VERSION,
  FlowOptionPrintsSchema,
} from "../contracts/flow.ts";
import {
  FLOW_OPTION_STREAMS,
  flowOptionStreamForSymbol,
} from "../flow-features.ts";
import {
  buildFlowOptionPrints,
  FLOW_OPTION_PRINTS_SOURCE,
  flowOptionDelayLabel,
  readFlowOptionPrintsRows,
} from "./flow-option-prints.ts";
import { flowSessionOpen, flowStaleSeconds } from "./flow-snapshot.ts";

// Monday 2026-11-23; New York is UTC-5. 15:00 ET = 20:00Z.
const OPEN_ET_1500 = new Date("2026-11-23T20:00:00.000Z");
// 16:05 ET = 21:05Z (index/ETF options open until 16:15 ET; NVDA equity options closed at 16:00 ET).
const ET_1605 = new Date("2026-11-23T21:05:00.000Z");
// 18:00 ET = 23:00Z (all options closed).
const CLOSED_ET_1800 = new Date("2026-11-23T23:00:00.000Z");

const samplePrint = (
  overrides: Partial<FlowOptionPrintRecord> = {}
): FlowOptionPrintRecord => ({
  ask: 5.2,
  bid: 5.1,
  consolidation: "sweep",
  dte: 10,
  expiry: "2026-12-04",
  goldenSweep: true,
  id: "p-iwm-1",
  iv: 0.24,
  moneyness: "otm",
  moneynessPct: 1.5,
  openInterest: 1200,
  opening: true,
  premium: 250_000,
  price: 5.2,
  right: "call",
  sentiment: "bullish",
  side: "above_ask",
  size: 480,
  strike: 230,
  symbol: "IWM",
  ticker: "IWM",
  tradedAt: new Date("2026-11-23T19:58:00.000Z"),
  underlyingPrice: 226.5,
  unusual: true,
  volume: 1500,
  volumeOverOi: true,
  ...overrides,
});

const emptySummary: FlowOptionTapeSummaryRecord = {
  bearishPremium: 0,
  blocks: 0,
  bullishPremium: 0,
  callPremium: 0,
  goldenSweeps: 0,
  putPremium: 0,
  sweeps: 0,
  trades: 0,
  unusualCount: 0,
};

const sampleRow = (
  symbol: FlowSampleRecord["symbol"],
  at: Date,
  status: FlowSampleRecord["status"] = "ok",
  message: string | null = "10 prints on 1 page(s)"
): FlowSampleRecord => ({
  at,
  items: status === "ok" ? 10 : 0,
  message,
  source: "options",
  status,
  symbol,
});

const gapRow = (
  symbol: FlowOptionGapRecord["symbol"]
): FlowOptionGapRecord => ({
  createdAt: new Date("2026-11-23T19:30:00.000Z"),
  endTime: new Date("2026-11-23T19:29:00.000Z"),
  startTime: new Date("2026-11-23T19:15:00.000Z"),
  symbol,
});

const fakeRepo = (overrides: Partial<FlowRepository> = {}): FlowRepository =>
  ({
    latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
    newestOptionPrintAt: vi.fn(async () => null),
    optionGaps: vi.fn(async () => []),
    readOptionTape: vi.fn(async () => ({ prints: [], summary: emptySummary })),
    ...overrides,
  }) as unknown as FlowRepository;

describe("flowOptionDelayLabel and per-ticker close hours", () => {
  it("formats 16:15 ET for index/broad-ETF options and 16:00 ET for NVDA equity options", () => {
    expect(flowOptionDelayLabel(FLOW_OPTION_STREAMS.SPY)).toContain(
      "09:30-16:15 ET"
    );
    expect(flowOptionDelayLabel(FLOW_OPTION_STREAMS.IWM)).toContain(
      "09:30-16:15 ET"
    );
    expect(flowOptionDelayLabel(FLOW_OPTION_STREAMS.NVDA)).toContain(
      "09:30-16:00 ET"
    );
  });

  it("closes NVDA at 16:00 ET while index/ETF options remain open until 16:15 ET", () => {
    expect(flowSessionOpen("options", "SPY", ET_1605)).toBe(true);
    expect(flowSessionOpen("options", "IWM", ET_1605)).toBe(true);
    expect(flowSessionOpen("options", "QQQ", ET_1605)).toBe(true);
    expect(flowSessionOpen("options", "NQ", ET_1605)).toBe(true);
    expect(flowSessionOpen("options", "NVDA", ET_1605)).toBe(false);
    expect(flowSessionOpen("ticks", "IWM", OPEN_ET_1500)).toBe(false);
    expect(flowStaleSeconds("options", "NVDA")).toBe(300);
    expect(flowStaleSeconds("ticks", "IWM")).toBe(600);
  });
});

describe("buildFlowOptionPrints and readFlowOptionPrintsRows", () => {
  it("builds a valid flow-option-prints.v1 document with full-window summary, unreadRanges and freshness", () => {
    const print = samplePrint();
    const okSample = sampleRow(
      "IWM",
      new Date(OPEN_ET_1500.getTime() - 60_000)
    );
    const out = buildFlowOptionPrints({
      gaps: [gapRow("IWM"), gapRow("IWM")],
      latest: [okSample],
      latestOk: [okSample],
      now: OPEN_ET_1500,
      prints: [print],
      stream: flowOptionStreamForSymbol("IWM"),
      summary: {
        bearishPremium: 50_000,
        blocks: 3,
        bullishPremium: 700_000,
        callPremium: 650_000,
        goldenSweeps: 2,
        putPremium: 100_000,
        sweeps: 8,
        trades: 42,
        unusualCount: 6,
      },
      windowEnd: OPEN_ET_1500,
      windowMinutes: 60,
      windowStart: new Date(OPEN_ET_1500.getTime() - 60 * 60_000),
    });
    expect(FlowOptionPrintsSchema.parse(out)).toEqual(out);
    expect(out.schemaVersion).toBe(FLOW_OPTION_PRINTS_VERSION);
    expect(out.source).toBe(FLOW_OPTION_PRINTS_SOURCE);
    expect(out.ticker).toBe("IWM");
    expect(out.symbol).toBe("IWM");
    expect(out.freshness.state).toBe("fresh");
    expect(out.unreadRanges).toBe(2);
    // Summary holds all 42 trades in the window even though prints holds 1 capped row.
    expect(out.summary.trades).toBe(42);
    expect(out.prints).toHaveLength(1);
    expect(out.prints[0]?.contract).toBe("IWM 2026-12-04 230C");
  });

  it("returns null opening and volumeOverOi flags on OI-0 and stored-null prints", () => {
    const okSample = sampleRow(
      "SPY",
      new Date(OPEN_ET_1500.getTime() - 60_000)
    );
    const out = buildFlowOptionPrints({
      gaps: [],
      latest: [okSample],
      latestOk: [okSample],
      now: OPEN_ET_1500,
      prints: [
        samplePrint({
          id: "legacy-oi-0",
          openInterest: 0,
          opening: true,
          symbol: "SPY",
          ticker: "SPY",
          volumeOverOi: true,
        }),
        samplePrint({
          id: "stored-null",
          openInterest: 0,
          opening: null,
          symbol: "SPY",
          ticker: "SPY",
          volumeOverOi: null,
        }),
      ],
      stream: flowOptionStreamForSymbol("SPY"),
      summary: emptySummary,
      windowEnd: OPEN_ET_1500,
      windowMinutes: 60,
      windowStart: new Date(OPEN_ET_1500.getTime() - 3_600_000),
    });
    expect(FlowOptionPrintsSchema.parse(out)).toEqual(out);
    expect(out.prints[0]).toMatchObject({ opening: null, volumeOverOi: null });
    expect(out.prints[1]).toMatchObject({ opening: null, volumeOverOi: null });
  });

  it("reports stale, closed and never freshness states accurately", () => {
    const oldSample = sampleRow(
      "NVDA",
      new Date(OPEN_ET_1500.getTime() - 400_000)
    );
    const staleOut = buildFlowOptionPrints({
      gaps: [],
      latest: [oldSample],
      latestOk: [oldSample],
      now: OPEN_ET_1500,
      prints: [],
      stream: flowOptionStreamForSymbol("NVDA"),
      summary: emptySummary,
      windowEnd: OPEN_ET_1500,
      windowMinutes: 60,
      windowStart: new Date(OPEN_ET_1500.getTime() - 3_600_000),
    });
    expect(staleOut.freshness.state).toBe("stale");

    const closedOut = buildFlowOptionPrints({
      gaps: [],
      latest: [oldSample],
      latestOk: [oldSample],
      now: ET_1605,
      prints: [],
      stream: flowOptionStreamForSymbol("NVDA"),
      summary: emptySummary,
      windowEnd: oldSample.at,
      windowMinutes: 60,
      windowStart: new Date(oldSample.at.getTime() - 3_600_000),
    });
    expect(closedOut.freshness.state).toBe("closed");

    const neverOut = buildFlowOptionPrints({
      gaps: [],
      latest: [],
      latestOk: [],
      now: OPEN_ET_1500,
      prints: [],
      stream: flowOptionStreamForSymbol("QQQ"),
      summary: emptySummary,
      windowEnd: OPEN_ET_1500,
      windowMinutes: 60,
      windowStart: new Date(OPEN_ET_1500.getTime() - 3_600_000),
    });
    expect(neverOut.freshness.state).toBe("never");
  });

  it("anchors closed windows to newestOptionPrintAt and falls back to now when empty", async () => {
    const newest = new Date("2026-11-23T20:55:00.000Z");
    const repo = fakeRepo({
      newestOptionPrintAt: vi.fn(async () => newest),
      readOptionTape: vi.fn(async () => ({
        prints: [
          samplePrint({ symbol: "NQ", ticker: "NDX", tradedAt: newest }),
        ],
        summary: { ...emptySummary, trades: 1 },
      })),
    });
    const rows = await readFlowOptionPrintsRows(
      repo,
      { limit: 50, ticker: "NDX", windowMinutes: 60 },
      CLOSED_ET_1800
    );
    expect(rows.stream.symbol).toBe("NQ");
    expect(rows.windowEnd).toEqual(newest);
    expect(rows.windowStart).toEqual(new Date(newest.getTime() - 3_600_000));

    const emptyRepo = fakeRepo();
    const emptyRows = await readFlowOptionPrintsRows(
      emptyRepo,
      { limit: 25, ticker: "SPX", windowMinutes: 30 },
      CLOSED_ET_1800
    );
    expect(emptyRows.stream.symbol).toBe("ES");
    expect(emptyRows.windowEnd).toEqual(CLOSED_ET_1800);
  });

  it("falls back to newestOptionPrintAt during an open session when the live window has 0 prints", async () => {
    const earlier = new Date("2026-11-20T20:50:00.000Z");
    const readOptionTape = vi
      .fn<FlowRepository["readOptionTape"]>()
      .mockResolvedValueOnce({ prints: [], summary: emptySummary })
      .mockResolvedValueOnce({
        prints: [
          samplePrint({ symbol: "NVDA", ticker: "NVDA", tradedAt: earlier }),
        ],
        summary: { ...emptySummary, trades: 3 },
      });
    const repo = fakeRepo({
      newestOptionPrintAt: vi.fn(async () => earlier),
      readOptionTape,
    });
    const rows = await readFlowOptionPrintsRows(
      repo,
      { limit: 50, ticker: "NVDA", windowMinutes: 60 },
      OPEN_ET_1500
    );
    expect(readOptionTape).toHaveBeenCalledTimes(2);
    expect(rows.windowEnd).toEqual(earlier);
    expect(rows.summary.trades).toBe(3);
  });
});
