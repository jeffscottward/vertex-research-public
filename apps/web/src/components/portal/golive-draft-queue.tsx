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
import { RotateCcw } from "lucide-react";
import {
  type ReactNode,
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
  apiErrorText,
  approveBlockers,
  DRAFT_STATE_WORDS,
  decisionText,
  ENTRY_SIGNAL_GROUP_TITLE,
  EXIT_GROUP_TITLE,
  EXIT_REASON_WORDS,
  EXIT_RULE_WORDS,
  expiryDate,
  generatorText,
  groupDrafts,
  limitText,
  MARKET_NOTES_WORDS,
  MODEL_HOLDS_GROUP_TITLE,
  maxLossText,
  NO_ENTRY_SIGNAL_TEXT,
  NO_ORDERS_NOTICE,
  NO_PLAN_TEXT,
  nodeText,
  noteText,
  OWNER_ONLY_DECISION_TEXT,
  orderLegLines,
  orderSummaryRows,
  planLimitRows,
  planStatusText,
  planTitle,
  preCheckView,
  quantityText,
  quoteText,
  REJECT_NOTE_REQUIRED,
  STRUCTURE_WORDS,
  sleeveRow,
  strikesText,
} from "./golive-draft-queue-model.ts";

// Go-live order draft queue (/drafts): the allocation plan in force, the state of the account,
// node and generator, and today's order drafts. The owner approves or rejects each draft.
// RECORDS ONLY: goLiveDrafts has no send route. An approval is a stored decision; the owner
// places an approved draft through Portfolio > Orders.

export interface GoLiveDraftsGateway {
  readonly approve: (
    input: GoLiveDraftApproveInput
  ) => Promise<GoLiveDraftOutput>;
  readonly queue: () => Promise<GoLiveQueueOutput>;
  readonly reject: (
    input: GoLiveDraftRejectInput
  ) => Promise<GoLiveDraftOutput>;
}

// The one place that reads goLiveDrafts from the root API client.
const connectGoLiveDrafts = (): GoLiveDraftsGateway => {
  const api = createApiClient({ baseUrl: window.location.origin }).goLiveDrafts;
  return {
    approve: (input) => api.approve(input),
    queue: () => api.queue({}),
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
    queue: () => current().queue(),
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
    {NO_ORDERS_NOTICE}
  </p>
);

const Frame = ({ children }: Readonly<{ children: ReactNode }>) => (
  <div className="space-y-4" data-golive-draft-queue="">
    <Notice />
    {children}
  </div>
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
}: Readonly<{ href: string | null; label: string }>) =>
  href === null ? null : (
    <li>
      <a
        className="underline underline-offset-2"
        href={href}
        rel="noreferrer"
        target="_blank"
      >
        {label}
      </a>
    </li>
  );

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
        {plan.ownerMessageUrl === null && plan.evidenceUrl === null ? null : (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <ExternalLink href={plan.ownerMessageUrl} label="Owner message" />
            <ExternalLink href={plan.evidenceUrl} label="Evidence" />
          </ul>
        )}
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
      <li data-golive-status="node">{nodeText(data.node)}</li>
      <li data-golive-status="generator">{generatorText(data)}</li>
      <li data-golive-status="market-notes">
        {MARKET_NOTES_WORDS[data.marketNotes]}
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
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );

const draftName = (draft: GoLiveDraftOutput): string =>
  `${draft.symbol} ${expiryDate(draft.expiry)}`;

const DraftActions = ({
  busy,
  draft,
  onDecide,
}: Readonly<{
  busy: boolean;
  draft: GoLiveDraftOutput;
  onDecide: (decision: Decision) => void;
}>) => {
  const reasonsId = useId();
  const blockers = approveBlockers(draft);
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
            order === null
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
  draft,
  onDecide,
  ownerOnly,
}: Readonly<{
  busy: boolean;
  draft: GoLiveDraftOutput;
  onDecide: (decision: Decision) => void;
  /** The API refused this draft's decision: the session is an operator, not the owner. */
  ownerOnly: boolean;
}>) => {
  const titleId = useId();
  const preCheck = preCheckView(draft.preCheck);
  const decided = decisionText(draft);
  return (
    <li>
      <article
        aria-labelledby={titleId}
        className="space-y-3 rounded-md border border-border p-3"
        data-golive-draft={draft.id}
        data-golive-draft-state={draft.state}
      >
        <h4 className="font-medium" id={titleId}>
          {draft.symbol}{" "}
          <span className="font-normal text-muted-foreground">
            {STRUCTURE_WORDS[draft.structure]}
          </span>
        </h4>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="State">{DRAFT_STATE_WORDS[draft.state]}</Field>
          <Field label="Expiry">{expiryDate(draft.expiry)}</Field>
          <Field label="Strikes">{strikesText(draft)}</Field>
          <Field label="Quote">{quoteText(draft.quote)}</Field>
          <Field label="Limit">{limitText(draft.sizing.limitPrice)}</Field>
          <Field label="Quantity">{quantityText(draft.sizing)}</Field>
          <Field label="Max loss">{maxLossText(draft.sizing)}</Field>
          <Field label="Exit rule">{EXIT_RULE_WORDS}</Field>
          {draft.exitReason === null ? null : (
            <Field label="Exit reason">
              {EXIT_REASON_WORDS[draft.exitReason]}
            </Field>
          )}
          <Field label="Pre-check">
            <span data-golive-precheck="">{preCheck.decision}</span>
            {preCheck.reasons.length === 0 ? null : (
              <TextList empty="" items={preCheck.reasons} />
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
        {draft.state === "proposed" ? (
          <DraftActions busy={busy} draft={draft} onDecide={onDecide} />
        ) : null}
        {ownerOnly ? (
          <p
            className="text-destructive text-sm"
            data-golive-owner-only=""
            role="alert"
          >
            {OWNER_ONLY_DECISION_TEXT}
          </p>
        ) : null}
      </article>
    </li>
  );
};

const DraftGroup = ({
  busy,
  drafts,
  empty,
  id,
  onDecide,
  ownerOnlyId,
  title,
}: Readonly<{
  busy: boolean;
  drafts: readonly GoLiveDraftOutput[];
  empty: string;
  id: string;
  onDecide: (decision: Decision) => void;
  ownerOnlyId: string | null;
  title: string;
}>) => (
  <section aria-labelledby={id} className={SECTION} data-golive-group={id}>
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
            draft={draft}
            key={draft.id}
            onDecide={onDecide}
            ownerOnly={draft.id === ownerOnlyId}
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
  onSubmit,
}: Readonly<{
  busy: boolean;
  decision: Decision;
  error: string | null;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}>) => {
  const titleId = useId();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) cancel.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { draft, type } = decision;
  const order = decision.type === "approve" ? decision.order : null;
  const submit = () => {
    if (type === "reject" && note.trim() === "") return setNoteMissing(true);
    return onSubmit(note.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg"
        data-golive-dialog={type}
        role="dialog"
      >
        <h2 className="font-semibold text-lg" id={titleId}>
          {`${type === "approve" ? "Approve" : "Reject"} ${draftName(draft)} ${STRUCTURE_WORDS[draft.structure]}`}
        </h2>
        {order === null ? (
          <div className="space-y-1 text-sm">
            <label className="font-medium" htmlFor={noteId}>
              Note (required)
            </label>
            <Textarea
              aria-invalid={noteMissing}
              id={noteId}
              maxLength={1000}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteMissing(false);
              }}
              required
              rows={3}
              value={note}
            />
            {noteMissing ? (
              <p className="text-destructive" role="alert">
                {REJECT_NOTE_REQUIRED}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 text-sm" data-golive-order="">
            <ul aria-label="Order legs" className="space-y-0.5 tabular-nums">
              {orderLegLines(order).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <dl className="grid grid-cols-3 gap-3">
              {orderSummaryRows(order, draft.sizing).map((row) => (
                <Field key={row.label} label={row.label}>
                  {row.value}
                </Field>
              ))}
            </dl>
            <p className="font-medium" data-golive-not-sent="">
              {APPROVAL_NOT_SENT_SENTENCE}
            </p>
          </div>
        )}
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
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
            data-golive-dialog-submit=""
            disabled={busy}
            onClick={submit}
            variant={type === "approve" ? "default" : "destructive"}
          >
            {type === "approve" ? "Record approval" : "Record rejection"}
          </Button>
        </div>
      </div>
    </div>
  );
};

export const GoLiveDraftQueue = ({
  gateway: supplied,
}: Readonly<{ gateway?: GoLiveDraftsGateway }>) => {
  const [gateway] = useState(
    () => supplied ?? createBrowserGoLiveDraftsGateway()
  );
  const [state, setState] = useState<State>({ type: "loading" });
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownerOnlyId, setOwnerOnlyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await gateway.queue();
      return setState({ data, type: "ready" });
    } catch (error) {
      return setState((previous) => {
        if (isOperatorAccessDenied(error)) return { type: "forbidden" };
        const message = apiErrorText(error);
        // A failed reload keeps the last loaded queue and reports the failure inline.
        return previous.type === "ready"
          ? { data: previous.data, reloadError: message, type: "ready" }
          : { message, type: "error" };
      });
    }
  }, [gateway]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (next: Decision) => {
    setDecisionError(null);
    setOwnerOnlyId(null);
    setDecision(next);
  };

  const submit = async (current: Decision, note: string) => {
    const { draft } = current;
    setBusy(true);
    setDecisionError(null);
    try {
      // The dialog repeated exactly this order; the server refuses when its own order differs.
      if (current.type === "approve")
        await gateway.approve({
          confirm: true,
          id: draft.id,
          order: current.order,
        });
      else await gateway.reject({ id: draft.id, note });
      setDecision(null);
      await load();
    } catch (error) {
      // The queue loaded, so this session is an operator: FORBIDDEN here means "not the owner".
      if (isOperatorAccessDenied(error)) {
        setDecision(null);
        setOwnerOnlyId(draft.id);
      } else setDecisionError(apiErrorText(error));
    } finally {
      setBusy(false);
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
        <Button onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Retry now
        </Button>
      </Frame>
    );

  const { data, reloadError } = state;
  const groups = groupDrafts(data.drafts);
  return (
    <Frame>
      {reloadError === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          Reload failed; showing the last loaded queue. {reloadError}
        </p>
      )}
      <PlanBlock plan={data.plan} />
      <StatusRow data={data} />
      <div className="flex justify-end">
        <Button disabled={busy} onClick={() => void load()} variant="outline">
          <RotateCcw aria-hidden="true" className="size-4" />
          Reload queue
        </Button>
      </div>
      <DraftGroup
        busy={busy}
        drafts={groups.entrySignal}
        empty={NO_ENTRY_SIGNAL_TEXT}
        id="golive-group-entry-signal"
        onDecide={open}
        ownerOnlyId={ownerOnlyId}
        title={ENTRY_SIGNAL_GROUP_TITLE}
      />
      <DraftGroup
        busy={busy}
        drafts={groups.modelHolds}
        empty="No draft in this group."
        id="golive-group-model-holds"
        onDecide={open}
        ownerOnlyId={ownerOnlyId}
        title={MODEL_HOLDS_GROUP_TITLE}
      />
      {groups.exits.length === 0 ? null : (
        <DraftGroup
          busy={busy}
          drafts={groups.exits}
          empty=""
          id="golive-group-exit"
          onDecide={open}
          ownerOnlyId={ownerOnlyId}
          title={EXIT_GROUP_TITLE}
        />
      )}
      {decision === null ? null : (
        <DecisionDialog
          busy={busy}
          decision={decision}
          error={decisionError}
          key={`${decision.type}:${decision.draft.id}`}
          onCancel={() => setDecision(null)}
          onSubmit={(note) => void submit(decision, note)}
        />
      )}
    </Frame>
  );
};
