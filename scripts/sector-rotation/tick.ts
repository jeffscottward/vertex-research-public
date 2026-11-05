// Sector rotation tick client for the scheduler (user systemd timer, not enabled by default).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:sector-rotation:tick [--dry-run]
// It calls sectorRotation.collect with an operator agent WRITE key. The procedure reads public Yahoo
// daily bars for SPY and the 11 sector ETFs, stores daily and weekly points and sends one ntfy line
// per new entry into leading or lagging. --dry-run computes and reports only: nothing is stored,
// recorded or sent. Research only: no orders. The key is never printed.
// Optional second route: with VERTEX_ALERT_POST_URL (a loopback chat bot endpoint that takes
// {channel, text}) and VERTEX_ALERT_CHANNEL set, each new alert that the server could not deliver
// (not-configured or failed) is posted there once. The server records an alert once, so a repeat
// run never posts it again. After each post the client records the result on the alert row through
// sectorRotation.recordChatDelivery ("sent" on a 2xx {ok:true} reply, else "failed"). A failed
// write-back is reported but never causes a second post.

import { z } from "zod";

export type SectorRotationTickIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

const EnvelopeSchema = z.object({ json: z.unknown().optional() });
const AlertsSchema = z.object({
  alerts: z.array(
    z.object({
      date: z.string(),
      delivery: z.string(),
      line: z.string(),
      symbol: z.string(),
      to: z.string(),
    })
  ),
});

const required = (
  env: SectorRotationTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

type TickAlert = Readonly<{
  date: string;
  delivery: string;
  line: string;
  symbol: string;
  to: string;
}>;

type Api = Readonly<{ origin: string; apiKey: string }>;

const apiOf = (io: SectorRotationTickIo): Api => ({
  apiKey: required(io.env, "VERTEX_AGENT_API_KEY"),
  origin: new URL(required(io.env, "VERTEX_ORIGIN")).origin,
});

const callApi = (
  io: SectorRotationTickIo,
  api: Api,
  procedure: string,
  input: unknown
): Promise<Response> =>
  io.post(`${api.origin}/api/orpc/sectorRotation/${procedure}`, {
    body: JSON.stringify({ json: input }),
    headers: {
      "content-type": "application/json",
      origin: api.origin,
      "x-api-key": api.apiKey,
    },
    method: "POST",
  });

const tick = async (
  io: SectorRotationTickIo
): Promise<Readonly<{ lines: string[]; alerts: TickAlert[] }>> => {
  const unknown = io.argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0)
    throw new Error(`unknown argument: ${unknown.join(" ")}`);
  const response = await callApi(io, apiOf(io), "collect", {
    dryRun: io.argv.includes("--dry-run"),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `sectorRotation.collect returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  const result = EnvelopeSchema.parse(JSON.parse(text)).json ?? null;
  const parsed = AlertsSchema.safeParse(result);
  const alerts = parsed.success ? parsed.data.alerts : [];
  return {
    alerts,
    lines: [
      JSON.stringify(result),
      ...alerts.map((alert) => `${alert.line} [${alert.delivery}]`),
    ],
  };
};

/** Records one chat post result on the alert row; true when the server accepted the call. */
const writeBack = async (
  io: SectorRotationTickIo,
  alert: TickAlert,
  delivery: "sent" | "failed"
): Promise<boolean> => {
  const response = await callApi(io, apiOf(io), "recordChatDelivery", {
    delivery,
    enteredOn: alert.date,
    quadrant: alert.to,
    symbol: alert.symbol,
  }).catch(() => null);
  if (response?.ok === true) return true;
  io.stderr.write(
    `could not record ${delivery} for ${alert.symbol} ${alert.to} ${alert.date}${response === null ? "" : ` (HTTP ${response.status})`}\n`
  );
  return false;
};

const chatAccepted = async (response: Response | null): Promise<boolean> => {
  if (response?.ok !== true) return false;
  const body: unknown = await response.json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    body.ok === true
  );
};

/**
 * Posts each undelivered alert line to the chat endpoint once and records the result. Returns how
 * many posts failed and how many write-backs failed.
 */
const forward = async (
  io: SectorRotationTickIo,
  alerts: readonly TickAlert[]
): Promise<Readonly<{ failed: number; unrecorded: number }>> => {
  const url = io.env["VERTEX_ALERT_POST_URL"]?.trim() ?? "";
  const channel = io.env["VERTEX_ALERT_CHANNEL"]?.trim() ?? "";
  if (url === "" || channel === "") return { failed: 0, unrecorded: 0 };
  let failed = 0;
  let unrecorded = 0;
  for (const alert of alerts) {
    if (alert.delivery !== "not-configured" && alert.delivery !== "failed")
      continue;
    const response = await io
      .post(url, {
        body: JSON.stringify({ channel, text: alert.line }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      .catch(() => null);
    const sent = await chatAccepted(response);
    if (sent) io.stdout.write(`posted to ${channel}\n`);
    else failed += 1;
    if (!(await writeBack(io, alert, sent ? "sent" : "failed")))
      unrecorded += 1;
  }
  return { failed, unrecorded };
};

/** Runs one collection and returns the process exit code (0 on success). */
export const runSectorRotationTick = async (
  io: SectorRotationTickIo
): Promise<number> => {
  try {
    const { alerts, lines } = await tick(io);
    for (const line of lines) io.stdout.write(`${line}\n`);
    const { failed, unrecorded } = await forward(io, alerts);
    if (failed > 0)
      throw new Error(`${failed} alert line(s) could not be posted to chat`);
    if (unrecorded > 0)
      throw new Error(
        `${unrecorded} chat delivery result(s) could not be recorded (lines were posted once; not reposted)`
      );
    return 0;
  } catch (error) {
    io.stderr.write(
      `sector rotation tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
