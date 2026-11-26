"use client";

import {
  type BacktestResultSummaryOutput,
  MARKET_BAR_SIZES,
  MARKET_SEC_TYPES,
  MARKET_WHAT_TO_SHOW,
  type MarketBarSize,
  type MarketBarsInput,
  type MarketBarsOutput,
  type MarketSecType,
} from "@darkfactory/api";
import { Button, Input, Panel } from "@darkfactory/ui";
import Link from "next/link";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  analysisTimeZone,
  closeReturns,
  isIntradayBarSize,
  returnHistogram,
  returnStats,
  sessionStats,
} from "../../features/charts/bar-analysis.ts";
import {
  BarReplayControls,
  useBarReplayView,
} from "../../features/charts/bar-replay.tsx";
import {
  type ChartIndicatorKey,
  DEFAULT_CHART_INDICATORS,
  studiesFor,
} from "../../features/charts/chart-indicators.ts";
import {
  aggregateCandles,
  CANDLE_PERIOD_SECONDS,
  type ChartInterval,
  DEFAULT_CHART_INTERVAL,
  INTERVAL_BARS,
  intervalForBars,
  parseIntervalParam,
} from "../../features/charts/chart-intervals.ts";
import {
  ChartToolbar,
  type ChartToolbarOpenInterest,
} from "../../features/charts/chart-toolbar.tsx";
import {
  type FuturesOiBar,
  futuresOiBars,
  futuresOiDaily,
  futuresOiFrom,
  futuresOiMarket,
  futuresOiPane,
} from "../../features/charts/futures-oi.ts";
import {
  BAR_SECONDS,
  barsToDisplayCandles,
  coerceDuration,
  DISPLAY_CANDLE_LIMIT,
  durationOptionsFor,
  type TradeLike,
  tradeMarkers,
} from "../../features/charts/market-bars.ts";
import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import {
  isLinkableSymbol,
  parseSymbolParam,
  withSymbolParam,
} from "../../features/charts/symbol-param.ts";
import type {
  ChartMarker,
  DisplayCandle,
} from "../../features/charts/types.ts";
import {
  createBrowserOpenbbGateway,
  type IvHistoryGateway,
  type OpenbbGateway,
} from "../../features/openbb/gateway.ts";
import type { OrderFlowGateway } from "../../features/order-flow/order-flow-client.ts";
import {
  flowEventsToChartMarkers,
  ORDER_FLOW_MARKER_KINDS,
} from "../../features/order-flow/order-flow-markers.ts";
import {
  createBrowserOptionsChainGateway,
  type OptionsChainGateway,
} from "../../features/stock-detail/options-chain-client.ts";
import { statusTime, TIME_NOT_REPORTED } from "../status-time.ts";
import {
  type BacktestsGateway,
  createBrowserBacktestsGateway,
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  OPERATOR_ACCESS_REQUIRED_TEXT,
} from "./agent-ops-client.tsx";
import {
  ReturnHistogram,
  ReturnStatsTable,
  SessionTable,
} from "./charts-analysis-panels.tsx";
import { ExpectedMoveBar } from "./expected-move-bar.tsx";
import {
  createBrowserFlowEventsGateway,
  createBrowserFlowSnapshotGateway,
  type FlowEventsGateway,
  type FlowSnapshotGateway,
  isFlowInstrument,
} from "./flow-events-client.ts";
import { FuturesOiPanel } from "./futures-oi-panel.tsx";
import { GammaLevelsBar } from "./gamma-levels-bar.tsx";
import { IvRankHistoryPanel } from "./iv-rank-history-panel.tsx";
import type { JevVerdictGateway } from "./jev-verdict-client.ts";
import { JevVerdictPanel } from "./jev-verdict-panel.tsx";
import {
  createBrowserMarketDataGateway,
  describeMarketDataFailure,
  type MarketDataFailure,
  type MarketDataGateway,
} from "./market-data-client.ts";
import type { OptionsAnalyticsGateway } from "./options-analytics-client.ts";
import { OptionsAnalyticsPanel } from "./options-analytics-panel.tsx";
import {
  type FlowEventsLoadState,
  OrderFlowMarksBar,
} from "./order-flow-marks-bar.tsx";
import { OrderFlowPanel } from "./order-flow-panel.tsx";
import { useExpectedMoveView } from "./use-expected-move.ts";
import { useFuturesOi } from "./use-futures-oi.ts";
import {
  type OptionsAnalyticsReport,
  useGammaLevelsView,
} from "./use-gamma-levels.ts";

// Fetch time for a title. A text that is not an ISO time with a zone is shown as sent,
// the same text the Fetched cell shows.
const fetchedTitle = (fetchedAt: string): string => {
  const time = statusTime(fetchedAt);
  return time === TIME_NOT_REPORTED && fetchedAt !== "" ? fetchedAt : time;
};

// KLineCharts loads only in the browser after bars arrive.
const LazyMarketBarsChart = lazy(async () => ({
  default: (await import("../../features/charts/market-chart.tsx"))
    .MarketBarsChart,
}));

export type ChartsForm = Readonly<{
  symbol: string;
  secType: MarketSecType;
  exchange: string;
  currency: string;
  barSize: MarketBarSize;
  duration: string;
  whatToShow: (typeof MARKET_WHAT_TO_SHOW)[number];
  useRTH: boolean;
  contractMonth: string;
}>;

const DEFAULT_CHARTS_FORM: ChartsForm = Object.freeze({
  barSize: "1 day",
  contractMonth: "",
  currency: "USD",
  duration: "1 Y",
  exchange: "SMART",
  secType: "STK",
  symbol: "SPY",
  useRTH: true,
  whatToShow: "TRADES",
});

// IBKR has no TRADES data for forex, so a CASH chart is MIDPOINT only. The value is derived here and
// not written into the form, so the operator's own Data choice is back after a forex chart.
const whatToShowFor = ({
  secType,
  whatToShow,
}: Pick<ChartsForm, "secType" | "whatToShow">): ChartsForm["whatToShow"] =>
  secType === "CASH" ? "MIDPOINT" : whatToShow;

// A forex pair is the base symbol plus the quote currency (EUR.USD); other markets show the symbol.
const marketLabel = ({
  symbol,
  secType,
  currency,
}: Pick<ChartsForm, "symbol" | "secType" | "currency">): string => {
  const base = symbol.trim().toUpperCase();
  return secType === "CASH" ? `${base}.${currency.trim().toUpperCase()}` : base;
};

const buildBarsInput = (form: ChartsForm): MarketBarsInput => {
  const exchange = form.exchange.trim().toUpperCase();
  const contractMonth = form.contractMonth.trim();
  return {
    secType: form.secType,
    symbol: form.symbol.trim().toUpperCase(),
    ...(exchange === "" ? {} : { exchange }),
    barSize: form.barSize,
    currency: form.currency.trim().toUpperCase(),
    duration: form.duration,
    useRTH: form.useRTH,
    whatToShow: whatToShowFor(form),
    ...(form.secType === "FUT" && contractMonth !== ""
      ? { contractMonth }
      : {}),
  };
};

type UrlChart = Readonly<{
  form: ChartsForm;
  interval: ChartInterval;
  error: string | null;
  linked: boolean;
}>;

// `?symbol=` and `?interval=` (1m..1M); missing values keep the SPY 1D default.
const formFromUrl = (search: string): UrlChart => {
  const interval = parseIntervalParam(search);
  const { barSize, duration } = INTERVAL_BARS[interval];
  const base = { ...DEFAULT_CHARTS_FORM, barSize, duration };
  const param = parseSymbolParam(search);
  if (param.type === "valid")
    return {
      error: null,
      form: { ...base, symbol: param.symbol },
      interval,
      linked: true,
    };
  return {
    error:
      param.type === "invalid"
        ? `"${param.raw}" is not a valid ticker. Showing ${DEFAULT_CHARTS_FORM.symbol}.`
        : null,
    form: base,
    interval,
    linked: false,
  };
};

// Adds a history entry only when the loaded symbol or interval differs from the
// URL, and only for STK requests the link can reproduce: a reloaded link rebuilds
// the stock defaults, so a futures entry would re-request the root as a stock.
const pushChartUrl = (
  { secType, symbol }: MarketBarsInput,
  interval: ChartInterval | null
): void => {
  if (!(secType === "STK" && isLinkableSymbol(symbol))) return;
  const { pathname, search } = window.location;
  const params = new URLSearchParams(withSymbolParam(search, symbol));
  if (interval === null || interval === DEFAULT_CHART_INTERVAL)
    params.delete("interval");
  else params.set("interval", interval);
  const next = `?${params.toString()}`;
  if (next === search) return;
  window.history.pushState(null, "", `${pathname}${next}`);
};

// Syncs the form with `?symbol=` on demand and on back/forward. After a linked
// symbol loads, scrolls the results into view (the form fills a phone screen).
// A failed linked load or a manual submit cancels the pending scroll.
const useSymbolDeepLink = (
  apply: (form: ChartsForm, interval: ChartInterval) => void,
  load: (input: MarketBarsInput) => Promise<void>,
  barsType: BarsState["type"]
) => {
  const [linkError, setLinkError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollPending = useRef(false);
  const applyUrlSymbol = useCallback((): ChartsForm => {
    const next = formFromUrl(window.location.search);
    setLinkError(next.error);
    apply(next.form, next.interval);
    scrollPending.current = next.linked;
    return next.form;
  }, [apply]);
  useEffect(() => {
    const chartsPath = window.location.pathname;
    const onPop = () => {
      // Back/forward to another route: leave it to the router.
      if (window.location.pathname !== chartsPath) return;
      void load(buildBarsInput(applyUrlSymbol()));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyUrlSymbol, load]);
  useEffect(() => {
    if (barsType === "error") scrollPending.current = false;
    if (!(barsType === "ready" && scrollPending.current)) return;
    scrollPending.current = false;
    resultsRef.current?.scrollIntoView({ block: "start" });
  }, [barsType]);
  const clearLink = useCallback(() => {
    setLinkError(null);
    scrollPending.current = false;
  }, []);
  return { applyUrlSymbol, clearLink, linkError, resultsRef };
};

const LinkError = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-sm" data-link-error="" role="alert">
      {message}
    </p>
  );

// SMART routing applies to stocks, IDEALPRO to forex; futures need a venue (CME by default).
const DEFAULT_EXCHANGES = ["SMART", "CME", "IDEALPRO"];
const exchangeFor = (secType: MarketSecType, current: string): string => {
  const value = current.trim().toUpperCase();
  const preset = value === "" || DEFAULT_EXCHANGES.includes(value);
  if (secType === "STK") return preset ? "SMART" : current;
  if (secType === "CASH") return preset ? "IDEALPRO" : current;
  return preset ? "CME" : current;
};

type QuickPick = Readonly<{
  label: string;
  market: Pick<ChartsForm, "symbol" | "secType" | "exchange" | "currency">;
}>;

const future = (symbol: string) =>
  ({ currency: "USD", exchange: "CME", secType: "CONTFUT", symbol }) as const;
const stock = (symbol: string) =>
  ({ currency: "USD", exchange: "SMART", secType: "STK", symbol }) as const;
const forex = (symbol: string, currency: string) =>
  ({ currency, exchange: "IDEALPRO", secType: "CASH", symbol }) as const;

// Common markets for the charts picker; a forex pair is base symbol + quote currency.
const QUICK_PICKS: readonly QuickPick[] = [
  { label: "ES (E-mini S&P)", market: future("ES") },
  { label: "NQ (E-mini Nasdaq)", market: future("NQ") },
  { label: "SPY", market: stock("SPY") },
  { label: "QQQ", market: stock("QQQ") },
  { label: "EUR.USD", market: forex("EUR", "USD") },
  { label: "USD.JPY", market: forex("USD", "JPY") },
  { label: "GBP.USD", market: forex("GBP", "USD") },
];

type BarsState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: MarketBarsOutput }>
  | Readonly<{ type: "error"; failure: MarketDataFailure }>;

type BacktestListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: BacktestResultSummaryOutput[] }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>;

type TradesState =
  | Readonly<{ type: "none" }>
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; id: string; trades: readonly TradeLike[] }>
  | Readonly<{ type: "error"; id: string; message: string }>;

const NO_MARKERS: readonly ChartMarker[] = Object.freeze([]);
const NO_OI_BARS: readonly FuturesOiBar[] = Object.freeze([]);
const OPEN_INTEREST_DAILY_HINT =
  "Open interest is a daily figure. Choose the 1D interval to see it.";

const SEC_TYPE_LABELS: Readonly<Record<MarketSecType, string>> = {
  CASH: "Forex (CASH)",
  CONTFUT: "Continuous future (CONTFUT)",
  FUT: "Future (FUT)",
  STK: "Stock (STK)",
};
const selectClass =
  "h-11 w-full rounded-sm border border-border-strong bg-surface px-2 text-sm";
const fieldClass = "space-y-1 text-xs";

const decimals = (value: number): number => {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 || text.includes("e") ? 0 : text.length - dot - 1;
};

const pricePrecisionFor = (data: MarketBarsOutput): number => {
  return Math.min(
    6,
    Math.max(2, ...data.bars.slice(-200).map((bar) => decimals(bar.c)))
  );
};

const Field = ({
  label,
  controlId,
  children,
}: {
  readonly label: string;
  readonly controlId: string;
  readonly children: ReactNode;
}) => (
  <div className={fieldClass}>
    <label className="block text-muted-foreground" htmlFor={controlId}>
      {label}
    </label>
    {children}
  </div>
);

const BarsForm = ({
  form,
  onChange,
  onSubmit,
  busy,
}: {
  readonly form: ChartsForm;
  readonly onChange: (next: ChartsForm) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
}) => {
  const fieldId = useId();
  const durations = durationOptionsFor(form.barSize);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return onSubmit();
  };
  const changeSecType = (event: ChangeEvent<HTMLSelectElement>) => {
    const secType = event.target.value as MarketSecType;
    return onChange({
      ...form,
      contractMonth: secType === "FUT" ? form.contractMonth : "",
      exchange: exchangeFor(secType, form.exchange),
      secType,
    });
  };
  const changeQuickPick = (event: ChangeEvent<HTMLSelectElement>) => {
    const pick = QUICK_PICKS.find(({ label }) => label === event.target.value);
    return pick === undefined
      ? undefined
      : onChange({
          ...form,
          ...pick.market,
          contractMonth: "",
        });
  };
  const changeBarSize = (event: ChangeEvent<HTMLSelectElement>) => {
    const barSize = event.target.value as MarketBarSize;
    return onChange({
      ...form,
      barSize,
      duration: coerceDuration(barSize, form.duration),
    });
  };
  return (
    <form
      aria-label="Bar request"
      className="flex flex-wrap items-center gap-2"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor={`${fieldId}-symbol`}>
        Symbol
      </label>
      <Input
        aria-label="Symbol"
        autoCapitalize="characters"
        className="h-11 w-28 font-medium uppercase"
        id={`${fieldId}-symbol`}
        maxLength={12}
        onChange={(event) => onChange({ ...form, symbol: event.target.value })}
        required
        spellCheck={false}
        value={form.symbol}
      />
      <select
        aria-label="Quick pick"
        className="h-11 rounded-sm border border-border-strong bg-surface px-2 text-sm"
        onChange={changeQuickPick}
        value=""
      >
        <option disabled value="">
          Markets…
        </option>
        {QUICK_PICKS.map((pick) => (
          <option key={pick.label} value={pick.label}>
            {pick.label}
          </option>
        ))}
      </select>
      <Button disabled={busy} type="submit">
        Open
      </Button>
      <details className="open:w-full" data-bar-settings="">
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-border-strong px-3 text-sm">
          Settings
        </summary>
        <div className="mt-2 grid w-full gap-3 rounded-md border border-border-strong bg-popover p-4 text-popover-foreground shadow-md sm:grid-cols-2">
          <Field controlId={`${fieldId}-security-type`} label="Security type">
            <select
              aria-label="Security type"
              className={selectClass}
              id={`${fieldId}-security-type`}
              onChange={changeSecType}
              value={form.secType}
            >
              {MARKET_SEC_TYPES.map((value) => (
                <option key={value} value={value}>
                  {SEC_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field controlId={`${fieldId}-exchange`} label="Exchange">
            <Input
              aria-label="Exchange"
              id={`${fieldId}-exchange`}
              maxLength={16}
              onChange={(event) =>
                onChange({ ...form, exchange: event.target.value })
              }
              spellCheck={false}
              value={form.exchange}
            />
          </Field>
          <Field controlId={`${fieldId}-currency`} label="Currency">
            <Input
              aria-label="Currency"
              id={`${fieldId}-currency`}
              maxLength={3}
              onChange={(event) =>
                onChange({ ...form, currency: event.target.value })
              }
              spellCheck={false}
              value={form.currency}
            />
          </Field>
          {form.secType === "FUT" ? (
            <Field
              controlId={`${fieldId}-contract-month`}
              label="Contract month"
            >
              <Input
                aria-label="Contract month"
                id={`${fieldId}-contract-month`}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) =>
                  onChange({ ...form, contractMonth: event.target.value })
                }
                placeholder="YYYYMM"
                value={form.contractMonth}
              />
            </Field>
          ) : null}
          <Field controlId={`${fieldId}-bar-size`} label="Bar size">
            <select
              aria-label="Bar size"
              className={selectClass}
              id={`${fieldId}-bar-size`}
              onChange={changeBarSize}
              value={form.barSize}
            >
              {MARKET_BAR_SIZES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field controlId={`${fieldId}-duration`} label="Duration">
            <select
              aria-label="Duration"
              className={selectClass}
              id={`${fieldId}-duration`}
              onChange={(event) =>
                onChange({ ...form, duration: event.target.value })
              }
              value={form.duration}
            >
              {durations.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field controlId={`${fieldId}-data`} label="Data">
            <select
              aria-label="Data"
              className={selectClass}
              id={`${fieldId}-data`}
              onChange={(event) =>
                onChange({
                  ...form,
                  whatToShow: event.target.value as ChartsForm["whatToShow"],
                })
              }
              value={whatToShowFor(form)}
            >
              {(form.secType === "CASH"
                ? (["MIDPOINT"] as const)
                : MARKET_WHAT_TO_SHOW
              ).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 self-end text-sm">
            <input
              checked={form.useRTH}
              className="size-5"
              onChange={(event) =>
                onChange({ ...form, useRTH: event.target.checked })
              }
              type="checkbox"
            />
            Regular trading hours only
          </label>
        </div>
      </details>
    </form>
  );
};

const formatAge = (seconds: number): string => `${seconds} s`;

const SourceSummary = ({
  data,
  dropped,
  skipped,
}: {
  readonly data: MarketBarsOutput;
  readonly dropped: number;
  readonly skipped: number;
}) => {
  const { contract, cache } = data;
  return (
    <div className="space-y-1">
      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs"
        data-market-source={data.source}
      >
        <dt className="text-muted-foreground">Source</dt>
        <dd>IBKR Gateway</dd>
        <dt className="text-muted-foreground">Contract</dt>
        <dd className="font-mono">
          {[
            contract.localSymbol,
            contract.longName,
            `conId ${contract.conId}`,
            contract.exchange,
            contract.currency,
            contract.lastTradeDateOrContractMonth,
          ]
            .filter((part) => part !== null && part !== "")
            .join(" · ")}
        </dd>
        <dt className="text-muted-foreground">As of</dt>
        {data.asOf === null ? (
          <dd
            className="font-mono"
            data-as-of="not-reported"
            title={`IBKR Gateway sent no as-of time; fetched ${fetchedTitle(data.fetchedAt)}`}
          >
            not reported by source
          </dd>
        ) : (
          <dd className="font-mono">{data.asOf}</dd>
        )}
        <dt className="text-muted-foreground">Fetched</dt>
        <dd className="font-mono">{data.fetchedAt}</dd>
        <dt className="text-muted-foreground">Cache</dt>
        <dd
          className="font-mono"
          data-cache-hit={String(cache.hit)}
          data-cache-stale={String(cache.stale)}
        >
          {cache.hit ? "hit" : "miss"} · age {formatAge(cache.ageSeconds)} · TTL{" "}
          {formatAge(cache.ttlSeconds)} · {cache.stale ? "stale" : "fresh"}
        </dd>
        <dt className="text-muted-foreground">Bars</dt>
        <dd className="font-mono" data-bar-count={data.count}>
          {data.count}
        </dd>
      </dl>
      {dropped > 0 ? (
        <p className="text-muted-foreground text-xs" role="status">
          Chart shows the last {DISPLAY_CANDLE_LIMIT} of {data.bars.length}{" "}
          bars.
        </p>
      ) : null}
      {skipped > 0 ? (
        <p className="text-muted-foreground text-xs" role="status">
          {skipped} bars with invalid or repeated values left out of the chart.
        </p>
      ) : null}
    </div>
  );
};

const Analysis = ({ data }: { readonly data: MarketBarsOutput }) => {
  const barSize = data.request.barSize;
  const intraday = isIntradayBarSize(barSize);
  const zone = analysisTimeZone(barSize, data.contract.timeZoneId);
  const returns = useMemo(() => closeReturns(data.bars), [data.bars]);
  const values = useMemo(() => returns.map((row) => row.r), [returns]);
  const stats = useMemo(() => returnStats(values), [values]);
  const bins = useMemo(() => returnHistogram(values), [values]);
  const weekdays = useMemo(
    () => sessionStats(returns, "weekday", zone),
    [returns, zone]
  );
  const hours = useMemo(
    () => (intraday ? sessionStats(returns, "hour", zone) : []),
    [returns, intraday, zone]
  );
  return (
    <div className="space-y-5">
      <ReturnStatsTable stats={stats} />
      <ReturnHistogram bins={bins} />
      <div className="grid gap-4 lg:grid-cols-2">
        <SessionTable
          keyLabel="Weekday"
          kind="weekday"
          rows={weekdays}
          title={`By weekday (${zone})`}
        />
        {intraday ? (
          <SessionTable
            keyLabel="Hour"
            kind="hour"
            rows={hours}
            title={`By hour (${zone})`}
          />
        ) : null}
      </div>
    </div>
  );
};

// The open-interest view of the loaded request (not of the form) over the candles the chart
// shows: during a bar replay nothing after the replay position is drawn or listed. The checkbox
// state is page state like the Volume checkbox (not stored across reloads).
const useOpenInterestView = (
  gateway: Pick<OpenbbGateway, "macro">,
  data: MarketBarsOutput | null,
  merged: boolean,
  candles: readonly DisplayCandle[]
) => {
  const [checked, setChecked] = useState(true);
  const market = data === null ? null : futuresOiMarket(data.request);
  const daily = data !== null && futuresOiDaily(data.request.barSize, merged);
  const from = useMemo(() => futuresOiFrom(candles), [candles]);
  const state = useFuturesOi({
    enabled: daily && checked,
    from,
    gateway,
    market,
  });
  const series = state.type === "ready" ? state.series : null;
  const bars = useMemo(
    () =>
      series === null
        ? NO_OI_BARS
        : futuresOiBars(candles, series.points, series.firstDate),
    [candles, series]
  );
  const pane = useMemo(() => futuresOiPane(bars), [bars]);
  const control = useMemo(
    (): ChartToolbarOpenInterest | null =>
      market === null
        ? null
        : {
            checked,
            disabled: !daily,
            hint: daily ? null : OPEN_INTEREST_DAILY_HINT,
            onChange: setChecked,
          },
    [checked, daily, market]
  );
  return { bars, control, market, pane, state };
};

export interface ChartsWorkspaceProps {
  readonly autoLoad?: boolean;
  readonly backtests?: BacktestsGateway;
  readonly flowEvents?: FlowEventsGateway;
  readonly flowSnapshot?: FlowSnapshotGateway;
  readonly ivHistory?: IvHistoryGateway;
  readonly jevVerdict?: JevVerdictGateway;
  readonly marketData?: MarketDataGateway;
  // Reads the stored CME open-interest series of ES and NQ (daily futures charts only).
  readonly openbb?: Pick<OpenbbGateway, "macro">;
  readonly optionsAnalytics?: OptionsAnalyticsGateway;
  readonly optionsChain?: Pick<OptionsChainGateway, "expectedMove">;
  readonly orderFlow?: OrderFlowGateway;
}

export const ChartsWorkspace = ({
  marketData: suppliedMarketData,
  optionsAnalytics,
  optionsChain: suppliedOptionsChain,
  jevVerdict,
  ivHistory,
  orderFlow,
  flowEvents: suppliedFlowEvents,
  flowSnapshot: suppliedFlowSnapshot,
  backtests: suppliedBacktests,
  openbb: suppliedOpenbb,
  autoLoad = true,
}: ChartsWorkspaceProps) => {
  const backtestSelectId = useId();
  const [marketData] = useState(
    () => suppliedMarketData ?? createBrowserMarketDataGateway()
  );
  const [backtests] = useState(
    () => suppliedBacktests ?? createBrowserBacktestsGateway()
  );
  const [openbb] = useState(
    () => suppliedOpenbb ?? createBrowserOpenbbGateway()
  );
  const [flowEvents] = useState(
    () => suppliedFlowEvents ?? createBrowserFlowEventsGateway()
  );
  const [flowSnapshot] = useState(
    () => suppliedFlowSnapshot ?? createBrowserFlowSnapshotGateway()
  );
  const [optionsChain] = useState(
    () => suppliedOptionsChain ?? createBrowserOptionsChainGateway()
  );
  const [form, setForm] = useState<ChartsForm>(DEFAULT_CHARTS_FORM);
  // Null when the settings request a bar size and duration no interval button matches.
  const [interval, setInterval] = useState<ChartInterval | null>(
    DEFAULT_CHART_INTERVAL
  );
  const [bars, setBars] = useState<BarsState>({ type: "idle" });
  const [volume, setVolume] = useState(true);
  const [indicators, setIndicators] = useState<readonly ChartIndicatorKey[]>(
    DEFAULT_CHART_INDICATORS
  );
  const [showFlowMarks, setShowFlowMarks] = useState(true);
  const [flowEventsState, setFlowEventsState] = useState<FlowEventsLoadState>({
    type: "idle",
  });
  const [analyticsReport, setAnalyticsReport] =
    useState<OptionsAnalyticsReport | null>(null);
  const [backtestList, setBacktestList] = useState<BacktestListState>({
    type: "loading",
  });
  const [trades, setTrades] = useState<TradesState>({ type: "none" });
  const generation = useRef(0);
  const tradesGeneration = useRef(0);
  const flowEventsGeneration = useRef(0);
  const started = useRef(false);
  const load = useCallback(
    async (input: MarketBarsInput) => {
      const mine = ++generation.current;
      setBars({ type: "loading" });
      try {
        const data = await marketData.bars(input);
        if (mine === generation.current)
          return setBars({ data, type: "ready" });
        return;
      } catch (error) {
        if (mine === generation.current)
          return setBars({
            failure: describeMarketDataFailure(error),
            type: "error",
          });
        return;
      }
    },
    [marketData]
  );

  const applyUrl = useCallback(
    (next: ChartsForm, nextInterval: ChartInterval) => {
      setForm(next);
      setInterval(nextInterval);
    },
    []
  );
  const { linkError, clearLink, applyUrlSymbol, resultsRef } =
    useSymbolDeepLink(applyUrl, load, bars.type);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const initial = applyUrlSymbol();
    if (autoLoad) void load(buildBarsInput(initial));
    return void (async () => {
      try {
        return setBacktestList({ rows: await backtests.list(), type: "ready" });
      } catch (error) {
        return setBacktestList(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : { message: describeAgentOpsFailure(error), type: "error" }
        );
      }
    })();
  }, [applyUrlSymbol, autoLoad, backtests, load]);

  const submit = useCallback(() => {
    const input = buildBarsInput(form);
    // Keep 1W/1M (daily bars, merged) when the settings still request daily bars.
    const kept =
      interval !== null &&
      INTERVAL_BARS[interval].barSize === form.barSize &&
      INTERVAL_BARS[interval].duration === form.duration
        ? interval
        : intervalForBars(form.barSize, form.duration);
    setInterval(kept);
    clearLink();
    pushChartUrl(input, kept);
    void load(input);
  }, [clearLink, form, interval, load]);

  const chooseInterval = useCallback(
    (next: ChartInterval) => {
      const { barSize, duration } = INTERVAL_BARS[next];
      const nextForm = { ...form, barSize, duration };
      const input = buildBarsInput(nextForm);
      setForm(nextForm);
      setInterval(next);
      clearLink();
      pushChartUrl(input, next);
      void load(input);
    },
    [clearLink, form, load]
  );

  const chooseBacktest = useCallback(
    async (id: string) => {
      const mine = ++tradesGeneration.current;
      if (id === "") {
        setTrades({ type: "none" });
        return;
      }
      setTrades({ id, type: "loading" });
      try {
        const detail = await backtests.get(id);
        if (mine === tradesGeneration.current)
          return setTrades({
            id,
            trades: detail.backtest.trades,
            type: "ready",
          });
        return;
      } catch (error) {
        if (mine === tradesGeneration.current)
          return setTrades({
            id,
            message: describeAgentOpsFailure(error),
            type: "error",
          });
        return;
      }
    },
    [backtests]
  );

  const data = bars.type === "ready" ? bars.data : null;
  // 1W/1M merge daily bars into week or month candles.
  const requested =
    interval === null ? null : INTERVAL_BARS[interval].aggregate;
  const aggregate =
    data === null || data.request.barSize !== "1 day" ? null : requested;
  const display = useMemo(() => {
    if (data === null) return null;
    const result = barsToDisplayCandles(data.bars);
    return aggregate === null
      ? result
      : { ...result, candles: aggregateCandles(result.candles, aggregate) };
  }, [data, aggregate]);
  const studies = useMemo(
    () => studiesFor(volume, indicators),
    [volume, indicators]
  );
  const barSeconds =
    data === null
      ? 0
      : aggregate === null
        ? BAR_SECONDS[data.request.barSize]
        : CANDLE_PERIOD_SECONDS[aggregate];
  useEffect(() => {
    const mine = ++flowEventsGeneration.current;
    if (!showFlowMarks || data === null || display === null) {
      setFlowEventsState({ type: "idle" });
      return;
    }
    const firstCandle = display.candles[0];
    const lastCandle = display.candles.at(-1);
    if (firstCandle === undefined || lastCandle === undefined) {
      setFlowEventsState({ type: "idle" });
      return;
    }
    const { secType, symbol } = data.request;
    if (!isFlowInstrument(symbol, secType)) {
      setFlowEventsState({
        secType,
        symbol,
        type: "unsupported",
      });
      return;
    }
    setFlowEventsState({ type: "loading" });
    void (async () => {
      try {
        const output = await flowEvents.events({
          from: new Date(firstCandle.timestamp).toISOString(),
          kinds: [...ORDER_FLOW_MARKER_KINDS],
          symbol,
          to: new Date(lastCandle.timestamp + barSeconds * 1000).toISOString(),
        });
        if (mine === flowEventsGeneration.current)
          setFlowEventsState({
            events: output.events,
            truncated: output.truncated,
            type: "ready",
          });
      } catch (error) {
        if (mine === flowEventsGeneration.current)
          setFlowEventsState(
            isOperatorAccessDenied(error)
              ? { type: "forbidden" }
              : { message: describeAgentOpsFailure(error), type: "error" }
          );
      }
    })();
    return () => {
      flowEventsGeneration.current += 1;
    };
  }, [showFlowMarks, data, display, barSeconds, flowEvents]);
  const overlay = useMemo(() => {
    if (trades.type !== "ready" || data === null || display === null)
      return null;
    return tradeMarkers(
      trades.trades,
      display.candles,
      // A merged candle covers its whole week or month.
      barSeconds,
      [data.request.symbol, data.contract.localSymbol]
    );
  }, [trades, data, display, barSeconds]);
  const flowMarkerOverlay = useMemo(() => {
    if (
      !showFlowMarks ||
      flowEventsState.type !== "ready" ||
      data === null ||
      display === null
    )
      return null;
    return flowEventsToChartMarkers(
      flowEventsState.events,
      display.candles,
      barSeconds
    );
  }, [showFlowMarks, flowEventsState, data, display, barSeconds]);
  const allMarkers = useMemo(
    () => [
      ...(overlay?.markers ?? NO_MARKERS),
      ...(flowMarkerOverlay?.markers ?? NO_MARKERS),
    ],
    [overlay, flowMarkerOverlay]
  );
  const {
    candles: replayCandles,
    dispatch: replayDispatch,
    label: replayLabel,
    markers,
    state: replay,
  } = useBarReplayView(display, allMarkers);
  const selectedBacktest = trades.type === "none" ? "" : trades.id;

  const oi = useOpenInterestView(
    openbb,
    data,
    aggregate !== null,
    replayCandles
  );
  const expectedMove = useExpectedMoveView({
    candles: replayCandles,
    currency: data?.request.currency ?? null,
    gateway: optionsChain,
    replayActive: replay.active,
    secType: data?.request.secType ?? null,
    symbol: data?.request.symbol ?? null,
  });
  const analyticsEligible =
    data !== null &&
    data.request.secType === "STK" &&
    data.request.currency === "USD";
  useEffect(() => {
    if (!analyticsEligible) setAnalyticsReport(null);
  }, [analyticsEligible]);
  const gammaLevels = useGammaLevelsView({
    analyticsReport,
    currency: data?.request.currency ?? null,
    flowSnapshot,
    replayActive: replay.active,
    secType: data?.request.secType ?? null,
    symbol: data?.request.symbol ?? null,
  });

  const shown = marketLabel(data?.request ?? form);
  const stockLink =
    data !== null && data.request.secType === "STK"
      ? data.request.symbol
      : null;

  return (
    <div className="space-y-6">
      <Panel
        actions={
          <>
            <BarsForm
              busy={bars.type === "loading"}
              form={form}
              onChange={setForm}
              onSubmit={submit}
            />
            {stockLink === null ? null : (
              <Link
                className="inline-flex min-h-11 items-center rounded-md px-3 font-medium text-sm underline-offset-4 hover:underline"
                href={`/stock/${encodeURIComponent(stockLink)}`}
                prefetch={false}
              >
                Options chain
              </Link>
            )}
          </>
        }
        data-chart-panel=""
        description="IBKR historical bars. The symbol and interval stay in the URL."
        title={`${shown} · ${interval ?? form.barSize}`}
      >
        <div className="space-y-4">
          <LinkError message={linkError} />
          <ChartToolbar
            indicators={indicators}
            interval={interval}
            onIndicators={setIndicators}
            onInterval={chooseInterval}
            onVolume={setVolume}
            volume={volume}
            {...(oi.control === null ? {} : { openInterest: oi.control })}
          >
            <div className="flex min-w-64 items-center gap-2 text-sm">
              <label
                className="whitespace-nowrap text-muted-foreground"
                htmlFor={backtestSelectId}
              >
                Backtest trades
              </label>
              {backtestList.type === "forbidden" ? (
                <span className="block text-sm" role="status">
                  {OPERATOR_ACCESS_REQUIRED_TEXT}
                </span>
              ) : backtestList.type === "error" ? (
                <span className="block text-sm" role="status">
                  {backtestList.message}
                </span>
              ) : (
                <select
                  aria-label="Backtest trades"
                  className={selectClass}
                  disabled={backtestList.type === "loading"}
                  id={backtestSelectId}
                  onChange={(event) => void chooseBacktest(event.target.value)}
                  value={selectedBacktest}
                >
                  <option value="">None</option>
                  {backtestList.type === "ready"
                    ? backtestList.rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.strategy} · {row.instruments} · {row.periodStart}{" "}
                          to {row.periodEnd}
                        </option>
                      ))
                    : null}
                </select>
              )}
            </div>
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
              <input
                checked={showFlowMarks}
                className="size-4"
                data-flow-marks-toggle=""
                onChange={(event) => setShowFlowMarks(event.target.checked)}
                type="checkbox"
              />
              Order-flow marks
            </label>
            {expectedMove.eligible ? (
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
                <input
                  checked={expectedMove.enabled}
                  className="size-4"
                  data-expected-move-toggle=""
                  onChange={(event) =>
                    expectedMove.setEnabled(event.target.checked)
                  }
                  type="checkbox"
                />
                Expected move
              </label>
            ) : null}
            {gammaLevels.eligible ? (
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
                <input
                  checked={gammaLevels.enabled}
                  className="size-4"
                  data-gamma-levels-toggle=""
                  onChange={(event) =>
                    gammaLevels.setEnabled(event.target.checked)
                  }
                  type="checkbox"
                />
                Gamma levels
              </label>
            ) : null}
          </ChartToolbar>
          <OrderFlowMarksBar
            enabled={showFlowMarks}
            priceDigits={data === null ? 2 : pricePrecisionFor(data)}
            state={flowEventsState}
            summary={flowMarkerOverlay}
          />
          {expectedMove.eligible ? (
            <ExpectedMoveBar
              enabled={expectedMove.enabled}
              expiries={expectedMove.expiries}
              horizonScale={expectedMove.horizonScale}
              onExpiry={expectedMove.onExpiry}
              onRetry={expectedMove.onRetry}
              priceDigits={data === null ? 2 : pricePrecisionFor(data)}
              replayActive={replay.active}
              selectedExpiry={expectedMove.selectedExpiry}
              state={expectedMove.state}
            />
          ) : null}
          {gammaLevels.eligible && data !== null ? (
            <GammaLevelsBar
              enabled={gammaLevels.enabled}
              onRetry={gammaLevels.onRetry}
              priceDigits={pricePrecisionFor(data)}
              replayActive={replay.active}
              state={gammaLevels.state}
            />
          ) : null}
          {trades.type === "loading" ? (
            <p aria-busy="true" className="text-muted-foreground text-xs">
              Loading trades…
            </p>
          ) : null}
          {trades.type === "error" ? (
            <p className="text-xs" role="alert">
              {trades.message}
            </p>
          ) : null}
          {overlay === null ? null : (
            <p
              className="font-mono text-muted-foreground text-xs"
              data-marker-summary=""
              role="status"
            >
              Trade markers: {overlay.shown} shown · {overlay.outside} outside
              loaded bars
              {overlay.otherSymbol > 0
                ? ` · ${overlay.otherSymbol} trades for other symbols skipped`
                : ""}
            </p>
          )}
          {bars.type === "loading" ? (
            <p aria-busy="true" className="text-muted-foreground text-sm">
              Loading bars…
            </p>
          ) : bars.type === "error" ? (
            <div
              className="space-y-1 rounded-md border border-border p-4"
              data-error-code={bars.failure.code}
              role="alert"
            >
              <p className="font-mono text-sm">{bars.failure.code}</p>
              <p className="text-sm">{bars.failure.message}</p>
            </div>
          ) : null}
          {data !== null && display !== null ? (
            <div className="space-y-4" data-chart-results="" ref={resultsRef}>
              {display.candles.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No bars returned.
                </p>
              ) : (
                <ChartRendererBoundary>
                  <BarReplayControls
                    dispatch={replayDispatch}
                    label={replayLabel}
                    state={replay}
                    total={display.candles.length}
                  />
                  <Suspense
                    fallback={
                      <p className="text-muted-foreground text-xs">
                        Loading chart…
                      </p>
                    }
                  >
                    <LazyMarketBarsChart
                      candles={replayCandles}
                      expectedMove={expectedMove.cone}
                      gammaLevels={gammaLevels.overlay}
                      label={`${data.contract.localSymbol} ${interval ?? data.request.barSize} bars`}
                      markers={markers}
                      pricePrecision={pricePrecisionFor(data)}
                      seriesPane={oi.pane}
                      studies={studies}
                      symbol={data.contract.localSymbol}
                    />
                  </Suspense>
                </ChartRendererBoundary>
              )}
              <SourceSummary
                data={data}
                dropped={display.dropped}
                skipped={display.skipped}
              />
              {oi.market === null ? null : (
                <FuturesOiPanel
                  bars={oi.bars}
                  candles={replayCandles}
                  market={oi.market}
                  state={oi.state}
                />
              )}
            </div>
          ) : null}
        </div>
      </Panel>
      {data === null ? null : (
        <Panel data-return-analysis="" title="Return analysis">
          <Analysis data={data} />
        </Panel>
      )}
      {/* Lazy: fetches nothing until the operator presses Load order flow. Forex has no ticks or depth. */}
      {data === null || data.request.secType === "CASH" ? null : (
        <OrderFlowPanel
          gateway={orderFlow}
          instrument={{
            contractMonth: data.request.contractMonth,
            currency: data.request.currency,
            exchange: data.request.exchange,
            secType: data.request.secType,
            symbol: data.request.symbol,
          }}
          key={`${data.request.symbol}|${data.request.secType}|${data.request.exchange}|${data.request.currency}|${data.request.contractMonth ?? ""}`}
          marketData={marketData}
          storedEvents={
            flowEventsState.type === "ready"
              ? flowEventsState.events
              : undefined
          }
          timeZoneId={data.contract.timeZoneId}
        />
      )}
      {/* QuantData covers US-listed equities only; the JEV verdict uses the same scope. */}
      {data !== null &&
      data.request.secType === "STK" &&
      data.request.currency === "USD" ? (
        <>
          <JevVerdictPanel gateway={jevVerdict} symbol={data.request.symbol} />
          <IvRankHistoryPanel
            gateway={ivHistory}
            symbol={data.request.symbol}
          />
          <OptionsAnalyticsPanel
            gateway={optionsAnalytics}
            onReport={setAnalyticsReport}
            symbol={data.request.symbol}
          />
        </>
      ) : null}
    </div>
  );
};
