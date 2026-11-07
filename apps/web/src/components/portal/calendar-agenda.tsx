"use client";

// What: the /calendar agenda: entries grouped by day with the All / Economic / Earnings filter.
// Used by: calendar-workspace.tsx. See: calendar-model.ts.
import { Badge, Button, Panel } from "@darkfactory/ui";

import { TickerLink } from "../ticker-link.tsx";
import {
  CALENDAR_FILTER_LABELS,
  CALENDAR_FILTERS,
  type CalendarEntry,
  type CalendarFilter,
  filterCalendarEntries,
  formatCalendarDay,
  groupCalendarDays,
} from "./calendar-model.ts";

const EMPTY_TEXT: Readonly<Record<CalendarFilter, string>> = {
  all: "No economic releases or earnings filings to show.",
  earnings: "No earnings filings to show for your watchlist.",
  economic: "No economic releases to show.",
};

const EntryRow = ({ entry }: Readonly<{ entry: CalendarEntry }>) => (
  <li
    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm"
    data-calendar-entry={entry.kind}
  >
    <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
      {entry.time ?? "All day"}
    </span>
    <Badge variant={entry.kind === "economic" ? "secondary" : "default"}>
      {entry.kind === "economic" ? "Economic" : "Earnings"}
    </Badge>
    {entry.kind === "economic" ? (
      <span className="font-medium">{entry.name}</span>
    ) : (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <TickerLink symbol={entry.symbol} />
        <a
          className="min-h-11 content-center break-words underline-offset-2 hover:underline"
          href={entry.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          8-K item 2.02 earnings results filed
          <span className="sr-only"> (opens SEC filing)</span>
        </a>
      </span>
    )}
  </li>
);

export interface CalendarAgendaProps {
  readonly entries: readonly CalendarEntry[];
  readonly filter: CalendarFilter;
  /** True while a source is still loading, so an empty list is not read as final. */
  readonly loading: boolean;
  readonly onFilterChange: (filter: CalendarFilter) => void;
  /** New York calendar day (YYYY-MM-DD) to mark as Today. */
  readonly today: string;
}

export const CalendarAgenda = ({
  entries,
  filter,
  onFilterChange,
  today,
  loading,
}: CalendarAgendaProps) => {
  const days = groupCalendarDays(filterCalendarEntries(entries, filter));
  return (
    <Panel
      actions={
        <div aria-label="Show" className="flex gap-1" role="group">
          {CALENDAR_FILTERS.map((option) => (
            <Button
              aria-pressed={option === filter}
              key={option}
              onClick={() => onFilterChange(option)}
              size="sm"
              variant={option === filter ? "primary" : "outline"}
            >
              {CALENDAR_FILTER_LABELS[option]}
            </Button>
          ))}
        </div>
      }
      description="Times are New York (ET). Earnings dates are the days companies filed their results with the SEC."
      flush
      headingId="calendar-agenda"
      title="Agenda"
    >
      {loading ? (
        <p
          aria-busy="true"
          className="px-4 pt-3 text-muted-foreground text-sm"
          role="status"
        >
          Loading calendar…
        </p>
      ) : null}
      {days.length === 0 && !loading ? (
        <p className="p-4 text-muted-foreground text-sm" data-calendar-empty="">
          {EMPTY_TEXT[filter]}
        </p>
      ) : null}
      <div className="divide-y">
        {days.map((day) => (
          <section
            aria-labelledby={`calendar-day-${day.date}`}
            data-calendar-day={day.date}
            data-calendar-when={
              day.date === today
                ? "today"
                : day.date < today
                  ? "past"
                  : "upcoming"
            }
            key={day.date}
          >
            <h3
              className="flex items-center gap-2 px-4 pt-3 font-medium text-sm"
              id={`calendar-day-${day.date}`}
            >
              <time dateTime={day.date}>{formatCalendarDay(day.date)}</time>
              {day.date === today ? (
                <Badge variant="outline">Today</Badge>
              ) : null}
            </h3>
            <ul className="pb-2">
              {day.entries.map((entry) => (
                <EntryRow entry={entry} key={entry.key} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
};
