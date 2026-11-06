"use client";

import {
  type ApiClient,
  createApiClient,
  type GexIndexRow,
  type MarketContextOutput,
} from "@darkfactory/api";
import {
  Button,
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
import { ExternalLink, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TickerLink } from "../ticker-link.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  feedsSourceStatus,
  type MarketSourceStatus,
} from "./market-source-status.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Market feeds (card vertex-markets-gex-macro-news): GEX for SPY/QQQ, macro series and macro news from
// market-watch-bot on the rig (marketContext.get). Read-only public market data; it never acts on it.

export interface MarketFeedsGateway {
  readonly context: () => Promise<MarketContextOutput>;
}

export const createBrowserMarketFeedsGateway = (): MarketFeedsGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    context: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.marketContext.get({});
    },
  });
};

export const MARKET_FEEDS_REFRESH_MS = 60_000;

const SECTION_LABEL = { gex: "GEX", macro: "Macro", news: "News" } as const;

const when = (value: string | null): string =>
  value === null
    ? "unknown"
    : new Date(value).toLocaleString("en-US", {
        dateStyle: "short",
        timeStyle: "short",
      });

const COMPACT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

const num = (value: number | null, digits = 2): string =>
  value === null ? "—" : value.toFixed(digits);

const signed = (value: number | null, digits = 2): string =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

const dollars = (value: number | null): string =>
  value === null ? "—" : `$${COMPACT.format(value)}`;

const REGIME_TONE: Readonly<Record<string, "warning" | "success">> = {
  amplified: "warning",
  dampened: "success",
};

const AsOf = ({
  label,
  value,
}: Readonly<{ label: string; value: string | null }>) => (
  <span className="text-xs" data-as-of={label}>
    As of {when(value)}
  </span>
);

const GexRow = ({ row }: Readonly<{ row: GexIndexRow }>) => (
  <TableRow data-gex={row.symbol}>
    <TableHead scope="row">
      <TickerLink symbol={row.symbol} />
    </TableHead>
    <TableCell className="tabular-nums">{num(row.spot)}</TableCell>
    <TableCell className="tabular-nums">{dollars(row.netGex)}</TableCell>
    <TableCell>
      {row.regime === null ? (
        "—"
      ) : (
        <StatusBadge status={REGIME_TONE[row.regime] ?? "info"}>
          {row.regime}
        </StatusBadge>
      )}
    </TableCell>
    <TableCell className="tabular-nums">
      {num(row.flip)}
      {row.spotVsFlip === null ? "" : ` (spot ${row.spotVsFlip})`}
    </TableCell>
    <TableCell className="tabular-nums">
      {num(row.callWall)} / {num(row.putWall)}
    </TableCell>
    <TableCell className="whitespace-normal tabular-nums">
      {row.zeroDte === null
        ? "—"
        : `${row.zeroDte.expiry ?? "?"}: flip ${num(row.zeroDte.flip)}, walls ${num(row.zeroDte.callWall)} / ${num(row.zeroDte.putWall)}`}
    </TableCell>
  </TableRow>
);

const GexSection = ({ gex }: Readonly<{ gex: MarketContextOutput["gex"] }>) => (
  <Panel
    data-section="gex"
    {...(gex === null
      ? {}
      : { description: <AsOf label="gex" value={gex.asOf} /> })}
    flush
    headingId="mf-gex"
    title="Gamma exposure (GEX)"
  >
    {gex === null ? (
      <p className="p-4 text-muted-foreground text-sm">GEX not available.</p>
    ) : (
      <>
        <TableScroll label="GEX by index" minWidth="44rem">
          <Table className="text-sm">
            <TableCaption className="sr-only">GEX by index</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Index</TableHead>
                <TableHead scope="col">Spot</TableHead>
                <TableHead scope="col">Net GEX</TableHead>
                <TableHead scope="col">Regime</TableHead>
                <TableHead scope="col">Gamma flip</TableHead>
                <TableHead scope="col">Call / put wall</TableHead>
                <TableHead scope="col">Nearest expiry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gex.index.map((row) => (
                <GexRow key={row.symbol} row={row} />
              ))}
            </TableBody>
          </Table>
        </TableScroll>
        <div className="space-y-2 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">
            {gex.label ?? "Estimate"}
            {gex.oiSession === null
              ? ""
              : ` Open interest from ${gex.oiSession}.`}{" "}
            Net GEX is dollars per 1% move.
          </p>
          {gex.index.map((row) =>
            row.notes.length === 0 && row.fadeNote === null ? null : (
              <ul
                className="list-disc space-y-1 pl-5 text-sm"
                data-gex-notes={row.symbol}
                key={row.symbol}
              >
                {[
                  ...row.notes,
                  ...(row.fadeNote === null ? [] : [row.fadeNote]),
                ].map((note) => (
                  <li key={note}>
                    <TickerLink symbol={row.symbol} />: {note}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </>
    )}
  </Panel>
);

const MacroSection = ({
  macro,
}: Readonly<{ macro: MarketContextOutput["macro"] }>) => (
  <Panel
    data-section="macro"
    {...(macro === null
      ? {}
      : { description: <AsOf label="macro" value={macro.asOf} /> })}
    flush
    headingId="mf-macro"
    title="Macro"
  >
    {macro === null ? (
      <p className="p-4 text-muted-foreground text-sm">
        Macro data not available.
      </p>
    ) : (
      <>
        {macro.regimes.length === 0 ? null : (
          <ul
            className="flex flex-wrap gap-2 border-b px-4 py-3 text-sm"
            data-macro-regimes=""
          >
            {macro.regimes.map((regime) => (
              <li key={regime.id} title={regime.rule ?? undefined}>
                <StatusBadge status="neutral">
                  {regime.id}: {regime.label}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
        <TableScroll label="Macro series" minWidth="36rem">
          <Table className="text-sm">
            <TableCaption className="sr-only">Macro series</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Series</TableHead>
                <TableHead scope="col">Value</TableHead>
                <TableHead scope="col">Date</TableHead>
                <TableHead scope="col">1d / 1m</TableHead>
                <TableHead scope="col">1y percentile</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {macro.series.map((series) => (
                <TableRow data-macro={series.id} key={series.id}>
                  <TableHead className="whitespace-normal" scope="row">
                    {series.sourceUrl === null ? (
                      series.label
                    ) : (
                      <a
                        className="underline-offset-4 hover:underline"
                        href={series.sourceUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {series.label}
                      </a>
                    )}
                    {series.status === "ok" && !series.stale
                      ? ""
                      : ` (${series.stale ? "stale" : series.status})`}
                  </TableHead>
                  <TableCell className="tabular-nums">
                    {series.value === null
                      ? "—"
                      : `${series.value} ${series.units}`.trim()}
                  </TableCell>
                  <TableCell>{series.date ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">
                    {signed(series.change1d)} / {signed(series.change1m)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {num(series.pct1y, 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
        {macro.events.length === 0 ? null : (
          <div
            className="space-y-1 border-t px-4 py-3 text-sm"
            data-macro-events=""
          >
            <h3 className="font-medium">Next releases</h3>
            <ul className="space-y-1">
              {macro.events.map((event) => (
                <li key={`${event.date}-${event.name}`}>
                  {event.date}
                  {event.time === null ? "" : ` ${event.time}`}: {event.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    )}
  </Panel>
);

const NewsSection = ({
  news,
}: Readonly<{ news: MarketContextOutput["news"] }>) => (
  <Panel
    data-section="news"
    {...(news === null
      ? {}
      : { description: <AsOf label="news" value={news.asOf} /> })}
    headingId="mf-news"
    title="Macro news"
  >
    {news === null ? (
      <p className="text-muted-foreground text-sm">News not available.</p>
    ) : (
      <div className="space-y-3">
        {news.themes.length === 0 ? null : (
          <ul className="flex flex-wrap gap-2 text-sm" data-news-themes="">
            {news.themes.map((theme) => (
              <li className="max-w-full" data-theme={theme.id} key={theme.id}>
                <StatusBadge
                  className="max-w-full whitespace-normal text-left"
                  status={theme.shock ? "destructive" : "neutral"}
                >
                  {theme.label}: {theme.count24h} in 24 h, sentiment{" "}
                  {signed(theme.sentiment24h)}
                  {theme.shock ? ", shock" : ""}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
        {news.headlines.length === 0 ? (
          <p className="text-muted-foreground text-sm">No macro headlines.</p>
        ) : (
          <ul className="divide-y text-sm" data-news-headlines="">
            {news.headlines.map((headline) => (
              <li className="space-y-1 py-2" key={headline.url}>
                <a
                  className="inline-flex min-h-11 items-center gap-1 break-words font-medium underline-offset-4 hover:underline"
                  href={headline.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {headline.title}
                  <ExternalLink
                    aria-hidden="true"
                    className="size-3 shrink-0"
                  />
                </a>
                <p className="text-muted-foreground text-xs">
                  {[
                    headline.publisher,
                    when(headline.publishedAt),
                    headline.theme,
                    headline.sentiment === null
                      ? null
                      : `sentiment ${signed(headline.sentiment)}`,
                    headline.materiality === null
                      ? null
                      : `${headline.materiality} materiality`,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    )}
  </Panel>
);

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: MarketContextOutput }>;

export interface MarketFeedsWorkspaceProps {
  readonly gateway?: MarketFeedsGateway;
  /** Called with whether a load is in flight, so the page header can hold Refresh. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Called with the load state, for the page header chip. */
  readonly onStatusChange?: (status: MarketSourceStatus) => void;
  /** Each new value reloads now (the page header Refresh). */
  readonly refreshSignal?: number;
}

export const MarketFeedsWorkspace = ({
  gateway: supplied,
  onStatusChange,
  onBusyChange,
  refreshSignal = 0,
}: MarketFeedsWorkspaceProps) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserMarketFeedsGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [busy, setBusy] = useState(true);
  // Each load takes the next number; only the newest may write, so a slow older answer
  // (the timer, Refresh or Retry overlapping) never overwrites a newer one.
  const latest = useRef(0);
  const load = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    setBusy(true);
    try {
      const data = await gateway.context();
      if (request === latest.current) setState({ data, type: "ready" });
    } catch (error) {
      if (request !== latest.current) return;
      const failure = describePortfolioMonitorFailure(error);
      setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { message: `${failure.code}: ${failure.message}`, type: "error" }
      );
    } finally {
      if (request === latest.current) setBusy(false);
    }
  }, [gateway]);
  useEffect(() => {
    // refreshSignal is a dependency only so the header Refresh reloads now and restarts the timer.
    void refreshSignal;
    void load();
    const timer = window.setInterval(
      () => void load(),
      MARKET_FEEDS_REFRESH_MS
    );
    return () => {
      window.clearInterval(timer);
      // A Refresh restart or unmount drops the answer still in flight.
      latest.current += 1;
    };
  }, [load, refreshSignal]);
  const status: MarketSourceStatus =
    state.type === "ready" ? feedsSourceStatus(state.data) : state.type;
  useEffect(() => onStatusChange?.(status), [onStatusChange, status]);
  useEffect(() => onBusyChange?.(busy), [onBusyChange, busy]);

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="market-context" />;
  if (state.type === "loading")
    return (
      <p
        aria-busy="true"
        className="text-muted-foreground text-sm"
        role="status"
      >
        Loading GEX, macro and news…
      </p>
    );
  if (state.type === "error")
    return (
      <div className="space-y-3" data-feeds-state="error">
        <p className="text-sm" role="alert">
          GEX, macro and news unavailable. {state.message}
        </p>
        <Button disabled={busy} onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );

  const { data } = state;
  return (
    <div className="space-y-4" data-feeds-state="ready">
      <p className="text-muted-foreground text-xs" role="note">
        Public market data from market-watch-bot on the rig (QuantData, FRED,
        EIA, BLS, news feeds). Read-only; no account data. Pushed{" "}
        {when(data.generatedAt)}.
      </p>
      {data.stale ? (
        <p className="text-sm" data-feeds-stale="" role="alert">
          The rig has not pushed for more than 15 minutes. This data may be old.
        </p>
      ) : null}
      {data.missing.length === 0 ? null : (
        <p className="text-sm" data-feeds-missing="" role="alert">
          The rig could not read:{" "}
          {data.missing.map((section) => SECTION_LABEL[section]).join(", ")}.
        </p>
      )}
      <GexSection gex={data.gex} />
      <MacroSection macro={data.macro} />
      <NewsSection news={data.news} />
    </div>
  );
};
