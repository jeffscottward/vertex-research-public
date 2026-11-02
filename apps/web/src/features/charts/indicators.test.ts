import { describe, expect, it } from "vitest";
import { CandleSchema } from "@darkfactory/api/vertex";
import type { Candle } from "@darkfactory/api/vertex";
import { decimalUnits } from "@darkfactory/shared/vertex";
import type { ChartView, IndicatorRequest } from "./types";
import { calculateIndicator, parseIndicatorRequest } from "./indicators";

const at = (second: number): string => {
  const hours = Math.floor(second / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((second % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (second % 60).toString().padStart(2, "0");
  return `2026-09-22T${hours}:${minutes}:${seconds}Z`;
};

const candle = (close: string, index: number, volume = "1"): Candle => {
  return CandleSchema.parse({
    schemaVersion: "1.0.0",
    candleId: `candle-${index}`,
    instrumentId: "instrument-1",
    currency: "USD",
    startAtInclusive: at(index),
    endAtExclusive: at(index + 1),
    interval: "1s",
    open: close,
    high: close,
    low: close,
    close,
    volume,
    source: {
      identity: {
        provider: "fixture",
        sourceId: "fixture-source",
        snapshotId: "snapshot-1",
        contentHash: "a".repeat(64),
      },
      dataKind: "synthetic",
      syntheticReason: "indicator regression fixture",
      providerTimezone: "UTC",
      entitlement: {
        policyId: "fixture-policy",
        status: "granted",
        checkedAt: at(0),
        expiresAt: "2026-09-23T00:00:00Z",
      },
      freshness: {
        status: "fresh",
        observedAt: at(index + 1),
        evaluatedAt: at(43_200),
        maxAgeMs: 86_400_000,
      },
    },
  });
};

const viewOf = (records: readonly Candle[]): ChartView<"candles"> => ({
  selection: {
    kind: "candles",
    instrumentId: "instrument-1",
    currency: "USD",
    provider: "fixture",
    sourceId: "fixture-source",
    interval: "1s",
    calendar: "fixture-calendar",
    sessionLabel: "2026-09-22-regular",
    sessionMembership: "verified",
    derivationRights: "granted",
    derivationExpiresAt: "2026-09-23T00:00:00Z",
    quantityUnit: "shares",
  },
  phase: "live",
  transport: "live",
  freshness: "fresh",
  reason: "fixture",
  records,
  sources: records.map((row) => row.source.identity),
  evaluatedAt: at(43_200),
  asOf: records.at(-1)?.endAtExclusive ?? null,
  synthetic: true,
  retained: records.length,
  withheld: 0,
  evicted: 0,
  snapshotId: "snapshot-1",
  sequence: "1",
  tradingAuthority: false,
});

const view = (
  closes: readonly string[],
  volumes?: readonly string[]
): ChartView<"candles"> => {
  return viewOf(
    closes.map((close, index) => candle(close, index, volumes?.[index] ?? "1"))
  );
};

const values = (
  input: ChartView<"candles">,
  kind: IndicatorRequest["kind"],
  period: number
): readonly string[] => {
  return calculateIndicator(input, { kind, period }).points.map(
    (point) => point.value
  );
};

describe("bounded exact display indicators", () => {
  it("parses only complete short allowlisted requests", () => {
    expect(parseIndicatorRequest("SMA(20)")).toEqual({
      kind: "sma",
      period: 20,
    });
    expect(parseIndicatorRequest("EMA(1)")).toEqual({ kind: "ema", period: 1 });
    expect(parseIndicatorRequest("VWAP(512)")).toEqual({
      kind: "vwap",
      period: 512,
    });
    expect(parseIndicatorRequest("RSI(14)")).toEqual({
      kind: "rsi",
      period: 14,
    });
    for (const text of [
      "SMA(0)",
      "SMA(513)",
      "SMA(-1)",
      "SMA(1.5)",
      "SMA(01)",
      "SMA(1e2)",
      "sma(20)",
      " SMA(20)",
      "SMA(20)\n",
      "SMA(20);alert(1)",
      "SMA(close,20)",
      "EMA(SMA(2))",
      "RSI(2)+1",
      "Math.max(1)",
      "constructor(1)",
      "VWAP",
      "x".repeat(10_000),
    ]) {
      expect(parseIndicatorRequest(text)).toBeNull();
    }
    return;
  });

  it("preserves huge and sub-unit decimals without floating point", () => {
    const input = view([
      "999999999999999999999999999999.999999999999999998",
      "999999999999999999999999999999.999999999999999999",
    ]);
    expect(values(input, "sma", 2)).toEqual([
      "999999999999999999999999999999.999999999999999998",
    ]);
    expect(
      values(view(["0.000000000000000001", "0.000000000000000002"]), "sma", 2)
    ).toEqual(["0.000000000000000001"]);
    expect(input.records[1]!.close).toBe(
      "999999999999999999999999999999.999999999999999999"
    );
    return;
  });

  it("emits only full-window SMA and seeded EMA at candle close", () => {
    const input = view(["1", "2", "3", "4"]);
    for (const kind of ["sma", "ema"] as const) {
      const series = calculateIndicator(input, { kind, period: 2 });
      expect(series.warmup).toBe(1);
      expect(series.points.map((point) => point.value)).toEqual([
        "1.5",
        "2.5",
        "3.5",
      ]);
      expect(series.points[0]).toEqual({
        candleId: "candle-1",
        timestamp: at(2),
        value: "1.5",
      });
      expect(series.tradingAuthority).toBe(false);
    }
    expect(values(input, "ema", 1)).toEqual(["1", "2", "3", "4"]);
    return;
  });

  it("keeps rational EMA state before the final floor", () => {
    const input = view(["0", "1", "0", "0"]);
    expect(values(input, "ema", 2)).toEqual([
      "0.5",
      "0.166666666666666666",
      "0.055555555555555555",
    ]);
    expect(
      calculateIndicator(input, { kind: "ema", period: 2 }).method
    ).toContain("exact rational");
    return;
  });

  it("serializes floored output as canonical decimals accepted by display arithmetic", () => {
    for (const kind of ["sma", "ema", "vwap", "rsi"] as const) {
      const series = calculateIndicator(view(["0", "0", "1", "2", "2"]), {
        kind,
        period: 2,
      });
      for (const point of series.points) {
        expect(() => decimalUnits(point.value)).not.toThrow();
        expect(point.value).not.toMatch(/\.\d*0$/);
      }
    }
    expect(values(view(["0", "0"]), "sma", 2)).toEqual(["0"]);
    expect(values(view(["1", "2"]), "sma", 2)).toEqual(["1.5"]);
    return;
  });

  it("documents insufficient history rather than emitting seed zeros", () => {
    for (const kind of ["sma", "ema", "vwap", "rsi"] as const) {
      const result = calculateIndicator(view(["5"]), { kind, period: 2 });
      expect(result.status).toBe("unavailable");
      expect(result.points).toEqual([]);
      expect(result.reason).toContain("Insufficient warmup");
      expect(result.warmup).toBe(kind === "rsi" ? 2 : 1);
    }
    return;
  });

  it("uses typical-price weighted approximation with no intermediate price floor", () => {
    const first = { ...candle("2", 0, "1"), open: "1", low: "1", high: "2" };
    const second = candle("4", 1, "2");
    const result = calculateIndicator(viewOf([first, second]), {
      kind: "vwap",
      period: 2,
    });
    expect(result.points[0]!.value).toBe("3.222222222222222222");
    expect(result.method).toContain("not tick VWAP");
    expect(result.method).toContain("session-cumulative");
    return;
  });

  it("omits zero-total-volume windows and resumes without fabricated zeros", () => {
    const input = view(["5", "6", "7", "8"], ["0", "0", "1", "0"]);
    const result = calculateIndicator(input, { kind: "vwap", period: 2 });
    expect(result.status).toBe("available");
    expect(result.points.map((point) => point.candleId)).toEqual([
      "candle-2",
      "candle-3",
    ]);
    expect(result.points.map((point) => point.value)).toEqual(["7", "7"]);
    expect(result.reason).toContain("1 zero-total-volume");
    const empty = calculateIndicator(view(["5", "6"], ["0", "0"]), {
      kind: "vwap",
      period: 2,
    });
    expect(empty.status).toBe("unavailable");
    expect(empty.points).toEqual([]);
    const gap = calculateIndicator(view(["2", "3", "4"], ["1", "0", "1"]), {
      kind: "vwap",
      period: 1,
    });
    expect(gap.points.map((point) => point.candleId)).toEqual([
      "candle-0",
      "candle-2",
    ]);
    expect(gap.points.map((point) => point.timestamp)).toEqual([at(1), at(3)]);
    return;
  });

  it("requires verified session ownership rather than guessing from a label or UTC reset", () => {
    const input = view(["1", "2"]);
    const { sessionMembership: _membership, ...unqualified } = input.selection;
    for (const selection of [
      { ...input.selection, calendar: "" },
      { ...input.selection, sessionLabel: " " },
      { ...input.selection, sessionMembership: "unavailable" as const },
      unqualified,
    ]) {
      const result = calculateIndicator(
        { ...input, selection },
        { kind: "vwap", period: 1 }
      );
      expect(result.status).toBe("unavailable");
      expect(result.reason).toContain("verified");
    }
    return;
  });

  it("permits non-session indicators on immutable snapshots without granting VWAP membership", () => {
    const input = view(["1", "2", "3"]);
    const snapshot: ChartView<"candles"> = {
      ...input,
      phase: "snapshot",
      transport: "snapshot",
      selection: { ...input.selection, sessionMembership: "unavailable" },
    };
    expect(
      calculateIndicator(snapshot, { kind: "sma", period: 2 }).points.map(
        (point) => point.value
      )
    ).toEqual(["1.5", "2.5"]);
    expect(
      calculateIndicator(snapshot, { kind: "vwap", period: 2 }).status
    ).toBe("unavailable");
    return;
  });

  it("requires current derive permission independently of entitled raw candles or session labels", () => {
    const input = view(["1", "2", "3"]);
    const {
      derivationRights: _rights,
      derivationExpiresAt: _expiry,
      ...unqualified
    } = input.selection;
    for (const selection of [
      unqualified,
      { ...input.selection, derivationRights: "unavailable" as const },
      { ...input.selection, derivationExpiresAt: at(43_200) },
      { ...input.selection, derivationExpiresAt: null },
    ]) {
      for (const kind of ["sma", "ema", "rsi", "vwap"] as const) {
        expect(
          calculateIndicator({ ...input, selection }, { kind, period: 2 })
            .status
        ).toBe("unavailable");
      }
      expect(input.records).toHaveLength(3);
    }
    return;
  });

  it("implements Wilder RSI with explicit flat, all-gain and all-loss behavior", () => {
    const request = { kind: "rsi", period: 2 } as const;
    const mixed = calculateIndicator(view(["1", "3", "2", "4"]), request);
    expect(mixed.warmup).toBe(2);
    expect(mixed.points.map((point) => point.value)).toEqual([
      "66.666666666666666666",
      "85.714285714285714285",
    ]);
    expect(values(view(["3", "3", "3"]), "rsi", 2)).toEqual(["50"]);
    expect(values(view(["1", "2", "3"]), "rsi", 2)).toEqual(["100"]);
    expect(values(view(["3", "2", "1"]), "rsi", 2)).toEqual(["0"]);
    expect(values(view(["1", "2", "1", "1"]), "rsi", 1)).toEqual([
      "100",
      "0",
      "50",
    ]);
    expect(mixed.method).toContain("Flat gain/loss=50");
    return;
  });

  it("restarts recursive seeds at the retained prefix and exposes that limitation", () => {
    const complete = view(["10", "12", "9", "15", "11", "20"]);
    const retained = { ...viewOf(complete.records.slice(2)), evicted: 2 };
    for (const kind of ["ema", "rsi"] as const) {
      const result = calculateIndicator(retained, { kind, period: 2 });
      expect(result.reason).toContain(
        "The calculation starts with the first retained input."
      );
      expect(result.warmup).toBe(kind === "rsi" ? 2 : 1);
      expect(result.points[0]!.candleId).toBe(
        kind === "rsi" ? "candle-4" : "candle-3"
      );
      expect(result.points[0]!.timestamp).toBe(kind === "rsi" ? at(5) : at(4));
    }
    expect(
      calculateIndicator(retained, { kind: "ema", period: 2 }).points[0]!.value
    ).toBe("12");
    expect(
      calculateIndicator(retained, { kind: "rsi", period: 2 }).points[0]!.value
    ).toBe("60");
    return;
  });

  it("never changes historical points when future valid candles are appended", () => {
    const complete = view(["10", "12", "9", "15", "11", "20"]);
    for (const kind of ["sma", "ema", "vwap", "rsi"] as const) {
      const request = { kind, period: 2 };
      const prefix = calculateIndicator(
        viewOf(complete.records.slice(0, 4)),
        request
      );
      const full = calculateIndicator(complete, request);
      expect(full.points.slice(0, prefix.points.length)).toEqual(prefix.points);
    }
    const future = calculateIndicator(
      { ...complete, evaluatedAt: at(5) },
      { kind: "sma", period: 2 }
    );
    expect(future.status).toBe("unavailable");
    expect(future.reason).toContain("future");
    return;
  });

  it("refuses withheld, rights-unavailable and nonlive phases with no source leakage", () => {
    const input = view(["1", "2"]);
    for (const phase of [
      "rights-unavailable",
      "loading",
      "empty",
      "disconnected",
      "gap",
      "backpressure",
      "error",
      "unavailable",
      "unknown",
    ] as const) {
      const result = calculateIndicator(
        { ...input, phase },
        { kind: "sma", period: 1 }
      );
      expect(result.status).toBe("unavailable");
      expect(result.points).toEqual([]);
      expect(result.inputSources).toEqual([]);
    }
    expect(
      calculateIndicator({ ...input, withheld: 1 }, { kind: "sma", period: 1 })
        .status
    ).toBe("unavailable");
    const original = input.records[0]!;
    const denied: Candle = {
      ...original,
      source: {
        ...original.source,
        entitlement: {
          ...original.source.entitlement,
          status: "denied",
          expiresAt: null,
        },
      },
    };
    expect(
      calculateIndicator(viewOf([denied]), { kind: "sma", period: 1 }).status
    ).toBe("unavailable");
    const expired: Candle = {
      ...original,
      source: {
        ...original.source,
        entitlement: { ...original.source.entitlement, expiresAt: at(2) },
      },
    };
    expect(
      calculateIndicator(viewOf([expired]), { kind: "sma", period: 1 }).status
    ).toBe("unavailable");
    return;
  });

  it("retains distinct input source identities and stale/synthetic labels", () => {
    const first = candle("1", 0);
    const second: Candle = {
      ...candle("2", 1),
      source: {
        ...first.source,
        identity: {
          ...first.source.identity,
          snapshotId: "snapshot-2",
          contentHash: "b".repeat(64),
        },
      },
    };
    const input = viewOf([first, second, candle("3", 2)]);
    const result = calculateIndicator(
      { ...input, phase: "stale" },
      { kind: "sma", period: 2 }
    );
    expect(result.inputSources).toEqual([
      first.source.identity,
      second.source.identity,
    ]);
    expect(result.reason).toContain("Stale input");
    expect(result.reason).toContain("Synthetic input");
    expect(result.tradingAuthority).toBe(false);
    expect(result.inputSources[0]).not.toBe(first.source.identity);
    return;
  });

  it("rejects unordered, overlapping, duplicate and mismatched selections", () => {
    const input = view(["1", "2", "3"]);
    const first = input.records[0]!;
    const second = input.records[1]!;
    const badRows: Candle[][] = [
      [second, first],
      [first, { ...second, startAtInclusive: at(0) }],
      [first, { ...second, candleId: first.candleId }],
      [first, { ...second, instrumentId: "another-instrument" }],
      [first, { ...second, interval: "1m" }],
      [first, { ...second, currency: "EUR" }],
      [
        first,
        {
          ...second,
          source: {
            ...second.source,
            identity: { ...second.source.identity, sourceId: "another-source" },
          },
        },
      ],
    ];
    for (const rows of badRows) {
      expect(
        calculateIndicator(viewOf(rows), { kind: "sma", period: 1 }).status
      ).toBe("unavailable");
    }
    return;
  });

  it("orders nanoseconds and equivalent offsets instead of timestamp spellings", () => {
    const first: Candle = {
      ...candle("1", 0),
      startAtInclusive: "2026-09-22T01:00:00+01:00",
      endAtExclusive: "2026-09-22T01:00:00.000000001+01:00",
    };
    const second: Candle = {
      ...candle("2", 1),
      startAtInclusive: "2026-09-22T00:00:00.000000001Z",
      endAtExclusive: "2026-09-22T00:00:00.000000002Z",
    };
    expect(
      calculateIndicator(viewOf([first, second]), { kind: "sma", period: 1 })
        .status
    ).toBe("available");
    expect(
      calculateIndicator(viewOf([second, first]), { kind: "sma", period: 1 })
        .status
    ).toBe("unavailable");
    return;
  });

  it("bounds both direct requests and rows without silent clipping", () => {
    const input = view(["1"]);
    for (const period of [
      0,
      -1,
      1.5,
      513,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(calculateIndicator(input, { kind: "sma", period }).status).toBe(
        "unavailable"
      );
    }
    expect(
      calculateIndicator(input, {
        kind: "arbitrary",
        period: 1,
      } as unknown as IndicatorRequest).status
    ).toBe("unavailable");
    expect(
      calculateIndicator(view([]), { kind: "sma", period: 1 }).status
    ).toBe("unavailable");
    const maximum = view(Array.from({ length: 4096 }, () => "1"));
    expect(
      calculateIndicator(maximum, { kind: "sma", period: 512 }).points
    ).toHaveLength(3585);
    expect(
      calculateIndicator(
        { ...maximum, records: [...maximum.records, candle("1", 4096)] },
        { kind: "sma", period: 1 }
      ).status
    ).toBe("unavailable");
    return;
  });

  return it("fails closed on malformed exact values without throwing or mutating input", () => {
    const input = view(["1", "2"]);
    const malformed = { ...input.records[0]!, close: "NaN" };
    expect(
      calculateIndicator(viewOf([malformed]), { kind: "sma", period: 1 }).status
    ).toBe("unavailable");
    expect(
      calculateIndicator(
        { ...input, evaluatedAt: "not-a-timestamp" },
        { kind: "sma", period: 1 }
      ).status
    ).toBe("unavailable");
    const before = JSON.stringify(input);
    calculateIndicator(input, { kind: "ema", period: 1 });
    expect(JSON.stringify(input)).toBe(before);
    return;
  });
});
