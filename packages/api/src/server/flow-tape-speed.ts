// What: the pure assembly of flow-tape-speed.v1 (flow.tapeSpeed) from stored rows: the time axis
// and the bucket of one window, one bar per bucket from the per-second counts of the streamed tape
// (flow_tape_seconds), the bursts by the tape speed rule, and the freshness of the tape.
// Used by: packages/api/src/server/flow.ts (the flow.tapeSpeed handler).
// Research only: a bar and a burst describe how fast the tape traded; they are never a trade
// signal. Doc: docs/vertex-rebuild/flow-pipeline.md ("Tape speed (ES, NQ)").
import {
  FLOW_TAPE_SPEED_MAX_BURSTS,
  FLOW_TAPE_SPEED_VERSION,
  type FlowTapeSpeed,
  type FlowTapeSpeedBar,
  type FlowTapeSymbol,
} from "../contracts/flow.ts";
import type { FlowTapeSecondsRow } from "../flow-tape-seconds.ts";
import {
  FLOW_TAPE_SPEED_RULES,
  foldTapeBursts,
  type JudgedTapeSecond,
  judgeTapeSeconds,
  type TapeSecond,
} from "../flow-tape-speed-rules.ts";
import { buildSourceFreshness, type FlowSampleRow } from "./flow-snapshot.ts";

const MINUTE_SECONDS = 60;
const MINUTE_MS = 60_000;

/** The bar length of a window: it depends on the window only, never on the screen. */
export const tapeSpeedBucketSeconds = (minutes: number): number => {
  if (minutes <= 60) return 10;
  if (minutes <= 120) return 20;
  return 60;
};

export type FlowTapeSpeedAxis = Readonly<{
  /** Start of the minute of the window start. */
  axisStart: Date;
  /** End of the minute of the window end: the axis holds the window's minutes plus one. */
  axisEnd: Date;
  /** axisStart minus the baseline of the rule: the rule needs these seconds for the first bar. */
  readFrom: Date;
}>;

export const tapeSpeedAxis = (
  windowStart: Date,
  windowEnd: Date
): FlowTapeSpeedAxis => {
  const floor = (date: Date) =>
    Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;
  const axisStart = floor(windowStart);
  return {
    axisEnd: new Date(floor(windowEnd) + MINUTE_MS),
    axisStart: new Date(axisStart),
    readFrom: new Date(
      axisStart - FLOW_TAPE_SPEED_RULES.baselineSeconds * 1000
    ),
  };
};

export type FlowTapeSpeedRows = Readonly<{
  symbol: FlowTapeSymbol;
  /** The window length of the request. */
  minutes: number;
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  /** Per-second rows with readFrom <= minute < axisEnd. */
  seconds: readonly FlowTapeSecondsRow[];
  /** The minutes with axisStart <= minute < axisEnd that have a minute row (flow_minutes). */
  minuteStarts: readonly Date[];
  /** Newest sample of any status, and newest ok sample, per source. */
  latest: readonly FlowSampleRow[];
  latestOk: readonly FlowSampleRow[];
}>;

const epochSeconds = (date: Date): number => date.getTime() / 1000;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** The covered seconds of the rows inside [from, to), ascending. */
const coveredSeconds = (
  rows: readonly FlowTapeSecondsRow[],
  from: number,
  to: number
): TapeSecond[] => {
  const seconds: TapeSecond[] = [];
  const ordered = [...rows].sort(
    (a, b) => a.minute.getTime() - b.minute.getTime()
  );
  for (const row of ordered) {
    const minute = epochSeconds(row.minute);
    if (minute < from || minute >= to) continue;
    for (let index = 0; index < MINUTE_SECONDS; index += 1)
      if (row.covered[index] === "1")
        seconds.push({
          contracts: row.contracts[index] as number,
          t: minute + index,
          trades: row.trades[index] as number,
        });
  }
  return seconds;
};

/**
 * flow-tape-speed.v1 of one window. Bar states, in this order: `counted` when the minute of the
 * bar has a per-second row and the bar has a covered second; `not_recorded` when the minute has no
 * per-second row and has a minute row (collected before the feature, or the per-second write
 * failed); `no_data` otherwise. Rates, peaks and the rule use covered seconds only. A burst is
 * listed when it has a second on the axis, so every mark of the chart has a row.
 */
export const buildFlowTapeSpeed = (rows: FlowTapeSpeedRows): FlowTapeSpeed => {
  const axis = tapeSpeedAxis(rows.windowStart, rows.windowEnd);
  const start = epochSeconds(axis.axisStart);
  const end = epochSeconds(axis.axisEnd);
  const bucket = tapeSpeedBucketSeconds(rows.minutes);

  const judged = judgeTapeSeconds(
    coveredSeconds(rows.seconds, epochSeconds(axis.readFrom), end)
  );
  const onAxis = judged.filter((second) => second.t >= start);
  const bySecond = new Map<number, JudgedTapeSecond>(
    onAxis.map((second) => [second.t, second])
  );
  const stored = rows.seconds
    .filter((row) => {
      const minute = epochSeconds(row.minute);
      return minute >= start && minute < end;
    })
    .sort((a, b) => a.minute.getTime() - b.minute.getTime());
  const storedMinutes = new Set(stored.map((row) => epochSeconds(row.minute)));
  const collectedMinutes = new Set(rows.minuteStarts.map(epochSeconds));

  const bars: FlowTapeSpeedBar[] = [];
  for (let from = start; from < end; from += bucket) {
    const bar = {
      burstSeconds: 0,
      contracts: 0,
      coveredSeconds: 0,
      peakContracts: 0,
      peakTrades: 0,
      trades: 0,
    };
    for (let t = from; t < from + bucket; t += 1) {
      const second = bySecond.get(t);
      if (second === undefined) continue;
      bar.coveredSeconds += 1;
      bar.trades += second.trades;
      bar.contracts += second.contracts;
      bar.peakTrades = Math.max(bar.peakTrades, second.trades);
      bar.peakContracts = Math.max(bar.peakContracts, second.contracts);
      if (second.verdict === "burst") bar.burstSeconds += 1;
    }
    const minute = Math.floor(from / MINUTE_SECONDS) * MINUTE_SECONDS;
    const state = ((): FlowTapeSpeedBar["state"] => {
      if (storedMinutes.has(minute))
        return bar.coveredSeconds > 0 ? "counted" : "no_data";
      return collectedMinutes.has(minute) ? "not_recorded" : "no_data";
    })();
    bars.push({ ...bar, start: iso(from), state });
  }

  const bursts = foldTapeBursts(judged).filter(
    (burst) => burst.start + burst.seconds - 1 >= start
  );
  const newest = stored.at(-1);
  return {
    axisStart: axis.axisStart.toISOString(),
    bars,
    bucketSeconds: bucket,
    bursts: bursts.slice(-FLOW_TAPE_SPEED_MAX_BURSTS).map((burst) => ({
      baseline: burst.baseline,
      contracts: burst.contracts,
      multiple: burst.baseline > 0 ? burst.peakTrades / burst.baseline : null,
      peakTrades: burst.peakTrades,
      seconds: burst.seconds,
      start: iso(burst.start),
    })),
    contract: newest?.contract ?? null,
    rules: { ...FLOW_TAPE_SPEED_RULES },
    schemaVersion: FLOW_TAPE_SPEED_VERSION,
    storedUntil:
      newest === undefined
        ? null
        : iso(epochSeconds(newest.minute) + MINUTE_SECONDS),
    symbol: rows.symbol,
    tape: buildSourceFreshness(rows, "ticks"),
    totals: {
      bursts: bursts.length,
      coveredSeconds: onAxis.length,
      evaluatedSeconds: onAxis.filter(
        (second) => second.verdict !== "not_evaluated"
      ).length,
    },
  };
};
