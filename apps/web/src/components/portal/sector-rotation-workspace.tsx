"use client";

import {
  SECTOR_ROTATION_TIMEFRAMES,
  type SectorRotationMapOutput,
  type SectorRotationPoint,
  type SectorRotationSeries,
  type SectorRotationTimeframe,
} from "@darkfactory/api";
import {
  Button,
  Input,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TickerLink } from "../ticker-link.tsx";
import { withQuery, writeQuery } from "./backtest-lab-query.ts";
import {
  type ChartHighlight,
  QUADRANT_CHIP,
  QUADRANT_LABELS,
  SectorRotationChart,
} from "./sector-rotation-chart.tsx";
import {
  createBrowserSectorRotationGateway,
  describeSectorRotationFailure,
  parseTickerList,
  SECTORS_PRESET,
  type SectorRotationGateway,
  type SectorRotationUniverseChoice,
  type SectorRotationUniversePreset,
} from "./sector-rotation-client.ts";

// Sector rotation page: the map, a time scrubber and a table of the values at the chosen date.
// Research only: a quadrant describes past prices and never authorizes a trade.

const TAIL_LENGTHS = [5, 10, 20] as const;
const DEFAULT_TIMEFRAME: SectorRotationTimeframe = "weekly";
const DEFAULT_TAIL_LENGTH = 10;
/** Time between two dates while the map plays. */
export const PLAY_STEP_MS = 400;
const CUSTOM_ID = "custom";
// Preset ids: "sectors", "watchlist" and "basket:<id>".
const UNIVERSE_ID = /^[\w:-]{1,64}$/u;

export type SectorRotationSettings = Readonly<{
  tailLength: number;
  timeframe: SectorRotationTimeframe;
  universeId: string;
}>;

type ParamValue = string | readonly string[] | undefined;

/** Reads `?timeframe=&universe=&tail=`; anything unknown falls back to the default. */
export const parseSectorRotationParams = (
  params: Readonly<Record<string, ParamValue>>
): SectorRotationSettings => {
  const { tail, timeframe, universe } = params;
  const tailLength = TAIL_LENGTHS.find((length) => String(length) === tail);
  return {
    tailLength: tailLength ?? DEFAULT_TAIL_LENGTH,
    timeframe:
      SECTOR_ROTATION_TIMEFRAMES.find((key) => key === timeframe) ??
      DEFAULT_TIMEFRAME,
    universeId:
      typeof universe === "string" && UNIVERSE_ID.test(universe)
        ? universe
        : SECTORS_PRESET.id,
  };
};

// Defaults removed from the URL so the default view keeps a clean address.
const URL_DEFAULTS = {
  tail: DEFAULT_TAIL_LENGTH,
  timeframe: DEFAULT_TIMEFRAME,
  universe: SECTORS_PRESET.id,
} as const;

/** The URL parameters this page owns; anything else in the address bar is left alone. */
const sectorRotationQuery = (settings: SectorRotationSettings) => ({
  tail: settings.tailLength,
  timeframe: settings.timeframe,
  universe: settings.universeId,
});

/** The query string for the settings, without the defaults ("" when all are default). */
export const sectorRotationSearch = (
  settings: SectorRotationSettings
): string => withQuery("", sectorRotationQuery(settings), URL_DEFAULTS);

const QUADRANT_ORDER = [
  "leading",
  "improving",
  "weakening",
  "lagging",
] as const satisfies readonly (keyof typeof QUADRANT_LABELS)[];

/** Number of rows in each quadrant (rows without a point are not counted). */
export const quadrantCounts = (
  rows: readonly SectorRotationRow[]
): Readonly<Record<(typeof QUADRANT_ORDER)[number], number>> => {
  const counts = { improving: 0, lagging: 0, leading: 0, weakening: 0 };
  for (const entry of rows)
    if (entry.point !== null) counts[entry.point.quadrant] += 1;
  return counts;
};
const TIMEFRAME_LABELS: Readonly<Record<SectorRotationTimeframe, string>> = {
  daily: "Daily",
  weekly: "Weekly",
};

/** Every date of every series, oldest first, without repeats. */
export const unionDates = (
  series: readonly SectorRotationSeries[]
): readonly string[] =>
  [
    ...new Set(series.flatMap((entry) => entry.points.map((p) => p.date))),
  ].sort();

export type SectorRotationRow = Readonly<{
  name: string | null;
  periods: number;
  point: SectorRotationPoint | null;
  since: string | null;
  symbol: string;
}>;

/**
 * Values of each series on its last point at or before `date`, with the length of the current
 * quadrant streak. On the server's latest date the stored streak is used (it may start before the
 * 12 months shown).
 */
export const rowsAt = (
  series: readonly SectorRotationSeries[],
  date: string | null
): readonly SectorRotationRow[] =>
  series.map((entry) => {
    const visible =
      date === null
        ? entry.points
        : entry.points.filter((candidate) => candidate.date <= date);
    const point = visible.at(-1);
    if (point === undefined)
      return {
        name: entry.name,
        periods: 0,
        point: null,
        since: null,
        symbol: entry.symbol,
      };
    if (entry.latest?.date === point.date)
      return {
        name: entry.name,
        periods: entry.latest.periods,
        point,
        since: entry.latest.since,
        symbol: entry.symbol,
      };
    let periods = 0;
    let since = point.date;
    for (const earlier of [...visible].reverse()) {
      if (earlier.quadrant !== point.quadrant) break;
      periods += 1;
      since = earlier.date;
    }
    return { name: entry.name, periods, point, since, symbol: entry.symbol };
  });

/** "1 day", "3 weeks". */
export const formatPeriods = (
  periods: number,
  timeframe: SectorRotationTimeframe
): string => {
  const unit = timeframe === "daily" ? "day" : "week";
  return `${periods} ${unit}${periods === 1 ? "" : "s"}`;
};

type LoadState =
  | Readonly<{ type: "idle" }>
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; map: SectorRotationMapOutput }>;

/**
 * What the map draws: `choice` null for an empty typed list. `pending` while a linked preset
 * (watchlist, basket) is not known yet: nothing loads until the preset lists arrive.
 */
type Selection = Readonly<{
  choice: SectorRotationUniverseChoice | null;
  pending: boolean;
}>;

const PENDING_KEY = "pending";
const CUSTOM_KEY_PREFIX = "custom:";

/**
 * A string naming what to draw. The map reloads when this changes, not when an equal preset
 * object is replaced (the preset lists arrive after the first load).
 */
const selectionKey = (
  universeId: string,
  customSymbols: readonly string[],
  presets: readonly SectorRotationUniversePreset[]
): string => {
  if (universeId === CUSTOM_ID)
    return `${CUSTOM_KEY_PREFIX}${customSymbols.join(",")}`;
  const preset = presets.find((candidate) => candidate.id === universeId);
  if (preset === undefined) return PENDING_KEY;
  return preset.universe.kind === "sectors"
    ? SECTORS_PRESET.id
    : `${CUSTOM_KEY_PREFIX}${preset.universe.symbols.join(",")}`;
};

const selectionFromKey = (key: string): Selection => {
  if (key === PENDING_KEY) return { choice: null, pending: true };
  if (key === SECTORS_PRESET.id)
    return { choice: SECTORS_PRESET.universe, pending: false };
  const symbols = key
    .slice(CUSTOM_KEY_PREFIX.length)
    .split(",")
    .filter((symbol) => symbol !== "");
  return {
    choice: symbols.length === 0 ? null : { kind: "custom", symbols },
    pending: false,
  };
};

const selectClass =
  "h-11 w-full rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60";

const CustomListForm = ({
  onApply,
}: {
  readonly onApply: (symbols: readonly string[]) => void;
}) => {
  const [customText, setCustomText] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseTickerList(customText);
        if (!parsed.ok) return setCustomError(parsed.message);
        setCustomError(null);
        return onApply(parsed.symbols);
      }}
    >
      <label className="w-full max-w-md space-y-1 text-sm">
        <span className="block">Tickers (comma or space separated)</span>
        <Input
          aria-describedby={
            customError === null ? undefined : "sector-rotation-custom-error"
          }
          aria-invalid={customError !== null}
          onChange={(event) => setCustomText(event.target.value)}
          placeholder="AAPL, MSFT, XOM"
          value={customText}
        />
      </label>
      <Button type="submit" variant="secondary">
        Apply
      </Button>
      {customError === null ? null : (
        <p
          className="w-full text-destructive text-sm"
          id="sector-rotation-custom-error"
        >
          {customError}
        </p>
      )}
    </form>
  );
};

const MapSummary = ({ map }: { readonly map: SectorRotationMapOutput }) => (
  <>
    <p className="text-muted-foreground text-sm">
      {map.source === "stored" ? "Stored nightly" : "Computed now"}. As of{" "}
      {map.asOf} against {map.benchmark}. Generated {map.generatedAt}.
    </p>
    {map.errors.length === 0 ? null : (
      <div className="space-y-1 text-sm">
        <h2 className="font-medium">Symbols without a line</h2>
        <ul className="list-disc space-y-0.5 pl-5">
          {map.errors.map((error) => (
            <li key={error.symbol}>
              <span className="font-mono">{error.symbol}</span>: {error.reason}
            </li>
          ))}
        </ul>
      </div>
    )}
  </>
);

const COLUMNS = [
  "Ticker",
  "Name",
  "Ratio",
  "Momentum",
  "Quadrant",
  "In quadrant",
  "Since",
] as const;

const RotationTable = ({
  date,
  highlighted,
  onHighlight,
  rows,
  timeframe,
}: {
  readonly date: string;
  readonly highlighted: ChartHighlight;
  readonly onHighlight: (symbol: ChartHighlight) => void;
  readonly rows: readonly SectorRotationRow[];
  readonly timeframe: SectorRotationTimeframe;
}) => (
  <Table className="w-full text-sm">
    <TableCaption className="sr-only">
      Ratio, momentum and quadrant on {date}
    </TableCaption>
    <TableHeader>
      <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
        {COLUMNS.map((label) => (
          <TableHead className="text-muted-foreground" key={label} scope="col">
            {label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow
          className={
            row.symbol === highlighted
              ? "border-border border-b bg-muted"
              : "border-border border-b"
          }
          data-row={row.symbol}
          key={row.symbol}
          onMouseEnter={() => onHighlight(row.symbol)}
          onMouseLeave={() => onHighlight(null)}
        >
          <TableHead
            className="font-mono"
            onBlur={() => onHighlight(null)}
            onFocus={() => onHighlight(row.symbol)}
            scope="row"
          >
            <TickerLink
              className="inline-flex min-h-11 items-center font-semibold"
              symbol={row.symbol}
            />
          </TableHead>
          <TableCell className="whitespace-normal">{row.name ?? "–"}</TableCell>
          {row.point === null ? (
            <TableCell className="text-muted-foreground" colSpan={5}>
              No data on this date
            </TableCell>
          ) : (
            <>
              <TableCell className="tabular-nums">
                {row.point.ratio.toFixed(2)}
              </TableCell>
              <TableCell className="tabular-nums">
                {row.point.momentum.toFixed(2)}
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`size-2.5 rounded-full ${QUADRANT_CHIP[row.point.quadrant]}`}
                  />
                  {QUADRANT_LABELS[row.point.quadrant]}
                </span>
              </TableCell>
              <TableCell className="tabular-nums">
                {formatPeriods(row.periods, timeframe)}
              </TableCell>
              <TableCell className="font-mono">{row.since}</TableCell>
            </>
          )}
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const HeaderStatus = ({ state }: { readonly state: LoadState }) => {
  if (state.type === "loading")
    return <StatusBadge status="info">Loading</StatusBadge>;
  if (state.type === "error")
    return <StatusBadge status="destructive">Unavailable</StatusBadge>;
  if (state.type === "ready")
    return <StatusBadge status="neutral">As of {state.map.asOf}</StatusBadge>;
  return null;
};

const RotationControls = ({
  onTailLength,
  onTimeframe,
  onUniverse,
  pending,
  presets,
  tailLength,
  timeframe,
  universeId,
}: {
  readonly onTailLength: (length: number) => void;
  readonly onTimeframe: (timeframe: SectorRotationTimeframe) => void;
  readonly onUniverse: (id: string) => void;
  /** The linked preset is not known yet: the picker waits for the lists. */
  readonly pending: boolean;
  readonly presets: readonly SectorRotationUniversePreset[];
  readonly tailLength: number;
  readonly timeframe: SectorRotationTimeframe;
  readonly universeId: string;
}) => (
  <div className="flex flex-wrap items-end gap-3">
    <div className="space-y-1 text-sm">
      <span className="block" id="sector-rotation-timeframe">
        Timeframe
      </span>
      <div
        aria-labelledby="sector-rotation-timeframe"
        className="flex gap-1"
        role="tablist"
      >
        {SECTOR_ROTATION_TIMEFRAMES.map((key) => (
          <Button
            aria-selected={key === timeframe}
            key={key}
            onClick={() => onTimeframe(key)}
            role="tab"
            size="sm"
            variant={key === timeframe ? "primary" : "secondary"}
          >
            {TIMEFRAME_LABELS[key]}
          </Button>
        ))}
      </div>
    </div>
    <label className="w-full space-y-1 text-sm sm:w-48">
      <span className="block">Universe</span>
      <select
        aria-busy={pending}
        className={selectClass}
        disabled={pending}
        onChange={(event) => onUniverse(event.target.value)}
        value={universeId}
      >
        {pending ? <option value={universeId}>Loading lists…</option> : null}
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        <option value={CUSTOM_ID}>Custom list</option>
      </select>
    </label>
    <label className="w-full space-y-1 text-sm sm:w-32">
      <span className="block">Tail length</span>
      <select
        className={selectClass}
        onChange={(event) => onTailLength(Number(event.target.value))}
        value={tailLength}
      >
        {TAIL_LENGTHS.map((length) => (
          <option key={length} value={length}>
            {length} periods
          </option>
        ))}
      </select>
    </label>
  </div>
);

const LoadNotice = ({
  onRetry,
  state,
}: {
  readonly onRetry: () => void;
  readonly state: LoadState;
}) => (
  <>
    {state.type === "idle" ? (
      <p className="text-muted-foreground text-sm">
        Type up to 30 tickers and select Apply to draw them.
      </p>
    ) : null}
    {state.type === "loading" ? (
      <div aria-busy="true" className="space-y-2" role="status">
        <span className="text-muted-foreground text-sm">
          Loading sector rotation…
        </span>
        <Skeleton className="aspect-square w-full max-w-2xl" />
      </div>
    ) : null}
    {state.type === "error" ? (
      <div className="space-y-2" role="alert">
        <p className="text-sm">Sector rotation unavailable: {state.message}</p>
        <Button onClick={onRetry} size="sm" variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      </div>
    ) : null}
  </>
);

const QuadrantKpis = ({
  date,
  rows,
}: {
  readonly date: string;
  readonly rows: readonly SectorRotationRow[];
}) => {
  const counts = quadrantCounts(rows);
  return (
    <KpiRow label={`Symbols per quadrant on ${date}`}>
      {QUADRANT_ORDER.map((quadrant) => (
        <KpiCard
          data-quadrant={quadrant}
          icon={
            <span
              className={`block size-2.5 rounded-full ${QUADRANT_CHIP[quadrant]}`}
            />
          }
          key={quadrant}
          label={QUADRANT_LABELS[quadrant]}
          value={<span className="tabular-nums">{counts[quadrant]}</span>}
        />
      ))}
    </KpiRow>
  );
};

const RotationTablePanel = ({
  date,
  highlighted,
  map,
  onHighlight,
  rows,
}: {
  readonly date: string | null;
  readonly highlighted: ChartHighlight;
  readonly map: SectorRotationMapOutput | null;
  readonly onHighlight: (symbol: ChartHighlight) => void;
  readonly rows: readonly SectorRotationRow[];
}) =>
  map === null || date === null ? null : (
    <Panel
      description={`Values on ${date}`}
      flush
      headingId="sector-rotation-table"
      title="Sectors"
    >
      <TableScroll label="Sector rotation table" minWidth="40rem">
        <RotationTable
          date={date}
          highlighted={highlighted}
          onHighlight={onHighlight}
          rows={rows}
          timeframe={map.timeframe}
        />
      </TableScroll>
    </Panel>
  );

export interface SectorRotationWorkspaceProps {
  readonly gateway?: SectorRotationGateway;
  /** Settings read from the URL by the page. */
  readonly initial?: SectorRotationSettings | undefined;
}

/**
 * The universe presets, with the sector ETFs always included. Until the lists (watchlist,
 * baskets) arrive or fail only the sector ETFs are known, so a linked id stays pending. Once
 * they settle, a linked id missing from them (a deleted list, or the lists failed) is replaced
 * by the sector ETFs, and the URL effect then drops `universe` from the address bar.
 */
const usePresetLists = (
  gateway: SectorRotationGateway,
  setUniverseId: Dispatch<SetStateAction<string>>
): readonly SectorRotationUniversePreset[] => {
  const [presets, setPresets] = useState<
    readonly SectorRotationUniversePreset[]
  >([SECTORS_PRESET]);
  useEffect(() => {
    let live = true;
    const settle = (loaded: readonly SectorRotationUniversePreset[]) => {
      if (!live) return;
      const list = loaded.some((preset) => preset.id === SECTORS_PRESET.id)
        ? loaded
        : [SECTORS_PRESET, ...loaded];
      setPresets(list);
      setUniverseId((current) =>
        current === CUSTOM_ID || list.some((preset) => preset.id === current)
          ? current
          : SECTORS_PRESET.id
      );
    };
    gateway.universes().then(settle, () => settle([]));
    return () => {
      live = false;
    };
  }, [gateway, setUniverseId]);
  return presets;
};

export const SectorRotationWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: SectorRotationWorkspaceProps) => {
  const settings = initial ?? parseSectorRotationParams({});
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserSectorRotationGateway()
  );
  const [timeframe, setTimeframe] = useState<SectorRotationTimeframe>(
    settings.timeframe
  );
  const [universeId, setUniverseId] = useState(settings.universeId);
  const presets = usePresetLists(gateway, setUniverseId);
  const [customSymbols, setCustomSymbols] = useState<readonly string[]>([]);
  const [tailLength, setTailLength] = useState<number>(settings.tailLength);
  const [state, setState] = useState<LoadState>({ type: "loading" });
  const [dateIndex, setDateIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [hovered, setHovered] = useState<ChartHighlight>(null);
  const request = useRef(0);

  // Only `timeframe`, `universe` and `tail` are ours: other parameters (e.g. `?theme=`) are kept.
  useEffect(
    () =>
      writeQuery(
        sectorRotationQuery({ tailLength, timeframe, universeId }),
        URL_DEFAULTS
      ),
    [tailLength, timeframe, universeId]
  );

  const key = selectionKey(universeId, customSymbols, presets);
  const { choice: universe, pending } = useMemo(
    () => selectionFromKey(key),
    [key]
  );

  const load = useCallback(
    async (
      next: SectorRotationTimeframe,
      choice: SectorRotationUniverseChoice | null
    ) => {
      request.current += 1;
      const id = request.current;
      setPlaying(false);
      setDateIndex(null);
      setHovered(null);
      if (choice === null) return setState({ type: "idle" });
      setState({ type: "loading" });
      try {
        const map = await gateway.map({
          timeframe: next,
          universe:
            choice.kind === "sectors"
              ? { kind: "sectors" }
              : { kind: "custom", symbols: [...choice.symbols] },
        });
        if (id === request.current) setState({ map, type: "ready" });
        return;
      } catch (error) {
        if (id === request.current)
          setState({
            message: describeSectorRotationFailure(error),
            type: "error",
          });
        return;
      }
    },
    [gateway]
  );

  useEffect(() => {
    // A linked preset waits for the lists, so the sector map is never drawn in its place.
    if (!pending) void load(timeframe, universe);
    return;
  }, [load, timeframe, pending, universe]);

  const map = state.type === "ready" ? state.map : null;
  const dates = useMemo(
    () => (map === null ? [] : unionDates(map.series)),
    [map]
  );
  const lastIndex = dates.length - 1;
  const position = dateIndex ?? lastIndex;
  const date = dates[position] ?? null;
  const rows = useMemo(
    () => (map === null ? [] : rowsAt(map.series, date)),
    [map, date]
  );

  useEffect(() => {
    if (!playing) return;
    if (position >= lastIndex) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDateIndex(position + 1),
      PLAY_STEP_MS
    );
    return () => window.clearTimeout(timer);
  }, [playing, position, lastIndex]);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (position >= lastIndex) setDateIndex(0);
    return setPlaying(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={state.type === "loading" || universe === null}
            onClick={() => void load(timeframe, universe)}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Our own relative strength ratio and momentum, both centered on 100. Not the RRG® / JdK algorithm. Research only."
        status={<HeaderStatus state={state} />}
        title="Sector rotation"
      />

      {map === null || date === null ? null : (
        <QuadrantKpis date={date} rows={rows} />
      )}

      <Panel
        actions={
          <RotationControls
            onTailLength={setTailLength}
            onTimeframe={setTimeframe}
            onUniverse={setUniverseId}
            pending={pending}
            presets={presets}
            tailLength={tailLength}
            timeframe={timeframe}
            universeId={universeId}
          />
        }
        contentClassName="space-y-4"
        headingId="sector-rotation-map"
        title="Rotation map"
      >
        {universeId === CUSTOM_ID ? (
          <CustomListForm onApply={setCustomSymbols} />
        ) : null}

        <LoadNotice
          onRetry={() => void load(timeframe, universe)}
          state={state}
        />
        {map === null ? null : (
          <>
            <MapSummary map={map} />
            {date === null ? (
              <p className="text-muted-foreground text-sm">
                No points to draw for this list yet.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <Button
                    aria-label={playing ? "Pause" : "Play"}
                    onClick={togglePlay}
                    size="sm"
                    variant="secondary"
                  >
                    {playing ? (
                      <Pause aria-hidden="true" className="size-4" />
                    ) : (
                      <Play aria-hidden="true" className="size-4" />
                    )}
                    {playing ? "Pause" : "Play"}
                  </Button>
                  <label className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
                    <span className="block">
                      Date <span className="font-mono">{date}</span>
                    </span>
                    <input
                      aria-valuetext={date}
                      className="min-h-11 w-full accent-primary"
                      max={lastIndex}
                      min={0}
                      onChange={(event) => {
                        setPlaying(false);
                        setDateIndex(Number(event.target.value));
                      }}
                      type="range"
                      value={position}
                    />
                  </label>
                </div>
                <div className="mx-auto w-full min-w-0 max-w-2xl">
                  <SectorRotationChart
                    benchmark={map.benchmark}
                    date={date}
                    highlighted={hovered}
                    onHighlight={setHovered}
                    series={map.series}
                    tailLength={tailLength}
                    timeframe={map.timeframe}
                  />
                </div>
              </>
            )}
          </>
        )}
      </Panel>

      <RotationTablePanel
        date={date}
        highlighted={hovered}
        map={map}
        onHighlight={setHovered}
        rows={rows}
      />
    </div>
  );
};
