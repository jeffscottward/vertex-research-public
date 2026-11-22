// biome-ignore-all lint/suspicious/noTemplateCurlyInString: entries quote source text, including template placeholders.
// Allow list of the API status language guard (status-language.test.ts). Data only.
// An entry with `open: true` is a known ambiguous text, or a wire value that the app prints as it
// arrives, from the first scan of 2026-11-22: it leaves this list when its replacement merges. An
// entry without `open` was checked and is kept for its reason.
// Regenerate: UPDATE_STATUS_LANGUAGE=1 on the test, then `biome format --write` this file.

import type { StatusLanguageEntry } from "../../../scripts/lib/status-language.ts";

export const STATUS_LANGUAGE_ALLOWLIST: readonly StatusLanguageEntry[] = [
  {
    file: "agent-model-runs-csv.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the separator between date and time in the CSV file name.",
  },
  {
    file: "agent-rating-placebo.ts",
    text: "unavailable",
    count: 4,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/academy.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/agent-model-runs.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/agent-ops.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/congress-trades.ts",
    text: "Congress trade storage unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/flow.ts",
    text: "source_unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/flow.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/golive-drafts.ts",
    text: "nlv_unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/golive-drafts.ts",
    text: "NLV_UNAVAILABLE",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/golive-drafts.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/golive-drafts.ts",
    text: "unknown",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/ibkr-recovery.ts",
    text: "Audit log unavailable; the request was not sent",
    count: 1,
    reason:
      "Kept: names what failed (the audit log) and the effect (the request was not sent), so the reader knows that the action did not run. The cause of the audit failure is not named.",
  },
  {
    file: "contracts/market-data.ts",
    text: "IBKR history service unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/market-notes.ts",
    text: "Market notes storage unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/nautilus-arm.ts",
    text: "Audit log unavailable; nothing was changed",
    count: 1,
    reason:
      "Kept: names what failed (the audit log) and the effect (nothing was changed), so the reader knows that the action did not run. The cause of the audit failure is not named.",
  },
  {
    file: "contracts/nautilus-arm.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/openbb.ts",
    text: "layout_unknown",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/options-analytics.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/research-reports.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/research-screen.ts",
    text: "Research screen storage unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/research-screen.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/sector-rotation.ts",
    text: "Market data source unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/sector-rotation.ts",
    text: "Sector rotation storage unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/semantic-terms.ts",
    text: "not_available",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/semantic-terms.ts",
    text: "unknown",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/smart-money.ts",
    text: "Smart money storage unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/smart-money.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-control.ts",
    text: "source-unavailable",
    count: 3,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-control.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Known ambiguous: the continuity state is a wire value that the app prints as it arrives ('Continuity: unavailable' in features/experience/today.tsx). It needs a label that names the state and its cause.",
    open: true,
  },
  {
    file: "contracts/vertex-control.ts",
    text: "unknown",
    count: 1,
    reason:
      "Known ambiguous: the reservation state is a wire value that the app prints as it arrives (column 'State' in features/experience/portfolio.tsx). It needs a label that names the state and its cause.",
    open: true,
  },
  {
    file: "contracts/vertex-experience-status-reads.ts",
    text: "source-unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-experience-status-reads.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-experience.ts",
    text: "Vertex capability unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/vertex-local-setup.ts",
    text: "Local research setup is not available for this account",
    count: 1,
    reason:
      "Kept: message of the FORBIDDEN error (403). It names the cause: this account has no access to the local setup.",
  },
  {
    file: "contracts/vertex-notification-read.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-policy.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-policy.ts",
    text: "unknown",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-read.ts",
    text: "Vertex read service unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/vertex-research-chat-conversation.ts",
    text: "outcome-unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-conversation.ts",
    text: "unavailable",
    count: 5,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-conversation.ts",
    text: "unknown",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-debate.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response-rpc.ts",
    text: "Approve only this displayed exact debate plan/request after separate source-use and operation privacy review. Unknown ACK requires original-key inspection.",
    count: 1,
    reason:
      "Kept: route description in prose (OpenAPI). 'Unknown' names the acknowledgement state, and the sentence says what to do then.",
  },
  {
    file: "contracts/vertex-research-chat-response-rpc.ts",
    text: "Deliberately approve the displayed exact plan/request and invoke original admission. Blocked does not prove absence; unknown requires same-key inspection, not retry.",
    count: 1,
    reason:
      "Kept: route description in prose (OpenAPI). 'Unknown' names the acknowledgement state, and the sentence says what to do then.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "context-retention-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "context-use-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "corpus-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "model-input-approval-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "model-input-preparation-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "outcome-unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "participant-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "policy-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "projection-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "research-runtime-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "review-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat-response.ts",
    text: "worker-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat.ts",
    text: "first-mate-configuration-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-research-chat.ts",
    text: "Vertex research chat service unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/vertex-worker-rpc.ts",
    text: "Worker service unavailable",
    count: 1,
    reason:
      "Known ambiguous: message of a contract error (503). It names the store or service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "contracts/vertex-worker.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex-worker.ts",
    text: "unknown",
    count: 4,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex.ts",
    text: "filled+remaining=total using exact decimals; unknown requires unknown-outcome and all other statuses forbid that error; not-submitted/rejected require zero filled; other observed known statuses require brokerOrderRef; filled requires zero remaining; partially-filled requires both positive; submitted requires zero filled. Observation only.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "granted requires expiresAt>checkedAt; expired requires nonnull expiresAt<=checkedAt; unknown and denied never prove entitlement.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "missing requires observedAt=null; fresh/stale require observedAt; age=evaluatedAt-observedAt must be nonnegative; fresh iff age<=maxAgeMs; stale iff age>maxAgeMs; unknown never proves freshness.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "model-unavailable",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex.ts",
    text: "provider-unavailable",
    count: 2,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "contracts/vertex.ts",
    text: "Receipt must preserve unknown outcomes and exact fill arithmetic",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "source IDs, content hashes, unavailable IDs and duplicate mapping source IDs are individually unique; unavailable IDs cannot be present sources; declared content hashes exactly cover sources; both sides of each non-self duplicate mapping exist and have its hash; do not merge equal-content source identities.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "sourceTimestamp<=receivedAt; unknown aggressor remains unknown.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "startAtInclusive<endAtExclusive<=captureTime; asOfAt<=captureTime; available vintage requires dataVintageId and unavailable requires null.",
    count: 1,
    reason:
      "Kept: contract rule in prose (schema documentation). The vague word names a wire value, and the sentence says what that value requires.",
  },
  {
    file: "contracts/vertex.ts",
    text: "unavailable",
    count: 5,
    reason:
      "Known ambiguous: wire values of the Vertex experience contract. The app prints some of them as they arrive: infrastructure and broker handshake (features/experience/utilities.tsx). Each needs a label that names the state and its cause.",
    open: true,
  },
  {
    file: "contracts/vertex.ts",
    text: "unknown",
    count: 12,
    reason:
      "Known ambiguous: wire values of the Vertex experience contract. The app prints some of them as they arrive: the freshness status (features/experience/portfolio.tsx, today.tsx), infrastructure, broker handshake and recovery (utilities.tsx) and the leakage check status (strategies.tsx). Each needs a label that names the state and its cause.",
    open: true,
  },
  {
    file: "contracts/vertex.ts",
    text: "unknown-outcome",
    count: 1,
    reason:
      "Wire value: an enum member, state or reason code of the contract that code compares. It is not a sentence. Where the app shows it, the app must show its own text. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "deep-value-score.ts",
    text: "?",
    count: 3,
    reason:
      "Known ambiguous: a '?' stands for a missing peer count, fiscal year or first reporting year in the score text. The text must say which value SEC data does not have.",
    open: true,
  },
  {
    file: "deep-value-score.ts",
    text: "debt-unknown",
    count: 1,
    reason:
      "Identifier of a score flag, not a sentence. Its label names the state: 'Debt not tagged in SEC data (counted as $0)'.",
  },
  {
    file: "flow-options.ts",
    text: "unknown",
    count: 2,
    reason:
      "Stored word in flow_option_prints (side, moneyness) for a print that the feed did not classify. The stored word does not change, so a rollback reads every row. The response maps it to not_classified and not_reported (server/flow-snapshot.ts).",
  },
  {
    file: "flow-trade-signing.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "market-news.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces the dot of a share class in a ticker symbol.",
  },
  {
    file: "options-engine/book.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the sign of the exponent in a formatted number.",
  },
  {
    file: "options-engine/book.ts",
    text: "Unknown options field: ${}",
    count: 1,
    reason: "Kept: input error that names its cause; the field name follows.",
  },
  {
    file: "options-engine/libm.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the minus sign of a number text that is parsed again.",
  },
  {
    file: "price-alerts.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces '.' or '/' in a ticker symbol for a Yahoo request or a ticker lookup.",
  },
  {
    file: "quant-multiple-testing.ts",
    text: "Other trials exist, but none has usable returns, so the Sharpe variance across trials is unknown.",
    count: 1,
    reason:
      "Kept: explanation in prose. It names the cause (no trial has usable returns) of the missing variance.",
  },
  {
    file: "research-report-technicals.ts",
    text: "No stored daily bars in this revision: pivots, Weinstein stage, Fibonacci levels and the volume profile are unavailable.",
    count: 1,
    reason:
      "Kept: note in prose that names the cause before or after the colon.",
  },
  {
    file: "research-report-technicals.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "research-report-technicals.ts",
    text: "Weinstein stage unavailable: the 30-week SMA or its slope is not a finite positive value inside the classified window.",
    count: 1,
    reason:
      "Kept: note in prose that names the cause before or after the colon.",
  },
  {
    file: "server/academy.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces '_' in the structure name of an idea tag.",
  },
  {
    file: "server/academy.ts",
    text: "Password step-up is not available on this server; overrides are refused",
    count: 1,
    reason:
      "Kept: error text that names its cause (the server has no password step-up) and the effect (overrides are refused).",
  },
  {
    file: "server/academy.ts",
    text: "Portfolio feed unavailable: ${}.",
    count: 1,
    reason: "Kept: the cause from the feed follows the colon.",
  },
  {
    file: "server/academy.ts",
    text: "The live NLV is unavailable; state your NLV so the paper limits can be sized (recorded in the audit)",
    count: 1,
    reason: "Kept: names the missing value and the next step (state your NLV).",
  },
  {
    file: "server/academy.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/agent-ops.ts",
    text: "unavailable",
    count: 4,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/assistant-chart-tools.ts",
    text: "Tool not available to the assistant",
    count: 1,
    reason:
      "Kept: refusal of a tool outside the assistant's list. A permission answer, not the state of a resource.",
  },
  {
    file: "server/assistant-runtime.ts",
    text: "- Certified terms first: for the owner's account (net liquidation or account value, P&L, positions, open options risk) and for certified research measures (backtest Sharpe and max drawdown, autopilot gate outcomes, paper deployment requests and the owner's approvals of them, drift levels), call terms_query with the matching term from terms_list and name the term and its source in the answer. The owner's account is the live IBKR account in the vertex-portfolio feed; the equity, positions and P&L in deployment_status belong to the paper exec node and never answer an account question. If terms_query says unknown or not_available, or no certified term covers the measure (for example buying power or Crown copy legs), say it is not available and give no number from another source or estimate.",
    count: 1,
    reason:
      "Kept: system prompt of the assistant. It tells the model what to do when a term answers unknown or not_available.",
  },
  {
    file: "server/assistant-runtime.ts",
    text: "Not available in Plan mode; ask the operator to switch to Act mode",
    count: 1,
    reason:
      "Kept: names the cause (Plan mode) and the next step (switch to Act mode).",
  },
  {
    file: "server/assistant-runtime.ts",
    text: "Procedure not available to the assistant",
    count: 1,
    reason:
      "Kept: refusal of a procedure outside the assistant's list. A permission answer, not the state of a resource.",
  },
  {
    file: "server/assistant-runtime.ts",
    text: "Tool not available to the assistant",
    count: 1,
    reason:
      "Kept: refusal of a tool outside the assistant's list. A permission answer, not the state of a resource.",
  },
  {
    file: "server/assistant-runtime.ts",
    text: "unknown_tool",
    count: 1,
    reason:
      "Not a status: the tool name written to a trace when the name the model sent is not a valid tool name.",
  },
  {
    file: "server/assistant.ts",
    text: "Assistant action storage unavailable. Apply migration 0029 if the table is missing.",
    count: 1,
    reason:
      "Kept: names the cause (the store did not answer or its tables are missing) and the next step (the migration to apply).",
  },
  {
    file: "server/assistant.ts",
    text: "Assistant storage unavailable. Apply migration 0022 if the tables are missing.",
    count: 1,
    reason:
      "Kept: names the cause (the store did not answer or its tables are missing) and the next step (the migration to apply).",
  },
  {
    file: "server/contact-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/deploy-status.ts",
    text: "Tailnet snapshot unavailable:",
    count: 1,
    reason: "Kept: prefix of snapshotError; the cause follows the colon.",
  },
  {
    file: "server/deployment-requests.ts",
    text: "Deployment request storage unavailable. Apply migration 0021 if the table is missing, and 0069 for the options column.",
    count: 1,
    reason:
      "Kept: names the cause (the store did not answer or its tables are missing) and the next step (the migration to apply).",
  },
  {
    file: "server/flow-collect.ts",
    text: "market closed; gaps unavailable: ${}",
    count: 1,
    reason:
      "Kept: collector note. It names the state (market closed) and the storage error follows the colon.",
  },
  {
    file: "server/flow-collect.ts",
    text: "unavailable",
    count: 6,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/flow-collect.ts",
    text: "unknown",
    count: 1,
    reason:
      "Stored word of a GEX row without IV term data. The stored word does not change; the response maps it to no_term_data (server/flow-snapshot.ts).",
  },
  {
    file: "server/flow-control.ts",
    text: "source_unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/flow-market-premium-collect.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/gex-context.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the minus sign before a formatted value.",
  },
  {
    file: "server/golive-drafts-sizing.ts",
    text: "nlv_unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/golive-drafts-sizing.ts",
    text: "NLV_UNAVAILABLE",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/golive-drafts.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/golive-drafts.ts",
    text: "unknown",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/golive-send-caps.ts",
    text: "NLV_UNAVAILABLE",
    count: 2,
    reason:
      "Refusal code of the go-live send gate, not a sentence. server/golive-send-gate.ts writes it in front of its cause ('GO-LIVE <CODE>: <cause>').",
  },
  {
    file: "server/golive-send-caps.ts",
    text: "WORKING_ORDER_RISK_UNKNOWN",
    count: 2,
    reason:
      "Refusal code of the go-live send gate, not a sentence. server/golive-send-gate.ts writes it in front of its cause ('GO-LIVE <CODE>: <cause>').",
  },
  {
    file: "server/golive-send-gate.ts",
    text: "approved, engine unknown (${}; checked ${}); send refused until the node reads running-armed",
    count: 1,
    reason:
      "Kept: names the cause, the time of the check and the condition for the next send.",
  },
  {
    file: "server/ibkr-monitor.ts",
    text: "UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/ibkr-recovery.ts",
    text: "Audit log unavailable; the request was not sent",
    count: 1,
    reason:
      "Kept: names what failed (the audit log) and the effect (the request was not sent), so the reader knows that the action did not run. The cause of the audit failure is not named.",
  },
  {
    file: "server/ibkr-recovery.ts",
    text: "AUDIT_UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/ibkr-recovery.ts",
    text: "UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/ibkr-recovery.ts",
    text: "unknown",
    count: 1,
    reason:
      "Not a status: the actor id sent to the VPS when the user id is empty. An audit field, never the state of a resource.",
  },
  {
    file: "server/loopback-status.ts",
    text: "UNAVAILABLE",
    count: 2,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/market-data.ts",
    text: "IBKR history service unavailable",
    count: 1,
    reason:
      "Known ambiguous: error text of the IBKR history source. It names the service, but not the cause or the next step.",
    open: true,
  },
  {
    file: "server/market-data.ts",
    text: "UNAVAILABLE",
    count: 4,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/market-news.ts",
    text: "UNAVAILABLE",
    count: 4,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/market-notes.ts",
    text: "Unknown claim id ${}",
    count: 1,
    reason: "Kept: input error that names its cause; the claim id follows.",
  },
  {
    file: "server/mcp.ts",
    text: "Answer one certified term: { term, params }. Returns status (ok, unknown or not_available), answer, rows, the SQL or feed path that produced them (query), source, unit and asOf. Account terms (net_liquidation, pnl, position, open_risk) read the owner's live IBKR account (vertex-portfolio feed), never the paper exec node. status unknown or not_available means: give no value. A term with several groupings (backtest_sharpe and backtest_max_drawdown: per strategy, and per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy) runs each certified grouping; every row has a grain cell, and groupings says which ran and which wait for certification. Say which grouping each row uses. Their strategy parameter also matches the symbol of a run with no strategy (for example IWM).",
    count: 1,
    reason:
      "Kept: MCP tool description for the model. It says what the wire statuses unknown, not_available and unavailable mean and what to do with them.",
  },
  {
    file: "server/mcp.ts",
    text: "Congress trades are not available: the response was not a congress trade feed.",
    count: 1,
    reason:
      "Kept: names the cause after the colon (the upstream response had the wrong shape).",
  },
  {
    file: "server/mcp.ts",
    text: "Insider clusters are not available: the response was not an insider cluster list.",
    count: 1,
    reason:
      "Kept: names the cause after the colon (the upstream response had the wrong shape).",
  },
  {
    file: "server/mcp.ts",
    text: "Owner market notes are not available: the response was not a notes list.",
    count: 1,
    reason:
      "Kept: names the cause after the colon (the upstream response had the wrong shape).",
  },
  {
    file: "server/mcp.ts",
    text: "Read-only QuantVPS trading-stack status: container services, plus session, positions, orders, fills, equity, risk (kill switch, limits, watchdog) and WARNING/ERROR logs when the tailnet snapshot is configured. Unavailable blocks carry a reason; snapshotError explains a v1 fallback. Its equity, positions and P&L belong to the exec-node account named in session.trading_mode (paper), not to the owner's IBKR account: for net liquidation, account P&L, positions or open risk use terms_query.",
    count: 1,
    reason:
      "Kept: MCP tool description for the model. It says what the wire statuses unknown, not_available and unavailable mean and what to do with them.",
  },
  {
    file: "server/mcp.ts",
    text: "The smart money ranking is not available: the response was not a ranking.",
    count: 1,
    reason:
      "Kept: names the cause after the colon (the upstream response had the wrong shape).",
  },
  {
    file: "server/mcp.ts",
    text: "Tool ${} needs a confirm card in the Vertex assistant; it is not available on the MCP endpoint",
    count: 1,
    reason:
      "Kept: refusal that names its cause (the tool needs a confirm card) and where the tool works.",
  },
  {
    file: "server/mcp.ts",
    text: "Unknown tool: ${}",
    count: 1,
    reason: "Kept: input error that names its cause; the tool name follows.",
  },
  {
    file: "server/nautilus-arm.ts",
    text: "Audit log unavailable; nothing was changed",
    count: 3,
    reason:
      "Kept: names what failed (the audit log) and the effect (nothing was changed), so the reader knows that the action did not run. The cause of the audit failure is not named.",
  },
  {
    file: "server/nautilus-arm.ts",
    text: "AUDIT_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/nautilus-arm.ts",
    text: "Password step-up is not available on this server; arming is refused",
    count: 1,
    reason:
      "Kept: error text that names its cause (the server has no password step-up) and the effect (arming is refused).",
  },
  {
    file: "server/nautilus-arm.ts",
    text: "UNAVAILABLE",
    count: 5,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/nautilus-arm.ts",
    text: "unknown",
    count: 2,
    reason:
      "Two uses. The actor id sent to the VPS when the user id is empty (an audit field). The wire value of the node badge (contracts/nautilus-arm.ts): the app names its cause from armError and container.",
  },
  {
    file: "server/optimizations.ts",
    text: "Optimization storage unavailable. Apply migration 0020 if the table is missing.",
    count: 1,
    reason:
      "Kept: names the cause (the store did not answer or its tables are missing) and the next step (the migration to apply).",
  },
  {
    file: "server/options-analytics.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/options-chain-ibkr.ts",
    text: "UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/options-chain-quantdata.ts",
    text: "UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/options-chain-yahoo.ts",
    text: "UNAVAILABLE",
    count: 4,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/pick-lists.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces '.' or '/' in a ticker symbol for a Yahoo request or a ticker lookup.",
  },
  {
    file: "server/portfolio-monitor.ts",
    text: "UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/research-lenses.ts",
    text: "-",
    count: 2,
    reason:
      "Not a status: the character that replaces '.' or '/' in a ticker symbol for a Yahoo request or a ticker lookup.",
  },
  {
    file: "server/research-lenses.ts",
    text: "UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/research-screen.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/router.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 2,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/sector-rotation.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces '.' or '/' in a ticker symbol for a Yahoo request or a ticker lookup.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "; percent of NLV unknown (no NLV)",
    count: 1,
    reason:
      "Kept: part of a certified term answer; the cause is in the brackets (no NLV).",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "Open risk is unknown: these option legs have no defined maximum loss under the certified definition: ${}.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The feed data is ${} minutes old (as of ${}); live account values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The feed data time ${} is in the future; values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The feed data time ${} is not a valid time; values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The feed has no data time; values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The feed reports a ${} account, not the live account; live account values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "The IB gateway is ${}${}; live account values are unknown.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-feed-terms.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "No certified term is named ${}. Call terms_list for the catalog; if no term covers the measure, it is not available.",
    count: 1,
    reason:
      "Kept: answer for the assistant. It names the cause (no term of that name) and the next step (terms_list).",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Not available: no feed reader is built for this term.",
    count: 1,
    reason:
      "Kept: answer of a certified term with status not_available; it names the cause (no feed reader).",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Not available. ${}",
    count: 1,
    reason:
      "Kept: answer of a certified term with status not_available; the reason follows.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "not_available",
    count: 4,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "unknown",
    count: 4,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Unknown parameter ${}. This term takes ${}.",
    count: 1,
    reason:
      "Kept: input error that names the parameter and lists the accepted ones.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Unknown: ${}",
    count: 2,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Unknown: the vertex-portfolio feed is unavailable (${}). No value is given; the paper exec node is not a substitute.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/semantic-terms.ts",
    text: "Unknown${}: ${} No value is given.",
    count: 1,
    reason:
      "Kept: answer of a certified term. 'Unknown' is the named status of the term, and the sentence gives its cause.",
  },
  {
    file: "server/strategy-library.ts",
    text: "Strategy library storage unavailable: its tables or columns are missing, or a stored value is invalid. Apply the pending strategy-library migrations (0019, 0065).",
    count: 1,
    reason:
      "Kept: names the cause (the store did not answer or its tables are missing) and the next step (the migration to apply).",
  },
  {
    file: "server/strategy-series.ts",
    text: "Series data is not available for ${} of ${}",
    count: 1,
    reason:
      "Kept: input error of a backtest. It names the cause: the run symbol does not have the series that the definition reads.",
  },
  {
    file: "server/strategy-series.ts",
    text: "The daily series store is not available on this server (needed for ${})",
    count: 1,
    reason:
      "Kept: names the cause (this server has no daily series store) and what needs it.",
  },
  {
    file: "server/unsupported.ts",
    text: "@darkfactory/api/server is unavailable in browser bundles",
    count: 1,
    reason:
      "Kept: build error for a developer. It names the cause (a server module in a browser bundle).",
  },
  {
    file: "server/vertex-chart-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-chart-service.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-dispatch/dispatcher.ts",
    text: "notification-unknown",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-dispatch/dispatcher.ts",
    text: "unavailable",
    count: 14,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-dispatch/dispatcher.ts",
    text: "unknown",
    count: 6,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-experience-adapter.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 4,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-experience-adapter.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-experience-commands.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 9,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-experience-core.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 8,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-experience-core.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-experience-reads.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the base64url character that replaces '+'.",
  },
  {
    file: "server/vertex-experience-reads.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 9,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-experience-reads.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-local-setup.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-notification-read-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-orders-confirm.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the base64url character that replaces '+'.",
  },
  {
    file: "server/vertex-orders.ts",
    text: "GO-LIVE STORE_UNAVAILABLE: the go-live draft store is not configured",
    count: 1,
    reason:
      "Kept: refusal of an order check. The code is followed by its cause (the go-live draft store is not configured).",
  },
  {
    file: "server/vertex-orders.ts",
    text: "GO-LIVE STORE_UNAVAILABLE: the go-live drafts could not be read",
    count: 1,
    reason:
      "Kept: refusal of an order check. The code is followed by its cause (the go-live drafts could not be read).",
  },
  {
    file: "server/vertex-orders.ts",
    text: "intent store unavailable",
    count: 2,
    reason:
      "Kept: detail of an audit record, not the text the user reads (that is intentWriteFailed). It names the cause: the order intent could not be written, so no order was sent.",
  },
  {
    file: "server/vertex-orders.ts",
    text: "outcome unknown: ${}",
    count: 2,
    reason:
      "Kept: detail of an audit record. 'unknown' is the named outcome of an order that may have reached IBKR (reconciliation checks it); the gateway error follows.",
  },
  {
    file: "server/vertex-orders.ts",
    text: "unknown",
    count: 4,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-conversation-runtime.ts",
    text: "model-input-preparation-unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-conversation-runtime.ts",
    text: "outcome-unknown",
    count: 5,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-conversation-runtime.ts",
    text: "projection-unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-conversation-runtime.ts",
    text: "unavailable",
    count: 10,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-conversation-runtime.ts",
    text: "unknown",
    count: 5,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-copy-cleanup-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-research-chat-execution-runtime.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat-output-runtime.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat.ts",
    text: "-",
    count: 2,
    reason: "Not a status: the base64url character that replaces '+'.",
  },
  {
    file: "server/vertex-research-chat.ts",
    text: "research-chat-agent-admission-unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat.ts",
    text: "research-runtime-unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-research-chat.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-research-chat.ts",
    text: "unavailable",
    count: 10,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-config-notifications.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-approval.ts",
    text: "unavailable",
    count: 12,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-bytes.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-evidence.ts",
    text: "unknown",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-execution.ts",
    text: "unknown",
    count: 5,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-execution.ts",
    text: "unknown-outcome",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-historical.ts",
    text: "unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-replay.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the minus sign of a decimal text.",
  },
  {
    file: "server/vertex-runtime-epoch-replay.ts",
    text: "unknown",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch-snapshot.ts",
    text: "unknown",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-epoch.ts",
    text: "unavailable",
    count: 5,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-gateway.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-model-evidence.ts",
    text: "Current model-use evidence unavailable",
    count: 2,
    reason:
      "Known ambiguous: text of a thrown Error. It names the fact that could not be read, but not the cause (store answer, cancelled request or missing grant).",
    open: true,
  },
  {
    file: "server/vertex-runtime-model-evidence.ts",
    text: "Current model-use read grant unavailable",
    count: 1,
    reason:
      "Known ambiguous: text of a thrown Error. It names the fact that could not be read, but not the cause (store answer, cancelled request or missing grant).",
    open: true,
  },
  {
    file: "server/vertex-runtime-model-use.ts",
    text: "Current model-use context unavailable",
    count: 1,
    reason:
      "Known ambiguous: text of a thrown Error. It names the fact that could not be read, but not the cause (store answer, cancelled request or missing grant).",
    open: true,
  },
  {
    file: "server/vertex-runtime-model-use.ts",
    text: "current-context-unavailable",
    count: 2,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-native.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-objects.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-policy-artifacts.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-recipe-build.ts",
    text: "unavailable",
    count: 13,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-recipes.ts",
    text: "unavailable",
    count: 7,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime-replay.ts",
    text: "unavailable",
    count: 3,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-runtime.ts",
    text: "unavailable",
    count: 1,
    reason:
      "Wire or stored value: a state or reason code that code compares. It is not a sentence. Recorded as it was on 2026-11-22: a rename is a contract change of its own.",
  },
  {
    file: "server/vertex-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-worker-auth.ts",
    text: "-",
    count: 1,
    reason: "Not a status: the base64url character that replaces '+'.",
  },
  {
    file: "server/vertex-worker-auth.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 3,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "server/vertex-worker-service.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 1,
    reason:
      "Error or reason code, not a sentence. Code compares it and maps it to a typed contract error. The message of that error is a text of its own, with its own entry when it is vague.",
  },
  {
    file: "signal-alerts.ts",
    text: "-",
    count: 1,
    reason:
      "Not a status: the character that replaces '.' or '/' in a ticker symbol for a Yahoo request or a ticker lookup.",
  },
  {
    file: "strategy-dsl.ts",
    text: "frame monthly bars have high = low = close and no volume: atr, adx and rvol are not available",
    count: 1,
    reason:
      "Kept: note in prose that names the cause before or after the colon.",
  },
  {
    file: "strategy-dsl.ts",
    text: "frame monthly bars have high = low = close and no volume: supertrend, chandelierExit and alphaTrend are not available",
    count: 1,
    reason:
      "Kept: note in prose that names the cause before or after the colon.",
  },
  {
    file: "strategy-dsl.ts",
    text: "Unknown sector. Use a Select Sector SPDR symbol, for example XLK",
    count: 1,
    reason: "Kept: input error that names its cause and the next step.",
  },
];
