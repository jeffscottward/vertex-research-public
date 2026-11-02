import type { Database } from "./client.ts";
import { createCommandOperations } from "./vertex-command-store.ts";
import { createNativeFactOperations } from "./vertex-native-fact-store.ts";
import { createOutboxOperations } from "./vertex-outbox-store.ts";
import {
  createPersistenceContext,
  fail,
  type VertexStoreOptions,
} from "./vertex-persistence-core.ts";
import type { VertexStore } from "./vertex-ports.ts";
import { createProjectionOperations } from "./vertex-projection-store.ts";
import { createQueryOperations } from "./vertex-query-store.ts";
import { createResearchChatOperations } from "./vertex-research-chat-store.ts";
import { createResearchOperations } from "./vertex-research-store.ts";
import { createReviewOperations } from "./vertex-review-store.ts";

// Pure construction: no connection, clock, provider, environment or credentials
// are discovered at import or construction time. Every operation is explicit.
export const createVertexStore = (
  db: Database,
  options: VertexStoreOptions
): VertexStore => {
  const ctx = createPersistenceContext(db, options);
  const research = createResearchOperations(ctx);
  const outbox = createOutboxOperations(ctx);
  const projection = createProjectionOperations(ctx);
  const review = createReviewOperations(ctx, projection.currentPortfolio);
  const queries = createQueryOperations(ctx);
  const commands = createCommandOperations(ctx);
  const nativeFacts = createNativeFactOperations(ctx);
  const researchChat = createResearchChatOperations(ctx);
  const operations: VertexStore = {
    putRights: research.putRights,
    getRights: research.getRights,
    registerArtifact: research.registerArtifact,
    findArtifact: research.findArtifact,
    publishCollectionSnapshot: (input) =>
      research.publication(input, outbox.enqueue),
    getActiveCollectionSnapshot: research.getActiveCollectionSnapshot,
    recordImmutable: research.recordImmutable,
    findDataset: research.findDataset,
    findEvidence: research.findEvidence,
    findModuleCatalog: research.findModuleCatalog,
    recordReview: review.recordReview,
    listReviews: review.listReviews,
    admitPaperSimulation: review.admitPaperSimulation,
    appendExecutionProjection: projection.appendExecutionProjection,
    recordPortfolioSnapshot: projection.recordPortfolioSnapshot,
    getPortfolioSnapshot: projection.getPortfolioSnapshot,
    getContinuity: projection.getContinuity,
    enqueueEvent: outbox.enqueueEvent,
    claimOutbox: outbox.claimOutbox,
    settleOutbox: outbox.settleOutbox,
    listArtifacts: queries.listArtifacts,
    findRecordArtifact: queries.findRecordArtifact,
    getAcceptedEvidence: queries.getAcceptedEvidence,
    listScopeReviews: queries.listScopeReviews,
    listPaperAdmissions: queries.listPaperAdmissions,
    listExecutionProjections: queries.listExecutionProjections,
    getCommandReceipt: commands.getCommandReceipt,
    recordReviewedEvidence: commands.recordReviewedEvidence,
    enqueueResearchProposal: commands.enqueueResearchProposal,
    queuePaperSimulation: commands.queuePaperSimulation,
    appendNativeFactProjection: nativeFacts.appendNativeFactProjection,
    listResearchChatThreads: researchChat.listResearchChatThreads,
    createResearchChatThread: researchChat.createResearchChatThread,
    readResearchChatThread: researchChat.readResearchChatThread,
    listResearchChatMessages: researchChat.listResearchChatMessages,
    readResearchChatTranscriptPage: researchChat.readResearchChatTranscriptPage,
    sendResearchChatMessage: researchChat.sendResearchChatMessage,
    requestResearchChatResponse: researchChat.requestResearchChatResponse,
    readResearchChatResponse: researchChat.readResearchChatResponse,
    reserveResearchChatCopy: researchChat.reserveResearchChatCopy,
    bindResearchChatCopyContent: researchChat.bindResearchChatCopyContent,
    closeResearchChatCopyFamily: researchChat.closeResearchChatCopyFamily,
    readResearchChatCopyInventory: researchChat.readResearchChatCopyInventory,
    requestResearchChatCopyCleanup: researchChat.requestResearchChatCopyCleanup,
    readResearchChatCopyCleanup: researchChat.readResearchChatCopyCleanup,
  };
  // Capture the entire request before the first await, including scope and
  // principal, so caller mutation cannot alter the SQL/authorization binding.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(operations).map(([name, operation]) => [
        name,
        async (...args: unknown[]) => {
          if (name === "appendNativeFactProjection") {
            // Raw proof bytes are not JSON. Snapshot the exact bounded typed-array
            // slice without calling a caller-provided iterator or species constructor.
            const value = args[3];
            let proof: Uint8Array;
            try {
              if (
                args.length !== 4 ||
                !(value instanceof Uint8Array) ||
                Object.getPrototypeOf(value) !== Uint8Array.prototype ||
                Object.hasOwn(value, "buffer") ||
                Object.hasOwn(value, "byteLength") ||
                Object.hasOwn(value, "length") ||
                Object.hasOwn(value, "byteOffset")
              )
                return fail("invalid");
              if (
                !(value.buffer instanceof ArrayBuffer) ||
                value.byteLength === 0 ||
                value.byteLength > 1_048_576
              )
                return fail("invalid");
              proof = new Uint8Array(value.byteLength);
              Uint8Array.prototype.set.call(proof, value);
            } catch {
              return fail("invalid");
            }
            return await Reflect.apply(operation, undefined, [
              ...ctx.capture(args.slice(0, 3)),
              proof,
            ]);
          }
          return await Reflect.apply(operation, undefined, ctx.capture(args));
        },
      ])
    )
  ) as VertexStore;
};
