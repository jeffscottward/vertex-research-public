"use client";

import type {
  PortfolioMonitorPosition,
  VertexOrderPreviewOutput as Preview,
} from "@darkfactory/api";
import { Button, Input, Label, StatusBadge } from "@darkfactory/ui";
import { useEffect, useId, useRef, useState } from "react";

import { ComboOrderDialog } from "./position-combo-dialog.tsx";
import {
  type ComboDraft,
  type PositionAction,
  type PositionOrderDraft,
  actionsUnavailableReason,
  comboDraft,
  defaultLimit,
  draftFor,
  estimatedAmount,
  parseOptionContract,
  shareContract,
  spreadGroup,
  toPositionOrderInput,
} from "./position-actions-model.ts";
import {
  orderErrorMessage,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

// Per-position Close / Buy / Sell buttons (owner 2026-11-04). A click opens a confirm dialog.
// Nothing is sent until the owner presses the send button there; the server applies every order
// rule (kill switch, caps, options only, unknown-outcome block) on preview and again on submit.

const usd = (value: number | null): string =>
  value === null
    ? "unknown"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD" });

const ACTION_LABEL: Readonly<Record<PositionAction, string>> = {
  close: "Close",
  buy: "Buy",
  sell: "Sell",
};

const Row = ({ label, value }: Readonly<{ label: string; value: string }>) => (
  <div className="flex justify-between gap-4 border-border border-b py-1.5 text-sm">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-right font-medium tabular-nums">{value}</dd>
  </div>
);

type DialogProps = Readonly<{
  action: PositionAction;
  draft: PositionOrderDraft;
  gateway: VertexOrdersGateway;
  onClose: () => void;
  position: PortfolioMonitorPosition;
}>;

const PositionOrderDialog = ({
  action,
  draft,
  gateway,
  onClose,
  position,
}: DialogProps) => {
  const titleId = useId();
  const [marketable, setMarketable] = useState(action === "close");
  const [quantity, setQuantity] = useState(String(draft.quantity));
  const [limit, setLimit] = useState(
    draft.limitPrice === null ? "" : String(draft.limitPrice)
  );
  const [review, setReview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Focus Cancel once on open (a safe default); Escape cancels.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // While a request runs, Escape is ignored so the result stays visible.
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const qty = Number(quantity);
  const price = Number(limit);
  const valid =
    Number.isInteger(qty) && qty > 0 && Number.isFinite(price) && price > 0;
  const shares = draft.secType === "STK";
  const amount = valid ? estimatedAmount(qty, price, shares ? 1 : 100) : null;
  const { contract } = draft;
  const offsetPct = shares ? 1 : 5;
  const title = shares
    ? `${ACTION_LABEL[action]} ${contract.symbol} shares`
    : `${ACTION_LABEL[action]} ${contract.symbol} ${contract.expiry} ${contract.strike} ${contract.right === "C" ? "call" : "put"}`;

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await step();
    } catch (error) {
      setMessage(orderErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const onMarketable = (next: boolean) => {
    setMarketable(next);
    setReview(null);
    const value = defaultLimit(
      position.last,
      draft.side,
      next,
      offsetPct / 100
    );
    if (value !== null) setLimit(String(value));
  };

  const onReview = () =>
    run(async () => {
      setReview(await gateway.preview(toPositionOrderInput(draft, qty, price)));
    });

  const onSend = (current: Preview, token: string) =>
    run(async () => {
      const result = await gateway.submit({
        order: current.review.order,
        confirmToken: token,
        confirm: true,
      });
      setSent(true);
      setReview(null);
      setMessage(`Order ${result.state} (${result.mode}): ${result.message}`);
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      data-position-order-dialog={action}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
        role="dialog"
      >
        <h2 className="font-semibold text-lg" id={titleId}>
          {title}
        </h2>
        <dl>
          <Row label="Symbol" value={contract.symbol} />
          <Row label="Side" value={draft.side} />
          <Row
            label={shares ? "Held shares" : "Held contracts"}
            value={String(position.position)}
          />
          <Row label="Order type" value="Limit (LMT), day" />
          <Row
            label={
              draft.side === "BUY" ? "Estimated cost" : "Estimated proceeds"
            }
            value={usd(amount)}
          />
        </dl>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${titleId}-qty`}>
              {shares ? "Shares" : "Contracts"}
            </Label>
            <Input
              id={`${titleId}-qty`}
              inputMode="numeric"
              min="1"
              onChange={(event) => {
                setQuantity(event.target.value);
                setReview(null);
              }}
              step="1"
              type="number"
              value={quantity}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${titleId}-limit`}>Limit price</Label>
            <Input
              id={`${titleId}-limit`}
              inputMode="decimal"
              min="0.01"
              onChange={(event) => {
                setLimit(event.target.value);
                setReview(null);
              }}
              step="0.01"
              type="number"
              value={limit}
            />
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            checked={marketable}
            className="size-4"
            onChange={(event) => onMarketable(event.target.checked)}
            type="checkbox"
          />
          Marketable limit (mark {draft.side === "BUY" ? "+" : "−"} {offsetPct}
          %)
        </label>
        <p className="text-muted-foreground text-xs">
          Default limit is the IBKR mark ({usd(position.last)}). Options are
          never exercised.
        </p>
        {message === null ? null : (
          <p
            className="rounded-md border border-border p-3 text-sm"
            role="alert"
          >
            {message}
          </p>
        )}
        {review === null ? null : review.review.accepted ? (
          <StatusBadge status="success">
            {review.gates.mode === "live"
              ? "Passes all order rules · LIVE IBKR"
              : "Passes all order rules · simulated (orders disabled)"}
          </StatusBadge>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-destructive text-sm">
            {review.review.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            disabled={busy}
            onClick={onClose}
            ref={cancelRef}
            variant="outline"
          >
            {sent ? "Close" : "Cancel"}
          </Button>
          {sent ? null : review?.confirmToken ? (
            <Button
              disabled={busy}
              onClick={() => void onSend(review, review.confirmToken as string)}
              variant={action === "buy" ? "primary" : "destructive"}
            >
              {review.gates.mode === "live"
                ? `Confirm: send ${draft.side} to IBKR`
                : `Confirm: send ${draft.side} (simulated)`}
            </Button>
          ) : (
            <Button disabled={busy || !valid} onClick={() => void onReview()}>
              Review order
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

const SPREAD_REASON = "Part of a spread: use Close (one combo order)";

const PositionActions = ({
  disabledReason,
  onAction,
  onCombo,
  position,
  positions,
}: Readonly<{
  disabledReason: string | null;
  onAction: (action: PositionAction, draft: PositionOrderDraft) => void;
  onCombo: (draft: ComboDraft) => void;
  position: PortfolioMonitorPosition;
  positions: readonly PortfolioMonitorPosition[];
}>) => {
  const share = shareContract(position);
  if (share !== null)
    return (
      <div className="flex gap-1">
        <Button
          aria-label={`Close ${position.symbol} shares`}
          data-position-action="close"
          onClick={() =>
            onAction("close", draftFor(share, position, "close", true, "STK"))
          }
          size="compact"
          variant="destructive"
        >
          Close
        </Button>
      </div>
    );
  const contract = parseOptionContract(position);
  const group = spreadGroup(position, positions);
  if (contract === null || group === "unparsed")
    return (
      <span className="text-muted-foreground text-xs">
        {actionsUnavailableReason(position)}
      </span>
    );
  const actions: readonly PositionAction[] = ["close", "buy", "sell"];
  // Close is always available (owner 2026-11-04: close no matter what; the server checks it).
  // The kill switch and unknown gates disable only Buy and Sell.
  const reasonFor = (action: PositionAction): string | null =>
    action === "close"
      ? null
      : (disabledReason ?? (group === null ? null : SPREAD_REASON));
  const onClick = (action: PositionAction) => {
    if (group === null)
      onAction(
        action,
        draftFor(contract, position, action, action === "close")
      );
    else onCombo(comboDraft(contract.symbol, group, true));
  };
  return (
    <div className="flex gap-1">
      {actions.map((action) => (
        <Button
          aria-label={`${ACTION_LABEL[action]} ${position.description}`}
          data-position-action={action}
          disabled={reasonFor(action) !== null}
          key={action}
          onClick={() => onClick(action)}
          size="compact"
          title={reasonFor(action) ?? undefined}
          variant={action === "close" ? "destructive" : "secondary"}
        >
          {ACTION_LABEL[action]}
        </Button>
      ))}
    </div>
  );
};

// Order buttons for a positions table: loads the order gates once (kill switch disables every
// button) and owns the one open dialog.
export const usePositionActions = (
  gateway: VertexOrdersGateway | undefined
) => {
  const [killSwitch, setKillSwitch] = useState<boolean | null>(null);
  const [open, setOpen] = useState<Readonly<{
    action: PositionAction;
    draft: PositionOrderDraft;
    position: PortfolioMonitorPosition;
  }> | null>(null);
  const [combo, setCombo] = useState<ComboDraft | null>(null);
  useEffect(() => {
    if (gateway === undefined) return;
    // A synchronous throw (no API client) also ends as "gates unknown".
    Promise.resolve()
      .then(() => gateway.status({}))
      .then((status) => setKillSwitch(status.gates.killSwitch))
      .catch(() => setKillSwitch(null));
  }, [gateway]);
  if (gateway === undefined) return null;
  const disabledReason =
    killSwitch === true
      ? "Kill switch on: Close only"
      : killSwitch === null
        ? "Order gates unknown"
        : null;
  return {
    cell: (
      position: PortfolioMonitorPosition,
      positions: readonly PortfolioMonitorPosition[]
    ) => (
      <PositionActions
        disabledReason={disabledReason}
        onAction={(action, draft) => setOpen({ action, draft, position })}
        onCombo={setCombo}
        position={position}
        positions={positions}
      />
    ),
    dialog:
      combo === null ? (
        open === null ? null : (
          <PositionOrderDialog
            action={open.action}
            draft={open.draft}
            gateway={gateway}
            key={`${open.position.id}-${open.action}`}
            onClose={() => setOpen(null)}
            position={open.position}
          />
        )
      ) : (
        <ComboOrderDialog
          draft={combo}
          gateway={gateway}
          onClose={() => setCombo(null)}
        />
      ),
  };
};
