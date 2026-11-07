"use client";

// What: the /charts "Order flow" panel for the loaded instrument (STK, FUT or CONTFUT): time &
// sales, order book (L2 snapshot), footprint, delta / CVD and a TPO profile. Lazy: nothing is
// fetched until the operator presses Load order flow, because IBKR pacing is shared with chart
// bars and trade prints can take about 20 s. Each view fetches, refreshes and fails on its own.
// Read-only research display; no order path.
// Used by: components/portal/charts-workspace.tsx.
import type {
  MarketBarsInput,
  MarketBarsOutput,
  MarketDepthInput,
  MarketDepthOutput,
  MarketSecType,
  MarketTicksInput,
  MarketTicksOutput,
} from "@darkfactory/api";
import { Button, Panel } from "@darkfactory/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { defined } from "../../features/order-flow/defined.ts";
import { buildDeltaSeries } from "../../features/order-flow/delta.ts";
import { buildFootprint } from "../../features/order-flow/footprint.ts";
import {
  createBrowserOrderFlowGateway,
  describeOrderFlowFailure,
  pacedRetryDelayMs,
  type OrderFlowFailure,
  type OrderFlowGateway,
  type OrderFlowView,
} from "../../features/order-flow/order-flow-client.ts";
import {
  autoBucketSeconds,
  bucketOptions,
  decimalsOf,
  deriveTickSize,
  formatBucketSeconds,
  PRICE_STEP_MULTIPLES,
  roundPrice,
} from "../../features/order-flow/price-grid.ts";
import {
  resolveTimeZone,
  tickCoverage,
  timeAndSalesRows,
} from "../../features/order-flow/time-and-sales.ts";
import { buildTpoProfile } from "../../features/order-flow/tpo.ts";
import {
  countSigning,
  signTrades,
} from "../../features/order-flow/trade-signing.ts";
import type { MarketDataGateway } from "./market-data-client.ts";
import {
  DeltaChart,
  FootprintGrid,
  formatPrice,
  OrderBookView,
  TicksSummary,
  TimeAndSalesTable,
  TpoView,
} from "./order-flow-views.tsx";

export type OrderFlowInstrument = Readonly<{
  symbol: string;
  secType: MarketSecType;
  exchange: string;
  currency: string;
  contractMonth: string | null;
}>;

export interface OrderFlowPanelProps {
  readonly gateway?: OrderFlowGateway | undefined;
  readonly instrument: OrderFlowInstrument;
  /** Bars gateway for the TPO's 30-minute bars. */
  readonly marketData: MarketDataGateway;
  /** IBKR contract timeZoneId (clock times and TPO sessions); UTC when null or unknown. */
  readonly timeZoneId: string | null;
}

type Load<T> =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading"; previous: T | null }>
  | Readonly<{ type: "ready"; data: T }>
  | Readonly<{ type: "error"; failure: OrderFlowFailure }>;

const IDLE = Object.freeze({ type: "idle" }) as Load<never>;

export const ORDER_FLOW_TABS = [
  "tape",
  "book",
  "footprint",
  "delta",
  "tpo",
] as const;
export type OrderFlowTab = (typeof ORDER_FLOW_TABS)[number];
const ORDER_FLOW_TAB_LABELS: Readonly<Record<OrderFlowTab, string>> =
  Object.freeze({
    book: "Order book",
    delta: "Delta / CVD",
    footprint: "Footprint",
    tape: "Time & Sales",
    tpo: "TPO",
  });
const TAB_VIEW: Readonly<Record<OrderFlowTab, OrderFlowView>> = Object.freeze({
  book: "depth",
  delta: "ticks",
  footprint: "ticks",
  tape: "ticks",
  tpo: "bars",
});
const REFRESH_LABEL: Readonly<Record<OrderFlowView, string>> = Object.freeze({
  bars: "Refresh TPO bars",
  depth: "Refresh order book",
  ticks: "Refresh trade prints",
});
const LOADING_TEXT: Readonly<Record<OrderFlowView, string>> = Object.freeze({
  bars: "Loading 30-minute bars…",
  depth: "Loading the depth snapshot…",
  ticks: "Loading trade prints and quotes (IBKR can take about 20 s)…",
});

const TICK_COUNTS = [250, 500, 1000] as const;
const DEPTH_ROWS = [5, 10, 20] as const;
/** TPO bars retry one pacing refusal; module-level so the loader callback stays stable. */
const barsLoaderOptions = Object.freeze({ retryPaced: true });
const selectClass =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";

/** Waits `ms` milliseconds; injectable so tests need no real timers. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Settled<Output> =
  | { type: "ready"; data: Output }
  | { type: "error"; failure: OrderFlowFailure };

/** One request, settled into the view state it leads to. */
const attempt = async <Input, Output>(
  run: (input: Input) => Promise<Output>,
  describe: (error: unknown) => OrderFlowFailure,
  input: Input
): Promise<Settled<Output>> => {
  try {
    return { data: await run(input), type: "ready" };
  } catch (error) {
    return { failure: describe(error), type: "error" };
  }
};

/**
 * Runs one view's request, keeps the newest answer only, and drops answers after unmount.
 * With `retryPaced`, an IBKR pacing refusal (429 busy/paced) is retried once after the wait the
 * history service reported, staying in the loading state meanwhile.
 */
const useViewLoader = <Input, Output>(
  run: (input: Input) => Promise<Output>,
  describe: (error: unknown) => OrderFlowFailure,
  options: { retryPaced?: boolean; wait?: (ms: number) => Promise<void> } = {}
) => {
  const { retryPaced = false, wait = sleep } = options;
  const [state, setState] = useState<Load<Output>>(IDLE);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );
  const load = useCallback(
    async (input: Input) => {
      const mine = ++generation.current;
      setState((current) => ({
        previous: current.type === "ready" ? current.data : null,
        type: "loading",
      }));
      let settled = await attempt(run, describe, input);
      const delay =
        retryPaced && settled.type === "error"
          ? pacedRetryDelayMs(settled.failure)
          : null;
      if (delay !== null && mine === generation.current) {
        await wait(delay);
        if (mine !== generation.current) return;
        settled = await attempt(run, describe, input);
      }
      if (mine === generation.current) setState(settled);
    },
    [run, describe, retryPaced, wait]
  );
  return [state, load] as const;
};

/** The data a view shows: the answer, or the previous one while refreshing. */
const shownData = <T,>(state: Load<T>): T | null =>
  state.type === "ready"
    ? state.data
    : state.type === "loading"
      ? state.previous
      : null;

const ViewFrame = ({
  view,
  state,
  onRefresh,
  controls,
  children,
}: {
  readonly view: OrderFlowView;
  readonly state: Load<unknown>;
  readonly onRefresh: () => void;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}) => {
  const loading = state.type === "loading";
  return (
    <div className="space-y-3" data-view-state={state.type}>
      <div className="flex flex-wrap items-end gap-3">
        {controls}
        <Button
          aria-label={REFRESH_LABEL[view]}
          disabled={loading}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>
      {loading ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          {LOADING_TEXT[view]}
        </p>
      ) : null}
      {state.type === "error" ? (
        <div
          className="space-y-1 rounded-md border border-destructive-border bg-destructive-subtle p-4"
          data-error-code={state.failure.code}
          role="alert"
        >
          <p className="font-mono text-sm">{state.failure.code}</p>
          <p className="text-sm">{state.failure.message}</p>
          {state.failure.detail === state.failure.message ? null : (
            <p className="text-muted-foreground text-xs">
              IBKR service said: {state.failure.detail}
            </p>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
};

const SelectField = ({
  label,
  value,
  onChange,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
}) => {
  const id = useId();
  return (
    <div className="space-y-1 text-xs">
      <label className="block text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <select
        className={selectClass}
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </div>
  );
};

export const OrderFlowPanel = ({
  instrument,
  timeZoneId,
  marketData,
  gateway: supplied,
}: OrderFlowPanelProps) => {
  const baseId = useId();
  const [gateway] = useState(() => supplied ?? createBrowserOrderFlowGateway());
  const timeZone = resolveTimeZone(timeZoneId);
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<OrderFlowTab>("tape");
  const [tickCount, setTickCount] = useState<number>(500);
  const [depthRows, setDepthRows] = useState<number>(10);
  // null = automatic bucket size / price step.
  const [bucketSeconds, setBucketSeconds] = useState<number | null>(null);
  const [stepMultiple, setStepMultiple] = useState<number | null>(null);

  const { contractMonth, currency, exchange, secType, symbol } = instrument;
  const base = useMemo(
    () => ({
      currency,
      exchange,
      secType,
      symbol,
      ...(secType === "FUT" && contractMonth !== null ? { contractMonth } : {}),
    }),
    [contractMonth, currency, exchange, secType, symbol]
  );
  const describeFor = useCallback(
    (view: OrderFlowView) => (error: unknown) =>
      describeOrderFlowFailure(error, { exchange, symbol, view }),
    [exchange, symbol]
  );
  const describeTicks = useMemo(() => describeFor("ticks"), [describeFor]);
  const describeDepth = useMemo(() => describeFor("depth"), [describeFor]);
  const describeBars = useMemo(() => describeFor("bars"), [describeFor]);
  const fetchTicks = useCallback(
    (input: MarketTicksInput) => gateway.ticks(input),
    [gateway]
  );
  const fetchDepth = useCallback(
    (input: MarketDepthInput) => gateway.depth(input),
    [gateway]
  );
  const fetchBars = useCallback(
    (input: MarketBarsInput) => marketData.bars(input),
    [marketData]
  );
  const [ticks, loadTicks] = useViewLoader<MarketTicksInput, MarketTicksOutput>(
    fetchTicks,
    describeTicks
  );
  const [depth, loadDepth] = useViewLoader<MarketDepthInput, MarketDepthOutput>(
    fetchDepth,
    describeDepth
  );
  const [bars, loadBars] = useViewLoader<MarketBarsInput, MarketBarsOutput>(
    fetchBars,
    describeBars,
    barsLoaderOptions
  );

  const ticksInput = () => ({
    ...base,
    count: tickCount,
    quotes: true,
    useRTH: false,
  });
  const barsInput = (): MarketBarsInput => ({
    ...base,
    barSize: "30 mins",
    duration: "5 D",
    useRTH: true,
    whatToShow: "TRADES",
  });
  const refreshTicks = () => void loadTicks(ticksInput());
  const refreshDepth = () => void loadDepth({ ...base, rows: depthRows });
  const refreshBars = () => void loadBars(barsInput());
  // The history service runs one historical request at a time (bars wait at most 20 s for it) and
  // the two paced tick requests hold it about 20 s, so the TPO bars go after the ticks settle.
  // Depth has its own slot and starts at once.
  const start = async () => {
    setStarted(true);
    refreshDepth();
    await loadTicks(ticksInput());
    await loadBars(barsInput());
  };

  const tickData = shownData(ticks);
  const signed = useMemo(
    () =>
      tickData === null ? [] : signTrades(tickData.trades, tickData.quotes),
    [tickData]
  );
  const counts = useMemo(() => countSigning(signed), [signed]);
  const coverage = useMemo(
    () => tickCoverage(signed, timeZone),
    [signed, timeZone]
  );
  // IBKR's minTick when the service has it; otherwise the gcd guess from the prints.
  const minTick = tickData?.minTick ?? null;
  const derivedTick = useMemo(
    () => deriveTickSize(signed.map((trade) => trade.price)),
    [signed]
  );
  const tickSize = minTick ?? derivedTick;
  const priceDigits = Math.max(2, tickSize === null ? 2 : decimalsOf(tickSize));
  const rows = useMemo(
    () => timeAndSalesRows(signed, timeZone),
    [signed, timeZone]
  );
  const priceStep =
    stepMultiple === null || tickSize === null
      ? undefined
      : roundPrice(tickSize * stepMultiple, decimalsOf(tickSize));
  const footprint = useMemo(
    () =>
      buildFootprint(signed, {
        bucketSeconds: bucketSeconds ?? undefined,
        priceStep,
        tickSize,
      }),
    [signed, bucketSeconds, priceStep, tickSize]
  );
  const delta = useMemo(
    () => buildDeltaSeries(signed, bucketSeconds ?? undefined),
    [signed, bucketSeconds]
  );
  const barsData = shownData(bars);
  const profile = useMemo(
    () => (barsData === null ? null : buildTpoProfile(barsData.bars, timeZone)),
    [barsData, timeZone]
  );
  const depthData = shownData(depth);

  const tabId = (option: OrderFlowTab) => `${baseId}-tab-${option}`;
  const panelId = (option: OrderFlowTab) => `${baseId}-panel-${option}`;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = ORDER_FLOW_TABS.length;
    const index = ORDER_FLOW_TABS.indexOf(tab);
    const target: Readonly<Record<string, number>> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      End: count - 1,
      Home: 0,
    };
    const move = target[event.key];
    if (move === undefined) return;
    const next = defined(ORDER_FLOW_TABS[(move + count) % count], "tab");
    event.preventDefault();
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  const first = coverage.first;
  const last = coverage.last;
  const bucketChoices =
    first === null || last === null ? [] : bucketOptions(first, last);
  const autoBucket =
    first === null || last === null ? null : autoBucketSeconds(first, last);
  const bucketSelect = (
    <SelectField
      label="Bucket"
      onChange={(value) =>
        setBucketSeconds(value === "auto" ? null : Number(value))
      }
      value={bucketSeconds === null ? "auto" : String(bucketSeconds)}
    >
      <option value="auto">
        Auto{autoBucket === null ? "" : ` (${formatBucketSeconds(autoBucket)})`}
      </option>
      {bucketChoices.map((seconds) => (
        <option key={seconds} value={seconds}>
          {formatBucketSeconds(seconds)}
        </option>
      ))}
    </SelectField>
  );
  const ticksSummary = (windowNote: boolean) =>
    tickData === null ? null : (
      <TicksSummary
        counts={counts}
        coverage={coverage}
        data={tickData}
        timeZone={timeZone}
        windowNote={windowNote}
      />
    );

  const views: Readonly<Record<OrderFlowTab, () => ReactNode>> = {
    book: () => (
      <ViewFrame
        controls={
          <SelectField
            label="Rows per side"
            onChange={(value) => setDepthRows(Number(value))}
            value={String(depthRows)}
          >
            {DEPTH_ROWS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectField>
        }
        onRefresh={refreshDepth}
        state={depth}
        view="depth"
      >
        {depthData === null ? null : <OrderBookView data={depthData} />}
      </ViewFrame>
    ),
    delta: () => (
      <ViewFrame
        controls={bucketSelect}
        onRefresh={refreshTicks}
        state={ticks}
        view="ticks"
      >
        {ticksSummary(true)}
        {delta === null ? (
          tickData === null ? null : (
            <p className="text-muted-foreground text-sm">
              No trade prints to compute delta from.
            </p>
          )
        ) : (
          <DeltaChart series={delta} timeZone={timeZone} />
        )}
      </ViewFrame>
    ),
    footprint: () => (
      <ViewFrame
        controls={
          <>
            {bucketSelect}
            <SelectField
              label="Price step"
              onChange={(value) =>
                setStepMultiple(value === "auto" ? null : Number(value))
              }
              value={stepMultiple === null ? "auto" : String(stepMultiple)}
            >
              <option value="auto">
                Auto
                {footprint === null
                  ? ""
                  : ` (${formatPrice(footprint.priceStep, priceDigits)})`}
              </option>
              {tickSize === null
                ? null
                : PRICE_STEP_MULTIPLES.slice(0, 7).map((multiple) => (
                    <option key={multiple} value={multiple}>
                      {formatPrice(
                        roundPrice(tickSize * multiple, decimalsOf(tickSize)),
                        priceDigits
                      )}
                      {multiple === 1 ? " (tick)" : ""}
                    </option>
                  ))}
            </SelectField>
          </>
        }
        onRefresh={refreshTicks}
        state={ticks}
        view="ticks"
      >
        {ticksSummary(true)}
        {footprint === null ? (
          tickData === null ? null : (
            <p className="text-muted-foreground text-sm">
              No trade prints to build a footprint from.
            </p>
          )
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              Each cell: sell (bid-hit) × buy (ask-lift) volume at{" "}
              {formatPrice(footprint.priceStep, priceDigits)} rows and{" "}
              {formatBucketSeconds(footprint.bucketSeconds)} columns; outlined
              cell = the bucket's POC
              {`; tick ${formatPrice(footprint.tickSize, priceDigits)} ${minTick === null ? "derived from the prints" : "(IBKR minTick)"}`}
              .
            </p>
            <FootprintGrid
              digits={priceDigits}
              footprint={footprint}
              timeZone={timeZone}
            />
          </>
        )}
      </ViewFrame>
    ),
    tape: () => (
      <ViewFrame
        controls={
          <SelectField
            label="Prints"
            onChange={(value) => setTickCount(Number(value))}
            value={String(tickCount)}
          >
            {TICK_COUNTS.map((option) => (
              <option key={option} value={option}>
                {option} most recent
              </option>
            ))}
          </SelectField>
        }
        onRefresh={refreshTicks}
        state={ticks}
        view="ticks"
      >
        {ticksSummary(false)}
        {tickData === null ? null : (
          <TimeAndSalesTable
            digits={priceDigits}
            rows={rows}
            timeZone={timeZone}
          />
        )}
      </ViewFrame>
    ),
    tpo: () => (
      <ViewFrame onRefresh={refreshBars} state={bars} view="bars">
        {barsData === null ? null : (
          <TpoView data={barsData} profile={profile} timeZone={timeZone} />
        )}
      </ViewFrame>
    ),
  };

  return (
    <Panel
      data-order-flow={instrument.symbol}
      description={`${instrument.symbol} ${instrument.secType} · ${instrument.exchange} · IBKR trade prints, L2 depth and 30-minute bars · read only`}
      title="Order flow"
    >
      {started ? (
        <div className="min-w-0 space-y-4">
          <div
            aria-label="Order flow views"
            className="flex gap-1 overflow-x-auto border-border border-b"
            onKeyDown={onTabKey}
            role="tablist"
          >
            {ORDER_FLOW_TABS.map((option) => (
              <button
                aria-controls={panelId(option)}
                aria-selected={tab === option}
                className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm ${tab === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                data-order-flow-tab={option}
                data-view-state={{ bars, depth, ticks }[TAB_VIEW[option]].type}
                id={tabId(option)}
                key={option}
                onClick={() => setTab(option)}
                role="tab"
                tabIndex={tab === option ? 0 : -1}
                type="button"
              >
                {ORDER_FLOW_TAB_LABELS[option]}
              </button>
            ))}
          </div>
          <div
            aria-labelledby={tabId(tab)}
            className="min-w-0"
            data-order-flow-view={tab}
            id={panelId(tab)}
            role="tabpanel"
          >
            {views[tab]()}
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-order-flow-idle="">
          <p className="text-muted-foreground text-sm">
            Time &amp; sales, order book, footprint, delta / CVD and a TPO
            profile for {instrument.symbol}. Nothing is fetched until you load:
            IBKR pacing is shared with chart bars and trade prints can take
            about 20 s. Footprint and delta cover only the fetched prints, not
            the whole session.
          </p>
          <Button onClick={() => void start()} type="button">
            Load order flow
          </Button>
        </div>
      )}
    </Panel>
  );
};
