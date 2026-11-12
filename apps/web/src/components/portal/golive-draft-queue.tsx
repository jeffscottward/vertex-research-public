"use client";

import {
  createApiClient,
  type GoLiveDraftApproveInput,
  type GoLiveDraftOutput,
  type GoLiveDraftRejectInput,
  type GoLivePlanOutput,
  type GoLiveQueueOutput,
} from "@darkfactory/api";
import { Button, Textarea } from "@darkfactory/ui";
import { Dialog, DialogContent } from "@darkfactory/ui/client/dialog";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  isOperatorAccessDenied,
  OperatorAccessRequired,
} from "./agent-ops-client.tsx";
import {
  APPROVAL_NOT_SENT_SENTENCE,
  accountText,
  approveBlockers,
  approvedOrderView,
  CURRENT_PRECHECK_LABEL,
  CURRENT_QUOTE_LABEL,
  CURRENT_SIZING_LABEL,
  currentSizingText,
  decisionAftermathText,
  decisionFailure,
  decisionText,
  draftStateText,
  draftsTitle,
  EXIT_GROUP_TITLE,
  emptyGroupText,
  entrySignalGroupTitle,
  etDayClock,
  exitReasonText,
  exitRuleText,
  expiryDate,
  type GoLiveDecisionFailure,
  type GoLiveDraftContext,
  generatorText,
  groupDrafts,
  keyedLines,
  limitText,
  loadErrorText,
  loadedText,
  MODEL_HOLDS_GROUP_TITLE,
  marketNotesText,
  maxLossText,
  NO_ORDERS_NOTICE_PARTS,
  NO_PLAN_TEXT,
  NODE_DISARMED_NOTE,
  nodeText,
  noteText,
  OTHER_GROUP_TITLE,
  OWNER_ONLY_DECISION_TEXT,
  orderLegLines,
  orderSummaryRows,
  PORTFOLIO_HREF,
  planLimitRows,
  planStatusText,
  planTitle,
  preCheckView,
  quantityText,
  quoteText,
  REJECT_NOTE_REQUIRED,
  REJECTION_RECORD_SENTENCE,
  safeHttpsUrl,
  sleeveRow,
  staleDialogNotice,
  staleDialogReason,
  strikesText,
  structureText,
} from "./golive-draft-queue-model.ts";

// Go-live order draft queue (/drafts): the allocation plan in force, the state of the account,
// node and generator, and the order drafts of the order session day. The owner approves or
// rejects each draft. The page has no polling: it says when it was loaded and has a Reload button.
// RECORDS ONLY: goLiveDrafts has no send route. An approval is a stored decision; the owner
// places an order through the Vertex orders tab of /portfolio.

export interface GoLiveDraftsGateway {
  readonly approve: (
    input: GoLiveDraftApproveInput
  ) => Promise<GoLiveDraftOutput>;
  /** The signal abandons the request when a newer load starts or the page is left. */
  readonly queue: (
    options: Readonly<{ signal: AbortSignal }>
  ) => Promise<GoLiveQueueOutput>;
  readonly reject: (
    input: GoLiveDraftRejectInput
  ) => Promise<GoLiveDraftOutput>;
}

// The one place that reads goLiveDrafts from the root API client.
const connectGoLiveDrafts = (): GoLiveDraftsGateway => {
  const api = createApiClient({ baseUrl: window.location.origin }).goLiveDrafts;
  return {
    approve: (input) => api.approve(input),
    queue: (options) => api.queue({}, options),
    reject: (input) => api.reject(input),
  };
};

/** Connects on the first call, so rendering on the server never touches `window`. */
export const createBrowserGoLiveDraftsGateway = (): GoLiveDraftsGateway => {
  let connected: GoLiveDraftsGateway | undefined;
  const current = (): GoLiveDraftsGateway => {
    connected ??= connectGoLiveDrafts();
    return connected;
  };
  return Object.freeze({
    approve: (input: GoLiveDraftApproveInput) => current().approve(input),
    queue: (options: Readonly<{ signal: AbortSignal }>) =>
      current().queue(options),
    reject: (input: GoLiveDraftRejectInput) => current().reject(input),
  });
};

type State =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "forbidden" }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{
      type: "ready";
      data: GoLiveQueueOutput;
      /** When the queue on screen was loaded. The page does not refresh on its own. */
      loadedAt: Date;
      /** A failed reload: the last loaded queue stays on screen. */
      reloadError?: string;
    }>;

// An approval always carries the exact order the dialog repeats.
type Decision =
  | Readonly<{
      draft: GoLiveDraftOutput;
      order: NonNullable<GoLiveDraftOutput["order"]>;
      type: "approve";
    }>
  | Readonly<{ draft: GoLiveDraftOutput; type: "reject" }>;

const SECTION = "space-y-3 rounded-lg border border-border bg-card p-4";
const FIELD_LABEL = "text-muted-foreground text-xs";

const Notice = () => (
  <p
    className="rounded-lg border border-warning-border bg-warning-subtle p-3 font-medium text-sm text-warning-foreground"
    data-golive-notice=""
    role="note"
  >
    {NO_ORDERS_NOTICE_PARTS.before}
    <Link
      className="underline underline-offset-2"
      href={PORTFOLIO_HREF}
      prefetch={false}
    >
      {NO_ORDERS_NOTICE_PARTS.link}
    </Link>
    {NO_ORDERS_NOTICE_PARTS.after}
  </p>
);

// Inert while the dialog is open: nothing behind it, the notice link included, can be clicked or
// focused. The dialog itself is rendered outside this element (a portal on the document body).
const Frame = ({
  children,
  inert = false,
  rootRef,
}: Readonly<{
  children: ReactNode;
  inert?: boolean;
  rootRef?: RefObject<HTMLDivElement | null>;
}>) => (
  <div
    className="space-y-4"
    data-golive-draft-queue=""
    inert={inert}
    ref={rootRef}
  >
    <Notice />
    {children}
  </div>
);

const LoadingMark = () => (
  <span
    className="text-muted-foreground text-sm"
    data-golive-loading=""
    role="status"
  >
    Loading…
  </span>
);

const Field = ({
  children,
  label,
}: Readonly<{ children: ReactNode; label: string }>) => (
  <div>
    <dt className={FIELD_LABEL}>{label}</dt>
    <dd className="break-words text-sm">{children}</dd>
  </div>
);

const ExternalLink = ({
  href,
  label,
}: Readonly<{ href: string; label: string }>) => (
  <li>
    <a
      className="underline underline-offset-2"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {label}
    </a>
  </li>
);

// Only an https link is rendered; the model drops anything else.
const PlanLinks = ({ plan }: Readonly<{ plan: GoLivePlanOutput }>) => {
  const ownerMessage = safeHttpsUrl(plan.ownerMessageUrl);
  const evidence = safeHttpsUrl(plan.evidenceUrl);
  return ownerMessage === null && evidence === null ? null : (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {ownerMessage === null ? null : (
        <ExternalLink href={ownerMessage} label="Owner message" />
      )}
      {evidence === null ? null : (
        <ExternalLink href={evidence} label="Evidence" />
      )}
    </ul>
  );
};

const PlanBlock = ({ plan }: Readonly<{ plan: GoLivePlanOutput | null }>) => (
  <section aria-labelledby="golive-plan-title" className={SECTION}>
    <h2 className="font-heading font-semibold text-lg" id="golive-plan-title">
      Plan
    </h2>
    {plan === null ? (
      <p className="text-muted-foreground text-sm" data-golive-plan="none">
        {NO_PLAN_TEXT}
      </p>
    ) : (
      <div className="space-y-3" data-golive-plan={plan.status}>
        <p className="font-medium">{planTitle(plan)}</p>
        <p className="text-sm" data-golive-plan-status="">
          {planStatusText(plan)}
        </p>
        <PlanLinks plan={plan} />
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {planLimitRows(plan.limits).map((row) => (
            <Field key={row.label} label={row.label}>
              {row.value}
            </Field>
          ))}
        </dl>
        <ul aria-label="Sleeves" className="space-y-2">
          {plan.sleeves.map(sleeveRow).map((sleeve) => (
            <li
              className="rounded-md border border-border p-3"
              data-golive-sleeve={sleeve.key}
              key={sleeve.key}
            >
              <p className="font-medium text-sm">{sleeve.name}</p>
              <dl className="mt-1 grid gap-2 sm:grid-cols-3">
                <Field label="Budget">{sleeve.budget}</Field>
                <Field label="Structure">{sleeve.structure}</Field>
                <Field label="Symbols">{sleeve.symbols}</Field>
              </dl>
              <p className="mt-1 text-muted-foreground text-xs">
                {sleeve.note}
              </p>
            </li>
          ))}
        </ul>
      </div>
    )}
  </section>
);

const StatusRow = ({ data }: Readonly<{ data: GoLiveQueueOutput }>) => (
  <section aria-labelledby="golive-status-title" className={SECTION}>
    <h2 className="font-heading font-semibold text-lg" id="golive-status-title">
      Status for {data.tradingDay}
    </h2>
    <ul className="grid gap-2 text-sm sm:grid-cols-2">
      <li data-golive-status="account">{accountText(data.account)}</li>
      <li data-golive-status="node">
        {nodeText(data.node)}
        <span
          className="block text-muted-foreground text-xs"
          data-golive-node-note=""
        >
          {NODE_DISARMED_NOTE}
        </span>
      </li>
      <li data-golive-status="generator">{generatorText(data)}</li>
      <li data-golive-status="market-notes">
        {marketNotesText(data.marketNotes)}
      </li>
    </ul>
  </section>
);

const TextList = ({
  empty,
  items,
}: Readonly<{ empty: string; items: readonly string[] }>) =>
  items.length === 0 ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <ul className="list-disc space-y-0.5 pl-4">
      {keyedLines(items).map((item) => (
        <li key={item.key}>{item.text}</li>
      ))}
    </ul>
  );

const draftName = (draft: GoLiveDraftOutput): string =>
  `${draft.symbol} ${expiryDate(draft.expiry)}`;

const DraftActions = ({
  busy,
  context,
  draft,
  onDecide,
}: Readonly<{
  busy: boolean;
  context: GoLiveDraftContext;
  draft: GoLiveDraftOutput;
  onDecide: (decision: Decision) => void;
}>) => {
  const reasonsId = useId();
  const blockers = approveBlockers(draft, context);
  const blocked = blockers.length > 0;
  const { order } = draft;
  return (
    <div className="space-y-2" data-golive-actions="">
      <div className="flex flex-wrap gap-2">
        <Button
          aria-describedby={blocked ? reasonsId : undefined}
          aria-label={`Approve ${draftName(draft)}`}
          data-golive-action="approve"
          disabled={blocked || busy}
          onClick={
            order === null || blocked
              ? undefined
              : () => onDecide({ draft, order, type: "approve" })
          }
        >
          Approve
        </Button>
        <Button
          aria-label={`Reject ${draftName(draft)}`}
          data-golive-action="reject"
          disabled={busy}
          onClick={() => onDecide({ draft, type: "reject" })}
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {blocked ? (
        <div
          className="text-sm text-warning-foreground"
          data-golive-blockers=""
          id={reasonsId}
        >
          <p className="font-medium">Cannot be approved:</p>
          <TextList empty="" items={blockers} />
        </div>
      ) : null}
    </div>
  );
};

const DraftRow = ({
  busy,
  canDecide,
  context,
  draft,
  onDecide,
}: Readonly<{
  busy: boolean;
  /** False for an operator who is not the owner: the row then has no Approve and no Reject. */
  canDecide: boolean;
  context: GoLiveDraftContext;
  draft: GoLiveDraftOutput;
  onDecide: (decision: Decision) => void;
}>) => {
  const titleId = useId();
  const preCheck = preCheckView(draft.preCheck);
  const decided = decisionText(draft);
  const approved = approvedOrderView(draft);
  return (
    <li>
      <article
        aria-labelledby={titleId}
        className="space-y-3 rounded-md border border-border p-3"
        data-golive-draft={draft.id}
        data-golive-draft-state={draft.state}
        // Focus lands here when a decision removed the button that opened the dialog.
        tabIndex={-1}
      >
        <h4 className="font-medium" id={titleId}>
          {draft.symbol}{" "}
          <span className="font-normal text-muted-foreground">
            {structureText(draft.structure)}
          </span>
        </h4>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="State">{draftStateText(draft.state)}</Field>
          <Field label="Expiry">{expiryDate(draft.expiry)}</Field>
          <Field label="Strikes">{strikesText(draft)}</Field>
          {/* On an approved row every live value is labelled as current, not as approved. */}
          <Field label={approved === null ? "Quote" : CURRENT_QUOTE_LABEL}>
            {quoteText(draft, context.readAt)}
          </Field>
          {approved === null ? (
            <>
              <Field label="Limit">{limitText(draft.sizing.limitPrice)}</Field>
              <Field label="Quantity">{quantityText(draft.sizing)}</Field>
              <Field label="Max loss">{maxLossText(draft.sizing)}</Field>
            </>
          ) : (
            <>
              <Field label={approved.label}>
                {approved.missing === null ? (
                  <div data-golive-approved-order="">
                    <TextList empty="" items={approved.legs} />
                    {approved.rows.map((row) => (
                      <div key={row.label}>
                        {row.label}: {row.value}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div data-golive-approved-order="missing">
                    {approved.missing}
                  </div>
                )}
                <div data-golive-node-at-approval="">{approved.nodeBadge}</div>
              </Field>
              <Field label={CURRENT_SIZING_LABEL}>
                <span data-golive-current-sizing="">
                  {currentSizingText(draft.sizing)}
                </span>
              </Field>
            </>
          )}
          <Field label="Exit rule">{exitRuleText(draft.exitRule)}</Field>
          {draft.exitReason === null ? null : (
            <Field label="Exit reason">
              {exitReasonText(draft.exitReason)}
            </Field>
          )}
          <Field
            label={approved === null ? "Pre-check" : CURRENT_PRECHECK_LABEL}
          >
            <span data-golive-precheck="">{preCheck.decision}</span>
            {preCheck.reasons.length === 0 ? null : (
              <TextList empty="" items={preCheck.reasons} />
            )}
            {preCheck.stance === null ? null : (
              <span className="block" data-golive-precheck-stance="">
                {preCheck.stance}
              </span>
            )}
            <span className="block text-muted-foreground text-xs">
              {preCheck.enginePolicy}
            </span>
          </Field>
          <Field label="Signal facts">
            <TextList empty="None reported" items={draft.signalFacts} />
          </Field>
          <Field label="Market notes">
            <TextList empty="None attached" items={draft.notes.map(noteText)} />
          </Field>
          {decided === null ? null : <Field label="Decision">{decided}</Field>}
          {draft.decisionNote === null ? null : (
            <Field label="Decision note">{draft.decisionNote}</Field>
          )}
        </dl>
        {draft.state === "proposed" && canDecide ? (
          <DraftActions
            busy={busy}
            context={context}
            draft={draft}
            onDecide={onDecide}
          />
        ) : null}
      </article>
    </li>
  );
};

const DraftGroup = ({
  busy,
  canDecide,
  context,
  drafts,
  empty,
  id,
  onDecide,
  title,
}: Readonly<{
  busy: boolean;
  canDecide: boolean;
  context: GoLiveDraftContext;
  drafts: readonly GoLiveDraftOutput[];
  empty: string;
  id: string;
  onDecide: (decision: Decision) => void;
  title: string;
}>) => (
  <section
    aria-labelledby={id}
    className="space-y-3 rounded-md border border-border p-3"
    data-golive-group={id}
  >
    <h3 className="font-heading font-semibold" id={id}>
      {title}
    </h3>
    {drafts.length === 0 ? (
      <p className="text-muted-foreground text-sm">{empty}</p>
    ) : (
      <ul className="space-y-3">
        {drafts.map((draft) => (
          <DraftRow
            busy={busy}
            canDecide={canDecide}
            context={context}
            draft={draft}
            key={draft.id}
            onDecide={onDecide}
          />
        ))}
      </ul>
    )}
  </section>
);

const DecisionDialog = ({
  busy,
  decision,
  error,
  onCancel,
  onClosed,
  onSubmit,
}: Readonly<{
  busy: boolean;
  decision: Decision;
  error: string | null;
  onCancel: () => void;
  /** After the dialog closed: decides where focus goes (prevent the default to take over). */
  onClosed: (event: Event) => void;
  onSubmit: (note: string) => void;
}>) => {
  const noteId = useId();
  const noteErrorId = useId();
  const errorId = useId();
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const { draft, type } = decision;
  const order = decision.type === "approve" ? decision.order : null;
  const submit = () => {
    if (type === "reject" && note.trim() === "") return setNoteMissing(true);
    return onSubmit(note.trim());
  };

  // The Radix dialog traps focus, hides the page from assistive technology, closes on Escape and
  // gives focus back when it closes. A close request is ignored while a decision is being recorded.
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || busy)) onCancel();
      }}
      open
    >
      <DialogContent
        aria-modal="true"
        className="max-w-md"
        closeLabel="Cancel and close"
        data-golive-dialog={type}
        description={
          <span data-golive-not-sent="">
            {type === "approve"
              ? APPROVAL_NOT_SENT_SENTENCE
              : REJECTION_RECORD_SENTENCE}
          </span>
        }
        onCloseAutoFocus={onClosed}
        onOpenAutoFocus={(event) => {
          // Approve opens on Cancel, so Enter does not record by accident; Reject opens on the note.
          event.preventDefault();
          (noteRef.current ?? cancelRef.current)?.focus();
        }}
        title={`${type === "approve" ? "Approve" : "Reject"} ${draftName(draft)} ${structureText(draft.structure)}`}
      >
        {order === null ? (
          <div className="space-y-1 text-sm">
            <label className="font-medium" htmlFor={noteId}>
              Note (required)
            </label>
            <Textarea
              // Both the missing-note error and a server error describe the note.
              aria-describedby={
                [
                  noteMissing ? noteErrorId : null,
                  error === null ? null : errorId,
                ]
                  .filter((id) => id !== null)
                  .join(" ") || undefined
              }
              aria-invalid={noteMissing}
              id={noteId}
              maxLength={1000}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteMissing(false);
              }}
              ref={noteRef}
              required
              rows={3}
              value={note}
            />
            {noteMissing ? (
              <p className="text-destructive" id={noteErrorId} role="alert">
                {REJECT_NOTE_REQUIRED}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 text-sm" data-golive-order="">
            <ul aria-label="Order legs" className="space-y-0.5 tabular-nums">
              {keyedLines(orderLegLines(order)).map((line) => (
                <li key={line.key}>{line.text}</li>
              ))}
            </ul>
            <dl className="grid grid-cols-3 gap-3">
              {orderSummaryRows(order, draft.sizing).map((row) => (
                <Field key={row.label} label={row.label}>
                  {row.value}
                </Field>
              ))}
            </dl>
          </div>
        )}
        {error === null ? null : (
          <p
            className="text-destructive text-sm"
            data-golive-dialog-error=""
            id={errorId}
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            aria-describedby={error === null ? undefined : errorId}
            data-golive-dialog-submit=""
            disabled={busy}
            onClick={submit}
            variant={type === "approve" ? "default" : "destructive"}
          >
            {type === "approve" ? "Record approval" : "Record rejection"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const GoLiveDraftQueue = ({
  clock: suppliedClock,
  gateway: supplied,
}: Readonly<{
  /** The page clock, for the "Loaded <time>" line. Tests supply a fixed one. */
  clock?: () => Date;
  gateway?: GoLiveDraftsGateway;
}>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserGoLiveDraftsGateway()
  );
  const [clock] = useState(() => suppliedClock ?? (() => new Date()));
  const [state, setState] = useState<State>({ type: "loading" });
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What a decision attempt came to when it closed the dialog: said once, above the queue. */
  const [notice, setNotice] = useState<string | null>(null);
  // A second click on Record arrives before `busy` has rendered; the ref refuses it at once.
  const submitting = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const opener = useRef<{ draftId: string; element: Element | null } | null>(
    null
  );
  // Loads are numbered. Only the answer of the newest load is used, so an older answer never
  // overwrites a newer queue or a draft that a decision returned.
  const loadNumber = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  /** The queue that was loaded, or null when the load failed or a newer load replaced it. */
  const load = useCallback(
    async (manual = false): Promise<GoLiveQueueOutput | null> => {
      loadNumber.current += 1;
      const mine = loadNumber.current;
      const current = (): boolean =>
        mounted.current && mine === loadNumber.current;
      loadAbort.current?.abort();
      const abort = new AbortController();
      loadAbort.current = abort;
      setLoading(true);
      try {
        const data = await gateway.queue({ signal: abort.signal });
        if (!current()) return null;
        setState({ data, loadedAt: clock(), type: "ready" });
        // A decision notice describes an earlier read. A Reload that succeeds replaces that read,
        // so the notice goes with it and never sits above a row that contradicts it.
        if (manual) setNotice(null);
        return data;
      } catch (error) {
        if (!current()) return null;
        setState((previous) => {
          if (isOperatorAccessDenied(error)) return { type: "forbidden" };
          const message = loadErrorText(error);
          // A failed reload keeps the last loaded queue and reports the failure inline.
          return previous.type === "ready"
            ? { ...previous, reloadError: message }
            : { message, type: "error" };
        });
        return null;
      } finally {
        if (current()) setLoading(false);
      }
    },
    [clock, gateway]
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      // Leaving the page abandons the load; no state is set after this.
      mounted.current = false;
      loadAbort.current?.abort();
    };
  }, [load]);

  // A queue answer can arrive behind an open dialog. The dialog must then not stay usable when
  // the queue is gone (operator access lost), this caller cannot decide, or the fresh row no
  // longer allows the decision the dialog shows: not proposed, blocked, or another order.
  useEffect(() => {
    if (decision === null || busy) return;
    if (state.type !== "ready") {
      setDecision(null);
      return;
    }
    const { data } = state;
    const reason = staleDialogReason(
      decision,
      data.drafts.find((entry) => entry.id === decision.draft.id),
      { plan: data.plan, readAt: data.node.checkedAt }
    );
    if (data.canDecide && reason === null) return;
    setDecision(null);
    setNotice(
      data.canDecide && reason !== null
        ? staleDialogNotice(reason)
        : `${OWNER_ONLY_DECISION_TEXT} The open dialog was closed and nothing was recorded.`
    );
  }, [busy, decision, state]);

  const open = (next: Decision) => {
    opener.current = {
      draftId: next.draft.id,
      element: document.activeElement,
    };
    setDecisionError(null);
    setNotice(null);
    setDecision(next);
  };

  // The dialog has no Radix trigger, so the page says where focus goes when it closes: back to
  // the button that opened it, or, when a decision removed or disabled that button, to the
  // draft's row, so focus is not lost to the top of the page.
  const restoreFocus = (event: Event) => {
    const from = opener.current;
    opener.current = null;
    if (from === null) return;
    event.preventDefault();
    const { element } = from;
    const target =
      element instanceof HTMLButtonElement &&
      element.isConnected &&
      !element.disabled
        ? element
        : rootRef.current?.querySelector<HTMLElement>(
            `[data-golive-draft="${CSS.escape(from.draftId)}"]`
          );
    target?.focus();
  };

  /**
   * The draft the server returned replaces the listed one, so a failed reload still shows it.
   * Loads that started before the decision are dropped: their answer is older than this draft.
   */
  const keep = (decided: GoLiveDraftOutput) => {
    loadNumber.current += 1;
    setState((previous) =>
      previous.type === "ready"
        ? {
            ...previous,
            data: {
              ...previous.data,
              drafts: previous.data.drafts.map((entry) =>
                entry.id === decided.id ? decided : entry
              ),
            },
          }
        : previous
    );
  };

  const send = (current: Decision, note: string): Promise<GoLiveDraftOutput> =>
    current.type === "approve"
      ? // The dialog repeated exactly this order; the server refuses when its own order differs.
        gateway.approve({
          confirm: true,
          id: current.draft.id,
          order: current.order,
        })
      : gateway.reject({ id: current.draft.id, note });

  // The dialog may show a stale order, or the decision may already be recorded: the dialog
  // closes, the queue is read again and the notice says what the reloaded row shows.
  const closeAndReload = async (
    failure: GoLiveDecisionFailure,
    draft: GoLiveDraftOutput
  ) => {
    setDecision(null);
    setNotice(failure.text);
    const reloaded = await load();
    if (!mounted.current || failure.aftermath === "none") return;
    const found =
      reloaded === null
        ? null
        : reloaded.drafts.find((entry) => entry.id === draft.id);
    setNotice(
      `${failure.text} ${decisionAftermathText(
        found,
        reloaded?.tradingDay ?? draft.tradingDay,
        failure.aftermath === "refused"
      )}`
    );
  };

  const submit = async (
    current: Decision,
    note: string,
    facts: GoLiveDraftContext
  ) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setDecisionError(null);
    try {
      const decided = await send(current, note);
      if (!mounted.current) return;
      keep(decided);
      setDecision(null);
      await load();
    } catch (error) {
      if (!mounted.current) return;
      const failure = decisionFailure(
        error,
        current.type,
        current.draft,
        facts
      );
      if (failure.action === "stay") setDecisionError(failure.text);
      else await closeAndReload(failure, current.draft);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (state.type === "loading")
    return (
      <Frame>
        <p
          aria-busy="true"
          className="text-muted-foreground text-sm"
          role="status"
        >
          Loading order drafts…
        </p>
      </Frame>
    );
  if (state.type === "forbidden")
    return (
      <Frame>
        <OperatorAccessRequired feature="drafts" />
      </Frame>
    );
  if (state.type === "error")
    return (
      <Frame>
        <p className="text-sm" role="alert">
          Order drafts unavailable. {state.message}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={loading}
            onClick={() => void load(true)}
            variant="outline"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            Retry now
          </Button>
          {loading ? <LoadingMark /> : null}
        </div>
      </Frame>
    );

  const { data, loadedAt, reloadError } = state;
  const groups = groupDrafts(data.drafts);
  const dialogOpen = decision !== null;
  // The plan in force and the server's clock at this read: what every draft is judged against.
  const context: GoLiveDraftContext = {
    plan: data.plan,
    readAt: data.node.checkedAt,
  };
  // No decision is started while a load runs: its answer may change what the row allows.
  const group = {
    busy: busy || loading,
    canDecide: data.canDecide,
    context,
    onDecide: open,
  };
  return (
    <Frame inert={dialogOpen} rootRef={rootRef}>
      {notice === null ? null : (
        <p
          className="text-destructive text-sm"
          data-golive-decision-notice=""
          role="alert"
        >
          {notice}
        </p>
      )}
      {reloadError === undefined ? null : (
        <p
          className="text-destructive text-sm"
          data-golive-reload-error=""
          role="alert"
        >
          Reload failed; showing the queue loaded {etDayClock(loadedAt)}.{" "}
          {reloadError}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p
          className="mr-auto text-muted-foreground text-sm"
          data-golive-loaded=""
        >
          {loadedText(loadedAt)}
        </p>
        {loading ? <LoadingMark /> : null}
        <Button
          disabled={busy || dialogOpen || loading}
          onClick={() => void load(true)}
          variant="outline"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          Reload queue
        </Button>
      </div>
      <PlanBlock plan={data.plan} />
      <StatusRow data={data} />
      <section aria-labelledby="golive-drafts-title" className={SECTION}>
        <h2
          className="font-heading font-semibold text-lg"
          id="golive-drafts-title"
        >
          {draftsTitle(data.tradingDay)}
        </h2>
        {data.canDecide ? null : (
          <p className="text-sm" data-golive-cannot-decide="">
            {OWNER_ONLY_DECISION_TEXT}
          </p>
        )}
        <DraftGroup
          {...group}
          drafts={groups.entrySignal}
          empty={emptyGroupText("entrySignal", data)}
          id="golive-group-entry-signal"
          title={entrySignalGroupTitle(data.tradingDay)}
        />
        <DraftGroup
          {...group}
          drafts={groups.modelHolds}
          empty={emptyGroupText("modelHolds", data)}
          id="golive-group-model-holds"
          title={MODEL_HOLDS_GROUP_TITLE}
        />
        {groups.exits.length === 0 ? null : (
          <DraftGroup
            {...group}
            drafts={groups.exits}
            empty=""
            id="golive-group-exit"
            title={EXIT_GROUP_TITLE}
          />
        )}
        {groups.other.length === 0 ? null : (
          <DraftGroup
            {...group}
            drafts={groups.other}
            empty=""
            id="golive-group-other"
            title={OTHER_GROUP_TITLE}
          />
        )}
      </section>
      {decision === null ? null : (
        <DecisionDialog
          busy={busy}
          decision={decision}
          error={decisionError}
          key={`${decision.type}:${decision.draft.id}`}
          onCancel={() => setDecision(null)}
          onClosed={restoreFocus}
          onSubmit={(note) => void submit(decision, note, context)}
        />
      )}
    </Frame>
  );
};
