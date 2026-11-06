"use client";

import {
  MARKET_BAR_SIZES,
  MARKET_SEC_TYPES,
  MARKET_WHAT_TO_SHOW,
  type BacktestResultSummaryOutput,
  type MarketBarSize,
  type MarketBarsInput,
  type MarketBarsOutput,
  type MarketSecType,
} from "@darkfactory/api";
import { Button, Input, Panel } from "@darkfactory/ui";
import Link from "next/link";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";

import {
  analysisTimeZone,
  closeReturns,
  isIntradayBarSize,
  returnHistogram,
  returnStats,
  sessionStats,
} from "../../features/charts/bar-analysis.ts";
import {
  BAR_SECONDS,
  DISPLAY_CANDLE_LIMIT,
  barsToDisplayCandles,
  coerceDuration,
  durationOptionsFor,
  tradeMarkers,
  type TradeLike,
} from "../../features/charts/market-bars.ts";
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
import { ChartToolbar } from "../../features/charts/chart-toolbar.tsx";
import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import type { ChartMarker } from "../../features/charts/types.ts";
import {
  OPERATOR_ACCESS_REQUIRED_TEXT,
  createBrowserBacktestsGateway,
  describeAgentOpsFailure,
  isOperatorAccessDenied,
  type BacktestsGateway,
} from "./agent-ops-client.tsx";
import {
  ReturnHistogram,
  ReturnStatsTable,
  SessionTable,
} from "./charts-analysis-panels.tsx";
import {
  createBrowserMarketDataGateway,
  describeMarketDataFailure,
  type MarketDataFailure,
  type MarketDataGateway,
} from "./market-data-client.ts";
import type { JevVerdictGateway } from "./jev-verdict-client.ts";
import { JevVerdictPanel } from "./jev-verdict-panel.tsx";
import type { OptionsAnalyticsGateway } from "./options-analytics-client.ts";
import { OptionsAnalyticsPanel } from "./options-analytics-panel.tsx";
import {
  isLinkableSymbol,
  parseSymbolParam,
  withSymbolParam,
} from "../../features/charts/symbol-param.ts";

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
  symbol: "SPY",
  secType: "STK",
  exchange: "SMART",
  currency: "USD",
  barSize: "1 day",
  duration: "1 Y",
  whatToShow: "TRADES",
  useRTH: true,
  contractMonth: "",
});

const buildBarsInput = (form: ChartsForm): MarketBarsInput => {
  const exchange = form.exchange.trim().toUpperCase();
  const contractMonth = form.contractMonth.trim();
  return {
    symbol: form.symbol.trim().toUpperCase(),
    secType: form.secType,
    ...(exchange === "" ? {} : { exchange }),
    currency: form.currency.trim().toUpperCase(),
    barSize: form.barSize,
    duration: form.duration,
    whatToShow: form.whatToShow,
    useRTH: form.useRTH,
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
    form: base,
    interval,
    linked: false,
    error:
      param.type === "invalid"
        ? `"${param.raw}" is not a valid ticker. Showing ${DEFAULT_CHARTS_FORM.symbol}.`
        : null,
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
  return { linkError, clearLink, applyUrlSymbol, resultsRef };
};

const LinkError = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-sm" data-link-error="" role="alert">
      {message}
    </p>
  );

// SMART routing applies to stocks; futures need a venue (CME by default).
const exchangeFor = (secType: MarketSecType, current: string): string => {
  const value = current.trim().toUpperCase();
  if (secType === "STK")
    return value === "" || value === "CME" ? "SMART" : current;
  return value === "" || value === "SMART" ? "CME" : current;
};

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

const SEC_TYPE_LABELS: Readonly<Record<MarketSecType, string>> = {
  STK: "Stock (STK)",
  FUT: "Future (FUT)",
  CONTFUT: "Continuous future (CONTFUT)",
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
      secType,
      exchange: exchangeFor(secType, form.exchange),
      contractMonth: secType === "FUT" ? form.contractMonth : "",
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
      <Button disabled={busy} type="submit">
        Open
      </Button>
      <details className="relative" data-bar-settings="">
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-border-strong px-3 text-sm">
          Settings
        </summary>
        <div className="absolute right-0 z-20 mt-1 grid w-[min(92vw,36rem)] gap-3 rounded-md border border-border-strong bg-popover p-4 text-popover-foreground shadow-md sm:grid-cols-2">
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
              value={form.whatToShow}
            >
              {MARKET_WHAT_TO_SHOW.map((value) => (
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
        <dd className="font-mono">{data.asOf ?? "—"}</dd>
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

export interface ChartsWorkspaceProps {
  readonly marketData?: MarketDataGateway;
  readonly optionsAnalytics?: OptionsAnalyticsGateway;
  readonly jevVerdict?: JevVerdictGateway;
  readonly backtests?: BacktestsGateway;
  readonly autoLoad?: boolean;
}

export const ChartsWorkspace = ({
  marketData: suppliedMarketData,
  optionsAnalytics,
  jevVerdict,
  backtests: suppliedBacktests,
  autoLoad = true,
}: ChartsWorkspaceProps) => {
  const backtestSelectId = useId();
  const [marketData] = useState(
    () => suppliedMarketData ?? createBrowserMarketDataGateway()
  );
  const [backtests] = useState(
    () => suppliedBacktests ?? createBrowserBacktestsGateway()
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
  const [backtestList, setBacktestList] = useState<BacktestListState>({
    type: "loading",
  });
  const [trades, setTrades] = useState<TradesState>({ type: "none" });
  const generation = useRef(0);
  const tradesGeneration = useRef(0);
  const started = useRef(false);

  const load = useCallback(
    async (input: MarketBarsInput) => {
      const mine = ++generation.current;
      setBars({ type: "loading" });
      try {
        const data = await marketData.bars(input);
        if (mine === generation.current)
          return setBars({ type: "ready", data });
        return;
      } catch (error) {
        if (mine === generation.current)
          return setBars({
            type: "error",
            failure: describeMarketDataFailure(error),
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
        return setBacktestList({ type: "ready", rows: await backtests.list() });
      } catch (error) {
        return setBacktestList(
          isOperatorAccessDenied(error)
            ? { type: "forbidden" }
            : { type: "error", message: describeAgentOpsFailure(error) }
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
      setTrades({ type: "loading", id });
      try {
        const detail = await backtests.get(id);
        if (mine === tradesGeneration.current)
          return setTrades({
            type: "ready",
            id,
            trades: detail.backtest.trades,
          });
        return;
      } catch (error) {
        if (mine === tradesGeneration.current)
          return setTrades({
            type: "error",
            id,
            message: describeAgentOpsFailure(error),
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
  const overlay = useMemo(() => {
    if (trades.type !== "ready" || data === null || display === null)
      return null;
    return tradeMarkers(
      trades.trades,
      display.candles,
      // A merged candle covers its whole week or month.
      aggregate === null
        ? BAR_SECONDS[data.request.barSize]
        : CANDLE_PERIOD_SECONDS[aggregate],
      [data.request.symbol, data.contract.localSymbol]
    );
  }, [trades, data, display, aggregate]);
  const markers = overlay?.markers ?? NO_MARKERS;
  const selectedBacktest = trades.type === "none" ? "" : trades.id;

  const shown = data?.request.symbol ?? form.symbol.trim().toUpperCase();
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
                prefetch={false}
                className="inline-flex min-h-11 items-center rounded-md px-3 font-medium text-sm underline-offset-4 hover:underline"
                href={`/stock/${encodeURIComponent(stockLink)}`}
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
          </ChartToolbar>
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
                  <Suspense
                    fallback={
                      <p className="text-muted-foreground text-xs">
                        Loading chart…
                      </p>
                    }
                  >
                    <LazyMarketBarsChart
                      candles={display.candles}
                      label={`${data.contract.localSymbol} ${interval ?? data.request.barSize} bars`}
                      markers={markers}
                      pricePrecision={pricePrecisionFor(data)}
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
            </div>
          ) : null}
        </div>
      </Panel>
      {data === null ? null : (
        <Panel data-return-analysis="" title="Return analysis">
          <Analysis data={data} />
        </Panel>
      )}
      {/* QuantData covers US-listed equities only; the JEV verdict uses the same scope. */}
      {data !== null &&
      data.request.secType === "STK" &&
      data.request.currency === "USD" ? (
        <>
          <JevVerdictPanel gateway={jevVerdict} symbol={data.request.symbol} />
          <OptionsAnalyticsPanel
            gateway={optionsAnalytics}
            symbol={data.request.symbol}
          />
        </>
      ) : null}
    </div>
  );
};
