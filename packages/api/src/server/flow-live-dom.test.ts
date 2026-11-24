import type {
  FlowBookSnapshotRecord,
  FlowLargeTradeRecord,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import type {
  FlowLiveDomParsedInput,
  FlowLiveDomStreamEvent,
  FlowLiveDomStreamParsedInput,
} from "../contracts/flow.ts";
import {
  abortableSleep,
  FLOW_LIVE_DOM_FALLBACK_TRADES_CAP,
  type FlowLiveDomDeps,
  type LiveDomRepository,
  liveDomFrameKey,
  openFlowLiveDomStream,
  readFlowLiveDomSnapshot,
} from "./flow-live-dom.ts";
import { MarketDataError, type MarketDom } from "./market-data.ts";

const T0 = new Date("2026-11-24T14:30:00.000Z");

const sampleDom = (over: Partial<MarketDom> = {}): MarketDom => ({
  asks: [[6012.5, 45]],
  bids: [[6012.25, 60]],
  contract: {
    conId: 42,
    currency: "USD",
    exchange: "CME",
    lastTradeDateOrContractMonth: "20261218",
    localSymbol: "ESZ6",
    longName: "E-mini S&P 500",
    matches: 1,
    multiplier: "50",
    secType: "FUT",
    timeZoneId: "US/Central",
  },
  depthStream: {
    error: null,
    lastAt: "2026-11-24T14:30:00Z",
    state: "live",
  },
  depthUpdates: 100,
  fetchedAt: "2026-11-24T14:30:00Z",
  lastTrade: {
    price: 6012.5,
    side: "buy",
    size: 4,
    t: Math.floor(T0.getTime() / 1000),
  },
  minTick: 0.25,
  receivedAt: "2026-11-24T14:30:00.000Z",
  seq: 120,
  since: null,
  source: "ibkr-gateway",
  symbol: "ES",
  tapeSeq: 20,
  tapeStream: {
    error: null,
    lastAt: "2026-11-24T14:30:00Z",
    state: "live",
  },
  volumeByPrice: [[6012.5, 40, 10, 0, 5]],
  windowSeconds: 900,
  ...over,
});

const snapshotRow = (
  over: Partial<FlowBookSnapshotRecord> = {}
): FlowBookSnapshotRecord => ({
  askPrices: [6012.5, 6012.75],
  askSizes: [30, 50],
  bestAsk: 6012.5,
  bestBid: 6012.25,
  bidPrices: [6012.25, 6012.0],
  bidSizes: [40, 80],
  capture: "streamed",
  capturedAt: new Date("2026-11-24T14:29:55.000Z"),
  contract: "ESZ6",
  minTick: 0.25,
  symbol: "ES",
  ...over,
});

const largeTrade = (
  seq: number,
  side: "buy" | "sell",
  price: number,
  size: number,
  at = new Date("2026-11-24T14:29:50.000Z")
): FlowLargeTradeRecord => ({
  capture: "streamed",
  limitSize: 10,
  price,
  sampledAt: at,
  second: at,
  seq,
  side,
  signing: "quote",
  size,
  symbol: "ES",
});

const makeRepo = (
  over: Partial<LiveDomRepository> = {}
): LiveDomRepository => ({
  latestSamples: vi.fn(async () => ({
    latest: [],
    latestOk: [
      {
        at: new Date("2026-11-24T14:29:55.000Z"),
        items: 10,
        message: null,
        source: "depth" as const,
        status: "ok" as const,
        symbol: "ES" as const,
      },
      {
        at: new Date("2026-11-24T14:29:54.000Z"),
        items: 25,
        message: null,
        source: "ticks" as const,
        status: "ok" as const,
        symbol: "ES" as const,
      },
    ],
  })),
  readBookSnapshots: vi.fn(async () => [snapshotRow()]),
  readLargeTrades: vi.fn(async () => [
    largeTrade(1, "buy", 6012.5, 12),
    largeTrade(2, "sell", 6012.25, 18),
    largeTrade(3, "buy", 6012.5, 20, new Date("2026-11-24T14:29:52.000Z")),
    largeTrade(0, "sell", 6012.25, 11, new Date("2026-11-24T14:29:45.000Z")),
  ]),
  ...over,
});

const baseInput: FlowLiveDomParsedInput = {
  rows: 10,
  symbol: "ES",
  windowSeconds: 900,
};

const baseStreamInput: FlowLiveDomStreamParsedInput = {
  ...baseInput,
  cadenceMs: 500,
};

const collectAll = async (
  iter: AsyncIterable<FlowLiveDomStreamEvent>
): Promise<FlowLiveDomStreamEvent[]> => {
  const events: FlowLiveDomStreamEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
};

describe("abortableSleep", () => {
  it("resolves immediately if already aborted, resolves after timer, and cancels on abort", async () => {
    const already = new AbortController();
    already.abort();
    await expect(abortableSleep(50, already.signal)).resolves.toBeUndefined();

    await expect(abortableSleep(1)).resolves.toBeUndefined();

    const mid = new AbortController();
    const pending = abortableSleep(5000, mid.signal);
    mid.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("readFlowLiveDomSnapshot", () => {
  it("uses live vertex-history /dom with zero Postgres queries when book is live", async () => {
    const repo = makeRepo();
    const fetchDom = vi.fn(async () => sampleDom());
    const frame = await readFlowLiveDomSnapshot(
      { fetchDom, now: () => T0, repository: repo },
      { ...baseInput, since: 1_763_994_000 }
    );
    expect(frame.source).toBe("live_stream");
    expect(frame.volumeSource).toBe("streamed_tape");
    expect(frame.contract).toBe("ESZ6");
    expect(frame.bestBid).toBe(6012.25);
    expect(frame.bestAsk).toBe(6012.5);
    expect(repo.readBookSnapshots).not.toHaveBeenCalled();
    expect(repo.readLargeTrades).not.toHaveBeenCalled();
    expect(liveDomFrameKey(frame)).toBe("ESZ6:live_stream:live:live:100:20");
  });

  it("handles live /dom with null contract, null lastTrade, and empty volumeByPrice", async () => {
    const fetchDom = vi.fn(async () =>
      sampleDom({
        bids: [],
        contract: null,
        lastTrade: null,
        volumeByPrice: [],
      })
    );
    const frame = await readFlowLiveDomSnapshot(
      { fetchDom, repository: null },
      baseInput
    );
    expect(frame.source).toBe("live_stream");
    expect(frame.volumeSource).toBe("none");
    expect(frame.contract).toBeNull();
    expect(frame.lastTrade).toBeNull();
    expect(liveDomFrameKey(frame)).toBe(":live_stream:live:live:100:20");
  });

  it("falls back to recorded Postgres snapshots when /dom returns 404, errors, or is unconfigured", async () => {
    const repo = makeRepo();
    const notDeployed = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () => {
          throw new MarketDataError("NOT_FOUND", "HTTP 404");
        }),
        now: () => T0,
        repository: repo,
      },
      baseInput
    );
    expect(notDeployed.source).toBe("recorded_fallback");
    expect(notDeployed.volumeSource).toBe("large_trades_only");
    expect(notDeployed.depthFeed.error).toContain("HTTP 404");
    expect(notDeployed.lastTrade?.size).toBe(20);

    const genericErr = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () => {
          throw new Error("boom");
        }),
        now: () => T0,
        repository: repo,
      },
      baseInput
    );
    expect(genericErr.depthFeed.error).toBe(
      "Live history service request failed"
    );

    const mdeErr = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () => {
          throw new MarketDataError("UNAVAILABLE", "History timed out");
        }),
        now: () => T0,
        repository: repo,
      },
      baseInput
    );
    expect(mdeErr.depthFeed.error).toBe("History timed out");

    const unconfigured = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: repo },
      baseInput
    );
    expect(unconfigured.source).toBe("recorded_fallback");
    expect(unconfigured.depthFeed.error).toContain("VERTEX_HISTORY_URL");
  });

  it("handles starting/non-live /dom using live tape when contract matches and skipping when mismatched", async () => {
    const repo = makeRepo();
    const startingMatching = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () =>
          sampleDom({
            asks: [],
            bids: [],
            depthStream: { error: null, lastAt: null, state: "starting" },
          })
        ),
        now: () => T0,
        repository: repo,
      },
      baseInput
    );
    expect(startingMatching.source).toBe("recorded_fallback");
    expect(startingMatching.volumeSource).toBe("streamed_tape");
    expect(startingMatching.depthFeed.state).toBe("starting");

    const startingNoLastTrade = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () =>
          sampleDom({
            asks: [],
            bids: [],
            depthStream: {
              error: "warming up",
              lastAt: "2026-11-24T14:29:59Z",
              state: "starting",
            },
            lastTrade: null,
          })
        ),
        now: () => T0,
        repository: makeRepo({ readBookSnapshots: vi.fn(async () => []) }),
      },
      baseInput
    );
    expect(startingNoLastTrade.source).toBe("empty");
    expect(startingNoLastTrade.volumeSource).toBe("streamed_tape");
    expect(startingNoLastTrade.lastTrade).toBeNull();
    expect(startingNoLastTrade.depthFeed.error).toBe("warming up");

    const startingMismatch = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () =>
          sampleDom({
            asks: [],
            bids: [],
            contract: {
              conId: 99,
              currency: "USD",
              exchange: "CME",
              lastTradeDateOrContractMonth: "20270319",
              localSymbol: "ESH7",
              longName: "E-mini S&P 500",
              matches: 1,
              multiplier: "50",
              secType: "FUT",
              timeZoneId: "US/Central",
            },
            depthStream: { error: null, lastAt: null, state: "down" },
          })
        ),
        now: () => T0,
        repository: repo,
      },
      baseInput
    );
    expect(startingMismatch.volumeSource).toBe("large_trades_only");
  });

  it("caps fallback large trades, skips readLargeTrades when since > anchor, handles empty repo/null repo, and rethrows aborts", async () => {
    const manyTrades: FlowLargeTradeRecord[] = [];
    for (let i = 0; i < FLOW_LIVE_DOM_FALLBACK_TRADES_CAP + 5; i += 1) {
      manyTrades.push(largeTrade(i, i % 2 === 0 ? "buy" : "sell", 6012.5, 10));
    }
    const cappedRepo = makeRepo({
      readLargeTrades: vi.fn(async () => manyTrades),
    });
    const capped = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: cappedRepo },
      baseInput
    );
    expect(capped.totals.trades).toBe(FLOW_LIVE_DOM_FALLBACK_TRADES_CAP);

    const futureSinceRepo = makeRepo();
    const skippedTrades = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: futureSinceRepo },
      { ...baseInput, since: Math.floor(T0.getTime() / 1000) + 60 }
    );
    expect(futureSinceRepo.readLargeTrades).not.toHaveBeenCalled();
    expect(skippedTrades.volumeSource).toBe("none");

    // Ask-only snapshot with shorter sizes array + rows cap covers pairsFromArrays & ask-only branch
    const askOnlyRepo = makeRepo({
      readBookSnapshots: vi.fn(async () => [
        snapshotRow({
          askPrices: [6012.5, 6012.75, 6013.0],
          askSizes: [25, 30],
          bestBid: null,
          bidPrices: [],
          bidSizes: [],
        }),
      ]),
      readLargeTrades: vi.fn(async () => []),
    });
    const askOnlyFrame = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: askOnlyRepo },
      { ...baseInput, rows: 1 }
    );
    expect(askOnlyFrame.source).toBe("recorded_fallback");
    expect(askOnlyFrame.rows).toHaveLength(1);
    const askShortFrame = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: askOnlyRepo },
      { ...baseInput, rows: 10 }
    );
    expect(askShortFrame.rows).toHaveLength(2);

    // Non-live /dom with null lastAt and no snapshot -> depthFeed.lastAt stays null
    const noLastAt = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () =>
          sampleDom({
            asks: [],
            bids: [],
            depthStream: { error: null, lastAt: null, state: "starting" },
            volumeByPrice: [],
          })
        ),
        now: () => T0,
        repository: null,
      },
      baseInput
    );
    expect(noLastAt.depthFeed.lastAt).toBeNull();

    // Live depthStream state with empty bids/asks reports clear empty-book message
    const liveEmptyBook = await readFlowLiveDomSnapshot(
      {
        fetchDom: vi.fn(async () =>
          sampleDom({
            asks: [],
            bids: [],
            depthStream: {
              error: null,
              lastAt: "2026-11-24T14:30:00Z",
              state: "live",
            },
            volumeByPrice: [],
          })
        ),
        now: () => T0,
        repository: null,
      },
      baseInput
    );
    expect(liveEmptyBook.depthFeed.error).toBe(
      "Live CME depth stream returned an empty book"
    );

    const emptyRepo = makeRepo({
      latestSamples: vi.fn(async () => ({ latest: [], latestOk: [] })),
      readBookSnapshots: vi.fn(async () => []),
      readLargeTrades: vi.fn(async () => []),
    });
    const emptyFrame = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: emptyRepo },
      baseInput
    );
    expect(emptyFrame.source).toBe("empty");
    expect(emptyFrame.depthFeed.state).toBe("never");
    expect(emptyFrame.tapeFeed.state).toBe("never");

    const nullRepoFrame = await readFlowLiveDomSnapshot(
      { fetchDom: null, now: () => T0, repository: null },
      baseInput
    );
    expect(nullRepoFrame.source).toBe("empty");

    const ac = new AbortController();
    ac.abort();
    await expect(
      readFlowLiveDomSnapshot(
        {
          fetchDom: vi.fn(async () => {
            throw new MarketDataError(
              "UNAVAILABLE",
              "History request cancelled"
            );
          }),
          now: () => T0,
          repository: emptyRepo,
        },
        baseInput,
        ac.signal
      )
    ).rejects.toThrow("History request cancelled");
  });
});

describe("openFlowLiveDomStream", () => {
  it("streams changed frames, deduplicates unchanged frames, emits heartbeats, and ends cleanly on lease expiry", async () => {
    let nowMs = T0.getTime();
    let call = 0;
    const responses: MarketDom[] = [
      sampleDom({ depthUpdates: 100, seq: 120 }),
      sampleDom({ depthUpdates: 100, seq: 120 }), // unchanged -> no emit yet
      sampleDom({ depthUpdates: 100, seq: 120 }), // unchanged past heartbeatMs -> heartbeat
      sampleDom({ depthUpdates: 101, seq: 121 }), // changed -> emit frame
    ];
    const deps: FlowLiveDomDeps = {
      fetchDom: vi.fn(async () => responses[call++] ?? responses[3]!),
      heartbeatMs: 1000,
      leaseMs: 3000,
      maxPolls: 10,
      now: () => new Date(nowMs),
      repository: null,
      sleep: async (ms) => {
        nowMs += ms;
      },
    };
    const stream = await openFlowLiveDomStream(deps, {
      ...baseStreamInput,
      cadenceMs: 500,
    });
    const events = await collectAll(stream);
    expect(events.map((e) => e.type)).toEqual([
      "frame",
      "heartbeat",
      "frame",
      "heartbeat",
      "reconnect",
    ]);
    const last = events.at(-1);
    expect(last?.type === "reconnect" && last.reason).toBe("lease_expired");
  });

  it("emits single fallback frame and recorded_fallback reconnect when initial read is not live", async () => {
    const repo = makeRepo();
    const stream = await openFlowLiveDomStream(
      { fetchDom: null, now: () => T0, repository: repo },
      baseStreamInput
    );
    // Initial DB read already completed BEFORE generator iteration started!
    expect(repo.readBookSnapshots).toHaveBeenCalledTimes(1);
    const events = await collectAll(stream);
    expect(events.map((e) => e.type)).toEqual(["frame", "reconnect"]);
    const last = events[1];
    expect(last?.type === "reconnect" && last.reason).toBe("recorded_fallback");
  });

  it("emits upstream_interrupted reconnect on mid-stream error or non-live book", async () => {
    let nowMs = T0.getTime();
    let step = 0;
    const errStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => {
          step += 1;
          if (step === 1) return sampleDom();
          throw new MarketDataError("UNAVAILABLE", "connection reset");
        }),
        leaseMs: 10_000,
        now: () => new Date(nowMs),
        repository: null,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
      baseStreamInput
    );
    const errEvents = await collectAll(errStream);
    expect(errEvents.map((e) => e.type)).toEqual(["frame", "reconnect"]);
    expect(errEvents[1]?.type === "reconnect" && errEvents[1].reason).toBe(
      "upstream_interrupted"
    );

    let step2 = 0;
    const downStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => {
          step2 += 1;
          if (step2 === 1) return sampleDom();
          return sampleDom({
            asks: [],
            bids: [],
            depthStream: { error: null, lastAt: null, state: "down" },
          });
        }),
        leaseMs: 10_000,
        now: () => new Date(nowMs),
        repository: null,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
      baseStreamInput
    );
    const downEvents = await collectAll(downStream);
    expect(downEvents.map((e) => e.type)).toEqual(["frame", "reconnect"]);
    expect(downEvents[1]?.type === "reconnect" && downEvents[1].reason).toBe(
      "upstream_interrupted"
    );
  });

  it("stops cleanly on abort during sleep, abort during fetch, remaining < 500ms, or maxPolls cap", async () => {
    let nowMs = T0.getTime();
    const acSleep = new AbortController();
    const sleepAbortStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => sampleDom()),
        leaseMs: 10_000,
        now: () => new Date(nowMs),
        repository: null,
        sleep: async () => {
          acSleep.abort();
        },
      },
      baseStreamInput,
      acSleep.signal
    );
    expect((await collectAll(sleepAbortStream)).map((e) => e.type)).toEqual([
      "frame",
    ]);

    const acFetch = new AbortController();
    let fetchCalls = 0;
    const fetchAbortStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) return sampleDom();
          acFetch.abort();
          throw new MarketDataError("UNAVAILABLE", "cancelled");
        }),
        leaseMs: 10_000,
        now: () => new Date(nowMs),
        repository: null,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
      baseStreamInput,
      acFetch.signal
    );
    expect((await collectAll(fetchAbortStream)).map((e) => e.type)).toEqual([
      "frame",
    ]);

    // Lease runs out right after sleep (remaining < 500ms) -> breaks and emits lease_expired
    let nowSmall = T0.getTime();
    const smallLeaseStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => sampleDom()),
        leaseMs: 800,
        now: () => new Date(nowSmall),
        repository: null,
        sleep: async (ms) => {
          nowSmall += ms;
        },
      },
      baseStreamInput
    );
    expect((await collectAll(smallLeaseStream)).map((e) => e.type)).toEqual([
      "frame",
      "reconnect",
    ]);

    // Abort right after receiving the initial frame exits loop without emitting reconnect
    const acAfterFirst = new AbortController();
    const afterFirstStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => sampleDom()),
        leaseMs: 10_000,
        now: () => new Date(nowMs),
        repository: null,
      },
      baseStreamInput,
      acAfterFirst.signal
    );
    const seenAfterFirst: string[] = [];
    for await (const event of afterFirstStream) {
      seenAfterFirst.push(event.type);
      acAfterFirst.abort();
    }
    expect(seenAfterFirst).toEqual(["frame"]);

    // Default now/sleep/maxPolls=0 exits immediately with lease_expired
    const zeroPollsStream = await openFlowLiveDomStream(
      {
        fetchDom: vi.fn(async () => sampleDom()),
        maxPolls: 0,
        repository: null,
      },
      baseStreamInput
    );
    expect((await collectAll(zeroPollsStream)).map((e) => e.type)).toEqual([
      "frame",
      "reconnect",
    ]);
  });
});
