"use client";

// What: the five order flow views on /charts (time & sales, order book, footprint, delta / CVD,
// TPO) as pure renderers of already-fetched IBKR data. Plain tables, CSS bars and SVG; no chart
// library. Read-only research display.
// Used by: components/portal/order-flow-panel.tsx.
import type {
  MarketBarsOutput,
  MarketDepthOutput,
  MarketTicksOutput,
} from "@darkfactory/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { useId, useState } from "react";

import type { DeltaSeries } from "../../features/order-flow/delta.ts";
import {
  buildDepthLadder,
  depthSizeNote,
  type LadderRow,
} from "../../features/order-flow/depth-ladder.ts";
import type { Footprint } from "../../features/order-flow/footprint.ts";
import {
  decimalsOf,
  formatBucketSeconds,
  groupPrice,
} from "../../features/order-flow/price-grid.ts";
import {
  formatClock,
  type TickCoverage,
  type TimeAndSalesRow,
  timeZoneLabel,
} from "../../features/order-flow/time-and-sales.ts";
import type { TpoProfile, TpoSession } from "../../features/order-flow/tpo.ts";
import {
  describeSigning,
  SIGNING_METHOD_LABELS,
  type SigningCounts,
  type TradeSide,
} from "../../features/order-flow/trade-signing.ts";

const DASH = "—";
const headCell = "py-1 pr-3 font-normal text-muted-foreground";
const numHead = `${headCell} text-right`;
const numCell = "py-1 pr-3 text-right font-mono tabular-nums";
const scrollBox = "max-h-96 overflow-auto rounded-md border border-border";
const BUY_FILL = "var(--color-success)";
const SELL_FILL = "var(--color-destructive)";

/** Price text at the window's tick decimals (at least 2), widened for a sub-penny print. */
export const formatPrice = (value: number | null, digits: number): string =>
  value === null
    ? DASH
    : value.toFixed(Math.min(Math.max(digits, decimalsOf(value)), 6));

const formatSize = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const formatSigned = (value: number): string =>
  value > 0
    ? `+${formatSize(value)}`
    : value < 0
      ? `−${formatSize(-value)}`
      : "0";

/** "2026-10-30 20:00:00 UTC" from an ISO time. */
const formatUtc = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

const SIDE_LABEL: Readonly<Record<TradeSide, string>> = Object.freeze({
  buy: "Buy",
  sell: "Sell",
  unknown: DASH,
});
const SIDE_CLASS: Readonly<Record<TradeSide, string>> = Object.freeze({
  buy: "rounded-sm bg-success-subtle px-1 text-success-foreground",
  sell: "rounded-sm bg-destructive-subtle px-1 text-destructive",
  unknown: "text-muted-foreground",
});

type Cache = MarketTicksOutput["cache"];

const cacheText = (cache: Cache): string =>
  `${cache.hit ? `cached ${cache.ageSeconds} s ago` : "fresh from IBKR"}${cache.stale ? " · stale" : ""}`;

/** Source, fetch time and cache line shared by every view. */
const SourceLine = ({
  fetchedAt,
  cache,
  extra,
}: {
  readonly fetchedAt: string;
  readonly cache: Cache;
  readonly extra?: string | undefined;
}) => (
  <p className="text-muted-foreground text-xs" data-source-line="">
    IBKR Gateway · fetched {formatUtc(fetchedAt)} · {cacheText(cache)}
    {cache.stale ? (
      <span
        className="ml-1 rounded-sm bg-warning-subtle px-1 text-warning-foreground"
        data-cache-stale=""
      >
        stale cache
      </span>
    ) : null}
    {extra === undefined ? null : ` · ${extra}`}
  </p>
);

export const TicksSummary = ({
  data,
  coverage,
  counts,
  timeZone,
  windowNote,
}: {
  readonly data: MarketTicksOutput;
  readonly coverage: TickCoverage;
  readonly counts: SigningCounts;
  readonly timeZone: string;
  readonly windowNote?: boolean;
}) => {
  const asOf =
    data.asOf === null
      ? null
      : `as of ${formatClock(Date.parse(data.asOf) / 1000, timeZone)} ${timeZoneLabel(timeZone)}`;
  return (
    <div className="space-y-1">
      <SourceLine
        cache={data.cache}
        extra={asOf ?? undefined}
        fetchedAt={data.fetchedAt}
      />
      <p className="text-xs" data-tick-coverage="">
        {coverage.label}
        {data.request.useRTH
          ? " · regular hours only"
          : " · incl. extended hours"}
        {data.quotes.length === 0
          ? " · no bid/ask quotes returned"
          : ` · ${data.quotes.length} quotes`}
      </p>
      <p className="text-muted-foreground text-xs" data-signing-counts="">
        Signed by: {describeSigning(counts)} ({counts.buy} buy · {counts.sell}{" "}
        sell{counts.unknown > 0 ? ` · ${counts.unknown} unsigned` : ""})
      </p>
      {windowNote === true ? (
        <p className="text-muted-foreground text-xs" data-window-note="">
          Covers only the fetched tick window ({coverage.label}), not the whole
          session.
        </p>
      ) : null}
    </div>
  );
};

export const TimeAndSalesTable = ({
  rows,
  digits,
  timeZone,
}: {
  readonly rows: readonly TimeAndSalesRow[];
  readonly digits: number;
  readonly timeZone: string;
}) => {
  if (rows.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        IBKR returned no trade prints for this window.
      </p>
    );
  return (
    <div className={scrollBox}>
      <Table className="w-full whitespace-nowrap text-xs" data-time-sales="">
        <TableHeader className="sticky top-0 bg-card">
          <TableRow className="border-border border-b text-left">
            <TableHead className={`${headCell} pl-2`} scope="col">
              Time ({timeZoneLabel(timeZone)})
            </TableHead>
            <TableHead className={numHead} scope="col">
              Price
            </TableHead>
            <TableHead className={numHead} scope="col">
              Size
            </TableHead>
            <TableHead className={headCell} scope="col">
              Side
            </TableHead>
            <TableHead className={headCell} scope="col">
              Rule
            </TableHead>
            <TableHead className={numHead} scope="col">
              Bid
            </TableHead>
            <TableHead className={numHead} scope="col">
              Ask
            </TableHead>
            <TableHead className={headCell} scope="col">
              Venue
            </TableHead>
            <TableHead className={headCell} scope="col">
              Cond.
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              className="border-border border-b"
              data-side={row.side}
              key={row.key}
            >
              <TableCell className="py-1 pr-3 pl-2 font-mono">
                {row.time}
              </TableCell>
              <TableCell className={numCell}>
                {formatPrice(row.price, digits)}
              </TableCell>
              <TableCell className={numCell}>{formatSize(row.size)}</TableCell>
              <TableCell className="py-1 pr-3">
                <span className={SIDE_CLASS[row.side]}>
                  {SIDE_LABEL[row.side]}
                </span>
              </TableCell>
              <TableCell className="py-1 pr-3 text-muted-foreground">
                {SIGNING_METHOD_LABELS[row.method]}
              </TableCell>
              <TableCell className={numCell}>
                {formatPrice(row.bid, digits)}
              </TableCell>
              <TableCell className={numCell}>
                {formatPrice(row.ask, digits)}
              </TableCell>
              <TableCell className="py-1 pr-3 font-mono">
                {row.venue ?? DASH}
              </TableCell>
              <TableCell className="py-1 pr-3 font-mono">
                {row.conditions ?? DASH}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

const SizeBar = ({
  size,
  max,
  side,
}: {
  readonly size: number;
  readonly max: number;
  readonly side: "bid" | "ask";
}) => (
  <div className="relative min-w-20">
    <div
      aria-hidden="true"
      className={`absolute inset-y-0 rounded-sm ${side === "bid" ? "right-0 bg-success/30" : "left-0 bg-destructive/30"}`}
      style={{ width: `${max > 0 ? (size / max) * 100 : 0}%` }}
    />
    <span
      className={`relative block px-1 font-mono tabular-nums ${side === "bid" ? "text-right" : "text-left"}`}
    >
      {formatSize(size)}
    </span>
  </div>
);

const LadderRowView = ({
  row,
  digits,
  maxSize,
  smart,
  divider,
}: {
  readonly row: LadderRow;
  readonly digits: number;
  readonly maxSize: number;
  readonly smart: boolean;
  /** First bid under the asks: a heavier rule marks the spread. */
  readonly divider: boolean;
}) => {
  const bid = row.side === "bid";
  return (
    <TableRow
      className={`border-border border-b ${divider ? "border-t-2 border-t-border" : ""}`}
      data-ladder-side={row.side}
    >
      <TableCell className={`${numCell} pl-2`}>
        {bid ? formatSize(row.cumulative) : ""}
      </TableCell>
      <TableCell className="py-1 pr-2">
        {bid ? <SizeBar max={maxSize} side="bid" size={row.size} /> : null}
      </TableCell>
      <TableCell
        className={`py-1 pr-3 text-center font-mono tabular-nums ${bid ? "text-success-foreground" : "text-destructive"}`}
      >
        {formatPrice(row.price, digits)}
      </TableCell>
      <TableCell className="py-1 pr-2">
        {bid ? null : <SizeBar max={maxSize} side="ask" size={row.size} />}
      </TableCell>
      <TableCell className={numCell}>
        {bid ? "" : formatSize(row.cumulative)}
      </TableCell>
      {smart ? (
        <TableCell className="py-1 pr-3 font-mono">
          {row.venue ?? DASH}
        </TableCell>
      ) : null}
    </TableRow>
  );
};

const VenueNotice = ({
  venues,
}: {
  readonly venues: NonNullable<MarketDepthOutput["venues"]>;
}) => (
  <div
    className="space-y-1 rounded-md border border-border p-3 text-xs"
    data-venue-notice=""
    role="note"
  >
    <p className="font-medium">IBKR venue notice</p>
    <p>
      Depth from: {venues.depth.length === 0 ? DASH : venues.depth.join(", ")}
    </p>
    {venues.top.length === 0 ? null : (
      <p>Top of book only: {venues.top.join(", ")}</p>
    )}
    {venues.missing.length === 0 ? null : (
      <p data-venues-missing="">
        Missing market data permission (not in this book):{" "}
        {venues.missing.join(", ")}
      </p>
    )}
  </div>
);

export const OrderBookView = ({
  data,
}: {
  readonly data: MarketDepthOutput;
}) => {
  const ladder = buildDepthLadder(data);
  const smart = data.request.smartDepth;
  const prices = ladder.rows.map((row) => row.price);
  // IBKR's minTick fixes the price decimals; without it, the decimals the prices show
  const digits =
    data.minTick === null
      ? Math.max(2, ...prices.map((price) => decimalsOf(price)))
      : Math.max(2, decimalsOf(data.minTick));
  const unit = data.request.secType === "STK" ? "shares" : "contracts";
  let spreadText = DASH;
  if (ladder.bookState === "crossed") spreadText = "Crossed book";
  else if (ladder.bookState === "locked") spreadText = "Locked book";
  else if (ladder.spread !== null)
    spreadText = `spread ${ladder.spread.toFixed(digits)}`;
  return (
    <div className="space-y-3">
      <SourceLine
        cache={data.cache}
        extra={`${smart ? "SMART depth (aggregated across venues)" : `${data.request.exchange} book`} · ${data.request.rows} rows requested · ${data.updates} depth updates folded in`}
        fetchedAt={data.fetchedAt}
      />
      <p className="text-muted-foreground text-xs" data-size-multiplier="">
        {depthSizeNote(ladder.sizeMultiplier, unit)}
      </p>
      {data.venues === null ? null : <VenueNotice venues={data.venues} />}
      {ladder.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          IBKR returned an empty book for this snapshot.
        </p>
      ) : (
        <>
          <p className="text-xs" data-book-summary="">
            Best bid {formatPrice(ladder.bestBid, digits)} · best ask{" "}
            {formatPrice(ladder.bestAsk, digits)} ·{" "}
            <span data-book-state={ladder.bookState ?? ""}>{spreadText}</span> ·
            bid {formatSize(ladder.totalBid)} / ask{" "}
            {formatSize(ladder.totalAsk)} {unit} shown
          </p>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table
              className="w-full whitespace-nowrap text-xs"
              data-depth-ladder=""
            >
              <TableHeader>
                <TableRow className="border-border border-b text-left">
                  <TableHead className={`${numHead} pl-2`} scope="col">
                    Bid cum.
                  </TableHead>
                  <TableHead className={numHead} scope="col">
                    Bid size
                  </TableHead>
                  <TableHead className={`${headCell} text-center`} scope="col">
                    Price
                  </TableHead>
                  <TableHead className={headCell} scope="col">
                    Ask size
                  </TableHead>
                  <TableHead className={numHead} scope="col">
                    Ask cum.
                  </TableHead>
                  {smart ? (
                    <TableHead className={headCell} scope="col">
                      Venue
                    </TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ladder.rows.map((row) => (
                  <LadderRowView
                    digits={digits}
                    divider={
                      row.side === "bid" &&
                      row.depth === 0 &&
                      ladder.bestAsk !== null
                    }
                    key={row.key}
                    maxSize={ladder.maxSize}
                    row={row}
                    smart={smart}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
};

/** Background for a footprint cell: buy- or sell-tinted by its delta, stronger with volume. */
const cellTint = (delta: number, volume: number, max: number): string => {
  if (volume <= 0 || max <= 0) return "transparent";
  const strength = Math.round(12 + (volume / max) * 48);
  const color = delta >= 0 ? BUY_FILL : SELL_FILL;
  return `color-mix(in oklab, ${color} ${strength}%, transparent)`;
};

export const FootprintGrid = ({
  footprint,
  digits,
  timeZone,
}: {
  readonly footprint: Footprint;
  readonly digits: number;
  readonly timeZone: string;
}) => {
  const cellAt = footprint.buckets.map(
    (bucket) => new Map(bucket.cells.map((cell) => [cell.price, cell]))
  );
  return (
    <div className={scrollBox}>
      <table
        className="border-separate border-spacing-0 whitespace-nowrap text-[11px]"
        data-footprint=""
      >
        <caption className="sr-only">
          Footprint: sell volume × buy volume per price level and{" "}
          {formatBucketSeconds(footprint.bucketSeconds)} bucket
        </caption>
        <thead>
          <tr>
            <th
              className="sticky top-0 left-0 z-20 bg-card px-2 py-1 text-left font-normal text-muted-foreground"
              scope="col"
            >
              Price
            </th>
            {footprint.buckets.map((bucket) => (
              <th
                className="sticky top-0 z-10 bg-card px-2 py-1 text-center font-mono font-normal text-muted-foreground"
                key={bucket.start}
                scope="col"
              >
                {formatClock(bucket.start, timeZone)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {footprint.levels.map((price) => (
            <tr key={price}>
              <th
                className="sticky left-0 z-10 border-border border-t bg-card px-2 py-0.5 text-left font-mono font-normal tabular-nums"
                scope="row"
              >
                {formatPrice(price, digits)}
              </th>
              {footprint.buckets.map((bucket, index) => {
                const cell = cellAt[index]?.get(price);
                const poc = cell !== undefined && bucket.poc === price;
                return (
                  <td
                    className={`border-border border-t px-2 py-0.5 text-center font-mono tabular-nums ${poc ? "outline outline-1 outline-foreground -outline-offset-1" : ""}`}
                    data-poc={poc ? "" : undefined}
                    key={bucket.start}
                    style={{
                      backgroundColor:
                        cell === undefined
                          ? undefined
                          : cellTint(
                              cell.delta,
                              cell.volume,
                              footprint.maxCellVolume
                            ),
                    }}
                    title={
                      cell === undefined
                        ? undefined
                        : `${formatPrice(price, digits)}: sell ${formatSize(cell.sell)}, buy ${formatSize(cell.buy)}${cell.unsigned > 0 ? `, unsigned ${formatSize(cell.unsigned)}` : ""}`
                    }
                  >
                    {cell === undefined
                      ? ""
                      : `${formatSize(cell.sell)}×${formatSize(cell.buy)}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          {(
            [
              ["Volume", (bucket) => formatSize(bucket.volume)],
              ["Delta", (bucket) => formatSigned(bucket.delta)],
              [
                "POC",
                (bucket) =>
                  bucket.poc === null ? DASH : formatPrice(bucket.poc, digits),
              ],
            ] as const satisfies readonly (readonly [
              string,
              (bucket: Footprint["buckets"][number]) => string,
            ])[]
          ).map(([label, value]) => (
            <tr data-footprint-total={label} key={label}>
              <th
                className="sticky left-0 z-10 border-border border-t-2 bg-card px-2 py-1 text-left font-normal text-muted-foreground"
                scope="row"
              >
                {label}
              </th>
              {footprint.buckets.map((bucket) => (
                <td
                  className={`border-border border-t-2 px-2 py-1 text-center font-mono tabular-nums ${label === "Delta" ? (bucket.delta > 0 ? "text-success-foreground" : bucket.delta < 0 ? "text-destructive" : "") : ""}`}
                  key={bucket.start}
                >
                  {value(bucket)}
                </td>
              ))}
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
};

const CHART_HEIGHT = 120;
const BAR_WIDTH = 24;

export const DeltaChart = ({
  series,
  timeZone,
}: {
  readonly series: DeltaSeries;
  readonly timeZone: string;
}) => {
  const width = Math.max(series.buckets.length * BAR_WIDTH, BAR_WIDTH);
  const half = CHART_HEIGHT / 2;
  const scale = series.maxAbsDelta > 0 ? (half - 4) / series.maxAbsDelta : 0;
  const span = series.maxCvd - series.minCvd;
  const cvdY = (cvd: number) =>
    span === 0 ? half : 4 + ((series.maxCvd - cvd) / span) * (CHART_HEIGHT - 8);
  const linePoints = series.buckets
    .map(
      (bucket, index) =>
        `${index * BAR_WIDTH + BAR_WIDTH / 2},${cvdY(bucket.cvd).toFixed(1)}`
    )
    .join(" ");
  const zone = timeZoneLabel(timeZone);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <div
          className="space-y-1"
          style={{ minWidth: `${Math.min(width, 640)}px` }}
        >
          <p className="text-muted-foreground text-xs">
            Delta per {formatBucketSeconds(series.bucketSeconds)} (buy − sell)
          </p>
          <svg
            aria-label={`Delta per ${formatBucketSeconds(series.bucketSeconds)} bucket, largest ${formatSize(series.maxAbsDelta)}`}
            className="h-28 w-full"
            data-delta-chart=""
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          >
            <line
              stroke="currentColor"
              strokeOpacity={0.3}
              x1={0}
              x2={width}
              y1={half}
              y2={half}
            />
            {series.buckets.map((bucket, index) => {
              const height = Math.abs(bucket.delta) * scale;
              return (
                <rect
                  fill={bucket.delta >= 0 ? BUY_FILL : SELL_FILL}
                  height={height}
                  key={bucket.start}
                  width={BAR_WIDTH - 6}
                  x={index * BAR_WIDTH + 3}
                  y={bucket.delta >= 0 ? half - height : half}
                />
              );
            })}
          </svg>
          <p className="text-muted-foreground text-xs">
            Cumulative volume delta (from 0 at the first fetched print)
          </p>
          <svg
            aria-label={`Cumulative volume delta ending at ${formatSigned(series.cvd)}`}
            className="h-28 w-full text-primary"
            data-cvd-chart=""
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          >
            <line
              stroke="currentColor"
              strokeDasharray="4 4"
              strokeOpacity={0.3}
              x1={0}
              x2={width}
              y1={cvdY(0)}
              y2={cvdY(0)}
            />
            <polyline
              fill="none"
              points={linePoints}
              stroke="currentColor"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      </div>
      <p className="text-xs" data-cvd-summary="">
        CVD {formatSigned(series.cvd)} · low {formatSigned(series.minCvd)} ·
        high {formatSigned(series.maxCvd)}
      </p>
      <div className={scrollBox}>
        <Table className="w-full whitespace-nowrap text-xs" data-delta-table="">
          <TableHeader className="sticky top-0 bg-card">
            <TableRow className="border-border border-b text-left">
              <TableHead className={`${headCell} pl-2`} scope="col">
                Bucket ({zone})
              </TableHead>
              <TableHead className={numHead} scope="col">
                Buy
              </TableHead>
              <TableHead className={numHead} scope="col">
                Sell
              </TableHead>
              <TableHead className={numHead} scope="col">
                Delta
              </TableHead>
              <TableHead className={numHead} scope="col">
                CVD
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {series.buckets.map((bucket) => (
              <TableRow className="border-border border-b" key={bucket.start}>
                <TableCell className="py-1 pr-3 pl-2 font-mono">
                  {formatClock(bucket.start, timeZone)}
                </TableCell>
                <TableCell className={numCell}>
                  {formatSize(bucket.buy)}
                </TableCell>
                <TableCell className={numCell}>
                  {formatSize(bucket.sell)}
                </TableCell>
                <TableCell
                  className={`${numCell} ${bucket.delta > 0 ? "text-success-foreground" : bucket.delta < 0 ? "text-destructive" : ""}`}
                >
                  {formatSigned(bucket.delta)}
                </TableCell>
                <TableCell className={numCell}>
                  {formatSigned(bucket.cvd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

const levelMarks = (session: TpoSession, price: number): string[] => {
  const marks: string[] = [];
  if (price === session.poc) marks.push("POC");
  if (price === session.valueAreaHigh) marks.push("VAH");
  if (price === session.valueAreaLow) marks.push("VAL");
  return marks;
};

export const TpoView = ({
  data,
  profile,
  timeZone,
}: {
  readonly data: MarketBarsOutput;
  readonly profile: TpoProfile | null;
  readonly timeZone: string;
}) => {
  const selectId = useId();
  const sessions = profile?.sessions ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const session =
    sessions.find((item) => item.date === chosen) ?? sessions.at(-1) ?? null;
  const step = profile?.priceStep ?? 0.01;
  const digits = Math.max(2, decimalsOf(step));
  const zone = timeZoneLabel(timeZone);
  return (
    <div className="space-y-3">
      <SourceLine
        cache={data.cache}
        extra={`${data.count} ${data.request.barSize} bars · ${data.request.duration} · ${data.request.useRTH ? "regular hours" : "all hours"}`}
        fetchedAt={data.fetchedAt}
      />
      {session === null || profile === null ? (
        <p className="text-muted-foreground text-sm">
          IBKR returned no 30-minute bars for a profile.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 text-xs">
              <label className="block text-muted-foreground" htmlFor={selectId}>
                Session
              </label>
              <select
                className="h-11 rounded-md border border-border bg-background px-2 text-sm"
                id={selectId}
                onChange={(event) => setChosen(event.target.value)}
                value={session.date}
              >
                {[...sessions].reverse().map((item) => (
                  <option key={item.date} value={item.date}>
                    {item.date}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-muted-foreground text-xs">
              Row step {formatPrice(step, digits)} · {session.periods.length}{" "}
              periods · {session.totalTpos} TPOs
            </p>
          </div>
          <dl
            className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4"
            data-tpo-summary=""
          >
            {(
              [
                ["POC", formatPrice(session.poc, digits)],
                [
                  "Value area (70%)",
                  `${formatPrice(session.valueAreaLow, digits)} – ${formatPrice(session.valueAreaHigh, digits)}`,
                ],
                [
                  `Initial balance (${session.initialBalance.periods === 1 ? "A" : "A+B"})`,
                  `${formatPrice(session.initialBalance.low, digits)} – ${formatPrice(session.initialBalance.high, digits)}`,
                ],
                [
                  "Single prints",
                  session.singlePrints.length === 0
                    ? "none"
                    : `${session.singlePrints.length} rows`,
                ],
              ] as const
            ).map(([term, value]) => (
              <div key={term}>
                <dt className="text-muted-foreground">{term}</dt>
                <dd className="font-mono tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <div className={scrollBox}>
            <Table
              className="w-full whitespace-nowrap text-xs"
              data-tpo-profile={session.date}
            >
              <TableHeader className="sticky top-0 bg-card">
                <TableRow className="border-border border-b text-left">
                  <TableHead className={`${numHead} pl-2`} scope="col">
                    Price
                  </TableHead>
                  <TableHead className={headCell} scope="col">
                    TPOs
                  </TableHead>
                  <TableHead className={headCell} scope="col">
                    <span className="sr-only">Marks</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {session.levels.map((level) => {
                  const inValue =
                    session.valueAreaLow !== null &&
                    session.valueAreaHigh !== null &&
                    level.price >= session.valueAreaLow &&
                    level.price <= session.valueAreaHigh;
                  const inIb =
                    session.initialBalance !== null &&
                    level.price >=
                      groupPrice(session.initialBalance.low, step) &&
                    level.price <= session.initialBalance.high;
                  const marks = levelMarks(session, level.price);
                  if (level.count === 1) marks.push("single");
                  return (
                    <TableRow
                      className={`border-border border-b ${inValue ? "bg-primary/10" : ""}`}
                      data-tpo-level={level.price}
                      data-value-area={inValue ? "" : undefined}
                      key={level.price}
                    >
                      <TableCell
                        className={`${numCell} pl-2 ${inIb ? "border-l-2 border-l-primary" : ""} ${level.price === session.poc ? "font-semibold" : ""}`}
                      >
                        {formatPrice(level.price, digits)}
                      </TableCell>
                      <TableCell className="py-1 pr-3 font-mono tracking-wider">
                        {level.letters}
                      </TableCell>
                      <TableCell className="py-1 pr-3 text-muted-foreground">
                        {marks.join(" · ")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs" data-tpo-letters="">
            Letters ({zone}):{" "}
            {session.periods
              .map(
                (period) =>
                  `${period.letter} ${formatClock(period.start, timeZone).slice(0, 5)}`
              )
              .join(" · ")}
            . Shaded rows: value area; left bar: initial balance.
          </p>
        </>
      )}
    </div>
  );
};
