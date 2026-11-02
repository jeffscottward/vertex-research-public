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
import { Button, Input } from "@darkfactory/ui";
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
import { ChartRendererBoundary } from "../../features/charts/renderer-host.tsx";
import type { ChartMarker, ChartStudies } from "../../features/charts/types.ts";
import {
  VERTEX_STUDIES,
  VERTEX_STUDY_IDS,
  type VertexStudyId,
} from "../../features/charts/vertex-studies.ts";
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

const formFromUrl = (
  search: string
): Readonly<{ form: ChartsForm; error: string | null }> => {
  const param = parseSymbolParam(search);
  if (param.type === "valid")
    return {
      form: { ...DEFAULT_CHARTS_FORM, symbol: param.symbol },
      error: null,
    };
  return {
    form: DEFAULT_CHARTS_FORM,
    error:
      param.type === "invalid"
        ? `"${param.raw}" is not a valid ticker. Showing ${DEFAULT_CHARTS_FORM.symbol}.`
        : null,
  };
};

// Adds a history entry only when the loaded symbol differs from the URL, and
// only for STK requests the link can reproduce: a reloaded link rebuilds the
// stock defaults, so a futures entry would re-request the root as a stock.
const pushSymbolUrl = ({ secType, symbol }: MarketBarsInput): void => {
  if (!(secType === "STK" && isLinkableSymbol(symbol))) return;
  const { pathname, search } = window.location;
  const current = parseSymbolParam(search);
  if (current.type === "valid" && current.symbol === symbol) return;
  window.history.pushState(
    null,
    "",
    `${pathname}${withSymbolParam(search, symbol)}`
  );
};

// Syncs the form with `?symbol=` on demand and on back/forward. After a linked
// symbol loads, scrolls the results into view (the form fills a phone screen).
// A failed linked load or a manual submit cancels the pending scroll.
const useSymbolDeepLink = (
  setForm: (form: ChartsForm) => void,
  load: (input: MarketBarsInput) => Promise<void>,
  barsType: BarsState["type"]
) => {
  const [linkError, setLinkError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollPending = useRef(false);
  const applyUrlSymbol = useCallback((): ChartsForm => {
    const next = formFromUrl(window.location.search);
    setLinkError(next.error);
    setForm(next.form);
    scrollPending.current = next.form !== DEFAULT_CHARTS_FORM;
    return next.form;
  }, [setForm]);
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

type StudyToggles = Readonly<{
  volume: boolean;
  sma20: boolean;
  sma50: boolean;
  ema20: boolean;
}>;
const STUDY_LABELS: readonly (readonly [keyof StudyToggles, string])[] = [
  ["volume", "Volume"],
  ["sma20", "SMA 20"],
  ["sma50", "SMA 50"],
  ["ema20", "EMA 20"],
];
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
      className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5"
      onSubmit={submit}
    >
      <Field controlId={`${fieldId}-symbol`} label="Symbol">
        <Input
          id={`${fieldId}-symbol`}
          aria-label="Symbol"
          autoCapitalize="characters"
          maxLength={12}
          onChange={(event) =>
            onChange({ ...form, symbol: event.target.value })
          }
          required
          spellCheck={false}
          value={form.symbol}
        />
      </Field>
      <Field controlId={`${fieldId}-security-type`} label="Security type">
        <select
          id={`${fieldId}-security-type`}
          aria-label="Security type"
          className={selectClass}
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
          id={`${fieldId}-exchange`}
          aria-label="Exchange"
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
          id={`${fieldId}-currency`}
          aria-label="Currency"
          maxLength={3}
          onChange={(event) =>
            onChange({ ...form, currency: event.target.value })
          }
          spellCheck={false}
          value={form.currency}
        />
      </Field>
      {form.secType === "FUT" ? (
        <Field controlId={`${fieldId}-contract-month`} label="Contract month">
          <Input
            id={`${fieldId}-contract-month`}
            aria-label="Contract month"
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
          id={`${fieldId}-bar-size`}
          aria-label="Bar size"
          className={selectClass}
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
          id={`${fieldId}-duration`}
          aria-label="Duration"
          className={selectClass}
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
          id={`${fieldId}-data`}
          aria-label="Data"
          className={selectClass}
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
      <div className="flex items-end">
        <Button disabled={busy} type="submit">
          Load bars
        </Button>
      </div>
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
  readonly backtests?: BacktestsGateway;
  readonly autoLoad?: boolean;
}

// Vertex-computed indicator overlays (display only, fixed default parameters).
const IndicatorToggles = ({
  onChange,
  selected,
}: Readonly<{
  onChange: (next: readonly VertexStudyId[]) => void;
  selected: readonly VertexStudyId[];
}>) => (
  <fieldset
    className="flex flex-wrap items-center gap-3 text-sm"
    data-vertex-studies=""
  >
    <legend className="sr-only">Indicators</legend>
    {VERTEX_STUDY_IDS.map((id) => (
      <label className="flex min-h-11 items-center gap-2" key={id}>
        <input
          checked={selected.includes(id)}
          className="size-5"
          onChange={(event) =>
            onChange(
              VERTEX_STUDY_IDS.filter((other) =>
                other === id ? event.target.checked : selected.includes(other)
              )
            )
          }
          type="checkbox"
        />
        {VERTEX_STUDIES[id].label}
      </label>
    ))}
  </fieldset>
);

export const ChartsWorkspace = ({
  marketData: suppliedMarketData,
  optionsAnalytics,
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
  const [bars, setBars] = useState<BarsState>({ type: "idle" });
  const [toggles, setToggles] = useState<StudyToggles>({
    volume: true,
    sma20: false,
    sma50: false,
    ema20: false,
  });
  const [extraStudies, setExtraStudies] = useState<readonly VertexStudyId[]>(
    []
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

  const { linkError, clearLink, applyUrlSymbol, resultsRef } =
    useSymbolDeepLink(setForm, load, bars.type);

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
    clearLink();
    pushSymbolUrl(input);
    void load(input);
  }, [clearLink, form, load]);

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
  const display = useMemo(
    () => (data === null ? null : barsToDisplayCandles(data.bars)),
    [data]
  );
  const studies = useMemo<ChartStudies>(
    () => ({
      volume: toggles.volume,
      sma: [...(toggles.sma20 ? [20] : []), ...(toggles.sma50 ? [50] : [])],
      ema: toggles.ema20 ? [20] : [],
      extra: extraStudies,
    }),
    [toggles, extraStudies]
  );
  const overlay = useMemo(() => {
    if (trades.type !== "ready" || data === null || display === null)
      return null;
    return tradeMarkers(
      trades.trades,
      display.candles,
      BAR_SECONDS[data.request.barSize],
      [data.request.symbol, data.contract.localSymbol]
    );
  }, [trades, data, display]);
  const markers = overlay?.markers ?? NO_MARKERS;
  const selectedBacktest = trades.type === "none" ? "" : trades.id;

  return (
    <div className="space-y-6">
      <BarsForm
        busy={bars.type === "loading"}
        form={form}
        onChange={setForm}
        onSubmit={submit}
      />
      <LinkError message={linkError} />
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="flex flex-wrap items-center gap-3 text-sm">
          <legend className="sr-only">Studies</legend>
          {STUDY_LABELS.map(([key, label]) => {
            return (
              <label className="flex min-h-11 items-center gap-2" key={key}>
                <input
                  checked={toggles[key]}
                  className="size-5"
                  onChange={(event) =>
                    setToggles({ ...toggles, [key]: event.target.checked })
                  }
                  type="checkbox"
                />
                {label}
              </label>
            );
          })}
        </fieldset>
        <IndicatorToggles onChange={setExtraStudies} selected={extraStudies} />
        <div className="min-w-64 space-y-1 text-xs">
          <label
            className="block text-muted-foreground"
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
              id={backtestSelectId}
              disabled={backtestList.type === "loading"}
              onChange={(event) => void chooseBacktest(event.target.value)}
              value={selectedBacktest}
            >
              <option value="">None</option>
              {backtestList.type === "ready"
                ? backtestList.rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.strategy} · {row.instruments} · {row.periodStart} to{" "}
                      {row.periodEnd}
                    </option>
                  ))
                : null}
            </select>
          )}
        </div>
      </div>
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
        <div className="space-y-6" data-chart-results="" ref={resultsRef}>
          <SourceSummary
            data={data}
            dropped={display.dropped}
            skipped={display.skipped}
          />
          {display.candles.length === 0 ? (
            <p className="text-muted-foreground text-sm">No bars returned.</p>
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
                  label={`${data.contract.localSymbol} ${data.request.barSize} bars`}
                  markers={markers}
                  pricePrecision={pricePrecisionFor(data)}
                  studies={studies}
                />
              </Suspense>
            </ChartRendererBoundary>
          )}
          <Analysis data={data} />
          {/* QuantData covers US-listed equities only. */}
          {data.request.secType === "STK" && data.request.currency === "USD" ? (
            <OptionsAnalyticsPanel
              gateway={optionsAnalytics}
              symbol={data.request.symbol}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
