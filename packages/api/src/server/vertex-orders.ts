import type { SemanticEvent } from "@darkfactory/observability/port";
import { call, implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { JevVerdictOutput } from "../contracts/jev-verdict.ts";
import type {
  VertexComboInput,
  VertexComboLeg,
  VertexOpenOrder,
  VertexOrderInput,
} from "../contracts/vertex-orders.ts";
import type { ApiContext } from "./context.ts";
import {
  evaluateFinalOrderGate,
  type FinalGateDecision,
  type FinalGateOrder,
  isRiskReducing,
} from "./final-order-gate.ts";
import {
  maxLoss,
  orderSessionDay,
  strikeWidth,
} from "./golive-drafts-sizing.ts";
import { goLiveOrderRef } from "./golive-order-ref.ts";
import { goLiveSendRefusals } from "./golive-send-gate.ts";
import { readCachedJevVerdict } from "./jev-verdict.ts";
import { nautilusArmRouter } from "./nautilus-arm.ts";
import { requireOperator } from "./operator-access.ts";
import type { VertexOrdersConfig } from "./service-config.ts";
import {
  CONFIRM_TTL_MS,
  consumeConfirmToken,
  issueConfirmToken,
} from "./vertex-orders-confirm.ts";
import {
  BRIDGE_TIMEOUT_MS,
  createBridgeOrderGateway,
  createMockOrderGateway,
  OrderGatewayError,
  type OrderGatewayPort,
} from "./vertex-orders-gateway.ts";
import {
  contractLabel,
  evaluateCombo,
  evaluateOpeningCombo,
  evaluateOrder,
  GOLIVE_ENGINE_ORDER_POLICY,
  type GatewayOpenOrder,
  type OrderAccount,
  sameContract,
} from "./vertex-orders-rules.ts";

export type { VertexOrdersConfig } from "./service-config.ts";

// Owner order screen (vertexOrders.*). Operator allow-list only (requireOperator; agent API keys
// cannot reach this namespace). The handler origin check covers CSRF for every POST. Each mutating
// call is rate-limited per user and audit-logged as a semantic event (user id, contract, result;
// never account numbers). VERTEX_ORDERS_ENABLED off => the mock gateway only; IBKR is never called.

interface Dependencies {
  bridgeFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  // Node status for the go-live send gate; defaults to nautilusArm.status.
  goLiveNode?: (
    context: ApiContext
  ) => Promise<Parameters<typeof goLiveSendRefusals>[0]["node"]>;
  // Cached P5 JEV verdict for the final gate; defaults to the shared verdict store.
  jevVerdict?: (symbol: string) => JevVerdictOutput | null;
  mock: OrderGatewayPort;
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
  goLiveSentRefs.clear();
  placingUntil = 0;
};

const DISABLED: VertexOrdersConfig = {
  bridgeUrl: null,
  confirmSecret: "",
  enabled: false,
  submission: "disabled",
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
    ? createBridgeOrderGateway(
        config.bridgeUrl,
        deps().bridgeFetch,
        config.bridgeToken ?? null
      )
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
  killSwitch: account.gates.killSwitch,
  mode: gateway.mode,
  optionsOnly: account.gates.optionsOnly,
  ordersEnabled: liveAllowed(config),
});

const toOpenOrder = (order: GatewayOpenOrder): VertexOpenOrder => ({
  ...order,
  // Only option orders can be cancelled here; share stops protect positions and stay untouched.
  cancellable: order.secType === "OPT" || order.secType === "BAG",
});

const orderAction = (order: VertexOrderInput): string =>
  `order:${JSON.stringify(order)}`;
const comboAction = (
  order: VertexComboInput,
  goLiveDraftId: string | undefined
): string =>
  `combo:${JSON.stringify(order)}${goLiveDraftId === undefined ? "" : `:golive:${goLiveDraftId}`}`;

// One go-live draft is sent at most once: its orderRef is fixed by the draft id (goLiveOrderRef),
// and any intent row for it (written before the bridge call, also when the outcome is unknown)
// refuses a second send until the bridge refused it. Across web processes, the intent row is
// written only with a claim on (orderRef, attempt) (orderIntents.recordIntentOnce, one
// transaction), so of two concurrent sends exactly one reaches the bridge. The bridge tail also
// refuses an orderRef IBKR already has. Process memory covers the mock gateway, which has no
// intent store.
const goLiveSentRefs = new Set<string>();
const DRAFT_ALREADY_SENT =
  "GO-LIVE DRAFT_ALREADY_SENT: this approved draft was already sent once (or its outcome is still unknown); check open orders and positions";
// A send the order bridge refused before IBKR (engine_refused: engine policy v3 or the node ARM check)
// sent nothing, so the draft may be sent again; a store read that fails counts as sent.
const goLiveAlreadySent = async (
  store: IntentStore | undefined,
  orderRef: string
): Promise<boolean> => {
  if (goLiveSentRefs.has(orderRef)) return true;
  if (store === undefined) return false;
  try {
    return (
      (await store.hasIntent(orderRef)) && !(await store.refused(orderRef))
    );
  } catch {
    return true;
  }
};

/**
 * The go-live send gate (golive-send-gate.ts) for an order sent for a go-live draft; no lines
 * for any other order. A store or node read that fails refuses by name.
 */
const goLiveRefusals = async (
  context: ApiContext,
  draftId: string | undefined,
  order: VertexComboInput,
  account: OrderAccount,
  now: Date
): Promise<string[]> => {
  if (draftId === undefined) return [];
  const store = context.repositories.goLiveDrafts;
  if (store === undefined)
    return [
      "GO-LIVE STORE_UNAVAILABLE: the go-live draft store is not configured",
    ];
  let drafts: Awaited<ReturnType<typeof store.listDrafts>>;
  let plan: Awaited<ReturnType<typeof store.planInForce>>;
  try {
    [drafts, plan] = await Promise.all([
      store.listDrafts({ tradingDay: orderSessionDay(now) }),
      store.planInForce(),
    ]);
  } catch {
    return ["GO-LIVE STORE_UNAVAILABLE: the go-live drafts could not be read"];
  }
  const node = await (
    deps().goLiveNode ??
    ((c: ApiContext) => call(nautilusArmRouter.status, {}, { context: c }))
  )(context).catch(() => null);
  // The working go-live combos of the day hold the max loss of their approved order.
  const goLiveRisk = new Map<string, number>();
  for (const draft of drafts)
    if (draft.state === "approved" && draft.approvedOrder !== null)
      goLiveRisk.set(
        await goLiveOrderRef(draft.id),
        maxLoss(
          draft.structure,
          draft.approvedOrder.limitPrice,
          strikeWidth(draft),
          draft.approvedOrder.quantity
        )
      );
  // A go-live entry opens a new spread. One that touches a held contract would be read as a close by
  // the order bridge, which runs engine policy v3 and the ARM check on openings only: refused here.
  const held = order.legs.find((leg) =>
    account.positions.some(
      (p) =>
        p.secType === "OPT" &&
        p.quantity !== 0 &&
        p.symbol === order.symbol &&
        p.expiry === leg.expiry &&
        Math.abs(p.strike - leg.strike) < 1e-6 &&
        p.right === leg.right
    )
  );
  const notOpening =
    held === undefined
      ? []
      : [
          `GO-LIVE NOT_AN_OPENING: ${order.symbol} ${held.expiry} ${held.strike}${held.right} is held; a go-live entry opens a new spread only`,
        ];
  return [
    ...notOpening,
    ...goLiveSendRefusals({
      account,
      draftId,
      drafts,
      goLiveRisk,
      node,
      now,
      order,
      plan,
      // Only a bridge that reports engine policy v3 on every opening combo sends go-live drafts (owner
      // 2026-11-12, card vertex-golive-exec-intake): never the mock gateway or an older bridge.
      sendEnabled: account.gates.orderPolicy === GOLIVE_ENGINE_ORDER_POLICY,
    }),
  ];
};

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
    action,
    attributes: { userId: userOf(context), ...attributes },
    correlation: {
      ...(context.span?.correlation ?? {}),
      procedure: `vertexOrders.${action}`,
      requestId: context.requestId,
    },
    entityType: "option-order",
    eventId: crypto.randomUUID(),
    name: `vertex.orders.${action}`,
    occurredAt: deps().now().toISOString(),
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

// Order placements run one at a time in this process: a submit that arrives while another is
// placing is refused (RATE_LIMITED) without using its confirm token. Each placement then reads the
// account after the previous order is placed, so parallel submits cannot pass a per-name cap or
// the max-loss gate together on one stale snapshot. QuantVPS runs one web process; the bridge
// checks each order again on its own. Cancels are not gated.
// A lease, not a promise chain: workerd cancels a request whose client disconnects, and a
// promise shared across requests would then never settle. A submit makes two bridge calls in a
// row (account, then place), so the lease ends after two bridge timeouts plus 30 s, even when the
// cancelled request never reaches `finally`. After that, the live-mode order intent (written
// before `place`) still refuses new orders while its outcome is unknown.
const PLACEMENT_LEASE_MS = 2 * BRIDGE_TIMEOUT_MS + 30_000;
let placingUntil = 0;
const onePlacementAtATime = api.middleware(async ({ next, errors }) => {
  const now = Date.now();
  if (placingUntil > now)
    throw (errors as unknown as Failures).RATE_LIMITED({
      message: "Another order is being placed. Try again when it finishes.",
    });
  const lease = now + PLACEMENT_LEASE_MS;
  placingUntil = lease;
  try {
    return await next();
  } finally {
    // A late finish of an expired lease must not end a newer one.
    if (placingUntil === lease) placingUntil = 0;
  }
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

// Order intents with an unknown outcome (state-machine audit 2026-11-03, card sma-vertex-order-unknown).
// IBKR lists an accepted order at once. After this time, an order that is neither open nor visible as
// a position change is treated as not received.
const UNKNOWN_SETTLE_MS = 10 * 60_000;
const INTENT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

type IntentStore = NonNullable<ApiContext["repositories"]["orderIntents"]>;

// Live orders need the intent store; the mock uses it when it is wired.
const intentStoreOf = (
  context: ApiContext,
  gateway: OrderGatewayPort,
  failures: Failures
): IntentStore | undefined => {
  const store = context.repositories.orderIntents;
  if (store === undefined && gateway.mode === "live")
    throw failures.AUDIT_UNAVAILABLE({
      message: "Order intent store unavailable; nothing was sent",
    });
  return store;
};

// Writes the result row of a submit. A failed write never hides the gateway result.
const outcomeRecorder =
  (context: ApiContext, store: IntentStore | undefined, orderRef: string) =>
  async (outcome: "placed" | "unknown" | "refused" | "not-taken") =>
    await store
      ?.recordOutcome({
        action: "vertex.order.result",
        actorUserId: userOf(context),
        orderRef,
        outcome,
        requestId: context.requestId,
      })
      .catch(() => undefined);

// Writes the intent row before the gateway call. A go-live ref is written only with its claim
// (recordIntentOnce): another web process that sends the same draft at the same time gets false
// and sends nothing. With no store (the mock gateway, unwired) nothing is written: true.
const writeIntent = async (
  store: IntentStore | undefined,
  goLive: boolean,
  input: Parameters<IntentStore["recordIntent"]>[0]
): Promise<boolean> => {
  if (store === undefined) return true;
  if (goLive) return await store.recordIntentOnce(input);
  await store.recordIntent(input);
  return true;
};

// The outcome row of a combo submit, from the bridge state. "submitted": placed. "unconfirmed" (IBKR
// has not acknowledged it yet) and "unknown" (the bridge could not tell): it may still be live, so
// reconciliation checks it. "engine_refused": the bridge refused it before IBKR, so a go-live draft
// is free to be sent again. Any other state (for example "aborted") did not place the order but is
// no proof that nothing reached IBKR: "not-taken", never sent again.
const comboOutcome = (
  state: string
): "placed" | "unknown" | "refused" | "not-taken" => {
  if (state === "submitted") return "placed";
  if (state === "unconfirmed" || state === "unknown") return "unknown";
  return state === "engine_refused" ? "refused" : "not-taken";
};

const heldIn = (
  account: OrderAccount,
  contract: Parameters<typeof sameContract>[0]
): number =>
  account.positions
    .filter((p) => p.secType === "OPT" && sameContract(contract, p))
    .reduce((sum, p) => sum + p.quantity, 0);

// Resolves earlier intents with an unknown outcome against the account. Returns one refusal reason
// for each intent that is still unknown. Placements are gated by onePlacementAtATime.
const reconcileUnknown = async (
  context: ApiContext,
  store: IntentStore | undefined,
  account: OrderAccount,
  now: number
): Promise<string[]> => {
  if (store === undefined) return [];
  let pending: Awaited<ReturnType<IntentStore["unresolved"]>>;
  try {
    pending = await store.unresolved(new Date(now - INTENT_LOOKBACK_MS));
  } catch {
    return [
      "Order intent store unavailable: earlier orders cannot be checked, so no new order.",
    ];
  }
  const reasons: string[] = [];
  for (const intent of pending) {
    // Inside the settle window only an open order resolves an intent: a position change there may
    // come from another fill on the same contract.
    const settled = now - intent.createdAt.getTime() >= UNKNOWN_SETTLE_MS;
    let outcome: "open" | "position-changed" | "not-found" | null = null;
    if (account.openOrders.some((o) => o.orderRef === intent.orderRef))
      outcome = "open";
    else if (settled)
      outcome =
        heldIn(account, intent) === intent.heldBefore
          ? "not-found"
          : "position-changed";
    const unknown = `Earlier order ${intent.orderRef} (${intent.contract}) has an unknown outcome and may still reach IBKR. Wait until it shows in open orders or positions.`;
    if (outcome === null) {
      reasons.push(unknown);
      continue;
    }
    try {
      await store.recordOutcome({
        action: "vertex.order.reconciled",
        actorUserId: userOf(context),
        orderRef: intent.orderRef,
        outcome,
        requestId: context.requestId,
      });
    } catch {
      reasons.push(unknown);
      continue;
    }
    await audit(context, "reconcile", "success", {
      orderRef: intent.orderRef,
      result: outcome,
    });
  }
  return reasons;
};

const blockedBy = <T extends { accepted: boolean; reasons: string[] }>(
  review: T,
  reasons: readonly string[]
): T =>
  reasons.length === 0
    ? review
    : { ...review, accepted: false, reasons: [...review.reasons, ...reasons] };

// Final JEV order gate (merge plan P6): runs on every order, simulated and live (owner approval
// 2026-11-05). The account gates (kill switch, OPTIONS_ONLY) are inputs to the shared gate.
// VERTEX_ORDERS_ENABLED and VERTEX_ORDER_SUBMISSION still choose the gateway (liveAllowed).
const finalGateFor = (
  account: OrderAccount,
  order: FinalGateOrder,
  now: Date
): FinalGateDecision =>
  evaluateFinalOrderGate({
    accountGates: account.gates,
    accountValue: account.netLiquidation,
    jev: (deps().jevVerdict ?? readCachedJevVerdict)(order.symbol),
    now,
    order,
    positions: account.positions,
  });

const withFinalGate = <T extends { accepted: boolean; reasons: string[] }>(
  review: T,
  gate: FinalGateDecision
): T & { finalGate: FinalGateDecision } => ({
  ...blockedBy(
    review,
    gate.decision === "deny"
      ? gate.reasons.map((reason) => `Final gate: ${reason}`)
      : []
  ),
  finalGate: gate,
});

// Audit field for the final gate. A risk-reducing order sent without a fresh JEV verdict is
// recorded here (owner rule: logged and sent).
const gateAudit = (
  gate: FinalGateDecision
): Readonly<Record<string, string>> => ({
  finalGate: `${gate.decision} ${gate.structure} jev=${gate.jevState}`,
});

const singleGateOrder = (order: VertexOrderInput): FinalGateOrder => ({
  engine: "platform-ticket",
  legs: [
    {
      expiry: order.expiry,
      ratio: 1,
      right: order.right,
      secType: order.secType,
      side: order.side,
      strike: order.strike,
    },
  ],
  limitPrice: order.limitPrice,
  quantity: order.quantity,
  reason: "owner order screen",
  symbol: order.symbol,
});

const comboGateOrder = (order: VertexComboInput): FinalGateOrder => ({
  engine: "platform-ticket",
  legs: order.legs.map((leg) => ({ ...leg, secType: "OPT" })),
  limitPrice: order.limitPrice,
  quantity: order.quantity,
  reason: "owner order screen",
  symbol: order.symbol,
});

// A combo that reverses held legs is a close (evaluateCombo). Any other combo opens a vertical
// (evaluateOpeningCombo, final gate) on both gateways: the live order tail accepts defined-risk
// opening verticals since card vertex-bridge-killswitch-closes (market-watch-bot PR #36).
const reviewCombo = (
  order: VertexComboInput,
  account: OrderAccount,
  now: Date
) => {
  const gateOrder = comboGateOrder(order);
  const opening = !isRiskReducing(gateOrder, account.positions);
  return withFinalGate(
    (opening ? evaluateOpeningCombo : evaluateCombo)(order, account, now),
    finalGateFor(account, gateOrder, now)
  );
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
    const review = blockedBy(
      withFinalGate(
        evaluateOrder(input, account, now),
        finalGateFor(account, singleGateOrder(input), now)
      ),
      await reconcileUnknown(
        context,
        intentStoreOf(context, gateway, failures),
        account,
        now.getTime()
      )
    );
    const expiresAt = now.getTime() + CONFIRM_TTL_MS;
    const confirmToken = review.accepted
      ? await issueConfirmToken(config.confirmSecret, {
          action: orderAction(input),
          expiresAt,
          nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
          userId: userOf(context),
        })
      : null;
    await audit(context, "preview", review.accepted ? "success" : "failure", {
      contract: review.contractLabel,
      limitPrice: input.limitPrice,
      mode: gateway.mode,
      quantity: input.quantity,
      result: review.accepted ? "accepted" : review.reasons.join(" | "),
      side: input.side,
      ...gateAudit(review.finalGate),
    });
    return {
      confirmToken,
      expiresAt:
        confirmToken === null ? null : new Date(expiresAt).toISOString(),
      gates: gatesOf(config, gateway, account),
      review,
    };
  });

const submit = api.vertexOrders.submit
  .use(requireOperator)
  .use(requireOwner)
  .use(onePlacementAtATime)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "submit");
    const config = configOf(context, failures);
    const now = deps().now();
    const label = contractLabel(input.order);
    const base = {
      contract: label,
      limitPrice: input.order.limitPrice,
      quantity: input.order.quantity,
      side: input.order.side,
    };
    const claims = await consumeConfirmToken(
      config.confirmSecret,
      input.confirmToken,
      { action: orderAction(input.order), userId: userOf(context) },
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
    const store = intentStoreOf(context, gateway, failures);
    const account = await guarded(failures, gateway.account, auditFailure);
    const review = blockedBy(
      withFinalGate(
        evaluateOrder(input.order, account, now),
        finalGateFor(account, singleGateOrder(input.order), now)
      ),
      await reconcileUnknown(context, store, account, now.getTime())
    );
    if (!review.accepted) {
      await auditFailure(review.reasons.join(" | "));
      throw failures.ORDER_REJECTED({ message: review.reasons.join(" ") });
    }
    // The Vertex order tail (market-watch-bot ops/vertex_order_tail.py) accepts only "vertex-" orderRefs.
    const orderRef = `vertex-${claims.nonce}`;
    await requireAudit(context, failures, "submit", {
      ...base,
      mode: gateway.mode,
      orderRef,
      ...gateAudit(review.finalGate),
    });
    const outcomeOf = outcomeRecorder(context, store, orderRef);
    try {
      await store?.recordIntent({
        actorUserId: userOf(context),
        intent: {
          contract: label,
          expiry: input.order.expiry,
          heldBefore: heldIn(account, input.order),
          orderRef,
          right: input.order.right,
          strike: input.order.strike,
          symbol: input.order.symbol,
        },
        requestId: context.requestId,
      });
    } catch {
      await auditFailure("intent store unavailable");
      throw failures.AUDIT_UNAVAILABLE({
        message: "Order intent store unavailable; nothing was sent",
      });
    }
    // A failed or timed-out place call may still reach IBKR: the intent stays "unknown" and the next
    // preview reconciles it before any new order.
    let result: Awaited<ReturnType<OrderGatewayPort["place"]>>;
    try {
      result = await gateway.place(input.order, orderRef);
    } catch (error) {
      const detail =
        error instanceof OrderGatewayError ? error.message : "gateway error";
      await outcomeOf("unknown");
      await auditFailure(`outcome unknown: ${detail}`);
      if (error instanceof OrderGatewayError)
        throw failures[error.code]({
          message: `Outcome unknown (${detail}): the order may still reach IBKR. The next preview checks it first.`,
        });
      throw error;
    }
    // "unconfirmed": IBKR has not acknowledged the order yet; it may still be live.
    await outcomeOf(result.state === "unconfirmed" ? "unknown" : "placed");
    // Only "submitted" and "unconfirmed" reached IBKR; any other state (for example "aborted")
    // is a refusal and is audited as a failure.
    await audit(
      context,
      "submit",
      result.state === "submitted" || result.state === "unconfirmed"
        ? "success"
        : "failure",
      {
        ...base,
        mode: gateway.mode,
        orderRef,
        result: result.state,
      }
    );
    return { mode: gateway.mode, orderRef, ...result };
  });

const comboPreview = api.vertexOrders.comboPreview
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "preview");
    const config = configOf(context, failures);
    const gateway = selectOrderGateway(config);
    const { goLiveDraftId, ...order } = input;
    const account = await guarded(failures, gateway.account);
    const now = deps().now();
    const store = intentStoreOf(context, gateway, failures);
    const review = blockedBy(reviewCombo(order, account, now), [
      ...(await reconcileUnknown(context, store, account, now.getTime())),
      ...(await goLiveRefusals(context, goLiveDraftId, order, account, now)),
      ...(goLiveDraftId !== undefined &&
      (await goLiveAlreadySent(store, await goLiveOrderRef(goLiveDraftId)))
        ? [DRAFT_ALREADY_SENT]
        : []),
    ]);
    const expiresAt = now.getTime() + CONFIRM_TTL_MS;
    const confirmToken = review.accepted
      ? await issueConfirmToken(config.confirmSecret, {
          action: comboAction(order, goLiveDraftId),
          expiresAt,
          nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
          userId: userOf(context),
        })
      : null;
    await audit(
      context,
      "comboPreview",
      review.accepted ? "success" : "failure",
      {
        contract: review.label,
        limitPrice: order.limitPrice,
        mode: gateway.mode,
        quantity: order.quantity,
        result: review.accepted ? "accepted" : review.reasons.join(" | "),
        ...(goLiveDraftId === undefined ? {} : { goLiveDraftId }),
        ...gateAudit(review.finalGate),
      }
    );
    return {
      confirmToken,
      expiresAt:
        confirmToken === null ? null : new Date(expiresAt).toISOString(),
      gates: gatesOf(config, gateway, account),
      review,
    };
  });

const comboSubmit = api.vertexOrders.comboSubmit
  .use(requireOperator)
  .use(requireOwner)
  .use(onePlacementAtATime)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    rateCheck(context, failures, "submit");
    const config = configOf(context, failures);
    const now = deps().now();
    const order = input.order;
    const base = {
      contract: `${order.symbol} combo (${order.legs.length} legs)`,
      limitPrice: order.limitPrice,
      quantity: order.quantity,
    };
    const claims = await consumeConfirmToken(
      config.confirmSecret,
      input.confirmToken,
      {
        action: comboAction(order, input.goLiveDraftId),
        userId: userOf(context),
      },
      now.getTime()
    );
    if (claims === null) {
      await audit(context, "comboSubmit", "failure", {
        ...base,
        result: "confirm invalid",
      });
      throw failures.CONFIRM_INVALID();
    }
    const gateway = selectOrderGateway(config);
    const auditFailure = (outcome: string) =>
      audit(context, "comboSubmit", "failure", {
        ...base,
        mode: gateway.mode,
        result: outcome,
      });
    const store = intentStoreOf(context, gateway, failures);
    const goLiveRef =
      input.goLiveDraftId === undefined
        ? null
        : await goLiveOrderRef(input.goLiveDraftId);
    const account = await guarded(failures, gateway.account, auditFailure);
    const review = blockedBy(reviewCombo(order, account, now), [
      ...(await reconcileUnknown(context, store, account, now.getTime())),
      ...(await goLiveRefusals(
        context,
        input.goLiveDraftId,
        order,
        account,
        now
      )),
      ...(goLiveRef !== null && (await goLiveAlreadySent(store, goLiveRef))
        ? [DRAFT_ALREADY_SENT]
        : []),
    ]);
    if (!review.accepted) {
      await auditFailure(review.reasons.join(" | "));
      throw failures.ORDER_REJECTED({ message: review.reasons.join(" ") });
    }
    // The review above refused a ref already sent. Reserve it now, with no await since that check
    // (onePlacementAtATime runs one submit at a time in this process), so a later submit of the
    // same draft is refused while this one is in flight.
    if (goLiveRef !== null) goLiveSentRefs.add(goLiveRef);
    const orderRef = goLiveRef ?? `vertex-${claims.nonce}`;
    // Nothing is sent before the intent row exists: a failure until then frees the reservation.
    const release = () => {
      if (goLiveRef !== null) goLiveSentRefs.delete(goLiveRef);
    };
    await requireAudit(context, failures, "comboSubmit", {
      ...base,
      mode: gateway.mode,
      orderRef,
      ...gateAudit(review.finalGate),
    }).catch((error: unknown) => {
      release();
      throw error;
    });
    // The intent tracks the first leg: reconciliation finds the orderRef in open orders, or a changed
    // position in that leg after the wait.
    // The contract schema requires at least two legs.
    const [first] = order.legs as [VertexComboLeg, ...VertexComboLeg[]];
    const leg = {
      expiry: first.expiry,
      right: first.right,
      strike: first.strike,
      symbol: order.symbol,
    };
    const intentInput = {
      actorUserId: userOf(context),
      intent: {
        contract: review.label,
        orderRef,
        ...leg,
        heldBefore: heldIn(account, leg),
      },
      requestId: context.requestId,
    };
    let claimed: boolean;
    try {
      claimed = await writeIntent(store, goLiveRef !== null, intentInput);
    } catch {
      release();
      await auditFailure("intent store unavailable");
      throw failures.AUDIT_UNAVAILABLE({
        message: "Order intent store unavailable; nothing was sent",
      });
    }
    if (!claimed) {
      release();
      await auditFailure(DRAFT_ALREADY_SENT);
      throw failures.ORDER_REJECTED({ message: DRAFT_ALREADY_SENT });
    }
    const outcomeOf = outcomeRecorder(context, store, orderRef);
    let result: Awaited<ReturnType<OrderGatewayPort["placeCombo"]>>;
    try {
      result = await gateway.placeCombo(order, orderRef);
    } catch (error) {
      const detail =
        error instanceof OrderGatewayError ? error.message : "gateway error";
      await outcomeOf("unknown");
      await auditFailure(`outcome unknown: ${detail}`);
      if (error instanceof OrderGatewayError)
        throw failures[error.code]({
          message: `Outcome unknown (${detail}): the order may still reach IBKR. The next preview checks it first.`,
        });
      throw error;
    }
    const engineRefused = result.state === "engine_refused";
    await outcomeOf(comboOutcome(result.state));
    if (engineRefused) release();
    // Only "submitted" and "unconfirmed" reached IBKR; any other state (for example "aborted")
    // is a refusal and is audited as a failure.
    await audit(
      context,
      "comboSubmit",
      result.state === "submitted" || result.state === "unconfirmed"
        ? "success"
        : "failure",
      {
        ...base,
        mode: gateway.mode,
        orderRef,
        result: result.state,
      }
    );
    return { mode: gateway.mode, orderRef, ...result };
  });

const findOrder = (
  failures: Failures,
  account: OrderAccount,
  permId: number
): GatewayOpenOrder => {
  const order = account.openOrders.find((o) => o.permId === permId);
  if (
    order === undefined ||
    (order.secType !== "OPT" && order.secType !== "BAG")
  )
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
      action: `cancel:${input.permId}`,
      expiresAt,
      nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
      userId: userOf(context),
    });
    await audit(context, "cancelPreview", "success", {
      contract: order.symbol,
      mode: gateway.mode,
      permId: input.permId,
    });
    return {
      confirmToken,
      expiresAt: new Date(expiresAt).toISOString(),
      gates: gatesOf(config, gateway, account),
      order: toOpenOrder(order),
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
      { action: `cancel:${input.permId}`, userId: userOf(context) },
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
        mode: gateway.mode,
        permId: input.permId,
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
      contract: order.symbol,
      mode: gateway.mode,
      permId: input.permId,
    });
    const result = await guarded(
      failures,
      () => gateway.cancel(input.permId),
      auditFailure
    );
    await audit(context, "cancel", "success", {
      contract: order.symbol,
      mode: gateway.mode,
      permId: input.permId,
      result: result.state,
    });
    return { mode: gateway.mode, orderRef: order.orderRef, ...result };
  });

export const vertexOrdersRouter = {
  cancelPreview,
  cancelSubmit,
  comboPreview,
  comboSubmit,
  preview,
  status,
  submit,
};
