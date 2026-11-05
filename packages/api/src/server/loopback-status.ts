import type { DeployStatusFetch } from "./deploy-status.ts";
import { readCappedText } from "./portfolio-monitor.ts";

// Reader for the rig status files on the Vertex host's loopback file server
// (vertex-engine-status.service, 127.0.0.1:3462). The rig writes them through a
// forced-command SSH key (infra/rig/engine-status). Used by engines.status
// (status.json) and marketContext.get (markets.json).

const LOOPBACK_STATUS_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
};

export type LoopbackStatusErrorCode =
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR";

export class LoopbackStatusError extends Error {
  code: LoopbackStatusErrorCode;
  constructor(code: LoopbackStatusErrorCode, message: string) {
    super(message);
    this.name = "LoopbackStatusError";
    this.code = code;
  }
}

export type LoopbackStatusOptions = Readonly<{
  fetch?: DeployStatusFetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

// One status file: `label` starts the error messages ("Engine status ..."),
// `missing` is the message for HTTP 404 (nothing pushed yet).
export type LoopbackStatusFile = Readonly<{
  label: string;
  envName: string;
  file: string;
  maxBytes: number;
  missing: string;
}>;

export const loopbackStatusUrl = (
  base: string | null,
  source: LoopbackStatusFile
): string => {
  if (base === null || base === "")
    throw new LoopbackStatusError(
      "NOT_CONFIGURED",
      `${source.label} not configured (${source.envName})`
    );
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new LoopbackStatusError(
      "NOT_CONFIGURED",
      `${source.envName} is not a valid URL`
    );
  }
  if (
    parsed.protocol !== "http:" ||
    LOOPBACK_HOSTS[parsed.hostname] !== true ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new LoopbackStatusError(
      "NOT_CONFIGURED",
      `${source.envName} must be a plain loopback http URL`
    );
  return new URL(`/${source.file}`, parsed.origin).toString();
};

// GET the file and parse it as JSON. The caller validates the shape.
export const fetchLoopbackStatus = async (
  base: string | null,
  source: LoopbackStatusFile,
  options: LoopbackStatusOptions = {}
): Promise<unknown> => {
  const url = loopbackStatusUrl(base, source);
  const doFetch: DeployStatusFetch =
    options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LOOPBACK_STATUS_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new LoopbackStatusError(
        "UNAVAILABLE",
        `${source.label} service did not answer`
      );
    }
    if (response.status === 404)
      throw new LoopbackStatusError("UNAVAILABLE", source.missing);
    if (response.status !== 200)
      throw new LoopbackStatusError(
        "UPSTREAM_ERROR",
        `${source.label} service returned HTTP ${response.status}`
      );
    const text = await readCappedText(
      response,
      source.maxBytes,
      (message) => new LoopbackStatusError("UPSTREAM_ERROR", message)
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LoopbackStatusError(
        "UPSTREAM_ERROR",
        `${source.label} file is not valid JSON`
      );
    }
  } finally {
    clearTimeout(timer);
  }
};

type LoopbackStatusErrorFactories = Readonly<
  Record<LoopbackStatusErrorCode, (options?: { message?: string }) => Error>
>;

// Procedure helper: map a reader failure to the contract's typed errors.
export const toLoopbackStatusProcedureError = (
  error: unknown,
  errors: unknown,
  fallback: string
): Error => {
  const failures = errors as LoopbackStatusErrorFactories;
  return error instanceof LoopbackStatusError
    ? failures[error.code]({ message: error.message })
    : failures.UPSTREAM_ERROR({ message: fallback });
};
