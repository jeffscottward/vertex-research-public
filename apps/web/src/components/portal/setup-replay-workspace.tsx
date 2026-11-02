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
import { Button, StatCard } from "@darkfactory/ui";
import { Play } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import {
  createBrowserSetupReplayGateway,
  describeSetupReplayFailure,
  type SetupReplayGateway,
} from "./setup-replay-client.ts";

// Setup replay ("time machine"): pick a stored daily series and a setup, then see every past
// occurrence with its outcome and a seeded Monte Carlo over those outcomes. A simulation over past
// bars, not a prediction. Research only; no orders.

export const formatR = (value: number | null): string =>
  value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;

export const formatShare = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export const formatReturnPct = (value: number): string =>
  `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

type Choices = Readonly<{
  setup: number;
  series: number;
  stop: (typeof SETUP_REPLAY_STOP_ATR_MULTIPLES)[number];
  targetR: (typeof SETUP_REPLAY_TARGET_RS)[number];
  maxHoldBars: (typeof SETUP_REPLAY_MAX_HOLD_BARS)[number];
  paths: (typeof SETUP_REPLAY_PATHS)[number];
}>;

const DEFAULT_CHOICES: Choices = {
  maxHoldBars: 10,
  paths: 5000,
  series: 0,
  setup: 0,
  stop: 1.5,
  targetR: 2,
};

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      series: readonly InstantBacktestSeries[];
      presets: readonly SetupReplayPreset[];
    }>;

type Ran = Readonly<{
  output: SetupReplayRunOutput;
  preset: SetupReplayPreset;
  input: SetupReplayRunInput;
}>;

type RunState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "running" }>
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
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">
                Past occurrences, newest first
              </caption>
              <thead className="sticky top-0 bg-background">
                <tr className="border-b text-left text-muted-foreground text-xs">
                  <th className="p-2" scope="col">
                    Entry
                  </th>
                  <th className="p-2" scope="col">
                    Exit
                  </th>
                  <th className="p-2 text-right" scope="col">
                    Entry price
                  </th>
                  <th className="p-2 text-right" scope="col">
                    Exit price
                  </th>
                  <th className="p-2" scope="col">
                    Outcome
                  </th>
                  <th className="p-2 text-right" scope="col">
                    Bars
                  </th>
                  <th className="p-2 text-right" scope="col">
                    Return
                  </th>
                  <th className="p-2 text-right" scope="col">
                    R
                  </th>
                </tr>
              </thead>
              <tbody>
                {occurrences.map((entry) => (
                  <tr
                    className="border-b last:border-b-0"
                    data-outcome={entry.outcome}
                    key={`${entry.entryDate}-${entry.exitDate}`}
                  >
                    <th className="p-2 text-left font-normal" scope="row">
                      {entry.entryDate}
                    </th>
                    <td className="p-2">{entry.exitDate}</td>
                    <td className="p-2 text-right font-mono">
                      {entry.entryPrice.toFixed(2)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {entry.exitPrice.toFixed(2)}
                    </td>
                    <td className="p-2">{OUTCOME_LABELS[entry.outcome]}</td>
                    <td className="p-2 text-right">{entry.barsHeld}</td>
                    <td className="p-2 text-right font-mono">
                      {formatReturnPct(entry.returnPct)}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {formatR(entry.rMultiple)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
}

export const SetupReplayWorkspace = ({
  gateway: suppliedGateway,
}: SetupReplayWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserSetupReplayGateway()
  );
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [choices, setChoices] = useState<Choices>(DEFAULT_CHOICES);
  const [run, setRun] = useState<RunState>({ type: "idle" });

  useEffect(() => {
    let active = true;
    Promise.all([gateway.series(), gateway.presets()]).then(
      ([seriesList, presetList]) => {
        if (!active) return;
        setLoad({
          presets: presetList.presets,
          series: seriesList.series.filter((entry) => entry.timeframe === "1d"),
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

  if (load.type === "loading") return <Notice>Loading stored series…</Notice>;
  if (load.type === "error") {
    return (
      <p className="text-destructive text-sm" role="alert">
        {load.message}
      </p>
    );
  }
  const series = load.series[choices.series];
  const preset = load.presets[choices.setup];
  if (series === undefined || preset === undefined) {
    return (
      <Notice>
        No stored daily bar series yet. Import one with
        scripts/vertex-market-bars-import.ts.
      </Notice>
    );
  }

  const set =
    <K extends keyof Choices>(key: K) =>
    (value: Choices[K]) =>
      setChoices((previous) => ({ ...previous, [key]: value }));

  const replay = async (): Promise<void> => {
    const input: SetupReplayRunInput = {
      maxHoldBars: choices.maxHoldBars,
      paths: choices.paths,
      seriesId: setupReplaySeriesId(series.symbol),
      setup: preset.id,
      stop: { kind: "atr", multiple: choices.stop },
      targetR: choices.targetR,
    };
    setRun({ type: "running" });
    try {
      const output = await gateway.run(input);
      setRun({ ran: { input, output, preset }, type: "done" });
    } catch (error) {
      setRun({ message: describeSetupReplayFailure(error), type: "error" });
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <form
        aria-label="Setup replay choices"
        className="space-y-4 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void replay();
        }}
      >
        <ChoiceSelect
          format={(entry) =>
            `${entry.symbol} daily (${entry.barCount.toLocaleString("en-US")} bars)`
          }
          label="Daily series"
          onChange={(entry) => set("series")(load.series.indexOf(entry))}
          options={load.series}
          value={series}
        />
        <ChoiceSelect
          format={(entry) => entry.label}
          label="Setup"
          onChange={(entry) => set("setup")(load.presets.indexOf(entry))}
          options={load.presets}
          value={preset}
        />
        <p className="text-muted-foreground text-xs">{preset.description}</p>
        <ChoiceSelect
          format={(value) => `${value} × ATR(14)`}
          label="Stop distance"
          onChange={set("stop")}
          options={SETUP_REPLAY_STOP_ATR_MULTIPLES}
          value={choices.stop}
        />
        <ChoiceSelect
          format={(value) => `${value}R`}
          label="Target"
          onChange={set("targetR")}
          options={SETUP_REPLAY_TARGET_RS}
          value={choices.targetR}
        />
        <ChoiceSelect
          format={(value) => `${value} bars`}
          label="Time exit after"
          onChange={set("maxHoldBars")}
          options={SETUP_REPLAY_MAX_HOLD_BARS}
          value={choices.maxHoldBars}
        />
        <ChoiceSelect
          format={(value) => `${value.toLocaleString("en-US")} paths`}
          label="Monte Carlo paths"
          onChange={set("paths")}
          options={SETUP_REPLAY_PATHS}
          value={choices.paths}
        />
        <Button
          className="min-h-11 w-full"
          disabled={run.type === "running"}
          type="submit"
        >
          <Play aria-hidden="true" className="size-4" />
          {run.type === "running" ? "Running…" : "Run replay"}
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
        {run.type === "idle" ? (
          <Notice>Choose a series and a setup, then run the replay.</Notice>
        ) : null}
        {run.type === "running" ? <Notice>Replaying…</Notice> : null}
        {run.type === "error" ? (
          <p className="text-destructive text-sm" role="alert">
            {run.message}
          </p>
        ) : null}
        {run.type === "done" ? <Results ran={run.ran} /> : null}
      </section>
    </div>
  );
};
