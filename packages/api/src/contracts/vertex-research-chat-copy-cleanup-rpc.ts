import { oc } from "@orpc/contract";
import { z } from "zod";
import { VertexResearchChatErrors } from "./vertex-research-chat.ts";
import {
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatRequestCopyCleanupOutputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupOutputSchema,
  type VertexResearchChatRequestCopyCleanupInput,
  type VertexResearchChatReadCopyCleanupInput,
} from "./vertex-research-chat-copy-cleanup.ts";

// Identity-only typed wire stages preserve the canonical preflight before any
// property inspection. These schemas convey no session or cleanup authority.
export const VertexResearchChatRequestCopyCleanupRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatRequestCopyCleanupInput
>((value) => value, VertexResearchChatRequestCopyCleanupInputSchema);
export const VertexResearchChatReadCopyCleanupRpcInputSchema = z.preprocess<
  unknown,
  typeof VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInput
>((value) => value, VertexResearchChatReadCopyCleanupInputSchema);
const vertex = oc.errors(VertexResearchChatErrors);
export const vertexResearchChatCopyCleanupContract = {
  requestCopyCleanup: vertex
    .route({
      method: "POST",
      path: "/vertex/research-chat/threads/{threadId}/copy-cleanup",
      operationId: "vertex.researchChat.requestCopyCleanup",
      tags: ["Vertex"],
      description:
        "Record or reconcile the original account cleanup intent for every copied kind in one existing response family. Requested is not physical cleanup or execution permission.",
    })
    .input(VertexResearchChatRequestCopyCleanupRpcInputSchema)
    .output(VertexResearchChatRequestCopyCleanupOutputSchema),
  readCopyCleanup: vertex
    .route({
      method: "GET",
      path: "/vertex/research-chat/threads/{threadId}/copy-cleanup",
      operationId: "vertex.researchChat.readCopyCleanup",
      tags: ["Vertex"],
      description:
        "Read the immutable original cleanup acknowledgement by its original key. NOT_FOUND is absence at read time, not permission for a new key or evidence that cleanup completed.",
    })
    .input(VertexResearchChatReadCopyCleanupRpcInputSchema)
    .output(VertexResearchChatReadCopyCleanupOutputSchema),
};
