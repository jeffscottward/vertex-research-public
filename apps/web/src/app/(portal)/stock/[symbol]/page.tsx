import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StockDetailWorkspace } from "../../../../features/stock-detail/stock-detail-workspace.tsx";
import { normalizeStockSymbol } from "../../../../features/stock-detail/url-state.ts";
import { getRequestPortalSession } from "../../../../lib/request-portal-session.ts";

type Params = Promise<{ symbol: string }>;

export const generateMetadata = async ({
  params,
}: {
  readonly params: Params;
}) => {
  const symbol = normalizeStockSymbol((await params).symbol);
  return { title: symbol === null ? "Stock" : `${symbol} · Stock` };
};

// Stock detail: chart and options chain with Greeks. Any ticker link (tickerHref) lands here.
export default async function StockPage({
  params,
}: {
  readonly params: Params;
}) {
  const symbol = normalizeStockSymbol((await params).symbol);
  if (symbol === null) notFound();
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout; operator-only reads send nothing otherwise.
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
        <ol className="flex flex-wrap items-center gap-2">
          <li>
            <Link
              prefetch={false}
              className="hover:text-foreground"
              href="/charts"
            >
              Charts
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-foreground">
            {symbol}
          </li>
        </ol>
      </nav>
      <PageHeader
        actions={
          <Link
            prefetch={false}
            className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 font-medium text-sm hover:bg-muted"
            href={`/charts?symbol=${encodeURIComponent(symbol)}`}
          >
            Open in Charts
          </Link>
        }
        title={symbol}
      />
      <StockDetailWorkspace
        operator={session?.isOperator === true}
        symbol={symbol}
      />
    </div>
  );
}
