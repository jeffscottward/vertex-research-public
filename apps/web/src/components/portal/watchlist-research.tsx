// What: Research tab of the watchlist: one card per symbol with its note, buy zone and links to
// the stock page (/stock/<SYM>), the chart (/charts?symbol=<SYM>) and market news (/news).
// Used by: watchlist-workspace.tsx.

import type { WatchlistItemOutput } from "@darkfactory/api";
import { BarChart3, FileText, Newspaper } from "lucide-react";
import Link from "next/link";

import { tickerHref } from "../../lib/ticker-href.ts";

export interface WatchlistResearchProps {
  readonly items: readonly WatchlistItemOutput[];
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const WatchlistResearch = ({ items }: WatchlistResearchProps) => (
  <ul
    aria-label="Research by symbol"
    className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
  >
    {items.map((item) => {
      const symbol = item.symbol.trim().toUpperCase();
      const headingId = `watchlist-research-${item.id}`;
      const hasZone = item.buyZoneLow !== null || item.buyZoneHigh !== null;
      const note = item.note?.trim() ?? "";
      return (
        <li
          className="space-y-3 rounded-lg border border-border bg-card p-4"
          data-symbol={symbol}
          key={item.id}
        >
          <h3 className="font-mono font-semibold text-base" id={headingId}>
            {symbol}
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Buy zone</dt>
            <dd className="font-mono">
              {hasZone
                ? `${item.buyZoneLow ?? "—"} – ${item.buyZoneHigh ?? "—"}`
                : "Not set"}
            </dd>
            <dt className="text-muted-foreground">Note</dt>
            <dd
              className={
                note === "" ? "text-muted-foreground" : "whitespace-pre-wrap"
              }
            >
              {note === "" ? "No note" : note}
            </dd>
          </dl>
          <nav
            aria-label={`${symbol} research links`}
            className="-mx-2 flex flex-wrap"
          >
            <Link
              aria-label={`${symbol} stock page`}
              className={LINK_CLASS}
              href={tickerHref(symbol)}
              prefetch={false}
            >
              <FileText aria-hidden="true" className="size-4" />
              Stock page
            </Link>
            <Link
              aria-label={`${symbol} chart`}
              className={LINK_CLASS}
              href={`/charts?symbol=${encodeURIComponent(symbol)}`}
              prefetch={false}
            >
              <BarChart3 aria-hidden="true" className="size-4" />
              Chart
            </Link>
            <Link
              aria-label={`Market news (for ${symbol})`}
              className={LINK_CLASS}
              href="/news"
              prefetch={false}
            >
              <Newspaper aria-hidden="true" className="size-4" />
              News
            </Link>
          </nav>
        </li>
      );
    })}
  </ul>
);
