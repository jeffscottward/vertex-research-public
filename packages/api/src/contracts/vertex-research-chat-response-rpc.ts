import { oc } from "@orpc/contract";
import { z } from "zod";
import { VertexResearchChatErrors } from "./vertex-research-chat.ts";
import {
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatRequestResponseOutputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseOutputSchema,
  type VertexResearchChatRequestResponseInput,
  type VertexResearchChatReadResponseInput,
} from "./vertex-research-chat-response.ts";
import {
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
  type VertexResearchChatPrepareResponseInput,
  type VertexResearchChatApproveAndRequestResponseInput,
  type VertexResearchChatAppendResponseInput,
  type VertexResearchChatReadResponseContentInput,
} from "./vertex-research-chat-conversation.ts";
import {
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatReadDebateRunInputSchema,
  VertexResearchChatReadDebateRunOutputSchema,
  type VertexResearchChatDebateStepInput,
  type VertexResearchChatDebateApproveInput,
  type VertexResearchChatReadDebateRunInput,
} from "./vertex-research-chat-debate.ts";
import { VertexResearchChatDebatePrepareOutputSchema } from "./vertex-research-chat-conversation.ts";
import { VertexResearchChatNativeEvidencePrepareOutputSchema } from "./vertex-research-chat-conversation.ts";
import {
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
  type VertexResearchChatNativeEvidenceRequest,
  type VertexResearchChatNativeEvidenceApproveInput,
} from "./vertex-research-chat-native-evidence.ts";
import {
  ReadModelPrivacyReviewRequestInputSchema,
  ReadModelPrivacyReviewRequestOutputSchema,
  RecordModelPrivacyReviewInputSchema,
  RecordModelPrivacyReviewOutputSchema,
} from "./vertex-model-privacy-rendezvous.ts";
import {
  ReadNativeModelPrivacyReviewRequestInputSchema,
  ReadNativeModelPrivacyReviewRequestOutputSchema,
  RecordNativeModelPrivacyReviewInputSchema,
} from "./vertex-model-privacy-rendezvous.ts";

// Keep composition outside the human contract: response DTOs reuse its scalar
// rules, so importing these operations there would create an initialization cycle.
// The exact canonical preflight, refinements and deep-freeze schemas run in RPC.
// The accepted DTO's unknown-input canonical preflight must still run before any
// property inspection. These typed identity stages return the untouched value as
// unknown without inspecting, normalizing, validating or granting anything.
// The exact accepted parser remains .out and is the sole runtime input boundary;
// the explicit input generic gives oRPC clients the required wire input type.
export const VertexResearchChatRequestResponseRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatRequestResponseInput
>((value) => value, VertexResearchChatRequestResponseInputSchema);
export const VertexResearchChatReadResponseRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseInput
>((value) => value, VertexResearchChatReadResponseInputSchema);
export const VertexResearchChatPrepareResponseRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseInput
>((value) => value, VertexResearchChatPrepareResponseInputSchema);
export const VertexResearchChatApproveAndRequestResponseRpcInputSchema =
  z.preprocess<
    unknown,
    typeof VertexResearchChatApproveAndRequestResponseInputSchema,
    VertexResearchChatApproveAndRequestResponseInput
  >((value) => value, VertexResearchChatApproveAndRequestResponseInputSchema);
export const VertexResearchChatAppendResponseRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseInput
>((value) => value, VertexResearchChatAppendResponseInputSchema);
export const VertexResearchChatReadResponseContentRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentInput
>((value) => value, VertexResearchChatReadResponseContentInputSchema);
export const VertexResearchChatDebateStepRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatDebateStepInputSchema,
  VertexResearchChatDebateStepInput
>((value) => value, VertexResearchChatDebateStepInputSchema);
export const VertexResearchChatDebateApproveRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatDebateApproveInputSchema,
  VertexResearchChatDebateApproveInput
>((value) => value, VertexResearchChatDebateApproveInputSchema);
export const VertexResearchChatReadDebateRunRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatReadDebateRunInputSchema,
  VertexResearchChatReadDebateRunInput
>((value) => value, VertexResearchChatReadDebateRunInputSchema);
export const VertexResearchChatNativeEvidenceRequestRpcInputSchema =
  z.preprocess<
    unknown,
    typeof VertexResearchChatNativeEvidenceRequestSchema,
    VertexResearchChatNativeEvidenceRequest
  >((value) => value, VertexResearchChatNativeEvidenceRequestSchema);
export const VertexResearchChatNativeEvidenceApproveRpcInputSchema =
  z.preprocess<
    unknown,
    typeof VertexResearchChatNativeEvidenceApproveInputSchema,
    VertexResearchChatNativeEvidenceApproveInput
  >((value) => value, VertexResearchChatNativeEvidenceApproveInputSchema);
const vertex = oc.errors(VertexResearchChatErrors);
export const vertexResearchChatResponseContract = {
  readNativeModelPrivacyReviewRequest: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/native-evidence/model-privacy/read",
      operationId: "vertex.researchChat.readNativeModelPrivacyReviewRequest",
      tags: ["Vertex"],
      description:
        "Independent reviewer lookup of one exact native phase/operation candidate under current request-specific authority.",
    })
    .input(ReadNativeModelPrivacyReviewRequestInputSchema)
    .output(ReadNativeModelPrivacyReviewRequestOutputSchema),
  recordNativeModelPrivacyReview: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/native-evidence/model-privacy/record",
      operationId: "vertex.researchChat.recordNativeModelPrivacyReview",
      tags: ["Vertex"],
      description:
        "Record independent exact phase-addressed privacy review. Parent consent and phase-one review never authorize phase-two bytes.",
    })
    .input(RecordNativeModelPrivacyReviewInputSchema)
    .output(RecordModelPrivacyReviewOutputSchema),
  prepareNativeEvidence: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/native-evidence/prepare",
      operationId: "vertex.researchChat.prepareNativeEvidence",
      tags: ["Vertex"],
      description:
        "Prepare explicit bounded First Mate native evidence protocol consent, without governed copies, admission or model dispatch.",
    })
    .input(VertexResearchChatNativeEvidenceRequestRpcInputSchema)
    .output(VertexResearchChatNativeEvidencePrepareOutputSchema),
  approveAndRequestNativeEvidence: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/native-evidence/approve-and-request",
      operationId: "vertex.researchChat.approveAndRequestNativeEvidence",
      tags: ["Vertex"],
      description:
        "Explicit human approval of the exact bounded two-phase protocol, corpus, derivation and aggregate ceilings. Separate exact privacy decisions and model grants remain required.",
    })
    .input(VertexResearchChatNativeEvidenceApproveRpcInputSchema)
    .output(VertexResearchChatApproveAndRequestResponseOutputSchema),
  readModelPrivacyReviewRequest: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/model-privacy/read",
      operationId: "vertex.researchChat.readModelPrivacyReviewRequest",
      tags: ["Vertex"],
      description:
        "Configured independent reviewer exact original response/operation lookup. Current account, policy and request grants required. Private no-store metadata only; no inbox enumeration.",
    })
    .input(ReadModelPrivacyReviewRequestInputSchema)
    .output(ReadModelPrivacyReviewRequestOutputSchema),
  recordModelPrivacyReview: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/model-privacy/record",
      operationId: "vertex.researchChat.recordModelPrivacyReview",
      tags: ["Vertex"],
      description:
        "Authenticated independent reviewer exact immutable candidate decision through existing review CAS. Does not dispatch, grant permissions or reserve model budget.",
    })
    .input(RecordModelPrivacyReviewInputSchema)
    .output(RecordModelPrivacyReviewOutputSchema),
  prepareDebateStep: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/debate/prepare",
      operationId: "vertex.researchChat.prepareDebateStep",
      tags: ["Vertex"],
      description:
        "Prepare one exact selected debate step from already published predecessors. Does not approve future output, issue authority or dispatch.",
    })
    .input(VertexResearchChatDebateStepRpcInputSchema)
    .output(VertexResearchChatDebatePrepareOutputSchema),
  approveAndRequestDebateStep: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/debate/approve-and-request",
      operationId: "vertex.researchChat.approveAndRequestDebateStep",
      tags: ["Vertex"],
      description:
        "Approve only this displayed exact debate plan/request after separate source-use and operation privacy review. Unknown ACK requires original-key inspection.",
    })
    .input(VertexResearchChatDebateApproveRpcInputSchema)
    .output(VertexResearchChatApproveAndRequestResponseOutputSchema),
  readDebateRun: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/debate",
      operationId: "vertex.researchChat.readDebateRun",
      tags: ["Vertex"],
      description:
        "Read current metadata and exact published predecessor pins. Contains no answer prose and grants no approval or automatic next-step execution.",
    })
    .input(VertexResearchChatReadDebateRunRpcInputSchema)
    .output(VertexResearchChatReadDebateRunOutputSchema),
  requestResponse: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads/{threadId}/responses",
      operationId: "vertex.researchChat.requestResponse",
      tags: ["Vertex"],
      description:
        "Persist or reconcile the exact original response request. This integration records runtime unavailability, not model execution or a queued job.",
    })
    .input(VertexResearchChatRequestResponseRpcInputSchema)
    .output(VertexResearchChatRequestResponseOutputSchema),
  readResponse: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads/{threadId}/responses",
      operationId: "vertex.researchChat.readResponse",
      tags: ["Vertex"],
      description:
        "Read the original scoped idempotency key under current access. NOT_FOUND means absence at read time only, not permission for a new key or recomputation; a request may still commit after this read.",
    })
    .input(VertexResearchChatReadResponseRpcInputSchema)
    .output(VertexResearchChatReadResponseOutputSchema),
  prepareResponse: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads/{threadId}/responses/prepare",
      operationId: "vertex.researchChat.prepareResponse",
      tags: ["Vertex"],
      description:
        "Prepare exact original consent metadata without approval, admission or model execution. Private no-store projection; metadata never grants authority.",
    })
    .input(VertexResearchChatPrepareResponseRpcInputSchema)
    .output(VertexResearchChatPrepareResponseOutputSchema),
  approveAndRequestResponse: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/responses/approve-and-request",
      operationId: "vertex.researchChat.approveAndRequestResponse",
      tags: ["Vertex"],
      description:
        "Deliberately approve the displayed exact plan/request and invoke original admission. Blocked does not prove absence; unknown requires same-key inspection, not retry.",
    })
    .input(VertexResearchChatApproveAndRequestResponseRpcInputSchema)
    .output(VertexResearchChatApproveAndRequestResponseOutputSchema),
  appendResponse: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads/{threadId}/responses/{responseRequestId}/append",
      operationId: "vertex.researchChat.appendResponse",
      tags: ["Vertex"],
      description:
        "Publish-authorized idempotent bodyless reference append under current source eligibility and thread CAS. Stale CAS is CONFLICT, never permission for new model work.",
    })
    .input(VertexResearchChatAppendResponseRpcInputSchema)
    .output(VertexResearchChatAppendResponseOutputSchema),
  readResponseContent: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads/{threadId}/responses/{responseRequestId}/content",
      operationId: "vertex.researchChat.readResponseContent",
      tags: ["Vertex"],
      description:
        "Read exact current owner-only governed content for an appended reference. Ephemeral private no-store data; missing reference and denied caller are RPC errors.",
    })
    .input(VertexResearchChatReadResponseContentRpcInputSchema)
    .output(VertexResearchChatReadResponseContentOutputSchema),
};
