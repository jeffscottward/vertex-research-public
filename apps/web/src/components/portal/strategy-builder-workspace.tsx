"use client";

import {
  type BacktestRun,
  type InstantBacktestSeries,
  parseStrategyDefinitionText,
  STRATEGY_INDICATORS,
  STRATEGY_OPERATORS,
  STRATEGY_PRICE_FIELDS,
  STRATEGY_TEMPLATE_IDS,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyExpr,
  type StrategyTemplateId,
} from "@darkfactory/api";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import { currentSearch, writeQuery } from "./backtest-lab-query.ts";
import {
  describeRevision,
  isFinished,
  isoDate,
  metricRows,
} from "./backtest-runs-model.ts";
import {
  type BacktestRunsGateway,
  createBrowserBacktestRunsGateway,
} from "./backtest-runs-workspace.tsx";
import {
  DEFAULT_UNIVERSE_CHOICE,
  visibleSeries,
} from "./backtest-universe.tsx";
import { describeMarketDataFailure } from "./market-data-client.ts";
import {
  type BuilderRunForm,
  defaultCondition,
  defaultExpr,
  definitionText,
  INDICATOR_LABELS,
  lengthUnit,
  numberOf,
  openBuilderRun,
  readBuilderQuery,
  removeAt,
  replaceAt,
  templateDefinition,
  toBuilderRunInput,
  usesSource,
  withLinkedRun,
  withOffset,
} from "./strategy-builder-model.ts";

// Strategy builder: a visual editor and a text editor for the same strategy definition (version 1).
// Every change is validated at once. "Run backtest" queues a backtest run of the definition; the
// run stores a revision of the definition. Research only; this page has no order path.

const POLL_MS = 1000;
// 20 minutes: a Nautilus run may wait up to 10 minutes for the research worker and then run up to
// 9 minutes (docs/vertex-rebuild/nautilus-backtest-engine.md).
const POLL_MAX = 1200;
const CONTROL = "min-h-11 rounded-md border bg-background px-3 text-sm";
const LABEL = "font-medium text-sm";

const TEMPLATE_LABELS: Record<StrategyTemplateId, string> = {
  atrExpansion: "ATR expansion",
  donchianBreakout: "Donchian breakout",
  rsiReversion: "RSI reversion",
  smaCross: "SMA cross",
};

const OPERATOR_LABELS: Record<StrategyCondition["op"], string> = {
  "<": "is below",
  "<=": "is at or below",
  ">": "is above",
  ">=": "is at or above",
  breaksAbove: "breaks above",
  breaksBelow: "breaks below",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
};

export type StrategyBuilderGateway = Pick<
  BacktestRunsGateway,
  "series" | "submit" | "get" | "list"
>;

export type StrategyBuilderWorkspaceProps = Readonly<{
  gateway?: StrategyBuilderGateway;
  pollMs?: number;
  pollMax?: number;
}>;

type Field = Readonly<{
  label: string;
  children: (id: string) => React.ReactNode;
}>;

const Labeled = ({ label, children }: Field) => {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  );
};

const NumberField = ({
  label,
  value,
  onChange,
  step = "any",
}: Readonly<{
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: string;
}>) => (
  <Labeled label={label}>
    {(id) => (
      <input
        className={CONTROL}
        id={id}
        inputMode="decimal"
        onChange={(event) => onChange(numberOf(event.target.value))}
        step={step}
        type="number"
        value={Number.isNaN(value) ? "" : value}
      />
    )}
  </Labeled>
);

const OffsetField = ({
  label,
  expr,
  onChange,
}: Readonly<{
  label: string;
  expr: Exclude<StrategyExpr, { type: "const" }>;
  onChange: (expr: StrategyExpr) => void;
}>) => (
  <Labeled label={`${label} bars ago`}>
    {(id) => (
      <input
        className={CONTROL}
        id={id}
        inputMode="numeric"
        min="0"
        onChange={(event) => onChange(withOffset(expr, event.target.value))}
        placeholder="0 (current bar)"
        step="1"
        type="number"
        value={expr.offset ?? ""}
      />
    )}
  </Labeled>
);

const ExprEditor = ({
  label,
  expr,
  onChange,
}: Readonly<{
  label: string;
  expr: StrategyExpr;
  onChange: (expr: StrategyExpr) => void;
}>) => (
  <div className="grid gap-2 sm:grid-cols-2">
    <Labeled label={`${label} input`}>
      {(id) => (
        <select
          className={CONTROL}
          id={id}
          onChange={(event) =>
            onChange(defaultExpr(event.target.value as StrategyExpr["type"]))
          }
          value={expr.type}
        >
          <option value="price">Price</option>
          <option value="indicator">Indicator</option>
          <option value="const">Number</option>
        </select>
      )}
    </Labeled>
    {expr.type === "price" ? (
      <Labeled label={`${label} price`}>
        {(id) => (
          <select
            className={CONTROL}
            id={id}
            onChange={(event) =>
              onChange({
                ...expr,
                field: event.target.value as typeof expr.field,
              })
            }
            value={expr.field}
          >
            {STRATEGY_PRICE_FIELDS.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        )}
      </Labeled>
    ) : null}
    {expr.type === "price" ? (
      <OffsetField expr={expr} label={label} onChange={onChange} />
    ) : null}
    {expr.type === "const" ? (
      <NumberField
        label={`${label} value`}
        onChange={(value) => onChange({ ...expr, value })}
        value={expr.value}
      />
    ) : null}
    {expr.type === "indicator" ? (
      <>
        <Labeled label={`${label} indicator`}>
          {(id) => (
            <select
              className={CONTROL}
              id={id}
              onChange={(event) =>
                onChange({
                  ...expr,
                  name: event.target.value as typeof expr.name,
                })
              }
              value={expr.name}
            >
              {STRATEGY_INDICATORS.map((name) => (
                <option key={name} value={name}>
                  {INDICATOR_LABELS[name]}
                </option>
              ))}
            </select>
          )}
        </Labeled>
        <NumberField
          label={`${label} length (${lengthUnit(expr.name)})`}
          onChange={(length) => onChange({ ...expr, length })}
          step="1"
          value={expr.length}
        />
        {usesSource(expr.name) ? (
          <Labeled label={`${label} source`}>
            {(id) => (
              <select
                className={CONTROL}
                id={id}
                onChange={(event) =>
                  onChange({
                    ...expr,
                    source: event.target.value as typeof expr.source,
                  })
                }
                value={expr.source}
              >
                {STRATEGY_PRICE_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            )}
          </Labeled>
        ) : null}
        <OffsetField expr={expr} label={label} onChange={onChange} />
      </>
    ) : null}
  </div>
);

const ConditionList = ({
  title,
  prefix,
  conditions,
  onChange,
}: Readonly<{
  title: string;
  prefix: string;
  conditions: readonly StrategyCondition[];
  onChange: (conditions: StrategyCondition[]) => void;
}>) => (
  <fieldset className="grid gap-3 rounded-md border p-4">
    <legend className="px-1 font-medium text-sm">{title}</legend>
    {conditions.length === 0 ? (
      <p className="text-muted-foreground text-sm">No conditions.</p>
    ) : null}
    {conditions.map((condition, index) => {
      const name = `${prefix} ${index + 1}`;
      const update = (next: StrategyCondition) =>
        onChange(replaceAt(conditions, index, next));
      return (
        <div className="grid gap-3 border-b pb-3 last:border-b-0" key={name}>
          <ExprEditor
            expr={condition.left}
            label={`${name} left`}
            onChange={(left) => update({ ...condition, left })}
          />
          <Labeled label={`${name} comparison`}>
            {(id) => (
              <select
                className={CONTROL}
                id={id}
                onChange={(event) =>
                  update({
                    ...condition,
                    op: event.target.value as StrategyCondition["op"],
                  })
                }
                value={condition.op}
              >
                {STRATEGY_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>
            )}
          </Labeled>
          <ExprEditor
            expr={condition.right}
            label={`${name} right`}
            onChange={(right) => update({ ...condition, right })}
          />
          <button
            className="min-h-11 justify-self-start rounded-md border px-3 text-sm"
            onClick={() => onChange(removeAt(conditions, index))}
            type="button"
          >
            Remove {name.toLowerCase()}
          </button>
        </div>
      );
    })}
    <button
      className="min-h-11 justify-self-start rounded-md border px-3 text-sm"
      onClick={() => onChange([...conditions, defaultCondition()])}
      type="button"
    >
      Add {prefix.toLowerCase()} condition
    </button>
  </fieldset>
);

type ExitLevel = StrategyDefinition["stopLoss"];

const ExitLevelEditor = ({
  label,
  level,
  onChange,
}: Readonly<{
  label: string;
  level: ExitLevel;
  onChange: (level: ExitLevel) => void;
}>) => (
  <div className="grid gap-2">
    <Labeled label={label}>
      {(id) => (
        <select
          className={CONTROL}
          id={id}
          onChange={(event) => {
            const kind = event.target.value;
            onChange(
              kind === "pct"
                ? { kind: "pct", pct: 5 }
                : kind === "atr"
                  ? { kind: "atr", length: 14, multiple: 2 }
                  : { kind: "none" }
            );
          }}
          value={level.kind}
        >
          <option value="none">None</option>
          <option value="pct">Percent of entry</option>
          <option value="atr">ATR multiple</option>
        </select>
      )}
    </Labeled>
    {level.kind === "pct" ? (
      <NumberField
        label={`${label} percent`}
        onChange={(pct) => onChange({ ...level, pct })}
        value={level.pct}
      />
    ) : null}
    {level.kind === "atr" ? (
      <>
        <NumberField
          label={`${label} ATR length (bars)`}
          onChange={(length) => onChange({ ...level, length })}
          step="1"
          value={level.length}
        />
        <NumberField
          label={`${label} ATR multiple`}
          onChange={(multiple) => onChange({ ...level, multiple })}
          value={level.multiple}
        />
      </>
    ) : null}
  </div>
);

const runStatusText = (run: BacktestRun): string => {
  if (run.status === "succeeded") return "The backtest finished.";
  if (run.status === "failed")
    return `The backtest failed: ${run.error ?? "unknown error"}`;
  return `The backtest is ${run.status}.`;
};

const RunResult = ({ run }: Readonly<{ run: BacktestRun }>) => (
  <section
    aria-label="Backtest result"
    className="grid gap-3 rounded-md border p-4"
  >
    <p className="text-sm">
      {runStatusText(run)}
      {describeRevision(run)}
    </p>
    {run.report === null ? null : (
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {metricRows(run.report.metrics).map((row) => (
          <div
            className="flex justify-between gap-4 border-b py-1"
            key={row.label}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    )}
    <a
      className="min-h-11 content-center justify-self-start text-sm underline"
      href={`/backtest-runs?run=${encodeURIComponent(run.id)}`}
    >
      Open the full report in Backtest runs
    </a>
  </section>
);

// The result shown under the form, or a notice when no builder run exists yet.
const ShownRun = ({
  latest,
  run,
}: Readonly<{ latest: LatestState; run: BacktestRun | null }>) => {
  if (run !== null) return <RunResult run={run} />;
  if (latest !== "none") return null;
  return (
    <p className="text-sm" role="status">
      No builder run exists yet. Run backtest queues one with this definition.
    </p>
  );
};

type LatestState = "loading" | "none" | "shown";

const seriesKey = (series: InstantBacktestSeries): string =>
  `${series.symbol}:${series.timeframe}`;

type LoadState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; series: readonly InstantBacktestSeries[] }>;

export const StrategyBuilderWorkspace = ({
  gateway: injected,
  pollMs = POLL_MS,
  pollMax = POLL_MAX,
}: StrategyBuilderWorkspaceProps) => {
  const gateway = useMemo(
    () => injected ?? createBrowserBacktestRunsGateway(),
    [injected]
  );
  const [draft, setDraft] = useState<StrategyDefinition>(() =>
    templateDefinition("smaCross")
  );
  const [text, setText] = useState(() => definitionText(draft));
  const [load, setLoad] = useState<LoadState>({ type: "loading" });
  const [selectedSeries, setSelectedSeries] = useState("");
  const [form, setForm] = useState<BuilderRunForm>({
    costBps: 0,
    from: "",
    initialCapital: 10_000,
    to: "",
  });
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // "none": no finished builder run exists yet, so the page shows the template only.
  const [latest, setLatest] = useState<LatestState>("loading");
  // Set by any user edit or submit, so a slow first load never overwrites the user's work.
  const touched = useRef(false);
  const templateId = useId();
  const textId = useId();
  const seriesId = useId();

  const validation = useMemo(() => parseStrategyDefinitionText(text), [text]);
  // Visual edits may make the definition invalid; only invalid text the builder did not write locks it.
  const textOutOfSync = !validation.ok && text !== definitionText(draft);

  // On open: pick the Core 7 default series (or ?symbol=), then show the linked (?run=) or newest
  // finished builder run. Read-only: nothing is submitted here.
  useEffect(() => {
    let active = true;
    let ready = false;
    const fail = (error: unknown) => {
      if (!active) return;
      if (ready) {
        setLatest("none");
        setMessage(describeMarketDataFailure(error).message);
        return;
      }
      setLoad(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : {
              message: describeMarketDataFailure(error).message,
              type: "error",
            }
      );
    };
    const open = async () => {
      const query = readBuilderQuery(currentSearch());
      const loaded = await gateway.series();
      if (!active) return;
      ready = true;
      setLoad({ series: loaded, type: "ready" });
      const linked = loaded.find((entry) => entry.symbol === query.symbol);
      const fallback = visibleSeries(loaded, DEFAULT_UNIVERSE_CHOICE).series[0];
      const start = linked ?? fallback;
      if (start !== undefined) {
        setSelectedSeries(seriesKey(start));
        setForm((current) => ({
          ...current,
          from: isoDate(start.firstT),
          to: isoDate(start.lastT),
        }));
      }
      const runs = await withLinkedRun(
        await gateway.list(),
        query.run,
        gateway.get
      );
      // A user edit or submit while the runs load wins over the stored run.
      if (!active || touched.current) return;
      const { defaults, picked, updates } = openBuilderRun(
        runs,
        { run: query.run, symbol: linked?.symbol ?? null },
        fallback?.symbol ?? null
      );
      writeQuery(updates, defaults);
      if (picked === null) {
        setLatest("none");
        return;
      }
      const { spec } = picked.run;
      setDraft(picked.definition);
      setText(definitionText(picked.definition));
      setSelectedSeries(`${spec.symbol}:${spec.timeframe}`);
      setForm({
        costBps: spec.costBps,
        from: spec.from,
        initialCapital: spec.initialCapital,
        to: spec.to,
      });
      // The polling effect reads the run and follows it until it finishes.
      setRunId(picked.run.id);
      setLatest("shown");
    };
    open().catch(fail);
    return () => {
      active = false;
    };
  }, [gateway]);

  // Follow the submitted run until it finishes, at most pollMax reads.
  useEffect(() => {
    if (runId === null) return;
    let active = true;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      reads += 1;
      gateway.get(runId).then(
        (value) => {
          if (!active) return;
          setRun(value);
          if (!isFinished(value)) {
            if (reads < pollMax) timer = setTimeout(read, pollMs);
            else
              setMessage(
                "The run has not finished yet. Open Backtest runs to check it later."
              );
          }
        },
        (error: unknown) => {
          if (active) setMessage(describeMarketDataFailure(error).message);
        }
      );
    };
    read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [gateway, runId, pollMs, pollMax]);

  if (load.type === "forbidden")
    return <OperatorAccessRequired feature="instant-backtest" />;
  if (load.type === "loading")
    return <p className="text-muted-foreground text-sm">Loading series…</p>;
  if (load.type === "error")
    return (
      <p className="text-sm" role="alert">
        {load.message}
      </p>
    );

  const edit = (next: StrategyDefinition) => {
    touched.current = true;
    setDraft(next);
    setText(definitionText(next));
  };
  const editText = (next: string) => {
    touched.current = true;
    setText(next);
    const parsed = parseStrategyDefinitionText(next);
    if (parsed.ok) setDraft(parsed.definition);
  };
  const editForm = (patch: Partial<BuilderRunForm>) => {
    touched.current = true;
    setForm((current) => ({ ...current, ...patch }));
  };
  const defaultSymbol =
    visibleSeries(load.series, DEFAULT_UNIVERSE_CHOICE).series[0]?.symbol ??
    null;

  const series = load.series.find(
    (entry) => seriesKey(entry) === selectedSeries
  );
  const request =
    !validation.ok || series === undefined
      ? null
      : toBuilderRunInput(validation.definition, series, form);

  const submit = async () => {
    if (request === null || "error" in request) return;
    touched.current = true;
    setSubmitting(true);
    setMessage(null);
    setRun(null);
    try {
      const created = await gateway.submit(request.input);
      setRun(created);
      setRunId(created.id);
      writeQuery({ run: created.id });
    } catch (error) {
      setMessage(describeMarketDataFailure(error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const session = draft.session;
  return (
    <div className="grid gap-8">
      <section
        aria-label="Definition editors"
        className="grid gap-6 xl:grid-cols-2"
      >
        <div className="grid content-start gap-4">
          <h2 className="font-semibold text-lg">Visual builder</h2>
          <div className="grid gap-1">
            <label className={LABEL} htmlFor={templateId}>
              Template
            </label>
            <select
              className={CONTROL}
              id={templateId}
              onChange={(event) => {
                const id = event.target.value as StrategyTemplateId | "";
                if (id !== "") edit(templateDefinition(id));
              }}
              value=""
            >
              <option value="">Load a template…</option>
              {STRATEGY_TEMPLATE_IDS.map((id) => (
                <option key={id} value={id}>
                  {TEMPLATE_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
          {textOutOfSync ? (
            <p className="rounded-md border p-3 text-sm" role="note">
              The visual builder shows the last valid definition. Fix the
              definition text to edit it here again.
            </p>
          ) : null}
          <fieldset
            className="grid gap-4 disabled:opacity-60"
            disabled={textOutOfSync}
          >
            <Labeled label="Strategy name">
              {(id) => (
                <input
                  className={CONTROL}
                  id={id}
                  onChange={(event) =>
                    edit({ ...draft, name: event.target.value })
                  }
                  value={draft.name}
                />
              )}
            </Labeled>
            <ConditionList
              conditions={draft.entry.all}
              onChange={(all) =>
                edit({ ...draft, entry: { ...draft.entry, all } })
              }
              prefix="Entry"
              title="Enter long when ALL of these are true"
            />
            <ConditionList
              conditions={draft.exit.any}
              onChange={(any) => edit({ ...draft, exit: { any } })}
              prefix="Exit"
              title="Exit when ANY of these is true"
            />
            <fieldset className="grid gap-3 rounded-md border p-4 md:grid-cols-3">
              <legend className="px-1 font-medium text-sm">
                Risk and sizing
              </legend>
              <div className="grid gap-2">
                <Labeled label="Position sizing">
                  {(id) => (
                    <select
                      className={CONTROL}
                      id={id}
                      onChange={(event) =>
                        edit({
                          ...draft,
                          sizing:
                            event.target.value === "riskPct"
                              ? { mode: "riskPct", riskPct: 1 }
                              : { mode: "allIn" },
                        })
                      }
                      value={draft.sizing.mode}
                    >
                      <option value="allIn">Fully invested</option>
                      <option value="riskPct">Risk percent of equity</option>
                    </select>
                  )}
                </Labeled>
                {draft.sizing.mode === "riskPct" ? (
                  <NumberField
                    label="Risk per trade (%)"
                    onChange={(riskPct) =>
                      edit({ ...draft, sizing: { mode: "riskPct", riskPct } })
                    }
                    value={draft.sizing.riskPct}
                  />
                ) : null}
              </div>
              <ExitLevelEditor
                label="Stop loss"
                level={draft.stopLoss}
                onChange={(stopLoss) => edit({ ...draft, stopLoss })}
              />
              <ExitLevelEditor
                label="Take profit"
                level={draft.takeProfit}
                onChange={(takeProfit) => edit({ ...draft, takeProfit })}
              />
            </fieldset>
            <fieldset className="grid gap-3 rounded-md border p-4 md:grid-cols-3">
              <legend className="px-1 font-medium text-sm">Session</legend>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  checked={session !== undefined}
                  className="size-5"
                  onChange={(event) => {
                    const { session: _removed, ...rest } = draft;
                    edit(
                      event.target.checked
                        ? {
                            ...rest,
                            session: { endUtc: "20:00", startUtc: "13:30" },
                          }
                        : rest
                    );
                  }}
                  type="checkbox"
                />
                Limit entries to a UTC session
              </label>
              {session !== undefined && series?.timeframe === "1d" ? (
                <p className="text-sm md:col-span-3">
                  Daily bars are stamped 00:00 UTC. A session that does not
                  include 00:00 blocks every entry on daily bars.
                </p>
              ) : null}
              {session === undefined ? null : (
                <>
                  <Labeled label="Session start (UTC)">
                    {(id) => (
                      <input
                        className={CONTROL}
                        id={id}
                        onChange={(event) =>
                          edit({
                            ...draft,
                            session: {
                              ...session,
                              startUtc: event.target.value,
                            },
                          })
                        }
                        type="time"
                        value={session.startUtc}
                      />
                    )}
                  </Labeled>
                  <Labeled label="Session end (UTC)">
                    {(id) => (
                      <input
                        className={CONTROL}
                        id={id}
                        onChange={(event) =>
                          edit({
                            ...draft,
                            session: { ...session, endUtc: event.target.value },
                          })
                        }
                        type="time"
                        value={session.endUtc}
                      />
                    )}
                  </Labeled>
                </>
              )}
            </fieldset>
          </fieldset>
        </div>
        <div className="grid content-start gap-4">
          <h2 className="font-semibold text-lg">Definition text (JSON)</h2>
          <label className="sr-only" htmlFor={textId}>
            Definition text
          </label>
          <textarea
            className="min-h-[32rem] rounded-md border bg-background p-3 font-mono text-xs"
            id={textId}
            onChange={(event) => editText(event.target.value)}
            spellCheck={false}
            value={text}
          />
          <section aria-label="Validation" aria-live="polite">
            {validation.ok ? (
              <p className="text-sm">The definition is valid.</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {validation.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <span className="font-mono">{issue.path || "(root)"}</span>:{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </section>

      <section aria-label="Backtest" className="grid gap-4">
        <h2 className="font-semibold text-lg">Backtest</h2>
        {load.series.length === 0 ? (
          <p className="text-sm">
            No stored bar series. Import bars with
            scripts/vertex-market-bars-import.ts first.
          </p>
        ) : null}
        <form
          className="grid gap-4 rounded-md border p-4 md:grid-cols-2 lg:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1 lg:col-span-2">
            <label className={LABEL} htmlFor={seriesId}>
              Symbol and timeframe
            </label>
            <select
              className={CONTROL}
              id={seriesId}
              onChange={(event) => {
                const next = load.series.find(
                  (entry) => seriesKey(entry) === event.target.value
                );
                touched.current = true;
                setSelectedSeries(event.target.value);
                if (next === undefined) return;
                writeQuery(
                  { run: null, symbol: next.symbol },
                  { symbol: defaultSymbol }
                );
                editForm({
                  from: isoDate(next.firstT),
                  to: isoDate(next.lastT),
                });
              }}
              value={selectedSeries}
            >
              {load.series.map((entry) => (
                <option key={seriesKey(entry)} value={seriesKey(entry)}>
                  {entry.symbol} {entry.timeframe}
                </option>
              ))}
            </select>
          </div>
          <Labeled label="From">
            {(id) => (
              <input
                className={CONTROL}
                id={id}
                onChange={(event) => editForm({ from: event.target.value })}
                type="date"
                value={form.from}
              />
            )}
          </Labeled>
          <Labeled label="To">
            {(id) => (
              <input
                className={CONTROL}
                id={id}
                onChange={(event) => editForm({ to: event.target.value })}
                type="date"
                value={form.to}
              />
            )}
          </Labeled>
          <NumberField
            label="Initial capital"
            onChange={(initialCapital) => editForm({ initialCapital })}
            value={form.initialCapital}
          />
          <NumberField
            label="Cost per side (bps)"
            onChange={(costBps) => editForm({ costBps })}
            value={form.costBps}
          />
          <div className="grid content-end gap-2 lg:col-span-4">
            {request !== null && "error" in request ? (
              <p className="text-sm">{request.error}</p>
            ) : null}
            {validation.ok ? null : (
              <p className="text-sm">
                Fix the definition before you run a backtest.
              </p>
            )}
          </div>
          <button
            className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm disabled:opacity-60"
            disabled={request === null || "error" in request || submitting}
            type="submit"
          >
            Run backtest
          </button>
        </form>
        {message === null ? null : (
          <p className="text-sm" role="alert">
            {message}
          </p>
        )}
        <ShownRun latest={latest} run={run} />
      </section>
    </div>
  );
};
