// Autopilot tick client for the scheduler (user systemd timer on the research host).
// Usage: VERTEX_ORIGIN=http://vertex.localhost VERTEX_AGENT_API_KEY=... bun run vertex:autopilot:tick [-- <campaign id>]
// It calls autopilot.campaigns.tick with an operator agent WRITE key. Each running campaign then
// breeds and gates strategy candidates for one time slice on stored bars (research only). The
// client sends one HTTP request to Vertex and nothing else; the key is never printed.

export type AutopilotTickIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

const required = (
  env: AutopilotTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

/** Runs one tick and returns the process exit code (0 on success). */
export const runAutopilotTick = async (
  argv: readonly string[],
  io: AutopilotTickIo
): Promise<number> => {
  try {
    const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
    const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
    const [id] = argv;
    const response = await io.post(
      `${origin}/api/orpc/autopilot/campaigns/tick`,
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
        `autopilot tick returned HTTP ${response.status}: ${text.slice(0, 300)}`
      );
    const body = JSON.parse(text) as { json?: unknown };
    io.stdout.write(`${JSON.stringify(body.json ?? null)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(
      `autopilot tick failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
