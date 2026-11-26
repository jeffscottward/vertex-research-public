// What: pure assembly and repository read of flow.optionPrints (flow-option-prints.v1) for all
// live QuantData option-print tickers (SPY, SPX, QQQ, NDX, IWM, NVDA). Research only; never a
// trade signal. Doc: docs/vertex-rebuild/designs/smart-money/plan-pr4.md.
import type {
  FlowOptionGapRecord,
  FlowOptionPrintRecord,
  FlowOptionTapeSummaryRecord,
  FlowRepository,
  FlowSampleRecord,
} from "@darkfactory/db/server";

import {
  FLOW_OPTION_PRINTS_VERSION,
  type FlowOptionPrints,
  type FlowOptionPrintsParsedInput,
} from "../contracts/flow.ts";
import {
  type FlowOptionStream,
  flowOptionStreamForSymbol,
  flowOptionSymbolForTicker,
} from "../flow-features.ts";
import {
  buildSourceFreshness,
  flowSessionOpen,
  printView,
} from "./flow-snapshot.ts";

export const FLOW_OPTION_PRINTS_SOURCE =
  "QuantData order-flow/consolidated" as const;

/** Human-readable delay and regular options hours derived from the stream's ET close minute. */
export const flowOptionDelayLabel = (stream: FlowOptionStream): string => {
  const hour = String(Math.floor(stream.closeMinuteEt / 60)).padStart(2, "0");
  const minute = String(stream.closeMinuteEt % 60).padStart(2, "0");
  return `Intraday; collected every ~2 minutes during US options hours (09:30-${hour}:${minute} ET).`;
};

export type FlowOptionPrintsRows = Readonly<{
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  windowMinutes: number;
  stream: FlowOptionStream;
  summary: FlowOptionTapeSummaryRecord;
  prints: readonly FlowOptionPrintRecord[];
  gaps: readonly FlowOptionGapRecord[];
  latest: readonly FlowSampleRecord[];
  latestOk: readonly FlowSampleRecord[];
}>;

export const buildFlowOptionPrints = (
  rows: FlowOptionPrintsRows
): FlowOptionPrints => ({
  asOf: rows.now.toISOString(),
  delay: flowOptionDelayLabel(rows.stream),
  freshness: buildSourceFreshness(
    {
      latest: rows.latest,
      latestOk: rows.latestOk,
      now: rows.now,
      symbol: rows.stream.symbol,
    },
    "options"
  ),
  prints: rows.prints.map(printView),
  schemaVersion: FLOW_OPTION_PRINTS_VERSION,
  source: FLOW_OPTION_PRINTS_SOURCE,
  summary: {
    bearishPremium: rows.summary.bearishPremium,
    blocks: rows.summary.blocks,
    bullishPremium: rows.summary.bullishPremium,
    callPremium: rows.summary.callPremium,
    goldenSweeps: rows.summary.goldenSweeps,
    putPremium: rows.summary.putPremium,
    sweeps: rows.summary.sweeps,
    ticker: rows.stream.optionsTicker,
    trades: rows.summary.trades,
    unusualCount: rows.summary.unusualCount,
  },
  symbol: rows.stream.symbol,
  ticker: rows.stream.optionsTicker,
  unreadRanges: rows.gaps.length,
  windowEnd: rows.windowEnd.toISOString(),
  windowMinutes: rows.windowMinutes,
  windowStart: rows.windowStart.toISOString(),
});

/**
 * Reads stored option prints, full-window summary, open gap count and options freshness for one
 * ticker. While the session is open the window ends at `now` (falling back to the newest stored
 * print if the live window has 0 prints); while closed it anchors at the newest stored print so
 * off-hours and weekend views show the last session instead of an empty screen.
 */
export const readFlowOptionPrintsRows = async (
  repository: FlowRepository,
  input: FlowOptionPrintsParsedInput,
  now: Date
): Promise<FlowOptionPrintsRows> => {
  const symbol = flowOptionSymbolForTicker(input.ticker);
  const stream = flowOptionStreamForSymbol(symbol);
  const windowMs = input.windowMinutes * 60_000;
  const open = flowSessionOpen("options", symbol, now);
  const [gaps, samples, newest] = await Promise.all([
    repository.optionGaps(symbol),
    repository.latestSamples(symbol, ["options"]),
    repository.newestOptionPrintAt(symbol),
  ]);
  let windowEnd = open ? now : (newest ?? now);
  let windowStart = new Date(windowEnd.getTime() - windowMs);
  let tape = await repository.readOptionTape({
    from: windowStart,
    limit: input.limit,
    symbol,
    to: windowEnd,
  });
  if (open && tape.summary.trades === 0 && newest !== null && newest < now) {
    windowEnd = newest;
    windowStart = new Date(windowEnd.getTime() - windowMs);
    tape = await repository.readOptionTape({
      from: windowStart,
      limit: input.limit,
      symbol,
      to: windowEnd,
    });
  }
  return {
    gaps,
    latest: samples.latest,
    latestOk: samples.latestOk,
    now,
    prints: tape.prints,
    stream,
    summary: tape.summary,
    windowEnd,
    windowMinutes: input.windowMinutes,
    windowStart,
  };
};
