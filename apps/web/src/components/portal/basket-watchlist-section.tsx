"use client";

import type { BasketOutput, BasketValuationOutput } from "@darkfactory/api";
import { Panel } from "@darkfactory/ui";
import { useEffect, useState } from "react";

import {
  type BasketGateway,
  createBrowserBasketGateway,
  describeBasketFailure,
  formatIndex,
  formatPct,
} from "./baskets-client.ts";

type Row = Readonly<{
  basket: BasketOutput;
  latest: BasketValuationOutput["latest"] | undefined;
  stale: boolean;
}>;

const valuedRow = async (
  gateway: BasketGateway,
  basket: BasketOutput
): Promise<Row> => {
  try {
    const valuation = await gateway.valuation(basket.id);
    return {
      basket,
      latest: valuation.latest,
      stale: valuation.staleSymbols.length > 0,
    };
  } catch {
    return { basket, latest: null, stale: true };
  }
};

// Shows each custom basket on the watchlist with its latest index value. undefined latest = still loading.
export const BasketWatchlistSection = ({
  gateway: suppliedGateway,
}: {
  readonly gateway?: BasketGateway;
}) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserBasketGateway()
  );
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      let baskets: BasketOutput[];
      try {
        baskets = await gateway.list();
      } catch (failure) {
        // Baskets are operator-only; other sessions simply see no section.
        const forbidden =
          typeof failure === "object" &&
          failure !== null &&
          Reflect.get(failure, "code") === "FORBIDDEN";
        if (active && !forbidden) setError(describeBasketFailure(failure));
        return;
      }
      if (!active) return;
      setRows(
        baskets.map((basket) => ({ basket, latest: undefined, stale: false }))
      );
      for (const basket of baskets) {
        const next = await valuedRow(gateway, basket);
        if (!active) return;
        setRows((current) =>
          current.map((row) => (row.basket.id === basket.id ? next : row))
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [gateway]);

  if (error !== null) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        Baskets: {error}
      </p>
    );
  }
  if (rows.length === 0) return null;
  return (
    <Panel flush headingId="watchlist-baskets-heading" title="Baskets">
      <ul className="divide-y" data-click-private="">
        {rows.map((row) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
            key={row.basket.id}
          >
            <a
              className="inline-flex min-h-11 items-center gap-2 font-medium font-mono underline-offset-4 hover:underline"
              href={`/baskets?symbol=${encodeURIComponent(row.basket.symbol)}`}
            >
              {row.basket.symbol}
              <span className="font-normal font-sans text-muted-foreground">
                {row.basket.name} ·{" "}
                {row.basket.members.map((m) => m.symbol).join(", ")}
              </span>
            </a>
            <span className="font-mono">
              {row.latest === undefined
                ? "…"
                : `${formatIndex(row.latest?.value ?? null)} (${formatPct(row.latest?.changePct ?? null)})`}
              {row.stale && (
                <span className="ml-2 font-sans text-amber-600 text-xs dark:text-amber-400">
                  stale
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
};
