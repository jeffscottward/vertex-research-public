import { type OpenAPI, OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import type { z } from "zod";
import { appContract } from "./contract.ts";
import { StrategyExprSchema } from "./strategy-dsl.ts";
import {
  DatasetManifestSchema,
  ResearchEvidenceSchema,
} from "./contracts/vertex.ts";
import { VERTEX_EXPERIENCE_READONLY_OUTPUTS } from "./contracts/vertex-experience.ts";
import {
  ReadModelPrivacyReviewRequestOutputSchema,
  RecordModelPrivacyReviewOutputSchema,
} from "./contracts/vertex-model-privacy-rendezvous.ts";
import { VertexModulesListOutputSchema } from "./contracts/vertex-read.ts";
import { VertexResearchChatReadonlyOutputs } from "./contracts/vertex-research-chat.ts";
import {
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseInputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatPrepareResponseInputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatReadResponseContentInputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
} from "./contracts/vertex-research-chat-conversation.ts";
import {
  VertexResearchChatCopyCleanupReceiptSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatRequestCopyCleanupInputSchema,
} from "./contracts/vertex-research-chat-copy-cleanup.ts";
import {
  VertexResearchChatReadCopyCleanupRpcInputSchema,
  VertexResearchChatRequestCopyCleanupRpcInputSchema,
} from "./contracts/vertex-research-chat-copy-cleanup-rpc.ts";
import {
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseOutputSchema,
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatResponseReceiptSchema,
} from "./contracts/vertex-research-chat-response.ts";
import {
  VertexResearchChatAppendResponseRpcInputSchema,
  VertexResearchChatApproveAndRequestResponseRpcInputSchema,
  VertexResearchChatPrepareResponseRpcInputSchema,
  VertexResearchChatReadResponseContentRpcInputSchema,
  VertexResearchChatReadResponseRpcInputSchema,
  VertexResearchChatRequestResponseRpcInputSchema,
} from "./contracts/vertex-research-chat-response-rpc.ts";
import { VERTEX_WORKER_READONLY_OUTPUTS } from "./contracts/vertex-worker-rpc.ts";

// Documentation only, exact identities only. These pipes begin with canonical
// preflight and end with freeze transforms; converting those stages would lose
// required fields. RPC continues to use the complete accepted schemas unchanged.
// This is structural documentation, not an encoding of BigInt range checks or
// cross-record refinements. Only the authoritative runtime schemas prove those.
const responseDocumentationSchemas = new Map<unknown, z.ZodType>([
  [
    VertexResearchChatRequestResponseRpcInputSchema,
    VertexResearchChatRequestResponseInputSchema.out,
  ],
  [
    VertexResearchChatReadResponseRpcInputSchema,
    VertexResearchChatReadResponseInputSchema.out,
  ],
  [
    VertexResearchChatResponseReceiptSchema,
    VertexResearchChatResponseReceiptSchema.in.out,
  ],
  [
    VertexResearchChatReadResponseOutputSchema,
    VertexResearchChatReadResponseOutputSchema.in.out,
  ],
  [
    VertexResearchChatRequestCopyCleanupRpcInputSchema,
    VertexResearchChatRequestCopyCleanupInputSchema.in.out,
  ],
  [
    VertexResearchChatReadCopyCleanupRpcInputSchema,
    VertexResearchChatReadCopyCleanupInputSchema.in.out,
  ],
  [
    VertexResearchChatCopyCleanupReceiptSchema,
    VertexResearchChatCopyCleanupReceiptSchema.in.out,
  ],
  [
    VertexResearchChatPrepareResponseRpcInputSchema,
    VertexResearchChatPrepareResponseInputSchema.out,
  ],
  [
    VertexResearchChatApproveAndRequestResponseRpcInputSchema,
    VertexResearchChatApproveAndRequestResponseInputSchema.in.out,
  ],
  [
    VertexResearchChatAppendResponseRpcInputSchema,
    VertexResearchChatAppendResponseInputSchema.in.out,
  ],
  [
    VertexResearchChatReadResponseContentRpcInputSchema,
    VertexResearchChatReadResponseContentInputSchema.in.out,
  ],
  [
    VertexResearchChatPrepareResponseOutputSchema,
    VertexResearchChatPrepareResponseOutputSchema.in.out,
  ],
  [
    VertexResearchChatApproveAndRequestResponseOutputSchema,
    VertexResearchChatApproveAndRequestResponseOutputSchema.in.out,
  ],
  [
    VertexResearchChatAppendResponseOutputSchema,
    VertexResearchChatAppendResponseOutputSchema.in.out,
  ],
  [
    VertexResearchChatReadResponseContentOutputSchema,
    VertexResearchChatReadResponseContentOutputSchema.in.out,
  ],
]);

// These exact artifact schemas only detach/freeze; their transforms do not
// change JSON shape. Preserve their structural requiredness without weakening
// runtime refinements or changing any other output conversion.
const isReadonlyArtifactOutput = (schema: unknown): boolean =>
  schema === DatasetManifestSchema ||
  schema === ResearchEvidenceSchema ||
  schema === VertexModulesListOutputSchema ||
  schema === ReadModelPrivacyReviewRequestOutputSchema ||
  schema === RecordModelPrivacyReviewOutputSchema ||
  VERTEX_EXPERIENCE_READONLY_OUTPUTS.some((output) => schema === output) ||
  VertexResearchChatReadonlyOutputs.some((output) => schema === output) ||
  VERTEX_WORKER_READONLY_OUTPUTS.some((output) => schema === output);

export const OPENAPI_INFO = {
  title: "DarkFactory API",
  version: "0.3.1",
} as const;

/**
 * The strategy expression tree is recursive (z.lazy). Unrolled at every use it grows the document
 * by megabytes, so it is one component per strategy that refers to itself.
 */
const COMMON_SCHEMAS = {
  StrategyExpr: { schema: StrategyExprSchema, strategy: "input" },
  StrategyExprOutput: { schema: StrategyExprSchema, strategy: "output" },
} as const;

export const buildOpenApiDocument = async (): Promise<OpenAPI.Document> => {
  const converter = new ZodToJsonSchemaConverter();
  const generator = new OpenAPIGenerator({
    schemaConverters: [
      {
        condition: (schema) => responseDocumentationSchemas.has(schema),
        convert: (schema, options) => {
          const documented = responseDocumentationSchemas.get(schema);
          if (documented === undefined) {
            throw new Error("Missing OpenAPI documentation schema");
          }
          return converter.convert(documented, {
            ...options,
            strategy: "input",
          });
        },
      },
      {
        condition: (schema, options) =>
          options.strategy === "output" && isReadonlyArtifactOutput(schema),
        convert: (schema, options) =>
          converter.convert(schema, { ...options, strategy: "input" }),
      },
      converter,
    ],
  });
  return await generator.generate(appContract, {
    commonSchemas: COMMON_SCHEMAS,
    info: OPENAPI_INFO,
  });
};

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
};

export const serializeOpenApiDocument = (
  document: OpenAPI.Document
): string => {
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
};
