"use client";

import {
  RESEARCH_PAPER_STAGE_VALUES,
  RESEARCH_PAPER_VERDICT_VALUES,
  type ResearchPaperOutput,
  type ResearchPaperStageValue,
  type ResearchPaperVerdictValue,
} from "@darkfactory/api";
import {
  Button,
  Input,
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
import { ChevronDown, Download, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createBrowserPapersGateway,
  describeAgentOpsFailure,
  formatMetrics,
  formatTimestamp,
  InfoGlyph,
  isOperatorAccessDenied,
  labelFor,
  metricsToText,
  OperatorAccessRequired,
  type PapersGateway,
  parseMetricsText,
  STAGE_LABELS,
  upsertById,
} from "./agent-ops-client.tsx";

export interface PapersWorkspaceProps {
  readonly gateway?: PapersGateway;
  // Stage filter from ?status=; anything that is not a stage shows every paper.
  readonly initialStatus?: string | null;
}

// Rows per table page; longer libraries page with Previous / Next.
export const PAPERS_PAGE_SIZE = 25;

const isStage = (value: string | null): value is ResearchPaperStageValue =>
  (RESEARCH_PAPER_STAGE_VALUES as readonly string[]).includes(value ?? "");

// Mirrors the stage filter into ?status= without a navigation.
const writeStatusParam = (stage: ResearchPaperStageValue | null): void => {
  const url = new URL(window.location.href);
  if (stage === null) url.searchParams.delete("status");
  else url.searchParams.set("status", stage);
  window.history.replaceState(window.history.state, "", url);
};

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; papers: ResearchPaperOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type Draft = Readonly<{
  id: string;
  stage: ResearchPaperStageValue;
  verdict: ResearchPaperVerdictValue;
  blockers: string;
  notes: string;
  reported: string;
  reproduced: string;
}>;

const selectClass =
  "h-11 rounded-md border border-border bg-background px-2 text-sm";
const areaClass =
  "min-h-20 w-full rounded-md border border-border bg-background p-2 text-xs";

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const PapersPager = ({
  onPage,
  page,
  shown,
  total,
}: Readonly<{
  onPage: (page: number) => void;
  page: number;
  shown: number;
  total: number;
}>) => {
  if (total <= PAPERS_PAGE_SIZE) return null;
  const first = page * PAPERS_PAGE_SIZE;
  return (
    <nav
      aria-label="Papers pages"
      className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs"
    >
      <span data-testid="papers-page-range">
        {first + 1}–{first + shown} of {total}
      </span>
      <span className="inline-flex gap-1">
        <Button
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          type="button"
          variant="secondary"
        >
          Previous
        </Button>
        <Button
          disabled={first + shown >= total}
          onClick={() => onPage(page + 1)}
          type="button"
          variant="secondary"
        >
          Next
        </Button>
      </span>
    </nav>
  );
};

const statusText = (state: ListState): string => {
  if (state.type === "loading") return "Loading";
  if (state.type !== "ready") return "Unavailable";
  const count = state.papers.length;
  return `${count} ${count === 1 ? "paper" : "papers"}`;
};

export const PapersWorkspace = ({
  gateway: suppliedGateway,
  initialStatus = null,
}: PapersWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserPapersGateway()
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [arxiv, setArxiv] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [stageFilter, setStageFilter] =
    useState<ResearchPaperStageValue | null>(
      isStage(initialStatus) ? initialStatus : null
    );
  const [page, setPage] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      return setState({ papers: await gateway.list(), type: "ready" });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { message: describeAgentOpsFailure(error), type: "error" }
      );
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const replace = (paper: ResearchPaperOutput): void => {
    setState((current) =>
      current.type === "ready"
        ? {
            papers: current.papers.some((row) => row.id === paper.id)
              ? upsertById(current.papers, paper)
              : [...current.papers, paper],
            type: "ready",
          }
        : current
    );
  };

  const add = async (): Promise<void> => {
    if (title.trim() === "") {
      setFeedback("Title is required.");
      return;
    }
    setBusy(true);
    try {
      const paper = await gateway.add({ sourceUrl: blankToNull(url), title });
      replace(paper);
      setTitle("");
      setUrl("");
      setFeedback(`Added ${paper.title}`);
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const addArxiv = async (): Promise<void> => {
    if (arxiv.trim() === "") {
      setFeedback("arXiv ID or URL is required.");
      return;
    }
    setBusy(true);
    try {
      const result = await gateway.addFromArxiv(arxiv.trim());
      replace(result.paper);
      setArxiv("");
      setFeedback(
        result.created
          ? `Added ${result.paper.identifier ?? result.paper.title} from the arXiv API`
          : `Already listed: ${result.paper.identifier ?? result.paper.title}`
      );
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (current: Draft): Promise<void> => {
    const reportedMetrics = parseMetricsText(current.reported);
    const reproducedMetrics = parseMetricsText(current.reproduced);
    if (
      typeof reportedMetrics === "string" ||
      typeof reproducedMetrics === "string"
    ) {
      setFeedback(
        typeof reportedMetrics === "string"
          ? reportedMetrics
          : String(reproducedMetrics)
      );
      return;
    }
    setBusy(true);
    try {
      const paper = await gateway.update({
        blockers: blankToNull(current.blockers),
        id: current.id,
        notes: blankToNull(current.notes),
        reportedMetrics,
        reproducedMetrics,
        stage: current.stage,
        verdict: current.verdict,
      });
      replace(paper);
      setDraft(null);
      setFeedback(`Saved ${paper.title}`);
    } catch (error) {
      setFeedback(describeAgentOpsFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const edit = (paper: ResearchPaperOutput): void => {
    setDraft({
      blockers: paper.blockers ?? "",
      id: paper.id,
      notes: paper.notes ?? "",
      reported: metricsToText(paper.reportedMetrics),
      reproduced: metricsToText(paper.reproducedMetrics),
      stage: paper.stage,
      verdict: paper.verdict,
    });
  };

  const openManual = (): void => {
    setManualOpen(true);
    // Focus after the form renders.
    queueMicrotask(() => titleRef.current?.focus());
  };

  const changeStage = (value: string): void => {
    const next = isStage(value) ? value : null;
    setStageFilter(next);
    setPage(0);
    writeStatusParam(next);
  };

  const header = (
    <PageHeader
      actions={
        state.type === "forbidden" ? undefined : (
          <Button onClick={openManual} type="button">
            <Plus aria-hidden="true" className="size-4" />
            Add paper
          </Button>
        )
      }
      status={
        state.type === "forbidden" ? undefined : (
          <StatusBadge
            data-testid="papers-status"
            status={state.type === "error" ? "destructive" : "neutral"}
          >
            {statusText(state)}
          </StatusBadge>
        )
      }
      title="Papers"
    />
  );

  if (state.type === "forbidden")
    return (
      <div className="space-y-6">
        {header}
        <OperatorAccessRequired feature="papers" />
      </div>
    );

  const filtered =
    state.type === "ready"
      ? state.papers.filter(
          (paper) => stageFilter === null || paper.stage === stageFilter
        )
      : [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAPERS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(
    currentPage * PAPERS_PAGE_SIZE,
    (currentPage + 1) * PAPERS_PAGE_SIZE
  );

  return (
    <div className="space-y-6">
      {header}
      <Panel
        headingId="papers-arxiv-heading"
        title={
          <>
            Add from arXiv
            <InfoGlyph text="Fetches title, authors, year, versioned identifier and abstract from the official arXiv API (export.arxiv.org). Stage is set to Ingested. An identifier already listed returns the existing row." />
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-64 flex-1 text-xs">
              arXiv ID or URL
              <Input
                aria-label="arXiv ID or URL"
                maxLength={300}
                onChange={(event) => setArxiv(event.target.value)}
                placeholder="2402.05272 or https://arxiv.org/abs/2402.05272v3"
                value={arxiv}
              />
            </label>
            <Button
              disabled={busy}
              onClick={() => void addArxiv()}
              type="button"
            >
              <Download aria-hidden="true" className="size-4" />
              Add from arXiv
            </Button>
          </div>
          <Button
            aria-controls="papers-manual-entry"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            <ChevronDown
              aria-hidden="true"
              className={manualOpen ? "size-4 rotate-180" : "size-4"}
            />
            Add paper manually
          </Button>
          {manualOpen ? (
            <section
              aria-labelledby="papers-add-heading"
              className="space-y-2"
              id="papers-manual-entry"
            >
              <h3 className="font-medium text-sm" id="papers-add-heading">
                Manual entry
                <InfoGlyph text="Title is required. URL is optional (http or https). Use this form for SSRN, DOI and other sources." />
              </h3>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-64 flex-1 text-xs">
                  Title
                  <Input
                    aria-label="Paper title"
                    maxLength={300}
                    onChange={(event) => setTitle(event.target.value)}
                    ref={titleRef}
                    value={title}
                  />
                </label>
                <label className="min-w-64 flex-1 text-xs">
                  Source URL (optional)
                  <Input
                    inputMode="url"
                    maxLength={2000}
                    onChange={(event) => setUrl(event.target.value)}
                    value={url}
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={() => void add()}
                  type="button"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Save paper
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      </Panel>
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      <Panel
        actions={
          <label className="flex items-center gap-2 text-xs">
            Stage
            <select
              aria-label="Filter by stage"
              className={selectClass}
              onChange={(event) => changeStage(event.target.value)}
              value={stageFilter ?? ""}
            >
              <option value="">All stages</option>
              {RESEARCH_PAPER_STAGE_VALUES.map((stage) => (
                <option key={stage} value={stage}>
                  {labelFor(STAGE_LABELS, stage)}
                </option>
              ))}
            </select>
          </label>
        }
        flush
        headingId="papers-library-heading"
        title="Library"
      >
        {state.type === "loading" ? (
          <p aria-busy="true" className="p-4 text-muted-foreground text-sm">
            Loading papers…
          </p>
        ) : state.type === "error" ? (
          <div className="space-y-2 p-4" role="alert">
            <p className="text-sm">{state.message}</p>
            <Button
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        ) : state.papers.length === 0 ? (
          <p className="p-4 text-muted-foreground text-sm">
            No papers. Add one above, or apply migration 0015 to load the four
            seeded references.
          </p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-muted-foreground text-sm">
            No papers at this stage.
          </p>
        ) : (
          <>
            <TableScroll label="Research papers table" minWidth="72rem">
              <Table className="w-full text-sm" data-click-private="">
                <TableCaption className="sr-only">Research papers</TableCaption>
                <TableHeader>
                  <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                    <TableHead className="text-muted-foreground" scope="col">
                      Paper
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      Stage
                      <InfoGlyph text="Queued → ingested → spec extracted → implemented → backtested → forward tested → verdict." />
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      Verdict
                      <InfoGlyph text="Pending until a reproduced backtest and forward test exist." />
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      Blockers
                      <InfoGlyph text="Unresolved specification details or missing data that stop the next stage." />
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      Reported / reproduced
                      <InfoGlyph text="Reported: values claimed by the source, unverified. Reproduced: values from our own runs." />
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      Updated (UTC)
                    </TableHead>
                    <TableHead className="text-muted-foreground" scope="col">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((paper) => {
                    const editingDraft =
                      draft !== null && draft.id === paper.id ? draft : null;
                    return (
                      <TableRow
                        className="border-border border-b [&>td]:align-top [&>th]:align-top"
                        data-paper-id={paper.id}
                        key={paper.id}
                      >
                        <TableHead
                          className="min-w-72 max-w-md whitespace-normal py-1 font-normal"
                          scope="row"
                        >
                          {paper.sourceUrl === null ? (
                            paper.title
                          ) : (
                            <a
                              className="underline underline-offset-2"
                              href={paper.sourceUrl}
                              rel="noreferrer noopener"
                              target="_blank"
                            >
                              {paper.title}
                            </a>
                          )}
                          <div className="text-muted-foreground text-xs">
                            {[
                              paper.kind === "article" ? "Article" : null,
                              paper.authors,
                              paper.year === null ? null : String(paper.year),
                              paper.identifier,
                            ]
                              .filter((part) => part !== null)
                              .join(" · ")}
                          </div>
                          {editingDraft ? (
                            <textarea
                              aria-label={`${paper.title} notes`}
                              className={areaClass}
                              maxLength={4000}
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  notes: event.target.value,
                                })
                              }
                              placeholder="Notes"
                              value={editingDraft.notes}
                            />
                          ) : paper.notes === null ? null : (
                            <p className="mt-1 text-xs">{paper.notes}</p>
                          )}
                        </TableHead>
                        <TableCell
                          className="whitespace-normal py-1"
                          data-stage={paper.stage}
                        >
                          {editingDraft ? (
                            <select
                              aria-label={`${paper.title} stage`}
                              className={selectClass}
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  stage: event.target
                                    .value as ResearchPaperStageValue,
                                })
                              }
                              value={editingDraft.stage}
                            >
                              {RESEARCH_PAPER_STAGE_VALUES.map((stage) => (
                                <option key={stage} value={stage}>
                                  {labelFor(STAGE_LABELS, stage)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            labelFor(STAGE_LABELS, paper.stage)
                          )}
                        </TableCell>
                        <TableCell
                          className="whitespace-normal py-1"
                          data-verdict={paper.verdict}
                        >
                          {editingDraft ? (
                            <select
                              aria-label={`${paper.title} verdict`}
                              className={selectClass}
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  verdict: event.target
                                    .value as ResearchPaperVerdictValue,
                                })
                              }
                              value={editingDraft.verdict}
                            >
                              {RESEARCH_PAPER_VERDICT_VALUES.map((verdict) => (
                                <option key={verdict} value={verdict}>
                                  {verdict}
                                </option>
                              ))}
                            </select>
                          ) : (
                            paper.verdict
                          )}
                        </TableCell>
                        <TableCell className="min-w-56 max-w-sm whitespace-normal py-1 text-xs">
                          {editingDraft ? (
                            <textarea
                              aria-label={`${paper.title} blockers`}
                              className={areaClass}
                              maxLength={4000}
                              onChange={(event) =>
                                setDraft({
                                  ...editingDraft,
                                  blockers: event.target.value,
                                })
                              }
                              value={editingDraft.blockers}
                            />
                          ) : (
                            (paper.blockers ?? "—")
                          )}
                        </TableCell>
                        <TableCell className="min-w-40 whitespace-normal py-1 font-mono text-xs">
                          {editingDraft ? (
                            <div className="space-y-1">
                              <textarea
                                aria-label={`${paper.title} reported metrics`}
                                className={areaClass}
                                onChange={(event) =>
                                  setDraft({
                                    ...editingDraft,
                                    reported: event.target.value,
                                  })
                                }
                                placeholder="sharpe=1.13"
                                value={editingDraft.reported}
                              />
                              <textarea
                                aria-label={`${paper.title} reproduced metrics`}
                                className={areaClass}
                                onChange={(event) =>
                                  setDraft({
                                    ...editingDraft,
                                    reproduced: event.target.value,
                                  })
                                }
                                placeholder="sharpe=0.9"
                                value={editingDraft.reproduced}
                              />
                            </div>
                          ) : (
                            <div>
                              <div>
                                R: {formatMetrics(paper.reportedMetrics)}
                              </div>
                              <div>
                                P: {formatMetrics(paper.reproducedMetrics)}
                              </div>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal py-1 font-mono text-muted-foreground text-xs">
                          {formatTimestamp(paper.updatedAt)}
                        </TableCell>
                        <TableCell className="whitespace-normal py-1 text-right">
                          {editingDraft ? (
                            <span className="inline-flex gap-1">
                              <Button
                                disabled={busy}
                                onClick={() => void save(editingDraft)}
                                type="button"
                              >
                                Save
                              </Button>
                              <Button
                                onClick={() => setDraft(null)}
                                type="button"
                                variant="secondary"
                              >
                                Cancel
                              </Button>
                            </span>
                          ) : (
                            <Button
                              aria-label={`Edit ${paper.title}`}
                              onClick={() => edit(paper)}
                              type="button"
                              variant="secondary"
                            >
                              <Pencil aria-hidden="true" className="size-4" />
                              Edit
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
            <PapersPager
              onPage={setPage}
              page={currentPage}
              shown={pageRows.length}
              total={filtered.length}
            />
          </>
        )}
      </Panel>
    </div>
  );
};
