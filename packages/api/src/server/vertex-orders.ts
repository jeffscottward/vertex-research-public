import type { SemanticEvent } from "@darkfactory/observability/port";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  VertexOpenOrder,
  VertexOrderInput,
} from "../contracts/vertex-orders.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  CONFIRM_TTL_MS,
  consumeConfirmToken,
  issueConfirmToken,
} from "./vertex-orders-confirm.ts";
import {
  createBridgeOrderGateway,
  createMockOrderGateway,
  OrderGatewayError,
  type OrderGatewayPort,
} from "./vertex-orders-gateway.ts";
import {
  contractLabel,
  evaluateOrder,
  type GatewayOpenOrder,
  type OrderAccount,
} from "./vertex-orders-rules.ts";

// Owner order screen (vertexOrders.*). Operator allow-list only (requireOperator; agent API keys
// cannot reach this namespace). The handler origin check covers CSRF for every POST. Each mutating
// call is rate-limited per user and audit-logged as a semantic event (user id, contract, result;
// never account numbers). VERTEX_ORDERS_ENABLED off => the mock gateway only; IBKR is never called.

export type VertexOrdersConfig = Readonly<{
  enabled: boolean;
  // VERTEX_ORDER_SUBMISSION, the repo-wide submission gate (a config literal "disabled" today).
  // Live orders need BOTH this gate open and VERTEX_ORDERS_ENABLED; otherwise the mock is used.
  submission: string;
  bridgeUrl: string | null;
  confirmSecret: string;
}>;

interface Dependencies {
  mock: OrderGatewayPort;
  bridgeFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
}

let dependencies: Dependencies | undefined;
const deps = (): Dependencies => {
  dependencies ??= { mock: createMockOrderGateway(), now: () => new Date() };
  return dependencies;
};
export const setVertexOrdersDependenciesForTesting = (
  next: Dependencies | undefined
): void => {
  dependencies = next;
  limits.clear();
};

const DISABLED: VertexOrdersConfig = {
  enabled: false,
  submission: "disabled",
  bridgeUrl: null,
  confirmSecret: "",
};

const MIN_SECRET_LENGTH = 32;

// The confirm-token secret is required for every mutating call; a short secret fails closed.
const configOf = (
  context: ApiContext,
  failures?: Failures
): VertexOrdersConfig => {
  const config = context.vertexOrders ?? DISABLED;
  if (failures !== undefined && config.confirmSecret.length < MIN_SECRET_LENGTH)
    throw failures.NOT_CONFIGURED({
      message: "Order confirm secret is not configured",
    });
  return config;
};

const liveAllowed = (config: VertexOrdersConfig): boolean =>
  config.enabled && config.submission === "enabled";

const selectOrderGateway = (config: VertexOrdersConfig): OrderGatewayPort =>
  liveAllowed(config)
    ? createBridgeOrderGateway(config.bridgeUrl, deps().bridgeFetch)
    : deps().mock;

const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS = { preview: 20, submit: 5 } as const;
const limits = new Map<string, number[]>();

const allow = (key: string, max: number, now: number): boolean => {
  const recent = (limits.get(key) ?? []).filter(
    (time) => time > now - RATE_WINDOW_MS
  );
  if (recent.length >= max) {
    limits.set(key, recent);
    return false;
  }
  recent.push(now);
  limits.set(key, recent);
  return true;
};

const gatesOf = (
  config: VertexOrdersConfig,
  gateway: OrderGatewayPort,
  account: OrderAccount
) => ({
  ordersEnabled: liveAllowed(config),
  mode: gateway.mode,
  killSwitch: account.gates.killSwitch,
  optionsOnly: account.gates.optionsOnly,
});

const toOpenOrder = (order: GatewayOpenOrder): VertexOpenOrder => ({
  ...order,
  // Only option orders can be cancelled here; share stops protect positions and stay untouched.
  cancellable: order.secType === "OPT",
});

const orderAction = (order: VertexOrderInput): string =>
  `order:${JSON.stringify(order)}`;

type Failures = Readonly<
  Record<
    | "CONFIRM_INVALID"
    | "ORDER_REJECTED"
    | "RATE_LIMITED"
    | "NOT_FOUND"
    | "NOT_CONFIGURED"
    | "UPSTREAM_ERROR"
    | "AUDIT_UNAVAILABLE"
    | "FORBIDDEN",
    (options?: { message?: string }) => Error
  >
>;

const api = implement(appContract).$context<ApiContext>();

type Principal = Readonly<{ userId: string }>;
// requireOperator runs first on every procedure here and always sets the principal.
const userOf = (context: ApiContext): string =>
  (context as ApiContext & { principal: Principal }).principal.userId;

const audit = async (
  context: ApiContext,
  action: string,
  outcome: "success" | "failure",
  attributes: Readonly<Record<string, string | number | boolean>>
): Promise<boolean> => {
  if (context.semanticEvents === undefined) return false;
  const event: SemanticEvent = {
    eventId: crypto.randomUUID(),
    name: `vertex.orders.${action}`,
    occurredAt: deps().now().toISOString(),
    correlation: {
      ...(context.span?.correlation ?? {}),
      requestId: context.requestId,
      procedure: `vertexOrders.${action}`,
    },
    action,
    entityType: "option-order",
    outcome,
    source: "api",
    attributes: { userId: userOf(context), ...attributes },
  };
  try {
    const result = await context.semanticEvents.emit(event);
    return result.structuredEvent === "emitted";
  } catch {
    return false;
  }
};

// Submit and cancel write an intent record before the gateway call. If that record cannot be
// written (no event port, sink failure), the request is refused and nothing reaches the gateway.
const requireAudit = async (
  context: ApiContext,
  failures: Failures,
  action: string,
  attributes: Readonly<Record<string, string | number | boolean>>
): Promise<void> => {
  if (!(await audit(context, `${action}Intent`, "success", attributes)))
    throw failures.AUDIT_UNAVAILABLE();
};

// Owner only: operator allow-list (requireOperator) AND the admin role. Agent keys never pass.
const requireOwner = api.middleware(async ({ context, next, errors }) => {
  try {
    await context.requireRole("admin");
  } catch {
    throw (errors as unknown as Failures).FORBIDDEN({
      message: "Owner (admin) access required",
    });
  }
  return next();
});

// Runs a gateway call and maps adapter failures to contract errors. On submit and cancel,
// `onFailure` writes the audit record before the error leaves the handler.
const guarded = async <T>(
  failures: Failures,
  run: () => Promise<T>,
  onFailure?: (result: string) => Promise<unknown>
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    await onFailure?.(
      error instanceof OrderGatewayError ? error.message : "gateway error"
    );
    if (error instanceof OrderGatewayError)
      throw failures[error.code]({ message: error.message });
    throw error;
  }
};

const status = api.vertexOrders.status
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, errors }) => {
    const config = configOf(context);
    const gateway = selectOrderGateway(config);
    const account = await guarded(
      errors as unknown as Failures,
      gateway.account
    );
    return {
      gates: gatesOf(config, gateway, account),
      netLiquidation: account.netLiquidation,
      openOrders: account.openOrders.map(toOpenOrder),
    };
  });

const rateCheck = (
  context: ApiContext,
  failures: Failures,
  kind: keyof typeof RATE_LIMITS
): void => {
  if (
    !allow(
      `${userOf(context)}:${kind}`,
      RATE_LIMITS[kind],
      deps().now().getTime()
    )
  )
    throw failures.RATE_LIMITED({
      message: `Too many order requests: at most ${RATE_LIMITS[kind]} per minute`,
    });
};

const preview = api.vertexOrders.preview
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "preview");
    const config = configOf(context, failures);
    const gateway = selectOrderGateway(config);
    const account = await guarded(failures, gateway.account);
    const now = deps().now();
    const review = evaluateOrder(input, account, now);
    const expiresAt = now.getTime() + CONFIRM_TTL_MS;
    const confirmToken = review.accepted
      ? await issueConfirmToken(config.confirmSecret, {
          userId: userOf(context),
          action: orderAction(input),
          nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
          expiresAt,
        })
      : null;
    await audit(context, "preview", review.accepted ? "success" : "failure", {
      contract: review.contractLabel,
      side: input.side,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      mode: gateway.mode,
      result: review.accepted ? "accepted" : review.reasons.join(" | "),
    });
    return {
      gates: gatesOf(config, gateway, account),
      review,
      confirmToken,
      expiresAt:
        confirmToken === null ? null : new Date(expiresAt).toISOString(),
    };
  });

const submit = api.vertexOrders.submit
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "submit");
    const config = configOf(context, failures);
    const now = deps().now();
    const label = contractLabel(input.order);
    const base = {
      contract: label,
      side: input.order.side,
      quantity: input.order.quantity,
      limitPrice: input.order.limitPrice,
    };
    const claims = await consumeConfirmToken(
      config.confirmSecret,
      input.confirmToken,
      { userId: userOf(context), action: orderAction(input.order) },
      now.getTime()
    );
    if (claims === null) {
      await audit(context, "submit", "failure", {
        ...base,
        result: "confirm invalid",
      });
      throw failures.CONFIRM_INVALID();
    }
    const gateway = selectOrderGateway(config);
    const auditFailure = (outcome: string) =>
      audit(context, "submit", "failure", {
        ...base,
        mode: gateway.mode,
        result: outcome,
      });
    const account = await guarded(failures, gateway.account, auditFailure);
    const review = evaluateOrder(input.order, account, now);
    if (!review.accepted) {
      await auditFailure(review.reasons.join(" | "));
      throw failures.ORDER_REJECTED({ message: review.reasons.join(" ") });
    }
    // The IBKR gateway place_option mode accepts only orderRefs that start with "leaps-".
    const orderRef = `leaps-vertex-${claims.nonce}`;
    await requireAudit(context, failures, "submit", {
      ...base,
      mode: gateway.mode,
      orderRef,
    });
    const result = await guarded(
      failures,
      () => gateway.place(input.order, orderRef),
      auditFailure
    );
    await audit(context, "submit", "success", {
      ...base,
      mode: gateway.mode,
      orderRef,
      result: result.state,
    });
    return { mode: gateway.mode, orderRef, ...result };
  });

const findOrder = (
  failures: Failures,
  account: OrderAccount,
  permId: number
): GatewayOpenOrder => {
  const order = account.openOrders.find((o) => o.permId === permId);
  if (order === undefined || order.secType !== "OPT")
    throw failures.NOT_FOUND({
      message: "No open option order with this permId",
    });
  return order;
};

const cancelPreview = api.vertexOrders.cancelPreview
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "preview");
    const config = configOf(context, failures);
    const gateway = selectOrderGateway(config);
    const account = await guarded(failures, gateway.account);
    const order = findOrder(failures, account, input.permId);
    const expiresAt = deps().now().getTime() + CONFIRM_TTL_MS;
    const confirmToken = await issueConfirmToken(config.confirmSecret, {
      userId: userOf(context),
      action: `cancel:${input.permId}`,
      nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
      expiresAt,
    });
    await audit(context, "cancelPreview", "success", {
      permId: input.permId,
      contract: order.symbol,
      mode: gateway.mode,
    });
    return {
      gates: gatesOf(config, gateway, account),
      order: toOpenOrder(order),
      confirmToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });

const cancelSubmit = api.vertexOrders.cancelSubmit
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "submit");
    const config = configOf(context, failures);
    const claims = await consumeConfirmToken(
      config.confirmSecret,
      input.confirmToken,
      { userId: userOf(context), action: `cancel:${input.permId}` },
      deps().now().getTime()
    );
    if (claims === null) {
      await audit(context, "cancel", "failure", {
        permId: input.permId,
        result: "confirm invalid",
      });
      throw failures.CONFIRM_INVALID();
    }
    const gateway = selectOrderGateway(config);
    const auditFailure = (outcome: string) =>
      audit(context, "cancel", "failure", {
        permId: input.permId,
        mode: gateway.mode,
        result: outcome,
      });
    const account = await guarded(failures, gateway.account, auditFailure);
    const order = account.openOrders.find(
      (o) => o.permId === input.permId && o.secType === "OPT"
    );
    if (order === undefined) {
      await auditFailure("not found");
      throw failures.NOT_FOUND({
        message: "No open option order with this permId",
      });
    }
    await requireAudit(context, failures, "cancel", {
      permId: input.permId,
      contract: order.symbol,
      mode: gateway.mode,
    });
    const result = await guarded(
      failures,
      () => gateway.cancel(input.permId),
      auditFailure
    );
    await audit(context, "cancel", "success", {
      permId: input.permId,
      contract: order.symbol,
      mode: gateway.mode,
      result: result.state,
    });
    return { mode: gateway.mode, orderRef: order.orderRef, ...result };
  });

export const vertexOrdersRouter = {
  status,
  preview,
  submit,
  cancelPreview,
  cancelSubmit,
};
