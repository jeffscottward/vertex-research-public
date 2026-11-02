import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalResearchChatInputJson,
  researchChatAdvisorySchema,
  RESEARCH_CHAT_NATIVE_EVIDENCE_SYSTEM,
} from "./vertex-research-chat-inputs.ts";
import {
  VertexResearchChatNativeEvidencePlanProtocolSchema,
  researchChatNativeEvidenceToolSchema,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import { present } from "./present.ts";

const utf8 = new TextEncoder();
const fail = (): never => {
  throw new TypeError("Invalid bounded native evidence derivation");
};
const requireNative = (condition: unknown): void => {
  if (!condition) fail();
};
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Uint8Array =>
  utf8.encode(canonicalResearchChatInputJson(value));
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
};
// Duplicate-aware lossless bounded JSON: approved evidence nanoseconds cannot
// round through Number. Neither duplicate keys nor unsafe float syntax is valid.
export const parseNativeEvidenceJson = (
  bytes: Uint8Array,
  maximum = 262_144
): unknown => {
  requireNative(
    bytes instanceof Uint8Array &&
      bytes.byteLength > 0 &&
      bytes.byteLength <= maximum
  );
  const source = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  let cursor = 0,
    nodes = 0;
  const space = () => {
    while (
      cursor < source.length &&
      /[\x20\t\r\n]/u.test(present(source[cursor]))
    )
      cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const ch = present(source[cursor++]);
      if (ch === "\\") {
        cursor++;
        continue;
      }
      if (ch === '"') {
        const value = JSON.parse(source.slice(start, cursor)) as string;
        canonicalResearchChatInputJson(value);
        return value;
      }
    }
    return fail();
  };
  const parse = (depth: number): unknown => {
    requireNative(++nodes <= 50_000 && depth <= 48);
    space();
    const ch = source[cursor];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      cursor++;
      space();
      const object = ch === "{",
        result: Record<string, unknown> | unknown[] = object
          ? Object.create(null)
          : [];
      const end = object ? "}" : "]",
        seen = new Set<string>();
      if (source[cursor] === end) {
        cursor++;
        return result;
      }
      while (cursor < source.length) {
        space();
        if (object) {
          requireNative(source[cursor] === '"');
          const key = string();
          requireNative(!seen.has(key));
          seen.add(key);
          space();
          requireNative(source[cursor++] === ":");
          (result as Record<string, unknown>)[key] = parse(depth + 1);
        } else (result as unknown[]).push(parse(depth + 1));
        space();
        if (source[cursor] === end) {
          cursor++;
          return result;
        }
        requireNative(source[cursor++] === ",");
      }
      return fail();
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/u.exec(source.slice(cursor));
    requireNative(match && match[0].length <= 128 && match[0] !== "-0");
    cursor += present(match)[0].length;
    const integer = BigInt(present(match)[0]),
      number = Number(integer);
    return Number.isSafeInteger(number) ? number : integer;
  };
  const result = parse(0);
  space();
  requireNative(cursor === source.length);
  return result;
};
const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u)
  .refine((value) => value.trim() === value);
const callSchema = z
  .object({
    id,
    type: z.literal("function"),
    function: z
      .object({
        name: z.literal("read_reviewed_evidence"),
        arguments: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();
const messageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.union([z.null(), z.literal("")]).optional(),
    tool_calls: z.tuple([callSchema]),
    refusal: z.null().optional(),
  })
  .strict();
const responseSchema = z
  .object({
    id: z.string().min(1).max(256),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: z.string().min(1).max(256),
    choices: z.tuple([
      z
        .object({
          index: z.literal(0),
          finish_reason: z.literal("tool_calls"),
          message: messageSchema,
          logprobs: z.null().optional(),
        })
        .strict(),
    ]),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
    system_fingerprint: z.string().nullable().optional(),
    service_tier: z.string().nullable().optional(),
  })
  .strict();
export type NativeEvidencePhaseTwoInputs = Readonly<{
  toolResult: Uint8Array;
  phaseTwoTokenizeInput: Uint8Array;
  phaseTwoCompletionInput: Uint8Array;
  derivation: Readonly<{
    profile: "reviewed-evidence-single-projection-v1";
    phaseOneResponseSha256: string;
    callId: string;
    toolName: "read_reviewed_evidence";
    argumentsCanonical: string;
    evidenceId: string;
    bundleSha256: string;
    toolResultSha256: string;
  }>;
}>;
// Pure reconstruction only. The caller must independently rejoin original
// approval, exact phase1 audits/dispatch, current rights and governed bundle.
export const prepareNativeEvidencePhaseTwoInputs = (
  phaseOneCompletionInput: Uint8Array,
  evidenceBundle: Uint8Array,
  rawResponse: Uint8Array
): NativeEvidencePhaseTwoInputs => {
  const original = row(
    parseNativeEvidenceJson(phaseOneCompletionInput, 1_048_576)
  );
  requireNative(
    canonicalResearchChatInputJson(original) ===
      new TextDecoder().decode(phaseOneCompletionInput)
  );
  const originalKeys = [
    "model",
    "messages",
    "store",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "n",
    "add_generation_prompt",
    "continue_final_message",
    "add_special_tokens",
    "chat_template_kwargs",
    "truncate_prompt_tokens",
    "skip_special_tokens",
  ];
  requireNative(
    Object.keys(original).length === originalKeys.length &&
      Object.keys(original).every((key) => originalKeys.includes(key))
  );
  requireNative(
    canonicalResearchChatInputJson(original["tools"]) ===
      canonicalResearchChatInputJson([researchChatNativeEvidenceToolSchema()])
  );
  requireNative(
    canonicalResearchChatInputJson(original["tool_choice"]) ===
      canonicalResearchChatInputJson({
        type: "function",
        function: { name: "read_reviewed_evidence" },
      })
  );
  requireNative(
    original["parallel_tool_calls"] === false &&
      original["stream"] === false &&
      original["n"] === 1 &&
      original["store"] === false
  );
  requireNative(
    original["add_generation_prompt"] === true &&
      original["continue_final_message"] === false &&
      original["add_special_tokens"] === false &&
      original["skip_special_tokens"] === true &&
      original["truncate_prompt_tokens"] === null &&
      canonicalResearchChatInputJson(original["chat_template_kwargs"]) === "{}"
  );
  requireNative(
    Array.isArray(original["messages"]) && original["messages"].length === 2
  );
  const messages = original["messages"] as Record<string, unknown>[];
  requireNative(
    messages[0]?.["role"] === "system" &&
      messages[1]?.["role"] === "user" &&
      typeof messages[1]?.["content"] === "string"
  );
  requireNative(
    messages.every(
      (message) =>
        Object.keys(message).length === 2 &&
        Object.keys(message).every((key) => ["role", "content"].includes(key))
    ) &&
      present(messages[0])["content"] === RESEARCH_CHAT_NATIVE_EVIDENCE_SYSTEM
  );
  const envelope = row(
      parseNativeEvidenceJson(
        utf8.encode(present(messages[1])["content"] as string),
        500_000
      )
    ),
    data = row(envelope["data"]);
  const protocol = VertexResearchChatNativeEvidencePlanProtocolSchema.parse(
    data["native_evidence_protocol"]
  );
  requireNative(
    original["max_completion_tokens"] ===
      protocol.operationCeilings[1].maximumOutputTokens
  );
  requireNative(
    Object.keys(envelope).length === 4 &&
      Object.keys(envelope).every((key) =>
        [
          "data",
          "inert_tool_names",
          "response_contract",
          "execution_authorized",
        ].includes(key)
      )
  );
  const dataKeys = [
    "phase",
    "task",
    "evidence",
    "evidence_manifest",
    "native_evidence_protocol",
    "prior_analyses",
    "tool_results",
    "untrusted_content",
    "human_context",
  ];
  requireNative(
    Object.keys(data).length === dataKeys.length &&
      Object.keys(data).every((key) => dataKeys.includes(key))
  );
  requireNative(
    typeof data["task"] === "string" &&
      data["task"].length >= 10 &&
      data["task"].length <= 2000
  );
  const human = parseVertexResearchChatHumanContextV1(data["human_context"]);
  requireNative(human.participant_id === "first-mate");
  requireNative(
    canonicalResearchChatInputJson(envelope) === present(messages[1])["content"]
  );
  requireNative(
    Array.isArray(envelope["inert_tool_names"]) &&
      envelope["inert_tool_names"].length === 0 &&
      Array.isArray(data["prior_analyses"]) &&
      data["prior_analyses"].length === 0
  );
  requireNative(
    data["phase"] === "evidence-selection" &&
      envelope["execution_authorized"] === false &&
      data["untrusted_content"] === true
  );
  requireNative(
    Array.isArray(data["evidence"]) &&
      data["evidence"].length === 0 &&
      Array.isArray(data["tool_results"]) &&
      data["tool_results"].length === 0
  );
  requireNative(
    canonicalResearchChatInputJson(envelope["response_contract"]) ===
      canonicalResearchChatInputJson(researchChatAdvisorySchema())
  );
  requireNative(
    evidenceBundle.byteLength === protocol.bundle.byteLength &&
      digest(evidenceBundle) === protocol.bundle.sha256
  );
  const bundle = parseNativeEvidenceJson(evidenceBundle);
  requireNative(
    canonicalResearchChatInputJson(bundle) ===
      new TextDecoder().decode(evidenceBundle) &&
      Array.isArray(bundle) &&
      bundle.length >= 1 &&
      bundle.length <= 16
  );
  const entries = (bundle as unknown[]).map(row);
  requireNative(
    new Set(entries.map((entry) => id.parse(entry["evidence_id"]))).size ===
      entries.length
  );
  const manifest = entries.map(
    ({
      evidence_id,
      source_id,
      source_snapshot_id,
      content_hash,
      excerpt_digest,
      attribution,
      untrusted_content,
    }) => ({
      evidence_id,
      source_id,
      source_snapshot_id,
      content_hash,
      excerpt_digest,
      attribution,
      untrusted_content,
    })
  );
  requireNative(
    canonicalResearchChatInputJson(manifest) ===
      canonicalResearchChatInputJson(data["evidence_manifest"])
  );
  const response = responseSchema.parse(parseNativeEvidenceJson(rawResponse)),
    call = response.choices[0].message.tool_calls[0];
  requireNative(
    response.model === original["model"] &&
      Number.isSafeInteger(response.usage.total_tokens) &&
      response.usage.total_tokens ===
        response.usage.prompt_tokens + response.usage.completion_tokens
  );
  requireNative(
    response.usage.prompt_tokens <=
      protocol.operationCeilings[1].maximumInputTokens &&
      response.usage.completion_tokens <=
        protocol.operationCeilings[1].maximumOutputTokens
  );
  const args = z
    .object({ evidence_id: id })
    .strict()
    .parse(parseNativeEvidenceJson(utf8.encode(call.function.arguments), 512));
  const selected = entries.filter(
    (entry) => entry["evidence_id"] === args.evidence_id
  );
  requireNative(
    selected.length === 1 &&
      present(selected[0])["untrusted_content"] === true &&
      typeof present(selected[0])["excerpt"] === "string"
  );
  requireNative(
    digest(utf8.encode(present(selected[0])["excerpt"] as string)) ===
      present(selected[0])["excerpt_digest"]
  );
  const toolResult = encode(selected[0]),
    argumentsCanonical = canonicalResearchChatInputJson(args);
  requireNative(call.function.arguments === argumentsCanonical);
  const exactCall = {
    id: call.id,
    type: "function",
    function: { name: "read_reviewed_evidence", arguments: argumentsCanonical },
  };
  const phaseTwoMessages = [
    ...messages,
    { role: "assistant", content: null, tool_calls: [exactCall] },
    {
      role: "tool",
      tool_call_id: call.id,
      content: new TextDecoder().decode(toolResult),
    },
  ];
  const { tools, parallel_tool_calls, ...base } = original;
  const completion = {
    ...base,
    messages: phaseTwoMessages,
    max_completion_tokens: protocol.operationCeilings[3].maximumOutputTokens,
    tool_choice: "none",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "vertex_advisory_v1",
        schema: researchChatAdvisorySchema(),
        strict: true,
      },
    },
  };
  const phaseTwoCompletionInput = encode(completion);
  const phaseTwoTokenizeInput = encode({
    model: original["model"],
    messages: phaseTwoMessages,
    add_generation_prompt: original["add_generation_prompt"],
    continue_final_message: original["continue_final_message"],
    add_special_tokens: original["add_special_tokens"],
    chat_template_kwargs: original["chat_template_kwargs"],
    tools: null,
    return_token_strs: false,
  });
  requireNative(
    [toolResult, phaseTwoTokenizeInput, phaseTwoCompletionInput].every(
      (bytes) => bytes.byteLength <= protocol.maximumIntermediateBytes
    )
  );
  return {
    toolResult,
    phaseTwoTokenizeInput,
    phaseTwoCompletionInput,
    derivation: {
      profile: "reviewed-evidence-single-projection-v1",
      phaseOneResponseSha256: digest(rawResponse),
      callId: call.id,
      toolName: "read_reviewed_evidence",
      argumentsCanonical,
      evidenceId: args.evidence_id,
      bundleSha256: digest(evidenceBundle),
      toolResultSha256: digest(toolResult),
    },
  };
};
