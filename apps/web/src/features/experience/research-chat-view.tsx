"use client";

import {
  createContext,
  useContext,
  type ButtonHTMLAttributes,
  type FormEvent,
} from "react";
import {
  CopilotChatView,
  type CopilotChatInputProps,
} from "@copilotkit/react-core/v2";
import { Button, Input } from "@darkfactory/ui";
import type {
  VertexResearchChatTranscriptMessage,
  VertexResearchChatAgentReferenceMessage,
  VertexResearchChatRosterEntry,
  VertexResearchChatThread,
  VertexResearchChatSendMessageInput,
} from "@darkfactory/api/vertex";
import type {
  ResearchConversationControls,
  ResearchPreparedCandidate,
  ResearchPrivateView,
  ResearchPrivateBody,
} from "./research-chat-conversation.ts";
import "@copilotkit/react-core/v2/styles.css";
import "./research-chat-view.css";

export interface ResearchChatViewProps {
  readonly selectedThread: VertexResearchChatThread | null;
  readonly threads: readonly VertexResearchChatThread[];
  readonly messages: readonly VertexResearchChatTranscriptMessage[];
  readonly participants: readonly VertexResearchChatRosterEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly sending: boolean;
  // Unknown mutation outcome: freeze edits without pretending a request is active.
  readonly mutationLocked?: boolean;
  // Stale/incomplete transcript: block only a new send, not editing or reading.
  readonly sendDisabled?: boolean;
  readonly responseStatus: "not-requested" | "unavailable" | "queued" | null;
  readonly responseReasonCodes: readonly string[];
  readonly requestedParticipantIds: readonly string[];
  readonly onRequestedParticipantsChange: (
    participantIds: readonly string[]
  ) => void;
  readonly mode: VertexResearchChatSendMessageInput["mode"];
  readonly onModeChange: (
    mode: VertexResearchChatSendMessageInput["mode"]
  ) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onCreateThread: (
    title: string,
    participantIds: readonly string[]
  ) => void;
  readonly onSendMessage: () => void;
  // Refresh/reconcile reads only. Never automatically resend an uncertain write.
  readonly onRetry: () => void;
  readonly conversation?: ResearchConversationControls;
  readonly privateContent?: ResearchPrivateView;
  readonly onViewResponse?:
    | ((reference: VertexResearchChatAgentReferenceMessage) => void)
    | undefined;
  readonly onHideResponse?: (() => void) | undefined;
}

type TranscriptProps = Pick<
  ResearchChatViewProps,
  | "selectedThread"
  | "messages"
  | "participants"
  | "loading"
  | "error"
  | "onViewResponse"
>;
// Display-only slot data, not a Copilot runtime/provider or a second thread store.
// A stable whole-messageView replacement must never mount the default renderer.
const TranscriptContext = createContext<TranscriptProps | null>(null);
const TranscriptProvider = TranscriptContext.Provider;
const EmptySlot = () => null;
const SendButton = ({
  children: _children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <Button {...props} type="button">
    Send message
  </Button>
);
const isResearchThread = (thread: VertexResearchChatThread): boolean =>
  thread.environment === "research" && thread.executionAuthorized === false;
const isAvailable = (participant: VertexResearchChatRosterEntry): boolean =>
  participant.availability === "ready" &&
  (participant.kind !== "expert" || participant.corpus.status === "reviewed");
// Preview eligibility is not availability, corpus qualification or execution permission.
export const canRequestExpertPreview = (
  participant: VertexResearchChatRosterEntry
): boolean =>
  participant.kind === "expert" && participant.availability !== "blocked";
export const canRequestDebatePreview = (
  participant: VertexResearchChatRosterEntry
): boolean =>
  participant.kind === "expert" && participant.availability !== "blocked";
const isConfiguredAdvisory = (
  participant: VertexResearchChatRosterEntry
): boolean =>
  participant.participantId === "first-mate" &&
  participant.kind === "first-mate" &&
  participant.advisory?.status === "configured" &&
  participant.advisory.authorization === "requires-governed-prepare";
const availabilityLabel = (
  participant: VertexResearchChatRosterEntry
): string =>
  isConfiguredAdvisory(participant)
    ? "Configured for governed advisory requests; provider/context authorization still required"
    : isAvailable(participant)
      ? "Ready for a request; admission still required"
      : participant.availability === "blocked"
        ? "Blocked"
        : "Unavailable";

const LiteralMetadata = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: unknown;
}) => (
  <section className="vx-chat-metadata" aria-label={label}>
    <h4>{label}</h4>
    <pre>{JSON.stringify(value, null, 2)}</pre>
  </section>
);

const PreparedContext = ({
  candidate,
}: {
  readonly candidate: ResearchPreparedCandidate;
}) => {
  const { preview, messages, recordDigests } = candidate;
  return (
    <section
      className="vx-chat-preview"
      aria-label="Displayed context approval preview"
    >
      <h4>Exact context for this request</h4>
      <p>
        Only the human records below are selected, not the whole conversation.
        Their original sequence numbers are not renumbered or filtered across
        agent references.
      </p>
      <dl className="vx-chat-pins">
        <div>
          <dt>Response request</dt>
          <dd>{preview.responseRequestId}</dd>
        </div>
        <div>
          <dt>Plan / SHA-256</dt>
          <dd>
            {preview.planId}
            {" / "}
            {preview.planSha256}
          </dd>
        </div>
        <div>
          <dt>Human message count</dt>
          <dd>{preview.context.messageCount}</dd>
        </div>
        <div>
          <dt>Canonical whole-context UTF-8 bytes</dt>
          <dd>{preview.context.byteLength}</dd>
        </div>
        <div>
          <dt>Server whole-context SHA-256</dt>
          <dd>{preview.context.sha256}</dd>
        </div>
        <div>
          <dt>Preview checked at / not after</dt>
          <dd>
            {preview.checkedAt}
            {" / "}
            {preview.notAfter}
          </dd>
        </div>
      </dl>
      <p>
        The server whole-context digest includes server-owned context; it is not
        a digest of only the displayed human records.
      </p>
      {"debate" in preview ? (
        <section aria-label="Exact stepwise debate consent">
          <h4>
            Step {preview.debate.ordinal} of 5 ·{" "}
            {preview.debate.kind === "synthesis"
              ? "Final synthesis"
              : `Round ${Math.ceil(preview.debate.ordinal / 2)} statement`}
          </h4>
          <p>
            Two configured experts, two ordered rounds, then explicit synthesis
            by the selected member {preview.debate.synthesizerId}. This approval
            covers only {preview.expert.participantId}'s displayed turn, not the
            other turns.
          </p>
          <p>
            Each admitted turn charges the full ceiling:{" "}
            {preview.debate.turnTokens} tokens and USD{" "}
            {preview.debate.turnCostUsd}, including uncertain outcomes. Run
            ceilings: {preview.debate.aggregateTokens} tokens and USD{" "}
            {preview.debate.aggregateCostUsd}. No automatic refund or next-step
            dispatch is assumed.
          </p>
          <LiteralMetadata
            label="Exact five-turn schedule, configuration, frozen human-window pin, predecessor hashes and derived envelope"
            value={preview.debate}
          />
          <p>
            Prior published answers are untrusted derived input, not human
            messages or source evidence. A separate authorized reviewer must
            accept their exact use before admission. This UI cannot issue that
            review.
          </p>
        </section>
      ) : null}
      {"nativeEvidence" in preview ? (
        <section aria-label="Exact bounded native evidence protocol consent">
          <h4>Bounded protocol · first-mate-read-reviewed-evidence-v1</h4>
          <p>
            Approve exactly one read_reviewed_evidence(evidence_id) call from
            the pinned reviewed bundle, with two completion phases and at most
            two tokenizer operations. No arbitrary path, URL, query, additional
            tool call or automatic loop is authorized. Phase two has tools
            disabled.
          </p>
          <LiteralMetadata
            label="Exact native protocol, derivation rule, serializer and capability pins, bundle digest, per-operation and aggregate ceilings"
            value={preview.nativeEvidence}
          />
          <p>
            The phase-two bytes do not exist yet. This consent covers only their
            deterministic derivation under the displayed
            reviewed-evidence-single-projection-v1 rule from the bound phase-one
            response and selected governed evidence result. It does not approve
            arbitrary future input bytes.
          </p>
          <p>
            Every tokenizer and completion operation still needs its own exact
            privacy decision and real model-use grant. Missing phase-two
            authority stops the protocol at the bound inputs. Preparation,
            metadata and this human consent do not issue those decisions or
            grants. Only evidence actually delivered in phase two may be cited
            in the final advisory.
          </p>
          <p>
            Consent value: approve-bounded-native-evidence-protocol-v1. This
            applies only to the original request, plan ID and plan SHA-256
            displayed above. Preparation creates no governed copies and
            dispatches no model work.
          </p>
        </section>
      ) : null}
      <LiteralMetadata
        label="Exact request fields (query, parent, snapshot, start, key and scope)"
        value={preview.request}
      />
      <LiteralMetadata
        label="Exact context message IDs and original bounds"
        value={preview.context}
      />
      <ol className="vx-chat-bound-messages">
        {messages.map((message, index) => (
          <li key={message.messageId}>
            <h4>
              Human message {message.messageId}
              {" · Original sequence "}
              {message.sequence}
            </h4>
            <p className="vx-chat-body">{message.body}</p>
            <p className="vx-chat-meta">
              Local exact-record SHA-256:{" "}
              {recordDigests[index] ?? "Unavailable — do not approve"}
            </p>
            <LiteralMetadata
              label={`Exact bound human record ${message.messageId}`}
              value={message}
            />
          </li>
        ))}
      </ol>
      <LiteralMetadata
        label="Exact expert configuration and model version"
        value={preview.expert}
      />
      <LiteralMetadata
        label="Corpus, snapshot and exact review pins"
        value={preview.corpus}
      />
      <LiteralMetadata
        label="Provider, HTTPS destination, served model, policy and endpoint pins"
        value={preview.model}
      />
      <LiteralMetadata
        label="Tokenize and completion input byte counts and SHA-256"
        value={preview.inputs}
      />
      <p>
        Corpus reviews are not model privacy approvals. Stage-specific tokenize
        and completion privacy reviews are not yet issued by this preview. Owner
        approval cannot issue those independent reviews.
      </p>
      <LiteralMetadata
        label="Original retention policy, rules and artifact pins"
        value={preview.retention}
      />
      <p>
        Context and model-input cleanup is triggered when the response attempt
        becomes terminal. Derived-output cleanup requires explicit user cleanup.
        Revocation or rights expiry can trigger earlier cleanup.
      </p>
      <p>
        READ ACCESS not after: {preview.retention.readNotAfter}. This is a
        read-access bound, not a deletion deadline. Guaranteed deletion
        deadline:{" "}
        {preview.retention.guaranteedDeletionDeadline === null
          ? "none (null)"
          : preview.retention.guaranteedDeletionDeadline}
        . No physical-deletion SLA is promised.
      </p>
      <LiteralMetadata
        label="Storage profile, evidence, logical namespace and fence semantics"
        value={preview.storage}
      />
      <p>
        Storage claims cover only the application-managed copy namespace.
        Conditional permanent tombstones prevent application copy resurrection;
        they do not promise erasure from the provider, backups, physical media,
        RAM or exports.
      </p>
      <p>
        {"nativeEvidence" in preview
          ? "Approval covers only this displayed bounded evidence-read protocol and plan. It does not authorize unrelated tools, acquisition, backtests, trades, publication or arbitrary model disclosures."
          : "Approval applies only to this displayed request and plan. It is not an answer, publication, trade, tool or backtest authorization."}
      </p>
    </section>
  );
};

export const ResearchConversationPanel = ({
  controls,
  participants,
  disabled,
}: {
  readonly controls: ResearchConversationControls;
  readonly participants: readonly VertexResearchChatRosterEntry[];
  readonly disabled: boolean;
}) => {
  const locked = disabled || controls.busy || controls.locked;
  const debate = controls.debate;
  const debating = debate?.mode === "stepwise-debate";
  const nativeEvidence =
    debate?.mode === "first-mate-read-reviewed-evidence-v1";
  const selectionLocked = locked || (debating && debate?.frozen === true);
  const hasMate = !debating && participants.some(isConfiguredAdvisory);
  const experts = participants.filter((participant) =>
    nativeEvidence
      ? participant.participantId === "first-mate" &&
        participant.kind === "first-mate"
      : debating
        ? canRequestDebatePreview(participant)
        : canRequestExpertPreview(participant) ||
          isConfiguredAdvisory(participant)
  );
  const hasPreviewOnlyExpert =
    !nativeEvidence &&
    experts.some(
      (participant) =>
        (debating
          ? canRequestDebatePreview(participant)
          : canRequestExpertPreview(participant)) && !isAvailable(participant)
    );
  const responderLabel = nativeEvidence
    ? "First Mate · native evidence protocol only"
    : hasMate
      ? "Exactly one advisory responder"
      : hasPreviewOnlyExpert
        ? debating
          ? "Exactly one first speaker for governed debate preview"
          : "Exactly one expert for governed preview"
        : "Exactly one ready expert";
  const selectedExpert = experts.some(
    (participant) => participant.participantId === controls.expertId
  );
  const canPrepare =
    !locked &&
    (debating
      ? debate?.canPrepare === true &&
        (debate.frozen ||
          (selectedExpert &&
            controls.start.length > 0 &&
            controls.end.length > 0 &&
            controls.query.length >= 10 &&
            controls.query.length <= 2000 &&
            controls.query.trim().length > 0 &&
            !/[\t\r\n]/u.test(controls.query)))
      : selectedExpert &&
        controls.start.length > 0 &&
        controls.end.length > 0 &&
        controls.query.trim().length > 0 &&
        controls.query.length >= 10 &&
        controls.query.length <= 2000 &&
        !/[\t\r\n]/u.test(controls.query));
  const canApprove =
    !locked &&
    controls.candidate !== null &&
    controls.candidate.recordDigests.length ===
      controls.candidate.messages.length;
  const change = (
    field: "start" | "end" | "query" | "expertId",
    value: string
  ) => {
    if (
      !selectionLocked &&
      (field !== "expertId" ||
        value === "" ||
        experts.some((participant) => participant.participantId === value))
    )
      return controls.onSelectionChange(field, value);
    return;
  };
  return (
    <section
      className="vx-chat-response-controls"
      aria-label={
        nativeEvidence
          ? "Bounded First Mate native evidence request"
          : debating
            ? "Bounded stepwise debate request"
            : hasMate
              ? "One governed advisory response request"
              : "One-expert response request"
      }
      aria-busy={controls.busy}
    >
      <h3>
        {nativeEvidence
          ? "First Mate · one reviewed-evidence read · two phases"
          : debating
            ? "Two experts · two rounds · one explicit synthesis"
            : hasMate
              ? "Request one governed advisory response"
              : "Request one expert response"}
      </h3>
      {debate === undefined ? null : (
        <label>
          Response workflow
          <select
            aria-label="Response workflow"
            value={debate.mode}
            disabled={locked || controls.operationKey !== null}
            onChange={(event) => {
              if (
                !locked &&
                controls.operationKey === null &&
                (event.target.value === "one-expert" ||
                  event.target.value === "stepwise-debate" ||
                  event.target.value === "first-mate-read-reviewed-evidence-v1")
              )
                return debate.onModeChange(event.target.value);
              return;
            }}
          >
            <option value="one-expert">
              {hasMate
                ? "One advisory response (default)"
                : "One expert response (default)"}
            </option>
            <option value="stepwise-debate">
              Bounded stepwise debate · 5 turns
            </option>
            <option value="first-mate-read-reviewed-evidence-v1">
              First Mate · bounded native evidence protocol (explicit opt-in)
            </option>
          </select>
        </label>
      )}
      {debating ? (
        <p>
          Source-implemented workflow, not a claim of live availability. Only
          one shared reviewed corpus and identical review pins are supported.
          The server resolves the configured participants, selected synthesizer
          and budgets; incompatible selections remain unavailable. No automatic
          turns or client-issued reviews.
        </p>
      ) : null}
      {debating && hasPreviewOnlyExpert ? (
        <p>
          Selecting a first speaker requests a governed debate preview only;
          unavailable or incomplete corpus status is unchanged. The server
          checks the exact configured pair and may refuse the selected first
          speaker. Preparation may record plan/run metadata and read previously
          authorized predecessor inputs, but creates no new governed copies or
          model dispatch. Review and separately approve only the returned
          preview for this turn.
        </p>
      ) : null}
      {hasMate ? (
        <p>
          First Mate: configured for governed advisory requests;
          provider/context authorization still required. The server must resolve
          the current pinned configuration and reviewed context. No provider,
          native tool, backtest or debate readiness is implied.
        </p>
      ) : null}
      {nativeEvidence ? (
        <p>
          This separately selected protocol is not a claim of live availability
          or model-use permission. Preparation resolves a pinned bounded plan
          without governed copies or model dispatch. Approval covers only the
          displayed protocol and deterministic derivation rule; independent
          exact privacy decisions and model-use grants are still required for
          both phases.
        </p>
      ) : null}
      {!debating && hasPreviewOnlyExpert ? (
        <p>
          Ordinary expert selection requests a governed preview only, not
          availability or execution permission. Unavailable or incomplete corpus
          status remains unchanged. The server must check the current
          configuration, corpus and exact request; it may return unavailable.
          Preparation creates no governed copies, submits no approval and
          dispatches no model work.
        </p>
      ) : null}
      {hasPreviewOnlyExpert &&
      !experts.some(
        (participant) =>
          participant.kind === "expert" && isAvailable(participant)
      ) ? (
        <p>
          No ready reviewed expert in this room. You may request a governed
          preview; the server still determines whether it is available.
        </p>
      ) : null}
      <p>
        Select 1–16 contiguous human messages using their ORIGINAL sequence
        numbers. A reference or gap invalidates that window. Preview before
        approving; selection alone sends nothing to a model.
      </p>
      <fieldset disabled={selectionLocked}>
        <legend>
          {debating
            ? "Frozen original human context and configured first speaker"
            : hasMate
              ? "Human context and one governed advisory responder"
              : hasPreviewOnlyExpert
                ? "Human context and one expert for governed preview"
                : "Human context and one ready expert"}
        </legend>
        <div className="vx-chat-selection">
          <label>
            Start ORIGINAL sequence
            <Input
              aria-label="Start ORIGINAL sequence"
              inputMode="numeric"
              value={controls.start}
              onChange={(event) => change("start", event.target.value)}
            />
          </label>
          <label>
            End ORIGINAL sequence
            <Input
              aria-label="End ORIGINAL sequence"
              inputMode="numeric"
              value={controls.end}
              onChange={(event) => change("end", event.target.value)}
            />
          </label>
          <label>
            {responderLabel}
            <select
              aria-label={responderLabel}
              value={controls.expertId}
              onChange={(event) => change("expertId", event.target.value)}
            >
              <option value="">
                {hasMate ? "Select one responder" : "Select one expert"}
              </option>
              {experts.map((participant) => (
                <option
                  key={participant.participantId}
                  value={participant.participantId}
                >
                  {participant.displayName}
                  {" · "}
                  {participant.participantId}
                  {isConfiguredAdvisory(participant)
                    ? " · configured advisory only"
                    : nativeEvidence || isAvailable(participant)
                      ? ""
                      : ` · ${availabilityLabel(participant)} · corpus ${participant.corpus.status} · preview only`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Exact literal retrieval query · 10–2,000 characters, one line
            <Input
              aria-label="Exact literal retrieval query"
              maxLength={2000}
              value={controls.query}
              onChange={(event) => change("query", event.target.value)}
            />
          </label>
        </div>
      </fieldset>
      {experts.length === 0 ? (
        <p>
          {nativeEvidence
            ? "First Mate is not a participant in this room. This protocol cannot be prepared here."
            : debating
              ? "No eligible expert in this room for a governed debate preview. Blocked and nonexpert participants cannot request a debate preview."
              : "No eligible expert or configured advisory responder in this room. Blocked participants cannot request a preview."}
        </p>
      ) : null}
      <div className="vx-chat-actions">
        <Button
          type="button"
          variant="secondary"
          data-action="prepare-response"
          disabled={!canPrepare}
          onClick={() => {
            if (canPrepare) return controls.onPrepare();
            return;
          }}
        >
          {nativeEvidence
            ? "Preview bounded native evidence plan"
            : debating
              ? "Prepare next debate step"
              : "Preview context"}
        </Button>
      </div>
      {debating && debate !== undefined ? (
        <section aria-label="Stepwise debate metadata">
          <p>
            Original run key: {debate.runKey ?? "not prepared"}. The original
            human window and literal query remain unchanged for all five turns.
          </p>
          <Button
            type="button"
            variant="secondary"
            data-action="read-debate-run"
            disabled={disabled || controls.busy || debate.runKey === null}
            onClick={() => {
              if (!(disabled || controls.busy) && debate.runKey !== null)
                return debate.onReadRun();
              return;
            }}
          >
            Refresh debate metadata (no computation)
          </Button>
          {debate.metadata === null ? (
            <p>
              No current run metadata. Refresh never prepares, approves,
              publishes or requests a response.
            </p>
          ) : (
            <div>
              <LiteralMetadata
                label="Current bodyless debate run, charged ceilings and next-step pins"
                value={debate.metadata}
              />
              <p>
                Charged tokens: {debate.metadata.chargedTokens}. Charged USD
                base units (10^-18 USD): {debate.metadata.chargedUsdUnits}.
                These exact charges include full reserved ceilings, not just
                reported model usage.
              </p>
              <p>
                {debate.metadata.complete
                  ? "All five turns complete."
                  : debate.metadata.nextStep === null
                    ? "No next step ready. Publication and independent review are not inferred."
                    : `Step ${debate.metadata.nextStep.ordinal} is identified by server metadata; a new explicit preparation and labelled approval are still required.`}
              </p>
            </div>
          )}
        </section>
      ) : null}
      {controls.candidate === null ? (
        <p>
          No current preview. Choose the exact context and query, then select
          Preview context.
        </p>
      ) : (
        <PreparedContext candidate={controls.candidate} />
      )}
      <Button
        type="button"
        data-action="approve-response"
        // The label runs to ~70 characters: let it wrap inside the column instead of
        // widening the page at 375 px (the chrome is nowrap and h-9 by default).
        className="max-w-full [&>[data-slot=button-chrome]]:h-auto [&>[data-slot=button-chrome]]:min-h-9 [&>[data-slot=button-chrome]]:min-w-0 [&>[data-slot=button-chrome]]:whitespace-normal [&>[data-slot=button-chrome]]:py-2 [&>[data-slot=button-chrome]]:text-left"
        disabled={!canApprove}
        onClick={() => {
          if (canApprove) return controls.onApprove();
          return;
        }}
      >
        {controls.candidate !== null &&
        "nativeEvidence" in controls.candidate.preview
          ? "Approve displayed bounded native evidence protocol and request First Mate"
          : controls.candidate !== null &&
              "debate" in controls.candidate.preview
            ? `Approve displayed ${controls.candidate.preview.debate.kind === "synthesis" ? "synthesis" : "statement"} step ${controls.candidate.preview.debate.ordinal} of 5 and request only this turn`
            : nativeEvidence
              ? "Approve displayed bounded native evidence protocol"
              : debating
                ? "Approve displayed debate step only"
                : "Approve displayed context and request response"}
      </Button>
      <div
        className="vx-chat-operation"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <p>Original operation key: {controls.operationKey ?? "none"}</p>
        <p>{controls.status}</p>
      </div>
      <p>
        Unknown outcomes are inspect-only for the original key. Inspection never
        retries a model request. Eligibility is not publication or a completed
        answer.
      </p>
      <div className="vx-chat-actions">
        <Button
          type="button"
          variant="secondary"
          data-action="inspect-response"
          disabled={controls.busy || controls.operationKey === null}
          onClick={() => {
            if (!controls.busy && controls.operationKey !== null)
              return controls.onInspect();
            return;
          }}
        >
          Inspect original operation
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-action="append-response"
          disabled={disabled || controls.busy || !controls.canAppend}
          onClick={() => {
            if (!(disabled || controls.busy) && controls.canAppend)
              return controls.onAppend();
            return;
          }}
        >
          Publish immutable advisory reference
        </Button>
      </div>
      <p>
        Private content is held only for the current view, with at most 15
        seconds of freshness measured from the read request's start; network
        time consumes that bound and server read limits may end it earlier. The
        old body is cleared before a current revalidation while visible and
        online. Hidden, page-hidden, offline or authorization-invalidated views
        drop the reference and held content; select Show private answer again to
        request a current read. Denial or error clears the answer without
        automatic retry. This is not instant revocation and cannot erase
        knowledge already seen.
      </p>
    </section>
  );
};

type NativeClaim = ResearchPrivateBody["profile"]["output"]["claims"][number];
const PrivateClaim = ({ claim }: { readonly claim: NativeClaim }) => (
  <div className="vx-chat-native-claim">
    <p>{claim.kind}</p>
    <p className="vx-chat-body">{claim.text}</p>
    <ul className="vx-chat-citations">
      {claim.citations.map((citation, index) => (
        <li key={`${citation.evidence_id}/${index}`}>
          <p className="vx-chat-body">Quote: {citation.quote}</p>
          <dl className="vx-chat-pins">
            <div>
              <dt>Evidence ID</dt>
              <dd>{citation.evidence_id}</dd>
            </div>
            <div>
              <dt>Source ID / snapshot ID</dt>
              <dd>
                {citation.source_id}
                {" / "}
                {citation.source_snapshot_id}
              </dd>
            </div>
            <div>
              <dt>Content hash</dt>
              <dd>{citation.content_hash}</dd>
            </div>
            <div>
              <dt>Excerpt digest</dt>
              <dd>{citation.excerpt_digest}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  </div>
);

export const ResearchPrivatePanel = ({
  content,
  onHide,
}: {
  readonly content: ResearchPrivateView;
  readonly onHide?: (() => void) | undefined;
}) => {
  const value =
    content.status === "available" &&
    content.value?.reference.messageId === content.referenceId
      ? content.value
      : null;
  return (
    <section
      className="vx-chat-private"
      aria-label="Current private advisory answer"
      aria-busy={content.status === "loading"}
    >
      <h3>Current private answer</h3>
      <p>
        Separate from shared history and the human context. Literal research
        advice only; execution authorized: false. Claims and proposals cannot
        authorize a trade, tool or backtest.
      </p>
      <p>Reference: {content.referenceId ?? "none"}</p>
      {value === null ? (
        <p>
          {content.status === "loading"
            ? "Checking current private read access; no answer is displayed while loading."
            : content.status === "idle"
              ? "Private answer hidden. Select Show private answer on a reference to request a current read."
              : "Private answer unavailable. Its immutable reference and provenance remain in history."}
        </p>
      ) : (
        <div>
          <dl className="vx-chat-pins">
            <div>
              <dt>Checked at / READ ACCESS not after</dt>
              <dd>
                {value.checkedAt}
                {" / "}
                {value.notAfter}
              </dd>
            </div>
            <div>
              <dt>Advisory SHA-256 / bytes</dt>
              <dd>
                {value.sha256}
                {" / "}
                {value.byteLength}
              </dd>
            </div>
            <div>
              <dt>Response request / plan / plan SHA-256</dt>
              <dd>
                {value.profile.responseRequestId}
                {" / "}
                {value.profile.planId}
                {" / "}
                {value.profile.planSha256}
              </dd>
            </div>
            <div>
              <dt>Run / trace / task contract</dt>
              <dd>
                {value.profile.runId}
                {" / "}
                {value.profile.traceId}
                {" / "}
                {value.profile.taskContract}
              </dd>
            </div>
            <div>
              <dt>Model version / model-use request SHA-256</dt>
              <dd>
                {value.profile.modelVersion}
                {" / "}
                {value.profile.modelUseRequestSha256}
              </dd>
            </div>
            <div>
              <dt>Response SHA-256</dt>
              <dd>{value.profile.responseSha256}</dd>
            </div>
          </dl>
          <LiteralMetadata
            label="Recorded model usage"
            value={value.profile.usage}
          />
          {value.profile.profile === "vertex-research-chat-advisory-v2" ? (
            <LiteralMetadata
              label="Private answer debate provenance"
              value={value.profile.debate}
            />
          ) : null}
          <h4>Claims</h4>
          <ol className="vx-chat-native-claims">
            {value.profile.output.claims.map((claim, index) => (
              <li key={index}>
                <PrivateClaim claim={claim} />
              </li>
            ))}
          </ol>
          <h4>Proposals · not authorized actions</h4>
          {value.profile.output.proposals.length === 0 ? (
            <p>No proposals.</p>
          ) : (
            <ol className="vx-chat-native-proposals">
              {value.profile.output.proposals.map((proposal) => (
                <li key={proposal.proposal_id}>
                  <h4>{proposal.title}</h4>
                  <p>
                    {proposal.proposal_id}
                    {" · "}
                    {proposal.kind}
                    {" · execution_authorized: false"}
                  </p>
                  <PrivateClaim claim={proposal.rationale} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        data-action="hide-private-response"
        disabled={onHide === undefined || content.status === "idle"}
        onClick={() => {
          if (content.status !== "idle") return onHide?.();
          return;
        }}
      >
        Hide private answer
      </Button>
      <p>
        Read freshness lasts at most 15 seconds from request start, including
        network time, and may end earlier. Hiding drops this view's held answer;
        it is not a server deletion request or erasure of information already
        seen. After a hidden or offline view, select Show private answer again.
      </p>
    </section>
  );
};

export const ResearchReference = ({
  reference,
  name,
  onView,
}: {
  readonly reference: VertexResearchChatAgentReferenceMessage;
  readonly name: string;
  readonly onView?:
    | ((reference: VertexResearchChatAgentReferenceMessage) => void)
    | undefined;
}) => (
  <article className="vx-chat-message" data-speaker-kind="advisory-reference">
    <header className="vx-chat-message-header">
      <strong>{name}</strong>
      <span>Immutable advisory reference · no answer body in history</span>
      <time dateTime={reference.recordedAt}>{reference.recordedAt}</time>
    </header>
    <dl className="vx-chat-pins">
      <div>
        <dt>Message / original sequence</dt>
        <dd>
          {reference.messageId}
          {" / "}
          {reference.sequence}
        </dd>
      </div>
      <div>
        <dt>Participant / run</dt>
        <dd>
          {reference.author.participantId}
          {" / "}
          {reference.author.runId}
        </dd>
      </div>
      <div>
        <dt>Chronology parent</dt>
        <dd>{reference.parentMessageId}</dd>
      </div>
      <div>
        <dt>Original response-to message</dt>
        <dd>{reference.replyToMessageId}</dd>
      </div>
    </dl>
    <LiteralMetadata
      label="Immutable response provenance"
      value={reference.response}
    />
    <p>
      Reference metadata remains when private content is unavailable. It is not
      current read permission or execution authority.
    </p>
    <Button
      type="button"
      variant="secondary"
      data-action="view-private-response"
      disabled={onView === undefined}
      onClick={() => onView?.(reference)}
    >
      Show private answer
    </Button>
  </article>
);

const ResearchTranscript = () => {
  const value = useContext(TranscriptContext);
  if (value === null) return null;
  const {
    selectedThread,
    messages,
    participants,
    loading,
    error,
    onViewResponse,
  } = value;
  if (loading)
    return (
      <p className="vx-chat-empty">
        Loading research conversation. Previous messages are not shown while
        loading.
      </p>
    );
  if (error !== null)
    return (
      <p className="vx-chat-empty">
        Conversation unavailable. Refresh reads before continuing; do not
        blindly resend a message with an unknown outcome.
      </p>
    );
  if (selectedThread === null)
    return (
      <p className="vx-chat-empty">
        Create a research room or select an existing conversation. No message or
        agent response has been generated.
      </p>
    );
  if (!isResearchThread(selectedThread))
    return (
      <p className="vx-chat-empty">
        Unsupported scope. This room accepts research records only; execution
        authority must be false.
      </p>
    );
  const roster = new Map(
    participants.map((participant) => [participant.participantId, participant])
  );
  const visible = messages.filter(
    (message) =>
      message.threadId === selectedThread.threadId &&
      message.executionAuthorized === false &&
      (message.kind === "advisory-reference" || message.author.kind === "user")
  );
  return (
    <section
      className="vx-chat-transcript"
      aria-label="Named research transcript"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
      tabIndex={0}
    >
      {visible.length === messages.length ? null : (
        <p className="vx-chat-warning">
          Some records were withheld because their thread or execution scope did
          not match.
        </p>
      )}
      {visible.length === 0 ? (
        <p className="vx-chat-empty">
          No messages recorded. Add a human research question. A private expert
          response requires a separate displayed-context approval.
        </p>
      ) : null}
      <ol className="vx-chat-messages">
        {visible.map((record) => {
          if (record.kind === "advisory-reference")
            return (
              <li key={record.messageId}>
                <ResearchReference
                  reference={record}
                  name={
                    roster.get(record.author.participantId)?.displayName ??
                    "Unknown participant"
                  }
                  onView={onViewResponse}
                />
              </li>
            );
          return (
            <li key={record.messageId}>
              <article className="vx-chat-message" data-speaker-kind="human">
                <header className="vx-chat-message-header">
                  <strong>Human: {record.author.actorId}</strong>
                  <span>Human statement</span>
                  <time dateTime={record.recordedAt}>{record.recordedAt}</time>
                </header>
                <p className="vx-chat-meta">
                  Message: {record.messageId}
                  {" · Original sequence: "}
                  {record.sequence}
                </p>
                <p className="vx-chat-body">{record.body}</p>
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

// The public slot type includes the default function's static Cursor member.
// Supply a matching namespace without mounting or calling any default renderer.
// React elements are NOT valid slot replacements in this installed vendor API.
const TranscriptMessageView = Object.assign(() => <ResearchTranscript />, {
  Cursor: () => <></>,
});

const ParticipantFacts = ({
  participant,
}: {
  readonly participant: VertexResearchChatRosterEntry;
}) => (
  <div className="vx-chat-participant" data-participant-kind={participant.kind}>
    <h4>{participant.displayName}</h4>
    <p>
      {participant.kind === "first-mate"
        ? "First mate · research coordinator"
        : "Corpus-based research agent — not a human participant"}
    </p>
    <p>{participant.specialty}</p>
    <p className="vx-chat-availability">{availabilityLabel(participant)}</p>
    <p>Corpus: {participant.corpus.status}</p>
    {participant.reasonCodes.length > 0 ? (
      <p>Reasons: {participant.reasonCodes.join(", ")}</p>
    ) : null}
    <dl className="vx-chat-pins">
      <div>
        <dt>Collection</dt>
        <dd>{participant.corpus.collectionId ?? "Unknown"}</dd>
      </div>
      <div>
        <dt>SHA-256</dt>
        <dd>{participant.corpus.snapshotSha256 ?? "Unknown"}</dd>
      </div>
      <div>
        <dt>Review</dt>
        <dd>{participant.corpus.reviewId ?? "Unknown"}</dd>
      </div>
    </dl>
  </div>
);

export const ResearchChatView = (props: ResearchChatViewProps) => {
  const {
    selectedThread,
    threads,
    messages,
    participants,
    loading,
    error,
    draft,
    sending,
    mutationLocked = false,
    sendDisabled = false,
    responseStatus,
    responseReasonCodes,
    requestedParticipantIds,
    mode,
    onDraftChange,
    onRequestedParticipantsChange,
    onModeChange,
    onSelectThread,
    onCreateThread,
    onSendMessage,
    onRetry,
    conversation,
    privateContent,
    onViewResponse,
    onHideResponse,
  } = props;
  const hasResearchThread =
    selectedThread !== null && isResearchThread(selectedThread);
  const blocked =
    !hasResearchThread ||
    loading ||
    sending ||
    mutationLocked ||
    error !== null;
  const members = new Set(selectedThread?.participantIds ?? []);
  const eligible = new Set(
    participants
      .filter(
        (participant) =>
          members.has(participant.participantId) && isAvailable(participant)
      )
      .map((participant) => participant.participantId)
  );
  const requestsValid =
    requestedParticipantIds.length <= 8 &&
    new Set(requestedParticipantIds).size === requestedParticipantIds.length &&
    requestedParticipantIds.every((id) => eligible.has(id));
  const canSend =
    !(blocked || sendDisabled) &&
    (conversation !== undefined || requestsValid) &&
    draft.trim().length > 0 &&
    draft.length <= 8000;
  const visiblePrivate =
    privateContent !== undefined &&
    (!hasResearchThread ||
      loading ||
      error !== null ||
      (privateContent.value !== null &&
        privateContent.value.reference.threadId !== selectedThread?.threadId))
      ? { ...privateContent, status: "unavailable" as const, value: null }
      : privateContent;
  const submit = () => {
    if (canSend) return onSendMessage();
    return;
  };
  const createThread = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || sending || mutationLocked || error !== null) return;
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    const ids = data.getAll("participantId").map(String);
    if (
      title.length === 0 ||
      title.length > 160 ||
      ids.length === 0 ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) =>
        participants.some((participant) => participant.participantId === id)
      )
    )
      return;
    return onCreateThread(title, ids);
  };
  const changeParticipant = (id: string, checked: boolean) => {
    if (blocked) return;
    if (!checked) {
      return onRequestedParticipantsChange(
        requestedParticipantIds.filter((current) => current !== id)
      );
    }
    if (
      eligible.has(id) &&
      !requestedParticipantIds.includes(id) &&
      requestedParticipantIds.length < 8
    ) {
      return onRequestedParticipantsChange([...requestedParticipantIds, id]);
    }
    return;
  };
  const input: CopilotChatInputProps = {
    mode: "input",
    autoFocus: false,
    positioning: "static",
    bottomAnchored: false,
    showDisclaimer: false,
    // The vendor clears onChange("") immediately on send, even in controlled mode.
    // Native textArea.onChange is the only draft writer; parent owns acknowledgement.
    onChange: () => ({}),
    textArea: {
      disabled: blocked,
      maxLength: 8000,
      rows: 3,
      "aria-label": "Research message",
      placeholder: "Ask a research question. Shift+Enter adds a line.",
      className: "vx-chat-textarea",
      onChange: (event) => {
        if (!blocked) return onDraftChange(event.target.value);
        return;
      },
    },
    sendButton: SendButton,
    addMenuButton: EmptySlot,
    startTranscribeButton: EmptySlot,
    // No audio recorder is mounted in the pinned input mode.
    cancelTranscribeButton: EmptySlot,
    finishTranscribeButton: EmptySlot,
    disclaimer: EmptySlot,
    className: "vx-chat-input",
  };
  const status = loading
    ? "Loading research conversation"
    : sending
      ? "Sending human message; server acknowledgement pending"
      : responseStatus === "queued"
        ? "Response queued; no completed answer yet"
        : responseStatus === "unavailable"
          ? "No agent response was queued. Agent response unavailable"
          : responseStatus === "not-requested"
            ? "Human message only; no agent response requested"
            : "No new response admission reported";
  const recordedCount =
    hasResearchThread && !loading && error === null
      ? messages.filter(
          (message) =>
            message.threadId === selectedThread?.threadId &&
            message.executionAuthorized === false
        ).length
      : 0;
  return (
    <div className="vx-research-chat">
      <header className="vx-chat-heading">
        <p className="vx-chat-eyebrow">Shared research conversation</p>
        <h2>Research room</h2>
        <p>
          Discuss evidence with named corpus-based research agents. They are not
          the people whose work informs their corpora.
        </p>
        <p className="vx-chat-authority">
          Research only · Execution authorized: false. Messages, synthesis and
          backtests never authorize trades. Tools and backtests require separate
          server admission.
        </p>
      </header>
      <div className="vx-chat-layout">
        <aside className="vx-chat-sidebar" aria-label="Research rooms">
          <h3>Rooms</h3>
          <nav aria-label="Research conversations">
            <ul className="vx-chat-threads" data-click-private="">
              {threads.filter(isResearchThread).map((thread) => (
                <li key={thread.threadId}>
                  <Button
                    variant="ghost"
                    className="vx-chat-thread"
                    aria-current={
                      selectedThread?.threadId === thread.threadId
                        ? "page"
                        : undefined
                    }
                    disabled={loading || sending || mutationLocked}
                    onClick={() => {
                      if (!(loading || sending || mutationLocked))
                        return onSelectThread(thread.threadId);
                      return;
                    }}
                  >
                    <span>
                      {thread.title}
                      <small>
                        {thread.accountAlias}
                        {" · "}
                        {thread.threadId}
                      </small>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
          {threads.length === 0 ? <p>No rooms loaded.</p> : null}
          {/* id: the Research page's New room action opens this form (research.tsx). */}
          <details
            className="vx-chat-create"
            id="research-new-room"
            open={threads.length === 0}
          >
            <summary>Create a research room</summary>
            <form onSubmit={createThread} aria-label="Create research room">
              <label>
                Room title
                <Input
                  name="title"
                  required
                  maxLength={160}
                  disabled={
                    loading || sending || mutationLocked || error !== null
                  }
                />
              </label>
              <fieldset
                disabled={
                  loading || sending || mutationLocked || error !== null
                }
              >
                <legend>Room participants · choose 1–16</legend>
                {participants.map((participant) => (
                  <label
                    className="vx-chat-choice"
                    key={participant.participantId}
                  >
                    <input
                      type="checkbox"
                      name="participantId"
                      value={participant.participantId}
                    />
                    <span>
                      {participant.displayName}
                      {" · "}
                      {availabilityLabel(participant)}
                    </span>
                  </label>
                ))}
              </fieldset>
              <p>
                Room membership does not request a response or activate an
                unavailable agent.
              </p>
              <Button
                type="submit"
                variant="secondary"
                disabled={
                  loading ||
                  sending ||
                  mutationLocked ||
                  error !== null ||
                  participants.length === 0
                }
              >
                Create room
              </Button>
            </form>
          </details>
        </aside>
        <section
          className="vx-chat-main"
          aria-label="Selected research conversation"
          aria-busy={loading || sending}
        >
          <header className="vx-chat-room-heading">
            <h3>{selectedThread?.title ?? "No room selected"}</h3>
            {selectedThread === null ? null : (
              <p>
                {selectedThread.accountAlias}
                {" / "}
                {selectedThread.environment}
                {" · "}
                {selectedThread.threadId}
              </p>
            )}
          </header>
          {error === null ? null : (
            <div role="alert" className="vx-chat-warning">
              <p>{error}</p>
              <p>
                An uncertain write may already be recorded. Refresh and
                reconcile reads; this button does not resend messages.
              </p>
              <Button
                variant="secondary"
                data-action="retry-read"
                disabled={loading || sending}
                onClick={onRetry}
              >
                Refresh conversation
              </Button>
            </div>
          )}
          <TranscriptProvider
            value={{
              selectedThread,
              messages,
              participants,
              loading,
              error,
              onViewResponse,
            }}
          >
            <CopilotChatView
              messageView={TranscriptMessageView}
              welcomeScreen={false}
              hasExplicitThreadId={hasResearchThread}
              autoScroll={false}
              inputValue={draft}
              {...(canSend ? { onSubmitMessage: submit } : {})}
              input={input}
            >
              {({ messageView, input: composer }) => (
                <div className="vx-chat-controlled">
                  {messageView}
                  <div className="vx-chat-composer">
                    {conversation === undefined ? (
                      <label className="vx-chat-mode">
                        Conversation mode
                        <select
                          aria-label="Conversation mode"
                          value={mode}
                          disabled={blocked}
                          onChange={(event) => {
                            if (
                              !blocked &&
                              (event.target.value === "discuss" ||
                                event.target.value === "debate")
                            )
                              return onModeChange(event.target.value);
                            return;
                          }}
                        >
                          <option value="discuss">Discuss</option>
                          <option value="debate">Debate</option>
                        </select>
                      </label>
                    ) : null}
                    <p>
                      Research message · {draft.length}/8,000 characters.
                      Shift+Enter for a new line.
                    </p>
                    {composer}
                    <p>
                      {conversation === undefined
                        ? requestedParticipantIds.length === 0
                          ? "Human-only message. Neither mode automatically requests agent replies."
                          : `Requesting ${requestedParticipantIds.length} participant response(s). Selection is not admission.`
                        : "Human-only message. Send records your text; it never requests an expert answer."}
                    </p>
                    {conversation === undefined && !requestsValid ? (
                      <p className="vx-chat-warning">
                        Selected responders are unavailable, outside this room,
                        duplicated or over the eight-participant limit. Deselect
                        them before sending.
                      </p>
                    ) : null}
                    {draft.length > 8000 ? (
                      <p className="vx-chat-warning">
                        Message exceeds the 8,000-character limit.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </CopilotChatView>
          </TranscriptProvider>
          {conversation === undefined ? null : (
            <ResearchConversationPanel
              controls={conversation}
              participants={participants.filter((participant) =>
                members.has(participant.participantId)
              )}
              disabled={blocked}
            />
          )}
          {visiblePrivate === undefined ? null : (
            <ResearchPrivatePanel
              content={visiblePrivate}
              onHide={onHideResponse}
            />
          )}
          <div
            className="vx-chat-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <p>
              {status}
              {". "}
              {recordedCount} recorded messages in this room.
            </p>
            {responseReasonCodes.length > 0 ? (
              <p>Reasons: {responseReasonCodes.join(", ")}</p>
            ) : null}
          </div>
        </section>
        <aside className="vx-chat-roster" aria-label="Participant readiness">
          <h3>Participants</h3>
          <p>
            Readiness is not permission to run. Corpus rights, budgets and job
            grants remain server checks.
          </p>
          {participants.length === 0 ? (
            <p>No participants supplied. No experts are being simulated.</p>
          ) : null}
          {conversation === undefined ? (
            <fieldset disabled={blocked}>
              <legend>Request responders · up to 8</legend>
              {participants.map((participant) => (
                <div
                  key={participant.participantId}
                  className="vx-chat-roster-entry"
                >
                  <ParticipantFacts participant={participant} />
                  <label className="vx-chat-choice">
                    <input
                      type="checkbox"
                      checked={requestedParticipantIds.includes(
                        participant.participantId
                      )}
                      disabled={
                        !requestedParticipantIds.includes(
                          participant.participantId
                        ) &&
                        (!eligible.has(participant.participantId) ||
                          requestedParticipantIds.length >= 8)
                      }
                      onChange={(event) =>
                        changeParticipant(
                          participant.participantId,
                          event.target.checked
                        )
                      }
                    />
                    <span>Request {participant.displayName}</span>
                  </label>
                  {members.has(participant.participantId) ? null : (
                    <p>Not in the selected room</p>
                  )}
                </div>
              ))}
              {requestedParticipantIds
                .filter(
                  (id) =>
                    !participants.some(
                      (participant) => participant.participantId === id
                    )
                )
                .map((id) => (
                  <label className="vx-chat-choice" key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => changeParticipant(id, false)}
                    />
                    <span>
                      Unknown participant: {id} · deselect to continue
                    </span>
                  </label>
                ))}
            </fieldset>
          ) : (
            <div>
              {participants.map((participant) => (
                <div
                  key={participant.participantId}
                  className="vx-chat-roster-entry"
                >
                  <ParticipantFacts participant={participant} />
                  {members.has(participant.participantId) ? null : (
                    <p>Not in the selected room</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
