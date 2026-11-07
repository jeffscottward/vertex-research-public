"use client";

// What: the "Widgets" grid on Mission control: compact Watchlist, Next economic events, Journal
// summary and Market context cards. The user shows/hides and reorders them; the layout is saved
// in this browser (localStorage). Read-only: no widget acts on the data it shows.
// See: dashboard-widgets-model.ts (layout, picks), trade-journal-client.ts (useLoadOnce).
import {
  type ApiClient,
  createApiClient,
  type MarketContextOutput,
  type PortfolioMonitorOutput,
  type WatchlistItemOutput,
} from "@darkfactory/api";
import { Button, Panel, StatusBadge } from "@darkfactory/ui";
import { ArrowDown, ArrowUp, Eye, EyeOff, Settings2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";

import { TickerLink } from "../ticker-link.tsx";
import { easternDate } from "./calendar-model.ts";
import {
  DASHBOARD_WIDGETS,
  type DashboardWidgetId,
  DEFAULT_WIDGET_LAYOUT,
  marketHeadline,
  moveWidget,
  normalizeWidgetLayout,
  toggleWidget,
  upcomingEvents,
  WIDGETS_STORAGE_KEY,
} from "./dashboard-widgets-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";
import { useStoredState } from "./portfolio-monitor-controls.tsx";
import {
  type JournalSnapshotLoader,
  type JournalSource,
  journalSnapshotFor,
  type LoadState,
  useLoadOnce,
} from "./trade-journal-client.ts";
import {
  formatPercent,
  formatSignedMoney,
  journalKpis,
  latestExecutions,
  pnlTextClass,
} from "./trade-journal-model.ts";
import { describeWatchlistFailure } from "./watchlist-client.ts";

export interface DashboardWidgetsGateway {
  /** null: the server has no snapshot service; the journal widget sends nothing. */
  readonly journal: JournalSnapshotLoader | null;
  readonly marketContext: () => Promise<MarketContextOutput>;
  readonly watchlist: () => Promise<readonly WatchlistItemOutput[]>;
}

export const createDashboardWidgetsGateway = (
  client: () => ApiClient,
  journalSource: JournalSource | null
): DashboardWidgetsGateway =>
  Object.freeze({
    journal:
      journalSource === null
        ? null
        : () => journalSnapshotFor(client(), journalSource)(),
    marketContext: () => client().marketContext.get({}),
    watchlist: async () => (await client().watchlist.list({})).items,
  });

/** One API client, created on the first request in the browser. */
export const createBrowserDashboardWidgetsGateway = (
  journalSource: JournalSource | null
): DashboardWidgetsGateway => {
  let client: ApiClient | undefined;
  return createDashboardWidgetsGateway(() => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  }, journalSource);
};

const TOP_SYMBOLS = 5;

const Muted = ({ children }: Readonly<{ children: ReactNode }>) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);

const OpenLink = ({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) => (
  <Link
    className="inline-flex min-h-11 items-center text-sm underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    href={href}
    prefetch={false}
  >
    {children}
  </Link>
);

/** Loading and failure lines shared by every widget; `ready` renders the data. Idle states
 * never reach it: the journal widget handles its own (not configured). */
const LoadBody = <T,>({
  state,
  describe,
  ready,
}: Readonly<{
  state: LoadState<T>;
  describe: (error: unknown) => string;
  ready: (value: T) => ReactNode;
}>) => {
  if (state.type === "ready") return ready(state.value);
  if (state.type === "error")
    return (
      <p className="text-destructive text-sm" role="status">
        {describe(state.error)}
      </p>
    );
  // Hidden widgets are not rendered, so the remaining state here is "loading".
  return <Muted>Loading…</Muted>;
};

const describeSnapshotFailure = (error: unknown): string => {
  const failure = describePortfolioMonitorFailure(error);
  return failure.kind === "forbidden"
    ? "Operator access required."
    : `Unavailable (${failure.code}): ${failure.message}`;
};

const WatchlistWidget = ({
  state,
}: Readonly<{ state: LoadState<readonly WatchlistItemOutput[]> }>) => (
  <LoadBody
    describe={describeWatchlistFailure}
    ready={(items) =>
      items.length === 0 ? (
        <Muted>No symbols yet.</Muted>
      ) : (
        <div className="space-y-2">
          <p className="font-semibold text-2xl tabular-nums">
            {items.length}
            <span className="ml-1 font-normal text-muted-foreground text-sm">
              {items.length === 1 ? "symbol" : "symbols"}
            </span>
          </p>
          <ul
            aria-label="Top watchlist symbols"
            className="flex flex-wrap gap-2"
          >
            {items.slice(0, TOP_SYMBOLS).map((item) => (
              <li key={item.id}>
                <TickerLink symbol={item.symbol} />
              </li>
            ))}
          </ul>
        </div>
      )
    }
    state={state}
  />
);

const EventsWidget = ({
  state,
  today,
}: Readonly<{ state: LoadState<MarketContextOutput>; today: string }>) => (
  <LoadBody
    describe={describeSnapshotFailure}
    ready={(context) => {
      if (context.macro === null)
        return <Muted>Macro data was missing from the last rig push.</Muted>;
      const events = upcomingEvents(context.macro.events, today);
      if (events.length === 0) return <Muted>No upcoming events listed.</Muted>;
      return (
        <ul className="space-y-1 text-sm">
          {events.map((event) => (
            <li
              className="flex justify-between gap-2"
              key={`${event.date}-${event.time}-${event.name}`}
            >
              <span className="min-w-0 truncate">{event.name}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {event.time === null
                  ? event.date
                  : `${event.date} ${event.time}`}
              </span>
            </li>
          ))}
        </ul>
      );
    }}
    state={state}
  />
);

const JournalWidget = ({
  state,
}: Readonly<{ state: LoadState<PortfolioMonitorOutput> }>) => {
  if (state.type === "idle")
    return (
      <Muted>Not configured: the server has no IBKR snapshot service.</Muted>
    );
  return (
    <LoadBody
      describe={describeSnapshotFailure}
      ready={(snapshot) => {
        const kpis = journalKpis(latestExecutions(snapshot.executions));
        return (
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Fills</dt>
              <dd className="font-semibold tabular-nums">{kpis.fills}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Realized</dt>
              <dd
                className={`font-semibold tabular-nums ${pnlTextClass(kpis.realized)}`}
              >
                {formatSignedMoney(kpis.realized)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Win rate</dt>
              <dd className="font-semibold tabular-nums">
                {formatPercent(kpis.winRate)}
              </dd>
            </div>
          </dl>
        );
      }}
      state={state}
    />
  );
};

const MarketWidget = ({
  state,
}: Readonly<{ state: LoadState<MarketContextOutput> }>) => (
  <LoadBody
    describe={describeSnapshotFailure}
    ready={(context) => {
      const headline = marketHeadline(context);
      return (
        <div className="space-y-2 text-sm">
          {context.stale ? (
            <StatusBadge status="warning">Stale</StatusBadge>
          ) : null}
          {headline === null ? (
            <Muted>No headline in the last rig push.</Muted>
          ) : headline.type === "news" ? (
            <p>
              <a
                className="underline-offset-4 hover:underline"
                href={headline.headline.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {headline.headline.title}
              </a>
              {headline.headline.publisher === null ? null : (
                <span className="text-muted-foreground">
                  {` · ${headline.headline.publisher}`}
                </span>
              )}
            </p>
          ) : (
            <p data-headline="gex">{headline.label}</p>
          )}
        </div>
      );
    }}
    state={state}
  />
);

const WIDGET_LINKS: Readonly<
  Record<DashboardWidgetId, Readonly<{ href: string; label: string }>>
> = Object.freeze({
  events: { href: "/markets", label: "Market context" },
  journal: { href: "/journal", label: "Open journal" },
  market: { href: "/markets", label: "Market context" },
  watchlist: { href: "/watchlist", label: "Open watchlist" },
});

export interface DashboardWidgetsProps {
  /** Test seam; defaults to the browser API client. */
  readonly gateway?: DashboardWidgetsGateway;
  /** From the server environment (resolveJournalSource). */
  readonly journalSource: JournalSource | null;
  /** Test seam for "today" (upcoming events). */
  readonly now?: () => Date;
  /** Non-operators only get the Watchlist widget, so no operator-only request is sent. */
  readonly operator: boolean;
}

/** A read that waits for the one before it shows as loading, not as idle (not configured). */
const waitFor = <T,>(started: boolean, state: LoadState<T>): LoadState<T> =>
  started ? state : { type: "loading" };

/** Answered (data or failure); a read whose load was just handed over is still "idle". */
const settled = (state: LoadState<unknown>): boolean =>
  state.type === "ready" || state.type === "error";

export const DashboardWidgets = ({
  journalSource,
  operator,
  gateway: supplied,
  now = () => new Date(),
}: DashboardWidgetsProps) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserDashboardWidgetsGateway(journalSource)
  );
  const [layout, setLayout] = useStoredState(
    WIDGETS_STORAGE_KEY,
    normalizeWidgetLayout
  );
  const [customizing, setCustomizing] = useState(false);
  const available = layout.order.filter(
    (id) => operator || !DASHBOARD_WIDGETS[id].operatorOnly
  );
  const visible = available.filter((id) => !layout.hidden.includes(id));
  const shown = (id: DashboardWidgetId) => visible.includes(id);

  // One widget read at a time, after each other: Mission control's own cards already read in
  // parallel, and the request database admits a bounded number of connections per isolate
  // (packages/db REQUEST_DATABASE_POOL_MAX_CONNECTIONS), so three more parallel reads pushed a
  // page load over the cap (HTTP 503) under load.
  const watchlist = useLoadOnce(shown("watchlist") ? gateway.watchlist : null);
  const afterWatchlist = !shown("watchlist") || settled(watchlist);
  const needsMarketContext = shown("events") || shown("market");
  const marketContext = waitFor(
    afterWatchlist,
    useLoadOnce(
      afterWatchlist && needsMarketContext ? gateway.marketContext : null
    )
  );
  const afterMarketContext =
    afterWatchlist && (!needsMarketContext || settled(marketContext));
  const journal = waitFor(
    afterMarketContext,
    useLoadOnce(afterMarketContext && shown("journal") ? gateway.journal : null)
  );

  const content: Readonly<Record<DashboardWidgetId, ReactNode>> = {
    events: <EventsWidget state={marketContext} today={easternDate(now())} />,
    journal: <JournalWidget state={journal} />,
    market: <MarketWidget state={marketContext} />,
    watchlist: <WatchlistWidget state={watchlist} />,
  };

  return (
    <section aria-labelledby="dashboard-widgets" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-base" id="dashboard-widgets">
          Widgets
        </h2>
        <Button
          aria-controls="dashboard-widgets-customize"
          aria-expanded={customizing}
          onClick={() => setCustomizing((open) => !open)}
          size="sm"
          variant="outline"
        >
          <Settings2 aria-hidden="true" className="size-4" />
          {customizing ? "Done" : "Customize"}
        </Button>
      </div>
      {customizing ? (
        <div
          className="space-y-2 rounded-md border border-border p-3"
          id="dashboard-widgets-customize"
        >
          <ul aria-label="Widget order and visibility" className="space-y-1">
            {available.map((id, index) => {
              const { title } = DASHBOARD_WIDGETS[id];
              const hidden = layout.hidden.includes(id);
              return (
                <li
                  className="flex items-center justify-between gap-2"
                  data-widget-control={id}
                  key={id}
                >
                  <span
                    className={
                      hidden ? "text-muted-foreground text-sm" : "text-sm"
                    }
                  >
                    {title}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      aria-label={`${hidden ? "Show" : "Hide"} ${title}`}
                      aria-pressed={!hidden}
                      onClick={() => setLayout(toggleWidget(layout, id))}
                      size="icon-sm"
                      variant="ghost"
                    >
                      {hidden ? (
                        <EyeOff aria-hidden="true" />
                      ) : (
                        <Eye aria-hidden="true" />
                      )}
                    </Button>
                    <Button
                      aria-label={`Move ${title} up`}
                      disabled={index === 0}
                      onClick={() =>
                        setLayout(moveWidget(layout, id, -1, available))
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      aria-label={`Move ${title} down`}
                      disabled={index === available.length - 1}
                      onClick={() =>
                        setLayout(moveWidget(layout, id, 1, available))
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          <Button
            onClick={() => setLayout(DEFAULT_WIDGET_LAYOUT)}
            size="sm"
            variant="ghost"
          >
            Reset to default
          </Button>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <Muted>All widgets are hidden. Use Customize to show them.</Muted>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {visible.map((id) => (
            <li data-widget={id} key={id}>
              <Panel
                actions={
                  <OpenLink href={WIDGET_LINKS[id].href}>
                    {WIDGET_LINKS[id].label}
                  </OpenLink>
                }
                className="h-full"
                headingLevel={3}
                title={DASHBOARD_WIDGETS[id].title}
              >
                {content[id]}
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
