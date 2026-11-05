import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import adxFilterStudy from "../../features/research-studies/adx-filter-study.json";
import {
  type FilterStudyViewModel,
  type StudyRow,
  toFilterStudyViewModel,
  type VerdictTone,
} from "../../features/research-studies/view-model.ts";

// Read-only summary of frozen filter studies (docs/specs/research/adx-filter.md). The numbers come
// from the committed study summary; nothing here runs a backtest or places orders.

const headCell = "text-muted-foreground px-2 py-2 text-left font-normal";
const numHead = "text-muted-foreground px-2 py-2 text-right font-normal";
const cell = "whitespace-normal px-2 py-2";
const numCell = "whitespace-normal px-2 py-2 text-right font-mono";

const TONE_CLASS: Readonly<Record<VerdictTone, string>> = {
  baseline: "text-muted-foreground",
  caution: "text-warning-foreground",
  drop: "text-destructive",
  keep: "text-success-foreground",
};

const StudyTable = ({
  caption,
  details,
  rows,
  showDeflated,
}: {
  readonly caption: string;
  readonly details: string;
  readonly rows: readonly StudyRow[];
  readonly showDeflated: boolean;
}) => (
  <div className="space-y-2">
    <p className="text-muted-foreground text-xs">{details}</p>
    <div
      aria-label={caption}
      className="overflow-x-auto"
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
      tabIndex={0}
    >
      <Table
        className="w-full min-w-[56rem] text-xs"
        containerClassName="overflow-visible"
      >
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-muted-foreground">
            <TableHead className={headCell} scope="col">
              Strategy
            </TableHead>
            <TableHead className={headCell} scope="col">
              Filter
            </TableHead>
            <TableHead className={numHead} scope="col">
              Sharpe
            </TableHead>
            <TableHead className={numHead} scope="col">
              1st half
            </TableHead>
            <TableHead className={numHead} scope="col">
              2nd half
            </TableHead>
            <TableHead className={numHead} scope="col">
              CAGR
            </TableHead>
            <TableHead className={numHead} scope="col">
              Max DD
            </TableHead>
            <TableHead className={numHead} scope="col">
              Trades
            </TableHead>
            <TableHead className={numHead} scope="col">
              Trades/yr
            </TableHead>
            {showDeflated ? (
              <TableHead className={numHead} scope="col">
                Deflated Sharpe
              </TableHead>
            ) : null}
            <TableHead className={headCell} scope="col">
              Verdict
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              className="border-border border-b"
              data-row={row.key}
              key={row.key}
            >
              <TableHead className={`${cell} font-normal`} scope="row">
                {row.strategy}
              </TableHead>
              <TableCell className={cell}>{row.filter}</TableCell>
              <TableCell className={numCell}>{row.sharpe}</TableCell>
              <TableCell className={numCell}>{row.firstHalf}</TableCell>
              <TableCell className={numCell}>{row.secondHalf}</TableCell>
              <TableCell className={numCell}>{row.cagr}</TableCell>
              <TableCell className={numCell}>{row.maxDrawdown}</TableCell>
              <TableCell className={numCell}>{row.trades}</TableCell>
              <TableCell className={numCell}>{row.tradesPerYear}</TableCell>
              {showDeflated ? (
                <TableCell className={numCell}>{row.deflated}</TableCell>
              ) : null}
              <TableCell className={`${cell} ${TONE_CLASS[row.tone]}`}>
                {row.verdict}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </div>
);

export const FilterStudiesPanel = ({
  model,
}: {
  readonly model: FilterStudyViewModel;
}) => (
  <section
    aria-labelledby="filter-studies-heading"
    className="space-y-4 rounded-lg border border-border p-4"
  >
    <div className="space-y-1">
      <h2 className="font-medium text-base" id="filter-studies-heading">
        Filter studies
      </h2>
      <p className="text-muted-foreground text-sm">
        ADX and relative volume at time as entry filters. Rules were frozen
        before the run ({model.spec}). Research only; a result does not
        authorize trades.
      </p>
    </div>
    <div className="space-y-2">
      <h3 className="font-medium text-sm">ADX filter, daily strategies</h3>
      <p className="text-sm">{model.dailySummary}</p>
      <StudyTable
        caption="ADX filter results by strategy and filter"
        details={model.dailyCaption}
        rows={model.dailyRows}
        showDeflated
      />
    </div>
    <div className="space-y-2">
      <h3 className="font-medium text-sm">RVOL at time, intraday</h3>
      <p className="text-sm">{model.intradaySummary}</p>
      <StudyTable
        caption="RVOL filter results"
        details={model.intradayCaption}
        rows={model.intradayRows}
        showDeflated={false}
      />
    </div>
  </section>
);

/** The committed study summary, validated at module load. */
export const FILTER_STUDY_MODEL = toFilterStudyViewModel(adxFilterStudy);
