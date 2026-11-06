// What: Run this worktree's web app in UI lab mode on 127.0.0.1:<port> and expose it TAILNET ONLY with
// `tailscale serve --bg --https=<serve>` (never Funnel). Prints the demo URL after it answers.
// Usage: bun scripts/vertex-ui/demo.ts --port <local> --serve <tailnetPort> [--host <name>.ts.net] [--no-serve]
// The app gets development-only bindings in apps/web/.dev.vars (git-ignored, mode 0600): VERTEX_UI_LAB=on,
// random per-run auth secrets and a placeholder database (the lab reads no database).
// See: ~/Documents/reports/web/firstmate/vertex-ui-program.md ("Demo server"); docs/vertex-rebuild/ui-lab.md.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

export const DEV_VARS_MARKER = "# vertex-ui-lab demo bindings (generated)";

export class DemoUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoUsageError";
  }
}

export type DemoOptions = Readonly<{
  port: number;
  serve: number | null;
  host: string | null;
}>;

const portValue = (name: string, value: string): number => {
  const port = Number(value);
  if (!/^\d{4,5}$/u.test(value) || port < 1024 || port > 65_535)
    throw new DemoUsageError(`--${name} must be a port from 1024 to 65535`);
  return port;
};

const TAILNET_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/u;

export const parseDemoArgs = (argv: readonly string[]): DemoOptions => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: "string" },
      "no-serve": { default: false, type: "boolean" },
      port: { type: "string" },
      serve: { type: "string" },
    },
    strict: true,
  });
  if (values.port === undefined) throw new DemoUsageError("--port is required");
  const noServe = values["no-serve"];
  if (noServe === (values.serve !== undefined))
    throw new DemoUsageError(
      "Give exactly one of --serve <port> or --no-serve"
    );
  if (values.host !== undefined && !TAILNET_HOST.test(values.host))
    throw new DemoUsageError("--host must be a *.ts.net tailnet name");
  return {
    host: values.host ?? null,
    port: portValue("port", values.port),
    serve: values.serve === undefined ? null : portValue("serve", values.serve),
  };
};

/** The tailnet DNS name from `tailscale status --json` (Self.DNSName without the final dot). */
export const tailnetHostFromStatus = (json: string): string => {
  const status: unknown = JSON.parse(json);
  const self =
    typeof status === "object" && status !== null
      ? Reflect.get(status, "Self")
      : undefined;
  const name =
    typeof self === "object" && self !== null
      ? Reflect.get(self, "DNSName")
      : undefined;
  const host = typeof name === "string" ? name.replace(/\.$/u, "") : "";
  if (!TAILNET_HOST.test(host))
    throw new DemoUsageError("tailscale status has no tailnet DNS name");
  return host;
};

/** Development-only Worker bindings for the lab demo. Secrets are random per run and never printed. */
export const demoBindings = (origin: string, secret: () => string): string =>
  [
    DEV_VARS_MARKER,
    "APP_ENV=development",
    `APP_URL=${origin}`,
    `BETTER_AUTH_URL=${origin}`,
    "DATABASE_PROVIDER=postgres",
    // Nothing listens on port 1: the lab must not need a database.
    "DATABASE_URL=postgresql://vertex_ui_lab@127.0.0.1:1/vertex_ui_lab_demo",
    `BETTER_AUTH_SECRET=${secret()}`,
    `CONTACT_THROTTLE_SECRET=${secret()}`,
    "EMAIL_PROVIDER=disabled",
    "EMAIL_TRANSPORT=disabled",
    "VERTEX_UI_LAB=on",
    "",
  ].join("\n");

export type DemoChild = Readonly<{
  exited: Promise<number | null>;
  kill: (signal: NodeJS.Signals) => void;
}>;

export type DemoDependencies = Readonly<{
  repositoryRoot: string;
  readText: (path: string) => Promise<string | null>;
  writePrivate: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  tailscale: (arguments_: readonly string[]) => Promise<string>;
  startServer: (
    webDirectory: string,
    environment: Readonly<Record<string, string>>
  ) => DemoChild;
  status: (url: string) => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  secret: () => string;
  baseEnvironment: Readonly<Record<string, string | undefined>>;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  log: (line: string) => void;
}>;

/** Polls `url` until it answers 200; false after `attempts`. */
export const waitForOk = async (
  url: string,
  dependencies: Pick<DemoDependencies, "status" | "sleep">,
  attempts = 150,
  intervalMs = 2000
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await dependencies.status(url)) === 200) return true;
    await dependencies.sleep(intervalMs);
  }
  return false;
};

type ServerPlan = Readonly<{
  host: string;
  origin: string;
  webDirectory: string;
}>;

/** Runs the dev server (and the tailnet serve) until the server exits. */
const runServer = async (
  options: DemoOptions,
  dependencies: DemoDependencies,
  { host, origin, webDirectory }: ServerPlan
): Promise<number> => {
  const pick = (name: string): Record<string, string> => {
    const value = dependencies.baseEnvironment[name];
    return value === undefined ? {} : { [name]: value };
  };
  const child = dependencies.startServer(webDirectory, {
    ...pick("PATH"),
    ...pick("HOME"),
    ...pick("TMPDIR"),
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host,
    BROWSER: "none",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    HOST: "127.0.0.1",
    NO_COLOR: "1",
    NODE_ENV: "development",
    PORT: String(options.port),
    WRANGLER_SEND_METRICS: "false",
  });
  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    await child.exited;
  };
  // SIGHUP too: `tmux kill-session` sends it, and the cleanup below (serve off,
  // bindings removed) must still run after the server exits.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    dependencies.onSignal(signal, () => child.kill(signal));
  const local = `http://127.0.0.1:${options.port}/lab`;
  if (!(await waitForOk(local, dependencies))) {
    dependencies.log(`The lab did not answer on ${local}`);
    await stop();
    return 1;
  }
  dependencies.log(`Local lab: ${local}`);
  if (options.serve === null) return (await child.exited) ?? 1;
  try {
    await dependencies.tailscale([
      "serve",
      "--bg",
      `--https=${options.serve}`,
      `http://127.0.0.1:${options.port}`,
    ]);
  } catch (error) {
    // No tailnet route: do not leave the dev server running.
    await stop();
    throw error;
  }
  // `--bg` outlives this process: always remove the serve, so the tailnet port never
  // forwards to whatever binds the local port later.
  try {
    const demo = `${origin}/lab`;
    if (!(await waitForOk(demo, dependencies, 15))) {
      dependencies.log(`The tailnet URL did not answer: ${demo}`);
      await stop();
      return 1;
    }
    dependencies.log(`Demo (tailnet only): ${demo}`);
    return (await child.exited) ?? 1;
  } finally {
    await dependencies.tailscale(["serve", `--https=${options.serve}`, "off"]);
    dependencies.log(`Tailnet serve removed: ${origin}`);
  }
};

/** Starts the demo; resolves with the server's exit code. */
export const runDemo = async (
  options: DemoOptions,
  dependencies: DemoDependencies
): Promise<number> => {
  const host =
    options.host ??
    tailnetHostFromStatus(await dependencies.tailscale(["status", "--json"]));
  const origin =
    options.serve === null
      ? `http://127.0.0.1:${options.port}`
      : `https://${host}:${options.serve}`;
  const webDirectory = join(dependencies.repositoryRoot, "apps/web");
  const devVars = join(webDirectory, ".dev.vars");
  const existing = await dependencies.readText(devVars);
  if (existing !== null && !existing.startsWith(DEV_VARS_MARKER))
    throw new DemoUsageError(
      "apps/web/.dev.vars exists and was not written by this demo; move it away first"
    );
  await dependencies.writePrivate(
    devVars,
    demoBindings(origin, dependencies.secret)
  );
  try {
    return await runServer(options, dependencies, {
      host,
      origin,
      webDirectory,
    });
  } finally {
    // The bindings hold per-run secrets: never leave them behind.
    await dependencies.removeFile(devVars);
  }
};

const run = promisify(execFile);

export type DemoCommands = Readonly<{
  tailscale: string;
  /** Command and arguments that start the web dev server in apps/web. */
  server: readonly [string, ...string[]];
}>;

const DEFAULT_DEMO_COMMANDS: DemoCommands = {
  server: ["bunx", "--no-install", "vinext", "dev"],
  tailscale: "tailscale",
};

/** Real dependencies for the CLI. */
export const createDemoDependencies = (
  repositoryRoot: string,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  onSignal: DemoDependencies["onSignal"],
  commands: DemoCommands
): DemoDependencies => ({
  baseEnvironment,
  log,
  onSignal,
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  removeFile: (path) => rm(path, { force: true }),
  repositoryRoot,
  secret: () => randomBytes(32).toString("base64url"),
  sleep: (ms) => {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    setTimeout(done, ms);
    return promise;
  },
  startServer: (webDirectory, environment) => {
    const [command, ...arguments_] = commands.server;
    const child: ChildProcess = spawn(command, arguments_, {
      cwd: webDirectory,
      env: environment,
      stdio: "inherit",
    });
    const exited = Promise.withResolvers<number | null>();
    child.once("error", () => exited.resolve(1));
    child.once("exit", exited.resolve);
    return { exited: exited.promise, kill: (signal) => child.kill(signal) };
  },
  status: async (url) => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(30_000) })).status;
    } catch {
      return null;
    }
  },
  tailscale: async (arguments_) =>
    (await run(commands.tailscale, [...arguments_])).stdout,
  writePrivate: (path, content) =>
    writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
});

export interface OutputStream {
  readonly write: (text: string) => unknown;
}

export type DemoEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  repositoryRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
  stdout: OutputStream;
  stderr: OutputStream;
  exitState: { exitCode?: number | string | null | undefined };
  onSignal: DemoDependencies["onSignal"];
  commands?: DemoCommands;
}>;

/** CLI entry: runs only when this module is the process entry point. */
export const runDemoEntrypoint = async ({
  isMain,
  argv,
  repositoryRoot,
  environment,
  stdout,
  stderr,
  exitState,
  onSignal,
  commands = DEFAULT_DEMO_COMMANDS,
}: DemoEntrypoint): Promise<void> => {
  if (!isMain) return;
  try {
    exitState.exitCode = await runDemo(
      parseDemoArgs(argv.slice(2)),
      createDemoDependencies(
        repositoryRoot,
        environment,
        (line) => stdout.write(`${line}\n`),
        onSignal,
        commands
      )
    );
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitState.exitCode = error instanceof DemoUsageError ? 2 : 1;
  }
};

await runDemoEntrypoint({
  argv: process.argv,
  environment: process.env,
  exitState: process,
  isMain: import.meta.main,
  onSignal: process.on.bind(process),
  repositoryRoot: resolve(import.meta.dirname, "../.."),
  stderr: process.stderr,
  stdout: process.stdout,
});
