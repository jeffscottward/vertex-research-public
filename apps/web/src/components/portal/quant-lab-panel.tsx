"use client";

import {
  type ApiClient,
  createApiClient,
  type QuantLabCapture,
  type QuantLabJsonObject,
  type QuantLabListOutput,
  type QuantLabStudy,
} from "@darkfactory/api";
import {
  Button,
  EmptyState,
  Skeleton,
  StatusBadge,
  type StatusBadgeProps,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { FlaskConical, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { formatTimestamp } from "./agent-ops-client.tsx";
import { describePortfolioMonitorFailure } from "./portfolio-monitor-client.ts";

// Quant Lab section of the Backtests page (quantLab.list): SSRN papers turned into frozen strategy
// specs and walk-forward backtests. Read-only. Records come from `bun run vertex:quantlab:record`.

export interface QuantLabGateway {
  readonly list: () => Promise<QuantLabListOutput>;
}

export const createBrowserQuantLabGateway = (): QuantLabGateway => {
  let client: ApiClient | undefined;
  return Object.freeze({
    list: () => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client.quantLab.list({});
    },
  });
};

export const QUANT_LAB_RECORD_COMMAND = "bun run vertex:quantlab:record";
export const QUANT_LAB_RESEARCH_NOTICE =
  "Research only; a verdict does not authorize a trade.";

type Verdict = NonNullable<QuantLabStudy["paper"]>["verdict"];

const VERDICT_TONES: Readonly<Record<Verdict, StatusBadgeProps["status"]>> =
  Object.freeze({
    inconclusive: "warning",
    pending: "neutral",
    promising: "success",
    rejected: "destructive",
  });

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/u;
const HTTP_PATTERN = /^https?:\/\//u;

// DOI first (stable), then the stored source URL; only http(s) links are rendered.
export const paperHref = (paper: QuantLabStudy["paper"]): string | null => {
  if (paper === null) return null;
  if (paper.identifier !== null && DOI_PATTERN.test(paper.identifier))
    return `https://doi.org/${paper.identifier}`;
  if (paper.sourceUrl !== null && HTTP_PATTERN.test(paper.sourceUrl))
    return paper.sourceUrl;
  return null;
};

const metric = (
  metrics: Readonly<Record<string, number | string>>,
  key: string
): number | null => {
  const value = metrics[key];
  return typeof value === "number" ? value : null;
};

export const formatRatio = (value: number | null): string =>
  value === null ? "—" : value.toFixed(2);

export const formatPct = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export type StudyMetric = Readonly<{
  label: string;
  strategy: string;
  benchmark: string | null;
}>;

// Walk-forward (stitched out-of-sample) figures next to buy and hold on the same days.
export const studyMetrics = (
  backtest: NonNullable<QuantLabStudy["backtest"]>
): StudyMetric[] => {
  const { metrics } = backtest;
  const rows: StudyMetric[] = [];
  if (metric(metrics, "wf_sharpe") !== null)
    rows.push({
      benchmark: formatRatio(metric(metrics, "bh_sharpe")),
      label: "Sharpe",
      strategy: formatRatio(metric(metrics, "wf_sharpe")),
    });
  if (metric(metrics, "wf_cagr") !== null)
    rows.push({
      benchmark: formatPct(metric(metrics, "bh_cagr")),
      label: "CAGR",
      strategy: formatPct(metric(metrics, "wf_cagr")),
    });
  const drawdown = metric(metrics, "wf_max_drawdown") ?? backtest.maxDrawdown;
  if (drawdown !== null)
    rows.push({
      benchmark: formatPct(metric(metrics, "bh_max_drawdown")),
      label: "Max drawdown",
      strategy: formatPct(drawdown),
    });
  return rows;
};

export type CriterionLine = Readonly<{
  outcome: "pass" | "fail" | null;
  text: string;
}>;

// Backtest notes: one line per preregistered criterion ("PASS ..." / "FAIL ...") plus provenance.
export const criterionLines = (notes: string | null): CriterionLine[] =>
  (notes ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      if (line.startsWith("PASS "))
        return { outcome: "pass", text: line.slice(5) };
      if (line.startsWith("FAIL "))
        return { outcome: "fail", text: line.slice(5) };
      return { outcome: null, text: line };
    });

export type PaperClaim = Readonly<{ quote: string; locator: string | null }>;

export const paperClaim = (claim: QuantLabJsonObject): PaperClaim => {
  const { locator, quote } = claim;
  return {
    locator: typeof locator === "string" ? locator : null,
    quote: typeof quote === "string" ? quote : JSON.stringify(claim),
  };
};

export const readingLabel = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const scalar = (value: unknown): string =>
  value === null ? "—" : typeof value === "string" ? value : String(value);

const ReadingValue = ({ value }: { readonly value: unknown }): ReactNode => {
  if (Array.isArray(value))
    return (
      <ul className="list-disc space-y-1 pl-5">
        {value.map((item, index) => (
          <li key={index}>{scalar(item)}</li>
        ))}
      </ul>
    );
  if (typeof value === "object" && value !== null)
    return (
      <ul className="space-y-1">
        {Object.entries(value).map(([key, item]) => (
          <li key={key}>{`${readingLabel(key)}: ${scalar(item)}`}</li>
        ))}
      </ul>
    );
  return <p>{scalar(value)}</p>;
};

const StudyDetail = ({ study }: { readonly study: QuantLabStudy }) => {
  const criteria = criterionLines(study.backtest?.notes ?? null);
  return (
    <details data-quant-lab-detail="">
      <summary className="min-h-11 cursor-pointer content-center font-medium text-sm">
        Paper claims, our reading and criteria
      </summary>
      <div className="space-y-4 pb-2 text-sm">
        <div className="space-y-2">
          <h4 className="font-medium">Paper claims</h4>
          <ul className="space-y-2">
            {study.paperClaims.map(paperClaim).map((claim, index) => (
              <li key={index}>
                <blockquote className="border-border border-l-2 pl-3">
                  {claim.quote}
                </blockquote>
                {claim.locator === null ? null : (
                  <p className="pl-3 text-muted-foreground text-xs">
                    Source: {claim.locator}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <h4 className="font-medium">Our reading</h4>
          <dl className="space-y-2">
            {Object.entries(study.ourReading).map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted-foreground text-xs">
                  {readingLabel(key)}
                </dt>
                <dd>
                  <ReadingValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="space-y-2">
          <h4 className="font-medium">Backtest notes</h4>
          {criteria.length === 0 ? (
            <p className="text-muted-foreground">No backtest notes.</p>
          ) : (
            <ul className="space-y-1" data-quant-lab-criteria="">
              {criteria.map((line, index) => (
                <li className="flex items-start gap-2" key={index}>
                  {line.outcome === null ? null : (
                    <StatusBadge
                      data-outcome={line.outcome}
                      status={
                        line.outcome === "pass" ? "success" : "destructive"
                      }
                    >
                      {line.outcome === "pass" ? "Pass" : "Fail"}
                    </StatusBadge>
                  )}
                  <span>{line.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
};

const StudyCard = ({ study }: { readonly study: QuantLabStudy }) => {
  const verdict: Verdict = study.paper?.verdict ?? "pending";
  const href = paperHref(study.paper);
  const headingId = `quant-lab-study-${study.id}`;
  const { backtest } = study;
  return (
    <li>
      <article
        aria-labelledby={headingId}
        className="space-y-3 rounded-md border border-border p-3"
        data-quant-lab-study={study.id}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <h3 className="font-medium text-sm" id={headingId}>
              {study.name}
            </h3>
            <p className="text-muted-foreground text-xs">
              {study.paper === null ? (
                "No linked paper"
              ) : href === null ? (
                study.paper.title
              ) : (
                <a
                  className="underline underline-offset-2"
                  href={href}
                  rel="noreferrer"
                  target="_blank"
                >
                  {study.paper.title}
                </a>
              )}
            </p>
          </div>
          <StatusBadge data-verdict={verdict} status={VERDICT_TONES[verdict]}>
            {verdict}
          </StatusBadge>
        </div>
        {backtest === null ? (
          <p className="text-muted-foreground text-sm">No backtest yet.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Period </span>
              {`${backtest.periodStart} to ${backtest.periodEnd}`}
              <span className="text-muted-foreground">
                {` · ${backtest.instruments} · `}
              </span>
              <a
                className="font-mono text-xs underline underline-offset-2"
                href={`/backtests?id=${encodeURIComponent(backtest.id)}`}
              >
                {backtest.id}
              </a>
            </p>
            <Table className="text-sm">
              <TableCaption className="sr-only">
                {`${study.name}: walk-forward result against buy and hold`}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Measure</TableHead>
                  <TableHead className="text-right" scope="col">
                    Walk-forward
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    Buy and hold
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {studyMetrics(backtest).map((row) => (
                  <TableRow data-metric={row.label} key={row.label}>
                    <TableHead
                      className="h-auto whitespace-normal font-normal"
                      scope="row"
                    >
                      {row.label}
                    </TableHead>
                    <TableCell className="text-right tabular-nums">
                      {row.strategy}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.benchmark}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <StudyDetail study={study} />
      </article>
    </li>
  );
};

export const pdfLabel = (status: string): string =>
  status === "retained"
    ? "Retained"
    : `Metadata only (${status.replace(/^metadata_only:/u, "").replaceAll("_", " ")})`;

const CapturesTable = ({
  captures,
}: {
  readonly captures: readonly QuantLabCapture[];
}) => (
  <div className="space-y-2">
    <h3 className="font-medium text-sm">Recent SSRN captures</h3>
    {captures.length === 0 ? (
      <p className="text-muted-foreground text-sm">No captures yet.</p>
    ) : (
      <Table className="text-sm">
        <TableCaption className="sr-only">
          Recent SSRN paper captures
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Title</TableHead>
            <TableHead className="hidden sm:table-cell" scope="col">
              Topic
            </TableHead>
            <TableHead className="hidden sm:table-cell" scope="col">
              PDF
            </TableHead>
            <TableHead scope="col">Captured</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {captures.map((capture) => (
            <TableRow data-capture={capture.id} key={capture.id}>
              <TableHead
                className="h-auto whitespace-normal font-normal"
                scope="row"
              >
                {HTTP_PATTERN.test(capture.url) ? (
                  <a
                    className="underline underline-offset-2"
                    href={capture.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {capture.title}
                  </a>
                ) : (
                  capture.title
                )}
              </TableHead>
              <TableCell className="hidden sm:table-cell">
                {capture.topic}
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {pdfLabel(capture.pdfStatus)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatTimestamp(capture.capturedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )}
  </div>
);

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "ready"; data: QuantLabListOutput }>;

const Body = ({
  state,
  onRetry,
}: {
  readonly state: State;
  readonly onRetry: () => void;
}) => {
  if (state.type === "loading")
    return (
      <div aria-busy="true" className="min-h-40 space-y-2" role="status">
        <span className="sr-only">Loading Quant Lab studies</span>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (state.type === "forbidden")
    return (
      <p className="min-h-40 text-muted-foreground text-sm" role="status">
        Quant Lab studies are limited to operators.
      </p>
    );
  if (state.type === "error")
    return (
      <div className="min-h-40 space-y-3">
        <p className="text-sm" role="alert">
          Quant Lab unavailable. {state.message}
        </p>
        <Button onClick={onRetry} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </div>
    );
  const { studies, captures } = state.data;
  return (
    <div className="space-y-4">
      {studies.length === 0 ? (
        <EmptyState
          description={
            <>
              Record one with <code>{QUANT_LAB_RECORD_COMMAND}</code>.
            </>
          }
          headingLevel={3}
          icon={<FlaskConical />}
          title="No Quant Lab studies recorded yet"
        />
      ) : (
        <ul
          aria-label="Quant Lab studies"
          className="space-y-3"
          data-click-private=""
        >
          {studies.map((study) => (
            <StudyCard key={study.id} study={study} />
          ))}
        </ul>
      )}
      <CapturesTable captures={captures} />
    </div>
  );
};

export const QuantLabPanel = ({
  gateway: supplied,
}: Readonly<{ gateway?: QuantLabGateway }>) => {
  const [gateway] = useState(() => supplied ?? createBrowserQuantLabGateway());
  const [state, setState] = useState<State>({ type: "loading" });
  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ data: await gateway.list(), type: "ready" });
    } catch (error) {
      const failure = describePortfolioMonitorFailure(error);
      return setState(
        failure.kind === "forbidden"
          ? { type: "forbidden" }
          : { message: `${failure.code}: ${failure.message}`, type: "error" }
      );
    }
  }, [gateway]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-labelledby="quant-lab-heading"
      className="space-y-4 rounded-lg border border-border p-4"
      data-quant-lab-state={state.type}
    >
      <div className="space-y-1">
        <h2 className="font-medium text-base" id="quant-lab-heading">
          Quant Lab
        </h2>
        <p className="text-muted-foreground text-sm">
          SSRN papers turned into frozen strategy specs and walk-forward
          backtests, with the criteria set before each run.{" "}
          {QUANT_LAB_RESEARCH_NOTICE}
        </p>
      </div>
      <Body onRetry={() => void load()} state={state} />
    </section>
  );
};
