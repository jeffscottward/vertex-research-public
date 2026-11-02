// Price alert tick client for the scheduler (user systemd timer, not enabled by default).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:alerts:tick
// It calls priceAlerts.tick with an operator agent WRITE key. The procedure evaluates a bounded batch
// of every owner's active price alerts against public Yahoo quotes and sends fixed-text ntfy
// notifications. Research only: no orders. This client sends one HTTP request to Vertex and nothing
// else; the key is never printed.

export type PriceAlertTickIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

const required = (
  env: PriceAlertTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const tick = async (io: PriceAlertTickIo): Promise<string> => {
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const response = await io.post(`${origin}/api/orpc/priceAlerts/tick`, {
    body: JSON.stringify({ json: {} }),
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
      `priceAlerts.tick returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  const body = JSON.parse(text) as { json?: unknown };
  return JSON.stringify(body.json ?? null);
};

/** Runs one tick and returns the process exit code (0 on success). */
export const runPriceAlertTick = async (
  io: PriceAlertTickIo
): Promise<number> => {
  try {
    io.stdout.write(`${await tick(io)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `price alert tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
