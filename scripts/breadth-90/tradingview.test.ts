import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assemble,
  barsOf,
  bunSocket,
  decodeFrames,
  emptyCollected,
  encodeFrame,
  FIELDS,
  fetchTradingView,
  handlePayload,
  message,
  openingFrames,
  type SocketLike,
  TV_ORIGIN,
  TV_URL,
} from "./tradingview.ts";

// 2026-11-05 09:30 ET and 2026-11-06 09:30 / 15:40 ET bar times.
const NOV5 = 1_793_889_000;
const NOV6 = NOV5 + 86_400;
const NOV6_1540 = NOV6 + 6 * 3600 + 10 * 60;

const values = {
  adv: [393, 1494],
  decl: [2276, 1221],
  dvol: [1_471_385_180, 248_847_000],
  uvol: [287_938_584, 301_103_572],
};

const series = (key: string, bars: [number, number][]): unknown => ({
  [key]: {
    s: bars.map(([time, close], i) => ({
      i,
      v: [time, close, close, close, close],
    })),
  },
});
const frame = (method: string, params: unknown[]): string =>
  message(method, params);

/** A fake socket that answers the opening frames with complete daily and intraday series. */
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  answerAll(): void {
    FIELDS.forEach((field, index) => {
      const [yesterday, today] = values[field] as [number, number];
      this.emit(
        frame("timescale_update", [
          `cs_d${index}`,
          series(`d${index}`, [[NOV5, yesterday]]),
        ])
      );
      this.emit(
        frame("du", [`cs_i${index}`, series(`i${index}`, [[NOV6_1540, today]])])
      );
      this.emit(frame("series_completed", [`cs_d${index}`, `d${index}`]));
      this.emit(frame("series_completed", [`cs_i${index}`, `i${index}`]));
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("protocol helpers", () => {
  it("frames and splits payloads, heartbeats included", () => {
    expect(encodeFrame("abc")).toBe("~m~3~m~abc");
    expect(
      decodeFrames(`${encodeFrame("~h~1")}${encodeFrame('{"m":"x"}')}`)
    ).toEqual(["~h~1", '{"m":"x"}']);
    expect(JSON.parse(decodeFrames(message("m", [1]))[0] ?? "")).toEqual({
      m: "m",
      p: [1],
    });
  });

  it("reads bars for one series id and ignores other shapes", () => {
    expect(barsOf(series("d0", [[1, 5]]), "d0")).toEqual([
      { close: 5, time: 1 },
    ]);
    expect(barsOf(series("d0", [[1, 5]]), "d1")).toEqual([]);
    expect(barsOf("x", "d0")).toEqual([]);
    expect(barsOf({ d0: { s: [{ v: [1] }] } }, "d0")).toEqual([]);
  });

  it("opens one daily and one 5-minute chart session per symbol", () => {
    const frames = openingFrames(60);
    expect(frames).toHaveLength(1 + FIELDS.length * 2 * 3);
    expect(frames[0]).toContain("unauthorized_user_token");
    expect(frames.join("")).toContain('\\"symbol\\":\\"USI:UVOL\\"');
    expect(
      frames.some((f) => f.includes('"cs_i3","i3","i3","sym_i3","5",3'))
    ).toBe(true);
    expect(FIELDS).toEqual(["adv", "decl", "dvol", "uvol"]);
    expect(
      frames.some((f) => f.includes('"cs_d0","d0","d0","sym_d0","1D",60'))
    ).toBe(true);
  });

  it("handles heartbeats, junk, errors, bars and completion", () => {
    const collected = emptyCollected();
    expect(handlePayload(collected, "~h~7")).toEqual({
      error: null,
      reply: encodeFrame("~h~7"),
    });
    expect(handlePayload(collected, "{nope")).toEqual({
      error: null,
      reply: null,
    });
    expect(handlePayload(collected, '{"x":1}')).toEqual({
      error: null,
      reply: null,
    });
    expect(
      handlePayload(collected, JSON.stringify({ m: "du", p: ["cs_z9", {}] }))
        .error
    ).toBeNull();
    expect(
      handlePayload(collected, JSON.stringify({ m: "du", p: ["cs_d7", {}] }))
        .error
    ).toBeNull();
    expect(
      handlePayload(
        collected,
        JSON.stringify({ m: "symbol_error", p: ["cs_d0", "bad"] })
      ).error
    ).toContain("tradingview: symbol_error");
    handlePayload(
      collected,
      JSON.stringify({
        m: "timescale_update",
        p: ["cs_d1", series("d1", [[NOV5, 9]])],
      })
    );
    handlePayload(
      collected,
      JSON.stringify({ m: "du", p: ["cs_i1", series("i1", [[NOV6, 4]])] })
    );
    handlePayload(
      collected,
      JSON.stringify({ m: "series_loading", p: ["cs_i1"] })
    );
    handlePayload(
      collected,
      JSON.stringify({ m: "series_completed", p: ["cs_i1"] })
    );
    expect(collected.daily.decl.get(NOV5)).toBe(9);
    expect(collected.intraday.decl.get(NOV6)).toBe(4);
    expect([...collected.completed]).toEqual(["i1"]);
  });

  it("assembles only complete daily dates and same-date intraday values", () => {
    const collected = emptyCollected();
    for (const field of FIELDS) {
      collected.daily[field].set(NOV5, 1);
      collected.intraday[field].set(NOV6, 2);
      collected.intraday[field].set(NOV6_1540, 3);
    }
    collected.daily.uvol.set(NOV6, 5);
    // An older bar that arrives late does not displace the newest one.
    collected.intraday.uvol.set(NOV5, 9);
    const result = assemble(collected, new Date("2026-11-06T20:45:00Z"));
    expect([...result.daily.keys()]).toEqual(["2026-11-05"]);
    expect(result.intraday).toEqual({
      barTime: NOV6_1540,
      date: "2026-11-06",
      values: { adv: 3, decl: 3, dvol: 3, uvol: 3 },
    });
    expect(result.asOf).toBe("2026-11-06T20:45:00.000Z");
    collected.intraday.decl.clear();
    expect(assemble(collected, new Date()).intraday).toBeNull();
    collected.intraday.decl.set(NOV5, 1);
    expect(assemble(collected, new Date()).intraday).toBeNull();
  });
});

describe("fetchTradingView", () => {
  const options = (socket: FakeSocket, timeoutMs = 1000) => ({
    dailyBars: 60,
    now: () => new Date("2026-11-06T20:45:00Z"),
    socket: vi.fn(() => socket),
    timeoutMs,
  });

  it("resolves once every series completed and answers heartbeats", async () => {
    const socket = new FakeSocket();
    const opts = options(socket);
    const pending = fetchTradingView(opts);
    expect(opts.socket).toHaveBeenCalledWith(TV_URL, TV_ORIGIN);
    socket.onopen?.();
    expect(socket.sent).toHaveLength(openingFrames(60).length);
    socket.emit(encodeFrame("~h~3"));
    expect(socket.sent.at(-1)).toBe(encodeFrame("~h~3"));
    socket.answerAll();
    const result = await pending;
    expect(socket.closed).toBe(true);
    expect(result.daily.get("2026-11-05")).toEqual({
      adv: 393,
      decl: 2276,
      dvol: 1_471_385_180,
      uvol: 287_938_584,
    });
    expect(result.intraday?.values.adv).toBe(1494);
    // A late message or close after settling changes nothing.
    socket.onclose?.();
    socket.answerAll();
  });

  it("rejects on a protocol error, socket error or early close", async () => {
    const errored = new FakeSocket();
    const first = fetchTradingView(options(errored));
    errored.emit(frame("critical_error", ["cs_d0", "exceed limit"]));
    await expect(first).rejects.toThrow("tradingview: critical_error");
    const broken = new FakeSocket();
    const second = fetchTradingView(options(broken));
    broken.onerror?.(new Event("error"));
    await expect(second).rejects.toThrow("socket error");
    const closed = new FakeSocket();
    const third = fetchTradingView(options(closed));
    closed.onclose?.();
    await expect(third).rejects.toThrow("socket closed");
  });

  it("on timeout resolves with partial data, or rejects when nothing completed", async () => {
    vi.useFakeTimers();
    const partial = new FakeSocket();
    const first = fetchTradingView(options(partial, 50));
    partial.emit(frame("series_completed", ["cs_d0"]));
    vi.advanceTimersByTime(60);
    expect((await first).daily.size).toBe(0);
    const empty = new FakeSocket();
    const second = fetchTradingView(options(empty, 50));
    vi.advanceTimersByTime(60);
    await expect(second).rejects.toThrow("timed out after 50 ms");
  });

  it("bunSocket passes the Origin header to the WebSocket constructor", () => {
    const ctor = vi.fn();
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string, init: unknown) {
          ctor(url, init);
        }
      }
    );
    bunSocket(TV_URL, TV_ORIGIN);
    expect(ctor).toHaveBeenCalledWith(TV_URL, {
      headers: {
        Origin: TV_ORIGIN,
        "User-Agent": "Mozilla/5.0 (vertex-breadth-90)",
      },
    });
  });
});
