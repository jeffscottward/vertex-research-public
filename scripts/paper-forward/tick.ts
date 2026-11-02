// Paper forward tick client for the scheduler (user systemd timer).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:paper:tick [-- <monitor id>]
// It calls backtestRuns.drift.paperTick with an operator agent WRITE key. The procedure runs the
// baseline strategy on new stored bars in paper mode only (simulated fills, no broker calls).
// This client sends one HTTP request to Vertex and nothing else; the key is never printed.

export type TickIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

const required = (
  env: TickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const tick = async (argv: readonly string[], io: TickIo): Promise<string> => {
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const [id] = argv;
  const response = await io.post(
    `${origin}/api/orpc/backtestRuns/drift/paperTick`,
    {
      body: JSON.stringify({ json: id === undefined ? {} : { id } }),
      headers: {
        "content-type": "application/json",
        origin,
        "x-api-key": apiKey,
      },
      method: "POST",
    }
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `paperTick returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  const body = JSON.parse(text) as { json?: unknown };
  return JSON.stringify(body.json ?? null);
};

/** Runs one tick and returns the process exit code (0 on success). */
export const runPaperForwardTick = async (
  argv: readonly string[],
  io: TickIo
): Promise<number> => {
  try {
    io.stdout.write(`${await tick(argv, io)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `paper forward tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
