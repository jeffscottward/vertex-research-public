"use client";

import {
  OPTIONS_CHAIN_SOURCE_LABELS,
  type OptionContract,
  type OptionsChainOutput,
  type OptionsChainRow,
} from "@darkfactory/api";
import { cn } from "@darkfactory/ui";
import { useState } from "react";

// Options chain for one expiry. Desktop: calls left, strike in the middle, puts right.
// Narrow screens: a Calls/Puts switch and one table that scrolls sideways. The at-the-money
// row is highlighted; in-the-money cells are shaded. A bid or ask from IBKR has a dotted
// underline, screen-reader text naming the source and a visible legend under the table.
// Read-only: no order controls.

type ColumnKey =
  | "bid"
  | "ask"
  | "last"
  | "volume"
  | "openInterest"
  | "iv"
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "rho";

type Column = Readonly<{ key: ColumnKey; label: string; title: string }>;

const COLUMNS: readonly Column[] = [
  { key: "bid", label: "Bid", title: "Bid" },
  { key: "ask", label: "Ask", title: "Ask" },
  { key: "last", label: "Last", title: "Last trade price" },
  { key: "volume", label: "Vol", title: "Volume" },
  { key: "openInterest", label: "OI", title: "Open interest" },
  { key: "iv", label: "IV", title: "Implied volatility" },
  { key: "delta", label: "Δ", title: "Delta" },
  { key: "gamma", label: "Γ", title: "Gamma" },
  { key: "theta", label: "Θ", title: "Theta per day" },
  { key: "vega", label: "Vega", title: "Vega per 1 volatility point" },
  { key: "rho", label: "Rho", title: "Rho per 1 rate point" },
];
// Calls mirror the puts so Bid sits next to the strike on both sides.
const CALL_COLUMNS = [...COLUMNS].reverse();

export const STRIKE_WINDOWS = [10, 20, 40, "all"] as const;
export type StrikeWindow = (typeof STRIKE_WINDOWS)[number];

// Tiny negatives round to "-0.000"; show them as "0.000".
const fixed = (value: number, digits: number): string => {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
};

/** The value of one column, or null when the source sent none. */
const cellValue = (contract: OptionContract, key: ColumnKey): number | null => {
  switch (key) {
    case "bid":
    case "ask":
    case "last":
    case "volume":
    case "openInterest":
    case "iv":
      return contract[key];
    default:
      return contract.greeks?.[key] ?? null;
  }
};

type MissingCell = Readonly<{ text: string; title?: string }>;

const NO_CONTRACT: MissingCell = {
  text: "no contract",
  title: "No contract listed at this strike",
};
const NO_QUOTE: MissingCell = { text: "no quote" };
const NO_GREEKS: MissingCell = {
  text: "no greeks",
  title: "Greeks not sent by the source",
};

// The reason shown in place of a null value (status language rule 2), by column.
const MISSING_CELLS: Readonly<Record<ColumnKey, MissingCell>> = {
  ask: NO_QUOTE,
  bid: NO_QUOTE,
  delta: NO_GREEKS,
  gamma: NO_GREEKS,
  iv: { text: "no IV", title: "IV not computed by the source" },
  last: { text: "no trade" },
  openInterest: {
    text: "no OI",
    title: "Open interest not sent by the source",
  },
  rho: NO_GREEKS,
  theta: NO_GREEKS,
  vega: NO_GREEKS,
  volume: { text: "no volume" },
};

const missingCell = (
  contract: OptionContract | null,
  key: ColumnKey
): MissingCell | null => {
  if (contract === null) return NO_CONTRACT;
  return cellValue(contract, key) === null ? MISSING_CELLS[key] : null;
};

const valueText = (value: number, key: ColumnKey): string => {
  switch (key) {
    case "bid":
    case "ask":
    case "last":
      return fixed(value, 2);
    case "volume":
    case "openInterest":
      return value.toLocaleString("en-US");
    case "iv":
      return `${(value * 100).toFixed(1)}%`;
    case "gamma":
      return fixed(value, 4);
    default:
      return fixed(value, 3);
  }
};

/** Display text for one contract column; a null value shows its short reason. */
export const formatCell = (
  contract: OptionContract | null,
  key: ColumnKey
): string => {
  if (contract === null) return NO_CONTRACT.text;
  const value = cellValue(contract, key);
  return value === null ? MISSING_CELLS[key].text : valueText(value, key);
};

/** The `title` of a cell without a value: the full cause, when the short reason needs one. */
export const cellTitle = (
  contract: OptionContract | null,
  key: ColumnKey
): string | undefined => missingCell(contract, key)?.title;

/** Index of the strike nearest the spot price, or -1 without a spot or rows. */
export const atmIndex = (
  rows: readonly OptionsChainRow[],
  spot: number | null
): number => {
  if (spot === null) return -1;
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  rows.forEach((row, index) => {
    const gap = Math.abs(row.strike - spot);
    if (gap < distance) {
      best = index;
      distance = gap;
    }
  });
  return best;
};

/** Rows centered on the at-the-money strike; "all" keeps every row. */
export const windowRows = (
  rows: readonly OptionsChainRow[],
  atm: number,
  size: StrikeWindow
): readonly OptionsChainRow[] => {
  if (size === "all" || rows.length <= size) return rows;
  const center = atm < 0 ? Math.floor(rows.length / 2) : atm;
  const start = Math.min(
    Math.max(0, center - Math.floor(size / 2)),
    rows.length - size
  );
  return rows.slice(start, start + size);
};

const inTheMoney = (
  side: "call" | "put",
  row: OptionsChainRow,
  spot: number | null
): boolean => {
  if (spot !== null)
    return side === "call" ? row.strike < spot : row.strike > spot;
  return row[side]?.inTheMoney ?? false;
};

// Tight horizontal padding: 23 columns must fit a laptop-width panel without scrolling.
const headClass =
  "h-9 whitespace-nowrap px-1.5 text-right font-medium text-[11px] text-muted-foreground";
const cellClass = "h-10 whitespace-nowrap px-1.5 text-right tabular-nums";
const itmClass = "bg-muted/50";
const strikeClass =
  "h-10 whitespace-nowrap border-x border-border bg-card px-2 text-center font-semibold tabular-nums";
// Only the one-side table pins the strike: in the split table it sits in the middle.
const stickyStrike = "sticky left-0 z-10";

const HeadCells = ({ columns }: { readonly columns: readonly Column[] }) =>
  columns.map((column) => (
    <th className={headClass} key={column.key} scope="col">
      <abbr className="no-underline" title={column.title}>
        {column.label}
      </abbr>
    </th>
  ));

const LIVE_QUOTE_LABEL = `${OPTIONS_CHAIN_SOURCE_LABELS.ibkr} live quote`;
const LIVE_QUOTE_LEGEND = ` A dotted underline marks an ${LIVE_QUOTE_LABEL}.`;

const ContractCells = ({
  columns,
  contract,
  shaded,
}: {
  readonly columns: readonly Column[];
  readonly contract: OptionContract | null;
  readonly shaded: boolean;
}) =>
  columns.map((column) => {
    // The live pair, as opposed to the delayed Yahoo quote.
    const live =
      (column.key === "bid" || column.key === "ask") &&
      contract?.sources.quote === "ibkr";
    return (
      <td
        className={cn(
          cellClass,
          shaded && itmClass,
          live && "underline decoration-dotted underline-offset-4"
        )}
        data-quote-source={live ? "ibkr" : undefined}
        key={column.key}
        title={cellTitle(contract, column.key)}
      >
        {formatCell(contract, column.key)}
        {live ? <span className="sr-only"> ({LIVE_QUOTE_LABEL})</span> : null}
      </td>
    );
  });

const StrikeCell = ({
  row,
  atm,
  sticky = false,
}: {
  readonly row: OptionsChainRow;
  readonly atm: boolean;
  readonly sticky?: boolean;
}) => (
  <th
    className={cn(strikeClass, sticky && stickyStrike, atm && "bg-muted")}
    scope="row"
  >
    {row.strike.toFixed(2)}
    {atm ? (
      <span className="ml-2 rounded-full border border-border-strong px-1.5 py-0.5 font-medium text-[10px]">
        ATM
      </span>
    ) : null}
  </th>
);

type TableProps = Readonly<{
  chain: OptionsChainOutput;
  rows: readonly OptionsChainRow[];
  atmStrike: number | null;
}>;

const SplitTable = ({ chain, rows, atmStrike }: TableProps) => (
  <table
    className="w-full min-w-[60rem] border-collapse text-xs"
    data-chain-layout="split"
  >
    <caption className="sr-only">
      {chain.symbol} options expiring {chain.expiry}: calls, strike, puts
    </caption>
    <thead>
      <tr className="border-border border-b bg-muted/60">
        <th
          className={cn(headClass, "text-center")}
          colSpan={COLUMNS.length}
          scope="colgroup"
        >
          Calls
        </th>
        <th className={cn(headClass, "text-center")} scope="col">
          Strike
        </th>
        <th
          className={cn(headClass, "text-center")}
          colSpan={COLUMNS.length}
          scope="colgroup"
        >
          Puts
        </th>
      </tr>
      <tr className="border-border border-b bg-muted/60">
        <HeadCells columns={CALL_COLUMNS} />
        <th className={cn(headClass, "text-center")} scope="col">
          <span className="sr-only">Strike</span>
        </th>
        <HeadCells columns={COLUMNS} />
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => {
        const atm = row.strike === atmStrike;
        return (
          <tr
            className={cn("border-border/60 border-b", atm && "font-semibold")}
            data-atm={atm ? "" : undefined}
            data-strike={row.strike}
            key={row.strike}
          >
            <ContractCells
              columns={CALL_COLUMNS}
              contract={row.call}
              shaded={inTheMoney("call", row, chain.spot)}
            />
            <StrikeCell atm={atm} row={row} />
            <ContractCells
              columns={COLUMNS}
              contract={row.put}
              shaded={inTheMoney("put", row, chain.spot)}
            />
          </tr>
        );
      })}
    </tbody>
  </table>
);

const SideTable = ({
  chain,
  rows,
  atmStrike,
  side,
}: TableProps & Readonly<{ side: "call" | "put" }>) => (
  <table
    className="w-full min-w-[48rem] border-collapse text-sm"
    data-chain-layout={side === "call" ? "calls" : "puts"}
  >
    <caption className="sr-only">
      {chain.symbol} {side === "call" ? "calls" : "puts"} expiring{" "}
      {chain.expiry}
    </caption>
    <thead>
      <tr className="border-border border-b bg-muted/60">
        <th
          className={cn(headClass, "sticky left-0 z-10 bg-muted text-center")}
          scope="col"
        >
          Strike
        </th>
        <HeadCells columns={COLUMNS} />
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => {
        const atm = row.strike === atmStrike;
        return (
          <tr
            className={cn("border-border/60 border-b", atm && "font-semibold")}
            data-atm={atm ? "" : undefined}
            key={row.strike}
          >
            <StrikeCell atm={atm} row={row} sticky />
            <ContractCells
              columns={COLUMNS}
              contract={row[side]}
              shaded={inTheMoney(side, row, chain.spot)}
            />
          </tr>
        );
      })}
    </tbody>
  </table>
);

export type OptionsChainTableProps = Readonly<{
  chain: OptionsChainOutput;
  strikes: StrikeWindow;
}>;

export const OptionsChainTable = ({
  chain,
  strikes,
}: OptionsChainTableProps) => {
  const [side, setSide] = useState<"call" | "put">("call");
  const atm = atmIndex(chain.rows, chain.spot);
  const rows = windowRows(chain.rows, atm, strikes);
  const atmStrike = chain.rows[atm]?.strike ?? null;
  // Which sides of the shown rows have a marked cell: the legend follows the view.
  const liveSides = {
    call: rows.some((row) => row.call?.sources.quote === "ibkr"),
    put: rows.some((row) => row.put?.sources.quote === "ibkr"),
  };
  if (chain.rows.length === 0)
    return (
      <p className="p-4 text-muted-foreground text-sm" role="status">
        No contracts are listed for this expiry.
      </p>
    );
  return (
    <div data-options-chain={chain.expiry}>
      <div className="hidden overflow-x-auto lg:block">
        <SplitTable atmStrike={atmStrike} chain={chain} rows={rows} />
      </div>
      <div className="lg:hidden">
        <fieldset className="flex gap-1 p-3">
          <legend className="sr-only">Contract side</legend>
          {(["call", "put"] as const).map((option) => (
            <button
              aria-pressed={side === option}
              className={cn(
                "min-h-11 min-w-20 rounded-md border border-border-strong px-3 font-medium text-sm",
                side === option
                  ? "border-foreground bg-muted"
                  : "text-muted-foreground"
              )}
              key={option}
              onClick={() => setSide(option)}
              type="button"
            >
              {option === "call" ? "Calls" : "Puts"}
            </button>
          ))}
        </fieldset>
        <div className="overflow-x-auto">
          <SideTable
            atmStrike={atmStrike}
            chain={chain}
            rows={rows}
            side={side}
          />
        </div>
      </div>
      <p
        className="px-4 py-3 text-muted-foreground text-xs"
        data-strike-count=""
      >
        Showing {rows.length} of {chain.rows.length} strikes. Shaded cells are
        in the money.
        {/* Wide screens show both sides; narrow screens show the chosen side. */}
        {liveSides.call || liveSides.put ? (
          <span className="hidden lg:inline" data-quote-legend="split">
            {LIVE_QUOTE_LEGEND}
          </span>
        ) : null}
        {liveSides[side] ? (
          <span className="lg:hidden" data-quote-legend={side}>
            {LIVE_QUOTE_LEGEND}
          </span>
        ) : null}
      </p>
    </div>
  );
};
