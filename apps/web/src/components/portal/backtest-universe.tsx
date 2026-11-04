import {
  BACKTEST_UNIVERSES,
  type BacktestUniverseId,
  backtestUniverse,
  DEFAULT_BACKTEST_UNIVERSE_ID,
  isBacktestUniverseId,
  universeSeries,
} from "@darkfactory/shared/universes";
import { useId } from "react";

// Universe choice for the backtest, sweep, backtest-run and Autopilot forms. "Core 7 futures" is
// preselected (owner decision 2026-11-03); the user can change it or show every stored series.

export type UniverseChoice = BacktestUniverseId | "all";

export const DEFAULT_UNIVERSE_CHOICE: UniverseChoice =
  DEFAULT_BACKTEST_UNIVERSE_ID;

export const UNIVERSE_CHOICES: readonly Readonly<{
  value: UniverseChoice;
  label: string;
}>[] = [
  ...BACKTEST_UNIVERSES.map((universe) => ({
    label: universe.label,
    value: universe.id,
  })),
  { label: "All stored series", value: "all" },
];

/** Reads a choice from a URL or a select; anything unknown falls back to the default. */
export const parseUniverseChoice = (value: string | null): UniverseChoice => {
  if (value === "all") return "all";
  return isBacktestUniverseId(value) ? value : DEFAULT_UNIVERSE_CHOICE;
};

export const universeChoiceLabel = (choice: UniverseChoice): string =>
  choice === "all" ? "All stored series" : backtestUniverse(choice).label;

/**
 * Series to list for a choice. A universe with no stored member falls back to every stored
 * series (`fallback: true`), so the form still works before Core 7 bars are imported.
 */
export const visibleSeries = <S extends Readonly<{ symbol: string }>>(
  series: readonly S[],
  choice: UniverseChoice
): Readonly<{ series: S[]; fallback: boolean }> => {
  if (choice === "all") return { fallback: false, series: [...series] };
  const members = universeSeries(series, choice);
  return members.length === 0
    ? { fallback: true, series: [...series] }
    : { fallback: false, series: members };
};

/** Key ("SYMBOL:timeframe") of the first series the choice lists, or "" when none is stored. */
export const firstSeriesKey = (
  series: readonly Readonly<{ symbol: string; timeframe: string }>[],
  choice: UniverseChoice
): string => {
  const [first] = visibleSeries(series, choice).series;
  return first === undefined ? "" : `${first.symbol}:${first.timeframe}`;
};

const DEFAULT_SELECT_CLASS =
  "min-h-11 rounded-md border bg-background px-3 text-sm";

export type UniverseSelectProps = Readonly<{
  id?: string;
  value: UniverseChoice;
  onChange: (value: UniverseChoice) => void;
  /** True when the chosen universe has no stored member and every series is shown. */
  fallback: boolean;
  /** Symbols that have stored bars; members without one are marked "(no bars)". */
  storedSymbols: readonly string[];
  selectClassName?: string;
}>;

export const UniverseSelect = ({
  id,
  value,
  onChange,
  fallback,
  storedSymbols,
  selectClassName = DEFAULT_SELECT_CLASS,
}: UniverseSelectProps) => {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const membersId = `${selectId}-members`;
  const noteId = `${selectId}-note`;
  const members = value === "all" ? [] : backtestUniverse(value).members;
  const describedBy = [
    members.length === 0 ? null : membersId,
    fallback ? noteId : null,
  ]
    .filter((entry) => entry !== null)
    .join(" ");
  return (
    <div className="grid min-w-0 gap-1">
      <label className="font-medium text-sm" htmlFor={selectId}>
        Universe
      </label>
      <select
        aria-describedby={describedBy === "" ? undefined : describedBy}
        className={selectClassName}
        id={selectId}
        onChange={(event) => onChange(parseUniverseChoice(event.target.value))}
        value={value}
      >
        {UNIVERSE_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      {members.length === 0 ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-universe-members=""
          id={membersId}
        >
          {members
            .map(
              (member) =>
                `${member.symbol} ${member.market}${storedSymbols.includes(member.symbol) ? "" : " (no bars)"}`
            )
            .join(" · ")}
        </p>
      )}
      {fallback ? (
        <p className="text-xs" data-universe-fallback="" id={noteId}>
          No stored bars for {universeChoiceLabel(value)} yet. Showing all
          stored series.
        </p>
      ) : null}
    </div>
  );
};
