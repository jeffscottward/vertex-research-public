"use client";

import {
  OPTIONS_CHAIN_SOURCE_LABELS,
  type OptionsChainOutput,
  type OptionsChainSourceStatus,
} from "@darkfactory/api";
import { Button, cn, Panel, StatCard } from "@darkfactory/ui";
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
import { localClock } from "../../components/portal/portfolio-monitor-model.ts";

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

/** A chain request with no answer after this long shows when it started, with Retry. */
export const CHAIN_REQUEST_TIMEOUT_MS = 30_000;

export type ChainState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "no-answer"; startedAt: number }>
  | Readonly<{ type: "ready"; chain: OptionsChainOutput }>
  | Readonly<{ type: "error"; failure: MarketDataFailure }>;

const NO_ATM_STRIKE = "No ATM strike for this expiry";

/** Why the stat cards have no chain values yet: still loading, no answer, or the failure message. */
const chainNotReadyText = (
  state: Exclude<ChainState, Readonly<{ type: "ready" }>>
): string => {
  if (state.type === "loading") return "Loading…";
  if (state.type === "no-answer")
    return `Not loaded: no answer after ${CHAIN_REQUEST_TIMEOUT_MS / 1000} s`;
  return `Not loaded: ${state.failure.message}`;
};

type ChainKpis = Readonly<{
  price: string;
  expiry: string;
  strike: string;
  atmIv: string;
  putCallOiValue: string;
  putCallOiDetail: string;
}>;

/** The stat card values: the chain state while there is no chain, else each value or what it lacks. */
export const chainKpis = (state: ChainState): ChainKpis => {
  if (state.type !== "ready") {
    const text = chainNotReadyText(state);
    return {
      atmIv: text,
      expiry: text,
      price: text,
      putCallOiValue: "—",
      putCallOiDetail: text,
      strike: text,
    };
  }
  const { chain } = state;
  const summary = chainSummary(chain);
  const noStrike = summary.atmStrike === null;
  const [putCallOiValue, putCallOiDetail] = putCallOiText(summary);
  return {
    atmIv: noStrike
      ? NO_ATM_STRIKE
      : summary.atmIv === null
        ? "No IV at the ATM strike"
        : `${(summary.atmIv * 100).toFixed(1)}%`,
    expiry: formatExpiry(chain.expiry),
    price:
      chain.spot === null
        ? "No price in this chain snapshot"
        : `$${chain.spot.toFixed(2)}`,
    putCallOiValue,
    putCallOiDetail,
    strike:
      summary.atmStrike === null
        ? NO_ATM_STRIKE
        : `Strike ${summary.atmStrike.toFixed(2)}`,
  };
};

/** Open interest of one side: contracts listed, contracts that reported it, and their sum. */
type OiSide = Readonly<{ contracts: number; reported: number; total: number }>;

type ChainSummary = Readonly<{
  atmStrike: number | null;
  atmIv: number | null;
  calls: OiSide;
  puts: OiSide;
  /** Puts / calls; null unless every contract on both sides reported and calls sum above 0. */
  putCallOi: number | null;
}>;

const complete = (side: OiSide): boolean =>
  side.contracts > 0 && side.reported === side.contracts;

/**
 * The put/call ratio, or why there is none. No contracts, open interest the source did not report,
 * and a reported 0 stay distinct: a missing value is never summed as 0.
 */
const putCallOiText = (
  summary: ChainSummary
): readonly [value: string, detail: string] => {
  if (summary.putCallOi !== null)
    return [summary.putCallOi.toFixed(2), "OI for the selected expiry"];
  const { calls, puts } = summary;
  if (calls.contracts === 0 && puts.contracts === 0)
    return ["—", "No contracts for the selected expiry"];
  if (calls.contracts === 0)
    return [
      "—",
      `No call contracts; put OI reported for ${puts.reported} of ${puts.contracts} contracts in this returned chain`,
    ];
  if (puts.contracts === 0)
    return [
      "—",
      `No put contracts; call OI reported for ${calls.reported} of ${calls.contracts} contracts in this returned chain`,
    ];
  if (calls.reported === 0 && puts.reported === 0)
    return [
      "—",
      `Calls OI reported for 0 of ${calls.contracts} contracts; puts OI reported for 0 of ${puts.contracts} contracts in this returned chain`,
    ];
  if (calls.reported < calls.contracts || puts.reported < puts.contracts)
    return [
      "—",
      `Calls OI reported for ${calls.reported} of ${calls.contracts} contracts; puts OI reported for ${puts.reported} of ${puts.contracts} contracts in this returned chain`,
    ];
  if (calls.total === 0 && puts.total === 0)
    return ["—", "Reported call and put OI totals are zero"];
  return ["—", "Call OI is zero; the ratio is unavailable"];
};

const addLeg = (side: OiSide, openInterest: number | null): OiSide =>
  openInterest === null
    ? { ...side, contracts: side.contracts + 1 }
    : {
        contracts: side.contracts + 1,
        reported: side.reported + 1,
        total: side.total + openInterest,
      };

const NO_LEGS: OiSide = { contracts: 0, reported: 0, total: 0 };

/** ATM strike and IV (mean of call and put) and the put/call open-interest ratio. */
export const chainSummary = (chain: OptionsChainOutput): ChainSummary => {
  const row = chain.rows[atmIndex(chain.rows, chain.spot)];
  const ivs = [row?.call?.iv, row?.put?.iv].filter(
    (value): value is number => typeof value === "number"
  );
  let calls = NO_LEGS;
  let puts = NO_LEGS;
  for (const item of chain.rows) {
    if (item.call !== null) calls = addLeg(calls, item.call.openInterest);
    if (item.put !== null) puts = addLeg(puts, item.put.openInterest);
  }
  return {
    atmIv:
      ivs.length === 0
        ? null
        : ivs.reduce((sum, value) => sum + value, 0) / ivs.length,
    atmStrike: row?.strike ?? null,
    calls,
    puts,
    putCallOi:
      complete(calls) && complete(puts) && calls.total > 0
        ? puts.total / calls.total
        : null,
  };
};

const formatExpiry = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });

const KpiRow = ({ state }: { readonly state: ChainState }) => {
  const chain = state.type === "ready" ? state.chain : null;
  const kpis = chainKpis(state);
  const quoteTime = chain?.quoteTime ?? null;
  const spotSource = chain?.spotSource ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-stock-kpis="">
      <StatCard
        className="px-4 py-4"
        description={
          // The quote time when the source sends one, else the name of the source.
          quoteTime === null
            ? spotSource === null
              ? "Spot from the options feed"
              : `Spot from ${OPTIONS_CHAIN_SOURCE_LABELS[spotSource]}`
            : `Quote ${new Date(quoteTime).toUTCString().slice(5, 22)} UTC`
        }
        label="Last price"
        value={kpis.price}
      />
      <StatCard
        className="px-4 py-4"
        description={
          chain === null
            ? "Nearest listed expiry"
            : `${chain.dte} days · ${chain.expiries.length} expiries listed`
        }
        label="Expiry"
        value={kpis.expiry}
      />
      <StatCard
        className="px-4 py-4"
        description={kpis.strike}
        label="ATM IV"
        value={kpis.atmIv}
      />
      <StatCard
        className="px-4 py-4"
        description={kpis.putCallOiDetail}
        label="Put/call OI"
        value={kpis.putCallOiValue}
      />
    </div>
  );
};

const SOURCE_STATUS_LABELS: Readonly<
  Record<OptionsChainSourceStatus["status"], string>
> = { empty: "no data", failed: "failed", off: "off", used: "used" };

const compactMoney = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

/** Call and put premium of the order-flow prints of this expiry; null when no contract has flow. */
export const chainFlow = (
  chain: OptionsChainOutput
): Readonly<{ call: number; put: number }> | null => {
  const calls = chain.rows.flatMap((row) => row.call?.flow ?? []);
  const puts = chain.rows.flatMap((row) => row.put?.flow ?? []);
  if (calls.length + puts.length === 0) return null;
  return {
    call: calls.reduce((sum, flow) => sum + flow.premium, 0),
    put: puts.reduce((sum, flow) => sum + flow.premium, 0),
  };
};

// One line per fact under the KPI row: what each data source did (with the reason as visible
// text, so touch and keyboard users read it too; long words break instead of overflowing), and
// the flow when there is any.
const SourceLines = ({ chain }: { readonly chain: OptionsChainOutput }) => {
  const flow = chainFlow(chain);
  return (
    <div
      className="space-y-1 break-words px-1 text-muted-foreground text-xs"
      data-chain-sources=""
    >
      <p>
        <span className="font-medium text-foreground">Sources</span>
        {chain.sources.map((item) => (
          <span
            data-source={item.source}
            data-status={item.status}
            key={item.source}
          >
            {" · "}
            {OPTIONS_CHAIN_SOURCE_LABELS[item.source]}:{" "}
            {SOURCE_STATUS_LABELS[item.status]}
            {item.message === null ? null : (
              <span data-source-message=""> ({item.message})</span>
            )}
          </span>
        ))}
      </p>
      {flow === null ? null : (
        <p data-chain-flow="">
          <span className="font-medium text-foreground">
            {OPTIONS_CHAIN_SOURCE_LABELS.quantdata} flow
          </span>
          {" · "}call premium {compactMoney.format(flow.call)}
          {" · "}put premium {compactMoney.format(flow.put)} (this expiry
          {chain.flowFirstPageOnly ? ", first provider page only" : ""})
        </p>
      )}
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
  onRetry: () => void;
}>;

const ChainPanel = ({
  symbol,
  state,
  lastChain,
  selectedExpiry,
  notice,
  onExpiry,
  onRetry,
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
      ) : state.type === "no-answer" ? (
        <div className="space-y-2 p-4" data-chain-no-answer="" role="alert">
          <p className="text-sm">
            {symbol} options requested at{" "}
            {localClock(new Date(state.startedAt))} · no answer after{" "}
            {CHAIN_REQUEST_TIMEOUT_MS / 1000} s
          </p>
          <Button onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
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
  const [attempt, setAttempt] = useState(0);

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
    const startedAt = Date.now();
    setChain({ type: "loading" });
    // The cleanup and both answers clear this timer, so it only runs for a live, open request.
    // An answer that arrives after the deadline still replaces the no-answer state.
    const deadline = window.setTimeout(
      () => setChain({ startedAt, type: "no-answer" }),
      CHAIN_REQUEST_TIMEOUT_MS
    );
    optionsChain.chain(expiry === null ? { symbol } : { expiry, symbol }).then(
      (data) => {
        window.clearTimeout(deadline);
        if (!active) return;
        setChain({ chain: data, type: "ready" });
        setLastChain(data);
      },
      (error: unknown) => {
        window.clearTimeout(deadline);
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
      window.clearTimeout(deadline);
    };
  }, [optionsChain, symbol, expiry, ready, attempt]);

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
      onRetry={() => setAttempt(attempt + 1)}
      selectedExpiry={query.expiry}
      state={chain}
      symbol={symbol}
    />
  );

  return (
    <div className="space-y-6" data-stock-detail={symbol}>
      <div className="space-y-2">
        <KpiRow state={chain} />
        {chain.type === "ready" ? <SourceLines chain={chain.chain} /> : null}
      </div>
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
