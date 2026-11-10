"use client";

import type { VertexComboPreviewOutput as ComboPreview } from "@darkfactory/api";
import {
  Button,
  Input,
  Label,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { useEffect, useId, useRef, useState } from "react";

import {
  type ComboDraft,
  comboLimit,
  toComboInput,
} from "./position-actions-model.ts";
import {
  orderErrorMessage,
  type VertexOrdersGateway,
} from "./vertex-orders-client.ts";

// Spread close (owner 2026-11-04): every leg closes together as ONE combo (BAG) order, never leg by
// leg. Quantity is the whole spread; only the net limit can be edited. Nothing is sent until the
// owner presses the confirm button after an accepted review.

const usd = (value: number): string =>
  Math.abs(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

export const ComboOrderDialog = ({
  draft,
  gateway,
  onClose,
}: Readonly<{
  draft: ComboDraft;
  gateway: VertexOrdersGateway;
  onClose: () => void;
}>) => {
  const titleId = useId();
  const [marketable, setMarketable] = useState(true);
  const [limit, setLimit] = useState(
    draft.limitPrice === null ? "" : String(draft.limitPrice)
  );
  const [review, setReview] = useState<ComboPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const net = Number(limit);
  const valid = limit.trim() !== "" && Number.isFinite(net) && net !== 0;
  const amount = Math.round(net * draft.quantity * 100 * 100) / 100;

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
    const value = comboLimit(draft.legs, next);
    if (value !== null) setLimit(String(value));
  };

  const onReview = () =>
    run(async () => {
      setReview(await gateway.comboPreview(toComboInput(draft, net)));
    });

  const onSend = (current: ComboPreview, token: string) =>
    run(async () => {
      const result = await gateway.comboSubmit({
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
      data-combo-order-dialog="close"
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
        role="dialog"
      >
        <h2 className="font-semibold text-lg" id={titleId}>
          {`Close ${draft.symbol} spread (one combo order)`}
        </h2>
        <Table className="w-full text-sm">
          <TableCaption className="sr-only">Combo legs</TableCaption>
          <TableHeader>
            <TableRow className="text-left">
              <TableHead scope="col">Leg</TableHead>
              <TableHead scope="col">Side</TableHead>
              <TableHead className="text-right" scope="col">
                Contracts
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.legs.map((leg) => (
              <TableRow
                className="border-border border-t"
                key={`${leg.contract.expiry}-${leg.contract.strike}-${leg.contract.right}`}
              >
                <TableCell className="whitespace-normal py-1.5">
                  {`${leg.contract.expiry} ${leg.contract.strike} ${leg.contract.right === "C" ? "call" : "put"}`}
                </TableCell>
                <TableCell className="whitespace-normal">{leg.side}</TableCell>
                <TableCell className="whitespace-normal text-right tabular-nums">
                  {leg.ratio * draft.quantity}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="space-y-1.5">
          <Label htmlFor={`${titleId}-limit`}>
            Net limit per combo (+ debit / − credit)
          </Label>
          <Input
            id={`${titleId}-limit`}
            inputMode="decimal"
            onChange={(event) => {
              setLimit(event.target.value);
              setReview(null);
            }}
            step="0.01"
            type="number"
            value={limit}
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            checked={marketable}
            className="size-4"
            onChange={(event) => onMarketable(event.target.checked)}
            type="checkbox"
          />
          Marketable limit (net at the marks, 5% toward a fill)
        </label>
        <p className="text-sm" data-combo-amount="true">
          {valid
            ? `Order type: combo LMT, day. Estimated ${amount > 0 ? "net debit" : "net credit"}: ${usd(amount)}`
            : "Enter a net limit."}
        </p>
        <p className="text-muted-foreground text-xs">
          All legs close together; options are never exercised.
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
              variant="destructive"
            >
              {review.gates.mode === "live"
                ? "Confirm: send combo to IBKR"
                : "Confirm: send combo (simulated)"}
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
