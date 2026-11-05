"use client";

import type {
  VertexComboInput,
  VertexComboPreviewOutput as ComboPreview,
} from "@darkfactory/api";
import { Button, Input, Label, StatusBadge } from "@darkfactory/ui";
import { useState, type FormEvent } from "react";

import { FinalGatePanel } from "./final-gate-panel.tsx";
import {
  orderErrorMessage,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

// Vertical spread ticket (merge plan P6): buy one strike, sell another, same expiry and right, as
// ONE combo order. Net limit: positive = debit paid, negative = credit received. Opening verticals
// are offered on the simulated (paper) gateway only, because the live order tail accepts exact
// closes only; the final JEV gate decides.

type VerticalForm = Readonly<{
  symbol: string;
  expiry: string;
  right: "C" | "P";
  buyStrike: string;
  sellStrike: string;
  quantity: string;
  netLimit: string;
}>;

const EMPTY: VerticalForm = {
  buyStrike: "",
  expiry: "",
  netLimit: "",
  quantity: "1",
  right: "C",
  sellStrike: "",
  symbol: "",
};

export const toVerticalInput = (form: VerticalForm): VertexComboInput => {
  const expiry = form.expiry.replaceAll("-", "");
  return {
    legs: [
      {
        expiry,
        ratio: 1,
        right: form.right,
        side: "BUY",
        strike: Number(form.buyStrike),
      },
      {
        expiry,
        ratio: 1,
        right: form.right,
        side: "SELL",
        strike: Number(form.sellStrike),
      },
    ],
    limitPrice: Number(form.netLimit),
    quantity: Number(form.quantity),
    symbol: form.symbol.trim().toUpperCase(),
  };
};

export const VerticalTicket = ({
  gateway,
  onPlaced,
}: Readonly<{
  gateway: VertexOrdersGateway;
  onPlaced: () => Promise<void>;
}>) => {
  const [form, setForm] = useState<VerticalForm>(EMPTY);
  const [review, setReview] = useState<ComboPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setReview(await gateway.comboPreview(toVerticalInput(form)));
    });
  };

  const onSend = (current: ComboPreview, confirmToken: string) =>
    run(async () => {
      const result = await gateway.comboSubmit({
        confirm: true,
        confirmToken,
        order: current.review.order,
      });
      setReview(null);
      setForm(EMPTY);
      setMessage(
        `Vertical ${result.state} (${result.mode}): ${result.message}`
      );
      await onPlaced();
    });

  const field = (key: keyof VerticalForm) => ({
    id: `vertical-${key}`,
    onChange: (event: { target: { value: string } }) =>
      setForm({ ...form, [key]: event.target.value }),
    value: form[key],
  });

  return (
    <section aria-labelledby="vertical-title" className="space-y-4">
      <h3 className="font-semibold" id="vertical-title">
        Vertical spread · defined risk
      </h3>
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
            <Label htmlFor="vertical-symbol">Spread underlying symbol</Label>
            <Input {...field("symbol")} autoComplete="off" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vertical-expiry">Spread expiry</Label>
            <Input {...field("expiry")} required type="date" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vertical-right">Spread right</Label>
            <select
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              {...field("right")}
            >
              <option value="C">Call</option>
              <option value="P">Put</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vertical-buyStrike">Buy strike</Label>
            <Input
              {...field("buyStrike")}
              inputMode="decimal"
              min="0"
              required
              step="any"
              type="number"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vertical-sellStrike">Sell strike</Label>
            <Input
              {...field("sellStrike")}
              inputMode="decimal"
              min="0"
              required
              step="any"
              type="number"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vertical-quantity">Spreads</Label>
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
            <Label htmlFor="vertical-netLimit">
              Net limit per share (+ debit, − credit)
            </Label>
            <Input
              {...field("netLimit")}
              inputMode="decimal"
              required
              step="0.01"
              type="number"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Button disabled={busy} type="submit">
              Review vertical
            </Button>
          </div>
        </form>
      ) : (
        <section
          aria-label="Vertical review"
          className="space-y-4 rounded-lg border border-border p-4"
        >
          <p className="font-medium text-sm">{review.review.label}</p>
          <p className="text-sm tabular-nums">
            Net {review.review.netAmount >= 0 ? "debit" : "credit"} $
            {Math.abs(review.review.netAmount).toLocaleString("en-US")}
          </p>
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
                  void onSend(review, review.confirmToken as string)
                }
              >
                {review.gates.mode === "live"
                  ? "Send vertical to IBKR"
                  : "Send vertical (simulated)"}
              </Button>
            )}
          </div>
        </section>
      )}
    </section>
  );
};
