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
  PageHeader,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { ArrowLeft, FileText, RotateCcw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type CatalogGroupView,
  DATASET_LABELS,
  DATASET_TABS,
  type DatasetView,
  RESEARCH_REPORTS_NOTICE,
  RESEARCH_REPORTS_PATH,
  toCatalogViewModel,
  toDatasetViewModel,
} from "../../features/research-reports/view-model.ts";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Research dossier pages (researchReports.*): the imported workspace catalog and one report's
// datasets. Read-only and operator-only. Rows come from `bun run vertex:research-reports:import`.

export interface ResearchReportsGateway {
  readonly list: () => Promise<ResearchReportsListOutput>;
  readonly dataset: (
    reportId: string,
    dataset: ResearchReportDatasetName
  ) => Promise<ResearchReportDatasetOutput>;
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

const CatalogGroup = ({ group }: { readonly group: CatalogGroupView }) => (
  <section
    aria-labelledby={`research-group-${group.id}`}
    className="space-y-2"
    data-research-group={group.id}
  >
    <div className="space-y-1">
      <h2 className="font-medium text-base" id={`research-group-${group.id}`}>
        {group.label}
      </h2>
      <p className="text-muted-foreground text-sm">{group.description}</p>
    </div>
    <Table className="text-sm">
      <TableCaption className="sr-only">{group.label} reports</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Report</TableHead>
          <TableHead className="hidden sm:table-cell" scope="col">
            Type
          </TableHead>
          <TableHead className="hidden md:table-cell" scope="col">
            Company research
          </TableHead>
          <TableHead scope="col">Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {group.reports.map((report) => (
          <TableRow data-research-report={report.id} key={report.id}>
            <TableHead className="whitespace-normal font-normal" scope="row">
              <a
                className="inline-flex min-h-11 items-center gap-2 underline underline-offset-2"
                href={report.href}
              >
                <span className="font-medium">{report.symbol}</span>
                <span className="text-muted-foreground">{report.name}</span>
              </a>
            </TableHead>
            <TableCell className="hidden sm:table-cell">
              {report.assetType}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              {report.research ? "Accepted" : "—"}
            </TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">
              {report.updated}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </section>
);

export const ResearchReportsCatalog = ({
  gateway: supplied,
}: Readonly<{ gateway?: ResearchReportsGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchReportsGateway()
  );
  const { load, state } = useLoad(() => gateway.list(), "catalog");
  return (
    <div className="space-y-6" data-research-reports-state={state.type}>
      <PageHeader title="Research dossiers" />
      <p className="text-muted-foreground text-sm">
        Dossiers imported from the research workspace, by group.{" "}
        {RESEARCH_REPORTS_NOTICE}
      </p>
      <LoadGate
        label="Research dossiers"
        onRetry={() => void load()}
        state={state}
      >
        {(data) => {
          const groups = toCatalogViewModel(data);
          return groups.length === 0 ? (
            <EmptyState
              description={
                <>
                  Import them with{" "}
                  <code>bun run vertex:research-reports:import</code>.
                </>
              }
              headingLevel={2}
              icon={<FileText />}
              title="No research dossiers imported yet"
            />
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <CatalogGroup group={group} key={group.id} />
              ))}
            </div>
          );
        }}
      </LoadGate>
    </div>
  );
};

const DatasetBody = ({ view }: { readonly view: DatasetView }) => (
  <div className="space-y-6 text-sm">
    <p className="text-muted-foreground text-xs">
      {view.asOf === null ? null : <>As of {view.asOf} · </>}
      Revision <code>{view.revision}</code> ({view.revisionCount} stored)
    </p>
    {view.title === null ? null : <p className="font-medium">{view.title}</p>}
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
    {view.metrics.length === 0 ? null : (
      <Table>
        <TableCaption className="sr-only">Metrics</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Metric</TableHead>
            <TableHead scope="col">Value</TableHead>
            <TableHead className="hidden sm:table-cell" scope="col">
              Period
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.metrics.map((metric, index) => (
            <TableRow key={index}>
              <TableHead className="whitespace-normal font-normal" scope="row">
                {metric.label}
              </TableHead>
              <TableCell className="whitespace-normal">
                {metric.value}
              </TableCell>
              <TableCell className="hidden whitespace-normal text-muted-foreground sm:table-cell">
                {metric.period ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )}
    {view.newsItems.length === 0 ? null : (
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
    )}
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
    {view.sources.length === 0 ? null : (
      <details data-dataset-sources="">
        <summary className="min-h-11 cursor-pointer content-center font-medium">
          Sources ({view.sources.length})
        </summary>
        <ul className="list-disc space-y-1 pb-2 pl-5">
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
      </details>
    )}
  </div>
);

export const ResearchReportDetail = ({
  reportId,
  gateway: supplied,
}: Readonly<{ reportId: string; gateway?: ResearchReportsGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserResearchReportsGateway()
  );
  const [dataset, setDataset] =
    useState<ResearchReportDatasetName>("fundamentals");
  const { load, state } = useLoad(
    () => gateway.dataset(reportId, dataset),
    `${reportId}/${dataset}`
  );
  const label = DATASET_LABELS[dataset];
  return (
    <div className="space-y-6" data-research-report-state={state.type}>
      <p>
        <a
          className="inline-flex min-h-11 items-center gap-2 text-sm underline underline-offset-2"
          href={RESEARCH_REPORTS_PATH}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All research dossiers
        </a>
      </p>
      <PageHeader
        actions={<StatusBadge status="neutral">Research only</StatusBadge>}
        title={`${reportId} dossier`}
      />
      <div aria-label="Dataset" className="flex flex-wrap gap-2" role="group">
        {DATASET_TABS.map((tab) => (
          <Button
            aria-pressed={tab.id === dataset}
            data-dataset-tab={tab.id}
            key={tab.id}
            onClick={() => setDataset(tab.id)}
            variant={tab.id === dataset ? "default" : "outline"}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <section aria-labelledby="research-dataset-heading">
        <h2 className="sr-only" id="research-dataset-heading">
          {label}
        </h2>
        <LoadGate
          label={`${label} dataset`}
          onRetry={() => void load()}
          state={state}
        >
          {(data) => <DatasetBody view={toDatasetViewModel(data)} />}
        </LoadGate>
      </section>
      <p className="text-muted-foreground text-xs">{RESEARCH_REPORTS_NOTICE}</p>
    </div>
  );
};
