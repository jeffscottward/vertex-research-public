"use client";

// The payoff lab of the research dossier Options analysis tab (merge plan P1-6): profit or loss at
// expiry of the strategies that the dossier stores, as a chart and an outcome table. The lab reads
// the stored JSON only through `parsePayoffStrategies`, whose output carries no stored text, so
// nothing here can render a strategy name, note or order text. It sends no request and keeps its
// state in memory. Research only: it cannot place or change an order.
import {
  Input,
  Panel,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { Component, type ReactNode, useMemo, useState } from "react";

import {
  type AvailablePayoff,
  type ExpiryPayoff,
  prepareExpiryPayoff,
} from "./payoff.ts";
import { payoffGeometry } from "./payoff-geometry.ts";
import {
  breakevenText,
  EXPIRED_MARK,
  firstSet,
  formatAmount,
  formatPlain,
  formatPrice,
  groupLabel,
  isExpired,
  LAB_LIMITS,
  lineLabel,
  MAX_SELECTED_LINES,
  parsePrice,
  parseUnits,
  priceAxis,
  REASON_TEXT,
  utcDate,
} from "./payoff-lab-model.ts";
import {
  assetGate,
  type CatalogFacts,
  type LabLine,
  type ParsedStrategies,
  parsePayoffStrategies,
} from "./payoff-strategies.ts";

export type PayoffLabProps = Readonly<{
  /** `ResearchReportDatasetOutput.data` of the `options-analysis` dataset. */
  data: unknown;
  reportId: string;
  catalog: CatalogFacts;
  /** The UTC date `YYYY-MM-DD`; the component tests pass a fixed one. */
  today?: string;
}>;

type LabState =
  | "loading"
  | "ready"
  | "no-strategies"
  | "malformed"
  | "none-drawable"
  | "failed";

const Shell = ({
  children,
  state,
}: Readonly<{ children: ReactNode; state: LabState }>) => (
  <Panel
    data-payoff-lab=""
    data-payoff-lab-state={state}
    description="Profit or loss at expiry of the strategies that this dossier stores. Research only."
    headingId="payoff-lab-heading"
    title="Payoff lab"
  >
    {children}
  </Panel>
);

/** A lab fault must not take the text panels of the tab down with it. */
class PayoffLabBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  override state = { failed: false };

  static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <Shell state="failed">
        <p className="text-sm" role="alert">
          The payoff lab failed to render. The text panels above are not
          affected.
        </p>
      </Shell>
    ) : (
      this.props.children
    );
  }
}

type Parsed = Extract<ParsedStrategies, { state: "parsed" }>;

const Counts = ({ parsed }: Readonly<{ parsed: Parsed }>) => {
  const notDrawable = parsed.notDrawable.reduce(
    (sum, entry) => sum + entry.rows,
    0
  );
  return (
    <div className="space-y-1 text-muted-foreground text-sm">
      <p data-payoff-lab-counts="">
        {parsed.stored} stored {parsed.stored === 1 ? "row" : "rows"} ={" "}
        {parsed.drawableRows} drawable ({parsed.lines.length}{" "}
        {parsed.lines.length === 1 ? "line" : "lines"}) + {notDrawable} not
        drawable + {parsed.notShown} not shown.
      </p>
      {parsed.notDrawable.length === 0 ? null : (
        <ul className="list-disc pl-5" data-payoff-lab-reasons="">
          {parsed.notDrawable.map((entry) => (
            <li key={entry.reason}>
              {entry.rows}: {REASON_TEXT[entry.reason]}
            </li>
          ))}
        </ul>
      )}
      {parsed.notShown === 0 ? null : (
        <p>
          Not shown: stock rows that the dossier does not mark as hypothetical
          with a share count above 0.
        </p>
      )}
    </div>
  );
};

/** The dash pattern of a line number (1 to 5); with the colour token it tells the lines apart. */
const dashOf = (number: number): string => {
  if (number === 1) return "none";
  if (number === 2) return "6 3";
  if (number === 3) return "2 3";
  return number === 4 ? "8 3 2 3" : "1 4";
};
const lineStyle = (number: number) => ({
  color: `var(--chart-${number})`,
  dash: dashOf(number),
});

const Swatch = ({ number }: Readonly<{ number: number }>) => {
  const { color, dash } = lineStyle(number);
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-8 shrink-0"
      data-payoff-swatch={number}
      viewBox="0 0 32 12"
    >
      <line
        stroke={color}
        strokeDasharray={dash}
        strokeWidth="3"
        x1="0"
        x2="32"
        y1="6"
        y2="6"
      />
    </svg>
  );
};

const Mark = ({ line, today }: Readonly<{ line: LabLine; today: string }>) =>
  isExpired(line, today) ? (
    <span className="rounded border px-1 text-muted-foreground text-xs">
      {EXPIRED_MARK}
    </span>
  ) : null;

const COMPACT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const PLOT_HEIGHT = "h-64 sm:h-80";

type Drawn = Readonly<{
  line: LabLine;
  number: number;
  /** `null`: the typed size is not valid. */
  units: number | null;
  payoff: ExpiryPayoff | null;
}>;

const Chart = ({
  axis,
  drawn,
  price,
}: Readonly<{
  axis: Readonly<{ min: number; max: number }>;
  drawn: readonly Drawn[];
  price: number | null;
}>) => {
  const geometry = payoffGeometry({
    lines: drawn.flatMap(({ line, number, payoff }) =>
      payoff?.available ? [{ key: line.key, number, payoff }] : []
    ),
    max: axis.max,
    min: axis.min,
    price,
  });
  return (
    <figure className="space-y-2" data-payoff-chart="">
      <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_1.75rem] gap-x-1">
        <div aria-hidden="true" className={`relative ${PLOT_HEIGHT}`}>
          {geometry.yTicks.map((tick) => (
            <span
              className="absolute right-0 -translate-y-1/2 text-muted-foreground text-xs tabular-nums"
              key={tick.value}
              style={{ top: `${tick.position}%` }}
            >
              {COMPACT.format(tick.value)}
            </span>
          ))}
        </div>
        <div
          className={`relative overflow-hidden rounded-md border bg-background ${PLOT_HEIGHT}`}
        >
          <svg
            aria-label="Profit or loss at expiry for the selected lines; the table below gives the outcome at the chosen price"
            className="absolute inset-0 size-full"
            preserveAspectRatio="none"
            role="img"
            viewBox="0 0 100 100"
          >
            {geometry.yTicks.map((tick) => (
              <line
                key={tick.value}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                x1="0"
                x2="100"
                y1={tick.position}
                y2={tick.position}
              />
            ))}
            <line
              data-payoff-zero=""
              stroke="var(--muted-foreground)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              x1="0"
              x2="100"
              y1={geometry.zeroY}
              y2={geometry.zeroY}
            />
            {geometry.markerX === null ? null : (
              <line
                data-payoff-marker=""
                stroke="var(--foreground)"
                strokeDasharray="4 4"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                x1={geometry.markerX}
                x2={geometry.markerX}
                y1="0"
                y2="100"
              />
            )}
            {geometry.paths.map((path) => {
              const { color, dash } = lineStyle(path.number);
              return (
                <path
                  d={path.d}
                  data-payoff-line={path.number}
                  fill="none"
                  key={path.key}
                  stroke={color}
                  strokeDasharray={dash}
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        </div>
        <div aria-hidden="true" className={`relative ${PLOT_HEIGHT}`}>
          {geometry.paths.map((path) => (
            <span
              className="absolute left-0 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border bg-card font-medium text-xs tabular-nums"
              key={path.key}
              style={{ top: `${path.badgeY}%` }}
            >
              {path.number}
            </span>
          ))}
        </div>
        <div />
        <div aria-hidden="true" className="relative h-5">
          {geometry.xTicks.map((tick) => (
            <span
              className="absolute -translate-x-1/2 text-muted-foreground text-xs tabular-nums"
              key={tick.value}
              style={{ left: `${tick.position}%` }}
            >
              {formatPrice(tick.value)}
            </span>
          ))}
        </div>
        <div />
      </div>
      <figcaption className="text-muted-foreground text-xs">
        Across: price at expiry. Up: profit or loss at expiry. The dashed
        vertical line is the price at expiry that you set.
      </figcaption>
    </figure>
  );
};

const NO_VALUE = "no value";

const outcomeText = (
  payoff: AvailablePayoff,
  price: number | null,
  currency: string | null
): string => {
  if (price === null) return "no price";
  const profit = payoff.at(price);
  return profit === null
    ? "beyond the supported range"
    : formatAmount(profit, currency);
};

/** The message under the size field: an invalid size, or a size that the model refuses. */
const sizeMessage = ({ line, payoff, units }: Drawn): string | null => {
  if (units === null)
    return line.kind === "stock"
      ? "Enter a share count above 0."
      : "Enter a whole number of contracts above 0.";
  return payoff === null || payoff.available
    ? null
    : `Not drawn at this size: ${REASON_TEXT[payoff.reason]}.`;
};

type RowTexts = Readonly<{
  multiplier: string;
  outcome: string;
  maxLoss: string;
  maxProfit: string;
  breakevens: string;
}>;

const EMPTY_ROW: RowTexts = {
  breakevens: NO_VALUE,
  maxLoss: NO_VALUE,
  maxProfit: NO_VALUE,
  multiplier: NO_VALUE,
  outcome: NO_VALUE,
};

const rowTexts = (
  payoff: AvailablePayoff,
  price: number | null,
  currency: string | null
): RowTexts => ({
  breakevens: breakevenText(payoff),
  maxLoss: formatAmount(payoff.maxLoss, currency),
  maxProfit:
    payoff.maxProfit === null
      ? "Uncapped"
      : formatAmount(payoff.maxProfit, currency),
  multiplier:
    payoff.contractMultiplier === null
      ? "not applicable to stock"
      : `${formatPrice(payoff.contractMultiplier)}${payoff.multiplierAssumed ? " (assumed)" : ""}`,
  outcome: outcomeText(payoff, price, currency),
});

const OutcomeRow = ({
  currency,
  item,
  onSize,
  price,
  sizeText,
  today,
}: Readonly<{
  currency: string | null;
  item: Drawn;
  onSize: (text: string) => void;
  price: number | null;
  sizeText: string;
  today: string;
}>) => {
  const { line, number, payoff } = item;
  const unit = line.kind === "stock" ? "shares" : "contracts";
  const message = sizeMessage(item);
  const messageId = `payoff-size-message-${line.key}`;
  const texts = payoff?.available
    ? rowTexts(payoff, price, currency)
    : EMPTY_ROW;
  return (
    <TableRow data-payoff-row={number}>
      <TableHead
        className="h-auto min-w-56 whitespace-normal py-2 font-normal"
        scope="row"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium tabular-nums">{number}.</span>
          <Swatch number={number} />
          <span>{lineLabel(line)}</span>
          <Mark line={line} today={today} />
        </span>
      </TableHead>
      <TableCell className="min-w-36 whitespace-normal">
        <Input
          aria-describedby={message === null ? undefined : messageId}
          aria-label={`Size of line ${number} in ${unit}`}
          className="w-28"
          data-payoff-size={number}
          inputMode="decimal"
          invalid={message !== null}
          onChange={(event) => onSize(event.target.value)}
          type="text"
          value={sizeText}
        />
        <span className="ml-2 text-muted-foreground text-xs">{unit}</span>
        {message === null ? null : (
          <p className="pt-1 text-xs" id={messageId} role="status">
            {message}
          </p>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">{texts.multiplier}</TableCell>
      <TableCell data-payoff-outcome={number} numeric>
        {texts.outcome}
      </TableCell>
      <TableCell numeric>{texts.maxLoss}</TableCell>
      <TableCell numeric>{texts.maxProfit}</TableCell>
      <TableCell className="whitespace-normal">{texts.breakevens}</TableCell>
    </TableRow>
  );
};

const CONTROL =
  "min-h-11 rounded-md border border-input bg-background px-2 text-sm";

const ReadyLab = ({
  parsed,
  today,
}: Readonly<{ parsed: Parsed; today: string }>) => {
  const { currency, lines } = parsed;
  const first = useMemo(() => firstSet(lines, today), [lines, today]);
  const axis = useMemo(() => priceAxis(lines, first), [lines, first]);
  const [listed, setListed] = useState<readonly string[]>(first);
  const [selected, setSelected] = useState<readonly string[]>(first);
  const [sizes, setSizes] = useState<Readonly<Record<string, string>>>({});
  const [priceText, setPriceText] = useState(() => formatPlain(axis.start));
  const [refused, setRefused] = useState(false);

  const price = parsePrice(priceText);
  const listedLines = lines
    .filter((line) => listed.includes(line.key))
    .sort((a, b) => listed.indexOf(a.key) - listed.indexOf(b.key));
  const unlisted = lines.filter((line) => !listed.includes(line.key));
  const groups = [...new Set(unlisted.map(groupLabel))].sort();
  const sizeTextOf = (line: LabLine): string =>
    sizes[line.key] ?? formatPlain(line.defaultUnits);
  const drawn: readonly Drawn[] = listedLines
    .filter((line) => selected.includes(line.key))
    .map((line, index) => {
      const units = parseUnits(sizeTextOf(line), line.kind);
      return {
        line,
        number: index + 1,
        payoff:
          units === null ? null : prepareExpiryPayoff(line.strategy, units),
        units,
      };
    });
  const numberOf = (line: LabLine): number | undefined =>
    drawn.find((item) => item.line.key === line.key)?.number;
  const expiryDates = new Set(
    drawn.flatMap(({ line }) => (line.expiry === null ? [] : [line.expiry]))
  );

  const toggle = (key: string, checked: boolean): void => {
    if (!checked) {
      setRefused(false);
      setSelected(selected.filter((entry) => entry !== key));
    } else if (selected.length >= MAX_SELECTED_LINES) setRefused(true);
    else setSelected([...selected, key]);
  };

  return (
    <Shell state="ready">
      <div className="space-y-6 text-sm">
        <Counts parsed={parsed} />

        <fieldset className="space-y-2" data-payoff-picker="">
          <legend className="font-medium">
            Lines ({selected.length} of {MAX_SELECTED_LINES} selected)
          </legend>
          <ul className="space-y-1">
            {listedLines.map((line) => {
              const number = numberOf(line);
              return (
                <li key={line.key}>
                  <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2">
                    <input
                      checked={number !== undefined}
                      className="size-5 accent-primary"
                      data-payoff-pick={line.key}
                      onChange={(event) =>
                        toggle(line.key, event.target.checked)
                      }
                      type="checkbox"
                    />
                    {number === undefined ? null : (
                      <>
                        <span className="font-medium tabular-nums">
                          {number}.
                        </span>
                        <Swatch number={number} />
                      </>
                    )}
                    <span>{lineLabel(line)}</span>
                    <Mark line={line} today={today} />
                  </label>
                </li>
              );
            })}
          </ul>
          {unlisted.length === 0 ? null : (
            <label className="flex flex-col gap-1 text-muted-foreground text-xs sm:max-w-md">
              Add a line
              <select
                className={CONTROL}
                data-payoff-add=""
                onChange={(event) => {
                  if (event.target.value !== "")
                    setListed([...listed, event.target.value]);
                }}
                value=""
              >
                <option value="">
                  Choose one of {unlisted.length} more lines
                </option>
                {groups.map((group) => (
                  <optgroup key={group} label={group}>
                    {unlisted
                      .filter((line) => groupLabel(line) === group)
                      .map((line) => (
                        <option key={line.key} value={line.key}>
                          {lineLabel(line)}
                          {isExpired(line, today) ? ` (${EXPIRED_MARK})` : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <div aria-live="polite" data-payoff-messages="" role="status">
            {refused ? (
              <p>
                {MAX_SELECTED_LINES} of {MAX_SELECTED_LINES} lines selected.
                Clear one to add another.
              </p>
            ) : null}
            {expiryDates.size > 1 ? (
              <p>
                The selected lines settle on different dates. One price at
                expiry cannot describe all of them.
              </p>
            ) : null}
            {drawn.length === 0 ? <p>Select a line to draw it.</p> : null}
          </div>
        </fieldset>

        <div className="space-y-2" data-payoff-price="">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <label className="flex flex-col gap-1 text-muted-foreground text-xs">
              Price at expiry{currency === null ? "" : ` (${currency})`}
              <Input
                aria-describedby="payoff-price-notes"
                className="w-36"
                data-payoff-price-field=""
                inputMode="decimal"
                invalid={price === null}
                onChange={(event) => setPriceText(event.target.value)}
                type="text"
                value={priceText}
              />
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-muted-foreground text-xs">
              Price slider, {formatPrice(axis.min)} to {formatPrice(axis.max)}
              <input
                className="min-h-11 w-full accent-primary"
                data-payoff-price-slider=""
                max={axis.max}
                min={axis.min}
                onChange={(event) =>
                  setPriceText(formatPlain(Number(event.target.value)))
                }
                step={axis.step}
                type="range"
                value={Math.min(
                  Math.max(price ?? axis.start, axis.min),
                  axis.max
                )}
              />
            </label>
          </div>
          <div
            className="space-y-1 text-muted-foreground text-xs"
            id="payoff-price-notes"
          >
            {price === null ? (
              <p role="status">Enter a price of 0 or more.</p>
            ) : null}
            {price !== null && (price < axis.min || price > axis.max) ? (
              <p role="status">The price is outside the chart range.</p>
            ) : null}
            <p>
              {axis.source === "stock-basis"
                ? "Starting price: the entry basis of the hypothetical stock row."
                : "Starting price: the midpoint of the lowest and the highest strike of the first lines."}{" "}
              It is not a current quote.
            </p>
            {currency === null ? (
              <p>Currency not stated in the dossier.</p>
            ) : null}
          </div>
        </div>

        <Chart axis={axis} drawn={drawn} price={price} />

        <TableScroll label="Payoff outcome per line" minWidth="56rem">
          <Table>
            <TableCaption className="sr-only">
              Outcome at the price at expiry, maximum loss, maximum profit and
              breakevens per selected line
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Line</TableHead>
                <TableHead scope="col">Size</TableHead>
                <TableHead scope="col">Shares per contract</TableHead>
                <TableHead numeric scope="col">
                  Outcome at {price === null ? "the price" : formatPrice(price)}
                </TableHead>
                <TableHead numeric scope="col">
                  Maximum loss
                </TableHead>
                <TableHead numeric scope="col">
                  Maximum profit
                </TableHead>
                <TableHead scope="col">Breakevens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drawn.map((item) => (
                <OutcomeRow
                  currency={currency}
                  item={item}
                  key={item.line.key}
                  onSize={(text) =>
                    setSizes({ ...sizes, [item.line.key]: text })
                  }
                  price={price}
                  sizeText={sizeTextOf(item.line)}
                  today={today}
                />
              ))}
            </TableBody>
          </Table>
        </TableScroll>

        <div className="space-y-1 text-muted-foreground text-xs">
          <h3 className="font-medium text-foreground text-sm">
            Limits of this chart
          </h3>
          <ul className="list-disc space-y-0.5 pl-5" data-payoff-limits="">
            {LAB_LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </div>
      </div>
    </Shell>
  );
};

const ParsedLab = ({
  catalog,
  data,
  reportId,
  today: suppliedToday,
}: Readonly<
  Omit<PayoffLabProps, "catalog"> & {
    catalog: Exclude<CatalogFacts, { status: "loading" }>;
  }
>) => {
  const [today] = useState(() => suppliedToday ?? utcDate(new Date()));
  const gate = assetGate(reportId, catalog);
  const catalogCurrency = catalog.status === "ready" ? catalog.currency : null;
  const parsed = useMemo(
    () => parsePayoffStrategies(data, { catalogCurrency, gate, reportId }),
    [data, catalogCurrency, gate, reportId]
  );
  if (parsed.state === "no-strategies")
    return (
      <Shell state="no-strategies">
        <p className="text-muted-foreground text-sm">
          This dossier stores no strategies, so there is no payoff chart.
        </p>
      </Shell>
    );
  if (parsed.state === "malformed")
    return (
      <Shell state="malformed">
        <p className="text-muted-foreground text-sm">
          The stored strategies have an unsupported shape, so there is no payoff
          chart.
        </p>
      </Shell>
    );
  if (parsed.lines.length === 0)
    return (
      <Shell state="none-drawable">
        <Counts parsed={parsed} />
      </Shell>
    );
  return <ReadyLab parsed={parsed} today={today} />;
};

export const PayoffLab = ({ catalog, ...rest }: PayoffLabProps) => (
  <PayoffLabBoundary>
    {catalog.status === "loading" ? (
      <Shell state="loading">
        <div aria-busy="true" className="space-y-2" role="status">
          <span className="sr-only">Loading payoff lab</span>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Shell>
    ) : (
      <ParsedLab catalog={catalog} {...rest} />
    )}
  </PayoffLabBoundary>
);
