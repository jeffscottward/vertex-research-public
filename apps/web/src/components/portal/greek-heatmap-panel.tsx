// What: strike-by-expiry Greek exposure heatmap panel (optionsAnalytics.greekHeatmap)
// with GEX, VEX, Charm, DEX and Volume-GEX tabs plus King, Call/Put Wall, Spot and
// Gamma Flip marks. Self-contained loading/error state; works in dark and light modes
// across 375-1440 px. Research view only: no orders, no arming, no risk settings.
// Used by: apps/web/src/components/portal/options-analytics-panel.tsx (/charts & /stock Analytics).
"use client";

import type { GreekHeatmapMetric, GreekHeatmapOutput } from "@darkfactory/api";
import {
  Button,
  cn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpToLine,
  Crosshair,
  Crown,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  buildHeatmapGridView,
  cellBackground,
  formatDistancePct,
  formatExpiryShort,
  formatExposure,
  formatExposureFull,
  formatPrice,
  formatStrike,
  GREEK_HEATMAP_TABS,
  type HeatmapGridView,
  type HeatmapRowView,
  nextTabIndex,
} from "../../features/options-heatmap/view-model.ts";
import { describeMarketDataFailure } from "./market-data-client.ts";
import type { OptionsAnalyticsGateway } from "./options-analytics-client.ts";
import { ProviderFailureAlert } from "./provider-failure-alert.tsx";

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; data: GreekHeatmapOutput }>
  | Readonly<{ type: "error"; code: string; message: string }>;

const headCell = "px-2 py-1.5 font-normal text-muted-foreground";
const numCell = "px-2 py-1.5 text-right font-mono tabular-nums";
const badgeBase =
  "inline-flex items-center rounded-sm border px-1 py-0.5 font-medium font-sans text-[10px] leading-none";

const MarkCard = ({
  testId,
  label,
  icon,
  primary,
  secondary,
}: Readonly<{
  testId: string;
  label: string;
  icon: ReactNode;
  primary: string;
  secondary: string | null;
}>) => (
  <div
    className="min-w-0 rounded-md border border-border px-2.5 py-2 text-xs"
    data-heatmap-mark={testId}
  >
    <dt className="flex items-center gap-1 text-muted-foreground">
      {icon}
      <span className="truncate">{label}</span>
    </dt>
    <dd className="mt-0.5 font-medium font-mono tabular-nums">
      {primary}
      {secondary === null ? null : (
        <span className="ml-1.5 font-normal text-muted-foreground">
          {secondary}
        </span>
      )}
    </dd>
  </div>
);

const LevelDividerRow = ({
  colSpan,
  kind,
  label,
}: Readonly<{
  colSpan: number;
  kind: "spot" | "flip";
  label: string;
}>) => (
  <TableRow
    className={cn(
      "border-y",
      kind === "flip"
        ? "border-warning-border border-dashed bg-warning-subtle/60"
        : "border-primary/60 bg-muted/60"
    )}
    data-heatmap-divider={kind}
  >
    <TableCell
      className="px-2 py-1 font-medium font-mono text-xs"
      colSpan={colSpan}
    >
      <span className="sticky left-2 inline-flex items-center gap-1.5">
        {kind === "flip" ? (
          <ArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Crosshair aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{label}</span>
      </span>
    </TableCell>
  </TableRow>
);

const StrikeBadges = ({
  row,
  view,
}: Readonly<{ row: HeatmapRowView; view: HeatmapGridView }>) => (
  <span className="ml-1.5 inline-flex flex-wrap items-center gap-1">
    {row.isKing ? (
      <span
        className={cn(
          badgeBase,
          "gap-0.5 border-warning-border bg-warning-subtle"
        )}
        data-mark-badge="king"
      >
        <Crown aria-hidden="true" className="h-2.5 w-2.5" />
        King
      </span>
    ) : null}
    {row.isCallWall ? (
      <span
        className={cn(badgeBase, "border-border bg-muted")}
        data-mark-badge="call-wall"
      >
        {view.tab.positiveBadge}
      </span>
    ) : null}
    {row.isPutWall ? (
      <span
        className={cn(badgeBase, "border-border bg-muted")}
        data-mark-badge="put-wall"
      >
        {view.tab.negativeBadge}
      </span>
    ) : null}
    {row.spotPosition === "at" ? (
      <span
        className={cn(badgeBase, "border-primary/60 bg-background")}
        data-mark-badge="spot"
      >
        Spot
      </span>
    ) : null}
    {row.flipPosition === "at" ? (
      <span
        className={cn(badgeBase, "border-warning-border bg-warning-subtle")}
        data-mark-badge="flip"
      >
        Flip
      </span>
    ) : null}
  </span>
);

const HeatmapMarksBar = ({
  view,
  spot,
}: Readonly<{ view: HeatmapGridView; spot: number | null }>) => {
  const { marks } = view.metric;
  const kingPrimary =
    marks.kingStrike === null ? "no exposure" : formatPrice(marks.kingStrike);
  const kingSecondary =
    view.kingValue === null ? null : formatExposure(view.kingValue);
  const callPrimary =
    marks.callWall === null ? "no positive" : formatPrice(marks.callWall);
  const callSecondary =
    view.callWallValue === null ? null : formatExposure(view.callWallValue);
  const putPrimary =
    marks.putWall === null ? "no negative" : formatPrice(marks.putWall);
  const putSecondary =
    view.putWallValue === null ? null : formatExposure(view.putWallValue);
  const flipPrimary =
    view.flipLevel === null ? "no zero crossing" : formatPrice(view.flipLevel);
  const flipSecondary =
    view.flipLevel === null ? null : formatDistancePct(view.flipLevel, spot);

  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <MarkCard
        icon={<Crown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
        label="King node"
        primary={kingPrimary}
        secondary={kingSecondary}
        testId="king"
      />
      <MarkCard
        icon={
          <ArrowUpToLine aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        }
        label={view.tab.positiveWallLabel}
        primary={callPrimary}
        secondary={callSecondary}
        testId="call-wall"
      />
      <MarkCard
        icon={
          <ArrowDownToLine
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
          />
        }
        label={view.tab.negativeWallLabel}
        primary={putPrimary}
        secondary={putSecondary}
        testId="put-wall"
      />
      <MarkCard
        icon={
          <ArrowLeftRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        }
        label={view.flipLabel}
        primary={flipPrimary}
        secondary={flipSecondary}
        testId="flip"
      />
    </dl>
  );
};

const EmptyCellMark = () => (
  <>
    <span aria-hidden="true" className="text-muted-foreground/60">
      ·
    </span>
    <span className="sr-only">no exposure</span>
  </>
);

const HeatmapGrid = ({
  data,
  view,
}: Readonly<{ data: GreekHeatmapOutput; view: HeatmapGridView }>) => {
  const colSpan = data.expiries.length + 2;
  return (
    <div className="space-y-2">
      <TableScroll
        className="max-h-[32rem] overflow-y-auto rounded-md border border-border"
        label={`${view.tab.fullName} strike by expiry table`}
        minWidth="0px"
      >
        <Table
          className="w-full whitespace-nowrap text-xs"
          containerClassName="overflow-visible"
          data-greek-heatmap-table=""
          data-metric={view.tab.id}
        >
          <TableHeader className="sticky top-0 z-20 bg-background">
            <TableRow className="border-border border-b text-left">
              <TableHead
                className={`${headCell} sticky left-0 z-30 bg-background text-right`}
                scope="col"
              >
                Strike
              </TableHead>
              {data.expiries.map((exp) => (
                <TableHead
                  className={`${headCell} text-right`}
                  key={exp.expiry}
                  scope="col"
                  title={`${exp.expiry} (${exp.dte} DTE)`}
                >
                  <div>{formatExpiryShort(exp.expiry)}</div>
                  <div className="font-mono text-[10px]">{exp.dte}d</div>
                </TableHead>
              ))}
              <TableHead className={`${headCell} text-right`} scope="col">
                Net
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.rows.map((row) => (
              <Fragment key={row.strike}>
                <TableRow
                  className={cn(
                    "border-border border-b",
                    row.isKing && "ring-1 ring-warning-border ring-inset"
                  )}
                  data-king-row={row.isKing ? "" : undefined}
                  data-strike-row={row.strike}
                >
                  <TableHead
                    className="sticky left-0 z-10 h-auto bg-background px-2 py-1.5 text-right font-medium font-mono tabular-nums"
                    scope="row"
                  >
                    <span>{formatStrike(row.strike)}</span>
                    <StrikeBadges row={row} view={view} />
                  </TableHead>
                  {data.expiries.map((exp, colIndex) => {
                    const value = row.values[colIndex] ?? null;
                    return (
                      <TableCell
                        className={numCell}
                        key={exp.expiry}
                        style={{
                          backgroundColor: cellBackground(
                            value,
                            view.maxAbsCell
                          ),
                        }}
                        title={
                          value === null
                            ? `Strike ${formatStrike(row.strike)} · ${exp.expiry} · no OI, volume or IV`
                            : `Strike ${formatStrike(row.strike)} · ${exp.expiry} · ${formatExposureFull(value)}`
                        }
                      >
                        {value === null ? (
                          <EmptyCellMark />
                        ) : (
                          formatExposure(value)
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className={`${numCell} min-w-24`}>
                    <div className="flex flex-col items-end gap-0.5">
                      <span>
                        {row.total === null ? (
                          <span className="text-muted-foreground">
                            no exposure
                          </span>
                        ) : (
                          formatExposure(row.total)
                        )}
                      </span>
                      <div
                        aria-hidden="true"
                        className="h-1.5 w-16 overflow-hidden rounded-sm bg-muted"
                      >
                        <div
                          className={cn(
                            "h-full rounded-sm",
                            (row.total ?? 0) < 0
                              ? "bg-destructive/75"
                              : "bg-success/75"
                          )}
                          style={{ width: `${row.barWidthPct}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
                {row.dividers.map((divider) => (
                  <LevelDividerRow
                    colSpan={colSpan}
                    key={divider.kind}
                    kind={divider.kind}
                    label={divider.label}
                  />
                ))}
              </Fragment>
            ))}
            <TableRow
              className="border-border border-t-2 bg-muted/40 font-medium"
              data-heatmap-footer=""
            >
              <TableHead
                className="sticky left-0 z-10 h-auto bg-muted px-2 py-1.5 text-right font-medium text-muted-foreground"
                scope="row"
              >
                Expiry net
              </TableHead>
              {data.expiries.map((exp, colIndex) => {
                const total = view.metric.expiryTotals[colIndex] ?? null;
                return (
                  <TableCell className={numCell} key={exp.expiry}>
                    {total === null ? <EmptyCellMark /> : formatExposure(total)}
                  </TableCell>
                );
              })}
              <TableCell className={numCell} data-heatmap-grand-total="">
                {view.metric.grandTotal === null
                  ? "no exposure"
                  : formatExposure(view.metric.grandTotal)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableScroll>
      <div
        className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs"
        data-heatmap-legend=""
      >
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm border border-border"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--color-destructive) 36%, transparent)",
              }}
            />
            Negative (−)
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm border border-border bg-background"
            />
            Zero / none
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm border border-border"
              style={{
                backgroundColor:
                  "color-mix(in oklab, var(--color-success) 36%, transparent)",
              }}
            />
            Positive (+)
          </span>
        </span>
        <span>
          Net total (50–150% spot):{" "}
          <strong className="font-mono text-foreground">
            {view.metric.grandTotal === null
              ? "no exposure"
              : formatExposure(view.metric.grandTotal)}
          </strong>
        </span>
      </div>
    </div>
  );
};

export interface GreekHeatmapPanelProps {
  readonly gateway: OptionsAnalyticsGateway;
  /** The tab shown first. The parent passes the last selected tab, because it mounts this panel again after a reload. */
  readonly initialTab?: GreekHeatmapMetric;
  readonly onTabChange?: (tab: GreekHeatmapMetric) => void;
  readonly symbol: string;
}

export const GreekHeatmapPanel = ({
  symbol,
  gateway,
  initialTab = "gex",
  onTabChange,
}: GreekHeatmapPanelProps) => {
  const headingId = useId();
  const tabBaseId = useId();
  const [activeTab, setActiveTabState] =
    useState<GreekHeatmapMetric>(initialTab);
  const [state, setState] = useState<State>({ type: "loading" });
  const generation = useRef(0);
  const setActiveTab = (tab: GreekHeatmapMetric) => {
    setActiveTabState(tab);
    onTabChange?.(tab);
  };

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ type: "loading" });
    try {
      const data = await gateway.greekHeatmap({ symbol });
      if (mine === generation.current) setState({ data, type: "ready" });
    } catch (error) {
      if (mine === generation.current)
        setState({ type: "error", ...describeMarketDataFailure(error) });
    }
  }, [gateway, symbol]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const onTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = GREEK_HEATMAP_TABS.findIndex((tab) => tab.id === activeTab);
    const next = nextTabIndex(current, event.key, GREEK_HEATMAP_TABS.length);
    if (next === null) return;
    event.preventDefault();
    const target = GREEK_HEATMAP_TABS[
      next
    ] as (typeof GREEK_HEATMAP_TABS)[number];
    setActiveTab(target.id);
    (event.currentTarget.children[next] as HTMLElement).focus();
  };

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-md border border-border p-4"
      data-greek-heatmap=""
      data-symbol={symbol}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-medium text-sm" id={headingId}>
            Greek exposure heatmap (strike × expiry)
          </h3>
          {state.type === "ready" && state.data.spot !== null ? (
            <p className="text-muted-foreground text-xs">
              Spot {formatPrice(state.data.spot)} · {state.data.expiries.length}{" "}
              {state.data.expiries.length === 1 ? "expiry" : "expiries"} ·
              QuantData chain + per-expiry OI &amp; volume
            </p>
          ) : null}
        </div>
        <div
          aria-label="Greek exposure metric"
          className="inline-flex flex-wrap gap-1 rounded-md border border-border bg-muted/50 p-1"
          onKeyDown={onTabListKeyDown}
          role="tablist"
        >
          {GREEK_HEATMAP_TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                aria-controls={
                  state.type === "ready" ? `${tabBaseId}-panel` : undefined
                }
                aria-selected={selected}
                className={cn(
                  "min-h-11 rounded-sm px-3 py-1 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
                data-heatmap-tab={tab.id}
                id={`${tabBaseId}-tab-${tab.id}`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {state.type === "loading" ? (
        <p
          className="text-muted-foreground text-xs"
          data-heatmap-loading=""
          role="status"
        >
          Loading Greek exposure heatmap for {symbol}
        </p>
      ) : null}

      {state.type === "error" ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-xs"
          data-heatmap-error={state.code}
          role="alert"
        >
          <p>{state.message}</p>
          <Button
            className="min-h-11"
            onClick={() => void load()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {state.type === "ready" ? (
        <div
          aria-labelledby={`${tabBaseId}-tab-${activeTab}`}
          className="space-y-3"
          id={`${tabBaseId}-panel`}
          role="tabpanel"
        >
          {state.data.rateLimited ? (
            <p
              className="rounded-md border border-warning-border bg-warning-subtle px-3 py-2 text-xs"
              data-heatmap-rate-limited=""
              role="status"
            >
              QuantData rate limit active
              {state.data.retryAfterSeconds === null
                ? "."
                : ` · retry in ${state.data.retryAfterSeconds} s.`}
            </p>
          ) : null}

          {(() => {
            const view = buildHeatmapGridView(state.data, activeTab);
            return (
              <>
                <p
                  className="text-muted-foreground text-xs"
                  data-heatmap-unit=""
                >
                  {view.tab.unitText}
                </p>
                {view.metric.status === "ok" ? (
                  <>
                    <HeatmapMarksBar spot={state.data.spot} view={view} />
                    <HeatmapGrid data={state.data} view={view} />
                  </>
                ) : view.metric.status === "failed" ? (
                  <div data-heatmap-metric-status="failed">
                    <ProviderFailureAlert
                      message={
                        view.metric.message ??
                        "QuantData did not answer for this metric."
                      }
                    />
                  </div>
                ) : (
                  <p
                    className="rounded-md border border-border p-3 text-muted-foreground text-xs"
                    data-heatmap-metric-status="empty"
                    role="status"
                  >
                    {view.metric.message ??
                      "No Greek exposure rows returned for this metric."}
                  </p>
                )}
              </>
            );
          })()}

          <ul className="space-y-0.5 text-muted-foreground text-xs">
            {state.data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};
