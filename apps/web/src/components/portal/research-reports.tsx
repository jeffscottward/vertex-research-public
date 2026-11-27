"use client";

import {
  type ApiClient,
  createApiClient,
  type ResearchReportDatasetName,
  type ResearchReportDatasetOutput,
  type ResearchReportsListOutput,
  type ResearchReportTechnicals,
} from "@darkfactory/api";
import {
  Button,
  EmptyState,
  Input,
  KpiCard,
  KpiRow,
  PageHeader,
  Panel,
  Skeleton,
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
import { StickyTabs } from "@darkfactory/ui/client/page-sections";
import {
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  FileText,
  FolderTree,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PayoffLab } from "../../features/research-reports/payoff-lab.tsx";
import type { CatalogFacts } from "../../features/research-reports/payoff-strategies.ts";
import {
  type TechnicalsRow,
  type TechnicalsView,
  toTechnicalsViewModel,
} from "../../features/research-reports/technicals-view-model.ts";
import {
  type CatalogGroupView,
  type CatalogSummaryView,
  countCatalogReports,
  DATASET_LABELS,
  DATASET_TABS,
  type DatasetView,
  filterCatalogGroups,
  RESEARCH_REPORTS_PATH,
  toCatalogSummary,
  toCatalogViewModel,
  toDatasetViewModel,
} from "../../features/research-reports/view-model.ts";
import { TickerLink } from "../ticker-link.tsx";
import { utcTime } from "./owner-market-notes-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Research dossier pages (researchReports.*): the imported workspace catalog and one report's
// datasets. Read-only and operator-only. Rows come from `bun run vertex:research-reports:import`.

export interface ResearchReportsGateway {
  readonly dataset: (
    reportId: string,
    dataset: ResearchReportDatasetName
  ) => Promise<ResearchReportDatasetOutput>;
  readonly list: () => Promise<ResearchReportsListOutput>;
  readonly technicals: (reportId: string) => Promise<ResearchReportTechnicals>;
}

export const createBrowserResearchReportsGateway =
  (): ResearchReportsGateway => {
    let client: ApiClient | undefined;
    const api = () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client;
    };
    return Object.freeze({
      dataset: (reportId: string, dataset: ResearchReportDatasetName) =>
        api().researchReports.dataset({ dataset, reportId }),
      list: () => api().researchReports.list({}),
      technicals: (reportId: string) =>
        api().researchReports.technicals({ reportId }),
    });
  };

type Load<T> =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  // code: the server's oRPC code. at: failure time (ISO).
  | Readonly<{ type: "error"; message: string; code: string; at: string }>
  | Readonly<{ type: "ready"; data: T }>;

/**
 * Loads once per `key` change and maps failures the same way as the other operator panels.
 * Only the newest request may set state, so a slow older response never replaces a newer one.
 */
const useLoad = <T,>(read: () => Promise<T>, key: string) => {
  const [state, setState] = useState<Load<T>>({ type: "loading" });
  const reader = useRef(read);
  reader.current = read;
  const latest = useRef(0);
  // `_request` names what is loaded (the effect passes `key`); the reader is always the newest.
  const load = useCallback(async (_request?: string) => {
    latest.current += 1;
    const request = latest.current;
    setState({ type: "loading" });
    try {
      const data = await reader.current();
      if (request === latest.current) setState({ data, type: "ready" });
    } catch (error) {
      if (request !== latest.current) return;
      const failure = describePortfolioMonitorFailure(error);
      setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : {
              at: new Date().toISOString(),
              code: failure.code,
              message: `${failure.code}: ${failure.message}`,
              type: "error",
            }
      );
    }
  }, []);
  useEffect(() => {
    void load(key);
    return () => {
      latest.current += 1;
    };
  }, [load, key]);
  return { load: () => load(key), state };
};

const LoadGate = <T,>({
  state,
  label,
  onRetry,
  children,
}: {
  readonly state: Load<T>;
  readonly label: string;
  readonly onRetry: () => void;
  readonly children: (data: T) => ReactNode;
}) => {
  if (state.type === "loading")
    return (
      <div aria-busy="true" className="min-h-40 space-y-2" role="status">
        <span className="sr-only">Loading {label}</span>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (state.type === "forbidden")
    return (
      <p className="min-h-40 text-muted-foreground text-sm" role="status">
        Research reports are limited to operators.
      </p>
    );
  if (state.type === "error")
    return (
      <div className="min-h-40 space-y-3">
        <p className="text-sm" role="alert">
          {label} did not load at {utcTime(state.at)}. {state.message}
        </p>
        <Button onClick={onRetry} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );
  return <>{children(state.data)}</>;
};

const Breadcrumb = ({
  href,
  label,
}: {
  readonly href: string;
  readonly label: string;
}) => (
  <nav aria-label="Breadcrumb">
    <Link
      className="inline-flex min-h-11 items-center gap-1 hover:text-foreground"
      href={href}
      prefetch={false}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {label}
    </Link>
  </nav>
);

/** Header chip for the catalog load: "Research only" once the dossiers are in. */
const catalogStatus = (state: Load<unknown>): ReactNode => {
  if (state.type === "loading")
    return <StatusBadge status="neutral">Loading</StatusBadge>;
  if (state.type === "forbidden")
    return <StatusBadge status="warning">Operator only</StatusBadge>;
  if (state.type === "error")
    return (
      <StatusBadge status="destructive">
        {`Load failed ${utcTime(state.at)} · ${state.code}`}
      </StatusBadge>
    );
  return <StatusBadge status="info">Research only</StatusBadge>;
};

// The catalog filter lives in the URL (?q=), so a filtered list can be shared and reloaded.
const QUERY_PARAM = "q";
const readQuery = (): string =>
  new URLSearchParams(window.location.search).get(QUERY_PARAM) ?? "";
const readServerQuery = (): string => "";
const subscribeToNothing = (): (() => void) => () => undefined;
const writeQuery = (value: string): void => {
  const url = new URL(window.location.href);
  if (value.trim() === "") url.searchParams.delete(QUERY_PARAM);
  else url.searchParams.set(QUERY_PARAM, value);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const CatalogKpis = ({ summary }: { readonly summary: CatalogSummaryView }) => (
  <KpiRow label="Research dossier summary">
    <KpiCard
      hint="Imported from the research workspace"
      icon={<FileText />}
      label="Dossiers"
      value={summary.dossiers}
    />
    <KpiCard
      hint="Categories with at least one dossier"
      icon={<FolderTree />}
      label="Groups"
      value={summary.groups}
    />
    <KpiCard
      hint="Dossiers with accepted company research"
      icon={<BadgeCheck />}
      label="Company research"
      value={summary.research}
    />
    <KpiCard
      hint={
        summary.stale > 0
          ? `Newest data date · ${summary.stale} stale`
          : "Newest data date"
      }
      icon={<CalendarClock />}
      label="Last updated"
      value={summary.lastUpdated}
    />
  </KpiRow>
);

const CatalogGroup = ({ group }: { readonly group: CatalogGroupView }) => (
  <Panel
    data-research-group={group.id}
    description={group.description}
    flush
    headingId={`research-group-${group.id}`}
    title={group.label}
  >
    <TableScroll label={`${group.label} dossiers`} minWidth="36rem">
      <Table>
        <TableCaption className="sr-only">{group.label} reports</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Dossier</TableHead>
            <TableHead scope="col">Symbol</TableHead>
            <TableHead scope="col">Type</TableHead>
            <TableHead scope="col">Company research</TableHead>
            <TableHead numeric scope="col">
              Data date
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.reports.map((report) => (
            <TableRow data-research-report={report.id} key={report.id}>
              <TableHead
                className="h-auto min-w-48 whitespace-normal font-normal"
                scope="row"
              >
                <Link
                  className="inline-flex min-h-11 items-center gap-2 font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-research-dossier-link=""
                  href={report.href}
                  prefetch={false}
                >
                  <FileText
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  {report.name}
                </Link>
              </TableHead>
              <TableCell>
                <TickerLink symbol={report.symbol} />
              </TableCell>
              <TableCell>{report.assetType}</TableCell>
              <TableCell>
                {report.research ? (
                  <StatusBadge status="success">Accepted</StatusBadge>
                ) : (
                  <span className="text-muted-foreground">
                    No accepted dossier
                  </span>
                )}
              </TableCell>
              <TableCell numeric>
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span>{report.updated}</span>
                  {report.isStale ? (
                    <StatusBadge status="warning">Stale</StatusBadge>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  </Panel>
);

const CatalogBody = ({
  data,
  onQuery,
  query,
}: {
  readonly data: ResearchReportsListOutput;
  readonly onQuery: (value: string) => void;
  readonly query: string;
}) => {
  const groups = toCatalogViewModel(data);
  if (groups.length === 0)
    return (
      <EmptyState
        description={
          <>
            Import them with <code>bun run vertex:research-reports:import</code>
            .
          </>
        }
        headingLevel={2}
        icon={<FileText />}
        title="No research dossiers imported yet"
      />
    );
  const summary = toCatalogSummary(data, groups);
  const shown = filterCatalogGroups(groups, query);
  return (
    <div className="space-y-6">
      <CatalogKpis summary={summary} />
      <form
        aria-label="Filter research dossiers"
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
        onSubmit={(event) => event.preventDefault()}
        role="search"
      >
        <Input
          aria-label="Filter by symbol or name"
          className="sm:max-w-xs"
          name={QUERY_PARAM}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter by symbol or name"
          type="search"
          value={query}
        />
        <p
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-research-reports-shown=""
        >
          {countCatalogReports(shown)} of {summary.dossiers} dossiers
        </p>
      </form>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No dossier matches “{query.trim()}”.
        </p>
      ) : (
        shown.map((group) => <CatalogGroup group={group} key={group.id} />)
      )}
    </div>
  );
};

export const ResearchReportsCatalog = ({
  gateway: supplied,
}: Readonly<{ gateway?: ResearchReportsGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchReportsGateway()
  );
  const { load, state } = useLoad(() => gateway.list(), "catalog");
  const fromUrl = useSyncExternalStore(
    subscribeToNothing,
    readQuery,
    readServerQuery
  );
  const [typed, setTyped] = useState<string | null>(null);
  const query = typed ?? fromUrl;
  const onQuery = (value: string) => {
    setTyped(value);
    return writeQuery(value);
  };
  return (
    <div className="space-y-6" data-research-reports-state={state.type}>
      <PageHeader
        breadcrumb={<Breadcrumb href="/research" label="Research" />}
        description="Imported research dossiers by group."
        status={catalogStatus(state)}
        title="Research dossiers"
      />
      <LoadGate
        label="Research dossiers"
        onRetry={() => void load()}
        state={state}
      >
        {(data) => <CatalogBody data={data} onQuery={onQuery} query={query} />}
      </LoadGate>
    </div>
  );
};

const DatasetPanels = ({
  label,
  view,
}: {
  readonly label: string;
  readonly view: DatasetView;
}) => (
  <div className="space-y-6 text-sm">
    <Panel
      description={
        <>
          {view.asOf === null ? null : <>As of {view.asOf} · </>}
          Revision <code>{view.revision}</code> ({view.revisionCount} stored)
        </>
      }
      headingId="research-dataset-heading"
      title={label}
    >
      {view.title === null &&
      view.summary === null &&
      view.warnings.length === 0 ? (
        <p className="text-muted-foreground">
          This dataset has no summary or warnings.
        </p>
      ) : (
        <div className="space-y-4">
          {view.title === null ? null : (
            <p className="font-medium">{view.title}</p>
          )}
          {view.summary === null ? null : (
            <p className="max-w-reading">{view.summary}</p>
          )}
          {view.warnings.length === 0 ? null : (
            <div className="space-y-1" data-dataset-warnings="">
              <h3 className="font-medium">Warnings</h3>
              <ul className="list-disc space-y-1 pl-5">
                {view.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
    {view.metrics.length === 0 ? null : (
      <Panel data-dataset-metrics="" flush title="Metrics">
        <TableScroll label={`${label} metrics`} minWidth="28rem">
          <Table>
            <TableCaption className="sr-only">Metrics</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Metric</TableHead>
                <TableHead numeric scope="col">
                  Value
                </TableHead>
                <TableHead scope="col">Period</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.metrics.map((metric, index) => (
                <TableRow key={index}>
                  <TableHead
                    className="h-auto min-w-40 whitespace-normal font-normal"
                    scope="row"
                  >
                    {metric.label}
                  </TableHead>
                  <TableCell className="whitespace-normal" numeric>
                    {metric.value}
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {metric.period ?? "No period recorded"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </Panel>
    )}
    {view.newsItems.length === 0 ? null : (
      <Panel title="News">
        <ul aria-label="News items" className="space-y-3">
          {view.newsItems.map((item, index) => (
            <li className="space-y-1" key={index}>
              <p className="font-medium">
                {item.href === null ? (
                  item.title
                ) : (
                  <a
                    className="inline-flex min-h-11 items-center underline underline-offset-2"
                    href={item.href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {item.title}
                  </a>
                )}
              </p>
              <p className="text-muted-foreground text-xs">
                {[item.date, item.source]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
              {item.summary === null ? null : <p>{item.summary}</p>}
            </li>
          ))}
        </ul>
      </Panel>
    )}
    {view.sections.length === 0 ? null : (
      <Panel title="Sections">
        <div className="divide-y">
          {view.sections.map((section, position) => (
            <details data-dataset-section={section.id} key={position}>
              <summary className="min-h-11 cursor-pointer content-center font-medium">
                {section.title}
              </summary>
              <ul className="list-disc space-y-1 pb-2 pl-5">
                {section.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </Panel>
    )}
    {view.sources.length === 0 ? null : (
      <Panel data-dataset-sources="" title={`Sources (${view.sources.length})`}>
        <ul className="list-disc space-y-1 pl-5">
          {view.sources.map((source, index) => (
            <li key={index}>
              {source.href === null ? (
                source.title
              ) : (
                <a
                  className="inline-flex min-h-11 items-center underline underline-offset-2"
                  href={source.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  {source.title}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    )}
  </div>
);

const RowsTable = ({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: readonly TechnicalsRow[];
}) => (
  <TableScroll label={label} minWidth="28rem">
    <Table>
      <TableCaption className="sr-only">{label}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Measure</TableHead>
          <TableHead numeric scope="col">
            Value
          </TableHead>
          <TableHead scope="col">Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label}>
            <TableHead
              className="h-auto min-w-40 whitespace-normal font-normal"
              scope="row"
            >
              {row.label}
            </TableHead>
            <TableCell className="whitespace-normal" numeric>
              {row.value}
            </TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">
              {row.detail}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </TableScroll>
);

const TREND_STATUS = {
  fail: { label: "Fail", status: "warning" },
  missing: { label: "Not stored", status: "neutral" },
  pass: { label: "Pass", status: "success" },
} as const;

const TechnicalsBody = ({ view }: { readonly view: TechnicalsView }) => (
  <div className="space-y-6 text-sm" data-technicals="">
    <Panel
      description={
        <>
          {view.barsLine} Revision <code>{view.revision}</code>.
        </>
      }
      flush
      title="Indicators"
    >
      <p
        className="flex flex-wrap items-center gap-2 px-4 py-3"
        data-technicals-check={view.check.tone}
      >
        <StatusBadge status={view.check.tone}>Recompute check</StatusBadge>
        <span>{view.check.text}</span>
      </p>
      <RowsTable label={view.indicatorsLabel} rows={view.indicators} />
    </Panel>
    <Panel title="Trend checks">
      <ul aria-label="Trend checks" className="grid gap-2 sm:grid-cols-2">
        {view.trendChecks.map((check) => (
          <li className="flex min-h-11 items-center gap-2" key={check.label}>
            <StatusBadge status={TREND_STATUS[check.status].status}>
              {TREND_STATUS[check.status].label}
            </StatusBadge>
            <span>{check.label}</span>
          </li>
        ))}
      </ul>
    </Panel>
    <Panel flush title="Weinstein stage">
      {view.weinstein === null ? (
        <p className="px-4 py-3 text-muted-foreground">
          Not computed for this revision; the notes below give the reason.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <p className="font-medium" data-technicals-stage="">
              {view.weinstein.stage}
            </p>
            <StatusBadge
              data-technicals-stage-stale={
                view.weinstein.isStale ? "true" : "false"
              }
              status={view.weinstein.isStale ? "warning" : "success"}
            >
              {view.weinstein.isStale
                ? "Stale"
                : `As of ${view.weinstein.asOf}`}
            </StatusBadge>
          </div>
          {view.weinstein.staleReason === null ? null : (
            <p
              className="px-4 pb-3 text-muted-foreground"
              data-technicals-stage-stale-reason=""
            >
              {view.weinstein.staleReason}
            </p>
          )}
          <RowsTable
            label="Weinstein stage inputs"
            rows={view.weinstein.rows}
          />
        </>
      )}
    </Panel>
    <Panel flush title="Swing pivots">
      {view.pivots === null ? (
        <p className="px-4 py-3 text-muted-foreground">
          Not computed for this revision; the notes below give the reason.
        </p>
      ) : (
        <>
          <RowsTable label="Nearest pivots" rows={view.pivots.rows} />
          <details className="px-4 py-2">
            <summary className="min-h-11 cursor-pointer content-center font-medium">
              {view.pivots.listLabel}
            </summary>
            <ul className="space-y-1 pb-2">
              {view.pivots.items.map((pivot) => (
                <li key={`${pivot.kind}-${pivot.date}`}>
                  {pivot.kind} {pivot.price} on {pivot.date}, confirmed{" "}
                  {pivot.confirmedOn}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Panel>
    <Panel
      description={view.fibonacci?.heading}
      flush
      title="Fibonacci retracement"
    >
      {view.fibonacci === null ? (
        <p className="px-4 py-3 text-muted-foreground">
          Not computed for this revision; the notes below give the reason.
        </p>
      ) : (
        <RowsTable
          label="Fibonacci levels"
          rows={view.fibonacci.rows.map((row) => ({
            detail: row.mark,
            label: row.ratio,
            value: row.price,
          }))}
        />
      )}
    </Panel>
    <Panel flush title="Volume profile">
      {view.volumeProfile === null ? (
        <p className="px-4 py-3 text-muted-foreground">
          Not computed for this revision; the notes below give the reason.
        </p>
      ) : (
        <>
          <RowsTable label="Volume profile" rows={view.volumeProfile.rows} />
          <details className="px-4 py-2">
            <summary className="min-h-11 cursor-pointer content-center font-medium">
              Volume by price ({view.volumeProfile.bins.length} bins, highest
              price first)
            </summary>
            <ul className="space-y-0.5 pb-2" data-technicals-bins="">
              {view.volumeProfile.bins.map((bin, index) => (
                <li
                  className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2 text-xs"
                  // Bins are fixed by position (highest price first).
                  key={index}
                >
                  <span className="tabular-nums">{bin.range}</span>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={
                        bin.mark === null
                          ? "h-2 rounded-sm bg-muted-foreground/40"
                          : "h-2 rounded-sm bg-primary"
                      }
                      style={{ width: `${bin.width}%` }}
                    />
                    <span className="text-muted-foreground tabular-nums">
                      {bin.volume}
                      {bin.mark === null ? null : ` · ${bin.mark}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Panel>
    <Panel title="Notes">
      {view.warnings.length === 0 ? null : (
        <ul
          className="mb-3 list-disc space-y-1 pl-5"
          data-technicals-warnings=""
        >
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <p className="max-w-reading text-muted-foreground">{view.methodNote}</p>
    </Panel>
  </div>
);

/** The computed technicals of the report, with their own load state above the dataset panels. */
const TechnicalsPanels = ({
  gateway,
  reportId,
}: {
  readonly gateway: ResearchReportsGateway;
  readonly reportId: string;
}) => {
  const { load, state } = useLoad(
    () => gateway.technicals(reportId),
    `${reportId}/technicals`
  );
  return (
    <div data-research-technicals-state={state.type}>
      <LoadGate label="Technicals" onRetry={() => void load()} state={state}>
        {(data) => <TechnicalsBody view={toTechnicalsViewModel(data)} />}
      </LoadGate>
    </div>
  );
};

/** One tab: StickyTabs mounts only the open tab, so each opening reads its dataset afresh. */
const DatasetTab = ({
  catalog,
  dataset,
  gateway,
  reportId,
}: {
  /** Currency of the report from the catalog read; the payoff lab needs it. */
  readonly catalog: CatalogFacts;
  readonly dataset: ResearchReportDatasetName;
  readonly gateway: ResearchReportsGateway;
  readonly reportId: string;
}) => {
  const { load, state } = useLoad(
    () => gateway.dataset(reportId, dataset),
    `${reportId}/${dataset}`
  );
  const label = DATASET_LABELS[dataset];
  return (
    <div className="space-y-6">
      {dataset === "technicals" ? (
        <TechnicalsPanels gateway={gateway} reportId={reportId} />
      ) : null}
      <div data-research-report-state={state.type}>
        <LoadGate
          label={`${label} dataset`}
          onRetry={() => void load()}
          state={state}
        >
          {(data) => (
            <div className="space-y-6">
              <DatasetPanels label={label} view={toDatasetViewModel(data)} />
              {dataset === "options-analysis" ? (
                <PayoffLab
                  catalog={catalog}
                  data={data.data}
                  key={data.dataRevision}
                  reportId={reportId}
                />
              ) : null}
            </div>
          )}
        </LoadGate>
      </div>
    </div>
  );
};

type ReportCatalog = Readonly<{
  /** The report's real ticker (a report id such as `brk-b` is not a symbol). */
  symbol: string | undefined;
  dataDate: string | null;
  isStale: boolean;
  facts: CatalogFacts;
}>;

/**
 * What the dossier page needs from the catalog: the ticker, data date and freshness for the
 * header, and the currency for the payoff lab. The symbol is undefined while loading, when the
 * catalog read fails or when the report is not listed.
 */
const useReportCatalog = (
  gateway: ResearchReportsGateway,
  reportId: string
): ReportCatalog => {
  const [found, setFound] = useState<
    (ReportCatalog & Readonly<{ reportId: string }>) | undefined
  >(undefined);
  useEffect(() => {
    // A late answer for an earlier report must not replace the state of the current one.
    let current = true;
    gateway.list().then(
      (catalog) => {
        if (!current) return;
        const report = catalog.reports.find((entry) => entry.id === reportId);
        setFound({
          dataDate: report?.dataDate ?? null,
          facts: {
            currency: report?.currency ?? null,
            status: "ready",
          },
          isStale: report?.freshness.isStale ?? false,
          reportId,
          symbol: report?.symbol,
        });
      },
      () => {
        if (current)
          setFound({
            dataDate: null,
            facts: { status: "failed" },
            isStale: false,
            reportId,
            symbol: undefined,
          });
      }
    );
    return () => {
      current = false;
    };
  }, [gateway, reportId]);
  return found?.reportId === reportId
    ? found
    : {
        dataDate: null,
        facts: { status: "loading" },
        isStale: false,
        symbol: undefined,
      };
};

export const ResearchReportDetail = ({
  reportId,
  gateway: supplied,
  initialTab,
}: Readonly<{
  reportId: string;
  gateway?: ResearchReportsGateway;
  /** `?tab=` from the request, so a deep link renders that dataset first. */
  initialTab?: string | undefined;
}>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchReportsGateway()
  );
  const { dataDate, facts, isStale, symbol } = useReportCatalog(
    gateway,
    reportId
  );
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb href={RESEARCH_REPORTS_PATH} label="Research dossiers" />
        }
        description={
          <>
            Research dossier for{" "}
            {symbol === undefined ? reportId : <TickerLink symbol={symbol} />},
            one dataset per tab.
          </>
        }
        status={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status="info">Research only</StatusBadge>
            {dataDate === null ? null : (
              <StatusBadge
                data-research-report-data-date={dataDate}
                status={isStale ? "warning" : "success"}
              >
                {isStale ? `Stale · ${dataDate}` : `Price data ${dataDate}`}
              </StatusBadge>
            )}
          </span>
        }
        title={`${reportId} dossier`}
      />
      <StickyTabs
        {...(initialTab === undefined ? {} : { initialValue: initialTab })}
        label="Dataset"
        tabs={DATASET_TABS.map((tab) => ({
          content: (
            <DatasetTab
              catalog={facts}
              dataset={tab.id}
              gateway={gateway}
              reportId={reportId}
            />
          ),
          label: tab.label,
          value: tab.id,
        }))}
      />
    </div>
  );
};
