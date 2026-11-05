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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { Download, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
}

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
  "h-9 rounded-md border border-border bg-background px-2 text-sm";
const areaClass =
  "min-h-20 w-full rounded-md border border-border bg-background p-2 text-xs";

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export const PapersWorkspace = ({
  gateway: suppliedGateway,
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

  const save = async (): Promise<void> => {
    if (draft === null) return;
    const reportedMetrics = parseMetricsText(draft.reported);
    const reproducedMetrics = parseMetricsText(draft.reproduced);
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
        blockers: blankToNull(draft.blockers),
        id: draft.id,
        notes: blankToNull(draft.notes),
        reportedMetrics,
        reproducedMetrics,
        stage: draft.stage,
        verdict: draft.verdict,
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

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="papers" />;

  return (
    <div className="space-y-6">
      <section aria-labelledby="papers-arxiv-heading" className="space-y-2">
        <h2 className="font-medium text-sm" id="papers-arxiv-heading">
          Add from arXiv
          <InfoGlyph text="Fetches title, authors, year, versioned identifier and abstract from the official arXiv API (export.arxiv.org). Stage is set to Ingested. An identifier already listed returns the existing row." />
        </h2>
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
          <Button disabled={busy} onClick={() => void addArxiv()} type="button">
            <Download aria-hidden="true" className="size-4" />
            Add from arXiv
          </Button>
        </div>
      </section>
      <section aria-labelledby="papers-add-heading" className="space-y-2">
        <h2 className="font-medium text-sm" id="papers-add-heading">
          Add paper manually
          <InfoGlyph text="Title is required. URL is optional (http or https). Use this form for SSRN, DOI and other sources." />
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1 text-xs">
            Title
            <Input
              aria-label="Paper title"
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label className="min-w-64 flex-1 text-xs">
            Source URL (optional)
            <Input
              aria-label="Paper URL"
              inputMode="url"
              maxLength={2000}
              onChange={(event) => setUrl(event.target.value)}
              value={url}
            />
          </label>
          <Button disabled={busy} onClick={() => void add()} type="button">
            <Plus aria-hidden="true" className="size-4" />
            Add paper
          </Button>
        </div>
      </section>
      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>
      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading papers…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : state.papers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No papers. Add a title above, or apply migration 0015 to load the four
          seeded references.
        </p>
      ) : (
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
            {state.papers.map((paper) => {
              const editingDraft =
                draft !== null && draft.id === paper.id ? draft : null;
              return (
                <TableRow
                  className="border-border border-b [&>td]:align-top [&>th]:align-top"
                  data-paper-id={paper.id}
                  key={paper.id}
                >
                  <TableHead
                    className="max-w-xs whitespace-normal py-1 font-normal"
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
                  <TableCell className="max-w-sm whitespace-normal py-1 text-xs">
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
                  <TableCell className="whitespace-normal py-1 font-mono text-xs">
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
                        <div>R: {formatMetrics(paper.reportedMetrics)}</div>
                        <div>P: {formatMetrics(paper.reproducedMetrics)}</div>
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
                          onClick={() => void save()}
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
      )}
    </div>
  );
};
