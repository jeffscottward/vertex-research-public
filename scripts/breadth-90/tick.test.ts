import { describe, expect, it, vi } from "vitest";

import { Breadth90CollectInputSchema } from "../../packages/api/src/contracts/breadth-90.ts";
import {
  mergeSessions,
  parseArgs,
  resolveMode,
  runBreadth90Tick,
  skipReason,
  type TickIo,
} from "./tick.ts";
import {
  type BreadthValues,
  encodeFrame,
  FIELDS,
  message,
  type SocketLike,
} from "./tradingview.ts";

type Values = Readonly<{
  uvol: number;
  dvol: number;
  adv: number;
  decl: number;
}>;
const pct = (up: number, adv = up): Values => ({
  adv: adv * 30,
  decl: (100 - adv) * 30,
  dvol: (100 - up) * 1e7,
  uvol: up * 1e7,
});
const epoch = (date: string, hhmmUtc = "14:30"): number =>
  Date.parse(`${date}T${hhmmUtc}:00Z`) / 1000;

type Feed =
  | {
      daily: Record<string, Values>;
      intraday: { date: string; values: Values } | null;
    }
  | "error";

/** A TradingView fake: answers the opening frames with the feed (or a protocol error). */
const tvSocket = (feed: () => Feed) => (): SocketLike => {
  const socket: SocketLike = {
    close: () => undefined,
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    send: () => undefined,
  };
  queueMicrotask(() => {
    socket.onopen?.();
    const data = feed();
    const emit = (method: string, params: unknown[]): void =>
      socket.onmessage?.({ data: message(method, params) });
    if (data === "error") {
      emit("critical_error", ["cs_d0", "boom"]);
      return;
    }
    socket.onmessage?.({ data: encodeFrame("~h~1") });
    FIELDS.forEach((field, index) => {
      const bars = Object.entries(data.daily).map(([date, values], i) => ({
        i,
        v: [epoch(date), 0, 0, 0, values[field]],
      }));
      emit("timescale_update", [
        `cs_d${index}`,
        { [`d${index}`]: { s: bars } },
      ]);
      if (data.intraday) {
        const v = [
          epoch(data.intraday.date, "20:40"),
          0,
          0,
          0,
          data.intraday.values[field],
        ];
        emit("du", [`cs_i${index}`, { [`i${index}`]: { s: [{ i: 0, v }] } }]);
      }
      emit("series_completed", [`cs_d${index}`]);
      emit("series_completed", [`cs_i${index}`]);
    });
  });
  return socket;
};

const wsjBody = (date: string, up: number, adv = up): unknown => {
  const [y, m, d] = date.split("-");
  const n = (value: number) => Math.round(value).toLocaleString("en-US");
  return {
    data: {
      instrumentSets: [
        {
          headerFields: [{ label: "Issues" }],
          instruments: [
            { NYSE: n(adv * 30), name: "Advancing" },
            { NYSE: n((100 - adv) * 30), name: "Declining" },
          ],
        },
        {
          headerFields: [{ label: "Share Volume" }],
          instruments: [
            { NYSE: n(up * 1e7), name: "Advancing" },
            { NYSE: n((100 - up) * 1e7), name: "Declining" },
          ],
        },
      ],
      timestamp: `3:40 PM EST ${m}/${d}/${y?.slice(2)}`,
    },
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

interface World {
  discordOk: boolean;
  err: string[];
  feed: Feed;
  files: Map<string, string>;
  mails: string[][];
  out: string[];
  posts: Array<{ url: string; body: Record<string, unknown> }>;
  vertex: Response | Error;
  wsj: unknown;
}

const NTFY = JSON.stringify({
  enabled: true,
  server: "https://ntfy.sh",
  topic: "omp-x",
});

const world = (overrides: Partial<World> = {}): World => ({
  discordOk: true,
  err: [],
  feed: { daily: {}, intraday: null },
  files: new Map([
    ["/h/.config/omp-notify/ntfy.json", NTFY],
    [
      "/h/Documents/reports/trading/dip-basket/basket.json",
      JSON.stringify({ reportPath: "/r.html", summary: "🧺 basket" }),
    ],
  ]),
  mails: [],
  out: [],
  posts: [],
  vertex: json(200, { json: { days: 1 } }),
  wsj: null,
  ...overrides,
});

const ioFor = (
  w: World,
  argv: string[],
  now: string,
  env: Record<string, string> = {}
): TickIo => ({
  appendText: async (path, text) => {
    w.files.set(path, `${w.files.get(path) ?? ""}${text}`);
  },
  argv,
  env: {
    BREADTH90_EMAIL_TO: "owner@example.com",
    BREADTH90_STATE_DIR: "/s",
    ...env,
  },
  fetch: vi.fn(async (url: string, init?: RequestInit) => {
    const body: Record<string, unknown> = init?.body
      ? JSON.parse(String(init.body))
      : {};
    w.posts.push({ body, url });
    if (url.includes("wsj.com")) {
      return w.wsj === null
        ? new Response("", { status: 503 })
        : json(200, w.wsj);
    }
    if (url.includes("ntfy")) {
      return json(200, { id: `n${w.posts.length}` });
    }
    if (url.includes("47821")) {
      return w.discordOk
        ? json(200, { id: "d1", ok: true })
        : json(502, { error: "post failed" });
    }
    if (w.vertex instanceof Error) {
      throw w.vertex;
    }
    return w.vertex.clone();
  }),
  fileSize: async (path) => (w.files.get(path) ?? "").length,
  home: "/h",
  now: () => new Date(now),
  readText: async (path) => w.files.get(path) ?? null,
  run: vi.fn(async (_command: string, args: readonly string[]) => {
    w.mails.push([...args]);
    const record = "/s/sent.mbox";
    w.files.set(record, `${w.files.get(record) ?? ""}mail\n`);
    return { code: 0, stderr: "" };
  }),
  socket: tvSocket(() => w.feed),
  stderr: { write: (text: string) => w.err.push(text) },
  stdout: { write: (text: string) => w.out.push(text) },
  writeText: async (path, text) => {
    w.files.set(path, text);
  },
});

const state = (w: World) => JSON.parse(w.files.get("/s/state.json") ?? "null");
const alertsSent = (w: World): string[] =>
  w.posts
    .filter((p) => p.url.includes("ntfy") || p.url.includes("47821"))
    .map((p) => String(p.body["title"] ?? p.body["text"]));

// Friday 2026-11-06 15:45 ET, Friday 16:20 ET, Saturday, Thanksgiving and 09:00 ET.
const INTRADAY = "2026-11-06T20:45:00Z";
const FINAL = "2026-11-06T21:20:00Z";

const armedHistory = { "2026-11-04": pct(70), "2026-11-05": pct(16.37, 14.72) };

describe("arguments and scheduling", () => {
  it("parses flags and rejects unknown ones", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      mode: "auto",
      push: true,
      testAlert: false,
    });
    expect(
      parseArgs(["--mode", "final", "--dry-run", "--test-alert", "--no-push"])
    ).toEqual({
      dryRun: true,
      mode: "final",
      push: false,
      testAlert: true,
    });
    expect(parseArgs(["--mode=backfill"]).mode).toBe("backfill");
    expect(() => parseArgs(["--mode", "weekly"])).toThrow(
      "--mode must be one of"
    );
    expect(() => parseArgs(["--mode"])).toThrow("--mode must be one of");
    expect(() => parseArgs(["--loud"])).toThrow("unknown argument: --loud");
  });

  it("resolves auto mode at close + 10 minutes and skips off-session runs", () => {
    expect(resolveMode("auto", 16 * 60 + 9, "2026-11-06")).toBe("intraday");
    expect(resolveMode("auto", 16 * 60 + 10, "2026-11-06")).toBe("final");
    expect(resolveMode("auto", 13 * 60 + 10, "2026-11-27")).toBe("final");
    expect(resolveMode("backfill", 0, "2026-11-06")).toBe("backfill");
    const base = {
      dryRun: false,
      mode: "auto",
      push: true,
      testAlert: false,
    } as const;
    expect(
      skipReason(base, "intraday", {
        date: "2026-11-07",
        minutes: 700,
        weekday: "Sat",
      })
    ).toContain("not an NYSE session");
    expect(
      skipReason(base, "intraday", {
        date: "2026-11-06",
        minutes: 9 * 60,
        weekday: "Fri",
      })
    ).toContain("before the open");
    expect(
      skipReason(base, "final", {
        date: "2026-11-06",
        minutes: 9 * 60,
        weekday: "Fri",
      })
    ).toBeNull();
    expect(
      skipReason({ ...base, testAlert: true }, "intraday", {
        date: "2026-11-07",
        minutes: 0,
        weekday: "Sat",
      })
    ).toBeNull();
    expect(
      skipReason(base, "backfill", {
        date: "2026-11-26",
        minutes: 0,
        weekday: "Thu",
      })
    ).toBeNull();
  });

  it("exits 2 on a usage error and 0 on a skipped day", async () => {
    const w = world();
    expect(await runBreadth90Tick(ioFor(w, ["--bogus"], INTRADAY))).toBe(2);
    expect(w.err.join("")).toContain("unknown argument");
    expect(await runBreadth90Tick(ioFor(w, [], "2026-11-07T16:00:00Z"))).toBe(
      0
    );
    expect(w.out.join("")).toContain(
      "2026-11-07 is not an NYSE session; skipped"
    );
    expect(w.files.has("/s/state.json")).toBe(false);
  });
});

describe("mergeSessions", () => {
  const tv = (
    daily: Record<string, BreadthValues>,
    intraday: { date: string; values: BreadthValues } | null
  ) => ({
    asOf: "tv-asof",
    daily: new Map(Object.entries(daily)),
    intraday: intraday && {
      ...intraday,
      barTime: epoch(intraday.date, "20:40"),
    },
    source: "tradingview" as const,
  });

  it("keeps today's daily bar non-final intraday and prefers it at the close", () => {
    const today = pct(60);
    const intraday = mergeSessions(
      {},
      "2026-11-06",
      "intraday",
      tv({ "2026-11-06": today, "2026-11-09": today }, null),
      null,
      "at"
    );
    expect(intraday.days["2026-11-06"]?.final).toBe(false);
    expect(intraday.days["2026-11-09"]).toBeUndefined();
    const final = mergeSessions(
      {},
      "2026-11-06",
      "final",
      tv({ "2026-11-06": today }, { date: "2026-11-06", values: pct(10) }),
      null,
      "at"
    );
    expect(final.days["2026-11-06"]).toMatchObject({
      asOf: "tv-asof",
      final: true,
      uvol: today.uvol,
    });
    expect(final.todaySource).toBe("tradingview");
  });

  it("falls back to WSJ for today and leaves today unset without either", () => {
    const wsj = {
      asOf: "3:40 PM",
      date: "2026-11-06",
      source: "wsj" as const,
      values: pct(55),
    };
    expect(
      mergeSessions({}, "2026-11-06", "final", null, wsj, "at").days[
        "2026-11-06"
      ]
    ).toMatchObject({ final: true, source: "wsj" });
    const none = mergeSessions(
      {},
      "2026-11-06",
      "intraday",
      null,
      { ...wsj, date: "2026-11-05" },
      "at"
    );
    expect(none.days).toEqual({});
    expect(none.todaySource).toBeNull();
    expect(none.crossCheck).toBeNull();
  });
});

describe("runBreadth90Tick", () => {
  it("first intraday run seeds history: ARMED by 11-05, no alert, state and history written", async () => {
    const w = world({
      feed: {
        daily: armedHistory,
        intraday: { date: "2026-11-06", values: pct(55.32, 55.15) },
      },
      wsj: wsjBody("2026-11-06", 56.09),
    });
    expect(await runBreadth90Tick(ioFor(w, ["--no-push"], INTRADAY))).toBe(0);
    const out = w.out.join("");
    expect(out).toContain(
      "breadth-90 intraday: 2026-11-06 up 55.32% adv 55.15% NEUTRAL intraday | state ARMED armed 2026-11-05 (30 sessions left)"
    );
    expect(out).toContain("cross-check wsj 56.09% (Δ 0.77 pp)");
    expect(out).toContain("🧺 basket");
    expect(out).toContain("no new alert");
    expect(alertsSent(w)).toEqual([]);
    expect(state(w).sent["ARMED:2026-11-05:standard"]).toMatchObject({
      seeded: true,
    });
    expect(w.files.get("/s/history.jsonl")).toContain('"state":"ARMED"');
  });

  it("alerts FORMING once on all three channels, then stays quiet", async () => {
    const w = world({
      feed: {
        daily: armedHistory,
        intraday: { date: "2026-11-06", values: pct(92, 91) },
      },
      wsj: wsjBody("2026-11-06", 91),
    });
    w.files.set(
      "/s/state.json",
      JSON.stringify({ days: {}, lastTick: "earlier", sent: {}, version: 1 })
    );
    expect(await runBreadth90Tick(ioFor(w, ["--no-push"], INTRADAY))).toBe(0);
    expect(w.out.join("")).toContain("alert FORMING:2026-11-06:major: ntfy OK");
    // The unsent ARMED alert of the prior session (11-05) goes out too, on Discord and ntfy only.
    expect(w.out.join("")).toContain(
      "alert ARMED:2026-11-05:standard: discord OK"
    );
    expect(alertsSent(w)).toHaveLength(4);
    expect(w.mails).toHaveLength(1);
    const second = world({ ...w, mails: [], out: [], posts: [] });
    expect(await runBreadth90Tick(ioFor(second, ["--no-push"], INTRADAY))).toBe(
      0
    );
    expect(second.out.join("")).toContain("no new alert");
    expect(second.posts.filter((p) => !p.url.includes("wsj"))).toEqual([]);
  });

  it("fails the email channel and exits 1 while BREADTH90_EMAIL_TO is unset", async () => {
    const w = world({
      feed: {
        daily: armedHistory,
        intraday: { date: "2026-11-06", values: pct(92, 91) },
      },
      wsj: wsjBody("2026-11-06", 91),
    });
    w.files.set(
      "/s/state.json",
      JSON.stringify({ days: {}, lastTick: "earlier", sent: {}, version: 1 })
    );
    const env = { BREADTH90_EMAIL_TO: "" };
    expect(await runBreadth90Tick(ioFor(w, ["--no-push"], INTRADAY, env))).toBe(
      1
    );
    expect(w.out.join("")).toContain(
      "email FAILED (BREADTH90_EMAIL_TO is not set)"
    );
    expect(w.mails).toEqual([]);
    // ntfy and Discord got FORMING and the prior ARMED once; only email stays due.
    expect(alertsSent(w)).toHaveLength(4);
    const second = world({ ...w, mails: [], out: [], posts: [] });
    expect(
      await runBreadth90Tick(ioFor(second, ["--no-push"], INTRADAY, env))
    ).toBe(1);
    expect(second.mails).toEqual([]);
    expect(alertsSent(second)).toEqual([]);
  });

  it("alerts FIRED at the close, retries only a failed channel and exits 1 on failure", async () => {
    const w = world({
      discordOk: false,
      feed: {
        daily: armedHistory,
        intraday: { date: "2026-11-06", values: pct(95, 93) },
      },
      wsj: wsjBody("2026-11-06", 80),
    });
    w.files.set(
      "/s/state.json",
      JSON.stringify({
        days: {},
        lastTick: "x",
        sent: {
          "ARMED:2026-11-05:standard": { at: "a", channels: {}, seeded: true },
        },
        version: 1,
      })
    );
    expect(await runBreadth90Tick(ioFor(w, ["--no-push"], FINAL))).toBe(1);
    expect(w.err.join("")).toContain(
      "DISAGREEMENT 2026-11-06: tradingview 95% vs wsj 80% (15 pp)"
    );
    expect(w.out.join("")).toContain("alert FIRED:2026-11-06:major: ntfy OK");
    expect(w.out.join("")).toContain("discord FAILED (HTTP 502 (not ok))");
    expect(state(w).sent["FIRED:2026-11-06:major"].channels.discord.ok).toBe(
      false
    );
    const retry = world({
      ...w,
      discordOk: true,
      mails: [],
      out: [],
      posts: [],
    });
    expect(await runBreadth90Tick(ioFor(retry, ["--no-push"], FINAL))).toBe(0);
    expect(retry.mails).toEqual([]);
    expect(retry.posts.filter((p) => p.url.includes("ntfy"))).toEqual([]);
    expect(retry.posts.filter((p) => p.url.includes("47821"))).toHaveLength(1);
  });

  it("alerts ARMED at the arming close on Discord and ntfy only", async () => {
    const w = world({
      feed: {
        daily: { "2026-11-04": pct(70) },
        intraday: { date: "2026-11-05", values: pct(16.37, 14.72) },
      },
    });
    w.files.set(
      "/s/state.json",
      JSON.stringify({ days: {}, lastTick: "x", sent: {}, version: 1 })
    );
    expect(
      await runBreadth90Tick(ioFor(w, ["--no-push"], "2026-11-05T21:20:00Z"))
    ).toBe(0);
    expect(w.out.join("")).toContain(
      "alert ARMED:2026-11-05:standard: discord OK"
    );
    expect(w.mails).toEqual([]);
    expect(alertsSent(w)).toHaveLength(2);
  });

  it("dry-run reports the would-be alert and writes nothing", async () => {
    const w = world({
      feed: {
        daily: armedHistory,
        intraday: { date: "2026-11-06", values: pct(95, 95) },
      },
    });
    w.files.set(
      "/s/state.json",
      JSON.stringify({ days: {}, lastTick: "x", sent: {}, version: 1 })
    );
    const before = w.files.get("/s/state.json");
    expect(
      await runBreadth90Tick(ioFor(w, ["--dry-run", "--mode", "final"], FINAL))
    ).toBe(0);
    expect(w.out.join("")).toContain("would alert FIRED:2026-11-06:major");
    // Events of the last two sessions alert: the 11-05 ARMED event was never sent.
    expect(w.out.join("")).toContain("would alert ARMED:2026-11-05:standard");
    expect(w.files.get("/s/state.json")).toBe(before);
    expect(w.err.join("")).toContain("source error: wsj: HTTP 503");
  });

  it("sends one labelled test alert, or reports it in a dry run", async () => {
    const w = world({ feed: { daily: armedHistory, intraday: null } });
    expect(
      await runBreadth90Tick(
        ioFor(w, ["--test-alert", "--no-push"], "2026-11-07T16:00:00Z")
      )
    ).toBe(0);
    expect(w.out.join("")).toContain("test alert: ntfy OK");
    expect(alertsSent(w)[0]).toContain("🧪 TEST");
    expect(state(w).testAlerts).toHaveLength(1);
    const dry = world({ feed: "error" });
    expect(
      await runBreadth90Tick(
        ioFor(dry, ["--test-alert", "--dry-run"], INTRADAY)
      )
    ).toBe(1);
    expect(dry.out.join("")).toContain("would send test alert: 🧪 TEST");
    expect(dry.err.join("")).toContain("no data for 2026-11-06");
    expect(dry.out.join("")).toContain("no data | state IDLE");
  });

  it("reports a failed test send", async () => {
    const w = world({
      discordOk: false,
      feed: { daily: armedHistory, intraday: null },
    });
    expect(
      await runBreadth90Tick(ioFor(w, ["--test-alert", "--no-push"], FINAL))
    ).toBe(1);
  });

  it("backfill lists every event, seeds them all and never alerts or reads WSJ", async () => {
    const w = world({
      feed: {
        daily: { ...armedHistory, "2026-11-06": pct(95, 95) },
        intraday: null,
      },
    });
    expect(
      await runBreadth90Tick(
        ioFor(w, ["--mode", "backfill", "--no-push"], "2026-11-07T16:00:00Z")
      )
    ).toBe(0);
    const out = w.out.join("");
    expect(out).toContain(
      "  2026-11-05 ARMED up 16.37% adv 14.72% standard (armed 2026-11-05)"
    );
    expect(out).toContain(
      "  2026-11-06 FIRED up 95% adv 95% UP_90 major (armed 2026-11-05)"
    );
    expect(state(w).sent["FIRED:2026-11-06:major"].seeded).toBe(true);
    expect(w.posts).toEqual([]);
  });

  it("uses WSJ when TradingView fails and pushes to Vertex with the write key", async () => {
    const w = world({ feed: "error", wsj: wsjBody("2026-11-06", 40, 42) });
    w.files.set(
      "/s/state.json",
      JSON.stringify({
        days: {
          "2026-11-05": {
            date: "2026-11-05",
            ...pct(16.37, 14.72),
            asOf: "t",
            final: true,
            source: "tradingview",
          },
        },
        lastTick: null,
        sent: {},
        version: 1,
      })
    );
    const env = {
      VERTEX_AGENT_API_KEY: "k",
      VERTEX_ORIGIN: "https://v.example",
    };
    expect(await runBreadth90Tick(ioFor(w, [], INTRADAY, env))).toBe(0);
    expect(w.err.join("")).toContain(
      "source error: tradingview: critical_error"
    );
    expect(w.out.join("")).toContain("Source: wsj as of 3:40 PM EST 11/06/26");
    expect(w.out.join("")).toContain('push: ok {"json":{"days":1}}');
    const push = w.posts.find(
      (p) => p.url === "https://v.example/api/orpc/breadth90/collect"
    );
    expect(push?.body["json"]).toMatchObject({
      armedOn: "2026-11-05",
      basket: { reportPath: "/r.html", summary: "🧺 basket", tiers: [] },
      days: [
        { date: "2026-11-05", final: true },
        { date: "2026-11-06", final: false, source: "wsj", upPct: 40 },
      ],
      sessionsLeft: 30,
      state: "ARMED",
      strict: false,
    });
    expect(push?.body["json"]).toHaveProperty("days.length", 2);
    // The real push body passes the server contract.
    expect(
      Breadth90CollectInputSchema.safeParse(push?.body["json"]).success
    ).toBe(true);
  });

  it("records an empty session in history, defaults the state dir and shows strict arming", async () => {
    const w = world({ feed: "error" });
    const io = ioFor(w, [], INTRADAY);
    const env = { ...io.env };
    delete env["BREADTH90_STATE_DIR"];
    expect(await runBreadth90Tick({ ...io, env })).toBe(1);
    expect(
      w.files.get("/h/.local/share/vertex-breadth-90/history.jsonl")
    ).toContain('"date":null');
    const strict = world({
      feed: {
        daily: {
          "2026-11-04": pct(8),
          "2026-11-05": { adv: 0, decl: 0, dvol: 5e8, uvol: 5e8 },
        },
        intraday: null,
      },
    });
    await runBreadth90Tick(
      ioFor(strict, ["--mode", "final", "--no-push"], "2026-11-05T21:20:00Z")
    );
    expect(strict.out.join("")).toContain(
      "2026-11-05 up 50% adv n/a% NEUTRAL final | state ARMED armed 2026-11-04 strict"
    );
  });

  it("backfill lists an unarmed thrust without volume breadth of issues", async () => {
    const w = world({
      feed: {
        daily: { "2026-11-05": { adv: 0, decl: 0, dvol: 5, uvol: 95 } },
        intraday: null,
      },
    });
    await runBreadth90Tick(
      ioFor(w, ["--mode", "backfill", "--no-push"], "2026-11-07T16:00:00Z")
    );
    expect(w.out.join("")).toContain(
      "  2026-11-05 THRUST up 95% adv n/a% UP_90 volume-only\n"
    );
  });

  it("reports push skips, HTTP errors and network failures", async () => {
    const feed: Feed = {
      daily: armedHistory,
      intraday: { date: "2026-11-06", values: pct(50) },
    };
    const skipped = world({ feed });
    await runBreadth90Tick(ioFor(skipped, [], INTRADAY));
    expect(skipped.out.join("")).toContain(
      "push: skipped (VERTEX_ORIGIN or VERTEX_AGENT_API_KEY not set)"
    );
    const env = { VERTEX_AGENT_API_KEY: "k", VERTEX_ORIGIN: "https://v" };
    const refused = world({ feed, vertex: json(403, { code: "FORBIDDEN" }) });
    expect(
      await runBreadth90Tick(
        ioFor(refused, ["--mode", "backfill"], INTRADAY, env)
      )
    ).toBe(1);
    expect(refused.out.join("")).toContain(
      'push: HTTP 403 {"code":"FORBIDDEN"}'
    );
    const down = world({ feed, vertex: new Error("ECONNREFUSED") });
    expect(await runBreadth90Tick(ioFor(down, [], INTRADAY, env))).toBe(1);
    expect(down.out.join("")).toContain("push: failed ECONNREFUSED");
  });
});
