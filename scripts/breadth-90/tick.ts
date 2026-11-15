// Breadth-90 tick (research only, no orders). See docs/vertex-rebuild/breadth-90.md.
// Usage: bun run vertex:breadth-90:tick [--mode auto|intraday|final|backfill] [--dry-run] [--test-alert] [--no-push]
// Fetches NYSE USI:UVOL/DVOL/ADV/DECL from the TradingView public websocket (daily bars plus today's
// cumulative 5-minute value) and the WSJ markets diary (fallback and cross-check), classifies the
// sessions, stores them in ~/.local/share/vertex-breadth-90/state.json, alerts each new ARMED,
// FORMING or FIRED event once per channel (ntfy, email, Discord) and, with VERTEX_ORIGIN and
// VERTEX_AGENT_API_KEY set, pushes the sessions and events to Vertex (breadth90.collect).
// --mode auto (default) is final from 10 minutes after the close, else intraday. Weekends and NYSE
// holidays are skipped (backfill and --test-alert still run). --dry-run fetches and reports only:
// nothing is stored, sent or pushed. --test-alert sends one "🧪 TEST" alert to all three channels
// and no real alert. Backfill stores up to 1000 daily sessions and never alerts.

import {
  type Alert,
  type AlertContext,
  type AlertIo,
  alertKey,
  type ChannelResult,
  composeAlert,
  composeTestAlert,
  deliver,
} from "./alerts.ts";
import { type BasketSummary, basketPathOf, readBasket } from "./basket.ts";
import {
  closeMinutes,
  isTradingDay,
  type NyTime,
  nyTime,
  OPEN_MINUTES,
} from "./calendar.ts";
import {
  type BreadthDay,
  type Evaluation,
  evaluate,
  sharePct,
} from "./classifier.ts";
import { type BreadthState, parseState, trimState } from "./state.ts";
import {
  type BreadthValues,
  fetchTradingView,
  type SocketFactory,
  type TvResult,
} from "./tradingview.ts";
import { fetchWsj, type WsjResult } from "./wsj.ts";

export type TickIo = AlertIo &
  Readonly<{
    argv: readonly string[];
    now: () => Date;
    socket: SocketFactory;
    writeText: (path: string, text: string) => Promise<void>;
    appendText: (path: string, text: string) => Promise<void>;
    stdout: Readonly<{ write: (text: string) => unknown }>;
    stderr: Readonly<{ write: (text: string) => unknown }>;
  }>;

export type Mode = "auto" | "intraday" | "final" | "backfill";
export type TickOptions = Readonly<{
  mode: Mode;
  dryRun: boolean;
  testAlert: boolean;
  push: boolean;
}>;

const MODES: readonly Mode[] = ["auto", "intraday", "final", "backfill"];
/** Percentage points between the two sources' up-volume share that count as a disagreement. */
const DISAGREE_PP = 5;

export const parseArgs = (argv: readonly string[]): TickOptions => {
  let mode: Mode = "auto";
  let dryRun = false;
  let testAlert = false;
  let push = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--test-alert") {
      testAlert = true;
    } else if (arg === "--no-push") {
      push = false;
    } else if (arg === "--mode" || arg?.startsWith("--mode=")) {
      const value =
        arg === "--mode" ? argv[++index] : arg.slice("--mode=".length);
      if (!MODES.includes(value as Mode)) {
        throw new Error(`--mode must be one of ${MODES.join("|")}`);
      }
      mode = value as Mode;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, mode, push, testAlert };
};

const day = (
  date: string,
  values: BreadthValues,
  final: boolean,
  source: string,
  asOf: string
): BreadthDay => ({
  date,
  ...values,
  asOf,
  final,
  source,
});

export type Merge = Readonly<{
  days: Record<string, BreadthDay>;
  todaySource: string | null;
  crossCheck: BreadthState["crossChecks"][number] | null;
}>;

/** Merges fetched data into the stored sessions (today final only in final mode). */
export const mergeSessions = (
  stored: Readonly<Record<string, BreadthDay>>,
  today: string,
  mode: Exclude<Mode, "auto">,
  tv: TvResult | null,
  wsj: WsjResult | null,
  at: string
): Merge => {
  const days: Record<string, BreadthDay> = { ...stored };
  const tvAsOf = tv?.asOf ?? at;
  for (const [date, values] of tv ? tv.daily : []) {
    if (date <= today) {
      days[date] = day(
        date,
        values,
        date < today || mode !== "intraday",
        "tradingview",
        tvAsOf
      );
    }
  }
  const final = mode !== "intraday";
  let todaySource: string | null = days[today]?.source ?? null;
  const tvToday = tv?.intraday?.date === today ? tv.intraday : null;
  if (mode !== "backfill" && tvToday && !(tv?.daily.has(today) && final)) {
    days[today] = day(
      today,
      tvToday.values,
      final,
      "tradingview",
      new Date(tvToday.barTime * 1000).toISOString()
    );
    todaySource = "tradingview";
  } else if (mode !== "backfill" && !tvToday && wsj?.date === today) {
    days[today] = day(today, wsj.values, final, "wsj", wsj.asOf);
    todaySource = "wsj";
  }
  const tvUpPct = tvToday
    ? sharePct(tvToday.values.uvol, tvToday.values.dvol)
    : null;
  const wsjUpPct =
    wsj?.date === today ? sharePct(wsj.values.uvol, wsj.values.dvol) : null;
  const crossCheck =
    tvUpPct !== null && wsjUpPct !== null
      ? {
          at,
          date: today,
          diff: Math.round(Math.abs(tvUpPct - wsjUpPct) * 100) / 100,
          disagree: Math.abs(tvUpPct - wsjUpPct) > DISAGREE_PP,
          tvUpPct,
          wsjUpPct,
        }
      : null;
  return { crossCheck, days, todaySource };
};

/** True once the alert reached every channel it targets (or was seeded as history). */
const allSent = (state: BreadthState, alert: Alert): boolean => {
  const entry = state.sent[alert.key];
  return Boolean(
    entry &&
      (entry.seeded ||
        alert.channels.every((channel) => entry.channels[channel]?.ok))
  );
};

/** Seeds every alertable event before the latest session so a first run never alerts history. */
const seedHistory = (
  state: BreadthState,
  evaluation: Evaluation,
  all: boolean,
  at: string
): BreadthState => {
  const latest = evaluation.latest?.date ?? "";
  const sent = { ...state.sent };
  for (const event of evaluation.events) {
    const key = alertKey(event);
    if (!sent[key] && (all || event.date < latest)) {
      sent[key] = { at, channels: {}, seeded: true };
    }
  }
  return { ...state, sent };
};

/** Sessions pushed per tick: every stored session on a backfill, else the newest PUSH_SESSIONS. */
const PUSH_SESSIONS = 60;

const pushToVertex = async (
  io: TickIo,
  sessionLimit: number,
  evaluation: Evaluation,
  days: readonly BreadthDay[],
  basket: BasketSummary,
  at: string
): Promise<Readonly<{ ok: boolean; line: string }>> => {
  const origin = io.env["VERTEX_ORIGIN"];
  const apiKey = io.env["VERTEX_AGENT_API_KEY"];
  if (!(origin && apiKey)) {
    return {
      line: "push: skipped (VERTEX_ORIGIN or VERTEX_AGENT_API_KEY not set)",
      ok: true,
    };
  }
  const byDate = new Map(days.map((item) => [item.date, item]));
  const input = {
    armedOn: evaluation.armedOn,
    asOf: at,
    basket: {
      asOf: basket.asOf,
      reportPath: basket.reportPath,
      rulesNote: basket.rulesNote,
      summary: basket.summary,
      tiers: basket.tiers,
    },
    days: evaluation.sessions.slice(-sessionLimit).map((row) => {
      const source = byDate.get(row.date) as BreadthDay;
      return {
        ...row,
        adv: source.adv,
        decl: source.decl,
        dvol: source.dvol,
        source: source.source,
        sourceAsOf: source.asOf,
        uvol: source.uvol,
      };
    }),
    events: evaluation.events.map((event) => ({
      ...event,
      trigger: event.trigger ?? null,
    })),
    sessionsLeft: evaluation.sessionsLeft,
    state: evaluation.state,
    strict: evaluation.strict,
  };
  try {
    const response = await io.fetch(`${origin}/api/orpc/breadth90/collect`, {
      body: JSON.stringify({ json: input }),
      headers: {
        "content-type": "application/json",
        origin,
        "x-api-key": apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return {
      line: response.ok
        ? `push: ok ${text.slice(0, 200)}`
        : `push: HTTP ${response.status} ${text.slice(0, 200)}`,
      ok: response.ok,
    };
  } catch (error) {
    return { line: `push: failed ${(error as Error).message}`, ok: false };
  }
};

const format = (results: readonly ChannelResult[]): string =>
  results
    .map(
      (result) =>
        `${result.channel} ${result.ok ? "OK" : "FAILED"} (${result.detail})`
    )
    .join("; ");

/** Mode after resolving auto: final from 10 minutes after the close, else intraday. */
export const resolveMode = (
  mode: Mode,
  minutes: number,
  date: string
): Exclude<Mode, "auto"> => {
  if (mode !== "auto") {
    return mode;
  }
  return minutes >= closeMinutes(date) + 10 ? "final" : "intraday";
};

/** Why the tick does nothing now (null when it runs). */
export const skipReason = (
  options: TickOptions,
  mode: Exclude<Mode, "auto">,
  ny: NyTime
): string | null => {
  if (options.testAlert || mode === "backfill") {
    return null;
  }
  if (!isTradingDay(ny.date)) {
    return `${ny.date} is not an NYSE session`;
  }
  if (mode === "intraday" && ny.minutes < OPEN_MINUTES + 5) {
    return `before the open (${ny.date})`;
  }
  return null;
};

type Delivery = BreadthState["testAlerts"][number]["channels"];

const deliveries = (results: readonly ChannelResult[], at: string): Delivery =>
  Object.fromEntries(
    results.map((r) => [r.channel, { at, detail: r.detail, ok: r.ok }])
  );

type Sources = Readonly<{
  tv: TvResult | null;
  wsj: WsjResult | null;
  errors: string[];
}>;

const fetchSources = async (
  io: TickIo,
  mode: Exclude<Mode, "auto">
): Promise<Sources> => {
  const errors: string[] = [];
  const tv = await fetchTradingView({
    dailyBars: mode === "backfill" ? 1000 : 60,
    now: io.now,
    socket: io.socket,
    timeoutMs: Number(io.env["BREADTH90_TV_TIMEOUT_MS"] ?? 25_000),
  }).catch((error: Error) => {
    errors.push(error.message);
    return null;
  });
  const wsj =
    mode === "backfill"
      ? null
      : await fetchWsj(io.fetch).catch((error: Error) => {
          errors.push(error.message);
          return null;
        });
  return { errors, tv, wsj };
};

const statusLine = (
  mode: string,
  dryRun: boolean,
  evaluation: Evaluation,
  sourceLine: string
): string => {
  const latest = evaluation.latest;
  const reading = latest
    ? `${latest.date} up ${latest.upPct}% adv ${latest.advPct ?? "n/a"}% ${latest.kind}${latest.final ? " final" : " intraday"}`
    : "no data";
  const armed = evaluation.armedOn
    ? ` armed ${evaluation.armedOn}${evaluation.strict ? " strict" : ""} (${evaluation.sessionsLeft} sessions left)`
    : "";
  return `breadth-90 ${mode}${dryRun ? " (dry run)" : ""}: ${reading} | state ${evaluation.state}${armed} | ${sourceLine}`;
};

/** Sends each due alert to the channels it has not reached yet; returns the new state and failure. */
const sendDue = async (
  io: TickIo,
  state: BreadthState,
  context: AlertContext,
  stateDir: string,
  dryRun: boolean,
  at: string,
  out: (line: string) => void
): Promise<Readonly<{ state: BreadthState; failed: boolean }>> => {
  // Events of the last two sessions: a fire at a missed close still alerts on the next run.
  const recent = new Set(
    context.evaluation.sessions.slice(-2).map((row) => row.date)
  );
  const due = context.evaluation.events
    .filter((event) => recent.has(event.date))
    .map((event) => composeAlert(event, context))
    .filter((alert) => !allSent(state, alert));
  if (due.length === 0) {
    out("no new alert");
  }
  let next = state;
  let failed = false;
  for (const alert of due) {
    const prior = next.sent[alert.key]?.channels ?? {};
    const channels = alert.channels.filter((channel) => !prior[channel]?.ok);
    if (dryRun) {
      out(`would alert ${alert.key}: ${alert.title} -> ${channels.join(", ")}`);
      continue;
    }
    const results = await deliver(io, alert, stateDir, channels);
    out(`alert ${alert.key}: ${format(results)}`);
    failed ||= results.some((result) => !result.ok);
    next = {
      ...next,
      sent: {
        ...next.sent,
        [alert.key]: {
          at,
          channels: { ...prior, ...deliveries(results, at) },
          seeded: false,
        },
      },
    };
  }
  return { failed, state: next };
};

/** Runs one tick and returns the process exit code (0 ok, 1 data or delivery failure, 2 usage). */
export const runBreadth90Tick = async (io: TickIo): Promise<number> => {
  let options: TickOptions;
  try {
    options = parseArgs(io.argv);
  } catch (error) {
    io.stderr.write(`breadth-90: ${(error as Error).message}\n`);
    return 2;
  }
  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  const now = io.now();
  const at = now.toISOString();
  const ny = nyTime(now);
  const mode = resolveMode(options.mode, ny.minutes, ny.date);
  const skip = skipReason(options, mode, ny);
  if (skip) {
    out(`breadth-90: ${skip}; skipped`);
    return 0;
  }
  const stateDir =
    io.env["BREADTH90_STATE_DIR"] ??
    `${io.home}/.local/share/vertex-breadth-90`;
  const statePath = `${stateDir}/state.json`;
  let state = parseState(await io.readText(statePath));
  const basket = readBasket(await io.readText(basketPathOf(io.env, io.home)));
  const { tv, wsj, errors } = await fetchSources(io, mode);
  for (const error of errors) {
    io.stderr.write(`breadth-90: source error: ${error}\n`);
  }
  const merged = mergeSessions(state.days, ny.date, mode, tv, wsj, at);
  const check = merged.crossCheck;
  if (check?.disagree) {
    io.stderr.write(
      `breadth-90: DISAGREEMENT ${ny.date}: tradingview ${check.tvUpPct}% vs wsj ${check.wsjUpPct}% (${check.diff} pp)\n`
    );
  }
  const days = Object.values(merged.days).filter(
    (item) => item.date <= ny.date
  );
  const evaluation = evaluate(days);
  const latest = evaluation.latest;
  const latestDay = latest ? merged.days[latest.date] : undefined;
  const checkText = check
    ? ` · cross-check wsj ${check.wsjUpPct}% (Δ ${check.diff} pp)`
    : "";
  const sourceLine = `Source: ${latestDay?.source ?? "none"} as of ${latestDay?.asOf ?? "n/a"}${checkText}`;
  state = {
    ...state,
    crossChecks: [...state.crossChecks, ...(check ? [check] : [])],
    days: merged.days,
  };
  if (
    mode === "backfill" ||
    (state.lastTick === null && Object.keys(state.sent).length === 0)
  ) {
    state = seedHistory(state, evaluation, mode === "backfill", at);
  }
  out(statusLine(mode, options.dryRun, evaluation, sourceLine));
  for (const line of basket.lines) {
    out(line);
  }
  if (mode === "backfill") {
    for (const event of evaluation.events) {
      out(
        `  ${event.date} ${event.kind} up ${event.upPct}% adv ${event.advPct ?? "n/a"}%${event.trigger ? ` ${event.trigger}` : ""} ${event.tier}${event.armedOn ? ` (armed ${event.armedOn})` : ""}`
      );
    }
  }
  let failed =
    mode !== "backfill" && isTradingDay(ny.date) && latest?.date !== ny.date;
  if (failed) {
    io.stderr.write(`breadth-90: no data for ${ny.date}\n`);
  }
  const context: AlertContext = { basket, evaluation, sourceLine };
  if (options.testAlert) {
    const alert = composeTestAlert(context, at);
    if (options.dryRun) {
      out(`would send test alert: ${alert.title}`);
    } else {
      const results = await deliver(io, alert, stateDir);
      out(`test alert: ${format(results)}`);
      failed ||= results.some((result) => !result.ok);
      state = {
        ...state,
        testAlerts: [
          ...state.testAlerts,
          { at, channels: deliveries(results, at) },
        ],
      };
    }
  } else if (mode !== "backfill") {
    const sent = await sendDue(
      io,
      state,
      context,
      stateDir,
      options.dryRun,
      at,
      out
    );
    state = sent.state;
    failed ||= sent.failed;
  }
  if (options.dryRun) {
    return failed ? 1 : 0;
  }
  if (options.push) {
    const pushed = await pushToVertex(
      io,
      mode === "backfill" ? 2000 : PUSH_SESSIONS,
      evaluation,
      days,
      basket,
      at
    );
    out(pushed.line);
    failed ||= !pushed.ok;
  }
  await io.writeText(
    statePath,
    `${JSON.stringify(trimState({ ...state, lastTick: at }), null, 2)}\n`
  );
  await io.appendText(
    `${stateDir}/history.jsonl`,
    `${JSON.stringify({ advPct: latest?.advPct ?? null, armedOn: evaluation.armedOn, at, crossCheck: check, date: latest?.date ?? null, errors, final: latest?.final ?? null, mode, source: latestDay?.source ?? null, state: evaluation.state, strict: evaluation.strict, upPct: latest?.upPct ?? null })}\n`
  );
  return failed ? 1 : 0;
};
