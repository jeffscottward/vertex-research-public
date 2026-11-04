// Sector rotation tick client for the scheduler (user systemd timer, not enabled by default).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:sector-rotation:tick [--dry-run]
// It calls sectorRotation.collect with an operator agent WRITE key. The procedure reads public Yahoo
// daily bars for SPY and the 11 sector ETFs, stores daily and weekly points and sends one ntfy line
// per new entry into leading or lagging. --dry-run computes and reports only: nothing is stored,
// recorded or sent. Research only: no orders. The key is never printed.
// Optional second route: with VERTEX_ALERT_POST_URL (a loopback chat bot endpoint that takes
// {channel, text}) and VERTEX_ALERT_CHANNEL set, each new alert that the server could not deliver
// (not-configured or failed) is posted there once. The server records an alert once, so a repeat
// run never posts it again.

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
  alerts: z.array(z.object({ delivery: z.string(), line: z.string() })),
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

type TickAlert = Readonly<{ delivery: string; line: string }>;

const tick = async (
  io: SectorRotationTickIo
): Promise<Readonly<{ lines: string[]; alerts: TickAlert[] }>> => {
  const unknown = io.argv.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0)
    throw new Error(`unknown argument: ${unknown.join(" ")}`);
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const response = await io.post(`${origin}/api/orpc/sectorRotation/collect`, {
    body: JSON.stringify({
      json: { dryRun: io.argv.includes("--dry-run") },
    }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-api-key": apiKey,
    },
    method: "POST",
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

/** Posts each undelivered alert line to the chat endpoint; returns how many posts failed. */
const forward = async (
  io: SectorRotationTickIo,
  alerts: readonly TickAlert[]
): Promise<number> => {
  const url = io.env["VERTEX_ALERT_POST_URL"]?.trim() ?? "";
  const channel = io.env["VERTEX_ALERT_CHANNEL"]?.trim() ?? "";
  if (url === "" || channel === "") return 0;
  let failed = 0;
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
    if (response?.ok === true) io.stdout.write(`posted to ${channel}\n`);
    else failed += 1;
  }
  return failed;
};

/** Runs one collection and returns the process exit code (0 on success). */
export const runSectorRotationTick = async (
  io: SectorRotationTickIo
): Promise<number> => {
  try {
    const { alerts, lines } = await tick(io);
    for (const line of lines) io.stdout.write(`${line}\n`);
    const failed = await forward(io, alerts);
    if (failed > 0)
      throw new Error(`${failed} alert line(s) could not be posted to chat`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `sector rotation tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
