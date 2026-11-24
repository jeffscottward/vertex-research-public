// Connectivity health & alerting tick client for QuantVPS / rig (research only, no orders).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
//   bun run vertex:connectivity:tick [--dry-run]
// Calls connectivity.checkAlerts with an operator agent WRITE key. The server evaluates recent
// Flow samples (QuantData & IBKR History) and OpenBB ingest runs, classifies HTTP 401/403
// credential failures vs repeated 5xx/unreachable feed errors, attempts server-side ntfy delivery,
// and returns pendingChat when ntfy is not configured or failed. When pendingChat is returned (and
// not --dry-run), this client posts once to VERTEX_ALERT_POST_URL (#omp-alerts) with a
// [NEEDS YOU — CREDENTIAL ROTATION] prefix for auth failures and acknowledges delivery through
// connectivity.recordAlertChat. The API key is never printed.

import { z } from "zod";

export type ConnectivityTickIo = Readonly<{
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
  needsOwnerAsk: z.boolean(),
  title: z.string(),
});

const PlannedAlertSchema = z.object({
  body: z.string(),
  kind: z.enum(["alert", "recovery"]),
  needsOwnerAsk: z.boolean(),
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
  alertableIssues: z.array(z.unknown()),
  delivery: z.enum(["sent", "not-configured", "failed", "dry-run"]).nullable(),
  dryRun: z.boolean(),
  issues: z.array(z.unknown()),
  needsOwnerAsk: z.boolean(),
  newlyAlerted: z.array(z.unknown()),
  ntfyConfigured: z.boolean(),
  overallStatus: z.enum(["healthy", "degraded", "auth_failed"]),
  pendingChat: PendingChatSchema.nullable(),
  plannedAlert: PlannedAlertSchema.nullable(),
});

const ChatAckReplySchema = z.object({
  committed: z.boolean(),
  delivery: z.enum(["sent", "failed"]),
  eventId: z.string(),
});

export type ConnectivityCheckReply = z.infer<typeof CheckReplySchema>;
type PendingChat = z.infer<typeof PendingChatSchema>;
type Api = Readonly<{ apiKey: string; origin: string }>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const required = (
  env: ConnectivityTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const apiOf = (io: ConnectivityTickIo): Api => {
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  let origin: string;
  try {
    origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  } catch {
    throw new Error("VERTEX_ORIGIN must be a valid URL");
  }
  return { apiKey, origin };
};

const callApi = async <T>(
  io: ConnectivityTickIo,
  api: Api,
  procedure: "checkAlerts" | "recordAlertChat",
  input: unknown,
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<T> => {
  const response = await io
    .post(`${api.origin}/api/orpc/connectivity/${procedure}`, {
      body: JSON.stringify({ json: input }),
      headers: {
        "content-type": "application/json",
        origin: api.origin,
        "x-api-key": api.apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    })
    .catch((error: unknown) => {
      throw new Error(
        `connectivity.${procedure} unreachable: ${messageOf(error)}`
      );
    });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `connectivity.${procedure} returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `connectivity.${procedure} returned a body that is not JSON: ${text.slice(0, 300)}`
    );
  }
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new Error(
      `connectivity.${procedure} returned an unexpected envelope`
    );
  }
  const parsed = schema.safeParse(envelope.data.json);
  if (!parsed.success) {
    throw new Error(
      `connectivity.${procedure} returned an unexpected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
};

const postChat = async (
  io: ConnectivityTickIo,
  url: string,
  channel: string,
  chat: PendingChat
): Promise<string | null> => {
  const prefix = chat.needsOwnerAsk
    ? "🔐 [NEEDS YOU — CREDENTIAL ROTATION]\n"
    : "";
  const text = `${prefix}**${chat.title}**\n${chat.body}`.slice(
    0,
    MAX_CHAT_TEXT_CHARS
  );
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
  io: ConnectivityTickIo,
  api: Api,
  eventId: string,
  delivery: "sent" | "failed"
): Promise<Readonly<{ committed: boolean; error: string | null }>> => {
  try {
    const ack = await callApi(
      io,
      api,
      "recordAlertChat",
      { delivery, eventId },
      ChatAckReplySchema,
      SIDE_REQUEST_TIMEOUT_MS
    );
    return { committed: ack.committed, error: null };
  } catch (error) {
    return { committed: false, error: messageOf(error) };
  }
};

const deliverPendingChat = async (
  io: ConnectivityTickIo,
  api: Api,
  reply: ConnectivityCheckReply,
  chat: PendingChat
): Promise<boolean> => {
  const url = io.env["VERTEX_ALERT_POST_URL"]?.trim() ?? "";
  const channel = io.env["VERTEX_ALERT_CHANNEL"]?.trim() ?? "";
  if (url === "" || channel === "") {
    if (reply.delivery !== "not-configured") {
      await recordChatBestEffort(io, api, chat.eventId, "failed");
    }
    io.stderr.write(
      "connectivity tick failed: VERTEX_ALERT_POST_URL and VERTEX_ALERT_CHANNEL are required when server ntfy did not deliver\n"
    );
    return false;
  }
  const failure = await postChat(io, url, channel, chat);
  if (failure !== null) {
    await recordChatBestEffort(io, api, chat.eventId, "failed");
    io.stderr.write(
      `connectivity tick failed: could not post ${chat.kind} to ${channel}: ${failure}\n`
    );
    return false;
  }
  io.stdout.write(`posted connectivity ${chat.kind} to ${channel}\n`);
  const ack = await recordChatBestEffort(io, api, chat.eventId, "sent");
  if (ack.error !== null) {
    io.stderr.write(
      `connectivity tick failed: could not record chat delivery for ${chat.eventId}: ${ack.error}\n`
    );
    return false;
  }
  if (!ack.committed) {
    io.stderr.write(
      `connectivity tick failed: chat delivery for ${chat.eventId} was not committed\n`
    );
    return false;
  }
  return true;
};

/**
 * Runs one connectivity alert check against an already-resolved API origin & key.
 * Returns `{ delivered, ok, reply }` so other ticks (such as flow.tick) can trigger alert delivery
 * immediately after observing unavailable feeds without duplicating alert logic.
 */
export const checkConnectivityAlertsNow = async (
  io: ConnectivityTickIo,
  api: Api,
  dryRun: boolean
): Promise<
  Readonly<{
    delivered: boolean;
    ok: boolean;
    reply: ConnectivityCheckReply;
  }>
> => {
  const reply = await callApi(
    io,
    api,
    "checkAlerts",
    { dryRun },
    CheckReplySchema,
    CHECK_TIMEOUT_MS
  );
  io.stdout.write(
    `connectivity${dryRun ? " (dry-run)" : ""}: status=${reply.overallStatus} issues=${reply.issues.length} alertable=${reply.alertableIssues.length} action=${reply.action} delivery=${reply.delivery ?? "none"} owner_ask=${reply.needsOwnerAsk ? "yes" : "no"}\n`
  );
  if (dryRun && reply.plannedAlert !== null) {
    io.stdout.write(
      `planned ${reply.plannedAlert.kind}: ${reply.plannedAlert.title} | ${reply.plannedAlert.body}\n`
    );
  }
  if (!dryRun && reply.pendingChat !== null) {
    const sent = await deliverPendingChat(io, api, reply, reply.pendingChat);
    return { delivered: sent, ok: sent, reply };
  }
  const delivered =
    reply.delivery === "sent" ||
    (reply.action === "noop" && reply.activeAlertKeys.length > 0);
  return { delivered, ok: true, reply };
};

/**
 * Standalone connectivity health check CLI.
 * Exit codes: 0 success / noop / dry-run, 1 API / chat / ack / env error, 2 unknown CLI argument.
 */
export const runConnectivityTick = async (
  io: ConnectivityTickIo
): Promise<number> => {
  const unknown = io.argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    io.stderr.write(
      `connectivity tick usage error: unknown argument: ${unknown.join(" ")}\n`
    );
    return 2;
  }
  const dryRun = io.argv.includes("--dry-run");
  try {
    const api = apiOf(io);
    const result = await checkConnectivityAlertsNow(io, api, dryRun);
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`connectivity tick failed: ${messageOf(error)}\n`);
    return 1;
  }
};
