import adxFilterStudy from "../../features/research-studies/adx-filter-study.json";
import {
  type FilterStudyViewModel,
  type StudyRow,
  toFilterStudyViewModel,
  type VerdictTone,
} from "../../features/research-studies/view-model.ts";

// Read-only summary of frozen filter studies (docs/specs/research/adx-filter.md). The numbers come
// from the committed study summary; nothing here runs a backtest or places orders.

const headCell = "px-2 py-2 text-left font-normal";
const numHead = "px-2 py-2 text-right font-normal";
const cell = "px-2 py-2";
const numCell = "px-2 py-2 text-right font-mono";

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
      <table className="w-full min-w-[56rem] text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border border-b text-muted-foreground">
            <th className={headCell} scope="col">
              Strategy
            </th>
            <th className={headCell} scope="col">
              Filter
            </th>
            <th className={numHead} scope="col">
              Sharpe
            </th>
            <th className={numHead} scope="col">
              1st half
            </th>
            <th className={numHead} scope="col">
              2nd half
            </th>
            <th className={numHead} scope="col">
              CAGR
            </th>
            <th className={numHead} scope="col">
              Max DD
            </th>
            <th className={numHead} scope="col">
              Trades
            </th>
            <th className={numHead} scope="col">
              Trades/yr
            </th>
            {showDeflated ? (
              <th className={numHead} scope="col">
                Deflated Sharpe
              </th>
            ) : null}
            <th className={headCell} scope="col">
              Verdict
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="border-border border-b"
              data-row={row.key}
              key={row.key}
            >
              <th className={`${cell} font-normal`} scope="row">
                {row.strategy}
              </th>
              <td className={cell}>{row.filter}</td>
              <td className={numCell}>{row.sharpe}</td>
              <td className={numCell}>{row.firstHalf}</td>
              <td className={numCell}>{row.secondHalf}</td>
              <td className={numCell}>{row.cagr}</td>
              <td className={numCell}>{row.maxDrawdown}</td>
              <td className={numCell}>{row.trades}</td>
              <td className={numCell}>{row.tradesPerYear}</td>
              {showDeflated ? (
                <td className={numCell}>{row.deflated}</td>
              ) : null}
              <td className={`${cell} ${TONE_CLASS[row.tone]}`}>
                {row.verdict}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
