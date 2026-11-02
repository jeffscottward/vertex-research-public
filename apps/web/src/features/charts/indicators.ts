import { CandleSchema } from "@darkfactory/api/vertex";
import type { SourceIdentity } from "@darkfactory/api/vertex";
import {
  decimalUnits,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type {
  ChartView,
  IndicatorPoint,
  IndicatorRequest,
  IndicatorSeries,
} from "./types";

const SCALE = 10n ** 18n;
const MAX_ROWS = 4096;
const MAX_PERIOD = 512;
const kinds = ["sma", "ema", "vwap", "rsi"] as const;

const validRequest = (request: IndicatorRequest): boolean => {
  return (
    request !== null &&
    typeof request === "object" &&
    kinds.some((kind) => kind === request.kind) &&
    Number.isInteger(request.period) &&
    request.period >= 1 &&
    request.period <= MAX_PERIOD
  );
};

// A tiny allowlisted grammar, not an expression language. No whitespace,
// case coercion, callbacks, functions, nesting, trailing newline, or evaluation.
export const parseIndicatorRequest = (
  text: string
): IndicatorRequest | null => {
  if (typeof text !== "string" || text.length > 9) return null;
  const match = /^(SMA|EMA|VWAP|RSI)\(([1-9][0-9]{0,2})\)$/.exec(text);
  if (!match || match[0] !== text) return null;
  const kind = (match[1] ?? "").toLowerCase() as IndicatorRequest["kind"];
  const period = Number(match[2]);
  return period <= MAX_PERIOD ? { kind, period } : null;
};

// Only the final nonnegative rational value is rounded down to 18 places.
// EMA/RSI intermediate states remain rational bigint pairs, not rounded values.
// Serialize canonically after flooring: shared decimalUnits rejects padded
// trailing fractional zeros. Precision remains 18 places, not fixed-width text.
const fixed = (units: bigint): string => {
  const fraction = (units % SCALE)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${units / SCALE}.${fraction}` : (units / SCALE).toString();
};

const methods: Record<IndicatorRequest["kind"], string> = {
  sma: "SMA uses trailing closing prices. Warmup requires a full period. The final value is rounded down to 18 decimal places.",
  ema: "EMA uses closing prices. The first full-period SMA supplies the initial value. Alpha=2/(period+1). Recurrence uses exact rational arithmetic. The final value is rounded down to 18 decimal places.",
  vwap: "VWAP uses a trailing full-period volume-weighted candle approximation with typical price ((high+low+close)/3). It is not tick VWAP or session-cumulative VWAP. The host must select one calendar and session. Zero-total-volume windows are omitted. The final value is rounded down to 18 decimal places.",
  rsi: "Wilder RSI uses closing prices. The initial value uses one period of closing-price changes. Alpha=1/period. Recurrence uses exact rational arithmetic. Flat gain/loss=50, no loss=100, no gain=0. The final value is rounded down to 18 decimal places.",
};

// Input is the rights-screened exact view, never a lossy renderer projection.
// Periods/row indices are bounded integers; all derived financial arithmetic is
// bigint. Rational denominators grow only across at most MAX_ROWS input rows.
// Recalculate from the retained prefix: EMA/RSI do not claim history before it.
// Candle schema has no session identity. VWAP needs the authenticated host's
// verified membership plus current derive permission; labels/UTC dates confer neither.
export const calculateIndicator = (
  view: ChartView<"candles">,
  request: IndicatorRequest
): IndicatorSeries => {
  const usableRequest = validRequest(request);
  const warmup = usableRequest
    ? request.kind === "rsi"
      ? request.period
      : request.period - 1
    : 0;
  const inputSources: SourceIdentity[] = [];
  const points: IndicatorPoint[] = [];
  const method = usableRequest
    ? methods[request.kind]
    : "Unsupported indicator request.";
  const unavailable = (reason: string): IndicatorSeries => ({
    request,
    points: [],
    warmup,
    method,
    inputSources: [],
    status: "unavailable",
    reason,
    tradingAuthority: false,
  });
  if (!usableRequest)
    return unavailable(
      "Indicator kind and integer period 1..512 are required."
    );
  if (
    view.selection.derivationRights !== "granted" ||
    !view.selection.derivationExpiresAt
  )
    return unavailable(
      "Current server policy has not granted derived-indicator use."
    );
  try {
    if (
      timestampToEpochNanoseconds(view.selection.derivationExpiresAt) <=
      timestampToEpochNanoseconds(view.evaluatedAt)
    )
      return unavailable("Derived-indicator rights have expired.");
  } catch {
    return unavailable("Derived-indicator rights cannot be verified.");
  }
  if (
    view.phase !== "live" &&
    view.phase !== "snapshot" &&
    view.phase !== "stale"
  )
    return unavailable(
      "A current immutable snapshot, live, or explicitly stale rights-screened candle view is required."
    );
  if (view.withheld !== 0)
    return unavailable(
      "Indicators cannot calculate across candles withheld from display."
    );
  if (view.records.length === 0 || view.records.length > MAX_ROWS)
    return unavailable(
      "Indicator input requires 1–4096 candles. Input outside this range is rejected."
    );
  if (view.selection.kind !== "candles")
    return unavailable("Candle selection is required.");
  if (
    request.kind === "vwap" &&
    (view.selection.sessionMembership !== "verified" ||
      !view.selection.calendar.trim() ||
      !view.selection.sessionLabel.trim())
  ) {
    return unavailable(
      "VWAP requires verified single-session membership; a session label alone is not proof."
    );
  }
  const closes: bigint[] = [];
  const volumes: bigint[] = [];
  const weighted: bigint[] = [];
  const identities = new Set<string>();
  const candleIds = new Set<string>();
  let previousEnd: bigint | null = null;
  try {
    const evaluatedAt = timestampToEpochNanoseconds(view.evaluatedAt);
    for (const candle of view.records) {
      if (!CandleSchema.safeParse(candle).success)
        return unavailable("Malformed canonical candle input.");
      const start = timestampToEpochNanoseconds(candle.startAtInclusive);
      const end = timestampToEpochNanoseconds(candle.endAtExclusive);
      if (previousEnd !== null && start < previousEnd)
        return unavailable(
          "Candles must be chronological and nonoverlapping; input is never sorted silently."
        );
      if (end > evaluatedAt)
        return unavailable(
          "Unclosed or future candles cannot produce causal indicators."
        );
      if (candleIds.has(candle.candleId))
        return unavailable("Duplicate candle identity.");
      candleIds.add(candle.candleId);
      previousEnd = end;
      const identity = candle.source.identity;
      if (
        candle.instrumentId !== view.selection.instrumentId ||
        candle.currency !== view.selection.currency ||
        candle.interval !== view.selection.interval ||
        identity.provider !== view.selection.provider ||
        identity.sourceId !== view.selection.sourceId
      ) {
        return unavailable(
          "Candles must belong to one selected instrument, currency, interval and source."
        );
      }
      const rights = candle.source.entitlement;
      if (
        rights.status !== "granted" ||
        rights.expiresAt === null ||
        timestampToEpochNanoseconds(rights.expiresAt) <= evaluatedAt ||
        timestampToEpochNanoseconds(rights.checkedAt) > evaluatedAt
      ) {
        return unavailable(
          "Current display rights are unavailable for a candle."
        );
      }
      if (
        candle.source.freshness.status !== "fresh" &&
        candle.source.freshness.status !== "stale"
      ) {
        return unavailable("Candle freshness is unknown or missing.");
      }
      const key = JSON.stringify([
        identity.provider,
        identity.sourceId,
        identity.snapshotId,
        identity.contentHash,
      ]);
      if (!identities.has(key)) {
        identities.add(key);
        inputSources.push({ ...identity });
      }
      const close = decimalUnits(candle.close);
      const volume = decimalUnits(candle.volume);
      closes.push(close);
      volumes.push(volume);
      weighted.push(
        (decimalUnits(candle.high) + decimalUnits(candle.low) + close) * volume
      );
    }
  } catch {
    return unavailable(
      "Malformed decimal, timestamp, or canonical candle input."
    );
  }
  const period = BigInt(request.period);
  let sum = 0n;
  let volumeSum = 0n;
  let weightSum = 0n;
  let numerator = 0n;
  let denominator = 1n;
  let gains = 0n;
  let losses = 0n;
  let omitted = 0;
  // Indices stay within [0, closes.length), where all three series are populated.
  const at = (values: readonly bigint[], index: number): bigint =>
    values[index] ?? 0n;
  for (let index = 0; index < closes.length; index += 1) {
    const close = at(closes, index);
    let value: bigint | null = null;
    if (request.kind === "sma" || request.kind === "ema") {
      if (index < request.period) sum += close;
      if (request.kind === "sma") {
        if (index >= request.period)
          sum += close - at(closes, index - request.period);
        if (index >= warmup) value = sum / period;
      } else if (index === warmup) {
        numerator = sum;
        denominator = period;
        value = numerator / denominator;
      } else if (index > warmup) {
        numerator = numerator * (period - 1n) + 2n * close * denominator;
        denominator *= period + 1n;
        value = numerator / denominator;
      }
    } else if (request.kind === "vwap") {
      volumeSum += at(volumes, index);
      weightSum += at(weighted, index);
      if (index >= request.period) {
        volumeSum -= at(volumes, index - request.period);
        weightSum -= at(weighted, index - request.period);
      }
      if (index >= warmup) {
        if (volumeSum > 0n) {
          value = weightSum / (3n * volumeSum);
        } else omitted += 1;
      }
    } else if (index > 0) {
      const delta = close - at(closes, index - 1);
      const gain = delta > 0n ? delta : 0n;
      const loss = delta < 0n ? -delta : 0n;
      if (index <= request.period) {
        gains += gain;
        losses += loss;
        if (index === request.period) denominator = period;
      } else {
        gains = gains * (period - 1n) + gain * denominator;
        losses = losses * (period - 1n) + loss * denominator;
        denominator *= period;
      }
      if (index >= warmup) {
        value =
          gains === 0n && losses === 0n
            ? 50n * SCALE
            : (100n * SCALE * gains) / (gains + losses);
      }
    }
    const candle = view.records[index];
    if (value !== null && candle !== undefined) {
      // Available only at the close, never at the start of the input candle.
      points.push({
        candleId: candle.candleId,
        timestamp: candle.endAtExclusive,
        value: fixed(value),
      });
    }
  }
  const labels = [
    "Display only. No trading authority. The calculation starts with the first retained input.",
  ];
  if (view.phase === "stale") labels.push("Stale input; not a live signal.");
  if (
    view.synthetic ||
    view.records.some((candle) => candle.source.dataKind === "synthetic")
  )
    labels.push("Synthetic input.");
  if (omitted > 0)
    labels.push(
      `${omitted} zero-total-volume windows omitted; missing points are gaps, not zeros.`
    );
  if (points.length === 0)
    labels.push(
      view.records.length <= warmup
        ? "Insufficient warmup history."
        : "No defined indicator points."
    );
  return {
    request,
    points,
    warmup,
    method,
    inputSources,
    status: points.length > 0 ? "available" : "unavailable",
    reason: labels.join(" "),
    tradingAuthority: false,
  };
};
