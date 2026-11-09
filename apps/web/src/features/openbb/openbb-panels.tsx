"use client";

import type {
  OpenbbCotOutput,
  OpenbbEventsOutput,
  OpenbbMacroOutput,
  OpenbbSecOutput,
  OpenbbShortsOutput,
  OpenbbVolContextOutput,
} from "@darkfactory/api";
import {
  Panel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
} from "@darkfactory/ui";
import { type ReactNode, useEffect, useState } from "react";

import { describePortfolioMonitorFailure } from "../../components/portal/portfolio-monitor-client.ts";
import { createBrowserOpenbbGateway, type OpenbbGateway } from "./gateway.ts";
import {
  COT_CHANGE_WEEKS,
  COT_REQUEST_WEEKS,
  cotSummary,
  EVENTS_AHEAD_DAYS,
  formatCompact,
  formatMacroValue,
  formatNumber,
  formatPercent,
  formatSignedCompact,
  ivTableRows,
  MACRO_HISTORY_DAYS,
  MISSING,
  macroRows,
  NOT_COLLECTED,
  newestDate,
  nyDate,
  otcWeeks,
  recentShortVolume,
  upcomingEvents,
  vxCurveRows,
} from "./view-model.ts";

// OpenBB panels (docs/vertex-rebuild/openbb.md): /markets "Vol, positioning and macro", the /flow
// short and off-exchange panel and the /stock/[symbol] filings tab. Read-only research views of
// public Cboe, CFTC, Fed, Treasury, FINRA and SEC data; never a trade signal.

type Load<T> =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: T }>;

/** Runs `load` once per key; a newer key or unmount drops an older answer. */
const useLoad = <T,>(load: () => Promise<T>, key: string): Load<T> => {
  const [state, setState] = useState<Load<T>>({ type: "loading" });
  // `key` names the request; `load` is rebuilt every render, so it is not a dependency.
  useEffect(() => {
    let active = true;
    setState({ type: "loading" });
    load().then(
      (data) => {
        if (active) setState({ data, type: "ready" });
      },
      (error: unknown) => {
        if (!active) return;
        const failure = describePortfolioMonitorFailure(error);
        setState({
          message:
            failure.kind === "forbidden"
              ? failure.message
              : `${failure.code}: ${failure.message}`,
          type: "error",
        });
      }
    );
    return () => {
      active = false;
    };
  }, [key]);
  return state;
};

const Status = ({
  state,
  what,
}: Readonly<{ state: Load<unknown>; what: string }>) =>
  state.type === "loading" ? (
    <p aria-busy="true" className="text-muted-foreground text-sm">
      Loading {what}…
    </p>
  ) : (
    <p className="text-sm" data-openbb-error="" role="alert">
      {what} unavailable. {(state as { message: string }).message}
    </p>
  );

const AsOf = ({ date }: Readonly<{ date: string | null }>) => (
  <span className="text-xs" data-as-of="">
    {date === null ? NOT_COLLECTED : `As of ${date}`}
  </span>
);

type Column<Row> = readonly [label: string, cell: (row: Row) => ReactNode];

const DataTable = <Row,>({
  caption,
  columns,
  rows,
  rowKey,
}: Readonly<{
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
}>) =>
  rows.length === 0 ? (
    <p className="p-4 text-muted-foreground text-sm" data-empty="">
      {NOT_COLLECTED}
    </p>
  ) : (
    <TableScroll label={caption} minWidth="32rem">
      <Table className="text-sm">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map(([label]) => (
              <TableHead key={label} scope="col">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map(([label, cell]) => (
                <TableCell className="tabular-nums" key={label}>
                  {cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  );

const Block = ({
  children,
  date,
  id,
  title,
}: Readonly<{
  children: ReactNode;
  date: string | null;
  id: string;
  title: string;
}>) => (
  <Panel
    data-openbb-block={id}
    description={<AsOf date={date} />}
    flush
    headingId={`openbb-${id}`}
    title={title}
  >
    {children}
  </Panel>
);

type MarketsData = Readonly<{
  vol: OpenbbVolContextOutput;
  cot: OpenbbCotOutput;
  macro: OpenbbMacroOutput;
  events: OpenbbEventsOutput;
  today: string;
}>;

const VOL_STRIP = ["VIX9D", "VIX", "VIX3M", "VIX6M", "VVIX", "SKEW"] as const;

const MarketsBlocks = ({ data }: Readonly<{ data: MarketsData }>) => {
  const { vol } = data;
  const strip = VOL_STRIP.map(
    (id) => vol.indices.find((index) => index.id === id) ?? null
  ).filter((index) => index !== null);
  const curve = vxCurveRows(vol.vxCurve);
  const iv = ivTableRows(vol.ivDaily);
  const cot = cotSummary(data.cot.rows);
  const macro = macroRows(data.macro.series);
  const events = upcomingEvents(data.events.events, data.today);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Block
        date={newestDate(strip.map((index) => index.date))}
        id="vol-strip"
        title="Vol index term strip"
      >
        {strip.length === 0 ? (
          <p className="p-4 text-muted-foreground text-sm" data-empty="">
            {NOT_COLLECTED}
          </p>
        ) : (
          <div className="space-y-3 p-4">
            <dl className="flex flex-wrap gap-4">
              {strip.map((index) => (
                <div data-vol-index={index.id} key={index.id}>
                  <dt className="text-muted-foreground text-xs">{index.id}</dt>
                  <dd className="font-medium tabular-nums">
                    {formatNumber(index.close)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm tabular-nums" data-vol-ratios="">
              VIX9D/VIX {formatNumber(vol.ratios.vix9dVix, 3)} · VIX/VIX3M{" "}
              {formatNumber(vol.ratios.vixVix3m, 3)} · VIX3M/VIX6M{" "}
              {formatNumber(vol.ratios.vix3mVix6m, 3)}
            </p>
          </div>
        )}
      </Block>
      <Block
        date={vol.vxCurve.latest?.asOf ?? null}
        id="vx-curve"
        title="VX futures curve"
      >
        <DataTable
          caption="VX curve, latest and 5 sessions earlier"
          columns={[
            ["Contract", (row) => row.contractMonth],
            ["Latest", (row) => formatNumber(row.latest)],
            [
              `5 sessions earlier${vol.vxCurve.earlier === null ? "" : ` (${vol.vxCurve.earlier.asOf})`}`,
              (row) => formatNumber(row.earlier),
            ],
            ["Change", (row) => formatNumber(row.change)],
          ]}
          rowKey={(row) => row.contractMonth}
          rows={curve}
        />
      </Block>
      <Block
        date={newestDate(iv.map((row) => row.asOf))}
        id="iv"
        title="Core 7 implied volatility"
      >
        <DataTable
          caption="Core 7 IV"
          columns={[
            ["ETF", (row) => row.underlying],
            ["ATM IV 30d", (row) => formatPercent(row.atmIv30d)],
            [
              "IV pctl",
              (row) =>
                row.ivPercentile === null
                  ? `${MISSING} (${row.sessions} sessions)`
                  : formatNumber(row.ivPercentile, 0),
            ],
            ["25d skew", (row) => formatPercent(row.skew25d)],
            ["Gamma flip", (row) => formatNumber(row.gammaFlip)],
            [
              "Call / put wall",
              (row) =>
                `${formatNumber(row.callWall)} / ${formatNumber(row.putWall)}`,
            ],
          ]}
          rowKey={(row) => row.underlying}
          rows={iv}
        />
      </Block>
      <Block
        date={newestDate(cot.map((row) => row.reportDate))}
        id="cot"
        title="COT net positioning"
      >
        <DataTable
          caption="COT net positioning"
          columns={[
            ["Market", (row) => row.market],
            ["Category", (row) => row.category.replace("_", " ")],
            ["Net", (row) => formatSignedCompact(row.net)],
            [
              `${COT_CHANGE_WEEKS}-week change`,
              (row) => formatSignedCompact(row.change),
            ],
          ]}
          rowKey={(row) => row.market}
          rows={cot}
        />
      </Block>
      <Block
        date={newestDate(
          macro.flatMap((row) => (row.asOf === null ? [] : [row.asOf]))
        )}
        id="macro"
        title="Macro regime"
      >
        <DataTable
          caption="Macro regime"
          columns={[
            ["Series", (row) => row.id],
            ["Name", (row) => row.name],
            ["Value", (row) => formatMacroValue(row.value, row.unit)],
            ["As of", (row) => row.asOf ?? MISSING],
          ]}
          rowKey={(row) => row.id}
          rows={macro}
        />
      </Block>
      <Block
        date={events.length === 0 ? null : data.today}
        id="events"
        title={`Events, next ${EVENTS_AHEAD_DAYS} days`}
      >
        <DataTable
          caption="Upcoming events"
          columns={[
            [
              "Date",
              (row) => `${row.date}${row.time === null ? "" : ` ${row.time}`}`,
            ],
            ["Event", (row) => row.title],
            ["Source", (row) => row.source],
          ]}
          rowKey={(row) => `${row.source}:${row.eventKey}`}
          rows={events}
        />
      </Block>
    </div>
  );
};

export const OpenbbMarketsSection = ({
  gateway: supplied,
  now = () => new Date(),
}: Readonly<{ gateway?: OpenbbGateway; now?: () => Date }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserOpenbbGateway());
  const state = useLoad<MarketsData>(async () => {
    const today = nyDate(now());
    const [vol, cot, macro, events] = await Promise.all([
      gateway.volContext(),
      gateway.cot(COT_REQUEST_WEEKS),
      gateway.macro(nyDate(now(), -MACRO_HISTORY_DAYS)),
      gateway.events(today, nyDate(now(), EVENTS_AHEAD_DAYS)),
    ]);
    return { cot, events, macro, today, vol };
  }, "markets");
  return (
    <section
      aria-labelledby="openbb-markets"
      className="space-y-4"
      data-openbb="markets"
    >
      <div>
        <h2 className="font-semibold text-lg" id="openbb-markets">
          Vol, positioning and macro (OpenBB)
        </h2>
        <p className="text-muted-foreground text-sm">
          Cboe, CFTC, Fed, Treasury, OECD and FRED data collected by the OpenBB
          jobs. Research input, not a trade signal.
        </p>
      </div>
      {state.type === "ready" ? (
        <MarketsBlocks data={state.data} />
      ) : (
        <Status state={state} what="OpenBB market data" />
      )}
    </section>
  );
};

const ShortBlocks = ({ data }: Readonly<{ data: OpenbbShortsOutput }>) => {
  const volume = recentShortVolume(data.shortVolume);
  const weeks = otcWeeks(data.otcWeekly);
  const interest = [...data.shortInterest].reverse();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Block
        date={volume[0]?.date ?? null}
        id="short-volume"
        title="Daily short volume ratio"
      >
        <DataTable
          caption="Daily short volume"
          columns={[
            ["Date", (row) => row.date],
            ["Short ratio", (row) => formatPercent(row.shortRatio)],
            ["Short volume", (row) => formatCompact(row.shortVolume)],
            ["Total volume", (row) => formatCompact(row.totalVolume)],
          ]}
          rowKey={(row) => row.date}
          rows={volume}
        />
      </Block>
      <Block
        date={weeks[0]?.weekStart ?? null}
        id="otc"
        title="Weekly off-exchange shares"
      >
        <DataTable
          caption="Weekly off-exchange shares"
          columns={[
            ["Week of", (row) => row.weekStart],
            ["ATS", (row) => formatCompact(row.ats)],
            ["Non-ATS OTC", (row) => formatCompact(row.nonAts)],
          ]}
          rowKey={(row) => row.weekStart}
          rows={weeks}
        />
      </Block>
      <Block
        date={interest[0]?.settlementDate ?? null}
        id="short-interest"
        title="Short interest"
      >
        <DataTable
          caption="Short interest"
          columns={[
            ["Settlement", (row) => row.settlementDate],
            ["Short interest", (row) => formatCompact(row.shortInterest)],
            ["Days to cover", (row) => formatNumber(row.daysToCover)],
          ]}
          rowKey={(row) => row.settlementDate}
          rows={interest}
        />
      </Block>
      <Block
        date={data.ftd[0]?.settlementDate ?? null}
        id="ftd"
        title="Fails to deliver (SEC)"
      >
        <DataTable
          caption="Fails to deliver"
          columns={[
            ["Settlement", (row) => row.settlementDate],
            ["Quantity", (row) => formatCompact(row.quantity)],
            ["Price", (row) => formatNumber(row.price)],
          ]}
          rowKey={(row) => row.settlementDate}
          rows={data.ftd}
        />
      </Block>
    </div>
  );
};

export const OpenbbShortsPanel = ({
  gateway: supplied,
  symbol,
}: Readonly<{ gateway?: OpenbbGateway; symbol: string }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserOpenbbGateway());
  const state = useLoad(() => gateway.shorts(symbol, 140), symbol);
  return (
    <section
      aria-labelledby="openbb-shorts"
      className="space-y-4"
      data-openbb="shorts"
    >
      <h2 className="font-semibold text-lg" id="openbb-shorts">
        Short and off-exchange (FINRA/SEC): {symbol}
      </h2>
      {state.type === "ready" ? (
        <ShortBlocks data={state.data} />
      ) : (
        <Status state={state} what="Short data" />
      )}
      <p className="text-muted-foreground text-xs">
        Daily short volume is not short interest. Research input, not a trade
        signal.
      </p>
    </section>
  );
};

const FilingBlocks = ({
  sec,
  shorts,
}: Readonly<{ sec: OpenbbSecOutput; shorts: OpenbbShortsOutput }>) => (
  <div className="space-y-6">
    <Block
      date={sec.filings[0]?.filingDate ?? null}
      id="filings"
      title="SEC filings"
    >
      <DataTable
        caption="SEC filings"
        columns={[
          ["Filed", (row) => row.filingDate],
          ["Form", (row) => row.formType],
          [
            "Description",
            (row) => (
              <a
                className="underline"
                href={row.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {row.description === "" ? row.accessionNumber : row.description}
              </a>
            ),
          ],
        ]}
        rowKey={(row) => row.accessionNumber}
        rows={sec.filings}
      />
    </Block>
    <Block
      date={sec.insiderTrades[0]?.filingDate ?? null}
      id="insider"
      title="Insider trades"
    >
      <DataTable
        caption="Insider trades"
        columns={[
          ["Filed", (row) => row.filingDate],
          [
            "Owner",
            (row) =>
              `${row.ownerName}${row.ownerTitle === null ? "" : ` (${row.ownerTitle})`}`,
          ],
          [
            "Code",
            (row) =>
              `${row.transactionCode ?? MISSING}${row.acquiredDisposed === null ? "" : ` ${row.acquiredDisposed}`}`,
          ],
          ["Shares", (row) => formatCompact(row.shares)],
          ["Price", (row) => formatNumber(row.price)],
        ]}
        rowKey={(row) => `${row.accessionNumber}:${row.rowNumber}`}
        rows={sec.insiderTrades}
      />
    </Block>
    <Block
      date={sec.holdings13f[0]?.periodEnding ?? null}
      id="13f"
      title="Tracked 13F holders"
    >
      <DataTable
        caption="13F holders"
        columns={[
          ["Filer", (row) => row.filerName],
          ["Period", (row) => row.periodEnding],
          ["Shares", (row) => formatCompact(row.shares)],
          ["Value", (row) => formatCompact(row.value)],
          [
            "Option",
            (row) => (row.optionType === "" ? MISSING : row.optionType),
          ],
        ]}
        rowKey={(row) =>
          `${row.filerCik}:${row.periodEnding}:${row.cusip}:${row.optionType}`
        }
        rows={sec.holdings13f}
      />
    </Block>
    <ShortBlocks data={{ ...shorts, ftd: sec.ftd }} />
  </div>
);

export const OpenbbFilingsTab = ({
  gateway: supplied,
  symbol,
}: Readonly<{ gateway?: OpenbbGateway; symbol: string }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserOpenbbGateway());
  const state = useLoad(async () => {
    const [sec, shorts] = await Promise.all([
      gateway.sec(symbol),
      gateway.shorts(symbol, 140),
    ]);
    return { sec, shorts };
  }, symbol);
  return (
    <div className="space-y-4" data-openbb="filings">
      {state.type === "ready" ? (
        <FilingBlocks sec={state.data.sec} shorts={state.data.shorts} />
      ) : (
        <Status state={state} what={`${symbol} filings`} />
      )}
      <p className="text-muted-foreground text-xs">
        SEC EDGAR and FINRA public data. Research input, not a trade signal.
      </p>
    </div>
  );
};
