// TradingView public websocket fetcher (unauthenticated, delayed data). One chart session per series
// (the free tier allows one series per chart session): a daily series and a 5-minute series for each
// NYSE breadth symbol. The 5-minute close is today's cumulative value. Only the public protocol frames
// are sent; no account or token is used.

import { z } from "zod";

import { nyTime } from "./calendar.ts";

export const TV_URL =
  "wss://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart";
export const TV_ORIGIN = "https://www.tradingview.com";
export const BREADTH_SYMBOLS = Object.freeze({
  adv: "USI:ADV",
  decl: "USI:DECL",
  dvol: "USI:DVOL",
  uvol: "USI:UVOL",
});
export type BreadthField = keyof typeof BREADTH_SYMBOLS;
export const FIELDS = Object.keys(BREADTH_SYMBOLS) as BreadthField[];

export interface SocketLike {
  close: () => void;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  send: (data: string) => void;
}
export type SocketFactory = (url: string, origin: string) => SocketLike;

export type Bar = Readonly<{ time: number; close: number }>;
export type BreadthValues = Readonly<Record<BreadthField, number>>;

export type TvResult = Readonly<{
  source: "tradingview";
  /** Daily values by New York date (only dates with every field). */
  daily: ReadonlyMap<string, BreadthValues>;
  /** Newest 5-minute cumulative values when every field has a bar on the same New York date. */
  intraday: Readonly<{
    date: string;
    values: BreadthValues;
    barTime: number;
  }> | null;
  asOf: string;
}>;

/** Encodes one payload as a socket.io-style length-prefixed frame. */
export const encodeFrame = (payload: string): string =>
  `~m~${payload.length}~m~${payload}`;
export const message = (method: string, params: readonly unknown[]): string =>
  encodeFrame(JSON.stringify({ m: method, p: params }));

/** Splits a raw frame into payloads; heartbeats come back as "~h~N" strings. */
export const decodeFrames = (raw: string): string[] =>
  raw.split(/~m~\d+~m~/).filter((part) => part.length > 0);

const FrameSchema = z.object({ m: z.string(), p: z.array(z.unknown()) });
const SeriesSchema = z.object({
  s: z.array(z.object({ v: z.array(z.number()) })),
});

/** Bars from a timescale_update or du payload for one series id. */
export const barsOf = (payload: unknown, seriesId: string): Bar[] => {
  const outer = z.record(z.string(), z.unknown()).safeParse(payload);
  const series = SeriesSchema.safeParse(
    outer.success ? outer.data[seriesId] : null
  );
  if (!series.success) {
    return [];
  }
  return series.data.s.flatMap(({ v }) => {
    const [time, , , , close] = v;
    return time !== undefined && close !== undefined ? [{ close, time }] : [];
  });
};

export interface Collected {
  completed: Set<string>;
  daily: Record<BreadthField, Map<number, number>>;
  intraday: Record<BreadthField, Map<number, number>>;
}

export const emptyCollected = (): Collected => ({
  completed: new Set(),
  daily: { adv: new Map(), decl: new Map(), dvol: new Map(), uvol: new Map() },
  intraday: {
    adv: new Map(),
    decl: new Map(),
    dvol: new Map(),
    uvol: new Map(),
  },
});

const dateOf = (time: number): string => nyTime(new Date(time * 1000)).date;

/** Joins the per-field series into complete daily values and the newest intraday values. */
export const assemble = (collected: Collected, asOf: Date): TvResult => {
  const byDate = new Map<string, Partial<Record<BreadthField, number>>>();
  for (const field of FIELDS) {
    for (const [time, close] of collected.daily[field]) {
      const date = dateOf(time);
      byDate.set(date, { ...byDate.get(date), [field]: close });
    }
  }
  const daily = new Map<string, BreadthValues>();
  for (const [date, values] of [...byDate].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (FIELDS.every((field) => values[field] !== undefined)) {
      daily.set(date, values as BreadthValues);
    }
  }
  // The newest 5-minute bar of each field (fields without a bar are left out).
  const latest = FIELDS.flatMap((field) => {
    const newest = [...collected.intraday[field]].reduce<Bar | null>(
      (best, [time, close]) =>
        best && best.time >= time ? best : { close, time },
      null
    );
    return newest ? [[field, newest] as const] : [];
  });
  const dates = new Set(latest.map(([, bar]) => dateOf(bar.time)));
  const barTime = Math.max(...latest.map(([, bar]) => bar.time));
  const intraday =
    latest.length === FIELDS.length && dates.size === 1
      ? {
          barTime,
          date: dateOf(barTime),
          values: Object.fromEntries(
            latest.map(([field, bar]) => [field, bar.close])
          ) as BreadthValues,
        }
      : null;
  return { asOf: asOf.toISOString(), daily, intraday, source: "tradingview" };
};

/** Every frame the client sends after the socket opens. */
export const openingFrames = (dailyBars: number): string[] => [
  message("set_auth_token", ["unauthorized_user_token"]),
  ...FIELDS.flatMap((field, index) =>
    (
      [
        ["d", "1D", dailyBars],
        ["i", "5", 3],
      ] as const
    ).flatMap(([kind, resolution, bars]) => {
      const key = `${kind}${index}`;
      const symbol = JSON.stringify({
        session: "regular",
        symbol: BREADTH_SYMBOLS[field],
      });
      return [
        message("chart_create_session", [`cs_${key}`, ""]),
        message("resolve_symbol", [`cs_${key}`, `sym_${key}`, `=${symbol}`]),
        message("create_series", [
          `cs_${key}`,
          key,
          key,
          `sym_${key}`,
          resolution,
          bars,
          "",
        ]),
      ];
    })
  ),
];

export type FrameOutcome = Readonly<{
  reply: string | null;
  error: string | null;
}>;

/** Applies one decoded payload to the collected bars; returns a heartbeat reply or a protocol error. */
export const handlePayload = (
  collected: Collected,
  part: string
): FrameOutcome => {
  if (part.startsWith("~h~")) {
    return { error: null, reply: encodeFrame(part) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(part);
  } catch {
    return { error: null, reply: null };
  }
  const parsed = FrameSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: null, reply: null };
  }
  const { m: method, p: params } = parsed.data;
  if (
    method === "critical_error" ||
    method === "symbol_error" ||
    method === "protocol_error"
  ) {
    return {
      error: `tradingview: ${method} ${JSON.stringify(params)}`,
      reply: null,
    };
  }
  const [session, payload] = params;
  const match = /^cs_([di])(\d)$/.exec(String(session));
  const field = FIELDS[Number(match?.[2])];
  if (!(match && field)) {
    return { error: null, reply: null };
  }
  const key = `${match[1]}${match[2]}`;
  if (method === "timescale_update" || method === "du") {
    const target =
      match[1] === "d" ? collected.daily[field] : collected.intraday[field];
    for (const bar of barsOf(payload, key)) {
      target.set(bar.time, bar.close);
    }
  } else if (method === "series_completed") {
    collected.completed.add(key);
  }
  return { error: null, reply: null };
};

export type TvOptions = Readonly<{
  socket: SocketFactory;
  now: () => Date;
  dailyBars: number;
  timeoutMs: number;
}>;

/**
 * Fetches daily and intraday breadth bars. Resolves when every series completed (or, at the timeout,
 * with what arrived when at least one series completed); rejects on a protocol error or socket loss.
 */
export const fetchTradingView = (options: TvOptions): Promise<TvResult> => {
  const { promise, resolve, reject } = Promise.withResolvers<TvResult>();
  const collected = emptyCollected();
  const socket = options.socket(TV_URL, TV_ORIGIN);
  let settled = false;
  const finish = (error: string | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.close();
    if (error) {
      reject(new Error(error));
    } else {
      resolve(assemble(collected, options.now()));
    }
  };
  const timer = setTimeout(() => {
    finish(
      collected.completed.size > 0
        ? null
        : `tradingview: timed out after ${options.timeoutMs} ms`
    );
  }, options.timeoutMs);
  socket.onopen = () => {
    for (const frame of openingFrames(options.dailyBars)) {
      socket.send(frame);
    }
  };
  socket.onmessage = (event) => {
    for (const part of decodeFrames(String(event.data))) {
      const outcome = handlePayload(collected, part);
      if (outcome.reply) {
        socket.send(outcome.reply);
      }
      if (outcome.error) {
        finish(outcome.error);
        return;
      }
    }
    if (collected.completed.size === FIELDS.length * 2) {
      finish(null);
    }
  };
  socket.onerror = () => finish("tradingview: socket error");
  socket.onclose = () =>
    finish("tradingview: socket closed before the data arrived");
  return promise;
};

/** Bun WebSocket factory that sends the TradingView Origin header. */
export const bunSocket: SocketFactory = (url, origin) =>
  new WebSocket(url, {
    // Bun accepts a headers option on the WebSocket constructor; the DOM typing does not.
    headers: {
      Origin: origin,
      "User-Agent": "Mozilla/5.0 (vertex-breadth-90)",
    },
  } as unknown as string[]) as unknown as SocketLike;
