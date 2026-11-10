// Breadth-90 alert copy and the three delivery channels: ntfy (the owner's phone topic from
// ~/.config/omp-notify/ntfy.json, JSON publish), email (mutt, with a local sent copy) and Discord
// (the loopback omp-discord-bot /post route, #trading-alerts). The ntfy topic is never printed.

import { z } from "zod";

import type { BasketSummary } from "./basket.ts";
import type { Evaluation, FireTrigger, SignalEvent } from "./classifier.ts";
import type { FetchLike } from "./wsj.ts";

export type Channel = "ntfy" | "email" | "discord";
const CHANNELS: readonly Channel[] = ["ntfy", "email", "discord"];

export type Alert = Readonly<{
  key: string;
  title: string;
  body: string;
  /** ntfy priority: 5 max, 4 high, 3 default. */
  priority: 3 | 4 | 5;
  tags: readonly string[];
  channels: readonly Channel[];
}>;

export type ChannelResult = Readonly<{
  channel: Channel;
  ok: boolean;
  detail: string;
}>;

export type RunResult = Readonly<{ code: number; stderr: string }>;

export type AlertIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  fetch: FetchLike;
  run: (
    command: string,
    args: readonly string[],
    stdin: string
  ) => Promise<RunResult>;
  readText: (path: string) => Promise<string | null>;
  fileSize: (path: string) => Promise<number>;
}>;

export type AlertContext = Readonly<{
  evaluation: Evaluation;
  basket: BasketSummary;
  sourceLine: string;
}>;

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${value.toFixed(1)}%`;

/** Dedupe key: one alert per kind, session and tier. */
export const alertKey = (event: SignalEvent): string =>
  `${event.kind}:${event.date}:${event.tier}`;

const readingLine = (event: SignalEvent, final: boolean): string =>
  `NYSE ${event.date}${final ? " close" : " intraday"}: up volume ${pct(event.upPct)}, advancers ${pct(event.advPct)}.`;

const TRIGGER_COPY: Record<FireTrigger, string> = {
  UP_80_X2: "back-to-back 80% up-volume days",
  UP_90: "a 90% up-volume day",
};

const gradeLine = (event: SignalEvent): string =>
  event.grade === "major"
    ? "🏆 Grade MAJOR: volume AND advancers both cleared the bar."
    : "⚠️ Grade VOLUME-ONLY: advancers lagged. Desmond rule 7: one-component days are often short-lived; size accordingly.";

const armLine = (event: SignalEvent): string =>
  `Armed by the 80%+ down day of ${event.armedOn ?? "n/a"}${event.strict ? " (STRICT: a true 90% down day is in the window)" : ""}.`;

/** Loud copy for one signal event, with the channels the spec gives that kind. */
export const composeAlert = (
  event: SignalEvent,
  context: AlertContext
): Alert => {
  const footer = [
    ...context.basket.lines,
    context.sourceLine,
    "Research only: no orders are placed.",
  ];
  const key = alertKey(event);
  const trigger = event.trigger ? TRIGGER_COPY[event.trigger] : "";
  if (event.kind === "FIRED") {
    return {
      body: [
        "🚨🚀💰 BREADTH-90 FIRED at the close: the official close confirms the thrust. BUY THE DIP.",
        readingLine(event, true),
        `Trigger: ${trigger}. ${armLine(event)}`,
        gradeLine(event),
        ...footer,
      ].join("\n"),
      channels: CHANNELS,
      key,
      priority: 5,
      tags: ["rotating_light", "rocket", "moneybag"],
      title: `🚨🟢 NOW'S THE TIME TO BUY THE DIP: BREADTH-90 FIRED ${pct(event.upPct)} (${event.date})`,
    };
  }
  if (event.kind === "FORMING") {
    return {
      body: [
        "🔥🚨 ARMED and today meets the fire rule intraday. Actionable before the close (not confirmed yet).",
        readingLine(event, false),
        `On pace for ${trigger}. ${armLine(event)}`,
        gradeLine(event),
        ...footer,
      ].join("\n"),
      channels: CHANNELS,
      key,
      priority: 5,
      tags: ["rotating_light", "fire", "hourglass_flowing_sand"],
      title: `🔥⏳ BREADTH-90 FORMING: ${pct(event.upPct)} up volume intraday, ACT BEFORE THE CLOSE (${event.date})`,
    };
  }
  if (event.kind === "THRUST") {
    return {
      body: [
        "🟢 A 90% up-volume day closed without a recent 80% down day: a breadth thrust notice, not the buy-the-dip signal.",
        readingLine(event, true),
        gradeLine(event),
        ...footer,
      ].join("\n"),
      channels: CHANNELS,
      key,
      priority: 4,
      tags: ["green_circle", "chart_with_upwards_trend"],
      title: `🟢📈 Breadth thrust: ${pct(event.upPct)} up-volume day, not armed (${event.date})`,
    };
  }
  return {
    body: [
      `🔻 ${event.strict ? "A 90%" : "An 80%"} down-volume day closed: breadth-90 is ARMED for 30 sessions.`,
      readingLine(event, true),
      "👀 Watching for a 90% up day, or back-to-back 80% up days, to fire BUY THE DIP.",
      context.sourceLine,
      "Research only: no orders are placed.",
    ].join("\n"),
    channels: ["discord", "ntfy"],
    key,
    priority: 3,
    tags: ["warning", "small_red_triangle_down"],
    title: `⚠️🔻 BREADTH-90 ARMED${event.strict ? " (STRICT)" : ""}: ${pct(100 - event.upPct)} down volume (${event.date})`,
  };
};

export const composeTestAlert = (context: AlertContext, at: string): Alert => {
  const { evaluation } = context;
  const latest = evaluation.latest;
  return {
    body: [
      "🧪 TEST ONLY: checks that breadth-90 alerts reach ntfy, email and Discord. NO SIGNAL FIRED.",
      latest
        ? `NYSE ${latest.date}${latest.final ? " close" : " intraday"}: up volume ${pct(latest.upPct)}, advancers ${pct(latest.advPct)}.`
        : "No session data yet.",
      `State: ${evaluation.state}${evaluation.armedOn ? ` (armed by ${evaluation.armedOn}${evaluation.strict ? ", strict" : ""}, ${evaluation.sessionsLeft} sessions left)` : ""}.`,
      ...context.basket.lines,
      context.sourceLine,
    ].join("\n"),
    channels: CHANNELS,
    key: `TEST:${at}`,
    priority: 3,
    tags: ["test_tube"],
    title: `🧪 TEST 🚨🟢 BREADTH-90 alert channel check (state ${evaluation.state})`,
  };
};

const NtfyConfigSchema = z.object({
  enabled: z.boolean(),
  server: z.string().url(),
  topic: z.string().min(1),
});
const NtfyReplySchema = z.object({ id: z.string() });

export const sendNtfy = async (
  io: AlertIo,
  alert: Alert
): Promise<ChannelResult> => {
  const path =
    io.env["BREADTH90_NTFY_CONFIG"] ??
    `${io.home}/.config/omp-notify/ntfy.json`;
  const raw = await io.readText(path);
  const config = NtfyConfigSchema.safeParse(
    raw === null ? null : JSON.parse(raw)
  );
  if (!config.success) {
    return {
      channel: "ntfy",
      detail: "ntfy config missing or invalid",
      ok: false,
    };
  }
  if (!config.data.enabled) {
    return { channel: "ntfy", detail: "ntfy disabled in config", ok: false };
  }
  const response = await io.fetch(config.data.server, {
    body: JSON.stringify({
      message: alert.body,
      priority: alert.priority,
      tags: alert.tags,
      title: alert.title,
      topic: config.data.topic,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
  const reply = NtfyReplySchema.safeParse(
    await response.json().catch(() => null)
  );
  const id = reply.success ? reply.data.id : null;
  return {
    channel: "ntfy",
    detail: `HTTP ${response.status}${id ? ` id=${id}` : " (no message id)"}`,
    ok: response.ok && id !== null,
  };
};

export const sendEmail = async (
  io: AlertIo,
  alert: Alert,
  stateDir: string
): Promise<ChannelResult> => {
  // No default recipient: the address is deployment data (breadth-90.env), never in the repository.
  const to = io.env["BREADTH90_EMAIL_TO"]?.trim() ?? "";
  if (to === "") {
    return {
      channel: "email",
      detail: "BREADTH90_EMAIL_TO is not set",
      ok: false,
    };
  }
  const mutt = io.env["BREADTH90_MUTT"] ?? "mutt";
  const record = `${stateDir}/sent.mbox`;
  const before = await io.fileSize(record);
  const result = await io.run(
    mutt,
    [
      "-e",
      "set copy=yes",
      "-e",
      `set record=${record}`,
      "-s",
      alert.title,
      "--",
      to,
    ],
    `${alert.body}\n`
  );
  const after = await io.fileSize(record);
  const copy =
    after > before
      ? `sent copy +${after - before} bytes in ${record}`
      : "no sent copy";
  return {
    channel: "email",
    detail: `${mutt} exit ${result.code}, ${copy}${result.code === 0 ? "" : `: ${result.stderr.trim().slice(0, 200)}`}`,
    ok: result.code === 0,
  };
};

const DiscordReplySchema = z.object({ ok: z.literal(true) }).passthrough();

export const sendDiscord = async (
  io: AlertIo,
  alert: Alert
): Promise<ChannelResult> => {
  const url = io.env["BREADTH90_DISCORD_URL"] ?? "http://127.0.0.1:47821/post";
  const channel = io.env["BREADTH90_DISCORD_CHANNEL"] ?? "trading-alerts";
  const text = `**${alert.title}**\n${alert.body}`.slice(0, 1900);
  const response = await io.fetch(url, {
    body: JSON.stringify({ channel, text, urgent: true }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
  const reply = DiscordReplySchema.safeParse(
    await response.json().catch(() => null)
  );
  const fields = reply.success
    ? Object.entries(reply.data)
        .filter(
          ([key, value]) =>
            ["channel", "id"].includes(key) && typeof value === "string"
        )
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return {
    channel: "discord",
    detail: `HTTP ${response.status}${reply.success ? ` ok ${fields}`.trimEnd() : " (not ok)"}`,
    ok: response.ok && reply.success,
  };
};

/** Sends to each requested channel; a thrown error becomes a failed result for that channel. */
export const deliver = async (
  io: AlertIo,
  alert: Alert,
  stateDir: string,
  channels: readonly Channel[] = alert.channels
): Promise<ChannelResult[]> =>
  Promise.all(
    channels.map(async (channel) => {
      try {
        if (channel === "ntfy") {
          return await sendNtfy(io, alert);
        }
        if (channel === "email") {
          return await sendEmail(io, alert, stateDir);
        }
        return await sendDiscord(io, alert);
      } catch (error) {
        return {
          channel,
          detail: `error: ${(error as Error).message}`,
          ok: false,
        };
      }
    })
  );
