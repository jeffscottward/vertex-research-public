"use client";

import {
  type InstantBacktestSeries,
  SETUP_REPLAY_MAX_HOLD_BARS,
  SETUP_REPLAY_PATHS,
  SETUP_REPLAY_STOP_ATR_MULTIPLES,
  SETUP_REPLAY_TARGET_RS,
  type SetupReplayPreset,
  type SetupReplayRunInput,
  type SetupReplayRunOutput,
  type SetupReplaySummary,
  setupReplaySeriesId,
} from "@darkfactory/api";
import {
  Button,
  StatCard,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { Play } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  cacheKey,
  createResultCache,
  currentSearch,
  pickNumberParam,
  pickParam,
  readParam,
  useDebouncedValue,
  writeQuery,
} from "./backtest-lab-query.ts";
import {
  DEFAULT_UNIVERSE_CHOICE,
  visibleSeries,
} from "./backtest-universe.tsx";
import {
  createBrowserEngineComparisonGateway,
  type EngineComparisonGateway,
  NautilusCard,
} from "./engine-comparison.tsx";
import {
  createBrowserSetupReplayGateway,
  describeSetupReplayFailure,
  type SetupReplayGateway,
} from "./setup-replay-client.ts";

// Setup replay ("time machine"): pick a stored daily series and a setup, then see every past
// occurrence with its outcome and a seeded Monte Carlo over those outcomes. A simulation over past
// bars, not a prediction. Research only; no orders. The page opens on the first stored Core 7
// futures daily series and the first setup and replays it at once; every change replays again.

export const formatR = (value: number | null): string =>
  value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;

export const formatShare = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const formatReturnPct = (value: number): string =>
  `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

export type SetupReplayChoices = Readonly<{
  setup: string;
  symbol: string;
  stop: (typeof SETUP_REPLAY_STOP_ATR_MULTIPLES)[number];
  targetR: (typeof SETUP_REPLAY_TARGET_RS)[number];
  maxHoldBars: (typeof SETUP_REPLAY_MAX_HOLD_BARS)[number];
  paths: (typeof SETUP_REPLAY_PATHS)[number];
}>;

type Choices = SetupReplayChoices;

/** Wait after the last change before a replay runs. */
const SETUP_REPLAY_DEBOUNCE_MS = 300;

/** Defaults: the first stored Core 7 futures daily series (else the first stored) and the first setup. */
export const defaultSetupReplayChoices = (
  series: readonly Readonly<{ symbol: string }>[],
  presets: readonly Readonly<{ id: string }>[]
): Choices => ({
  maxHoldBars: 10,
  paths: 5000,
  setup: presets[0]?.id ?? "",
  stop: 1.5,
  symbol:
    visibleSeries(series, DEFAULT_UNIVERSE_CHOICE).series[0]?.symbol ?? "",
  targetR: 2,
});

/** Choices from the URL; a missing or unknown value keeps its default. */
export const parseSetupReplayQuery = (
  search: string,
  defaults: Choices,
  symbols: readonly string[],
  setups: readonly string[]
): Choices => ({
  maxHoldBars: pickNumberParam(
    readParam(search, "hold"),
    SETUP_REPLAY_MAX_HOLD_BARS,
    defaults.maxHoldBars
  ),
  paths: pickNumberParam(
    readParam(search, "paths"),
    SETUP_REPLAY_PATHS,
    defaults.paths
  ),
  setup: pickParam(readParam(search, "setup"), setups, defaults.setup),
  stop: pickNumberParam(
    readParam(search, "stop"),
    SETUP_REPLAY_STOP_ATR_MULTIPLES,
    defaults.stop
  ),
  symbol: pickParam(readParam(search, "symbol"), symbols, defaults.symbol),
  targetR: pickNumberParam(
    readParam(search, "target"),
    SETUP_REPLAY_TARGET_RS,
    defaults.targetR
  ),
});

const queryOf = (choices: Choices) => ({
  hold: choices.maxHoldBars,
  paths: choices.paths,
  setup: choices.setup,
  stop: choices.stop,
  symbol: choices.symbol,
  target: choices.targetR,
});

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      series: readonly InstantBacktestSeries[];
      presets: readonly SetupReplayPreset[];
      defaults: Choices;
      choices: Choices;
    }>;

type Ran = Readonly<{
  output: SetupReplayRunOutput;
  preset: SetupReplayPreset;
  input: SetupReplayRunInput;
}>;

type RunState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "running"; ran: Ran | null }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "done"; ran: Ran }>;

const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm";

/** A labelled native select over a fixed list; the chosen option is read by index. */
const ChoiceSelect = <T,>({
  label,
  options,
  value,
  format,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly T[];
  readonly value: T;
  readonly format: (option: T) => string;
  readonly onChange: (option: T) => void;
}) => {
  const id = useId();
  return (
    <div className="space-y-1">
      <label className="block font-medium text-sm" htmlFor={id}>
        {label}
      </label>
      <select
        className={selectClass}
        id={id}
        onChange={(event) =>
          onChange(options[event.currentTarget.selectedIndex] as T)
        }
        value={String(options.indexOf(value))}
      >
        {options.map((option, index) => (
          <option key={format(option)} value={String(index)}>
            {format(option)}
          </option>
        ))}
      </select>
    </div>
  );
};

const OUTCOME_SEGMENTS = [
  { key: "targetFirst", label: "Target first", tone: "bg-green-600" },
  { key: "stopFirst", label: "Stop first", tone: "bg-destructive" },
  { key: "timeExit", label: "Time exit", tone: "bg-muted-foreground/50" },
] as const;

const OutcomeBar = ({ summary }: { readonly summary: SetupReplaySummary }) => {
  const total = Math.max(summary.count, 1);
  const text = OUTCOME_SEGMENTS.map(
    (segment) =>
      `${segment.label} ${summary[segment.key]} (${formatShare(summary[segment.key] / total)})`
  ).join(", ");
  return (
    <figure className="space-y-2">
      <div
        aria-label={`Outcomes: ${text}`}
        className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {OUTCOME_SEGMENTS.map((segment) => (
          <div
            className={segment.tone}
            data-outcome={segment.key}
            key={segment.key}
            style={{ width: `${(summary[segment.key] / total) * 100}%` }}
          />
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        {OUTCOME_SEGMENTS.map((segment) => (
          <span className="inline-flex items-center gap-1.5" key={segment.key}>
            <span
              aria-hidden="true"
              className={`inline-block size-2.5 rounded-full ${segment.tone}`}
            />
            {segment.label}: {summary[segment.key]}
          </span>
        ))}
      </figcaption>
    </figure>
  );
};

const OUTCOME_LABELS = {
  stop: "Stop",
  target: "Target",
  time: "Time",
} as const;

const Results = ({ ran }: { readonly ran: Ran }) => {
  const { output, preset, input } = ran;
  const { summary, monteCarlo, occurrences, series } = output;
  // Label, value and an optional secondary line under the value.
  const cards: readonly (readonly [string, string, string?])[] = [
    ["Occurrences", summary.count.toLocaleString("en-US")],
    ["Win rate", formatShare(summary.winRate)],
    ["Average R", formatR(summary.avgR)],
    ["Planned expectancy (R)", formatR(summary.expectancyR)],
    [
      "Target share",
      formatShare(summary.targetShare),
      `Break-even ${formatShare(summary.breakEvenShare)}`,
    ],
    ["Paths in profit", formatShare(monteCarlo?.pProfit ?? null)],
    ["Median total R", formatR(monteCarlo?.totalR.p50 ?? null)],
    [
      "Total R, 5th to 95th",
      monteCarlo === null
        ? "n/a"
        : `${formatR(monteCarlo.totalR.p5)} to ${formatR(monteCarlo.totalR.p95)}`,
    ],
    [
      "Median compounded return",
      monteCarlo === null
        ? "n/a"
        : formatReturnPct(monteCarlo.totalReturnPct.p50),
    ],
  ];
  return (
    <div className="space-y-4" data-setup-replay="results">
      <p className="text-muted-foreground text-sm">
        {preset.label} on {series.symbol} daily, {series.from} to {series.to} (
        {series.bars.toLocaleString("en-US")} bars). Stop {input.stop.multiple}{" "}
        ATR, target {input.targetR}R, time exit after {input.maxHoldBars} bars.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {cards.map(([label, value, description]) => (
          <StatCard
            className="px-4 py-4"
            data-stat={label}
            {...(description === undefined ? {} : { description })}
            key={label}
            label={label}
            value={value}
          />
        ))}
      </div>
      <OutcomeBar summary={summary} />
      {monteCarlo === null ? null : (
        <p className="text-muted-foreground text-xs">
          Monte Carlo: {monteCarlo.paths.toLocaleString("en-US")} paths of{" "}
          {monteCarlo.tradesPerPath} trades drawn with replacement from the
          outcomes above, seed {monteCarlo.seed}. The same choices and data give
          the same numbers.
        </p>
      )}
      {occurrences.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          This setup did not occur in the stored bars.
        </p>
      ) : (
        <section aria-label="Occurrences" className="space-y-2">
          {occurrences.length < summary.count ? (
            <p className="text-muted-foreground text-xs">
              Showing the newest {occurrences.length.toLocaleString("en-US")} of{" "}
              {summary.count.toLocaleString("en-US")} occurrences.
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Bars: bars the position was held. A stop or target counts the bar it
            fills in; a time exit leaves at the next open.
          </p>
          <div
            aria-label="Occurrence table, scrolls sideways on small screens"
            className="max-h-[32rem] overflow-auto rounded-md border"
            role="region"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
            tabIndex={0}
          >
            <Table
              className="w-full min-w-[40rem] text-sm"
              containerClassName="overflow-visible"
            >
              <TableCaption className="sr-only">
                Past occurrences, newest first
              </TableCaption>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow className="border-b text-left text-muted-foreground text-xs">
                  <TableHead className="p-2 text-muted-foreground" scope="col">
                    Entry
                  </TableHead>
                  <TableHead className="p-2 text-muted-foreground" scope="col">
                    Exit
                  </TableHead>
                  <TableHead
                    className="p-2 text-right text-muted-foreground"
                    scope="col"
                  >
                    Entry price
                  </TableHead>
                  <TableHead
                    className="p-2 text-right text-muted-foreground"
                    scope="col"
                  >
                    Exit price
                  </TableHead>
                  <TableHead className="p-2 text-muted-foreground" scope="col">
                    Outcome
                  </TableHead>
                  <TableHead
                    className="p-2 text-right text-muted-foreground"
                    scope="col"
                  >
                    Bars
                  </TableHead>
                  <TableHead
                    className="p-2 text-right text-muted-foreground"
                    scope="col"
                  >
                    Return
                  </TableHead>
                  <TableHead
                    className="p-2 text-right text-muted-foreground"
                    scope="col"
                  >
                    R
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {occurrences.map((entry) => (
                  <TableRow
                    className="border-b last:border-b-0"
                    data-outcome={entry.outcome}
                    key={`${entry.entryDate}-${entry.exitDate}`}
                  >
                    <TableHead
                      className="whitespace-normal p-2 text-left font-normal"
                      scope="row"
                    >
                      {entry.entryDate}
                    </TableHead>
                    <TableCell className="whitespace-normal p-2">
                      {entry.exitDate}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 text-right font-mono">
                      {entry.entryPrice.toFixed(2)}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 text-right font-mono">
                      {entry.exitPrice.toFixed(2)}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2">
                      {OUTCOME_LABELS[entry.outcome]}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 text-right">
                      {entry.barsHeld}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 text-right font-mono">
                      {formatReturnPct(entry.returnPct)}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 text-right font-mono">
                      {formatR(entry.rMultiple)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
};

const Notice = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-muted-foreground text-sm" role="status">
    {children}
  </p>
);

export interface SetupReplayWorkspaceProps {
  readonly gateway?: SetupReplayGateway;
  /** Engine comparison: where the Nautilus status of a replay is read. */
  readonly comparisonGateway?: EngineComparisonGateway;
}

export const SetupReplayWorkspace = ({
  gateway: suppliedGateway,
  comparisonGateway: suppliedComparisons,
}: SetupReplayWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserSetupReplayGateway()
  );
  const [comparisonGateway] = useState(
    () => suppliedComparisons ?? createBrowserEngineComparisonGateway()
  );
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [cache] = useState(() => createResultCache<SetupReplayRunOutput>(20));
  const [run, setRun] = useState<RunState>({ type: "idle" });
  const latest = useRef(0);

  useEffect(() => {
    let active = true;
    Promise.all([gateway.series(), gateway.presets()]).then(
      ([seriesList, presetList]) => {
        if (!active) return;
        const series = seriesList.series.filter(
          (entry) => entry.timeframe === "1d"
        );
        const presets = presetList.presets;
        const defaults = defaultSetupReplayChoices(series, presets);
        setLoad({
          choices: parseSetupReplayQuery(
            currentSearch(),
            defaults,
            series.map((entry) => entry.symbol),
            presets.map((entry) => entry.id)
          ),
          defaults,
          presets,
          series,
          type: "ready",
        });
      },
      (error: unknown) => {
        if (!active) return;
        setLoad({ message: describeSetupReplayFailure(error), type: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const ready = load.type === "ready" ? load : null;
  const choices = ready?.choices;
  const series = ready?.series.find(
    (entry) => entry.symbol === choices?.symbol
  );
  const preset = ready?.presets.find((entry) => entry.id === choices?.setup);
  const request = useMemo(
    () =>
      choices === undefined || series === undefined || preset === undefined
        ? null
        : {
            input: {
              maxHoldBars: choices.maxHoldBars,
              paths: choices.paths,
              seriesId: setupReplaySeriesId(series.symbol),
              setup: preset.id,
              stop: { kind: "atr", multiple: choices.stop },
              targetR: choices.targetR,
            } satisfies SetupReplayRunInput,
            preset,
          },
    [choices, series, preset]
  );
  const key = request === null ? "" : cacheKey(request.input);
  const settledKey = useDebouncedValue(key, SETUP_REPLAY_DEBOUNCE_MS);

  const replay = async (
    target: NonNullable<typeof request>,
    useCache: boolean
  ): Promise<void> => {
    const { input } = target;
    const id = cacheKey(input);
    latest.current += 1;
    const ticket = latest.current;
    // A replay with an engine comparison always asks the server again: its Nautilus group may
    // have been superseded since, and the server reuses or requeues it (no flooding).
    const cached = useCache ? cache.get(id) : undefined;
    if (cached !== undefined && cached.comparison === undefined) {
      setRun({
        ran: { input, output: cached, preset: target.preset },
        type: "done",
      });
      return;
    }
    setRun((previous) => ({
      ran: previous.type === "done" ? previous.ran : null,
      type: "running",
    }));
    try {
      const output = await gateway.run(input);
      cache.set(id, output);
      if (ticket !== latest.current) return;
      setRun({ ran: { input, output, preset: target.preset }, type: "done" });
    } catch (error) {
      if (ticket !== latest.current) return;
      setRun({ message: describeSetupReplayFailure(error), type: "error" });
    }
  };
  const replayRef = useRef(replay);
  replayRef.current = replay;

  // Replays once the choices settle; a cached result shows without a server call.
  useEffect(() => {
    if (request === null || key !== settledKey) return;
    void replayRef.current(request, true);
  }, [request, key, settledKey]);

  // Keeps the address bar in step with the choices; defaults are left out.
  useEffect(() => {
    if (ready === null) return;
    writeQuery(queryOf(ready.choices), queryOf(ready.defaults));
  }, [ready]);

  if (load.type === "loading") return <Notice>Loading stored series…</Notice>;
  if (load.type === "error") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {load.message}
      </p>
    );
  }
  if (series === undefined || preset === undefined || request === null) {
    return (
      <Notice>
        No stored daily bar series yet. Import one with
        scripts/vertex-market-bars-import.ts.
      </Notice>
    );
  }
  const current = load.choices;

  const set =
    <K extends keyof Choices>(name: K) =>
    (value: Choices[K]) =>
      setLoad({ ...load, choices: { ...current, [name]: value } });

  const shown =
    run.type === "done" ? run.ran : run.type === "running" ? run.ran : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <form
        aria-label="Setup replay choices"
        className="space-y-4 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void replay(request, false);
        }}
      >
        <ChoiceSelect
          format={(entry) =>
            `${entry.symbol} daily (${entry.barCount.toLocaleString("en-US")} bars)`
          }
          label="Daily series"
          onChange={(entry) => set("symbol")(entry.symbol)}
          options={load.series}
          value={series}
        />
        <ChoiceSelect
          format={(entry) => entry.label}
          label="Setup"
          onChange={(entry) => set("setup")(entry.id)}
          options={load.presets}
          value={preset}
        />
        <p className="text-muted-foreground text-xs">{preset.description}</p>
        <ChoiceSelect
          format={(value) => `${value} × ATR(14)`}
          label="Stop distance"
          onChange={set("stop")}
          options={SETUP_REPLAY_STOP_ATR_MULTIPLES}
          value={current.stop}
        />
        <ChoiceSelect
          format={(value) => `${value}R`}
          label="Target"
          onChange={set("targetR")}
          options={SETUP_REPLAY_TARGET_RS}
          value={current.targetR}
        />
        <ChoiceSelect
          format={(value) => `${value} bars`}
          label="Time exit after"
          onChange={set("maxHoldBars")}
          options={SETUP_REPLAY_MAX_HOLD_BARS}
          value={current.maxHoldBars}
        />
        <ChoiceSelect
          format={(value) => `${value.toLocaleString("en-US")} paths`}
          label="Monte Carlo paths"
          onChange={set("paths")}
          options={SETUP_REPLAY_PATHS}
          value={current.paths}
        />
        <Button
          className="min-h-11 w-full"
          disabled={run.type === "running"}
          type="submit"
        >
          <Play aria-hidden="true" className="size-4" />
          {run.type === "running" ? "Running…" : "Run again"}
        </Button>
        <p className="text-muted-foreground text-xs">
          Long only. A signal on a daily close enters at the next open. The stop
          and target are checked inside each bar, the stop first when both are
          touched; a gap through the stop fills at the open.
        </p>
      </form>
      <section aria-label="Setup replay result" className="min-w-0 space-y-4">
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          This is a simulation over past bars, not a prediction. Earnings, news
          and events the stored history never saw can do something different.
          Research only; no orders.
        </p>
        {run.type === "idle" ? <Notice>Preparing the replay…</Notice> : null}
        {run.type === "running" ? <Notice>Replaying…</Notice> : null}
        {run.type === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {run.message}
          </p>
        ) : null}
        {shown === null ? null : <Results ran={shown} />}
        {shown?.output.comparison === undefined ? null : (
          // Engine comparison on: the same engine run repeats on Nautilus (owner decision
          // 2026-11-08); the replay above stays the TypeScript one.
          <div data-engine-comparison="on">
            <NautilusCard
              gateway={comparisonGateway}
              key={shown.output.comparison.groupId ?? "none"}
              timing={shown.output.comparison}
            />
          </div>
        )}
      </section>
    </div>
  );
};
