// What: Server-side portal session lookup and safe callback/sign-in URL helpers.
// Used by: apps/web/src/lib/request-portal-session.ts#getPortalSession, apps/web/src/app/(portal)/layout.tsx#portalSignInHref.
// See: docs/debugging.md#symptom--where-to-look (Auth cookie missing or sign-in loops; "portal session check failed" lines).
import {
  CANONICAL_APP_URL,
  isDevelopmentLocalhostHttpOrigin,
} from "@darkfactory/config";
import { isOperatorIdentity } from "@darkfactory/config/server";

import {
  CAPACITY_RETRY_DELAY_MS,
  CAPACITY_RETRY_MAX_ATTEMPTS,
  isCapacityResponse,
} from "./capacity-retry.ts";

export type PortalRole = "member" | "admin";

export interface PortalSession {
  readonly expiresAt: Date;
  /** Same rule as `requireOperator` in packages/api: active, verified, on VERTEX_OPERATOR_EMAILS. */
  readonly isOperator: boolean;
  readonly name: string;
  readonly role: PortalRole;
  readonly status: "active";
  readonly userId: string;
}

export type PortalSessionFetch = (request: Request) => Promise<Response>;

export interface GetPortalSessionOptions {
  readonly cfConnectingIp?: string | null;
  readonly cookieHeader: string | null;
  readonly fetch?: PortalSessionFetch;
  readonly now?: Date;
  /** Parsed VERTEX_OPERATOR_EMAILS; absent or empty means nobody is an operator. */
  readonly operatorEmails?: readonly string[];
  readonly timeoutMs?: number;
}

const MAX_SESSION_RESPONSE_BYTES = 16_384;
const DEFAULT_SESSION_TIMEOUT_MS = 3000;
const PORTAL_PATH_ROOTS = [
  "/dashboard",
  "/research",
  "/assistant",
  "/agents",
  "/papers",
  "/library",
  "/academy",
  "/backtests",
  "/instant-backtest",
  "/setup-replay",
  "/backtest-runs",
  "/backtest-sweeps",
  "/portfolio-combos",
  "/forward-drift",
  "/strategy-builder",
  "/rotation-matrix",
  "/sector-rotation",
  "/deep-value",
  "/congress-trades",
  "/risk-allocator",
  "/markets",
  "/knowledge",
  "/optimizations",
  "/autopilot",
  "/charts",
  "/deployments",
  "/engines",
  "/watchlist",
  "/price-alerts",
  "/news",
  "/calendar",
  "/journal",
  "/baskets",
  "/pick-lists",
  "/plays",
  "/todos",
  "/today",
  "/portfolio",
  "/strategies",
  "/audit",
  "/modules",
  "/connections",
  "/settings",
  // Legacy roots: their pages redirect (to /settings, and /data to /research).
  "/account",
  "/admin",
  "/data",
] as const;
const REQUEST_PATH_HEADERS = [
  "x-pathname",
  "x-invoke-path",
  "next-url",
] as const;

export const resolvePortalAppUrl = (
  configured = process.env["APP_URL"]?.trim(),
  appEnvironment = process.env["APP_ENV"]
): URL => {
  try {
    const url = new URL(configured || CANONICAL_APP_URL);
    if (
      (url.protocol !== "https:" &&
        !isDevelopmentLocalhostHttpOrigin(url, appEnvironment)) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search.length > 0 ||
      url.hash.length > 0
    )
      throw new TypeError(
        "Portal application URL must be a clean HTTPS origin"
      );
    return url;
  } catch {
    throw new TypeError("Portal application URL must be a clean HTTPS origin");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const boundedString = (value: unknown, maximum: number): value is string => {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
};

const isPortalRole = (value: unknown): value is PortalRole => {
  return value === "member" || value === "admin";
};

export const parsePortalSession = (
  value: unknown,
  now = new Date(),
  operatorEmails: readonly string[] = []
): PortalSession | null => {
  if (
    !(isRecord(value) && isRecord(value["user"]) && isRecord(value["session"]))
  ) {
    return null;
  }

  const user = value["user"];
  const session = value["session"];
  const userId = user["id"];
  const name = user["name"];
  const role = user["role"];
  const status = user["status"];
  const expiresAtValue = session["expiresAt"];

  if (
    !(
      boundedString(userId, 256) &&
      boundedString(name, 200) &&
      isPortalRole(role)
    ) ||
    status !== "active" ||
    !(typeof expiresAtValue === "string" || expiresAtValue instanceof Date)
  ) {
    return null;
  }

  const expiresAt =
    expiresAtValue instanceof Date ? expiresAtValue : new Date(expiresAtValue);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }

  const email = user["email"];
  return {
    expiresAt,
    isOperator: isOperatorIdentity(
      {
        email: typeof email === "string" ? email : "",
        emailVerified: user["emailVerified"] === true,
        status,
      },
      operatorEmails
    ),
    name: name.trim(),
    role,
    status,
    userId,
  };
};

const readBoundedResponseBody = async (
  response: Response,
  signal: AbortSignal
): Promise<string | null> => {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancelAtDeadline = () => {
    return void reader.cancel();
  };
  signal.addEventListener("abort", cancelAtDeadline, { once: true });
  if (signal.aborted) cancelAtDeadline();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_SESSION_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelAtDeadline);
    reader.releaseLock();
  }

  if (byteLength === 0) return null;
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

/** A failed check, as the reason text of the one failure log line. A valid "no session" answer is not a failure. */
type SessionCheckOutcome =
  | { readonly session: PortalSession | null }
  | { readonly failure: string; readonly capacity?: true };

/**
 * The session API answered the request-DB capacity 503 on every attempt.
 * Transient, not "signed out": callers must not redirect to sign-in.
 */
export class PortalSessionUnavailableError extends Error {
  override readonly name = "PortalSessionUnavailableError";

  constructor() {
    super("Portal session check is temporarily unavailable");
  }
}

/** Resolves true after the capacity retry delay, false as soon as `signal` aborts. */
const waitForSessionCapacity = (signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(finish, CAPACITY_RETRY_DELAY_MS);
    signal.addEventListener("abort", finish, { once: true });
  });

/** Error class names only: error messages can hold connection details. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;

const safeErrorName = (error: unknown): string => {
  try {
    if (error instanceof Error && ERROR_NAME_PATTERN.test(error.name)) {
      return error.name;
    }
  } catch {
    // A hostile `name` getter or proxy trap keeps "unknown"; the check still denies.
  }
  return "unknown";
};

const parseSessionResponse = async (
  response: Response,
  now: Date,
  signal: AbortSignal,
  operatorEmails: readonly string[]
): Promise<SessionCheckOutcome> => {
  if (!response.ok) {
    const capacity = isCapacityResponse(response);
    await response.body?.cancel();
    return {
      failure: `reason=http status=${response.status} capacity=${capacity}`,
      ...(capacity ? { capacity: true as const } : {}),
    };
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SESSION_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    return { failure: "reason=invalid-body" };
  }

  const body = await readBoundedResponseBody(response, signal);
  if (body === null) return { failure: "reason=invalid-body" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { failure: "reason=invalid-body" };
  }
  return { session: parsePortalSession(parsed, now, operatorEmails) };
};

/**
 * Asks Better Auth for the session behind `cookieHeader`. Every failure
 * (request setup, deadline, transport error, non-2xx answer, unusable body) denies access
 * and writes one `portal session check failed` line to stderr with the
 * reason and duration; it never includes cookies, headers or identities.
 * The request-DB capacity 503 is the one exception: it is retried (at most
 * CAPACITY_RETRY_MAX_ATTEMPTS, inside the deadline) and, if it persists,
 * throws PortalSessionUnavailableError so a busy isolate never signs users out.
 */
export const getPortalSession = async ({
  cookieHeader,
  cfConnectingIp = null,
  fetch: fetchSession = globalThis.fetch,
  now = new Date(),
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  operatorEmails = [],
}: GetPortalSessionOptions): Promise<PortalSession | null> => {
  if (cookieHeader === null || cookieHeader.trim().length === 0) return null;
  const deadline = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1), 10_000)
    : DEFAULT_SESSION_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadline);
  const startedAt = Date.now();
  const fail = (reason: string): null => {
    const reported = controller.signal.aborted
      ? `reason=timeout deadlineMs=${deadline}`
      : reason;
    console.error(
      `portal session check failed: ${reported} durationMs=${Date.now() - startedAt}`
    );
    return null;
  };

  // "setup" until the request is built (bad APP_URL or cookie header), then "network".
  let stage = "setup";
  // Once any attempt saw capacity, a later abort or transport error is still "busy", never "signed out".
  let sawCapacity = false;
  try {
    const sessionHeaders = new Headers({
      accept: "application/json",
      cookie: cookieHeader,
    });
    if (cfConnectingIp !== null) {
      sessionHeaders.set("cf-connecting-ip", cfConnectingIp);
    }
    const request = new Request(
      new URL("/api/auth/get-session", resolvePortalAppUrl()),
      {
        cache: "no-store",
        headers: sessionHeaders,
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      }
    );
    stage = "network";
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await parseSessionResponse(
        await fetchSession(request.clone()),
        now,
        controller.signal,
        operatorEmails
      );
      if (!("failure" in outcome)) return outcome.session;
      if (outcome.capacity !== true) return fail(outcome.failure);
      sawCapacity = true;
      if (
        attempt === CAPACITY_RETRY_MAX_ATTEMPTS ||
        !(await waitForSessionCapacity(controller.signal))
      ) {
        fail(outcome.failure);
        throw new PortalSessionUnavailableError();
      }
    }
  } catch (error) {
    if (error instanceof PortalSessionUnavailableError) throw error;
    fail(`reason=${stage} error=${safeErrorName(error)}`);
    if (sawCapacity) throw new PortalSessionUnavailableError();
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const isAllowedPortalPath = (pathname: string): boolean => {
  return PORTAL_PATH_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`)
  );
};

export const safePortalCallbackPath = (value: string | null): string | null => {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return null;

  try {
    const parsed = new URL(value, CANONICAL_APP_URL);
    if (
      parsed.origin !== CANONICAL_APP_URL ||
      !isAllowedPortalPath(parsed.pathname)
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
};

export const resolvePortalCallbackPath = (requestHeaders: Headers): string => {
  for (const headerName of REQUEST_PATH_HEADERS) {
    const safePath = safePortalCallbackPath(requestHeaders.get(headerName));
    if (safePath !== null) return safePath;
  }
  return "/dashboard";
};

export const portalSignInHref = (requestHeaders: Headers): string => {
  return `/sign-in?callbackURL=${encodeURIComponent(resolvePortalCallbackPath(requestHeaders))}`;
};
