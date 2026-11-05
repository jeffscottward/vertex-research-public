"use client";

import type {
  VertexCancelPreviewOutput as CancelPreview,
  VertexOpenOrder,
  VertexOrderPreviewOutput as Preview,
  VertexOrderInput,
  VertexOrdersStatus,
} from "@darkfactory/api";
import { Button, Input, Label, StatusBadge } from "@darkfactory/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { FinalGatePanel } from "./final-gate-panel.tsx";
import { VerticalTicket } from "./vertical-ticket.tsx";
import {
  orderErrorMessage,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

// Owner order screen: one option order at a time. Flow: form -> server review (rules, caps) ->
// explicit "Send order". Cancel: one open option order -> review -> explicit "Send cancel".
// The server enforces every rule again; this screen only shows them.

const money = (value: number | null): string =>
  value === null
    ? "unknown"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD" });

type FormState = Readonly<{
  symbol: string;
  expiry: string;
  strike: string;
  right: "C" | "P";
  side: "BUY" | "SELL";
  quantity: string;
  limitPrice: string;
}>;

const EMPTY: FormState = {
  symbol: "",
  expiry: "",
  strike: "",
  right: "C",
  side: "BUY",
  quantity: "1",
  limitPrice: "",
};

export const toOrderInput = (form: FormState): VertexOrderInput => ({
  symbol: form.symbol.trim().toUpperCase(),
  secType: "OPT",
  expiry: form.expiry.replaceAll("-", ""),
  strike: Number(form.strike),
  right: form.right,
  side: form.side,
  quantity: Number(form.quantity),
  orderType: "LMT",
  limitPrice: Number(form.limitPrice),
});

const Row = ({ label, value }: Readonly<{ label: string; value: string }>) => (
  <div className="flex justify-between gap-4 border-border border-b py-1.5 text-sm">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-right font-medium tabular-nums">{value}</dd>
  </div>
);

const RightSelect = (
  props: Readonly<{
    id: string;
    value: string;
    onChange: (event: { target: { value: string } }) => void;
  }>
) => (
  <div className="space-y-1.5">
    <Label htmlFor={props.id}>Right</Label>
    <select
      className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
      {...props}
    >
      <option value="C">Call</option>
      <option value="P">Put</option>
    </select>
  </div>
);

const TicketHint = () => (
  <p className="text-muted-foreground text-sm sm:col-span-2 lg:col-span-3">
    Calls or puts, limit order, day order. Share orders and naked short options
    are not available.
  </p>
);

const ModeBanner = ({ status }: Readonly<{ status: VertexOrdersStatus }>) =>
  status.gates.ordersEnabled ? (
    <StatusBadge status="warning">Live orders: IBKR</StatusBadge>
  ) : (
    <p
      className="rounded-md border border-info-border bg-info-subtle p-3 text-info-foreground text-sm"
      role="status"
    >
      Orders disabled. This screen uses a simulated mock account; nothing is
      sent to IBKR.
    </p>
  );

export const VertexOrders = ({
  gateway,
}: Readonly<{ gateway: VertexOrdersGateway }>) => {
  const [status, setStatus] = useState<VertexOrdersStatus | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [review, setReview] = useState<Preview | null>(null);
  const [cancelReview, setCancelReview] = useState<CancelPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await gateway.status({}));
    } catch (error) {
      setMessage(orderErrorMessage(error));
    }
  }, [gateway]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const onReview = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setCancelReview(null);
      setReview(await gateway.preview(toOrderInput(form)));
    });
  };

  const onSend = (order: VertexOrderInput, confirmToken: string) =>
    run(async () => {
      const result = await gateway.submit({
        order,
        confirmToken,
        confirm: true,
      });
      setReview(null);
      setForm(EMPTY);
      setMessage(`Order ${result.state} (${result.mode}): ${result.message}`);
      await refresh();
    });

  const onCancelReview = (order: VertexOpenOrder) =>
    run(async () => {
      setReview(null);
      setCancelReview(await gateway.cancelPreview({ permId: order.permId }));
    });

  const onCancelSend = (current: CancelPreview) =>
    run(async () => {
      const result = await gateway.cancelSubmit({
        permId: current.order.permId,
        confirmToken: current.confirmToken,
        confirm: true,
      });
      setCancelReview(null);
      setMessage(`Cancel ${result.state} (${result.mode}): ${result.message}`);
      await refresh();
    });

  const field = (key: keyof FormState) => ({
    id: `order-${key}`,
    value: form[key],
    onChange: (event: { target: { value: string } }) =>
      setForm({ ...form, [key]: event.target.value }),
  });

  return (
    <section aria-labelledby="orders-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-lg" id="orders-title">
          Orders · options only
        </h2>
        {status === null ? null : (
          <span className="text-muted-foreground text-sm">
            Net liquidation {money(status.netLiquidation)}
          </span>
        )}
      </div>
      {status === null ? null : <ModeBanner status={status} />}
      {status?.gates.killSwitch === true ? (
        <StatusBadge status="destructive">
          Kill switch on: no new orders
        </StatusBadge>
      ) : null}
      {message === null ? null : (
        <p className="rounded-md border border-border p-3 text-sm" role="alert">
          {message}
        </p>
      )}

      {review === null ? (
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={onReview}
        >
          <div className="space-y-1.5">
            <Label htmlFor="order-symbol">Underlying symbol</Label>
            <Input {...field("symbol")} autoComplete="off" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="order-expiry">Expiry</Label>
            <Input {...field("expiry")} required type="date" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="order-strike">Strike</Label>
            <Input
              {...field("strike")}
              inputMode="decimal"
              min="0"
              required
              step="any"
              type="number"
            />
          </div>
          <RightSelect {...field("right")} />
          <div className="space-y-1.5">
            <Label htmlFor="order-side">Side</Label>
            <select
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              {...field("side")}
            >
              <option value="BUY">Buy to open</option>
              <option value="SELL">Sell to close</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="order-quantity">Contracts</Label>
            <Input
              {...field("quantity")}
              inputMode="numeric"
              min="1"
              required
              step="1"
              type="number"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="order-limitPrice">Limit price per share</Label>
            <Input
              {...field("limitPrice")}
              inputMode="decimal"
              min="0"
              required
              step="0.01"
              type="number"
            />
          </div>
          <TicketHint />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button disabled={busy} type="submit">
              Review order
            </Button>
          </div>
        </form>
      ) : (
        <section
          className="space-y-4 rounded-lg border border-border p-4"
          aria-label="Order review"
        >
          <h3 className="font-semibold">Review order</h3>
          <dl>
            <Row label="Contract" value={review.review.contractLabel} />
            <Row label="Side" value={review.review.order.side} />
            <Row
              label="Contracts"
              value={String(review.review.order.quantity)}
            />
            <Row
              label="Limit price"
              value={money(review.review.order.limitPrice)}
            />
            <Row label="Total premium" value={money(review.review.premium)} />
            <Row
              label="Premium % NLV"
              value={
                review.review.premiumPctNlv === null
                  ? "unknown"
                  : `${review.review.premiumPctNlv}%`
              }
            />
            <Row
              label="Days to expiry"
              value={String(review.review.daysToExpiry)}
            />
            <Row label="Cap" value={review.review.cap.label} />
            <Row
              label="Name premium after order"
              value={`${money(review.review.cap.afterOrder)} (${review.review.cap.afterOrderPct}% NLV)`}
            />
          </dl>
          <FinalGatePanel gate={review.review.finalGate} />
          {review.review.accepted ? (
            <StatusBadge status="success">Passes all order rules</StatusBadge>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-destructive text-sm">
              {review.review.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={busy}
              onClick={() => setReview(null)}
              variant="outline"
            >
              Back
            </Button>
            {review.confirmToken === null ? null : (
              <Button
                disabled={busy}
                onClick={() =>
                  void onSend(
                    review.review.order,
                    review.confirmToken as string
                  )
                }
              >
                {review.gates.mode === "live"
                  ? "Send order to IBKR"
                  : "Send order (simulated)"}
              </Button>
            )}
          </div>
        </section>
      )}
      <VerticalTicket gateway={gateway} onPlaced={refresh} />

      <div className="space-y-3">
        <h3 className="font-semibold">Open orders</h3>
        {status === null || status.openOrders.length === 0 ? (
          <p className="text-muted-foreground text-sm">No open orders.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {status.openOrders.map((order) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                key={order.permId}
              >
                <span>
                  {order.side} {order.quantity} {order.symbol}
                  {order.secType === "OPT"
                    ? ` ${order.expiry} ${order.strike} ${order.right}`
                    : ` ${order.secType}`}{" "}
                  {order.orderType}{" "}
                  {order.limitPrice === null ? "" : money(order.limitPrice)} ·{" "}
                  {order.status}
                </span>
                {order.cancellable ? (
                  <Button
                    disabled={busy}
                    onClick={() => void onCancelReview(order)}
                    size="sm"
                    variant="outline"
                  >
                    Cancel…
                  </Button>
                ) : (
                  <span className="text-muted-foreground">
                    Not cancellable here
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {cancelReview === null ? null : (
          <section
            className="space-y-3 rounded-lg border border-border p-4"
            aria-label="Cancel review"
          >
            <h3 className="font-semibold">Review cancel</h3>
            <dl>
              <Row
                label="Order"
                value={`${cancelReview.order.side} ${cancelReview.order.quantity} ${cancelReview.order.symbol} ${cancelReview.order.expiry} ${cancelReview.order.strike} ${cancelReview.order.right}`}
              />
              <Row
                label="Limit price"
                value={money(cancelReview.order.limitPrice)}
              />
              <Row label="Status" value={cancelReview.order.status} />
            </dl>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={busy}
                onClick={() => setCancelReview(null)}
                variant="outline"
              >
                Back
              </Button>
              <Button
                disabled={busy}
                onClick={() => void onCancelSend(cancelReview)}
                variant="destructive"
              >
                {cancelReview.gates.mode === "live"
                  ? "Send cancel to IBKR"
                  : "Send cancel (simulated)"}
              </Button>
            </div>
          </section>
        )}
      </div>
    </section>
  );
};
