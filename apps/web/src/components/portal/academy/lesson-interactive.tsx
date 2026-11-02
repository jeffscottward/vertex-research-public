"use client";

// Interactive example: the same chart as the video with every parameter editable, a time scrubber
// (forward and back), step-through of the lesson's drawing steps, 3D rotation and the data tables.
import {
  buildScene,
  buildTables,
  type ColorToken,
  type DataTable,
  defaultValues,
  elementColors,
  FORMULAS,
  type Lesson,
  type LessonParam,
} from "@darkfactory/academy";
import { LessonChart } from "@darkfactory/academy/chart";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAcademyTheme } from "./academy-theme.tsx";
import { elementName } from "./lesson-video.tsx";

const SCRUB_STEPS = 1000;

const ParamInput = ({
  param,
  value,
  onChange,
}: {
  param: LessonParam;
  value: number | string;
  onChange: (value: number | string) => void;
}) => {
  const id = `param-${param.id}`;
  return (
    <label
      className="flex flex-col gap-1 text-muted-foreground text-xs"
      htmlFor={id}
      title={param.help}
    >
      <span>
        {param.label}
        {param.unit === undefined ? "" : ` (${param.unit})`}
      </span>
      {param.kind === "select" ? (
        <select
          className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={String(value)}
        >
          {(param.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="min-h-11 rounded-md border border-border bg-background px-2 text-foreground text-sm tabular-nums"
          id={id}
          inputMode="decimal"
          max={param.max}
          min={param.min}
          onChange={(event) =>
            onChange(
              param.kind === "text"
                ? event.target.value
                : event.target.value === ""
                  ? ""
                  : Number(event.target.value)
            )
          }
          step={param.step ?? "any"}
          type={param.kind === "text" ? "text" : "number"}
          value={value}
        />
      )}
    </label>
  );
};

export const TableView = ({ table }: { readonly table: DataTable }) => (
  <div
    className="overflow-x-auto rounded-lg border border-border"
    data-table={table.id}
  >
    <table className="w-full min-w-max text-sm">
      <caption className="px-3 py-2 text-left font-semibold">
        {table.title}
      </caption>
      <thead className="bg-muted/60 text-muted-foreground text-xs">
        <tr>
          {table.columns.map((column) => (
            <th
              className="px-3 py-2 text-left font-medium"
              key={column}
              scope="col"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr className="border-border border-t" key={`${table.id}-${index}`}>
            {row.map((cell, column) => (
              <td
                className={`px-3 py-1.5 ${column === 0 ? "" : "tabular-nums"}`}
                key={`${index}-${column}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    {table.note === undefined ? null : (
      <p className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
        {table.note}
      </p>
    )}
  </div>
);

export const LessonInteractive = ({ lesson }: { readonly lesson: Lesson }) => {
  const { palette } = useAcademyTheme();
  const defaults = useMemo(() => defaultValues(lesson.params), [lesson]);
  const [values, setValues] =
    useState<Record<string, number | string>>(defaults);
  const [scrub, setScrub] = useState(Math.round(SCRUB_STEPS * 0.5));
  const [step, setStep] = useState<number | null>(null);
  const [azimuth, setAzimuth] = useState(0.6);
  const [playing, setPlaying] = useState(false);
  const colors = useMemo(() => elementColors(lesson), [lesson]);
  // Each step paired with its element color: the first step that draws an element sets its color.
  const steps = useMemo(() => {
    const first: Record<string, ColorToken> = {};
    return lesson.steps.map((entry) => {
      const color = first[entry.element] ?? entry.color;
      first[entry.element] = color;
      return { entry, color };
    });
  }, [lesson]);
  // Blank inputs keep the default until a number is typed.
  const effective = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          value === "" ? (defaults[key] ?? 0) : value,
        ])
      ),
    [values, defaults]
  );
  const t = scrub / SCRUB_STEPS;
  const scene = useMemo(
    () => buildScene(lesson, effective, t, azimuth),
    [lesson, effective, t, azimuth]
  );
  const tables = useMemo(
    () => buildTables(lesson, effective, t),
    [lesson, effective, t]
  );
  const has3d = scene.panels.some((panel) => panel.surface !== undefined);
  const revealed = useMemo(() => {
    if (step === null) return "all" as const;
    const map = new Map<string, number>();
    for (const entry of lesson.steps.slice(0, step + 1))
      map.set(entry.element, 1);
    return map;
  }, [lesson, step]);
  const unit =
    scene.timeUnit === "days" ? 1 / Math.max(scene.horizon, 1) : 0.01;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setScrub((current) => {
        if (current >= SCRUB_STEPS) {
          setPlaying(false);
          return SCRUB_STEPS;
        }
        return Math.min(
          current + Math.max(Math.round(SCRUB_STEPS * unit), 4),
          SCRUB_STEPS
        );
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [playing, unit]);

  const goStep = (index: number | null, time?: readonly [number, number]) => {
    setStep(index);
    if (time !== undefined) setScrub(Math.round(time[1] * SCRUB_STEPS));
  };
  const nudge = (direction: 1 | -1) =>
    setScrub((current) =>
      Math.min(
        Math.max(
          current + direction * Math.max(Math.round(SCRUB_STEPS * unit), 1),
          0
        ),
        SCRUB_STEPS
      )
    );
  const active = step === null ? null : (steps[step] ?? null);
  const timeText = `${scene.timeLabel}: ${scene.timeUnit === "pct" ? `${scene.now.toFixed(0)}%` : scene.now.toFixed(scene.timeUnit === "days" ? 1 : 0)}${scene.timeUnit === "pct" ? "" : ` of ${scene.horizon.toFixed(0)}`}`;

  return (
    <div className="flex flex-col gap-4" data-lesson-interactive>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Lesson steps"
      >
        <button
          className={`min-h-11 rounded-md border px-3 text-sm ${step === null ? "border-primary" : "border-border"}`}
          onClick={() => goStep(null)}
          type="button"
        >
          Show all
        </button>
        {steps.map(({ entry, color }, index) => (
          <button
            aria-pressed={step === index}
            className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${step === index ? "border-primary bg-muted" : "border-border"}`}
            data-step-button={index}
            key={`${entry.element}-${index}`}
            onClick={() => goStep(index, entry.time)}
            type="button"
          >
            <span
              className="size-2.5 rounded-full"
              style={{
                background: palette.tokens[color],
              }}
            />
            Step {index + 1}
          </button>
        ))}
      </div>
      {active === null ? null : (
        <p
          className="rounded-md border border-border p-3 text-sm"
          data-step-caption
          style={{
            borderLeft: `6px solid ${palette.tokens[active.color]}`,
          }}
        >
          <span
            className="mr-2 font-semibold text-xs uppercase"
            style={{
              color: palette.tokens[active.color],
            }}
          >
            ● {elementName(active.entry.element)}
          </span>
          {active.entry.caption}
        </p>
      )}
      <div
        className="overflow-hidden rounded-lg border border-border"
        data-interactive-chart
        data-time={t.toFixed(3)}
      >
        <LessonChart
          azimuth={azimuth}
          colors={colors}
          height={720}
          highlight={active?.entry.element ?? null}
          idPrefix="interactive"
          palette={palette}
          revealed={revealed}
          scene={scene}
          width={1280}
        />
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-label="Step back in time"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border"
            data-scrub-back
            onClick={() => nudge(-1)}
            type="button"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </button>
          <button
            aria-label={playing ? "Pause" : "Play forward in time"}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border"
            onClick={() => {
              // Play at the end of the horizon starts over from entry.
              if (!playing && scrub >= SCRUB_STEPS) setScrub(0);
              setPlaying(!playing);
            }}
            type="button"
          >
            {playing ? (
              <Pause aria-hidden className="size-4" />
            ) : (
              <Play aria-hidden className="size-4" />
            )}
          </button>
          <button
            aria-label="Step forward in time"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border"
            data-scrub-forward
            onClick={() => nudge(1)}
            type="button"
          >
            <ChevronRight aria-hidden className="size-4" />
          </button>
          <label
            className="flex min-w-48 flex-1 flex-col gap-1 text-muted-foreground text-xs"
            htmlFor="lesson-scrubber"
          >
            <span data-scrub-label>{timeText}</span>
            <input
              aria-valuetext={timeText}
              className="min-h-11 w-full accent-primary"
              id="lesson-scrubber"
              max={SCRUB_STEPS}
              min={0}
              onChange={(event) => setScrub(Number(event.target.value))}
              type="range"
              value={scrub}
            />
          </label>
          {has3d ? (
            <label
              className="flex min-w-40 flex-col gap-1 text-muted-foreground text-xs"
              htmlFor="lesson-azimuth"
            >
              Rotate 3D view
              <input
                className="min-h-11 accent-primary"
                id="lesson-azimuth"
                max={3.14}
                min={-3.14}
                onChange={(event) => setAzimuth(Number(event.target.value))}
                step={0.02}
                type="range"
                value={azimuth}
              />
            </label>
          ) : null}
        </div>
      </div>
      <fieldset className="rounded-lg border border-border p-3">
        <legend className="px-1 font-semibold text-sm">Parameters</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {lesson.params.map((param) => (
            <ParamInput
              key={param.id}
              onChange={(value) =>
                setValues((current) => ({ ...current, [param.id]: value }))
              }
              param={param}
              value={values[param.id] ?? param.default}
            />
          ))}
        </div>
        <button
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm"
          onClick={() => setValues(defaults)}
          type="button"
        >
          <RotateCcw aria-hidden className="size-4" /> Reset parameters
        </button>
      </fieldset>
      <div className="grid gap-3 lg:grid-cols-2" data-lesson-tables>
        {tables.map((table) => (
          <TableView key={table.id} table={table} />
        ))}
      </div>
      <section
        aria-label="Formulas"
        className="rounded-lg border border-border p-3"
      >
        <h3 className="mb-2 font-semibold text-sm">Formulas</h3>
        <dl className="grid gap-3 md:grid-cols-2">
          {lesson.formulas.map((id) => (
            <div
              className="rounded-md bg-muted/40 p-3"
              data-formula={id}
              key={id}
            >
              <dt className="text-muted-foreground text-xs">
                {FORMULAS[id].title}
              </dt>
              <dd
                className="overflow-x-auto text-base"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: static MathML constants from @darkfactory/academy formulas.ts, never user input.
                dangerouslySetInnerHTML={{ __html: FORMULAS[id].mathml }}
              />
              <dd className="mt-1 text-muted-foreground text-xs">
                {FORMULAS[id].text}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
};
