import type { Breadth90Day, Breadth90DayKind } from "@darkfactory/api";

// Breadth-90 session chart: one bar per session of the NYSE up-volume share (0-100%), with dashed
// reference lines at the classifier thresholds (10/20% down days, 80/90% up days). A trailing
// intraday session is drawn hollow. The same values are in a visually hidden table.

const WIDTH = 600;
const HEIGHT = 200;
const PAD_LEFT = 36;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;
/** Share of each bar slot left empty between bars. */
const BAR_GAP = 0.25;

// Status tokens carry the meaning in every theme; the hidden table and titles name each value.
const KIND_FILL: Readonly<Record<Breadth90DayKind, string>> = {
  DOWN_80: "fill-destructive opacity-60",
  DOWN_90: "fill-destructive",
  NEUTRAL: "fill-muted-foreground opacity-40",
  UP_80: "fill-success opacity-60",
  UP_90: "fill-success",
};

export const KIND_LABEL: Readonly<Record<Breadth90DayKind, string>> = {
  DOWN_80: "80% down day",
  DOWN_90: "90% down day",
  NEUTRAL: "Neutral",
  UP_80: "80% up day",
  UP_90: "90% up day",
};

export type Breadth90Thresholds = Readonly<{
  down90: number;
  down80: number;
  up80: number;
  up90: number;
}>;

const yOf = (pct: number): number => PAD_TOP + PLOT_H * (1 - pct / 100);

export const Breadth90Chart = ({
  days,
  thresholds,
}: Readonly<{
  days: readonly Breadth90Day[];
  thresholds: Breadth90Thresholds;
}>) => {
  const slot = PLOT_W / Math.max(days.length, 1);
  const barWidth = slot * (1 - BAR_GAP);
  const lines = [
    thresholds.down90,
    thresholds.down80,
    thresholds.up80,
    thresholds.up90,
  ];
  const first = days[0];
  const last = days.at(-1);
  const summary =
    first === undefined || last === undefined
      ? "No sessions yet."
      : `Up-volume share of the last ${days.length} NYSE sessions, ${first.date} to ${last.date}. Latest ${last.upPct.toFixed(1)}%${last.final ? "" : " (intraday)"}. Reference lines at ${lines.join(", ")}%.`;
  return (
    <figure className="space-y-2" data-breadth90-chart="">
      <svg
        aria-label={summary}
        className="h-auto w-full"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        {lines.map((pct) => (
          <g data-threshold={pct} key={pct}>
            <line
              className="stroke-border-strong"
              strokeDasharray="4 4"
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yOf(pct)}
              y2={yOf(pct)}
            />
            <text
              className="fill-muted-foreground text-[10px]"
              dominantBaseline="middle"
              textAnchor="end"
              x={PAD_LEFT - 4}
              y={yOf(pct)}
            >
              {pct}%
            </text>
          </g>
        ))}
        {days.map((day, index) => {
          const top = yOf(day.upPct);
          return (
            <rect
              className={
                day.final
                  ? KIND_FILL[day.kind]
                  : `${KIND_FILL[day.kind]} stroke-foreground`
              }
              data-date={day.date}
              data-final={String(day.final)}
              data-kind={day.kind}
              height={Math.max(PAD_TOP + PLOT_H - top, 1)}
              key={day.date}
              strokeDasharray={day.final ? undefined : "3 2"}
              strokeWidth={day.final ? undefined : 1.5}
              width={barWidth}
              x={PAD_LEFT + index * slot + (slot - barWidth) / 2}
              y={top}
            >
              <title>{`${day.date}: ${day.upPct.toFixed(1)}% up volume, ${KIND_LABEL[day.kind]}${day.final ? "" : " (intraday)"}`}</title>
            </rect>
          );
        })}
        {first === undefined || last === undefined ? null : (
          <>
            <text
              className="fill-muted-foreground text-[10px]"
              x={PAD_LEFT}
              y={HEIGHT - 6}
            >
              {first.date}
            </text>
            <text
              className="fill-muted-foreground text-[10px]"
              textAnchor="end"
              x={WIDTH - PAD_RIGHT}
              y={HEIGHT - 6}
            >
              {last.date}
            </text>
          </>
        )}
      </svg>
      <table className="sr-only">
        <caption>Breadth-90 sessions</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Up volume %</th>
            <th scope="col">Advancers %</th>
            <th scope="col">Day</th>
            <th scope="col">Session</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <td>{day.date}</td>
              <td>{day.upPct.toFixed(1)}</td>
              <td>{day.advPct === null ? "—" : day.advPct.toFixed(1)}</td>
              <td>{KIND_LABEL[day.kind]}</td>
              <td>{day.final ? "Close" : "Intraday"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
