"use client";

import { Button, TableBody, TableRow } from "@darkfactory/ui";

import { useEffect, useId, useMemo, useState } from "react";
import type {
  PortfolioSnapshot,
  ProjectionContinuity,
  VertexPortfolioStatusRead,
} from "@darkfactory/api/vertex";
import { ReadNotice } from "../../components/research/research-views.tsx";
import { ResearchTableHeading } from "../../components/research/research-table-heading.tsx";
import type { ExperienceScope } from "./ports.ts";
import { serverClock } from "./research-chat-status.ts";
import {
  continuityStateLabel,
  freshnessStatusLabel,
  reservationStateLabel,
} from "./status-labels.ts";
import {
  EmptyCollection,
  ExperienceFrame,
  ResourcePanel,
  ScopeLabel,
  ScopeChooser,
  useExperienceResource,
  useExperienceServices,
} from "./shared.tsx";
import {
  ExperienceTable,
  ExperienceTableCaption,
  ExperienceTableCell,
  ExperienceTableHead,
  ExperienceTableHeader,
  experienceTableScroll,
} from "./experience-table.tsx";

const exact = (value: string | null): string =>
  value === null ? "Unknown — not supplied" : value;
const continuityMessages: Record<
  Exclude<ProjectionContinuity["state"], "unavailable">,
  string
> = {
  empty:
    "The source has reported no events. An empty stream does not confirm zero holdings or cash.",
  continuous:
    "The supplied high-water mark was continuous at the source evaluation time. Current broker state is unconfirmed. This status does not grant execution permission.",
  gap: "The source reported a sequence gap. These observations may be incomplete. Available funds and complete holdings are unconfirmed.",
  stale:
    "No newer observation arrived within the age limit. Values are historical observations. Current balances are unconfirmed.",
  "epoch-mismatch":
    "The projection owner epoch does not match. The native owner must reconcile it. This view cannot repair it.",
};

export const continuityMessage = (continuity: ProjectionContinuity): string => {
  if (continuity.state !== "unavailable")
    return continuityMessages[continuity.state];
  const reported =
    continuity.lastOccurredAt === null
      ? "The source sent no record time"
      : `The source reported this at ${continuity.lastOccurredAt}`;
  return `Portfolio source reported no portfolio data. ${reported} (sequence ${continuity.highWaterSequence}). Completeness and current balances are unconfirmed until the source sends an observation. Refresh reads the source again.`;
};

// "source-unavailable" is a protocol value; the page names the state instead.
export const sourceKindLabel = (
  kind: PortfolioSnapshot["sourceKind"]
): string => (kind === "source-unavailable" ? "source reported no data" : kind);

export const PortfolioContinuity = ({
  continuity,
}: {
  readonly continuity: ProjectionContinuity;
}) => (
  <section
    className="rounded-xl border border-border bg-card px-5 pt-4 pb-5 text-card-foreground [&>:first-child]:mt-0 [:not(.grid,.flex)>&+&]:mt-6"
    id="continuity"
    aria-label="Projection continuity"
  >
    <h2>Projection continuity</h2>
    <p
      className="font-medium text-foreground text-sm leading-[1.7] [overflow-wrap:anywhere]"
      role="status"
    >
      {continuityStateLabel(continuity.state)}
      {" · freshness: "}
      {freshnessStatusLabel(continuity.freshness.status)}
    </p>
    <p>{continuityMessage(continuity)}</p>
    <dl className="my-4 grid text-sm leading-[1.75] [&>div]:grid @min-[42rem]:[&>div]:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)] @min-[42rem]:[&>div]:gap-6 [&>div]:gap-2 [&>div]:border-border [&>div]:border-b [&>div]:py-3 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground">
      <div>
        <dt>Stream</dt>
        <dd>{continuity.streamId}</dd>
      </div>
      <div>
        <dt>Owner epoch</dt>
        <dd>{continuity.ownerEpoch}</dd>
      </div>
      <div>
        <dt>High-water sequence</dt>
        <dd>{continuity.highWaterSequence}</dd>
      </div>
      <div>
        <dt>High-water event hash</dt>
        <dd>{exact(continuity.highWaterEventHash)}</dd>
      </div>
      <div>
        <dt>Expected next sequence</dt>
        <dd>{continuity.expectedNextSequence}</dd>
      </div>
      <div>
        <dt>Received sequence</dt>
        <dd>{exact(continuity.receivedSequence)}</dd>
      </div>
      <div>
        <dt>Last occurred at</dt>
        <dd>{exact(continuity.lastOccurredAt)}</dd>
      </div>
      <div>
        <dt>Last received at</dt>
        <dd>{exact(continuity.lastReceivedAt)}</dd>
      </div>
      <div>
        <dt>Evaluated at</dt>
        <dd>{continuity.evaluatedAt}</dd>
      </div>
      <div>
        <dt>Freshness observed at</dt>
        <dd>{exact(continuity.freshness.observedAt)}</dd>
      </div>
      <div>
        <dt>Freshness evaluated at</dt>
        <dd>{continuity.freshness.evaluatedAt}</dd>
      </div>
      <div>
        <dt>Maximum age (milliseconds)</dt>
        <dd>{continuity.freshness.maxAgeMs}</dd>
      </div>
    </dl>
    <p className="text-muted-foreground text-sm leading-relaxed">
      This projection has no reservation authority. New risk is blocked. Only
      the native owner can establish reservation authority.
    </p>
  </section>
);

type Column<Row> = Readonly<{
  label: string;
  value: (row: Row) => string | null;
}>;
const PAGE_SIZE = 25;

export const PortfolioCollection = <Row,>({
  title,
  description,
  notice,
  rows,
  columns,
  identity,
}: {
  readonly title: string;
  /** Help text behind the info icon; without it the heading shows no icon. */
  readonly description?: string;
  readonly notice?: string;
  readonly rows: readonly Row[];
  readonly columns: readonly Column<Row>[];
  readonly identity: (row: Row) => string;
}) => {
  const inputId = useId();
  const headingId = `${inputId}-heading`;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return rows;
    return rows.filter((row) =>
      columns.some((column) =>
        column.value(row)?.toLowerCase().includes(normalized)
      )
    );
  }, [rows, columns, query]);
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = matches.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );
  return (
    <section
      className="my-4 border-border border-y [&>summary]:cursor-pointer [&>summary]:py-4 [&>summary]:font-semibold"
      aria-labelledby={headingId}
    >
      <div className="my-4 flex flex-wrap items-center gap-4 [&>label]:flex-[1_1_16rem]">
        {description === undefined ? (
          <ResearchTableHeading id={headingId} title={title} />
        ) : (
          <ResearchTableHeading id={headingId} title={title}>
            <p>{description}</p>
          </ResearchTableHeading>
        )}
        <span className="text-muted-foreground text-sm leading-relaxed">
          {rows.length} supplied
        </span>
      </div>
      {notice === undefined ? null : (
        <p className="text-muted-foreground text-sm leading-relaxed">
          {notice}
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyCollection title={`No ${title.toLowerCase()} supplied`}>
          The source returned an empty collection. This does not establish zero
          exposure, a zero balance or available spending capacity.
        </EmptyCollection>
      ) : (
        <div>
          <div className="my-4 flex flex-wrap items-center gap-4 [&>label]:flex-[1_1_16rem]">
            <label htmlFor={inputId}>Search {title.toLowerCase()}</label>
            <input
              id={inputId}
              type="search"
              value={query}
              maxLength={160}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                return setPage(0);
              }}
            />
            {query.length > 0 ? (
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  setQuery("");
                  return setPage(0);
                }}
              >
                Clear search
              </Button>
            ) : null}
          </div>
          {matches.length === 0 ? (
            <EmptyCollection title="No matching observations">
              Change or clear the search. The source collection has not been
              changed.
            </EmptyCollection>
          ) : (
            <div>
              <div
                className={experienceTableScroll}
                role="region"
                aria-label={`${title} observations; scroll horizontally for all fields`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
                tabIndex={0}
              >
                <ExperienceTable aria-labelledby={headingId}>
                  <ExperienceTableCaption>
                    {title} — exact source values; no calculated totals
                  </ExperienceTableCaption>
                  <ExperienceTableHeader>
                    <TableRow>
                      {columns.map((column) => (
                        <ExperienceTableHead key={column.label} scope="col">
                          {column.label}
                        </ExperienceTableHead>
                      ))}
                    </TableRow>
                  </ExperienceTableHeader>
                  <TableBody>
                    {visible.map((row) => (
                      <TableRow key={identity(row)}>
                        {columns.map((column) => (
                          <ExperienceTableCell key={column.label}>
                            {exact(column.value(row))}
                          </ExperienceTableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </ExperienceTable>
              </div>
              <nav
                className="text-(length:--text-sm) my-4 flex flex-wrap items-center gap-4 border-border border-t pt-4 @min-[42rem]:[&>p]:mr-auto [&>p]:flex-[1_1_100%] @min-[42rem]:[&>p]:basis-auto"
                aria-label={`${title} pages`}
              >
                <Button
                  variant="outline"
                  type="button"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <p role="status">
                  Page {currentPage + 1} of {pageCount}
                  {" · "}
                  {matches.length} matching observations
                </p>
                <Button
                  variant="outline"
                  type="button"
                  disabled={currentPage + 1 >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </Button>
              </nav>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const positionColumns: readonly Column<
  PortfolioSnapshot["positions"][number]
>[] = [
  { label: "Instrument", value: (row) => row.instrumentId },
  { label: "Observed quantity", value: (row) => row.quantity },
  { label: "Market value", value: (row) => row.marketValue },
  { label: "Cost basis", value: (row) => row.costBasis },
  { label: "Currency", value: (row) => row.currency },
  { label: "Price as of", value: (row) => row.priceAsOf },
  { label: "Sleeve", value: (row) => row.sleeveId },
];
const lotColumns: readonly Column<PortfolioSnapshot["lots"][number]>[] = [
  { label: "Lot", value: (row) => row.lotId },
  { label: "Instrument", value: (row) => row.instrumentId },
  { label: "Observed quantity", value: (row) => row.quantity },
  { label: "Unit cost", value: (row) => row.unitCost },
  { label: "Currency", value: (row) => row.currency },
  { label: "Opened at", value: (row) => row.openedAt },
  { label: "Source event", value: (row) => row.sourceEventId },
];
const reservationColumns: readonly Column<
  PortfolioSnapshot["reservations"][number]
>[] = [
  { label: "Reservation", value: (row) => row.reservationId },
  { label: "Submission key", value: (row) => row.submissionKey },
  { label: "Instrument", value: (row) => row.instrumentId },
  { label: "Cash amount", value: (row) => row.cashAmount },
  { label: "Share quantity", value: (row) => row.shareQuantity },
  { label: "Currency", value: (row) => row.currency },
  { label: "State", value: (row) => reservationStateLabel(row.state) },
  { label: "Source event", value: (row) => row.sourceEventId },
];
const sleeveColumns: readonly Column<
  PortfolioSnapshot["sleeveAllocations"][number]
>[] = [
  { label: "Sleeve", value: (row) => row.sleeveId },
  { label: "Allocated amount", value: (row) => row.allocatedAmount },
  { label: "Currency", value: (row) => row.currency },
  { label: "Source event", value: (row) => row.sourceEventId },
];

export const PortfolioObservation = ({
  snapshot,
}: {
  readonly snapshot: PortfolioSnapshot;
}) => (
  <div className="grid gap-8">
    <section
      className="rounded-xl border border-border bg-card px-5 pt-4 pb-5 text-card-foreground [&>:first-child]:mt-0 [:not(.grid,.flex)>&+&]:mt-6"
      aria-label="Portfolio source"
    >
      <h2>Source observation</h2>
      <p className="font-medium text-foreground text-sm leading-[1.7] [overflow-wrap:anywhere]">
        {snapshot.environment}
        {" · "}
        {sourceKindLabel(snapshot.sourceKind)}
        {" · observation only"}
      </p>
      {snapshot.sourceKind === "source-unavailable" ? (
        <ReadNotice
          plain
          title={`Portfolio source reported no portfolio data for ${snapshot.environment} at ${snapshot.asOfAt}`}
        >
          {`The source reported at ${snapshot.asOfAt} (sequence ${snapshot.sequence}) that it has no portfolio data; this page received the report at ${snapshot.receivedAt}. `}
          No balances or holdings have been supplied. Empty collections and
          unknown values are not zero.
          {
            " Refresh reads the source again; values appear when it sends an observation."
          }
        </ReadNotice>
      ) : snapshot.continuity.freshness.status === "stale" ? (
        <ReadNotice
          plain
          title={`Portfolio source not responding for ${snapshot.environment}: no newer observation since ${snapshot.asOfAt}`}
        >
          {`No newer portfolio observation arrived within the age limit of ${snapshot.continuity.freshness.maxAgeMs} ms. The values below are from that observation (sequence ${snapshot.sequence}); current balances are unconfirmed.`}
          {" Refresh reads the source again."}
        </ReadNotice>
      ) : null}
      {snapshot.sourceKind === "paper-simulation" ? (
        <p>
          PAPER-SIMULATION observations only. These are not broker-paper
          holdings or live balances.
        </p>
      ) : null}
      <dl className="my-4 grid text-sm leading-[1.75] [&>div]:grid @min-[42rem]:[&>div]:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)] @min-[42rem]:[&>div]:gap-6 [&>div]:gap-2 [&>div]:border-border [&>div]:border-b [&>div]:py-3 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground">
        <div>
          <dt>Account alias</dt>
          <dd>{snapshot.accountAlias}</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd>{snapshot.environment}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{sourceKindLabel(snapshot.sourceKind)}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{snapshot.snapshotId}</dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>{snapshot.asOfAt}</dd>
        </div>
        <div>
          <dt>Received at</dt>
          <dd>{snapshot.receivedAt}</dd>
        </div>
        <div>
          <dt>Sequence</dt>
          <dd>{snapshot.sequence}</dd>
        </div>
        <div>
          <dt>Source event hash</dt>
          <dd>{snapshot.sourceEventHash}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Times and decimal values are preserved exactly as supplied. Refresh
        reads the source again; it does not synchronize a broker or repair
        continuity.
      </p>
    </section>
    <PortfolioContinuity continuity={snapshot.continuity} />
    <section
      className="rounded-xl border border-border bg-card px-5 pt-4 pb-5 text-card-foreground [&>:first-child]:mt-0 [:not(.grid,.flex)>&+&]:mt-6"
      aria-label="Observed cash and NAV"
    >
      <h2>
        {snapshot.environment === "live"
          ? "Observed cash and live NAV"
          : snapshot.environment === "paper"
            ? "Observed simulation cash and NAV"
            : "Research observations — no live NAV"}
      </h2>
      <dl className="my-4 grid text-sm leading-[1.75] [&>div]:grid @min-[42rem]:[&>div]:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)] @min-[42rem]:[&>div]:gap-6 [&>div]:gap-2 [&>div]:border-border [&>div]:border-b [&>div]:py-3 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground">
        <div>
          <dt>Cash observation ({snapshot.currency})</dt>
          <dd>{exact(snapshot.cash)}</dd>
        </div>
        <div>
          <dt>Net asset value ({snapshot.currency})</dt>
          <dd>
            {snapshot.environment === "research"
              ? "Not applicable — research has no live NAV"
              : exact(snapshot.netAssetValue)}
          </dd>
        </div>
      </dl>
      <p>
        Cash is not available or spendable cash. No amount is derived by
        subtracting reservations, adding positions or aggregating currencies.
      </p>
      <p>
        Research and Quant Lab notional are excluded from NAV. Strategy limits,
        backtests and sleeve allocations are not added to these source balances.
      </p>
    </section>
    <PortfolioCollection
      title="Positions"
      description="Search filters the supplied observations only; it does not request additional positions."
      notice="Source-reported positions; quantities are observations, never sizing recommendations."
      rows={snapshot.positions}
      columns={positionColumns}
      identity={(row) => row.instrumentId}
    />
    <PortfolioCollection
      title="Lots"
      description="Individual source lots remain separate from position totals. No tax or realized-profit calculation is performed."
      rows={snapshot.lots}
      columns={lotColumns}
      identity={(row) => row.lotId}
    />
    <PortfolioCollection
      title="Reservation projections"
      notice="Nonauthoritative native-owner projections. Reserved, spent, released and unknown states do not grant spending permission. This view cannot reserve, release, reconcile or submit."
      rows={snapshot.reservations}
      columns={reservationColumns}
      identity={(row) => row.reservationId}
    />
    <PortfolioCollection
      title="Sleeve allocations"
      description="Search filters supplied sleeve records without changing source allocations."
      notice="Nonauthoritative allocation projections, separate from cash and NAV. Allocations neither create funds nor authorize spending."
      rows={snapshot.sleeveAllocations}
      columns={sleeveColumns}
      identity={(row) => row.sleeveId}
    />
  </div>
);

type PortfolioUnavailableReason = Extract<
  VertexPortfolioStatusRead,
  { status: "unavailable" }
>["reason"];
// One title and cause per read reason; the protocol word itself is never printed.
const unavailableReads: Record<
  PortfolioUnavailableReason,
  Readonly<{ title: (environment: string) => string; cause: string }>
> = {
  "not-configured": {
    title: (environment) =>
      `Portfolio source not configured for ${environment}`,
    cause:
      "No native source has opened a projection stream for this account and environment yet. Portfolio data appears after a source starts publishing.",
  },
  "not-found": {
    title: (environment) =>
      `No portfolio snapshot received yet for ${environment}`,
    cause:
      "A native source has opened a projection stream for this account and environment, but it has not sent a portfolio snapshot for its current owner epoch. Refresh reads again.",
  },
  "capability-disabled": {
    title: (environment) => `Portfolio reads turned off for ${environment}`,
    cause: "The portfolio read is turned off for this account and environment.",
  },
  "source-unavailable": {
    title: (environment) =>
      `Portfolio source not responding for ${environment}`,
    cause:
      "The portfolio source did not answer this read. Refresh reads again.",
  },
};
export const PortfolioReadResult = ({
  result,
  scope,
}: {
  readonly result: VertexPortfolioStatusRead;
  readonly scope: ExperienceScope;
}) => {
  if (result.status === "unavailable") {
    const read = unavailableReads[result.reason];
    return (
      <ReadNotice title={read.title(scope.environment)}>
        {read.cause}
        {result.checkedAt === undefined
          ? " "
          : ` The server checked at ${serverClock(result.checkedAt)}. `}
        No portfolio balance is inferred. This account remains observation-only.
      </ReadNotice>
    );
  }
  if (
    result.snapshot.accountAlias !== scope.accountAlias ||
    result.snapshot.environment !== scope.environment
  ) {
    return (
      <ReadNotice title="Portfolio scope mismatch">
        The returned observation does not match the selected account and
        environment. Its private details are not displayed. Refresh or ask the
        source owner to resolve the mismatch.
      </ReadNotice>
    );
  }
  return <PortfolioObservation snapshot={result.snapshot} />;
};

const ScopedPortfolio = ({ scope }: { readonly scope: ExperienceScope }) => {
  const services = useExperienceServices();
  const { resource, state } = useExperienceResource(services.reads.portfolio);
  useEffect(() => {
    void resource.load(scope);
    return () => resource.clear();
  }, [resource, scope]);
  return (
    <div className="grid gap-8">
      <div className="my-4 flex flex-wrap items-center gap-4 [&>label]:flex-[1_1_16rem]">
        <ScopeLabel scope={scope} />
        <Button
          variant="outline"
          type="button"
          disabled={state.type === "loading"}
          onClick={() => void resource.load(scope)}
        >
          Refresh portfolio
        </Button>
      </div>
      <ResourcePanel
        state={state}
        title="Portfolio"
        retry={() => void resource.load(scope)}
      >
        {(result) => <PortfolioReadResult result={result} scope={scope} />}
      </ResourcePanel>
    </div>
  );
};

export const PortfolioWorkspace = () => {
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  return (
    <ExperienceFrame level={2} title="Portfolio projection">
      <ScopeChooser
        onSelect={setScope}
        onRetire={() => setScope(null)}
        label="Portfolio account scope"
      />
      {scope === null ? null : (
        <ScopedPortfolio key={JSON.stringify(scope)} scope={scope} />
      )}
    </ExperienceFrame>
  );
};
