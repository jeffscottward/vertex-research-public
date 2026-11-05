// What: TickerLink, every ticker symbol in the portal as a link to its stock detail page.
// Used by: portal tables and lists (watchlist first).
// See: apps/web/src/lib/ticker-href.ts.
import { cn } from "@darkfactory/ui";
import Link from "next/link";
import type { ReactNode } from "react";

import { tickerHref } from "../lib/ticker-href.ts";

export function TickerLink(props: {
  symbol: string;
  className?: string;
  children?: ReactNode;
}) {
  const symbol = props.symbol.trim().toUpperCase();
  return (
    <Link
      className={cn(
        "font-medium font-mono underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.className
      )}
      data-slot="ticker-link"
      href={tickerHref(symbol)}
      prefetch={false}
    >
      {props.children ?? symbol}
    </Link>
  );
}
