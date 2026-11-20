import {
  type VertexResearchChatCorpus,
  type VertexResearchChatReadResponseOutput,
  type VertexResearchChatResponseReasonCode,
  VertexResearchChatResponseReasonCodeSchema,
  type VertexResearchChatRosterEntry,
} from "@darkfactory/api/vertex";
import {
  localClock,
  sinceClock,
} from "../../components/portal/portfolio-monitor-model.ts";
import { classifyVertexFailure } from "../../components/research/vertex-client.ts";

// Definite display text for research chat machine codes. A code is never printed raw: each label
// names what is missing and the next step. The caller adds the time the server checked.

// Browser-local hour and minute with the zone name ("14:02 EST").
export const clockAt = (ms: number): string => localClock(new Date(ms));

// A server timestamp as a local clock. Text that is not a timestamp is shown as sent.
export const serverClock = (timestamp: string): string => {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? timestamp : clockAt(ms);
};

// Reason codes of the response contract. Exhaustive: a new contract code fails the type check here.
const responseReason = (code: VertexResearchChatResponseReasonCode): string => {
  switch (code) {
    case "participant-unavailable":
      return "the server reported that the selected participant cannot take this request and gave no further cause; choose another responder or ask the operator";
    case "corpus-unavailable":
      return "the server reported that the expert corpus cannot be used for this request and gave no further cause; ask the operator to check the collection";
    case "context-limit":
      return "the selected context is over the server limit; choose a smaller window";
    case "context-lineage-unsupported":
      return "the selected context holds records this request type cannot use; choose a human-only window";
    case "context-use-unavailable":
      return "the server reported that use of the selected context could not be confirmed and gave no further cause; prepare again";
    case "context-retention-unavailable":
      return "the server reported that retention of the selected context could not be confirmed and gave no further cause; prepare again";
    case "model-input-preparation-unavailable":
      return "the server did not complete the preparation of the model input: its store transaction ended with an error, or a policy or configuration it needs was not readable (an expired one gives the same result); nothing was sent to a model; prepare again, and ask the operator if it repeats";
    case "model-input-approval-unavailable":
      return "the approval was not accepted; nothing was sent to a model; prepare a new preview";
    case "research-runtime-unavailable":
      return "the research runtime did not take this request; nothing was sent to a model";
    case "worker-unavailable":
      return "the server reported that no research worker could take this request and gave no further cause; nothing was sent; retry later or ask the operator";
    case "projection-unavailable":
      return "no published answer is readable for this request now (not produced yet, expired or revoked); inspect the same key later";
    case "policy-unavailable":
      return "the server reported that the governing policy could not be used and gave no further cause; nothing was sent; retry or ask the operator";
    case "policy-revoked":
      return "the governing policy or approval was revoked; prepare a new request";
    case "rights-denied":
      return "the source rights do not allow this use; choose other evidence";
    case "review-unavailable":
      return "the server reported that the required review could not be used and gave no further cause; ask the reviewer or the operator";
    case "deadline":
      return "the request deadline passed before the server finished; prepare again";
    case "worker-failed":
      return "the worker reported a failure; no answer was produced; prepare a new request";
    case "cancelled":
      return "the job was cancelled; no answer was produced";
    case "outcome-unknown":
      return "the outcome is not confirmed; inspect the same request key and do not send a replacement";
    case "research-runtime-not-configured":
      return "the research runtime is not enabled on this deployment; nothing was sent; ask the operator to enable it";
    case "model-input-denied":
      return "the server denied the model input for this caller; nothing was sent to a model; check your access, then prepare again";
    case "model-input-approval-denied":
      return "the server denied this approval; nothing was sent to a model; prepare a new preview";
    case "projection-read-failed":
      return "the server did not complete the read of the published answer: a store, storage or policy read ended with an error (an expired policy gives the same result); nothing changed; retry the same key, and ask the operator if it repeats";
    case "projection-read-denied":
      return "the server denied the read of the published answer: a grant, right or policy of the original request no longer allows it; nothing was shown; ask the operator to check access";
    case "response-not-recorded":
      return "the server found no worker record for this request that this account can read; check the request key, or prepare a new request";
    case "response-not-produced":
      return "the server holds no answer record for this request; if the worker job still runs, inspect the same key later";
    case "response-publication-unconfirmed":
      return "the publication of the answer is not confirmed (no publication record, or its worker job has not succeeded); inspect the same key later";
    case "response-input-copies-unconfirmed":
      return "the server has not confirmed every input-copy acknowledgement for this answer, so it holds the answer back; inspect the same key later";
    case "response-authority-closed":
      return "the approval for this answer is no longer current (it expired, was revoked or was cleaned up; the server does not say which); prepare a new request";
    case "response-check-incomplete":
      return "a check the server needs did not complete: a proof record is missing or a runtime it needs is not configured; the server holds the answer back; inspect the same key later, and ask the operator if it repeats";
    case "worker-outcome-unconfirmed":
      return "the job closed without a confirmed outcome; the server will not settle it; prepare a new request";
  }
};

// Codes of the roster, send and debate contracts. The roster and send fields are open strings,
// so a code without a description is named as such and never hidden.
const otherReason = (code: string): string => {
  switch (code) {
    case "research-chat-agent-admission-unavailable":
      return "sending a message never queues an agent response; use Prepare, then Approve";
    case "first-mate-configuration-unavailable":
      return "no current First Mate advisory configuration could be read (missing, expired, or the read failed); ask the operator to check the advisory configuration";
    case "governed-prepare-required":
      return "each advisory request needs its own governed Prepare and approval";
    case "corpus-not-qualified":
      return "the expert corpus has no accepted review yet";
    case "tools-not-integrated":
      return "research-room coordination tools are not integrated";
    case "debate-runtime-not-configured":
      return "the debate runtime is not enabled on this deployment; ask the operator to enable it";
    case "debate-not-found":
      return "the server holds no debate run for this key; prepare the first step";
    case "debate-expired":
      return "the read window of this debate run ended; read the run again";
    default:
      return `code ${code} (this page has no description for it)`;
  }
};

// A broad code whose specific cause was also sent. The broad text is then left out, so the
// status names one cause and not a list of possible ones.
const PROJECTION_CAUSES: readonly string[] = [
  "response-not-recorded",
  "response-not-produced",
  "response-publication-unconfirmed",
  "response-input-copies-unconfirmed",
  "response-authority-closed",
  "response-check-incomplete",
];
const specificCauses = (code: string): readonly string[] => {
  switch (code) {
    case "projection-unavailable":
      return PROJECTION_CAUSES;
    case "outcome-unknown":
      return ["worker-outcome-unconfirmed"];
    default:
      return [];
  }
};
const narrowed = (code: string, codes: readonly string[]): boolean =>
  specificCauses(code).some((specific) => codes.includes(specific));

export const reasonText = (codes: readonly string[]): string =>
  codes
    .filter((code) => !narrowed(code, codes))
    .map((code) => {
      const known = VertexResearchChatResponseReasonCodeSchema.safeParse(code);
      return known.success ? responseReason(known.data) : otherReason(code);
    })
    .join("; ");

type ReadResponse = VertexResearchChatReadResponseOutput;

export const jobStateText = (
  state: NonNullable<ReadResponse["job"]>["state"]
): string => {
  switch (state) {
    case "leased":
      return "leased to a worker";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "no confirmed result: the worker reported its outcome as unknown, or the job was cancelled or its lease or deadline passed before it reported; an engine may still have run; this state does not resolve by waiting";
  }
};

// Job state with the lease end of a job that is still leased or running.
// A lease end that has passed is named as passed; the date is added when it is not today.
// A job in a final state (including unknown) has no pending lease, so none is shown.
export const jobText = (
  job: NonNullable<ReadResponse["job"]>,
  nowMs: number
): string => {
  const state = jobStateText(job.state);
  const open = job.state === "leased" || job.state === "running";
  if (!open || job.leaseExpiresAt === undefined) return state;
  const end = sinceClock(job.leaseExpiresAt, nowMs);
  // Text that is not a timestamp is shown as sent, with no claim about past or future.
  if (end === null) return `${state}; job lease end ${job.leaseExpiresAt}`;
  const passed = Date.parse(job.leaseExpiresAt) <= nowMs;
  return `${state}; job lease ${passed ? "ended" : "ends"} ${end}`;
};

export const deliveryText = (delivery: ReadResponse["delivery"]): string => {
  switch (delivery.status) {
    case "not-applicable":
      return "none, because the request was not admitted";
    case "pending":
      return "pending, the worker has not finished";
    case "eligible":
      return "answer ready to append";
    case "appended":
      return "appended to the conversation";
    case "unavailable":
      return `not deliverable (${reasonText(delivery.reasonCodes)})`;
  }
};

export const receiptText = (
  receipt: Pick<ReadResponse["receipt"], "status" | "reasonCodes">
): string =>
  receipt.status === "admitted"
    ? "admitted"
    : `not admitted (${reasonText(receipt.reasonCodes)})`;

type CorpusStatus = VertexResearchChatCorpus["status"];
export const corpusText = (status: CorpusStatus): string => {
  switch (status) {
    case "unknown":
      return "review status not reported by the server";
    case "incomplete":
      return "incomplete";
    case "reviewed":
      return "reviewed";
    case "not-applicable":
      return "not applicable, this participant has no corpus by design";
  }
};

// A corpus pin that the roster did not send, with the corpus state that explains it.
export const corpusPinText = (
  pin: string | null,
  status: CorpusStatus
): string => pin ?? `Not supplied by roster (corpus ${corpusText(status)})`;

const rosterCodes = (
  participant: VertexResearchChatRosterEntry
): readonly string[] => [
  ...participant.reasonCodes,
  ...(participant.advisory?.reasonCodes ?? []),
];

// Why a roster entry cannot take a request: its own reasons, else its corpus state.
export const notReadyText = (
  participant: VertexResearchChatRosterEntry
): string => {
  const codes = rosterCodes(participant);
  const cause =
    codes.length > 0
      ? reasonText(codes)
      : `corpus ${corpusText(participant.corpus.status)}`;
  return `${participant.availability === "blocked" ? "Blocked" : "Not ready"}: ${cause}`;
};

// One line for a picker option: the cause, then the corpus state unless the cause is that state.
export const pickerStateText = (
  participant: VertexResearchChatRosterEntry
): string =>
  rosterCodes(participant).length > 0
    ? `${notReadyText(participant)} · corpus ${corpusText(participant.corpus.status)}`
    : notReadyText(participant);

// The first rule a responder selection breaks, with the participant named. Null when valid.
export const responderProblem = (
  requested: readonly string[],
  participants: readonly VertexResearchChatRosterEntry[],
  members: ReadonlySet<string>,
  eligible: ReadonlySet<string>
): string | null => {
  if (requested.length > 8)
    return `${requested.length} responders are selected; the limit is 8`;
  const name = (id: string): string =>
    participants.find((entry) => entry.participantId === id)?.displayName ??
    `Participant ${id}`;
  for (const [index, id] of requested.entries()) {
    if (requested.indexOf(id) !== index) return `${name(id)} is selected twice`;
    if (!members.has(id)) return `${name(id)} is not in this room`;
    if (!eligible.has(id)) return `${name(id)} is not ready for a request`;
  }
  return null;
};

// What a request did when it ended with an error, and the next step.
export type RequestEnd = Readonly<{ what: string; next: string }>;

// "<what> at 14:02 EST (<cause>). <then>" for a request that ended with an error.
// Only the classified title is shown, never the text of the error itself.
export const endedText = (
  end: RequestEnd,
  error: unknown,
  nowMs: number
): string =>
  `${end.what} at ${clockAt(nowMs)} (${classifyVertexFailure(error).title}). ${end.next}`;

// "<what> (checked 14:02 EST): <causes>" for a state the server reported.
// An older server sends no time and no cause; the text says so.
export const reportedText = (
  what: string,
  checkedAt: string | undefined,
  codes: readonly string[] | undefined,
  notAfter?: string
): string => {
  const at =
    checkedAt === undefined ? "" : ` (checked ${serverClock(checkedAt)})`;
  const cause =
    codes === undefined || codes.length === 0
      ? "the server sent no cause"
      : reasonText(codes);
  const ended =
    notAfter === undefined ? "" : `; window ended ${serverClock(notAfter)}`;
  return `${what}${at}: ${cause}${ended}`;
};

// An approve or append call that the server did not record.
type Unrecorded = Readonly<{
  status: "blocked" | "unavailable" | "unknown";
  reasonCodes: readonly string[];
  checkedAt?: string | undefined;
  stage?: string | undefined;
  startedAt?: string | undefined;
}>;
export const unrecordedText = (value: Unrecorded): string => {
  if (value.status !== "unknown")
    return reportedText(
      value.status === "blocked" ? "Blocked" : "Not done",
      value.checkedAt,
      value.reasonCodes
    );
  const stage =
    value.stage === undefined ? "" : `; last stage started: ${value.stage}`;
  const since =
    value.startedAt === undefined
      ? ""
      : `; call started ${serverClock(value.startedAt)}`;
  return `Outcome not confirmed${stage}${since}`;
};
