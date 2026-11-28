import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REDIRECT_TARGET_PATH = "/__workerd-redirect-target";

const WranglerConfigSchema = z.object({
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibility_flags: z.array(z.string().min(1)).default([]),
});

const WorkerdModuleSchema = z.object({
  default: z.string().min(1),
  version: z.string().min(1),
});

const ControlMessageSchema = z.object({
  event: z.string(),
  port: z.number().int().positive().optional(),
  socket: z.string().optional(),
});

const ReplayWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    body: z.string(),
    headers: z.record(z.string(), z.string()),
    ok: z.literal(true),
    redirected: z.boolean(),
    status: z.number().int(),
  }),
  z.object({
    message: z.string(),
    name: z.string(),
    ok: z.literal(false),
  }),
]);

export type WorkerdConfig = Readonly<{
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
}>;

export type WorkerdBinaryInfo = Readonly<{
  binaryPath: string;
  version: string;
}>;

export type SerializedFetchCall = Readonly<{
  init: Readonly<Record<string, unknown>>;
  method: string;
  originalUrl: string;
  signalAborted: boolean;
  targetUrl: string;
  viaRequest: boolean;
  withSignal: boolean;
}>;

export type LoopbackResponseConfig = Readonly<{
  body?: string;
  headers?: Readonly<Record<string, string>>;
  mode: "200" | "302";
  status?: number;
}>;

export type ReplayRecord = Readonly<{
  followedRedirect: boolean;
  init: Readonly<Record<string, unknown>>;
  method: string;
  originalUrl: string;
  responseStatus: number | null;
  serverHits: number;
  viaRequest: boolean;
  withSignal: boolean;
  workerdError: Readonly<{ message: string; name: string }> | null;
}>;

export type AdapterReplayHandle = Readonly<{
  fetch: typeof globalThis.fetch;
  records: readonly ReplayRecord[];
}>;

export type WorkerdReplayHarness = Readonly<{
  close: () => Promise<void>;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  createAdapterFetch: () => AdapterReplayHandle;
  loopbackOrigin: string;
  replayRaw: (
    path: string,
    init: Readonly<Record<string, unknown>>,
    options?: Readonly<{ viaRequest?: boolean; withSignal?: boolean }>
  ) => Promise<ReplayRecord>;
  setLoopbackResponse: (config: LoopbackResponseConfig) => void;
  workerdVersion: string;
}>;

export type WorkerdReplayHarnessOptions = Readonly<{
  binaryPath?: string;
  webPackageJsonPath?: string;
  wranglerConfigPath?: string;
}>;

/** Reads compatibility_date and compatibility_flags from apps/web/wrangler.jsonc. */
export const readWorkerdConfig = (configPath: string): WorkerdConfig => {
  const parsed: unknown = parseJsonc(readFileSync(configPath, "utf8"));
  const result = WranglerConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid wrangler config at ${configPath}: ${result.error.message}`
    );
  }
  return Object.freeze({
    compatibilityDate: result.data.compatibility_date,
    compatibilityFlags: Object.freeze([...result.data.compatibility_flags]),
  });
};

/** Resolves the pinned workerd binary through apps/web -> wrangler -> miniflare -> workerd. */
export const resolveWorkerdBinary = (
  webPackageJsonPath: string
): WorkerdBinaryInfo => {
  const fromWeb = createRequire(webPackageJsonPath);
  const fromWrangler = createRequire(fromWeb.resolve("wrangler/package.json"));
  const fromMiniflare = createRequire(
    fromWrangler.resolve("miniflare/package.json")
  );
  const workerdModule: unknown = fromMiniflare("workerd");
  const parsed = WorkerdModuleSchema.safeParse(workerdModule);
  if (!parsed.success) {
    throw new Error(`Invalid workerd module export: ${parsed.error.message}`);
  }
  return Object.freeze({
    binaryPath: parsed.data.default,
    version: parsed.data.version,
  });
};

export const normalizeBody = (body: BodyInit): string => {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  throw new Error("Unsupported fetch body type for workerd replay");
};

const copyExtraInitFields = (
  target: Record<string, unknown>,
  init: RequestInit | undefined,
  skipKeys: Readonly<Record<string, true>>
): { signalAborted: boolean; withSignal: boolean } => {
  let withSignal = false;
  let signalAborted = false;
  if (init === undefined) return { signalAborted, withSignal };
  for (const [key, value] of Object.entries(init)) {
    if (value === undefined) continue;
    if (key === "signal") {
      withSignal = value !== null;
      signalAborted = value instanceof AbortSignal && value.aborted;
      continue;
    }
    if (Object.hasOwn(skipKeys, key)) continue;
    if (key === "headers") {
      target["headers"] = Object.fromEntries(
        new Headers(value as HeadersInit).entries()
      );
      continue;
    }
    if (key === "body") {
      if (value !== null) target["body"] = normalizeBody(value as BodyInit);
      continue;
    }
    target[key] = value;
  }
  return { signalAborted, withSignal };
};

const REQUEST_SKIP_KEYS: Readonly<Record<string, true>> = {
  body: true,
  cache: true,
  credentials: true,
  headers: true,
  integrity: true,
  keepalive: true,
  method: true,
  mode: true,
  redirect: true,
  referrerPolicy: true,
};

const EMPTY_SKIP_KEYS: Readonly<Record<string, true>> = {};

const mergeRequestHeaders = (
  base: Headers,
  override: HeadersInit | undefined
): Record<string, string> => {
  const merged = new Headers(base);
  if (override !== undefined) {
    for (const [key, value] of new Headers(override).entries()) {
      merged.set(key, value);
    }
  }
  return Object.fromEntries(merged.entries());
};

const serializeRequestInput = async (
  input: Request,
  init: RequestInit | undefined,
  rewriteOrigin: string
): Promise<SerializedFetchCall> => {
  const method = init?.method ?? input.method;
  const serializedInit: Record<string, unknown> = {
    credentials: init?.credentials ?? input.credentials,
    headers: mergeRequestHeaders(input.headers, init?.headers),
    integrity: init?.integrity ?? input.integrity,
    keepalive: init?.keepalive ?? input.keepalive,
    method,
    mode: init?.mode ?? input.mode,
    redirect: init?.redirect ?? input.redirect,
    referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
  };
  // Node's Request defaults `.cache` to "default" when omitted; workerd rejects "default".
  // Forward an explicit init.cache verbatim, and forward non-default Request.cache (e.g. "no-store").
  const cache =
    init?.cache ?? (input.cache === "default" ? undefined : input.cache);
  if (cache !== undefined) serializedInit["cache"] = cache;
  if (init?.body !== undefined && init.body !== null) {
    serializedInit["body"] = normalizeBody(init.body);
  } else if (input.body !== null) {
    serializedInit["body"] = await input.clone().text();
  }
  const extra = copyExtraInitFields(serializedInit, init, REQUEST_SKIP_KEYS);
  const parsedUrl = new URL(input.url);
  return Object.freeze({
    init: Object.freeze(serializedInit),
    method,
    originalUrl: input.url,
    signalAborted: extra.signalAborted || input.signal.aborted,
    targetUrl: `${rewriteOrigin}${parsedUrl.pathname}${parsedUrl.search}`,
    viaRequest: true,
    withSignal: true,
  });
};

/** Captures every RequestInit field from fetch(input, init) for replay inside workerd. */
export const serializeFetchCall = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  rewriteOrigin: string
): Promise<SerializedFetchCall> => {
  if (input instanceof Request) {
    return await serializeRequestInput(input, init, rewriteOrigin);
  }
  const originalUrl = String(input);
  const parsedUrl = new URL(originalUrl);
  const serializedInit: Record<string, unknown> = {};
  const extra = copyExtraInitFields(serializedInit, init, EMPTY_SKIP_KEYS);
  const method =
    typeof serializedInit["method"] === "string"
      ? serializedInit["method"]
      : "GET";
  return Object.freeze({
    init: Object.freeze(serializedInit),
    method,
    originalUrl,
    signalAborted: extra.signalAborted,
    targetUrl: `${rewriteOrigin}${parsedUrl.pathname}${parsedUrl.search}`,
    viaRequest: false,
    withSignal: extra.withSignal,
  });
};

/** Builds the workerd Cap'n Proto config pinned to the app's compatibility date/flags and loopback-only outbound. */
export const buildCapnpConfig = (config: WorkerdConfig): string => {
  const flags = config.compatibilityFlags
    .map((flag) => JSON.stringify(flag))
    .join(", ");
  return [
    'using Workerd = import "/workerd/workerd.capnp";',
    "",
    "const config :Workerd.Config = (",
    "  services = [",
    '    (name = "main", worker = .replayWorker),',
    '    (name = "loopback", network = (allow = ["local"])),',
    "  ],",
    '  sockets = [ ( name = "http", address = "127.0.0.1:0", http = (), service = "main" ) ]',
    ");",
    "",
    "const replayWorker :Workerd.Worker = (",
    '  modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],',
    `  compatibilityDate = ${JSON.stringify(config.compatibilityDate)},`,
    `  compatibilityFlags = [${flags}],`,
    '  globalOutbound = "loopback",',
    ");",
    "",
  ].join("\n");
};

const WORKER_SCRIPT = [
  "export default {",
  "  async fetch(request) {",
  "    const payload = await request.json();",
  "    const init = { ...payload.init };",
  "    if (payload.withSignal) {",
  "      init.signal = payload.signalAborted",
  "        ? AbortSignal.abort()",
  "        : AbortSignal.timeout(10000);",
  "    }",
  "    try {",
  "      const response = payload.viaRequest",
  "        ? await fetch(new Request(payload.url, init))",
  "        : await fetch(payload.url, init);",
  "      const body = await response.text();",
  "      return Response.json({",
  "        body,",
  "        headers: Object.fromEntries(response.headers.entries()),",
  "        ok: true,",
  "        redirected: response.redirected,",
  "        status: response.status,",
  "      });",
  "    } catch (error) {",
  "      return Response.json(",
  "        {",
  "          message: error instanceof Error ? error.message : String(error),",
  "          name: error instanceof Error ? error.name : typeof error,",
  "          ok: false,",
  "        },",
  "        { status: 500 }",
  "      );",
  "    }",
  "  },",
  "};",
  "",
].join("\n");

const TEST_FILE =
  /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.(tsx?|jsx?|mjs|mts|cts)$/u;
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|mts|cts)$/u;
const FETCH_CALL = /\bglobalThis\.fetch\b|\b(?:fetch|fetcher|fetchImpl)\s*\(/u;

/** Lists every tracked non-test source file under packages/ and apps/ that calls fetch / fetcher / fetchImpl. */
export const discoverOutboundFetchFiles = (
  repoRoot: string = REPO_ROOT
): readonly string[] => {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--", "packages", "apps"],
    { cwd: repoRoot, encoding: "utf8" }
  )
    .split("\0")
    .filter(
      (file) =>
        file !== "" && SOURCE_EXTENSION.test(file) && !TEST_FILE.test(file)
    );
  return Object.freeze(
    files
      .filter((file) => {
        const stripped = readFileSync(join(repoRoot, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n");
        return FETCH_CALL.test(stripped);
      })
      .sort()
  );
};

const drainRequestBody = async (req: IncomingMessage): Promise<void> => {
  for await (const _chunk of req) {
    // Drain request body before responding so keep-alive sockets stay clean.
  }
};

const waitForListenPort = (
  proc: ChildProcess,
  controlStream: Readable,
  stderrStream: Readable
): Promise<number> => {
  const { promise, reject, resolve } = Promise.withResolvers<number>();
  let buffer = "";
  let stderr = "";
  stderrStream.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    reject(
      new Error(
        `workerd exited before listening (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`
      )
    );
  };
  proc.once("exit", onExit);
  controlStream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line !== "") {
        const parsed = ControlMessageSchema.safeParse(JSON.parse(line));
        if (
          parsed.success &&
          parsed.data.event === "listen" &&
          parsed.data.socket === "http" &&
          parsed.data.port !== undefined
        ) {
          proc.off("exit", onExit);
          resolve(parsed.data.port);
          return;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return promise;
};

const stopProcess = async (proc: ChildProcess): Promise<void> => {
  if (proc.exitCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  proc.once("exit", () => resolve());
  proc.kill("SIGTERM");
  await promise;
};

const closeHttpServer = (server: Server): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
};

type ReplayExecutionResult =
  | Readonly<{
      body: string;
      headers: Readonly<Record<string, string>>;
      ok: true;
      record: ReplayRecord;
      status: number;
    }>
  | Readonly<{
      ok: false;
      record: ReplayRecord;
    }>;

/** Starts a pinned workerd instance plus a loopback 200/302 HTTP target server. */
export const startWorkerdReplayHarness = async (
  options: WorkerdReplayHarnessOptions = {}
): Promise<WorkerdReplayHarness> => {
  const wranglerConfigPath =
    options.wranglerConfigPath ?? join(REPO_ROOT, "apps/web/wrangler.jsonc");
  const webPackageJsonPath =
    options.webPackageJsonPath ?? join(REPO_ROOT, "apps/web/package.json");
  const config = readWorkerdConfig(wranglerConfigPath);
  const binary =
    options.binaryPath === undefined
      ? resolveWorkerdBinary(webPackageJsonPath)
      : { binaryPath: options.binaryPath, version: "custom" };

  let loopbackResponse: LoopbackResponseConfig = { mode: "200" };
  let hitCount = 0;
  let followedRedirectCount = 0;

  const loopbackServer = createServer((req, res) => {
    void drainRequestBody(req).then(() => {
      if (req.url === REDIRECT_TARGET_PATH) {
        followedRedirectCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"redirected":true}');
        return;
      }
      hitCount += 1;
      if (loopbackResponse.mode === "302") {
        res.writeHead(302, {
          location: REDIRECT_TARGET_PATH,
          ...loopbackResponse.headers,
        });
        res.end();
        return;
      }
      res.writeHead(loopbackResponse.status ?? 200, {
        "content-type": "application/json",
        ...loopbackResponse.headers,
      });
      res.end(loopbackResponse.body ?? "{}");
    });
  });
  const listened = Promise.withResolvers<void>();
  loopbackServer.listen(0, "127.0.0.1", () => listened.resolve());
  await listened.promise;
  const loopbackPort = (loopbackServer.address() as AddressInfo).port;
  const loopbackOrigin = `http://127.0.0.1:${loopbackPort}`;

  const tempDir = mkdtempSync(join(tmpdir(), "vertex-workerd-replay-"));
  const capnpPath = join(tempDir, "config.capnp");
  writeFileSync(join(tempDir, "worker.mjs"), WORKER_SCRIPT);
  writeFileSync(capnpPath, buildCapnpConfig(config));

  const proc = spawn(
    binary.binaryPath,
    ["serve", "--control-fd=3", capnpPath],
    {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    }
  );
  const controlStream = proc.stdio[3] as Readable;
  const stderrStream = proc.stderr as Readable;

  let workerdPort: number;
  try {
    workerdPort = await waitForListenPort(proc, controlStream, stderrStream);
  } catch (error) {
    await stopProcess(proc);
    await closeHttpServer(loopbackServer);
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  const workerdUrl = `http://127.0.0.1:${workerdPort}/`;

  const executeReplay = async (
    call: SerializedFetchCall
  ): Promise<ReplayExecutionResult> => {
    const hitsBefore = hitCount;
    const redirectsBefore = followedRedirectCount;
    const raw = await globalThis.fetch(workerdUrl, {
      body: JSON.stringify({
        init: call.init,
        signalAborted: call.signalAborted,
        url: call.targetUrl,
        viaRequest: call.viaRequest,
        withSignal: call.withSignal,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const parsed = ReplayWorkerResponseSchema.parse(await raw.json());
    const serverHits = hitCount - hitsBefore;
    const followedRedirect = followedRedirectCount > redirectsBefore;
    if (!parsed.ok) {
      const record: ReplayRecord = Object.freeze({
        followedRedirect,
        init: call.init,
        method: call.method,
        originalUrl: call.originalUrl,
        responseStatus: null,
        serverHits,
        viaRequest: call.viaRequest,
        withSignal: call.withSignal,
        workerdError: Object.freeze({
          message: parsed.message,
          name: parsed.name,
        }),
      });
      return { ok: false, record };
    }
    const record: ReplayRecord = Object.freeze({
      followedRedirect,
      init: call.init,
      method: call.method,
      originalUrl: call.originalUrl,
      responseStatus: parsed.status,
      serverHits,
      viaRequest: call.viaRequest,
      withSignal: call.withSignal,
      workerdError: null,
    });
    return {
      body: parsed.body,
      headers: parsed.headers,
      ok: true,
      record,
      status: parsed.status,
    };
  };

  const createAdapterFetch = (): AdapterReplayHandle => {
    const records: ReplayRecord[] = [];
    const adapterFetch: typeof globalThis.fetch = async (input, init) => {
      const call = await serializeFetchCall(input, init, loopbackOrigin);
      const result = await executeReplay(call);
      records.push(result.record);
      if (!result.ok) {
        const err = result.record.workerdError as Readonly<{
          message: string;
          name: string;
        }>;
        if (err.name === "TypeError") throw new TypeError(err.message);
        throw new Error(`${err.name}: ${err.message}`);
      }
      return new Response(result.body.length === 0 ? null : result.body, {
        headers: result.headers,
        status: result.status,
      });
    };
    return Object.freeze({ fetch: adapterFetch, records });
  };

  const replayRaw = async (
    path: string,
    init: Readonly<Record<string, unknown>>,
    replayOptions: Readonly<{ viaRequest?: boolean; withSignal?: boolean }> = {}
  ): Promise<ReplayRecord> => {
    const targetUrl = `${loopbackOrigin}${path}`;
    const method = typeof init["method"] === "string" ? init["method"] : "GET";
    const result = await executeReplay({
      init,
      method,
      originalUrl: targetUrl,
      signalAborted: false,
      targetUrl,
      viaRequest: replayOptions.viaRequest ?? false,
      withSignal: replayOptions.withSignal ?? false,
    });
    return result.record;
  };

  const close = async (): Promise<void> => {
    await stopProcess(proc);
    await closeHttpServer(loopbackServer);
    rmSync(tempDir, { force: true, recursive: true });
  };

  return Object.freeze({
    close,
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags,
    createAdapterFetch,
    loopbackOrigin,
    replayRaw,
    setLoopbackResponse: (next) => {
      loopbackResponse = next;
    },
    workerdVersion: binary.version,
  });
};
