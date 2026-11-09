"use client";

import type { OptionsChainOutput } from "@darkfactory/api";
import { cn, Panel, StatCard } from "@darkfactory/ui";
import type { MouseEvent } from "react";
import { useEffect, useId, useState } from "react";

import {
  createBrowserMarketDataGateway,
  describeMarketDataFailure,
  type MarketDataFailure,
  type MarketDataGateway,
} from "../../components/portal/market-data-client.ts";
import type { OptionsAnalyticsGateway } from "../../components/portal/options-analytics-client.ts";
import { OptionsAnalyticsPanel } from "../../components/portal/options-analytics-panel.tsx";

import {
  createBrowserOptionsChainGateway,
  type OptionsChainGateway,
} from "./options-chain-client.ts";
import {
  atmIndex,
  OptionsChainTable,
  STRIKE_WINDOWS,
  type StrikeWindow,
} from "./options-chain-table.tsx";
import type { OpenbbGateway } from "../openbb/gateway.ts";
import { OpenbbFilingsTab } from "../openbb/openbb-panels.tsx";
import { StockChartPanel } from "./stock-chart-panel.tsx";
import {
  parseStockQuery,
  type StockQuery,
  type StockTab,
  stockQueryString,
} from "./url-state.ts";

// /stock/<SYMBOL>: price chart, options chain per expiry with Greeks, and options analytics.
// Opens with defaults (1D chart, nearest expiry); every choice lives in the URL query.
// Read-only market data: no order entry on this page.

const TABS: readonly (readonly [StockTab, string])[] = [
  ["chart", "Chart"],
  ["options", "Options chain"],
  ["analytics", "Analytics"],
  ["filings", "Filings"],
];

type ChainState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; chain: OptionsChainOutput }>
  | Readonly<{ type: "error"; failure: MarketDataFailure }>;

const money = (value: number | null): string =>
  value === null ? "—" : `$${value.toFixed(2)}`;

type ChainSummary = Readonly<{
  atmStrike: number | null;
  atmIv: number | null;
  putCallOi: number | null;
}>;

/** ATM strike and IV (mean of call and put) and the put/call open-interest ratio. */
export const chainSummary = (chain: OptionsChainOutput): ChainSummary => {
  const row = chain.rows[atmIndex(chain.rows, chain.spot)];
  const ivs = [row?.call?.iv, row?.put?.iv].filter(
    (value): value is number => typeof value === "number"
  );
  let calls = 0;
  let puts = 0;
  for (const item of chain.rows) {
    calls += item.call?.openInterest ?? 0;
    puts += item.put?.openInterest ?? 0;
  }
  return {
    atmIv:
      ivs.length === 0
        ? null
        : ivs.reduce((sum, value) => sum + value, 0) / ivs.length,
    atmStrike: row?.strike ?? null,
    putCallOi: calls === 0 ? null : puts / calls,
  };
};

const formatExpiry = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });

const KpiRow = ({ chain }: { readonly chain: OptionsChainOutput | null }) => {
  const summary = chain === null ? null : chainSummary(chain);
  const quoteTime = chain?.quoteTime ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-stock-kpis="">
      <StatCard
        className="px-4 py-4"
        description={
          quoteTime === null
            ? "Spot from the options feed"
            : `Quote ${new Date(quoteTime).toUTCString().slice(5, 22)} UTC`
        }
        label="Last price"
        value={money(chain?.spot ?? null)}
      />
      <StatCard
        className="px-4 py-4"
        description={
          chain === null
            ? "Nearest listed expiry"
            : `${chain.dte} days · ${chain.expiries.length} expiries listed`
        }
        label="Expiry"
        value={chain === null ? "—" : formatExpiry(chain.expiry)}
      />
      <StatCard
        className="px-4 py-4"
        description={`Strike ${summary?.atmStrike?.toFixed(2) ?? "—"}`}
        label="ATM IV"
        value={
          summary?.atmIv === null || summary === null
            ? "—"
            : `${(summary.atmIv * 100).toFixed(1)}%`
        }
      />
      <StatCard
        className="px-4 py-4"
        description="Open interest, this expiry"
        label="Put/call OI"
        value={summary?.putCallOi?.toFixed(2) ?? "—"}
      />
    </div>
  );
};

type ChainPanelProps = Readonly<{
  symbol: string;
  state: ChainState;
  // The last chain that loaded: the controls stay mounted (and keep focus) while the next loads.
  lastChain: OptionsChainOutput | null;
  selectedExpiry: string | null;
  notice: string | null;
  onExpiry: (expiry: string) => void;
}>;

const ChainPanel = ({
  symbol,
  state,
  lastChain,
  selectedExpiry,
  notice,
  onExpiry,
}: ChainPanelProps) => {
  const expiryId = useId();
  const strikesId = useId();
  const [strikes, setStrikes] = useState<StrikeWindow>(20);
  const chain = lastChain;
  const selectClass =
    "h-11 rounded-md border border-border-strong bg-surface px-2 text-sm";
  return (
    <Panel
      actions={
        chain === null ? undefined : (
          <>
            <label className="sr-only" htmlFor={expiryId}>
              Expiry
            </label>
            <select
              aria-label="Expiry"
              className={selectClass}
              id={expiryId}
              onChange={(event) => onExpiry(event.target.value)}
              value={selectedExpiry ?? chain.expiry}
            >
              {chain.expiries.map((item) => (
                <option key={item.date} value={item.date}>
                  {formatExpiry(item.date)} · {item.dte}d
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={strikesId}>
              Strikes
            </label>
            <select
              aria-label="Strikes"
              className={selectClass}
              id={strikesId}
              onChange={(event) =>
                setStrikes(
                  event.target.value === "all"
                    ? "all"
                    : (Number(event.target.value) as StrikeWindow)
                )
              }
              value={String(strikes)}
            >
              {STRIKE_WINDOWS.map((size) => (
                <option key={size} value={size}>
                  {size === "all" ? "All strikes" : `${size} strikes`}
                </option>
              ))}
            </select>
          </>
        )
      }
      contentClassName="p-0"
      data-chain-panel={symbol}
      description="Calls and puts with quotes, IV and Greeks. Read-only."
      title={`${symbol} options chain`}
    >
      {notice === null ? null : (
        <p className="border-border border-b px-4 py-2 text-sm" role="status">
          {notice}
        </p>
      )}
      {state.type === "loading" ? (
        <p
          aria-busy="true"
          className="flex h-40 items-center justify-center text-muted-foreground text-sm"
        >
          Loading {symbol} options…
        </p>
      ) : state.type === "error" ? (
        <div
          className="space-y-1 p-4"
          data-error-code={state.failure.code}
          role="alert"
        >
          <p className="font-mono text-sm">{state.failure.code}</p>
          <p className="text-sm">{state.failure.message}</p>
        </div>
      ) : (
        <>
          <OptionsChainTable chain={state.chain} strikes={strikes} />
          <ul
            className="space-y-1 border-border border-t px-4 py-3 text-muted-foreground text-xs"
            data-chain-notes=""
          >
            {state.chain.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
};

export interface StockDetailWorkspaceProps {
  readonly symbol: string;
  readonly marketData?: MarketDataGateway;
  readonly optionsChain?: OptionsChainGateway;
  readonly optionsAnalytics?: OptionsAnalyticsGateway;
  readonly openbb?: OpenbbGateway;
}

export const StockDetailWorkspace = ({
  symbol,
  marketData: suppliedMarketData,
  optionsChain: suppliedOptionsChain,
  optionsAnalytics,
  openbb,
}: StockDetailWorkspaceProps) => {
  const [marketData] = useState(
    () => suppliedMarketData ?? createBrowserMarketDataGateway()
  );
  const [optionsChain] = useState(
    () => suppliedOptionsChain ?? createBrowserOptionsChainGateway()
  );
  // The URL is read after mount, so server and first client render match.
  const [query, setQuery] = useState<StockQuery | null>(null);
  const [chain, setChain] = useState<ChainState>({ type: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [lastChain, setLastChain] = useState<OptionsChainOutput | null>(null);

  useEffect(() => {
    const read = () => {
      setNotice(null);
      setQuery(parseStockQuery(window.location.search));
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const expiry = query?.expiry ?? null;
  const ready = query !== null;
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setChain({ type: "loading" });
    optionsChain.chain(expiry === null ? { symbol } : { expiry, symbol }).then(
      (data) => {
        if (!active) return;
        setChain({ chain: data, type: "ready" });
        setLastChain(data);
      },
      (error: unknown) => {
        if (!active) return;
        const failure = describeMarketDataFailure(error);
        if (failure.code === "NOT_FOUND" && expiry !== null) {
          // An old or mistyped expiry link: show the nearest expiry instead.
          setNotice(
            `No options expire on ${expiry}. Showing the nearest expiry.`
          );
          const next = {
            ...parseStockQuery(window.location.search),
            expiry: null,
          };
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${stockQueryString(next)}`
          );
          setQuery(next);
          return;
        }
        setChain({ failure, type: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [optionsChain, symbol, expiry, ready]);

  if (query === null)
    return (
      <p aria-busy="true" className="text-muted-foreground text-sm">
        Loading {symbol}…
      </p>
    );

  const navigate = (patch: Partial<StockQuery>) => {
    const next = { ...query, ...patch };
    setNotice(null);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${stockQueryString(next)}`
    );
    setQuery(next);
  };
  const selectTab =
    (tab: StockTab) => (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      navigate({ tab });
    };
  const chainPanel = (
    <ChainPanel
      lastChain={lastChain}
      notice={notice}
      onExpiry={(next) => navigate({ expiry: next })}
      selectedExpiry={query.expiry}
      state={chain}
      symbol={symbol}
    />
  );

  return (
    <div className="space-y-6" data-stock-detail={symbol}>
      <KpiRow chain={chain.type === "ready" ? chain.chain : null} />
      <nav aria-label={`${symbol} views`}>
        <ul className="flex flex-wrap gap-1 border-border border-b">
          {TABS.map(([tab, label]) => (
            <li key={tab}>
              <a
                aria-current={query.tab === tab ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center border-b-2 px-4 font-medium text-sm",
                  query.tab === tab
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
                href={stockQueryString({ ...query, tab }) || "?"}
                onClick={selectTab(tab)}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {query.tab === "filings" ? (
        <OpenbbFilingsTab
          {...(openbb === undefined ? {} : { gateway: openbb })}
          symbol={symbol}
        />
      ) : query.tab === "analytics" ? (
        <OptionsAnalyticsPanel gateway={optionsAnalytics} symbol={symbol} />
      ) : (
        <>
          {query.tab === "chart" ? (
            <StockChartPanel
              interval={query.interval}
              marketData={marketData}
              onInterval={(interval) => navigate({ interval })}
              symbol={symbol}
            />
          ) : null}
          {chainPanel}
        </>
      )}
    </div>
  );
};
