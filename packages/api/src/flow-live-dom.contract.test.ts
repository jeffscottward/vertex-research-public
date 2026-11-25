import { describe, expect, it } from "vitest";

import {
  FLOW_LIVE_DOM_CADENCE_MS,
  FLOW_LIVE_DOM_VERSION,
  FLOW_LIVE_DOM_WINDOW_SECONDS,
  FlowLiveDomInputSchema,
  FlowLiveDomSchema,
  FlowLiveDomStreamEventSchema,
  FlowLiveDomStreamInputSchema,
  flowContract,
} from "./contracts/flow.ts";
import { buildFlowLiveDom } from "./flow-live-dom-rules.ts";

describe("flow.liveDom and flow.liveDomStream contracts", () => {
  it("coerces GET query strings and applies defaults on input schemas", () => {
    expect(FlowLiveDomInputSchema.parse({ symbol: "ES" })).toEqual({
      rows: 10,
      symbol: "ES",
      windowSeconds: 900,
    });
    expect(
      FlowLiveDomInputSchema.parse({
        rows: "5",
        since: "1763900000",
        symbol: "NQ",
        windowSeconds: "3600",
      })
    ).toEqual({
      rows: 5,
      since: 1_763_900_000,
      symbol: "NQ",
      windowSeconds: 3600,
    });
    expect(
      FlowLiveDomStreamInputSchema.parse({
        cadenceMs: "1000",
        rows: "8",
        symbol: "ES",
        windowSeconds: "300",
      })
    ).toEqual({
      cadenceMs: 1000,
      rows: 8,
      symbol: "ES",
      windowSeconds: 300,
    });
    expect(FLOW_LIVE_DOM_WINDOW_SECONDS).toEqual([300, 900, 1800, 3600]);
    expect(FLOW_LIVE_DOM_CADENCE_MS).toEqual([500, 1000, 2000]);
  });

  it("rejects out-of-range symbols, rows, non-preset windows/cadences, and extra keys", () => {
    expect(FlowLiveDomInputSchema.safeParse({ symbol: "SPY" }).success).toBe(
      false
    );
    expect(
      FlowLiveDomInputSchema.safeParse({ rows: 0, symbol: "ES" }).success
    ).toBe(false);
    expect(
      FlowLiveDomInputSchema.safeParse({ rows: 11, symbol: "ES" }).success
    ).toBe(false);
    expect(
      FlowLiveDomInputSchema.safeParse({ symbol: "ES", windowSeconds: 60 })
        .success
    ).toBe(false);
    expect(
      FlowLiveDomInputSchema.safeParse({ since: 0, symbol: "ES" }).success
    ).toBe(false);
    expect(
      FlowLiveDomInputSchema.safeParse({ extra: 1, symbol: "ES" }).success
    ).toBe(false);
    expect(
      FlowLiveDomStreamInputSchema.safeParse({ cadenceMs: 250, symbol: "ES" })
        .success
    ).toBe(false);
  });

  it("validates FlowLiveDomSchema and all FlowLiveDomStreamEventSchema variants", () => {
    const frame = buildFlowLiveDom({
      asks: [[6012.5, 40]],
      bids: [[6012.25, 55]],
      capturedAt: "2026-11-24T14:30:00.000Z",
      contract: "ESZ6",
      depthFeed: {
        error: null,
        lastAt: "2026-11-24T14:30:00.000Z",
        state: "live",
      },
      depthUpdates: 10,
      lastTrade: {
        price: 6012.5,
        side: "buy",
        size: 3,
        t: "2026-11-24T14:30:00.000Z",
      },
      minTick: 0.25,
      seq: 12,
      since: null,
      source: "live_stream",
      symbol: "ES",
      tapeFeed: {
        error: null,
        lastAt: "2026-11-24T14:30:00.000Z",
        state: "live",
      },
      tapeSeq: 2,
      volumeByPrice: [[6012.5, 3, 0, 0, 1]],
      volumeSource: "streamed_tape",
      windowSeconds: 900,
    });

    expect(FlowLiveDomSchema.parse(frame).schemaVersion).toBe(
      FLOW_LIVE_DOM_VERSION
    );
    expect(
      FlowLiveDomStreamEventSchema.parse({ frame, type: "frame" }).type
    ).toBe("frame");
    expect(
      FlowLiveDomStreamEventSchema.parse({
        at: "2026-11-24T14:30:05.000Z",
        seq: 12,
        type: "heartbeat",
      }).type
    ).toBe("heartbeat");
    expect(
      FlowLiveDomStreamEventSchema.parse({
        at: "2026-11-24T14:30:20.000Z",
        reason: "lease_expired",
        retryAfterMs: 250,
        type: "reconnect",
      }).type
    ).toBe("reconnect");
  });

  it("exposes GET routes for flow.liveDom and flow.liveDomStream", () => {
    const liveDomMeta = (
      flowContract.liveDom as unknown as {
        "~orpc": {
          route: { method: string; path: string; operationId: string };
        };
      }
    )["~orpc"].route;
    const streamMeta = (
      flowContract.liveDomStream as unknown as {
        "~orpc": {
          route: { method: string; path: string; operationId: string };
        };
      }
    )["~orpc"].route;
    expect(liveDomMeta.method).toBe("GET");
    expect(liveDomMeta.path).toBe("/flow/live-dom");
    expect(liveDomMeta.operationId).toBe("flow.liveDom");
    expect(streamMeta.method).toBe("GET");
    expect(streamMeta.path).toBe("/flow/live-dom/stream");
    expect(streamMeta.operationId).toBe("flow.liveDomStream");
  });
});
