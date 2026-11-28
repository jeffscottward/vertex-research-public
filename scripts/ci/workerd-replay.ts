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
import ts from "typescript-api";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REDIRECT_TARGET_PATH = "/__workerd-redirect-target";
const REPLAY_PATH_PREFIX = "/__r/";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 3000;

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
  listenHost?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  webPackageJsonPath?: string;
  wranglerConfigPath?: string;
}>;

// Tracks explicit `cache` passed to `new Request(input, init)` while running under
// `withCapturedRequestCache`, so `new Request(url, { cache: "default" })` is distinguished
// from omitting `cache` (Node exposes `.cache === "default"` for both, while workerd rejects
// explicit `cache: "default"`).
const explicitRequestCache = new WeakMap<Request, RequestCache>();

const attachCloneCachePropagation = (
  request: Request,
  cache: RequestCache
): void => {
  explicitRequestCache.set(request, cache);
  const originalClone = request.clone.bind(request);
  Object.defineProperty(request, "clone", {
    configurable: true,
    value: (): Request => {
      const cloned = originalClone();
      attachCloneCachePropagation(cloned, cache);
      return cloned;
    },
  });
};

/** Runs an async operation while tracking explicit `cache` options passed to `new Request(...)`. */
export const withCapturedRequestCache = async <T>(
  operation: () => Promise<T>
): Promise<T> => {
  const OriginalRequest = globalThis.Request;
  const TrackedRequest = new Proxy(OriginalRequest, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget) as Request;
      const input = args[0] as unknown;
      const init = args[1] as RequestInit | undefined;
      const explicit =
        init?.cache ??
        (input instanceof OriginalRequest
          ? explicitRequestCache.get(input)
          : undefined);
      if (explicit !== undefined) {
        attachCloneCachePropagation(instance, explicit);
      }
      return instance;
    },
  });
  globalThis.Request = TrackedRequest;
  try {
    return await operation();
  } finally {
    globalThis.Request = OriginalRequest;
  }
};

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
  referrer: true,
  referrerPolicy: true,
};

const EMPTY_SKIP_KEYS: Readonly<Record<string, true>> = {};

const serializeRequestInput = async (
  input: Request,
  init: RequestInit | undefined,
  rewriteOrigin: string,
  pathPrefix: string
): Promise<SerializedFetchCall> => {
  const method = init?.method ?? input.method;
  // Fetch spec: init.headers replaces input.headers rather than merging onto them.
  const headers = Object.fromEntries(
    new Headers(
      init?.headers === undefined ? input.headers : init.headers
    ).entries()
  );
  const serializedInit: Record<string, unknown> = {
    credentials: init?.credentials ?? input.credentials,
    headers,
    integrity: init?.integrity ?? input.integrity,
    keepalive: init?.keepalive ?? input.keepalive,
    method,
    mode: init?.mode ?? input.mode,
    redirect: init?.redirect ?? input.redirect,
    referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
  };
  const cache =
    init?.cache ??
    explicitRequestCache.get(input) ??
    (input.cache === "default" ? undefined : input.cache);
  if (cache !== undefined) serializedInit["cache"] = cache;
  const referrer =
    init?.referrer ??
    (input.referrer === "about:client" ? undefined : input.referrer);
  if (referrer !== undefined) serializedInit["referrer"] = referrer;
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
    targetUrl: `${rewriteOrigin}${pathPrefix}${parsedUrl.pathname}${parsedUrl.search}`,
    viaRequest: true,
    withSignal: true,
  });
};

/** Captures every RequestInit field from fetch(input, init) for replay inside workerd. */
export const serializeFetchCall = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  rewriteOrigin: string,
  pathPrefix = ""
): Promise<SerializedFetchCall> => {
  if (input instanceof Request) {
    return await serializeRequestInput(input, init, rewriteOrigin, pathPrefix);
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
    targetUrl: `${rewriteOrigin}${pathPrefix}${parsedUrl.pathname}${parsedUrl.search}`,
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
const FETCH_CALLEES: Readonly<Record<string, true>> = {
  fetch: true,
  fetcher: true,
  fetchImpl: true,
  fetchRequest: true,
};
const GLOBAL_FETCH_HOSTS: Readonly<Record<string, true>> = {
  global: true,
  globalThis: true,
  self: true,
  window: true,
};
const HTTP_SDK_CONSTRUCTORS: Readonly<Record<string, true>> = {
  Groq: true,
  Resend: true,
};

/** AST check for runtime fetch/fetcher/fetchImpl/fetchRequest calls, global fetch references, or HTTP SDK constructors. */
export const sourceHasOutboundFetch = (
  filePath: string,
  source: string
): boolean => {
  if (!/(?:fetch|Resend|Groq)/u.test(source)) return false;
  const scriptKind =
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      Object.hasOwn(GLOBAL_FETCH_HOSTS, node.expression.text) &&
      node.name.text === "fetch"
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        (ts.isIdentifier(expr) && Object.hasOwn(FETCH_CALLEES, expr.text)) ||
        (ts.isPropertyAccessExpression(expr) && expr.name.text === "fetch")
      ) {
        found = true;
        return;
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      Object.hasOwn(HTTP_SDK_CONSTRUCTORS, node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/** Lists every tracked non-test source file under packages/ and apps/ with runtime outbound fetch or HTTP SDK calls. */
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
      .filter((file) =>
        sourceHasOutboundFetch(file, readFileSync(join(repoRoot, file), "utf8"))
      )
      .sort()
  );
};

const drainRequestBody = async (req: IncomingMessage): Promise<void> => {
  for await (const _chunk of req) {
    // Drain request body before responding so keep-alive sockets stay clean.
  }
};

const parseReplayId = (requestUrl: string): string => {
  if (requestUrl.startsWith(REPLAY_PATH_PREFIX)) {
    const rest = requestUrl.slice(REPLAY_PATH_PREFIX.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? rest : rest.slice(0, slash);
  }
  const parsed = new URL(requestUrl, "http://127.0.0.1");
  return parsed.searchParams.get("rid") ?? "";
};

const waitForListenPort = (
  proc: ChildProcess,
  controlStream: Readable,
  stderrStream: Readable,
  startupTimeoutMs: number
): Promise<number> => {
  const { promise, reject, resolve } = Promise.withResolvers<number>();
  let buffer = "";
  let stderr = "";
  let controlEndTimer: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    clearTimeout(timer);
    clearTimeout(controlEndTimer);
    proc.off("close", onClose);
    proc.off("error", onError);
    controlStream.off("data", onControlData);
    controlStream.off("end", onControlEnd);
    stderrStream.off("data", onStderrData);
  };

  const fail = (error: Error): void => {
    cleanup();
    reject(error);
  };

  const onStderrData = (chunk: Buffer): void => {
    stderr += chunk.toString("utf8");
  };

  const onError = (error: Error): void => {
    fail(new Error(`workerd failed to spawn: ${error.message}`));
  };

  const onClose = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    fail(
      new Error(
        `workerd exited before listening (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`
      )
    );
  };

  const onControlEnd = (): void => {
    // Brief grace window so a dying process delivers its real exit code via `close` first.
    controlEndTimer = setTimeout(() => {
      fail(
        new Error(
          `workerd closed control-fd before listening: ${stderr.trim()}`
        )
      );
    }, 25);
    controlEndTimer.unref();
  };
  const onControlData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line !== "") {
        let rawJson: unknown;
        try {
          rawJson = JSON.parse(line);
        } catch {
          fail(new Error(`workerd emitted malformed control-fd JSON: ${line}`));
          return;
        }
        const parsed = ControlMessageSchema.safeParse(rawJson);
        if (
          parsed.success &&
          parsed.data.event === "listen" &&
          parsed.data.socket === "http" &&
          parsed.data.port !== undefined
        ) {
          cleanup();
          resolve(parsed.data.port);
          return;
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  };

  const timer = setTimeout(() => {
    fail(
      new Error(
        `workerd did not listen within ${startupTimeoutMs}ms: ${stderr.trim()}`
      )
    );
  }, startupTimeoutMs);
  timer.unref();

  stderrStream.on("data", onStderrData);
  proc.once("error", onError);
  proc.once("close", onClose);
  controlStream.on("data", onControlData);
  controlStream.once("end", onControlEnd);

  return promise;
};

const stopProcess = async (
  proc: ChildProcess,
  stopTimeoutMs: number
): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const finish = (): void => {
    clearTimeout(killTimer);
    proc.off("close", finish);
    proc.off("error", finish);
    resolve();
  };
  const killTimer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, stopTimeoutMs);
  killTimer.unref();
  proc.once("close", finish);
  proc.once("error", finish);
  proc.kill("SIGTERM");
  await promise;
};

const closeHttpServer = (server: Server): Promise<void> => {
  if (!server.listening) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.closeAllConnections();
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
  const hostFetch = globalThis.fetch.bind(globalThis);
  const wranglerConfigPath =
    options.wranglerConfigPath ?? join(REPO_ROOT, "apps/web/wrangler.jsonc");
  const webPackageJsonPath =
    options.webPackageJsonPath ?? join(REPO_ROOT, "apps/web/package.json");
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const config = readWorkerdConfig(wranglerConfigPath);
  const binary =
    options.binaryPath === undefined
      ? resolveWorkerdBinary(webPackageJsonPath)
      : { binaryPath: options.binaryPath, version: "custom" };

  let loopbackResponse: LoopbackResponseConfig = { mode: "200" };
  let nextReplaySeq = 0;
  const statsByReplayId = new Map<
    string,
    { followedRedirect: boolean; hits: number }
  >();

  const loopbackServer = createServer((req, res) => {
    void drainRequestBody(req)
      .then(() => {
        const reqUrl = String(req.url);
        const rid = parseReplayId(reqUrl);
        const entry = statsByReplayId.get(rid);
        if (reqUrl.startsWith(REDIRECT_TARGET_PATH)) {
          if (entry !== undefined) entry.followedRedirect = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"redirected":true}');
          return;
        }
        if (entry !== undefined) entry.hits += 1;
        if (loopbackResponse.mode === "302") {
          res.writeHead(302, {
            location: `${REDIRECT_TARGET_PATH}?rid=${encodeURIComponent(rid)}`,
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
      })
      .catch(() => undefined);
  });

  let tempDir: string | null = null;
  let proc: ChildProcess | null = null;

  const cleanupResources = async (): Promise<void> => {
    if (proc !== null) await stopProcess(proc, stopTimeoutMs);
    await closeHttpServer(loopbackServer);
    if (tempDir !== null) rmSync(tempDir, { force: true, recursive: true });
  };

  let loopbackOrigin: string;
  let workerdPort: number;
  try {
    const listened = Promise.withResolvers<void>();
    loopbackServer.once("error", listened.reject);
    loopbackServer.listen(0, options.listenHost ?? "127.0.0.1", () => {
      loopbackServer.off("error", listened.reject);
      listened.resolve();
    });
    await listened.promise;
    const loopbackPort = (loopbackServer.address() as AddressInfo).port;
    loopbackOrigin = `http://127.0.0.1:${loopbackPort}`;

    tempDir = mkdtempSync(join(tmpdir(), "vertex-workerd-replay-"));
    const capnpPath = join(tempDir, "config.capnp");
    writeFileSync(join(tempDir, "worker.mjs"), WORKER_SCRIPT);
    writeFileSync(capnpPath, buildCapnpConfig(config));

    proc = spawn(binary.binaryPath, ["serve", "--control-fd=3", capnpPath], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const controlStream = proc.stdio[3] as Readable;
    const stderrStream = proc.stderr as Readable;
    workerdPort = await waitForListenPort(
      proc,
      controlStream,
      stderrStream,
      startupTimeoutMs
    );
  } catch (error) {
    await cleanupResources();
    throw error;
  }

  const workerdUrl = `http://127.0.0.1:${workerdPort}/`;

  const executeReplay = async (
    replayId: string,
    call: SerializedFetchCall
  ): Promise<ReplayExecutionResult> => {
    const stats = { followedRedirect: false, hits: 0 };
    statsByReplayId.set(replayId, stats);
    try {
      const raw = await hostFetch(workerdUrl, {
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
      if (!parsed.ok) {
        const record: ReplayRecord = Object.freeze({
          followedRedirect: stats.followedRedirect,
          init: call.init,
          method: call.method,
          originalUrl: call.originalUrl,
          responseStatus: null,
          serverHits: stats.hits,
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
        followedRedirect: stats.followedRedirect,
        init: call.init,
        method: call.method,
        originalUrl: call.originalUrl,
        responseStatus: parsed.status,
        serverHits: stats.hits,
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
    } finally {
      statsByReplayId.delete(replayId);
    }
  };

  const createAdapterFetch = (): AdapterReplayHandle => {
    const records: ReplayRecord[] = [];
    const adapterFetch: typeof globalThis.fetch = async (input, init) => {
      const replayId = `r${++nextReplaySeq}`;
      const call = await serializeFetchCall(
        input,
        init,
        loopbackOrigin,
        `${REPLAY_PATH_PREFIX}${replayId}`
      );
      const result = await executeReplay(replayId, call);
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
    const replayId = `r${++nextReplaySeq}`;
    const targetUrl = `${loopbackOrigin}${REPLAY_PATH_PREFIX}${replayId}${path}`;
    const method = typeof init["method"] === "string" ? init["method"] : "GET";
    const result = await executeReplay(replayId, {
      init,
      method,
      originalUrl: `${loopbackOrigin}${path}`,
      signalAborted: false,
      targetUrl,
      viaRequest: replayOptions.viaRequest ?? false,
      withSignal: replayOptions.withSignal ?? false,
    });
    return result.record;
  };

  return Object.freeze({
    close: cleanupResources,
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
