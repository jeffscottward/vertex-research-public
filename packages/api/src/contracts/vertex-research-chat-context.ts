import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { DigestSchema, IdentifierSchema } from "./vertex.ts";
import {
  VertexResearchChatOrdinalSchema,
  VertexResearchChatSendMessageInputSchema,
} from "./vertex-research-chat.ts";

// Internal, inert codec only. These hashes, labels and all prose are untrusted
// data, not Evidence, permission, readiness, identity proof or model admission.
// Trusted extraction/current-use authorization must be designed separately.
const ContextIdentifierSchema = IdentifierSchema.refine(
  (value) => value.trim() === value,
  { message: "Identifier must consume the complete string" }
);
const ContextDigestSchema = DigestSchema.refine(
  (value) => value.trim() === value,
  { message: "Digest must consume the complete string" }
);
// Reuse the actual human-send validator: complete literal text, UTF-16 lengths,
// ECMAScript-trim nonblank, no normalization, TAB/LF/CR only in multiline prose.
const BodySchema = VertexResearchChatSendMessageInputSchema.shape.body;
// Zod >=4.6 measures string maxima in code points; these limits are UTF-16
// code units, so they are explicit length refinements.
const PersonaSchema = BodySchema.refine((value) => value.length <= 4000, {
  message: "Expected at most 4000 UTF-16 code units",
});
const ParticipantLabelSchema = BodySchema.refine(
  (value) => value.length <= 160,
  { message: "Expected at most 160 UTF-16 code units" }
).refine((value) => !/[\t\r\n]/u.test(value), {
  message: "Participant label must be single-line literal text",
});

const HumanMessageSchema = z
  .object({
    message_id: ContextIdentifierSchema,
    sequence: VertexResearchChatOrdinalSchema,
    record_sha256: ContextDigestSchema,
    author: z
      .object({ kind: z.literal("user"), actor_id: ContextIdentifierSchema })
      .strict()
      .readonly(),
    body: BodySchema,
  })
  .strict()
  .readonly();

const HumanContextShapeSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    kind: z.literal("research-chat-human-context"),
    account_alias: ContextIdentifierSchema,
    environment: z.literal("research"),
    owner_actor_id: ContextIdentifierSchema,
    response_request_id: ContextIdentifierSchema,
    thread_id: ContextIdentifierSchema,
    parent_message_id: ContextIdentifierSchema,
    participant_id: ContextIdentifierSchema,
    participant_config_sha256: ContextDigestSchema,
    participant_label: ParticipantLabelSchema,
    persona_text: PersonaSchema,
    snapshot_revision: VertexResearchChatOrdinalSchema,
    high_water_sequence: VertexResearchChatOrdinalSchema,
    start_sequence: VertexResearchChatOrdinalSchema,
    messages: z.array(HumanMessageSchema).min(1).max(16).readonly(),
  })
  .strict()
  .refine(
    (value) => {
      // Zod may still run refinements after a nonfatal string-format failure.
      // Guard arithmetic so malformed ordinals remain ordinary validation errors.
      try {
        const highWater = BigInt(value.high_water_sequence);
        const start = BigInt(value.start_sequence);
        if (
          BigInt(value.snapshot_revision) !== highWater + 1n ||
          start > highWater
        )
          return false;
        if (highWater - start + 1n !== BigInt(value.messages.length))
          return false;
        if (
          new Set(value.messages.map((message) => message.message_id)).size !==
          value.messages.length
        )
          return false;
        if (
          !value.messages.every(
            (message, index) =>
              message.author.actor_id === value.owner_actor_id &&
              BigInt(message.sequence) === start + BigInt(index)
          )
        )
          return false;
        return value.messages.at(-1)?.message_id === value.parent_message_id;
      } catch {
        return false;
      }
    },
    {
      message:
        "Expected an owned contiguous human-only window ending at its parent and exact snapshot high-water",
    }
  )
  .readonly();

// The authoritative encoder validates descriptors before visiting values. Run
// it BEFORE Zod touches properties, and never expose a raw shape-only schema.
// JSON.parse detaches this already-canonical graph; it is not a second encoder.
// This preflight is inside the schema, not just the convenience parse helper.
const CanonicalContextInputSchema = z.unknown().transform((value, ctx) => {
  try {
    const canonical = canonicalArtifactJson(value);
    if (new TextEncoder().encode(canonical).byteLength > 65_536) {
      ctx.addIssue({
        code: "custom",
        message: "Human context exceeds the canonical UTF-8 byte limit",
      });
      return z.NEVER;
    }
    return JSON.parse(canonical) as unknown;
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Human context must be a canonical JSON data graph",
    });
    return z.NEVER;
  }
});

export const VertexResearchChatHumanContextV1Schema =
  CanonicalContextInputSchema.pipe(HumanContextShapeSchema).transform(
    deepFreezeArtifact
  );
export type VertexResearchChatHumanContextV1 = z.infer<
  typeof VertexResearchChatHumanContextV1Schema
>;

export const parseVertexResearchChatHumanContextV1 = (
  value: unknown
): VertexResearchChatHumanContextV1 => {
  return VertexResearchChatHumanContextV1Schema.parse(value);
};

export const canonicalVertexResearchChatHumanContextV1 = (
  value: unknown
): string => {
  return canonicalArtifactJson(parseVertexResearchChatHumanContextV1(value));
};

// biome-ignore lint/suspicious/useAwait: async keeps the promise contract so synchronous validation failures reject instead of throwing.
export const hashVertexResearchChatHumanContextV1 = async (
  value: unknown
): Promise<string> => {
  return hashArtifact(canonicalVertexResearchChatHumanContextV1(value));
};
