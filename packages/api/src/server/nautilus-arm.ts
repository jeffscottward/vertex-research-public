import type { SemanticEvent } from "@darkfactory/observability/port";
import { implement } from "@orpc/server";
import { z } from "zod";

import { appContract } from "../contract.ts";
import {
  NAUTILUS_ARM_STATEMENT,
  NAUTILUS_CONTAINER_STATES,
  type NautilusArmChangeOutput,
  type NautilusArmStatusOutput,
  type NautilusNodeBadge,
  NautilusArmStateSchema,
} from "../contracts/nautilus-arm.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import {
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_WINDOW_MS,
  passwordStepUp,
  type StepUpOutcome,
} from "./password-step-up.ts";
import { readCappedText } from "./portfolio-monitor.ts";

// Nautilus node arm switch (nautilusArm.*). Owner decision 2026-10-30: the node runs 24/7 and is disarmed
// by default. Operator allow-list only, browser session only: agent API keys are refused on every
// procedure here. Arm needs the owner's password (step-up with lockout), a typed reason and the exact
// statement. Every change writes an intent row to audit_records BEFORE the bridge call (no row => nothing
// is sent) and a result row after it. Disarm needs no password. The server calls the QuantVPS recovery
// bridge (VERTEX_IBKR_RECOVERY_URL, same token), which runs only the vertex-quant arm CLI.

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;
const DISARM_REASON = "Disarmed from Vertex Mission control";

type NautilusArmErrorCode =
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "UPSTREAM_ERROR"
  | "CONFLICT"
  | "AUDIT_UNAVAILABLE"
  | "FORBIDDEN";

class NautilusArmError extends Error {
  code: NautilusArmErrorCode;
  constructor(code: NautilusArmErrorCode, message: string) {
    super(message);
    this.name = "NautilusArmError";
    this.code = code;
  }
}

export type NautilusArmDependencies = Readonly<{
  fetch?: DeployStatusFetch;
  now?: () => Date;
  newRequestId?: () => string;
  timeoutMs?: number;
}>;

let dependencies: NautilusArmDependencies = {};

export const setNautilusArmDependenciesForTesting = (
  next: NautilusArmDependencies
): void => {
  dependencies = next;
};

const now = (): Date => (dependencies.now ?? (() => new Date()))();

const UpstreamStatusSchema = z
  .object({
    arm: NautilusArmStateSchema.nullable(),
    armError: z.string().max(40).nullable(),
    container: z
      .object({
        health: z.enum(["healthy", "unhealthy", "starting"]).nullable(),
        state: z.enum(NAUTILUS_CONTAINER_STATES),
      })
      .strict(),
    generatedAt: z.string().max(40),
    schema: z.literal("vertex-nautilus-arm-status-v1"),
    version: z.string().max(20),
  })
  .strict();

const UpstreamResultSchema = z
  .object({
    action: z.enum(["arm", "disarm"]),
    arm: NautilusArmStateSchema,
    auditId: z.string().max(64).nullable(),
    requestId: z.string().max(64),
    schema: z.literal("vertex-nautilus-arm-result-v1"),
  })
  .strict();

// The bridge and the node accept ^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}$; other characters become "_".
export const toArmActorId = (userId: string): string => {
  const cleaned = userId
    .replace(/[^A-Za-z0-9_.@-]/g, "_")
    .replace(/^-/u, "_")
    .slice(0, 64);
  return cleaned === "" ? "unknown" : cleaned;
};

type Reply = Readonly<{ status: number; json: unknown }>;

// Bounded call to the bridge: 15 s timeout, 64 KiB cap, redirects never followed. Messages never
// include the token, the URL or response text.
const call = async (
  config: DeployStatusConfig | null,
  path: string,
  body?: string
): Promise<Reply> => {
  if (config === null)
    throw new NautilusArmError(
      "NOT_CONFIGURED",
      "Nautilus arm endpoint not configured (VERTEX_IBKR_RECOVERY_URL)"
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
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new NautilusArmError(
        "UNAVAILABLE",
        controller.signal.aborted
          ? "Nautilus arm request timed out"
          : "Nautilus arm request failed"
      );
    }
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new NautilusArmError(
        [502, 503, 504].includes(response.status)
          ? "UNAVAILABLE"
          : "UPSTREAM_ERROR",
        `Nautilus arm endpoint returned HTTP ${response.status} with an unexpected content type`
      );
    let text: string;
    try {
      text = await readCappedText(
        response,
        MAX_BYTES,
        (message) =>
          new NautilusArmError(
            "UPSTREAM_ERROR",
            `Nautilus arm ${message.toLowerCase()}`
          )
      );
    } catch (error) {
      if (error instanceof NautilusArmError) throw error;
      throw new NautilusArmError(
        "UNAVAILABLE",
        "Nautilus arm response could not be read"
      );
    }
    try {
      return { json: JSON.parse(text) as unknown, status: response.status };
    } catch {
      throw new NautilusArmError(
        "UPSTREAM_ERROR",
        "Nautilus arm response is not valid JSON"
      );
    }
  } finally {
    clearTimeout(timer);
  }
};

const parseOrFail = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new NautilusArmError(
      "UPSTREAM_ERROR",
      "Nautilus arm response does not match the expected schema"
    );
  return parsed.data;
};

export const nodeBadge = (
  container: NautilusArmStatusOutput["container"],
  arm: NautilusArmStatusOutput["arm"]
): NautilusNodeBadge => {
  if (container.state === "exited" || container.state === "missing")
    return "down";
  if (container.state === "running" && arm !== null)
    return arm.armed ? "running-armed" : "running-disarmed";
  return "unknown";
};

// Bridge and node refusals (HTTP 409) -> operator text.
const REFUSALS: Readonly<Record<string, string>> = {
  busy: "Another arm or disarm is running; try again in a few seconds",
  invalid_actor: "The node refused the operator id",
  invalid_reason: "The node refused the reason",
  kill_switch_active: "The kill switch is active; the node cannot be armed",
  not_running: "The Nautilus node is not running",
  version_mismatch:
    "The running image version changed; reload the status and try again",
  write_failed: "The node could not write the arm record",
};

const refusalOf = (reply: Reply): NautilusArmError => {
  const error =
    typeof reply.json === "object" && reply.json !== null
      ? Reflect.get(reply.json, "error")
      : undefined;
  const text = typeof error === "string" ? REFUSALS[error] : undefined;
  if (reply.status === 409 && text !== undefined)
    return new NautilusArmError("CONFLICT", text);
  return new NautilusArmError(
    [502, 503, 504].includes(reply.status) ? "UNAVAILABLE" : "UPSTREAM_ERROR",
    `Nautilus arm endpoint returned HTTP ${reply.status}`
  );
};

const api = implement(appContract).$context<ApiContext>();

// Agent API keys (x-api-key) never reach the arm switch, even a write key of an operator.
const denyAgentKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true)
    throw (
      errors as unknown as Readonly<{
        FORBIDDEN: (options?: { message?: string }) => Error;
      }>
    ).FORBIDDEN({
      message: "Agent API keys cannot use the Nautilus arm switch",
    });
  return await next();
});

type Principal = Readonly<{ userId: string }>;
// requireOperator runs first on every procedure here and always sets the principal.
const userOf = (context: ApiContext): string =>
  (context as ApiContext & { principal: Principal }).principal.userId;

type Failures = Readonly<
  Record<NautilusArmErrorCode, (options?: { message?: string }) => Error>
>;

const mapError = (failures: Failures, error: unknown): Error => {
  if (error instanceof NautilusArmError)
    return failures[error.code]({ message: error.message });
  return failures.UPSTREAM_ERROR({ message: "Nautilus arm request failed" });
};

// Best-effort structured event next to the audit_records row (the row is the gate).
const emit = async (
  context: ApiContext,
  action: string,
  outcome: "success" | "failure",
  attributes: Readonly<Record<string, string | boolean>>
): Promise<void> => {
  if (context.semanticEvents === undefined) return;
  const event: SemanticEvent = {
    action,
    attributes: { userId: userOf(context), ...attributes },
    correlation: {
      ...(context.span?.correlation ?? {}),
      procedure: `nautilusArm.${action}`,
      requestId: context.requestId,
    },
    entityType: "nautilus-node",
    eventId: crypto.randomUUID(),
    name: `vertex.nautilusArm.${action}`,
    occurredAt: now().toISOString(),
    outcome,
    source: "api",
  };
  try {
    await context.semanticEvents.emit(event);
  } catch {
    // The audit_records row already holds the record.
  }
};

type AuditRepository = NonNullable<
  ApiContext["repositories"]["nautilusArmAudit"]
>;

const auditOrFail = (context: ApiContext): AuditRepository => {
  const audit = context.repositories.nautilusArmAudit;
  if (audit === undefined)
    throw new NautilusArmError(
      "AUDIT_UNAVAILABLE",
      "Audit log unavailable; nothing was changed"
    );
  return audit;
};

const configOrFail = (context: ApiContext): DeployStatusConfig => {
  const config = context.ibkrRecovery ?? null;
  if (config === null)
    throw new NautilusArmError(
      "NOT_CONFIGURED",
      "Nautilus arm endpoint not configured (VERTEX_IBKR_RECOVERY_URL)"
    );
  return config;
};

type Action = "arm" | "disarm";

// Intent row before the bridge call, the call, then the result row. No intent row => no call.
const change = async (
  context: ApiContext,
  audit: AuditRepository,
  config: DeployStatusConfig,
  action: Action,
  body: Readonly<Record<string, string>>,
  metadata: Readonly<Record<string, string>>
): Promise<NautilusArmChangeOutput> => {
  const userId = userOf(context);
  const armRequestId = (
    dependencies.newRequestId ?? (() => crypto.randomUUID())
  )();
  const record = async (
    stage: "intent" | "result",
    extra: Readonly<Record<string, string | boolean>>
  ) =>
    await audit.record({
      action: `nautilus.${action}.${stage}`,
      actorUserId: userId,
      armRequestId,
      metadata: { ...metadata, ...extra },
      requestId: context.requestId,
    });
  try {
    await record("intent", {});
  } catch {
    throw new NautilusArmError(
      "AUDIT_UNAVAILABLE",
      "Audit log unavailable; nothing was changed"
    );
  }
  await emit(context, `${action}Intent`, "success", { armRequestId });
  const fail = async (error: NautilusArmError): Promise<never> => {
    // The node may have changed when the bridge did not answer; the status poll shows the real state.
    await record("result", { outcome: error.code }).catch(() => undefined);
    await emit(context, action, "failure", {
      armRequestId,
      outcome: error.code,
    });
    throw error;
  };
  let reply: Reply;
  try {
    reply = await call(
      config,
      `/nautilus/${action}`,
      JSON.stringify({
        ...body,
        actorId: toArmActorId(userId),
        requestId: armRequestId,
      })
    );
  } catch (error) {
    return await fail(error as NautilusArmError);
  }
  if (reply.status !== 200) return await fail(refusalOf(reply));
  let result: z.infer<typeof UpstreamResultSchema>;
  try {
    result = parseOrFail(UpstreamResultSchema, reply.json);
  } catch (error) {
    return await fail(error as NautilusArmError);
  }
  // The node changed already; a failed result row cannot undo it, so the answer still reports it.
  await record("result", {
    armed: result.arm.armed,
    nodeAuditId: result.auditId ?? "none",
    outcome: "ok",
  }).catch(() => undefined);
  await emit(context, action, "success", {
    armRequestId,
    armed: result.arm.armed,
  });
  return { action: result.action, arm: result.arm, auditId: result.auditId };
};

const statusProcedure = api.nautilusArm.status
  .use(denyAgentKeys)
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    try {
      const reply = await call(
        context.ibkrRecovery ?? null,
        "/nautilus/status"
      );
      if (reply.status !== 200) throw refusalOf(reply);
      const upstream = parseOrFail(UpstreamStatusSchema, reply.json);
      return {
        arm: upstream.arm,
        armError: upstream.armError,
        badge: nodeBadge(upstream.container, upstream.arm),
        checkedAt: now().toISOString(),
        container: upstream.container,
      };
    } catch (error) {
      throw mapError(errors as unknown as Failures, error);
    }
  });

const armProcedure = api.nautilusArm.arm
  .use(denyAgentKeys)
  .use(requireOperator)
  .handler(async ({ context, errors, input }) => {
    const failures = errors as unknown as Failures;
    try {
      const audit = auditOrFail(context);
      const config = configOrFail(context);
      const verifyPassword = context.verifyPassword;
      if (verifyPassword === undefined)
        throw new NautilusArmError(
          "FORBIDDEN",
          "Password step-up is not available on this server; arming is refused"
        );
      const userId = userOf(context);
      let outcome: StepUpOutcome;
      try {
        outcome = await passwordStepUp(
          {
            countSince: async (stage, since) =>
              await audit.countSince({
                action: `nautilus.arm.password-${stage}`,
                actorUserId: userId,
                since,
              }),
            record: async (stage) =>
              await audit.record({
                action: `nautilus.arm.password-${stage}`,
                actorUserId: userId,
                armRequestId: "none",
                metadata: { imageVersion: input.imageVersion },
                requestId: context.requestId,
              }),
          },
          verifyPassword,
          input.password,
          now().getTime()
        );
      } catch {
        throw new NautilusArmError(
          "AUDIT_UNAVAILABLE",
          "Audit log unavailable; nothing was changed"
        );
      }
      if (outcome.kind === "locked")
        throw new NautilusArmError(
          "FORBIDDEN",
          `Too many failed password attempts; try again in ${PASSWORD_FAILURE_WINDOW_MS / 60_000} minutes`
        );
      if (outcome.kind === "error")
        throw new NautilusArmError(
          "UNAVAILABLE",
          "The password could not be checked; try again later"
        );
      if (outcome.kind === "failed")
        throw new NautilusArmError(
          "FORBIDDEN",
          `Password check failed; the node was not armed (${outcome.attempt} of ${PASSWORD_FAILURE_LIMIT} attempts)`
        );
      return await change(
        context,
        audit,
        config,
        "arm",
        {
          imageVersion: input.imageVersion,
          reason: input.reason,
          statement: NAUTILUS_ARM_STATEMENT,
        },
        { imageVersion: input.imageVersion, reason: input.reason }
      );
    } catch (error) {
      throw mapError(failures, error);
    }
  });

const disarmProcedure = api.nautilusArm.disarm
  .use(denyAgentKeys)
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    try {
      return await change(
        context,
        auditOrFail(context),
        configOrFail(context),
        "disarm",
        { reason: DISARM_REASON },
        { reason: DISARM_REASON }
      );
    } catch (error) {
      throw mapError(errors as unknown as Failures, error);
    }
  });

export const nautilusArmRouter = {
  arm: armProcedure,
  disarm: disarmProcedure,
  status: statusProcedure,
};
