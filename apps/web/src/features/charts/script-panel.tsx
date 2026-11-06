"use client";

import {
  type RunResult,
  SCRIPT_TEMPLATES,
  type ScriptError,
  type ScriptInputSpec,
  type ScriptTemplate,
} from "@darkfactory/scripting";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CHART_BUTTON, CHART_FIELD } from "./chart-ui.ts";
import { SCRIPT_LAYERS_MAX } from "./kline-adapter.ts";
import {
  type AppliedScript,
  caretOffset,
  describeRun,
  groupTemplates,
  inputOptions,
  inputValue,
  isFreshRun,
  NEW_SCRIPT_SOURCE,
  parseInputValue,
  resolveActiveScripts,
  type ScriptRun,
  scriptLayers,
  toScriptBars,
} from "./script-model.ts";
import {
  createScriptRunner,
  SCRIPT_RUN_SUPERSEDED,
  type ScriptRunner,
} from "./script-runner.ts";
import type { ScriptInputs } from "./script-sandbox.ts";
import {
  loadActiveScripts,
  loadSavedScripts,
  newScriptId,
  removeSavedScript,
  type SavedScript,
  type ScriptStore,
  storeActiveScripts,
  storeSavedScripts,
  upsertSavedScript,
} from "./scripts-storage.ts";
import type { DisplayCandle, ScriptLayer } from "./types.ts";

// One script sent by the Quant assistant; a new nonce means a new request.
export type ScriptRequest = Readonly<{
  title: string;
  source: string;
  nonce: number;
}>;

export type ScriptPanelProps = Readonly<{
  symbol: string;
  candles: readonly DisplayCandle[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLayers: (layers: readonly ScriptLayer[]) => void;
  request?: ScriptRequest | null;
  // Injected for tests; defaults to a module Web Worker created on first use.
  runner?: ScriptRunner;
  storage?: ScriptStore | null;
  now?: () => number;
  // Delay before applied scripts re-run on new bars; coalesces fast ticks.
  rerunDelayMs?: number;
}>;

type Editor = Readonly<{
  title: string;
  source: string;
  ref: string | null;
  // The applied script this editor updates on Run; null adds a new one.
  layerId: string | null;
}>;

const LINE_HEIGHT = 20;
const EMPTY_LAYERS: readonly ScriptLayer[] = Object.freeze([]);
const NO_INPUTS: ScriptInputs = Object.freeze({});
const TEMPLATE_GROUPS = groupTemplates(SCRIPT_TEMPLATES);
// Runner key for editor runs of a script not yet on the chart (latest wins).
const EDITOR_RUN_KEY = "editor";

const browserStore = (): ScriptStore | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const savedId = (ref: string | null): string | null =>
  ref?.startsWith("saved:") ? ref.slice("saved:".length) : null;

export const ScriptPanel = ({
  symbol,
  candles,
  open,
  onOpenChange,
  onLayers,
  request = null,
  runner,
  storage = browserStore(),
  now = Date.now,
  rerunDelayMs = 150,
}: ScriptPanelProps) => {
  const ids = useId();
  const bars = useMemo(() => toScriptBars(candles), [candles]);
  const [editor, setEditor] = useState<Editor>({
    layerId: null,
    ref: null,
    source: NEW_SCRIPT_SOURCE,
    title: "",
  });
  const [inputs, setInputs] = useState<ScriptInputs>(NO_INPUTS);
  const [specs, setSpecs] = useState<readonly ScriptInputSpec[]>([]);
  const [errors, setErrors] = useState<readonly ScriptError[]>([]);
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState<readonly SavedScript[]>(() =>
    loadSavedScripts(storage)
  );
  const nextLayer = useRef(0);
  const layerId = useCallback(() => {
    nextLayer.current += 1;
    return `script-${nextLayer.current}`;
  }, []);
  // Scripts on the chart, restored from the last session for this symbol.
  const restore = (forSymbol: string): readonly AppliedScript[] =>
    resolveActiveScripts(
      loadActiveScripts(storage, forSymbol),
      loadSavedScripts(storage),
      SCRIPT_TEMPLATES
    ).map((entry) => ({ ...entry, id: layerId() }));
  const [applied, setApplied] = useState<readonly AppliedScript[]>(() =>
    restore(symbol)
  );
  const [runs, setRuns] = useState<ReadonlyMap<string, ScriptRun>>(
    () => new Map()
  );
  // A new symbol has its own scripts: they replace the old symbol's before anything is
  // drawn or stored, so the old ones are never written under the new symbol's key.
  const [loadedSymbol, setLoadedSymbol] = useState(symbol);
  if (loadedSymbol !== symbol) {
    setLoadedSymbol(symbol);
    setApplied(restore(symbol));
    setRuns(new Map());
    setEditor((current) => ({ ...current, layerId: null }));
  }
  const latest = useRef({ applied, symbol });
  latest.current = { applied, symbol };
  const [templateId, setTemplateId] = useState(SCRIPT_TEMPLATES[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const escaped = useRef(false);
  const mounted = useRef(true);
  const owned = useRef<ScriptRunner | null>(null);
  const runsRef = useRef(runs);
  runsRef.current = runs;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      owned.current?.dispose();
      owned.current = null;
    };
  }, []);
  // Created on first use only, so nothing starts a Worker during server rendering.
  const getRunner = useCallback((): ScriptRunner => {
    if (runner !== undefined) return runner;
    owned.current ??= createScriptRunner();
    return owned.current;
  }, [runner]);

  // The old symbol's layers leave the chart at once; restored scripts follow when they ran.
  useEffect(() => {
    onLayers(EMPTY_LAYERS);
    return;
  }, [symbol]);
  const layers = useMemo(
    () =>
      applied.length === 0 ? EMPTY_LAYERS : scriptLayers(applied, runs, bars),
    [applied, runs, bars]
  );
  useEffect(() => {
    if (layers !== null) onLayers(layers);
    return;
  }, [layers, onLayers]);

  // Applied scripts re-run whenever the bars, their source or their inputs change.
  useEffect(() => {
    const stale = applied.filter(
      (entry) => !isFreshRun(runsRef.current.get(entry.id), entry, bars)
    );
    if (stale.length === 0) return;
    let current = true;
    const timer = setTimeout(() => {
      for (const entry of stale)
        void getRunner()
          .run(entry.source, bars, entry.inputs, entry.id)
          .then((result) => {
            if (
              !(current && mounted.current) ||
              result === SCRIPT_RUN_SUPERSEDED
            )
              return;
            setRuns((previous) =>
              new Map(previous).set(entry.id, {
                bars,
                inputs: entry.inputs,
                result,
                source: entry.source,
              })
            );
          });
    }, rerunDelayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [applied, bars, getRunner, rerunDelayMs]);

  useEffect(() => {
    storeActiveScripts(
      storage,
      symbol,
      applied.flatMap((entry) =>
        entry.ref === null ? [] : [{ inputs: entry.inputs, ref: entry.ref }]
      )
    );
    return;
  }, [applied, storage, symbol]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const element = textarea.current;
    if (caret === null || element === null) return;
    pendingCaret.current = null;
    element.setSelectionRange(caret, caret);
    return;
  });

  // Runs one script and puts it on the chart (replacing the one the editor came from).
  const runScriptSpec = useCallback(
    async (spec: Editor, values: ScriptInputs): Promise<RunResult | null> => {
      const title = spec.title.trim() || "Untitled script";
      if (spec.layerId === null && applied.length >= SCRIPT_LAYERS_MAX) {
        setStatus(
          `At most ${SCRIPT_LAYERS_MAX} scripts can be on the chart. Remove one first.`
        );
        return null;
      }
      setRunning(true);
      setStatus(`Running "${title}"…`);
      const startedFor = symbol;
      const result = await getRunner().run(
        spec.source,
        bars,
        values,
        spec.layerId ?? EDITOR_RUN_KEY
      );
      if (!mounted.current || result === SCRIPT_RUN_SUPERSEDED) return null;
      setRunning(false);
      // Ran for another symbol, or the script it updates was removed meanwhile: dropped.
      if (
        latest.current.symbol !== startedFor ||
        (spec.layerId !== null &&
          !latest.current.applied.some((other) => other.id === spec.layerId))
      ) {
        setStatus(`"${title}" finished after it left the chart; not applied.`);
        return null;
      }
      setStatus(
        describeRun(
          result,
          spec.title.trim() || (result.ok && result.title) || title
        )
      );
      if (!result.ok) {
        setErrors(result.errors);
        return result;
      }
      setErrors([]);
      setSpecs(result.inputs);
      const id = spec.layerId ?? layerId();
      const entry: AppliedScript = {
        id,
        inputs: values,
        ref: spec.ref,
        source: spec.source,
        title: spec.title.trim() || result.title,
      };
      setRuns((previous) =>
        new Map(previous).set(id, {
          bars,
          inputs: values,
          result,
          source: spec.source,
        })
      );
      setApplied((current) =>
        spec.layerId === null
          ? [...current, entry]
          : current.map((other) => (other.id === id ? entry : other))
      );
      setEditor((current) =>
        current.source === spec.source
          ? { ...current, layerId: id, title: current.title || result.title }
          : current
      );
      return result;
    },
    [applied.length, bars, getRunner, layerId, symbol]
  );

  // A script from the Quant assistant: load it into the editor, run it and apply it.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (request === null || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const spec: Editor = {
      layerId: null,
      ref: null,
      source: request.source,
      title: request.title,
    };
    setEditor(spec);
    setInputs(NO_INPUTS);
    setSpecs([]);
    setErrors([]);
    void runScriptSpec(spec, NO_INPUTS);
    return;
  }, [request, runScriptSpec]);

  const run = () => void runScriptSpec(editor, inputs);

  const load = (next: Editor, values: ScriptInputs = NO_INPUTS) => {
    setEditor(next);
    setInputs(values);
    setSpecs([]);
    setErrors([]);
  };

  const save = () => {
    if (editor.source.trim() === "") {
      setStatus("There is no script to save.");
      return;
    }
    const id = savedId(editor.ref) ?? newScriptId(now());
    const title = editor.title.trim() || "Untitled script";
    const next = upsertSavedScript(saved, {
      id,
      source: editor.source,
      title,
      updatedAt: Math.trunc(now()),
    });
    const ref = `saved:${id}`;
    setSaved(next);
    setEditor((current) => ({ ...current, ref, title }));
    if (editor.layerId !== null)
      setApplied((current) =>
        current.map((entry) =>
          entry.id === editor.layerId ? { ...entry, ref } : entry
        )
      );
    setStatus(
      storeSavedScripts(storage, next)
        ? `Saved "${title}".`
        : `"${title}" is kept for this visit only: this browser refused to store it.`
    );
  };

  const remove = (id: string) => {
    const next = removeSavedScript(saved, id);
    const ref = editor.ref;
    setSaved(next);
    storeSavedScripts(storage, next);
    setEditor((current) => ({ ...current, ref: null }));
    setApplied((current) =>
      current.map((entry) =>
        entry.ref === ref ? { ...entry, ref: null } : entry
      )
    );
    setStatus(
      `Deleted "${editor.title.trim() || "Untitled script"}" from My scripts.`
    );
  };

  const create = () => {
    load({ layerId: null, ref: null, source: NEW_SCRIPT_SOURCE, title: "" });
    setStatus("New script. Edit it, then press Run.");
    textarea.current?.focus();
  };

  const applyTemplate = (template: ScriptTemplate) => {
    load({
      layerId: null,
      ref: `template:${template.id}`,
      source: template.source,
      title: template.title,
    });
    setStatus(
      `Loaded the "${template.title}" template. Press Run to apply it.`
    );
  };

  const edit = (entry: AppliedScript) => {
    const result = runs.get(entry.id)?.result;
    load(
      {
        layerId: entry.id,
        ref: entry.ref,
        source: entry.source,
        title: entry.title,
      },
      entry.inputs
    );
    if (result?.ok) setSpecs(result.inputs);
    onOpenChange(true);
    setStatus(`Editing "${entry.title}". Run updates it on the chart.`);
  };

  const detach = (entry: AppliedScript) => {
    setApplied((current) => current.filter((other) => other.id !== entry.id));
    setRuns((previous) => {
      const next = new Map(previous);
      next.delete(entry.id);
      return next;
    });
    setEditor((current) =>
      current.layerId === entry.id ? { ...current, layerId: null } : current
    );
    setStatus(`Removed "${entry.title}" from the chart.`);
  };

  const setInput = (spec: ScriptInputSpec, raw: string | boolean) => {
    const value = parseInputValue(spec, raw);
    if (value === null) return;
    const next = { ...inputs, [spec.id]: value };
    setInputs(next);
    // An input of a script already on the chart updates it right away.
    if (editor.layerId !== null)
      setApplied((current) =>
        current.map((entry) =>
          entry.id === editor.layerId && entry.source === editor.source
            ? { ...entry, inputs: next }
            : entry
        )
      );
  };

  // Focus and the caret move scroll the editor to the line.
  const goTo = (error: ScriptError) => {
    const offset = caretOffset(editor.source, error.line, error.column);
    textarea.current?.focus();
    textarea.current?.setSelectionRange(offset, offset);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
      return;
    }
    if (event.key === "Escape") {
      escaped.current = true;
      return;
    }
    const leave = escaped.current;
    escaped.current = false;
    if (
      event.key !== "Tab" ||
      leave ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const source = `${editor.source.slice(0, start)}    ${editor.source.slice(end)}`;
    pendingCaret.current = start + 4;
    setEditor((current) => ({ ...current, source }));
  };

  const lineCount = editor.source.split("\n").length;
  const selectedTemplate = SCRIPT_TEMPLATES.find(
    (entry) => entry.id === templateId
  );
  const savedNow = savedId(editor.ref);
  const regionId = `${ids}-region`;

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="space-y-3 rounded-md border border-border p-3"
      data-script-panel=""
    >
      <h3 className="font-semibold" id={`${ids}-heading`}>
        <button
          aria-controls={regionId}
          aria-expanded={open}
          className={`${CHART_BUTTON} w-full text-left`}
          data-script-toggle=""
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          Scripts{applied.length > 0 ? ` (${applied.length} on chart)` : ""}
        </button>
      </h3>
      <p
        aria-live="polite"
        className="min-h-5 text-muted-foreground text-xs"
        data-script-status=""
        role="status"
      >
        {status}
      </p>
      <div className="space-y-4" hidden={!open} id={regionId}>
        <p className="text-muted-foreground text-xs">
          Scripts use a Pine Script compatible subset and run in your browser.
          Their plots and signals are chart annotations only, never trading
          instructions.
        </p>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-2">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              Script title
              <input
                className={`${CHART_FIELD} min-w-0 flex-1`}
                data-script-title=""
                maxLength={80}
                onChange={(event) => {
                  const title = event.target.value;
                  setEditor((current) => ({ ...current, title }));
                }}
                value={editor.title}
              />
            </label>
            <div className="flex overflow-hidden rounded-md border border-border font-mono text-sm">
              <div
                aria-hidden="true"
                className="select-none overflow-hidden border-border border-r bg-muted px-2 py-2 text-right text-muted-foreground"
                data-script-gutter=""
                style={{ lineHeight: `${LINE_HEIGHT}px`, maxHeight: "24rem" }}
              >
                <div style={{ transform: `translateY(${-scrollTop}px)` }}>
                  {Array.from(
                    { length: lineCount },
                    (_, index) => index + 1
                  ).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </div>
              <textarea
                aria-describedby={`${ids}-editor-help`}
                aria-label="Script source"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="min-h-64 w-full resize-y bg-background px-2 py-2 font-mono focus-visible:outline-2"
                data-script-editor=""
                maxLength={16_000}
                onChange={(event) => {
                  const source = event.target.value;
                  setEditor((current) => ({ ...current, source }));
                }}
                onKeyDown={onKeyDown}
                onScroll={(event) =>
                  setScrollTop(event.currentTarget.scrollTop)
                }
                ref={textarea}
                rows={14}
                spellCheck={false}
                style={{ lineHeight: `${LINE_HEIGHT}px`, maxHeight: "24rem" }}
                value={editor.source}
                wrap="off"
              />
            </div>
            <p
              className="text-muted-foreground text-xs"
              id={`${ids}-editor-help`}
            >
              Tab inserts four spaces. Press Escape, then Tab, to leave the
              editor. Ctrl+Enter or Cmd+Enter runs the script.
            </p>
            <div
              aria-label="Script actions"
              className="flex flex-wrap gap-2"
              role="toolbar"
            >
              <button
                className={CHART_BUTTON}
                data-script-run=""
                disabled={running}
                onClick={run}
                type="button"
              >
                {editor.layerId === null ? "Run" : "Run (update chart)"}
              </button>
              <button
                className={CHART_BUTTON}
                data-script-save=""
                onClick={save}
                type="button"
              >
                Save
              </button>
              <button
                className={CHART_BUTTON}
                data-script-new=""
                onClick={create}
                type="button"
              >
                New
              </button>
              <button
                className={CHART_BUTTON}
                data-script-delete=""
                disabled={savedNow === null}
                onClick={savedNow === null ? undefined : () => remove(savedNow)}
                type="button"
              >
                Delete
              </button>
            </div>
            {errors.length > 0 ? (
              <section aria-labelledby={`${ids}-errors`} data-script-errors="">
                <h4 className="font-semibold text-sm" id={`${ids}-errors`}>
                  Errors
                </h4>
                <ul className="mt-1 space-y-1">
                  {errors.map((error) => (
                    <li key={`${error.line}:${error.column}:${error.message}`}>
                      <button
                        className={`${CHART_BUTTON} w-full text-left font-mono`}
                        onClick={() => goTo(error)}
                        type="button"
                      >
                        {error.line}:{error.column} {error.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {specs.length > 0 ? (
              <fieldset className="space-y-2" data-script-inputs="">
                <legend className="font-semibold text-sm">Inputs</legend>
                {specs.map((spec) => (
                  <ScriptInputControl
                    key={spec.id}
                    onChange={(raw) => setInput(spec, raw)}
                    spec={spec}
                    value={inputValue(spec, inputs)}
                  />
                ))}
              </fieldset>
            ) : null}
          </div>
          <div className="space-y-4 text-sm">
            <section aria-labelledby={`${ids}-library`} data-script-library="">
              <h4 className="font-semibold" id={`${ids}-library`}>
                Indicator library
              </h4>
              <label className="mt-2 flex flex-col gap-1">
                Template
                <select
                  aria-describedby={`${ids}-template-help`}
                  className={CHART_FIELD}
                  data-script-template=""
                  onChange={(event) => setTemplateId(event.target.value)}
                  value={templateId}
                >
                  {TEMPLATE_GROUPS.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {group.templates.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.title}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <p
                className="mt-1 text-muted-foreground text-xs"
                id={`${ids}-template-help`}
              >
                {selectedTemplate?.description ?? "No templates available."}
              </p>
              <button
                className={`${CHART_BUTTON} mt-2`}
                data-script-use-template=""
                disabled={selectedTemplate === undefined}
                onClick={
                  selectedTemplate === undefined
                    ? undefined
                    : () => applyTemplate(selectedTemplate)
                }
                type="button"
              >
                Use template
              </button>
            </section>
            <section aria-labelledby={`${ids}-saved`} data-script-saved="">
              <h4 className="font-semibold" id={`${ids}-saved`}>
                My scripts
              </h4>
              {saved.length === 0 ? (
                <p className="mt-1 text-muted-foreground text-xs">
                  No saved scripts yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {saved.map((script) => (
                    <li
                      className="flex items-center justify-between gap-2"
                      data-saved-script={script.id}
                      key={script.id}
                    >
                      <span className="min-w-0 truncate">{script.title}</span>
                      <button
                        aria-label={`Open ${script.title}`}
                        className={CHART_BUTTON}
                        onClick={() => {
                          load({
                            layerId: null,
                            ref: `saved:${script.id}`,
                            source: script.source,
                            title: script.title,
                          });
                          setStatus(`Opened "${script.title}".`);
                        }}
                        type="button"
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby={`${ids}-applied`} data-script-applied="">
              <h4 className="font-semibold" id={`${ids}-applied`}>
                On chart
              </h4>
              {applied.length === 0 ? (
                <p className="mt-1 text-muted-foreground text-xs">
                  No scripts on the chart.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {applied.map((entry) => {
                    const current = runs.get(entry.id);
                    const state = isFreshRun(current, entry, bars)
                      ? current.result.ok
                        ? `${current.result.plots.length} plots, ${current.result.signals.length} signals`
                        : `Error: ${current.result.errors[0]?.message ?? "did not run"}`
                      : "Running…";
                    return (
                      <li data-applied-script={entry.id} key={entry.id}>
                        <span className="block truncate">{entry.title}</span>
                        <span className="block text-muted-foreground text-xs">
                          {state}
                        </span>
                        <span className="mt-1 flex gap-2">
                          <button
                            aria-label={`Edit ${entry.title}`}
                            className={CHART_BUTTON}
                            onClick={() => edit(entry)}
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            aria-label={`Remove ${entry.title} from the chart`}
                            className={CHART_BUTTON}
                            onClick={() => detach(entry)}
                            type="button"
                          >
                            Remove
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </section>
  );
};

const ScriptInputControl = ({
  spec,
  value,
  onChange,
}: Readonly<{
  spec: ScriptInputSpec;
  value: string | number | boolean;
  onChange: (raw: string | boolean) => void;
}>) => {
  const label = spec.title || spec.id;
  if (spec.kind === "bool")
    return (
      <label className="flex min-h-11 items-center gap-2">
        <input
          checked={value === true}
          className="size-5"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {label}
      </label>
    );
  const options = inputOptions(spec);
  if (options.length > 0)
    return (
      <label className="flex min-h-11 items-center gap-2">
        {label}
        <select
          className={CHART_FIELD}
          onChange={(event) => onChange(event.target.value)}
          value={String(value)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  if (spec.kind === "int" || spec.kind === "float")
    return (
      <label className="flex min-h-11 items-center gap-2">
        {label}
        <input
          className={`${CHART_FIELD} w-28`}
          defaultValue={String(value)}
          inputMode={spec.kind === "int" ? "numeric" : "decimal"}
          key={String(value)}
          {...(spec.min === undefined ? {} : { min: spec.min })}
          {...(spec.max === undefined ? {} : { max: spec.max })}
          onBlur={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onChange(event.currentTarget.value);
          }}
          step={spec.kind === "int" ? 1 : "any"}
          type="number"
        />
      </label>
    );
  return (
    <label className="flex min-h-11 items-center gap-2">
      {label}
      <input
        className={`${CHART_FIELD} min-w-0 flex-1`}
        defaultValue={String(value)}
        key={String(value)}
        maxLength={200}
        onBlur={(event) => onChange(event.target.value)}
        type="text"
      />
    </label>
  );
};
