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
  // orderRef -> max loss of the approved order, for the go-live combos of the day.
  goLiveRisk?: ReadonlyMap<string, number>;
  // true only when the order gateway is a bridge that reports engine policy v3 + the node ARM check on
  // every opening combo (account gates.orderPolicy; owner 2026-11-12, card vertex-golive-exec-intake);
  // false refuses every go-live send by name (V3_NOT_ON_LIVE_PATH): mock gateway, older bridge.
  sendEnabled: boolean;
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
 * Max loss of each working order, conservatively: a share SELL takes no new risk and a share BUY
 * takes its limit x quantity; option SELLs that together stay within a held long take no new
 * risk; an option BUY limit takes limit x quantity x 100; a go-live combo (its orderRef is in
 * goLiveRisk) takes the max loss of the order the owner approved; anything else (another combo,
 * a SELL that would open a short, no limit) is unknown.
 */
export const workingOrderRisks = (
  orders: readonly GatewayOpenOrder[],
  positions: readonly HeldPosition[],
  goLiveRisk: ReadonlyMap<string, number> = new Map()
): WorkingOrderRisk[] => {
  const sellLeft = new Map<string, number>();
  for (const p of positions)
    if (p.secType === "OPT" && p.quantity > 0)
      sellLeft.set(
        JSON.stringify([p.symbol, p.expiry, p.strike, p.right]),
        p.quantity
      );
  return orders.map((order) => {
    const symbol = order.symbol;
    const known = goLiveRisk.get(order.orderRef);
    if (known !== undefined) return { maxLoss: known, symbol };
    if (order.secType === "STK")
      return {
        maxLoss:
          order.side === "SELL"
            ? 0
            : order.limitPrice === null
              ? null
              : order.limitPrice * order.quantity,
        symbol,
      };
    if (order.secType === "OPT" && order.side === "SELL") {
      const key = JSON.stringify([
        symbol,
        order.expiry,
        order.strike,
        order.right,
      ]);
      const left = sellLeft.get(key) ?? 0;
      if (left < order.quantity) return { maxLoss: null, symbol };
      sellLeft.set(key, left - order.quantity);
      return { maxLoss: 0, symbol };
    }
    if (
      order.secType === "OPT" &&
      order.side === "BUY" &&
      order.limitPrice !== null
    )
      return { maxLoss: order.limitPrice * order.quantity * 100, symbol };
    return { maxLoss: null, symbol };
  });
};

/** The named refusals of sending this order for this draft now; empty = allowed. */
export const goLiveSendRefusals = (input: GoLiveSendInputs): string[] => {
  const day = orderSessionDay(input.now);
  const draft = input.drafts.find(
    (d) => d.id === input.draftId && d.tradingDay === day
  );
  const refusals: string[] = input.sendEnabled
    ? []
    : [
        line(
          "V3_NOT_ON_LIVE_PATH",
          "the order gateway does not report engine policy v3 on the live path (simulated gateway or an older bridge), so go-live sends are off; the approval is recorded"
        ),
      ];
  if (draft === undefined)
    return [
      ...refusals,
      line("DRAFT_NOT_FOUND", `no draft ${input.draftId} on ${day}`),
    ];
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
    // The plan caps measure the plan's own book: positions and working orders on the plan's
    // names (every sleeve symbol). Positions the owner holds outside the plan (manual entries,
    // owner 2026-11-12) stay under the bridge's own premium and 2% gates, not the plan's 4%.
    const planNames = new Set(plan.sleeves.flatMap((sleeve) => sleeve.symbols));
    planNames.add(draft.symbol);
    const positions = input.account.positions.filter((p) =>
      planNames.has(p.symbol)
    );
    const caps = checkSendCaps({
      limits: plan.limits,
      nlv: input.account.netLiquidation,
      orderMaxLoss: maxLoss(
        draft.structure,
        input.order.limitPrice,
        strikeWidth(draft),
        input.order.quantity
      ),
      positions,
      symbol: input.order.symbol,
      working: workingOrderRisks(
        input.account.openOrders.filter((o) => planNames.has(o.symbol)),
        positions,
        input.goLiveRisk
      ),
    });
    for (const code of caps.refusals) refusals.push(line(code, CAP_TEXT[code]));
  }
  return refusals;
};
