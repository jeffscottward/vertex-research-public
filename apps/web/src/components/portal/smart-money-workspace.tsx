"use client";

import type {
  CongressTradesFeedOutput,
  OpenbbChanges13fOutput,
  OpenbbInsiderClustersOutput,
  OpenbbStatusOutput,
  SmartMoneyRankingOutput,
  SmartMoneyRankingRow,
  SmartMoneySessionWindow,
  SmartMoneySort,
} from "@darkfactory/api";
import {
  Button,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import {
  ListOrdered,
  RefreshCw,
  RotateCcw,
  Scale,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { writeQuery } from "./backtest-lab-query.ts";
import { describeResearchLensFailure } from "./research-lenses-client.ts";
import {
  createBrowserSmartMoneyGateway,
  type SmartMoneyGateway,
} from "./smart-money-client.ts";
import {
  ALL_TICKERS,
  DEFAULT_SESSIONS,
  DEFAULT_SORT,
  normalizeSmartMoneyTicker,
  SESSION_WINDOWS,
  type SmartMoneySettings,
  SORTS,
} from "./smart-money-params.ts";
import {
  type SectionLoadState,
  SmartMoney13fChangesPanel,
  SmartMoneyCongressPanel,
  SmartMoneyFreshnessStrip,
  SmartMoneyInsiderClustersPanel,
} from "./smart-money-sections.tsx";

// Smart money, PR 2: market-wide options premium from large trades (at least $100,000 each),
// summed per ticker from QuantData gainers-losers captures. The server ranks and filters.
// Research only: these lists are not trade signals, and nothing here places an order.

const selectClass =
  "h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm sm:w-44 sm:flex-none";
const inputClass =
  "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-sm uppercase placeholder:normal-case sm:w-28";
const linkClass =
  "inline-flex min-h-11 items-center font-mono underline-offset-2 hover:underline";
const numberCell = "whitespace-nowrap text-right font-mono text-xs";

type Coverage = SmartMoneyRankingOutput["coverage"];
type Session = SmartMoneyRankingOutput["sessions"][number];

type RankingState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; ranking: SmartMoneyRankingOutput }>;

const SORT_LABELS: Readonly<Record<SmartMoneySort, string>> = {
  net_bearish: "Net bearish",
  net_bullish: "Net bullish",
  total: "Total premium",
};

const STATUS_TEXT: Readonly<Record<NonNullable<Coverage["status"]>, string>> = {
  complete: "session complete",
  no_data: "no data for the session",
  partial: "session partial",
  unavailable: "QuantData could not supply the session",
};

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});
const SIGNED_COMPACT_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  signDisplay: "exceptZero",
  style: "currency",
});
const ET_TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "America/New_York",
});
const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

/** Compact US dollars, e.g. "$1.2M". */
export const formatPremium = (value: number): string =>
  COMPACT_USD.format(value);
/** Compact US dollars with a sign, e.g. "+$1.2M" or "-$450K"; zero has no sign. */
export const formatNetPremium = (value: number): string =>
  SIGNED_COMPACT_USD.format(value);

const etTime = (value: Date): string => `${ET_TIME.format(value)} ET`;

const sessionsLabel = (count: number): string =>
  `${count} ${count === 1 ? "session" : "sessions"}`;

const lastAttempt = (coverage: Coverage): readonly string[] =>
  coverage.lastAttemptAt === null || coverage.lastMessage === null
    ? []
    : [
        `last attempt ${etTime(coverage.lastAttemptAt)}: ${coverage.lastMessage}`,
      ];

const closedText = (newest: Session | undefined): readonly string[] =>
  newest === undefined
    ? ["QuantData", "market closed", "nothing stored yet"]
    : [
        "QuantData",
        "market closed",
        `newest session ${newest.sessionDate}`,
        `captured ${ET_DATE.format(newest.capturedAt)} ${etTime(newest.capturedAt)}`,
        STATUS_TEXT[newest.status],
      ];

/** One line on how current today's capture is, built from `coverage` and the newest session. */
export const coverageText = (
  ranking: Pick<SmartMoneyRankingOutput, "coverage" | "sessions">
): string => {
  const { coverage } = ranking;
  const { capturedAt, overdueSince, state, status } = coverage;
  if (state === "closed") return closedText(ranking.sessions[0]).join(" · ");
  if (state === "fresh" && capturedAt !== null)
    return [
      "QuantData, intraday",
      `captured ${etTime(capturedAt)}`,
      ...(status === null ? [] : [STATUS_TEXT[status]]),
    ].join(" · ");
  // The server names when the capture became overdue (coverage.overdueSince).
  if (state === "stale")
    return [
      overdueSince === null
        ? "Today's capture is overdue"
        : `Today's capture is overdue since ${etTime(overdueSince)}`,
      ...(capturedAt === null ? [] : [`last capture ${etTime(capturedAt)}`]),
      ...lastAttempt(coverage),
    ].join(" · ");
  return ["No capture yet today", ...lastAttempt(coverage)].join(" · ");
};

/** Which sessions the ranking sums, e.g. "3 of 5 sessions: 2026-10-28 to 2026-10-30". */
export const sessionsText = (
  sessions: readonly Session[],
  requested: SmartMoneySessionWindow
): string => {
  const [newest] = sessions;
  const oldest = sessions.at(-1);
  if (newest === undefined || oldest === undefined)
    return "No session stored yet";
  if (requested === 1) return `Session ${newest.sessionDate}, ${newest.status}`;
  const span =
    newest === oldest
      ? newest.sessionDate
      : `${oldest.sessionDate} to ${newest.sessionDate}`;
  const live = newest.status === "partial" ? ", newest partial" : "";
  return `${sessions.length} of ${sessionsLabel(requested)}: ${span}${live}`;
};

/** "History: 312 of 340 weekdays stored, 8 without data, 20 pending". */
export const historyText = (
  history: SmartMoneyRankingOutput["history"]
): string => {
  const count = (value: number) => value.toLocaleString("en-US");
  return `History: ${count(history.stored)} of ${count(history.weekdays)} weekdays stored, ${count(history.noData)} without data, ${count(history.pending)} pending`;
};

const RankingStatus = ({ state }: { readonly state: RankingState }) => {
  if (state.type === "loading")
    return <StatusBadge status="info">Loading</StatusBadge>;
  if (state.type === "error")
    return <StatusBadge status="destructive">Load failed</StatusBadge>;
  const count = state.ranking.totals.tickers;
  return (
    <StatusBadge status="neutral">
      {count.toLocaleString("en-US")} {count === 1 ? "ticker" : "tickers"}
    </StatusBadge>
  );
};

const RankingKpis = ({
  ranking,
  sessions,
}: {
  readonly ranking: SmartMoneyRankingOutput;
  readonly sessions: SmartMoneySessionWindow;
}) => {
  const over = `Over the newest ${sessionsLabel(sessions)}`;
  return (
    <KpiRow
      label={`Large-trade options premium, newest ${sessionsLabel(sessions)}`}
    >
      <KpiCard
        data-kpi="tickers"
        hint="With at least one large trade"
        icon={<ListOrdered />}
        label="Tickers"
        value={ranking.totals.tickers.toLocaleString("en-US")}
      />
      <KpiCard
        data-kpi="bullish"
        hint={over}
        icon={<TrendingUp />}
        label="Bullish premium"
        value={formatPremium(ranking.totals.bullishPremium)}
      />
      <KpiCard
        data-kpi="bearish"
        hint={over}
        icon={<TrendingDown />}
        label="Bearish premium"
        value={formatPremium(ranking.totals.bearishPremium)}
      />
      <KpiCard
        data-kpi="net"
        hint="Bullish minus bearish"
        icon={<Scale />}
        label="Net premium"
        value={formatNetPremium(ranking.totals.netPremium)}
      />
    </KpiRow>
  );
};

const RankingTable = ({
  rows,
  showSessions,
  sort,
}: {
  readonly rows: readonly SmartMoneyRankingRow[];
  readonly showSessions: boolean;
  readonly sort: SmartMoneySort;
}) => (
  <TableScroll label="Smart money ranking" minWidth="52rem">
    <Table className="w-full text-sm">
      <TableCaption className="sr-only">
        Tickers ranked by large-trade options premium, sorted by{" "}
        {SORT_LABELS[sort].toLowerCase()}
      </TableCaption>
      <TableHeader>
        <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
          <TableHead scope="col">Rank</TableHead>
          <TableHead scope="col">Ticker</TableHead>
          <TableHead className="text-right" scope="col">
            Bullish
          </TableHead>
          <TableHead className="text-right" scope="col">
            Bearish
          </TableHead>
          <TableHead className="text-right" scope="col">
            Net
          </TableHead>
          <TableHead className="text-right" scope="col">
            Total
          </TableHead>
          <TableHead className="text-right" scope="col">
            Trades
          </TableHead>
          <TableHead className="text-right" scope="col">
            Volume
          </TableHead>
          {showSessions ? (
            <TableHead className="text-right" scope="col">
              Sessions
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            className="border-border border-b align-middle"
            key={row.ticker}
          >
            <TableCell className="font-mono text-xs">{row.rank}</TableCell>
            <TableHead
              className="h-auto whitespace-normal text-left font-medium"
              scope="row"
            >
              <a
                aria-label={`Open ${row.ticker} stock page`}
                className={linkClass}
                href={`/stock/${encodeURIComponent(row.ticker)}`}
              >
                {row.ticker}
              </a>
            </TableHead>
            <TableCell className={numberCell}>
              {formatPremium(row.bullishPremium)}
            </TableCell>
            <TableCell className={numberCell}>
              {formatPremium(row.bearishPremium)}
            </TableCell>
            <TableCell className={numberCell}>
              {formatNetPremium(row.netPremium)}
            </TableCell>
            <TableCell className={numberCell}>
              {formatPremium(row.premium)}
            </TableCell>
            <TableCell className={numberCell}>
              {row.tradeCount.toLocaleString("en-US")}
            </TableCell>
            <TableCell className={numberCell}>
              {row.volume.toLocaleString("en-US")}
            </TableCell>
            {showSessions ? (
              <TableCell className={numberCell}>
                {row.sessionsPresent}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const RankingBody = ({
  ranking,
  settings,
}: {
  readonly ranking: SmartMoneyRankingOutput;
  readonly settings: SmartMoneySettings;
}) => {
  const { rows } = ranking;
  const stale = ranking.coverage.state === "stale";
  return (
    // Named region for the loaded ranking only, so "Smart money ranking" means the answer has arrived.
    <section aria-label="Smart money ranking">
      <ul
        aria-label="Data coverage"
        className="space-y-1 border-b px-4 py-2 text-xs"
      >
        <li>
          {/* The coverage text can be longer than a phone line: let it wrap. */}
          <StatusBadge
            className="h-auto max-w-full whitespace-normal rounded-md text-left"
            status={stale ? "warning" : "neutral"}
          >
            {coverageText(ranking)}
          </StatusBadge>
        </li>
        <li className="text-muted-foreground">
          {sessionsText(ranking.sessions, settings.sessions)}
        </li>
        <li className="text-muted-foreground">
          {historyText(ranking.history)}
        </li>
      </ul>
      <div className="border-b p-4">
        <RankingKpis ranking={ranking} sessions={settings.sessions} />
      </div>
      {rows.length === 0 ? (
        <p className="p-4 text-sm">
          {settings.ticker === ALL_TICKERS
            ? "No large-trade premium stored yet."
            : `No large-trade premium stored for ${settings.ticker} in the newest ${sessionsLabel(settings.sessions)}.`}
        </p>
      ) : (
        <>
          <p
            className="border-b px-4 py-2 text-muted-foreground text-xs"
            role="status"
          >
            Top {rows.length.toLocaleString("en-US")} of{" "}
            {ranking.totals.tickers.toLocaleString("en-US")}{" "}
            {ranking.totals.tickers === 1 ? "ticker" : "tickers"}, sorted by{" "}
            {SORT_LABELS[settings.sort].toLowerCase()}
          </p>
          <RankingTable
            rows={rows}
            showSessions={settings.sessions > 1}
            sort={settings.sort}
          />
        </>
      )}
      <p className="border-t px-4 py-2 text-muted-foreground text-xs">
        Source: {ranking.source} · Delay: {ranking.delay} · Read{" "}
        {etTime(ranking.receivedAt)}
      </p>
    </section>
  );
};

export interface SmartMoneyWorkspaceProps {
  readonly gateway?: SmartMoneyGateway;
  /** Settings restored from the URL (`?sessions=&sort=&ticker=`); the workspace keeps the URL in sync. */
  readonly initial?: SmartMoneySettings;
}

export const SmartMoneyWorkspace = ({
  gateway: suppliedGateway,
  initial,
}: SmartMoneyWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserSmartMoneyGateway()
  );
  const [settings, setSettings] = useState<SmartMoneySettings>(() => ({
    sessions: initial?.sessions ?? DEFAULT_SESSIONS,
    sort: initial?.sort ?? DEFAULT_SORT,
    ticker: initial?.ticker ?? ALL_TICKERS,
  }));
  const [tickerDraft, setTickerDraft] = useState(settings.ticker);
  const [congressPurchasesOnly, setCongressPurchasesOnly] = useState(true);
  const [state, setState] = useState<RankingState>({ type: "loading" });
  const [statusState, setStatusState] = useState<
    SectionLoadState<OpenbbStatusOutput>
  >({ type: "loading" });
  const [insidersState, setInsidersState] = useState<
    SectionLoadState<OpenbbInsiderClustersOutput>
  >({ type: "loading" });
  const [congressState, setCongressState] = useState<
    SectionLoadState<CongressTradesFeedOutput>
  >({ type: "loading" });
  const [changes13fState, setChanges13fState] = useState<
    SectionLoadState<OpenbbChanges13fOutput>
  >({ type: "loading" });
  const latest = useRef(0);
  const latestStatus = useRef(0);
  const latestInsiders = useRef(0);
  const latestCongress = useRef(0);
  const latest13f = useRef(0);

  const load = useCallback(
    async (query: SmartMoneySettings) => {
      latest.current += 1;
      const request = latest.current;
      setState({ type: "loading" });
      const next: RankingState = await gateway.ranking(query).then(
        (loaded) => ({ ranking: loaded, type: "ready" }),
        (error: unknown) => ({
          message: describeResearchLensFailure(error),
          type: "error",
        })
      );
      // A newer filter choice wins over a slower, older response.
      if (request !== latest.current) return;
      setState(next);
    },
    [gateway]
  );

  const runSection = useCallback(
    async <T,>(
      ref: { current: number },
      set: (next: SectionLoadState<T>) => void,
      loader: () => Promise<T>
    ) => {
      ref.current += 1;
      const request = ref.current;
      set({ type: "loading" });
      let next: SectionLoadState<T>;
      try {
        next = { data: await loader(), type: "ready" };
      } catch (error: unknown) {
        next = { message: describeResearchLensFailure(error), type: "error" };
      }
      if (request !== ref.current) return;
      set(next);
    },
    []
  );

  const loadStatus = useCallback(() => {
    const fn = gateway.status;
    if (fn !== undefined) void runSection(latestStatus, setStatusState, fn);
  }, [gateway, runSection]);

  const loadInsiders = useCallback(
    (ticker: string) => {
      const fn = gateway.insiderClusters;
      if (fn !== undefined)
        void runSection(latestInsiders, setInsidersState, () => fn(ticker));
    },
    [gateway, runSection]
  );

  const loadCongress = useCallback(
    (ticker: string) => {
      const fn = gateway.congressFeed;
      if (fn !== undefined)
        void runSection(latestCongress, setCongressState, () => fn(ticker));
    },
    [gateway, runSection]
  );

  const loadChanges13f = useCallback(
    (ticker: string) => {
      const fn = gateway.changes13f;
      if (fn !== undefined)
        void runSection(latest13f, setChanges13fState, () => fn(ticker));
    },
    [gateway, runSection]
  );

  useEffect(() => {
    void load(settings);
    return;
  }, [load, settings]);

  useEffect(() => {
    void loadStatus();
    return;
  }, [loadStatus]);

  useEffect(() => {
    void loadInsiders(settings.ticker);
    void loadCongress(settings.ticker);
    void loadChanges13f(settings.ticker);
    return;
  }, [loadInsiders, loadCongress, loadChanges13f, settings.ticker]);

  useEffect(() => {
    // Only this page's keys change; foreign params such as ?theme= survive.
    writeQuery(settings, {
      sessions: DEFAULT_SESSIONS,
      sort: DEFAULT_SORT,
      ticker: ALL_TICKERS,
    });
  }, [settings]);

  const update = (changes: Partial<SmartMoneySettings>) =>
    setSettings((current) => ({ ...current, ...changes }));

  const applyTicker = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ticker = normalizeSmartMoneyTicker(tickerDraft);
    setTickerDraft(ticker);
    if (ticker !== settings.ticker) update({ ticker });
  };

  const ranking = state.type === "ready" ? state.ranking : null;

  const controls = (
    <div className="flex w-full flex-wrap items-center gap-3">
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Sessions</span>
        <select
          className={selectClass}
          onChange={(event) =>
            update({
              sessions: Number(event.target.value) as SmartMoneySessionWindow,
            })
          }
          value={settings.sessions}
        >
          {SESSION_WINDOWS.map((span) => (
            <option key={span} value={span}>
              {sessionsLabel(span)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex w-full items-center gap-2 text-sm sm:w-auto">
        <span>Sort</span>
        <select
          className={selectClass}
          onChange={(event) =>
            update({ sort: event.target.value as SmartMoneySort })
          }
          value={settings.sort}
        >
          {SORTS.map((name) => (
            <option key={name} value={name}>
              {SORT_LABELS[name]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  const refreshAll = () => {
    void load(settings);
    void loadStatus();
    void loadInsiders(settings.ticker);
    void loadCongress(settings.ticker);
    void loadChanges13f(settings.ticker);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={state.type === "loading"}
            onClick={refreshAll}
            size="sm"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        description="Market-wide lists of where large traders, insiders, Congress members, and 13F filers put their money, each with its own delay. No blended score and no trade signals."
        status={<RankingStatus state={state} />}
        title="Smart money"
      />

      {gateway.status === undefined ? null : (
        <SmartMoneyFreshnessStrip state={statusState} />
      )}

      <form
        aria-label="Ticker filter"
        className="flex w-full flex-wrap items-center gap-2 text-sm"
        onSubmit={applyTicker}
      >
        <label className="flex min-w-0 items-center gap-2">
          <span>Ticker</span>
          <input
            autoCapitalize="characters"
            className={inputClass}
            maxLength={16}
            onChange={(event) => setTickerDraft(event.target.value)}
            placeholder="All"
            spellCheck={false}
            type="text"
            value={tickerDraft}
          />
        </label>
        <Button className="min-h-11" size="sm" type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <Panel
        flush
        headingId="smart-money-premium-heading"
        title="Large options trades (QuantData)"
      >
        <div className="border-b px-4 py-3">{controls}</div>
        {state.type === "loading" ? (
          <p
            aria-busy="true"
            className="p-4 text-muted-foreground text-sm"
            role="status"
          >
            Loading ranking…
          </p>
        ) : null}
        {state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">Ranking not loaded: {state.message}</p>
            <Button
              className="min-h-11"
              onClick={() => void load(settings)}
              size="sm"
              variant="secondary"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Try again
            </Button>
          </div>
        ) : null}
        {ranking === null ? null : (
          <RankingBody ranking={ranking} settings={settings} />
        )}
        <p className="border-t px-4 py-3 text-muted-foreground text-xs">
          Premium is the dollar value of option trades of at least $100,000
          each, summed per ticker. Bullish and bearish follow the trade side
          QuantData reports; net is bullish minus bearish. A ranking shows where
          large money traded, not why. Research only; not a trade signal; no
          orders.
        </p>
      </Panel>

      {gateway.insiderClusters === undefined ? (
        <p className="text-sm">
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            href="/insider-clusters"
          >
            Insider cluster buys (SEC Form 4)
          </a>
        </p>
      ) : (
        <SmartMoneyInsiderClustersPanel
          onRetry={() => void loadInsiders(settings.ticker)}
          state={insidersState}
          ticker={settings.ticker}
        />
      )}

      {gateway.congressFeed === undefined ? null : (
        <SmartMoneyCongressPanel
          onModeChange={setCongressPurchasesOnly}
          onRetry={() => void loadCongress(settings.ticker)}
          purchasesOnly={congressPurchasesOnly}
          state={congressState}
          ticker={settings.ticker}
        />
      )}

      {gateway.changes13f === undefined ? null : (
        <SmartMoney13fChangesPanel
          onRetry={() => void loadChanges13f(settings.ticker)}
          state={changes13fState}
          ticker={settings.ticker}
        />
      )}
    </div>
  );
};
