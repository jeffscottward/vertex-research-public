import type {
  GoLiveDraftRecord,
  GoLivePlanRecord,
} from "@darkfactory/db/server";

import type { NautilusArmStatusOutput } from "../contracts/nautilus-arm.ts";
import type { VertexComboInput } from "../contracts/vertex-orders.ts";
import {
  maxLoss,
  orderSessionDay,
  sameCombo,
  strikeWidth,
} from "./golive-drafts-sizing.ts";
import {
  checkSendCaps,
  type HeldPosition,
  type SendCapRefusal,
  type WorkingOrderRisk,
} from "./golive-send-caps.ts";
import type { GatewayOpenOrder } from "./vertex-orders-rules.ts";

// Go-live send gate (GO-LIVE 4 steps 2 and 3, owner 2026-11-12). An order sent for a go-live
// draft (combo preview/submit with goLiveDraftId) passes, on top of every rule of the owner order
// screen (opening vertical, kill switch, 2% gate, final JEV gate, confirm token, audit):
// - the draft is an approved ENTRY of the order session day and the order is exactly the order
//   stored with the owner's approval (to the cent and the contract);
// - the execution node is ARMED by the owner now (nautilusArm.status badge running-armed);
// - the plan caps at send, counting the account's open positions and working orders
//   (golive-send-caps.ts).
// Each refusal is one named line; nothing here sends, arms or approves.

const GOLIVE_SEND_REFUSAL_PREFIX = "GO-LIVE";

export type GoLiveSendInputs = Readonly<{
  account: Readonly<{
    netLiquidation: number | null;
    openOrders: readonly GatewayOpenOrder[];
    positions: readonly HeldPosition[];
  }>;
  draftId: string;
  drafts: readonly GoLiveDraftRecord[];
  node: Pick<NautilusArmStatusOutput, "arm" | "badge" | "checkedAt"> | null;
  now: Date;
  order: VertexComboInput;
  plan: GoLivePlanRecord | null;
}>;

const line = (code: string, text: string): string =>
  `${GOLIVE_SEND_REFUSAL_PREFIX} ${code}: ${text}`;

const CAP_TEXT: Readonly<Record<SendCapRefusal, string>> = {
  NAME_CAP:
    "the name would hold more than the plan's name cap of the account value",
  NLV_UNAVAILABLE: "the account value is not available",
  OPEN_RISK_CAP:
    "open positions + working orders + this order would exceed the plan's total risk cap",
  POSITION_CAP: "this order's max loss is above the plan's per-position cap",
  UNDEFINED_RISK_HELD:
    "the account holds a short option that no long covers; nothing opens until it is closed",
  WORKING_ORDER_RISK_UNKNOWN:
    "a working order's max loss cannot be read; wait for it or cancel it first",
};

/**
 * Max loss of each working order, conservatively: a share order and an option SELL that reduces
 * a held long take no new risk; an option BUY limit takes limit x quantity x 100; anything else
 * (a combo, a SELL that would open a short, no limit) is unknown.
 */
export const workingOrderRisks = (
  orders: readonly GatewayOpenOrder[],
  positions: readonly HeldPosition[]
): WorkingOrderRisk[] =>
  orders.map((order) => {
    if (order.secType === "STK") return { maxLoss: 0, symbol: order.symbol };
    if (order.secType === "OPT" && order.side === "SELL") {
      const held = positions.find(
        (p) =>
          p.secType === "OPT" &&
          p.symbol === order.symbol &&
          p.expiry === order.expiry &&
          p.strike === order.strike &&
          p.right === order.right
      );
      return {
        maxLoss:
          held !== undefined && held.quantity >= order.quantity ? 0 : null,
        symbol: order.symbol,
      };
    }
    if (
      order.secType === "OPT" &&
      order.side === "BUY" &&
      order.limitPrice !== null
    )
      return {
        maxLoss: order.limitPrice * order.quantity * 100,
        symbol: order.symbol,
      };
    return { maxLoss: null, symbol: order.symbol };
  });

/** The named refusals of sending this order for this draft now; empty = allowed. */
export const goLiveSendRefusals = (input: GoLiveSendInputs): string[] => {
  const day = orderSessionDay(input.now);
  const draft = input.drafts.find(
    (d) => d.id === input.draftId && d.tradingDay === day
  );
  if (draft === undefined)
    return [line("DRAFT_NOT_FOUND", `no draft ${input.draftId} on ${day}`)];
  const refusals: string[] = [];
  if (draft.kind !== "entry" || draft.state !== "approved")
    refusals.push(
      line("DRAFT_NOT_APPROVED", "only an approved entry draft is sent")
    );
  if (
    draft.approvedOrder === null ||
    !sameCombo(input.order, draft.approvedOrder)
  )
    refusals.push(
      line(
        "ORDER_NOT_APPROVED",
        "the order is not the exact order the owner approved for this draft"
      )
    );
  if (input.node?.badge !== "running-armed")
    refusals.push(
      line(
        "ENGINE_DISARMED",
        `approved, engine ${input.node === null ? "status unknown" : input.node.badge} (checked ${input.node?.checkedAt ?? input.now.toISOString()}); the owner arms the node`
      )
    );
  const plan = input.plan;
  if (plan === null || plan.status !== "approved" || plan.id !== draft.planId)
    refusals.push(
      line(
        "PLAN_NOT_IN_FORCE",
        "the draft's plan is not the approved plan in force"
      )
    );
  else {
    const caps = checkSendCaps({
      limits: plan.limits,
      nlv: input.account.netLiquidation,
      orderMaxLoss: maxLoss(
        draft.structure,
        input.order.limitPrice,
        strikeWidth(draft),
        input.order.quantity
      ),
      positions: input.account.positions,
      symbol: input.order.symbol,
      working: workingOrderRisks(
        input.account.openOrders,
        input.account.positions
      ),
    });
    for (const code of caps.refusals) refusals.push(line(code, CAP_TEXT[code]));
  }
  return refusals;
};
