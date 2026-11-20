import type {
  GoLiveDraftOutput,
  GoLiveQueueOutput,
  VertexOrdersStatus,
} from "@darkfactory/api";

import { strikesText, structureText } from "./golive-draft-queue-model.ts";

// Portfolio "Drafts and orders" (owner 2026-11-20): the open order drafts of the trading day and
// the working IBKR orders, so the owner sees from the portfolio page what waits for him. Read
// only: this view never approves, arms or sends anything.

export type DraftRow = Readonly<{
  href: string;
  id: string;
  label: string;
  maxLoss: number | null;
  state: string;
  waitingFor: string;
}>;

export type OrderRow = Readonly<{
  key: string;
  label: string;
  status: string;
}>;

// null: the feed was not read (error or not ready). An empty list is a definite "none".
export type DraftsAndOrdersView = Readonly<{
  checkedAt: Date;
  drafts: readonly DraftRow[] | null;
  orders: readonly OrderRow[] | null;
}>;

const SEND_WAIT: Readonly<
  Record<NonNullable<GoLiveDraftOutput["send"]>, string>
> = {
  not_found: "Check at IBKR: the order was not found",
  not_sent: "Arm, then Send approved order",
  not_taken: "Check at IBKR: the order was not taken",
  refused: "Arm, then Send approved order (last send was refused)",
  sent: "IBKR fill",
  unavailable: "Send state not read: the order store did not answer",
  unknown: "The IBKR answer to the send",
};

/** What the owner (or IBKR) must do next for one draft. */
export const waitingFor = (draft: GoLiveDraftOutput): string => {
  if (draft.state === "proposed")
    return draft.notApprovable.length === 0
      ? "Your Approve"
      : "Cannot be approved now (see the draft)";
  if (draft.state === "approved")
    return draft.send === null ? "Send state not shown" : SEND_WAIT[draft.send];
  return "Nothing";
};

/** Open drafts: proposed, or approved and not yet known to be sent. */
export const draftRows = (queue: GoLiveQueueOutput): DraftRow[] =>
  queue.drafts
    .filter((draft) => draft.state === "proposed" || draft.state === "approved")
    .map((draft) => ({
      href: `/drafts#draft-${draft.id}`,
      id: draft.id,
      label: `${draft.symbol} ${structureText(draft.structure)} ${draft.expiry} ${strikesText(draft)}`,
      maxLoss: draft.approvedRoom?.maxLoss ?? draft.sizing.maxLoss ?? null,
      state: draft.state,
      waitingFor: waitingFor(draft),
    }));

const orderLabel = (order: VertexOrdersStatus["openOrders"][number]): string =>
  [
    order.side,
    order.quantity,
    order.symbol,
    order.secType,
    order.expiry,
    order.strike,
    order.right,
    order.limitPrice === null ? order.orderType : `@ ${order.limitPrice}`,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" ");

export const orderRows = (status: VertexOrdersStatus): OrderRow[] =>
  status.openOrders.map((order) => ({
    key: `${order.permId}-${order.orderRef}`,
    label: orderLabel(order),
    status: order.status,
  }));

export const moneyText = (value: number | null): string =>
  value === null
    ? "not sized"
    : value.toLocaleString("en-US", {
        currency: "USD",
        maximumFractionDigits: 0,
        style: "currency",
      });

export const checkedText = (at: Date): string =>
  at.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });

/** The one-line summary: definite when both feeds were read, unknown otherwise. */
export const summaryText = (view: DraftsAndOrdersView): string => {
  const at = checkedText(view.checkedAt);
  const drafts =
    view.drafts === null
      ? "Drafts not loaded: the draft list request failed."
      : view.drafts.length === 0
        ? "No drafts."
        : `${view.drafts.length} open draft${view.drafts.length === 1 ? "" : "s"}.`;
  const orders =
    view.orders === null
      ? "Working IBKR orders not loaded: the order feed is not ready."
      : view.orders.length === 0
        ? "No working orders at IBKR."
        : `${view.orders.length} working order${view.orders.length === 1 ? "" : "s"} at IBKR.`;
  return `${drafts} ${orders} Checked ${at}.`;
};
