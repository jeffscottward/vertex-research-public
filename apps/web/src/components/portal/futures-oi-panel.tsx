import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";

import {
  candleDate,
  candlesAfter,
  formatChange,
  formatContracts,
  type FuturesOiBar,
  type FuturesOiMarket,
} from "../../features/charts/futures-oi.ts";
import type { DisplayCandle } from "../../features/charts/types.ts";
import type { FuturesOiSeries, FuturesOiState } from "./use-futures-oi.ts";

// Text, reading key and table for the "OI change" pane of /charts. The pane is a canvas, so
// every fact it draws is repeated here as text. Props only: the page owns the read.

const TABLE_ROWS = 10;
const NO_CHANGE_TEXT: Readonly<
  Record<NonNullable<FuturesOiBar["noChange"]>, string>
> = {
  edge: "first loaded candle",
  expiry: "quarterly expiry",
  first: "first stored day",
  gap: "no figure for the trading day before",
};
const KEY_SENTENCES = [
  "A bar above the line: open interest rose that day. A bar below the line: it fell.",
  "The textbook reading of price and open interest together (J. J. Murphy, Technical Analysis of the Financial Markets):",
  "Price up, open interest up: new buying.",
  "Price up, open interest down: short covering.",
  "Price down, open interest up: new selling.",
  "Price down, open interest down: long liquidation.",
  "This is a reading aid, not a signal. The CME figure is preliminary; on a day with a small change the final figure can show the other direction.",
  "The first figure after a quarterly expiry (the third Friday of March, June, September and December) has no bar: the expired contract leaves the total.",
] as const;
const cell = "py-1 pr-3 whitespace-nowrap";
const headCell = `${cell} h-auto font-normal text-muted-foreground`;

/** `YYYY-MM-DD HH:MM UTC` of a time. */
const utcMinute = (time: Date): string => {
  const iso = time.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

const changeText = (bar: FuturesOiBar): string =>
  bar.change === null
    ? NO_CHANGE_TEXT[bar.noChange ?? "first"]
    : formatChange(bar.change);

const newestText = (market: FuturesOiMarket, bar: FuturesOiBar): string => {
  const figure = `Open interest, ${market} futures, all contract months (CME, preliminary): ${formatContracts(bar.figure)} contracts on ${bar.date}`;
  return bar.change === null
    ? `${figure}.`
    : `${figure}, ${formatChange(bar.change)} against ${bar.previousDate}.`;
};

const ReadingKey = () => (
  <details data-futures-oi-key="">
    <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm">
      How to read the bars
    </summary>
    <ul className="space-y-1 text-muted-foreground">
      {KEY_SENTENCES.map((sentence) => (
        <li key={sentence}>{sentence}</li>
      ))}
    </ul>
  </details>
);

const BarsTable = ({ bars }: { readonly bars: readonly FuturesOiBar[] }) => (
  <div className="overflow-x-auto" data-futures-oi-table="">
    <Table className="w-full text-xs">
      <TableCaption className="text-left">
        Open interest by trading day (last 10 stored days)
      </TableCaption>
      <TableHeader>
        <TableRow className="border-border border-b text-left">
          <TableHead className={headCell} scope="col">
            Date
          </TableHead>
          <TableHead className={`${headCell} text-right`} scope="col">
            Open interest
          </TableHead>
          <TableHead className={`${headCell} text-right`} scope="col">
            Change
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bars
          .slice(-TABLE_ROWS)
          .reverse()
          .map((bar) => (
            <TableRow className="border-border border-b" key={bar.date}>
              <TableHead className={`${cell} h-auto font-mono`} scope="row">
                {bar.date}
              </TableHead>
              <TableCell className={`${cell} text-right font-mono`}>
                {formatContracts(bar.figure)}
              </TableCell>
              <TableCell
                className={`${cell} text-right ${bar.change === null ? "" : "font-mono"}`}
              >
                {changeText(bar)}
              </TableCell>
            </TableRow>
          ))}
      </TableBody>
    </Table>
  </div>
);

const Ready = ({
  market,
  series,
  bars,
  candles,
}: {
  readonly market: FuturesOiMarket;
  readonly series: FuturesOiSeries;
  readonly bars: readonly FuturesOiBar[];
  readonly candles: readonly DisplayCandle[];
}) => {
  const newest = bars.at(-1);
  const after = candlesAfter(candles, series.lastDate);
  const [first] = candles;
  const storedFrom =
    first !== undefined && candleDate(first.timestamp) < series.firstDate;
  return (
    <>
      <div className="space-y-1" role="status">
        {newest === undefined ? null : (
          <p data-futures-oi-newest="">{newestText(market, newest)}</p>
        )}
        <p className="text-muted-foreground">
          Figures last written {utcMinute(series.updatedAt)}.
        </p>
        {after > 0 ? (
          <p className="text-muted-foreground">
            {after === 1
              ? `1 loaded trading day after ${series.lastDate} has no CME figure yet.`
              : `${after} loaded trading days after ${series.lastDate} have no CME figure yet.`}
          </p>
        ) : null}
        {storedFrom ? (
          <p className="text-muted-foreground">
            CME figures are stored from {series.firstDate}. Earlier candles have
            no bar.
          </p>
        ) : null}
      </div>
      <ReadingKey />
      {newest === undefined ? null : <BarsTable bars={bars} />}
    </>
  );
};

export type FuturesOiPanelProps = Readonly<{
  market: FuturesOiMarket;
  state: FuturesOiState;
  // Stored dates that have a shown candle, oldest first.
  bars: readonly FuturesOiBar[];
  // The candles the chart shows.
  candles: readonly DisplayCandle[];
}>;

export const FuturesOiPanel = ({
  market,
  state,
  bars,
  candles,
}: FuturesOiPanelProps) => {
  if (state.type === "off") return null;
  return (
    <section
      aria-label="Futures open interest"
      className="space-y-2 text-xs"
      data-futures-oi={market}
      data-futures-oi-state={state.type}
    >
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground" role="status">
          Loading open interest
        </p>
      ) : state.type === "error" ? (
        <p role="alert">
          Open interest could not be read. The price chart is not affected.
        </p>
      ) : state.series === null ? (
        <p role="status">
          No CME open-interest figures are stored for {market}. The daily job
          cme-futures-oi stores them.
        </p>
      ) : (
        <Ready
          bars={bars}
          candles={candles}
          market={market}
          series={state.series}
        />
      )}
    </section>
  );
};
