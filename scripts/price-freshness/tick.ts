// Price freshness tick client for QuantVPS (docs/vertex-rebuild/designs/price-freshness-alert/plan.md).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
//   bun run vertex:price-freshness:tick [--dry-run]
// Calls openbb.checkPriceFreshness with an operator agent WRITE key. The server evaluates all 31
// stored daily series and 14 stored 1d bar series, attempts server-side ntfy delivery when needed,
// and returns pendingChat when ntfy is not-configured or failed. When pendingChat is returned (and
// not --dry-run), this client posts once to VERTEX_ALERT_POST_URL (#omp-alerts) and acknowledges
// delivery through openbb.recordPriceFreshnessChat. Research only: no orders. The key is never printed.

import { z } from "zod";

export type PriceFreshnessTickIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
}>;

const CHECK_TIMEOUT_MS = 15_000;
const SIDE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CHAT_TEXT_CHARS = 1900;

const EnvelopeSchema = z.object({ json: z.unknown().optional() });

const PendingChatSchema = z.object({
  body: z.string(),
  eventId: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

const PlannedAlertSchema = z.object({
  body: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

const CheckReplySchema = z.object({
  action: z.enum([
    "noop",
    "in-flight",
    "prune-active",
    "clear-pending",
    "alert",
    "recovery",
  ]),
  activeAlertKeys: z.array(z.string()),
  dailyBarsCount: z.number().int().nonnegative(),
  dailySeriesCount: z.number().int().nonnegative(),
  delivery: z.enum(["sent", "not-configured", "failed", "dry-run"]).nullable(),
  dryRun: z.boolean(),
  expectedSession: z.string(),
  ntfyConfigured: z.boolean(),
  pendingChat: PendingChatSchema.nullable(),
  plannedAlert: PlannedAlertSchema.nullable(),
  stale: z.array(
    z.object({
      id: z.string(),
      lastDate: z.string().nullable(),
      sessionsBehind: z.number().int().nullable(),
      table: z.enum(["daily_series", "daily_bars"]),
    })
  ),
});

const ChatAckReplySchema = z.object({
  committed: z.boolean(),
  delivery: z.enum(["sent", "failed"]),
  eventId: z.string(),
});

type CheckReply = z.infer<typeof CheckReplySchema>;
type PendingChat = z.infer<typeof PendingChatSchema>;
type Api = Readonly<{ apiKey: string; origin: string }>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const required = (
  env: PriceFreshnessTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const apiOf = (io: PriceFreshnessTickIo): Api => {
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const url = new URL(required(io.env, "VERTEX_ORIGIN"));
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("VERTEX_ORIGIN must use http or https");
  return {
    apiKey,
    origin: url.origin,
  };
};

const unexpectedShape = (
  procedure: string,
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[]
): Error => {
  const details = issues
    .slice(0, 5)
    .map((issue) => {
      const path = [...prefix, ...issue.path].map(String).join(".");
      return `${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("; ");
  return new Error(`${procedure} returned an unexpected shape (${details})`);
};

const callApi = async <T>(
  io: PriceFreshnessTickIo,
  api: Api,
  procedure: "checkPriceFreshness" | "recordPriceFreshnessChat",
  input: unknown,
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<T> => {
  const response = await io.post(`${api.origin}/api/orpc/openbb/${procedure}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      "content-type": "application/json",
      origin: api.origin,
      "x-api-key": api.apiKey,
    },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `openbb.${procedure} returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `openbb.${procedure} returned non-JSON: ${text.slice(0, 300)}`
    );
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success)
    throw unexpectedShape(`openbb.${procedure}`, envelope.error.issues, []);
  const parsed = schema.safeParse(envelope.data.json);
  if (!parsed.success)
    throw unexpectedShape(`openbb.${procedure}`, parsed.error.issues, ["json"]);
  return parsed.data;
};

const postChat = async (
  io: PriceFreshnessTickIo,
  url: string,
  channel: string,
  chat: PendingChat
): Promise<string | null> => {
  const text = `**${chat.title}**\n${chat.body}`.slice(0, MAX_CHAT_TEXT_CHARS);
  let response: Response;
  try {
    response = await io.post(url, {
      body: JSON.stringify({ channel, text }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(SIDE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return messageOf(error);
  }
  if (!response.ok) return `HTTP ${response.status}`;
  const reply: unknown = await response.json().catch(() => null);
  return typeof reply === "object" &&
    reply !== null &&
    "ok" in reply &&
    reply.ok === true
    ? null
    : 'reply was not {"ok":true}';
};

const recordChatBestEffort = async (
  io: PriceFreshnessTickIo,
  api: Api,
  eventId: string,
  delivery: "sent" | "failed"
): Promise<Readonly<{ committed: boolean; error: string | null }>> => {
  try {
    const ack = await callApi(
      io,
      api,
      "recordPriceFreshnessChat",
      { delivery, eventId },
      ChatAckReplySchema,
      SIDE_REQUEST_TIMEOUT_MS
    );
    return { committed: ack.committed, error: null };
  } catch (error) {
    return { committed: false, error: messageOf(error) };
  }
};

const handlePendingChat = async (
  io: PriceFreshnessTickIo,
  api: Api,
  reply: CheckReply,
  chat: PendingChat
): Promise<number> => {
  const url = io.env["VERTEX_ALERT_POST_URL"]?.trim() ?? "";
  const channel = io.env["VERTEX_ALERT_CHANNEL"]?.trim() ?? "";
  if (url === "" || channel === "") {
    if (reply.delivery !== "not-configured") {
      await recordChatBestEffort(io, api, chat.eventId, "failed");
    }
    io.stderr.write(
      "price freshness tick failed: VERTEX_ALERT_POST_URL and VERTEX_ALERT_CHANNEL are required when server ntfy did not deliver\n"
    );
    return 1;
  }
  const failure = await postChat(io, url, channel, chat);
  if (failure !== null) {
    await recordChatBestEffort(io, api, chat.eventId, "failed");
    io.stderr.write(
      `price freshness tick failed: could not post ${chat.kind} to ${channel}: ${failure}\n`
    );
    return 1;
  }
  io.stdout.write(`posted ${chat.kind} to ${channel}\n`);
  const ack = await recordChatBestEffort(io, api, chat.eventId, "sent");
  if (ack.error !== null) {
    io.stderr.write(
      `price freshness tick failed: could not record chat delivery for ${chat.eventId} (next tick may duplicate): ${ack.error}\n`
    );
    return 1;
  }
  if (!ack.committed) {
    io.stderr.write(
      `price freshness tick failed: chat delivery for ${chat.eventId} was not committed (superseded eventId; next tick may duplicate)\n`
    );
    return 1;
  }
  return 0;
};

/**
 * Runs one QuantVPS price freshness check.
 * Exit codes: 0 success / noop / dry-run, 1 API / chat / ack / env error, 2 unknown CLI argument.
 */
export const runPriceFreshnessTick = async (
  io: PriceFreshnessTickIo
): Promise<number> => {
  const unknown = io.argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    io.stderr.write(
      `price freshness tick usage error: unknown argument: ${unknown.join(" ")}\n`
    );
    return 2;
  }
  const dryRun = io.argv.includes("--dry-run");
  try {
    const api = apiOf(io);
    const reply = await callApi(
      io,
      api,
      "checkPriceFreshness",
      { dryRun },
      CheckReplySchema,
      CHECK_TIMEOUT_MS
    );
    io.stdout.write(
      `price-freshness${dryRun ? " (dry-run)" : ""}: expected=${reply.expectedSession} stale=${reply.stale.length}/${reply.dailySeriesCount + reply.dailyBarsCount} action=${reply.action} delivery=${reply.delivery ?? "none"}\n`
    );
    if (!reply.ntfyConfigured) {
      io.stdout.write(
        "note: server ntfy is not configured; using #omp-alerts fallback (rig-down alerts queue in Postgres until the tunnel returns)\n"
      );
    }
    if (dryRun && reply.plannedAlert !== null) {
      io.stdout.write(
        `planned ${reply.plannedAlert.kind}: ${reply.plannedAlert.title} | ${reply.plannedAlert.body}\n`
      );
    }
    if (!dryRun && reply.pendingChat !== null) {
      return await handlePendingChat(io, api, reply, reply.pendingChat);
    }
    return 0;
  } catch (error) {
    io.stderr.write(`price freshness tick failed: ${messageOf(error)}\n`);
    return 1;
  }
};
