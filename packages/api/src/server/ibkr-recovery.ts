import type { SemanticEvent } from "@darkfactory/observability/port";
import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";
import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  IBKR_RECOVERY_LOGIN_STATES,
  IBKR_RECOVERY_REQUEST_STATES,
  IBKR_RECOVERY_TERMINAL_STATES,
  type IbkrRecoveryRequest,
  type IbkrRecoveryRequestOutput,
  type IbkrRecoveryStatusOutput,
} from "../contracts/ibkr-recovery.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { readCappedText } from "./portfolio-monitor.ts";

// Human IBKR 2FA recovery (ibkrRecovery.*). Operator allow-list only; agent API keys and MCP tools
// cannot reach this namespace. The Vertex server never holds IBKR credentials. It asks the QuantVPS
// service vertex-ibkr-recovery (VERTEX_IBKR_RECOVERY_URL, bearer VERTEX_IBKR_RECOVERY_TOKEN) to start
// the existing 2FA script once. Gates here: one request in flight, 15 min cooldown, a logged-out or
// stopped gateway, and a written audit record before the VPS call. The VPS service enforces the same
// gates again with persisted state. Nothing here retries a request.

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;

type IbkrRecoveryErrorCode =
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "IN_FLIGHT"
  | "NOT_NEEDED"
  | "RATE_LIMITED"
  | "AUDIT_UNAVAILABLE";

class IbkrRecoveryError extends Error {
  code: IbkrRecoveryErrorCode;
  constructor(code: IbkrRecoveryErrorCode, message: string) {
    super(message);
    this.name = "IbkrRecoveryError";
    this.code = code;
  }
}

export type IbkrRecoveryDependencies = Readonly<{
  fetch?: DeployStatusFetch;
  now?: () => Date;
  newRequestId?: () => string;
  timeoutMs?: number;
}>;

let dependencies: IbkrRecoveryDependencies = {};
// Process-local single-flight guard; the VPS lock and persisted cooldown are authoritative.
let pending = false;
const auditedResults = new Set<string>();

export const setIbkrRecoveryDependenciesForTesting = (
  next: IbkrRecoveryDependencies
): void => {
  dependencies = next;
  pending = false;
  auditedResults.clear();
};

const now = (): Date => (dependencies.now ?? (() => new Date()))();

const iso = z.string().max(40);

const UpstreamRequestSchema = z
  .object({
    actorId: z.string().max(64),
    detail: z.string().max(200),
    finishedAt: iso.nullable(),
    recheck: z
      .object({ at: iso, detail: z.string().max(200), ok: z.boolean() })
      .strict()
      .nullable()
      .default(null),
    // VPS 1.1.0 and later. Older services omit them.
    recheckAt: iso.nullable().default(null),
    requestedAt: iso,
    requestId: z.string().max(64),
    scriptRunning: z.boolean(),
    state: z.enum(IBKR_RECOVERY_REQUEST_STATES),
    updatedAt: iso,
  })
  .strict();

const UpstreamStatusSchema = z
  .object({
    cooldown: z
      .object({
        seconds: z.number().int().nonnegative(),
        until: iso.nullable(),
      })
      .strict(),
    gateway: z
      .object({
        // VPS 1.1.0 and later. Older services omit it: unknown counts as false.
        feedsMissing: z.boolean().default(false),
        loginState: z.enum(IBKR_RECOVERY_LOGIN_STATES),
        needsLogin: z.boolean(),
        reason: z.string().max(60),
        since: iso.nullable(),
      })
      .strict(),
    generatedAt: iso,
    history: z.array(UpstreamRequestSchema).max(20),
    request: UpstreamRequestSchema.nullable(),
    schema: z.literal("vertex-ibkr-recovery-status-v1"),
    version: z.string().max(20),
  })
  .strict();

const UpstreamRequestResultSchema = z
  .object({
    outcome: z.enum(["started", "existing"]),
    request: UpstreamRequestSchema,
    schema: z.literal("vertex-ibkr-recovery-request-v1"),
  })
  .strict();

type UpstreamStatus = z.infer<typeof UpstreamStatusSchema>;
type UpstreamRequest = z.infer<typeof UpstreamRequestSchema>;

const TERMINAL: ReadonlySet<string> = new Set(IBKR_RECOVERY_TERMINAL_STATES);

// The VPS accepts actor ids matching ^[A-Za-z0-9_-]{1,64}$; other characters become "_".
export const toActorId = (userId: string): string => {
  const cleaned = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned === "" ? "unknown" : cleaned;
};

type Reply = Readonly<{ status: number; json: unknown }>;

// Bounded call to the VPS service: 10 s timeout, 64 KiB cap, redirects never followed. Messages
// never include the token, the URL or response text.
const call = async (
  config: DeployStatusConfig | null,
  path: string,
  init: Readonly<{ method: "GET" | "POST"; body?: string }>
): Promise<Reply> => {
  if (config === null)
    throw new IbkrRecoveryError(
      "NOT_CONFIGURED",
      "IBKR recovery endpoint not configured (VERTEX_IBKR_RECOVERY_URL)"
    );
  const doFetch =
    dependencies.fetch ?? ((url, request) => globalThis.fetch(url, request));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await doFetch(`${config.url.replace(/\/+$/, "")}${path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new IbkrRecoveryError(
        "UNAVAILABLE",
        controller.signal.aborted
          ? "IBKR recovery request timed out"
          : "IBKR recovery request failed"
      );
    }
    if ([502, 503, 504].includes(response.status))
      throw new IbkrRecoveryError(
        "UNAVAILABLE",
        `IBKR recovery endpoint returned HTTP ${response.status}`
      );
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new IbkrRecoveryError(
        "UPSTREAM_ERROR",
        `IBKR recovery endpoint returned HTTP ${response.status} with an unexpected content type`
      );
    let text: string;
    try {
      text = await readCappedText(
        response,
        MAX_BYTES,
        (message) =>
          new IbkrRecoveryError(
            "UPSTREAM_ERROR",
            `IBKR recovery ${message.toLowerCase()}`
          )
      );
    } catch (error) {
      if (error instanceof IbkrRecoveryError) throw error;
      throw new IbkrRecoveryError(
        "UNAVAILABLE",
        "IBKR recovery response could not be read"
      );
    }
    try {
      return { json: JSON.parse(text) as unknown, status: response.status };
    } catch {
      throw new IbkrRecoveryError(
        "UPSTREAM_ERROR",
        "IBKR recovery response is not valid JSON"
      );
    }
  } finally {
    clearTimeout(timer);
  }
};

const parseOrFail = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new IbkrRecoveryError(
      "UPSTREAM_ERROR",
      "IBKR recovery response does not match the expected schema"
    );
  return parsed.data;
};

const fetchIbkrRecoveryStatus = async (
  config: DeployStatusConfig | null
): Promise<UpstreamStatus> => {
  const reply = await call(config, "/status", { method: "GET" });
  if (reply.status !== 200)
    throw new IbkrRecoveryError(
      "UPSTREAM_ERROR",
      `IBKR recovery endpoint returned HTTP ${reply.status}`
    );
  return parseOrFail(UpstreamStatusSchema, reply.json);
};

const toRequest = (
  request: UpstreamRequest,
  actorId: string
): IbkrRecoveryRequest => ({
  detail: request.detail,
  finishedAt: request.finishedAt,
  recheck: request.recheck,
  recheckAt: request.recheckAt,
  requestedAt: request.requestedAt,
  requestedByYou: request.actorId === actorId,
  requestId: request.requestId,
  scriptRunning: request.scriptRunning,
  state: request.state,
  updatedAt: request.updatedAt,
});

// Same rule as the VPS: logged out/stopped, or logged in while the account feeds are missing.
const recoveryNeeded = (upstream: UpstreamStatus): boolean =>
  upstream.gateway.needsLogin ||
  (upstream.gateway.loginState === "logged-in" &&
    upstream.gateway.feedsMissing);

const inFlight = (request: UpstreamRequest | null): boolean =>
  request !== null && (request.scriptRunning || !TERMINAL.has(request.state));

// The persisted VPS cooldown (15 min after each start) decides; a time in the past means none.
const cooldownUntil = (upstream: UpstreamStatus, at: Date): string | null =>
  upstream.cooldown.until !== null &&
  Date.parse(upstream.cooldown.until) > at.getTime()
    ? upstream.cooldown.until
    : null;

const toIbkrRecoveryStatus = (
  upstream: UpstreamStatus,
  actorId: string,
  at: Date
): IbkrRecoveryStatusOutput => {
  const cooldown = cooldownUntil(upstream, at);
  return {
    canRequest:
      recoveryNeeded(upstream) &&
      !inFlight(upstream.request) &&
      cooldown === null,
    checkedAt: at.toISOString(),
    cooldownUntil: cooldown,
    gateway: upstream.gateway,
    request:
      upstream.request === null ? null : toRequest(upstream.request, actorId),
  };
};

const api = implement(appContract).$context<ApiContext>();

type Principal = Readonly<{ userId: string }>;
// requireOperator runs first on every procedure here and always sets the principal.
const userOf = (context: ApiContext): string =>
  (context as ApiContext & { principal: Principal }).principal.userId;

type Attributes = Readonly<Record<string, string | number | boolean>>;

const audit = async (
  context: ApiContext,
  action: string,
  outcome: "success" | "failure",
  attributes: Attributes
): Promise<boolean> => {
  if (context.semanticEvents === undefined) return false;
  const event: SemanticEvent = {
    action,
    attributes: { userId: userOf(context), ...attributes },
    correlation: {
      ...(context.span?.correlation ?? {}),
      procedure: `ibkrRecovery.${action}`,
      requestId: context.requestId,
    },
    entityType: "ibkr-gateway-recovery",
    eventId: crypto.randomUUID(),
    name: `vertex.ibkrRecovery.${action}`,
    occurredAt: now().toISOString(),
    outcome,
    source: "api",
  };
  try {
    const result = await context.semanticEvents.emit(event);
    return result.structuredEvent === "emitted";
  } catch {
    return false;
  }
};

type Failures = Readonly<
  Record<IbkrRecoveryErrorCode, (options?: { message?: string }) => Error>
>;

const mapError = (failures: Failures, error: unknown): Error => {
  if (error instanceof IbkrRecoveryError)
    return failures[error.code]({ message: error.message });
  return failures.UPSTREAM_ERROR({ message: "IBKR recovery request failed" });
};

// Records the outcome of a finished request once per process (who started it, final state).
const auditResult = async (
  context: ApiContext,
  request: UpstreamRequest | null
): Promise<void> => {
  if (
    request === null ||
    !TERMINAL.has(request.state) ||
    auditedResults.has(request.requestId)
  )
    return;
  auditedResults.add(request.requestId);
  await audit(
    context,
    "result",
    request.state === "logged-in" ? "success" : "failure",
    {
      detail: request.detail,
      recoveryRequestId: request.requestId,
      requestedAt: request.requestedAt,
      requestedBy: request.actorId,
      state: request.state,
    }
  );
};

const statusProcedure = api.ibkrRecovery.status
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    try {
      const upstream = await fetchIbkrRecoveryStatus(
        context.ibkrRecovery ?? null
      );
      await auditResult(context, upstream.request);
      return toIbkrRecoveryStatus(upstream, toActorId(userOf(context)), now());
    } catch (error) {
      throw mapError(failures, error);
    }
  });

const REFUSALS: Readonly<Record<string, IbkrRecoveryErrorCode>> = {
  cooldown: "RATE_LIMITED",
  in_flight: "IN_FLIGHT",
  not_needed: "NOT_NEEDED",
};

const refusalOf = (reply: Reply): IbkrRecoveryError => {
  const error =
    typeof reply.json === "object" && reply.json !== null
      ? Reflect.get(reply.json, "error")
      : undefined;
  const code = typeof error === "string" ? REFUSALS[error] : undefined;
  if (code !== undefined && (reply.status === 409 || reply.status === 429))
    return new IbkrRecoveryError(code, `VPS refused the request (${error})`);
  return new IbkrRecoveryError(
    "UPSTREAM_ERROR",
    `IBKR recovery endpoint returned HTTP ${reply.status}`
  );
};

// The first gate that refuses a new request, or null when all gates pass.
const refusalBeforeSend = (
  upstream: UpstreamStatus,
  at: Date
): IbkrRecoveryError | null => {
  if (inFlight(upstream.request))
    return new IbkrRecoveryError(
      "IN_FLIGHT",
      "An IBKR 2FA request is already in progress"
    );
  const until = cooldownUntil(upstream, at);
  if (until !== null)
    return new IbkrRecoveryError(
      "RATE_LIMITED",
      `Next IBKR 2FA request possible at ${until}`
    );
  if (!recoveryNeeded(upstream))
    return new IbkrRecoveryError(
      "NOT_NEEDED",
      `The IBKR gateway login state is ${upstream.gateway.loginState}; no 2FA request is needed`
    );
  return null;
};

const sendRequest = async (
  context: ApiContext,
  actorId: string
): Promise<IbkrRecoveryRequestOutput> => {
  const config = context.ibkrRecovery ?? null;
  const upstream = await fetchIbkrRecoveryStatus(config);
  const refusal = refusalBeforeSend(upstream, now());
  if (refusal !== null) {
    await audit(context, "request", "failure", {
      loginState: upstream.gateway.loginState,
      outcome: refusal.code,
    });
    throw refusal;
  }
  const recoveryRequestId = (
    dependencies.newRequestId ?? (() => crypto.randomUUID())
  )();
  // The intent record must exist before the VPS can start anything.
  if (
    !(await audit(context, "requestIntent", "success", {
      loginState: upstream.gateway.loginState,
      recoveryRequestId,
    }))
  )
    throw new IbkrRecoveryError(
      "AUDIT_UNAVAILABLE",
      "Audit log unavailable; the request was not sent"
    );
  // call() converts every failure to an IbkrRecoveryError.
  const reply = await call(config, "/request", {
    body: JSON.stringify({
      actorId,
      dryRun: false,
      requestId: recoveryRequestId,
      statement: RECOVERY_CONFIRMATION,
    }),
    method: "POST",
  }).catch(async (error: IbkrRecoveryError) => {
    await audit(context, "request", "failure", {
      outcome: error.code,
      recoveryRequestId,
    });
    throw error;
  });
  if (reply.status !== 200 && reply.status !== 202) {
    const vpsRefusal = refusalOf(reply);
    await audit(context, "request", "failure", {
      outcome: vpsRefusal.code,
      recoveryRequestId,
    });
    throw vpsRefusal;
  }
  const result = parseOrFail(UpstreamRequestResultSchema, reply.json);
  await audit(context, "request", "success", {
    outcome: result.outcome,
    recoveryRequestId: result.request.requestId,
    state: result.request.state,
  });
  return {
    outcome: result.outcome,
    request: toRequest(result.request, actorId),
  };
};

const requestProcedure = api.ibkrRecovery.request
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    // One request in flight per server process; the VPS lock covers other processes.
    if (pending)
      throw failures.IN_FLIGHT({
        message: "An IBKR 2FA request is already being sent",
      });
    pending = true;
    try {
      return await sendRequest(context, toActorId(userOf(context)));
    } catch (error) {
      throw mapError(failures, error);
    } finally {
      pending = false;
    }
  });

export const ibkrRecoveryRouter = {
  request: requestProcedure,
  status: statusProcedure,
};
