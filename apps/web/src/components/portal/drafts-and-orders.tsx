"use client";

import type { GoLiveQueueOutput, VertexOrdersStatus } from "@darkfactory/api";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  type DraftsAndOrdersView,
  draftRows,
  moneyText,
  orderRows,
  summaryText,
} from "./drafts-and-orders-model.ts";

export type DraftsAndOrdersGateway = Readonly<{
  drafts: (
    options: Readonly<{ signal: AbortSignal }>
  ) => Promise<GoLiveQueueOutput>;
  orders: (
    options: Readonly<{ signal: AbortSignal }>
  ) => Promise<VertexOrdersStatus>;
}>;

// Each feed is read on its own: one failed feed shows "unknown" for that feed only.
const settle = async <T, R>(
  read: () => Promise<T>,
  map: (value: T) => R
): Promise<R | null> => {
  try {
    return map(await read());
  } catch {
    return null;
  }
};

/** Portfolio section: open order drafts and working IBKR orders. Read only. */
export const DraftsAndOrders = ({
  gateway,
}: Readonly<{ gateway: DraftsAndOrdersGateway }>) => {
  const [view, setView] = useState<DraftsAndOrdersView | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      settle(() => gateway.drafts({ signal: abort.signal }), draftRows),
      settle(() => gateway.orders({ signal: abort.signal }), orderRows),
    ]).then(([drafts, orders]) => {
      if (!abort.signal.aborted)
        setView({ checkedAt: new Date(), drafts, orders });
    });
    return () => abort.abort();
  }, [gateway]);
  const workingOrders =
    view === null || view.orders === null || view.orders === "simulated"
      ? []
      : view.orders;
  return (
    <section
      aria-labelledby="drafts-and-orders-title"
      className="space-y-3 rounded-md border border-border p-4"
      data-drafts-and-orders=""
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-base" id="drafts-and-orders-title">
          Drafts and orders
        </h2>
        <Link
          className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline underline-offset-4"
          href="/drafts"
          prefetch={false}
        >
          Open order drafts
        </Link>
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {view === null ? "Checking drafts and IBKR orders…" : summaryText(view)}
      </p>
      {view !== null && view.drafts !== null && view.drafts.length > 0 ? (
        <ul className="space-y-2" data-drafts-list="">
          {view.drafts.map((draft) => (
            <li className="text-sm" key={draft.id}>
              <Link
                className="inline-flex min-h-11 items-center font-medium underline underline-offset-4"
                href={draft.href}
                prefetch={false}
              >
                {draft.label}
              </Link>{" "}
              <span className="text-muted-foreground">
                · {draft.state} · max loss {moneyText(draft.maxLoss)} · waiting
                for: {draft.waitingFor}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {workingOrders.length > 0 ? (
        <ul className="space-y-2" data-orders-list="">
          {workingOrders.map((order) => (
            <li className="text-sm" key={order.key}>
              {order.label}{" "}
              <span className="text-muted-foreground">· {order.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
