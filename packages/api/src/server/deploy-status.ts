import {
  DEPLOY_STALE_AFTER_SECONDS,
  DeployUpstreamStatusSchema,
  DeployUpstreamStatusV2Schema,
  type DeployServiceStatusOutput,
  type DeployUpstreamStatus,
  type DeploymentStatusOutput,
} from "../contracts/agent-ops.ts";
import type { DeployStatusConfig } from "./service-config.ts";

export type { DeployStatusConfig } from "./service-config.ts";

// Bounded, read-only fetch of the QuantVPS deployment status document (vertex-deploy-status-v1).
// GET only, bearer token in the Authorization header, 5 s timeout, 64 KiB cap, redirects never
// followed, strict schema parse. Error messages never include the token, URL credentials or body text.

const DEPLOY_STATUS_FETCH_TIMEOUT_MS = 5000;
const DEPLOY_STATUS_MAX_BYTES = 64 * 1024;
const DEPLOY_STATUS_TOKEN_MIN = 32;
// The tailnet v2 snapshot carries session blocks; the collector keeps it under 60 KiB but may reach 256 KiB.
const DEPLOY_STATUS_V2_MAX_BYTES = 256 * 1024;

export class DeployStatusNotConfiguredError extends Error {
  constructor() {
    super("Deployment status endpoint not configured");
    this.name = "DeployStatusNotConfiguredError";
  }
}

export class DeployStatusUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployStatusUpstreamError";
  }
}

export type DeployStatusFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export type FetchDeployStatusOptions = Readonly<{
  fetch?: DeployStatusFetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}>;

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export type ResolveDeployStatusOptions = Readonly<{
  // Also accept plain http on a loopback host. For services on the same host as the web app
  // (QuantVPS history and portfolio), whose tailnet route only admits the rig.
  allowLoopbackHttp?: boolean;
}>;

const isAllowedProtocol = (
  parsed: URL,
  options: ResolveDeployStatusOptions
): boolean =>
  parsed.protocol === "https:" ||
  (options.allowLoopbackHttp === true &&
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(parsed.hostname));

// Both values must be present and the URL must be https without credentials (or loopback http when
// allowed); anything else is "not configured".
export const resolveDeployStatusConfig = (
  url: string | undefined,
  token: string | undefined,
  options: ResolveDeployStatusOptions = {}
): DeployStatusConfig | null => {
  if (url === undefined || token === undefined) return null;
  const trimmedUrl = url.trim();
  const trimmedToken = token.trim();
  if (trimmedUrl === "" || trimmedToken.length < DEPLOY_STATUS_TOKEN_MIN)
    return null;
  try {
    const parsed = new URL(trimmedUrl);
    if (
      !isAllowedProtocol(parsed, options) ||
      parsed.username !== "" ||
      parsed.password !== ""
    )
      return null;
  } catch {
    return null;
  }
  return Object.freeze({ url: trimmedUrl, token: trimmedToken });
};

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new DeployStatusUpstreamError("Status response exceeds the size cap");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DeployStatusUpstreamError(
        "Status response exceeds the size cap"
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DeployStatusUpstreamError("Status response is not valid UTF-8");
  }
};

export const deployAgeSeconds = (generatedAt: string, now: Date): number => {
  return Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(generatedAt)) / 1000)
  );
};

export const isDeployStatusStale = (ageSeconds: number): boolean => {
  return ageSeconds > DEPLOY_STALE_AFTER_SECONDS;
};

const toDeployServiceStatus = (
  service: DeployUpstreamStatus["services"][number]
): DeployServiceStatusOutput => {
  if (!service.present) {
    return {
      service: service.service,
      present: false,
      status: null,
      running: false,
      health: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      restartCount: null,
      oomKilled: false,
      image: null,
      log: null,
    };
  }
  return {
    service: service.service,
    present: true,
    status: service.status,
    running: service.running,
    health: service.health,
    startedAt: service.startedAt,
    finishedAt: service.finishedAt,
    exitCode: service.exitCode,
    restartCount: service.restartCount,
    oomKilled: service.oomKilled,
    image: service.image,
    log: service.log === undefined ? null : { ...service.log },
  };
};

// Parses an upstream document into the procedure output. Throws DeployStatusUpstreamError on schema drift.
export const toDeploymentStatus = (
  raw: unknown,
  fetchedAt: Date
): DeploymentStatusOutput => {
  const parsed = DeployUpstreamStatusSchema.safeParse(raw);
  if (!parsed.success)
    throw new DeployStatusUpstreamError(
      "Status response failed schema validation"
    );
  const document = parsed.data;
  const ageSeconds = deployAgeSeconds(document.generatedAt, fetchedAt);
  return {
    configured: true,
    fetchedAt: fetchedAt.toISOString(),
    source: {
      host: document.host,
      generatedAt: document.generatedAt,
      ageSeconds,
      stale: isDeployStatusStale(ageSeconds),
    },
    services: document.services.map(toDeployServiceStatus),
  };
};

const fetchDeployDocument = async (
  config: DeployStatusConfig,
  options: FetchDeployStatusOptions,
  defaultMaxBytes: number
): Promise<unknown> => {
  const doFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEPLOY_STATUS_FETCH_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(config.url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
        },
        // workerd rejects redirect "error"; "manual" returns 3xx as-is and the status check refuses it.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new DeployStatusUpstreamError(
        controller.signal.aborted
          ? "Status request timed out"
          : "Status request failed"
      );
    }
    if (response.status !== 200)
      throw new DeployStatusUpstreamError(
        `Status endpoint returned HTTP ${response.status}`
      );
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(contentType))
      throw new DeployStatusUpstreamError(
        "Status endpoint returned an unexpected content type"
      );
    let body: string;
    try {
      body = await readCapped(response, options.maxBytes ?? defaultMaxBytes);
    } catch (error) {
      if (error instanceof DeployStatusUpstreamError) throw error;
      throw new DeployStatusUpstreamError(
        controller.signal.aborted
          ? "Status request timed out"
          : "Status response could not be read"
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new DeployStatusUpstreamError("Status response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
};

export const fetchDeploymentStatus = async (
  config: DeployStatusConfig | null,
  options: FetchDeployStatusOptions = {}
): Promise<DeploymentStatusOutput> => {
  if (config === null) throw new DeployStatusNotConfiguredError();
  const raw = await fetchDeployDocument(
    config,
    options,
    DEPLOY_STATUS_MAX_BYTES
  );
  return toDeploymentStatus(raw, (options.now ?? (() => new Date()))());
};

// Parses a v2 document: v1 fields plus the session blocks. Throws DeployStatusUpstreamError on schema drift.
export const toDeploymentStatusV2 = (
  raw: unknown,
  fetchedAt: Date
): DeploymentStatusOutput => {
  const parsed = DeployUpstreamStatusV2Schema.safeParse(raw);
  if (!parsed.success)
    throw new DeployStatusUpstreamError(
      "Snapshot response failed schema validation"
    );
  const document = parsed.data;
  const ageSeconds = deployAgeSeconds(document.generatedAt, fetchedAt);
  return {
    configured: true,
    fetchedAt: fetchedAt.toISOString(),
    source: {
      host: document.host,
      generatedAt: document.generatedAt,
      ageSeconds,
      stale: isDeployStatusStale(ageSeconds),
    },
    services: document.services.map(toDeployServiceStatus),
    session: document.session,
    positions: document.positions,
    orders: document.orders,
    fills: document.fills,
    equity: document.equity,
    risk: document.risk,
    logs: document.logs,
  };
};

const SNAPSHOT_ERROR_PREFIX = "Tailnet snapshot unavailable: ";

// v2 (tailnet) first when configured; on any v2 failure fall back to v1 and report why in snapshotError.
// The v2 fetch alone gets the 256 KiB cap; same GET/timeout/no-redirect rules as v1.
export const fetchDeploymentSnapshot = async (
  v1: DeployStatusConfig | null,
  v2: DeployStatusConfig | null,
  options: FetchDeployStatusOptions = {}
): Promise<DeploymentStatusOutput> => {
  if (v2 === null) return fetchDeploymentStatus(v1, options);
  let reason: string;
  try {
    const raw = await fetchDeployDocument(
      v2,
      { ...options, maxBytes: options.maxBytes ?? DEPLOY_STATUS_V2_MAX_BYTES },
      DEPLOY_STATUS_V2_MAX_BYTES
    );
    return toDeploymentStatusV2(raw, (options.now ?? (() => new Date()))());
  } catch (error) {
    reason =
      error instanceof DeployStatusUpstreamError
        ? error.message
        : "Snapshot request failed";
  }
  if (v1 === null)
    throw new DeployStatusUpstreamError(`${SNAPSHOT_ERROR_PREFIX}${reason}`);
  const fallback = await fetchDeploymentStatus(v1, options);
  return { ...fallback, snapshotError: `${SNAPSHOT_ERROR_PREFIX}${reason}` };
};
