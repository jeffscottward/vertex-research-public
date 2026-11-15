// Research screen tick client for the scheduler (system timer on QuantVPS, every 5 minutes).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... bun run vertex:research-screen:tick
// It calls researchScreen.tick with an operator agent WRITE key, and calls again at once while the
// answer says that work remains (done: false). The server decides what is due; this client holds no
// calendar and sends no slot. Before each call it checks the pause file of the restart script
// (infra/quantvps/restart-when-idle.sh) and stops while that file is fresh. Research only: no
// orders. The key is never printed.

export type ResearchScreenTickIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  /** Current time in milliseconds. */
  now: () => number;
  /** Age of the file in milliseconds; null when the file does not exist. */
  fileAgeMs: (path: string) => Promise<number | null>;
  /** Commit of the installed bundle; added to every result line when given. */
  sourceSha?: string | undefined;
}>;

const PROCEDURE = "researchScreen/tick";
/** Limit of one call. */
const CALL_TIMEOUT_MS = 200_000;
/** The script starts no new call after this time; the next timer run continues. */
export const WALL_LIMIT_MS = 28 * 60_000;
/** A pause file older than this is ignored (the same limit as the backtest worker). */
export const PAUSE_FILE_MAX_AGE_MS = 90 * 60_000;

/**
 * Reads the commit of the installed bundle from the file SOURCE_SHA beside the running script (the
 * install script writes it). Returns undefined when the file does not exist or is empty.
 */
export const readSourceSha = async (
  scriptUrl: string,
  readText: (file: URL) => Promise<string>
): Promise<string | undefined> => {
  try {
    const sha = (await readText(new URL("./SOURCE_SHA", scriptUrl))).trim();
    return sha === "" ? undefined : sha;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
};

const required = (
  env: ResearchScreenTickIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

const pauseFilePath = (env: ResearchScreenTickIo["env"]): string =>
  env["VERTEX_WORKER_PAUSE_FILE"] ??
  `${env["XDG_STATE_HOME"] ?? `${env["HOME"] ?? ""}/.local/state`}/vertex-nautilus-worker.pause`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const call = async (
  io: ResearchScreenTickIo,
  origin: string,
  apiKey: string
): Promise<Record<string, unknown>> => {
  const response = await io.post(`${origin}/api/orpc/${PROCEDURE}`, {
    body: JSON.stringify({ json: {} }),
    headers: {
      "content-type": "application/json",
      origin,
      "x-api-key": apiKey,
    },
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  const name = PROCEDURE.replaceAll("/", ".");
  if (!response.ok)
    throw new Error(
      `${name} returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  const body: unknown = JSON.parse(text);
  const answer = isRecord(body) ? body["json"] : undefined;
  if (!isRecord(answer)) throw new Error(`${name} returned no result object`);
  return answer;
};

const loop = async (io: ResearchScreenTickIo): Promise<void> => {
  const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
  const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
  const pauseFile = pauseFilePath(io.env);
  const start = io.now();
  for (;;) {
    const age = await io.fileAgeMs(pauseFile);
    if (age !== null && age < PAUSE_FILE_MAX_AGE_MS) {
      io.stdout.write(`${JSON.stringify({ paused: true })}\n`);
      return;
    }
    if (io.now() - start >= WALL_LIMIT_MS) {
      io.stdout.write(`${JSON.stringify({ wallLimit: true })}\n`);
      return;
    }
    const answer = await call(io, origin, apiKey);
    const line =
      io.sourceSha === undefined
        ? answer
        : { ...answer, sourceSha: io.sourceSha };
    io.stdout.write(`${JSON.stringify(line)}\n`);
    if (answer["done"] !== false) return;
  }
};

/**
 * Runs ticks until the server reports no remaining work, the pause file is fresh or the wall limit
 * passes. Returns the process exit code: 0 on success, 2 when a call timed out, 1 on other errors.
 */
export const runResearchScreenTick = async (
  io: ResearchScreenTickIo
): Promise<number> => {
  try {
    await loop(io);
    return 0;
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    io.stderr.write(
      `research screen tick ${timedOut ? "timed out" : "failed"}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return timedOut ? 2 : 1;
  }
};
