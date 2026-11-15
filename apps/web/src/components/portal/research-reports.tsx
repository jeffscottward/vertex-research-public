"use client";

import {
  type ApiClient,
  createApiClient,
  type ResearchReportDatasetName,
  type ResearchReportDatasetOutput,
  type ResearchReportsListOutput,
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

import {
  type CatalogGroupView,
  type CatalogSummaryView,
  countCatalogReports,
  DATASET_LABELS,
  DATASET_TABS,
  type DatasetView,
  filterCatalogGroups,
  RESEARCH_REPORTS_NOTICE,
  RESEARCH_REPORTS_PATH,
  toCatalogSummary,
  toCatalogViewModel,
  toDatasetViewModel,
} from "../../features/research-reports/view-model.ts";
import { TickerLink } from "../ticker-link.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Research dossier pages (researchReports.*): the imported workspace catalog and one report's
// datasets. Read-only and operator-only. Rows come from `bun run vertex:research-reports:import`.

export interface ResearchReportsGateway {
  readonly dataset: (
    reportId: string,
    dataset: ResearchReportDatasetName
  ) => Promise<ResearchReportDatasetOutput>;
  readonly list: () => Promise<ResearchReportsListOutput>;
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
    });
  };

type Load<T> =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
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
          : { message: `${failure.code}: ${failure.message}`, type: "error" }
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
          {label} unavailable. {state.message}
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
const catalogStatus = (type: Load<unknown>["type"]): ReactNode => {
  if (type === "loading")
    return <StatusBadge status="neutral">Loading</StatusBadge>;
  if (type === "forbidden")
    return <StatusBadge status="warning">Operator only</StatusBadge>;
  if (type === "error")
    return <StatusBadge status="destructive">Unavailable</StatusBadge>;
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
      hint="Newest source update"
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
              Updated
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
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell numeric>{report.updated}</TableCell>
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
        description={`Imported research dossiers by group. ${RESEARCH_REPORTS_NOTICE}`}
        status={catalogStatus(state.type)}
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
                    {metric.period ?? "—"}
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

/** One tab: StickyTabs mounts only the open tab, so each opening reads its dataset afresh. */
const DatasetTab = ({
  dataset,
  gateway,
  reportId,
}: {
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
    <div data-research-report-state={state.type}>
      <LoadGate
        label={`${label} dataset`}
        onRetry={() => void load()}
        state={state}
      >
        {(data) => (
          <DatasetPanels label={label} view={toDatasetViewModel(data)} />
        )}
      </LoadGate>
    </div>
  );
};

/**
 * The report's real ticker from the catalog (a report id such as `brk-b` is not a symbol).
 * Undefined while loading, when the catalog read fails or when the report is not listed.
 */
const useReportSymbol = (
  gateway: ResearchReportsGateway,
  reportId: string
): string | undefined => {
  const [found, setFound] = useState<
    Readonly<{ reportId: string; symbol: string | undefined }> | undefined
  >(undefined);
  useEffect(() => {
    gateway.list().then(
      (catalog) =>
        setFound({
          reportId,
          symbol: catalog.reports.find((report) => report.id === reportId)
            ?.symbol,
        }),
      () => undefined
    );
  }, [gateway, reportId]);
  return found?.reportId === reportId ? found.symbol : undefined;
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
  const symbol = useReportSymbol(gateway, reportId);
  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb href={RESEARCH_REPORTS_PATH} label="Research dossiers" />
        }
        description={
          <>
            Imported research for{" "}
            {symbol === undefined ? reportId : <TickerLink symbol={symbol} />},
            one dataset per tab. {RESEARCH_REPORTS_NOTICE}
          </>
        }
        status={<StatusBadge status="info">Research only</StatusBadge>}
        title={`${reportId} dossier`}
      />
      <StickyTabs
        {...(initialTab === undefined ? {} : { initialValue: initialTab })}
        label="Dataset"
        tabs={DATASET_TABS.map((tab) => ({
          content: (
            <DatasetTab
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
