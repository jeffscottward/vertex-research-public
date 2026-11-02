import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  canonicalArtifactJson,
  decimalUnits,
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  VertexResearchChatExecutionPlanSchema,
  VertexResearchChatParticipantConfigurationV1Schema,
  type VertexResearchChatExecutionPlan,
  type VertexResearchChatParticipantConfigurationV1,
} from "../contracts/vertex-research-chat-execution.ts";
import {
  parseModelUseRequest,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import {
  canonicalResearchChatInputJson,
  RESEARCH_CHAT_DEBATE_SYSTEM,
} from "./vertex-research-chat-inputs.ts";
import { parseResearchChatDerivedContext } from "./vertex-research-chat-derived.ts";
import {
  parseVertexResearchChatHumanContextV1,
  canonicalVertexResearchChatHumanContextV1,
} from "../contracts/vertex-research-chat-context.ts";
import {
  VertexResearchChatNativeEvidencePlanV1Schema,
  VertexResearchChatNativeEvidenceConfigurationV1Schema,
  type VertexResearchChatNativeEvidencePlanV1,
  type VertexResearchChatNativeEvidenceConfigurationV1,
} from "../contracts/vertex-research-chat-execution.ts";
import { WorkerNativeEvidencePhaseSchema } from "../contracts/vertex-worker.ts";
import { researchChatNativeEvidenceToolSchema } from "../contracts/vertex-research-chat-native-evidence.ts";
import {
  researchChatAdvisorySchema,
  RESEARCH_CHAT_NATIVE_EVIDENCE_SYSTEM,
} from "./vertex-research-chat-inputs.ts";
import { present } from "./present.ts";
export type ResearchChatAdvisoryOutputInput = Readonly<{
  plan: VertexResearchChatExecutionPlan;
  configuration: VertexResearchChatParticipantConfigurationV1;
  request: ModelUseRequest;
  responseBytes: Uint8Array;
  completionInputBytes: Uint8Array;
  modelPolicy: Readonly<Record<string, unknown>>;
}>;
export interface ResearchChatAdvisoryUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  completionCostUsd: string;
}
export interface ResearchChatAdvisoryDecodedOutput {
  profile: Record<string, unknown>;
  bytes: Uint8Array;
  responseSha256: string;
  usage: ResearchChatAdvisoryUsage;
}
export type ResearchChatNativeEvidenceAdvisoryOutputInput = Readonly<{
  plan: VertexResearchChatNativeEvidencePlanV1;
  configuration: VertexResearchChatNativeEvidenceConfigurationV1;
  request: ModelUseRequest;
  responseBytes: Uint8Array;
  completionInputBytes: Uint8Array;
  modelPolicy: Readonly<Record<string, unknown>>;
  phase: z.infer<typeof WorkerNativeEvidencePhaseSchema>;
  toolResultBytes: Uint8Array;
}>;
const utf8 = new TextEncoder();
const fail = (): never => {
  throw new TypeError("Invalid research chat advisory output");
};
const requireOutput = (condition: unknown): void => {
  if (!condition) fail();
};
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const row = (
  value: unknown,
  keys?: readonly string[]
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail();
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return fail();
  const result = value as Record<string, unknown>;
  if (
    keys &&
    (Object.keys(result).length !== keys.length ||
      keys.some((key) => !own(result, key)))
  )
    return fail();
  return result;
};
const array = (value: unknown, minimum: number, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    return fail();
  return value;
};
const integer = (
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    Object.is(value, -0)
  )
    return fail();
  return value;
};
const scalar = (value: unknown): string => {
  if (typeof value !== "string") return fail();
  for (const ch of value) {
    const code = present(ch.codePointAt(0));
    if (code >= 0xd8_00 && code <= 0xdf_ff) return fail();
  }
  return value;
};
// Native agents/evidence.py counts Unicode code points, not UTF-16 units.
const text = (value: unknown, maximum: number): string => {
  const result = scalar(value);
  requireOutput(
    Array.from(result).length >= 1 &&
      Array.from(result).length <= maximum &&
      !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(result)
  );
  return result;
};
const identifier = (value: unknown): string => {
  const result = scalar(value);
  requireOutput(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(result));
  return result;
};
const sha = (value: unknown): string => {
  const result = scalar(value);
  requireOutput(/^[0-9a-f]{64}$/u.test(result));
  return result;
};
const units = (value: unknown): bigint => {
  const result = scalar(value);
  requireOutput(
    /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?$/u.test(result)
  );
  return decimalUnits(result);
};
const usd = (value: bigint): string => {
  const scale = 10n ** 18n,
    whole = value / scale,
    fraction = value % scale;
  return fraction === 0n
    ? String(whole)
    : `${whole}.${String(fraction).padStart(18, "0").replace(/0+$/u, "")}`;
};

// Unknown provider numeric fields may contain exact decimals (e.g. timings).
// Validate original boundary.py decimal limits without binary rounding, but
// keep non-integer lexical numbers opaque: never coerce them into text/usage.
const opaqueNumber = Symbol("bounded-provider-number");
const providerNumber = (token: string): number | symbol => {
  requireOutput(token.length <= 128);
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(token)) {
    const exact = BigInt(token);
    if (exact >= -9007199254740991n && exact <= 9007199254740991n)
      return Number(exact);
  }
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(
    token
  );
  if (!match) return fail();
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/u, "");
  let power = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  if (digits.length === 0) {
    requireOutput(power >= -128n && power <= 29n);
    return opaqueNumber;
  }
  requireOutput(power >= -128n && BigInt(digits.length) + power - 1n <= 29n);
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    power += 1n;
  }
  requireOutput(power >= -18n);
  return opaqueNumber;
};

// Actual provider response/content: 24 levels, 100k nodes. Original approved
// completion JSON: 48 levels, 50k nodes, lossless <=128-character integers.
// Count keys too (conservatively stricter than the native response counter).
const parseJson = (
  bytes: Uint8Array,
  maximumBytes: number,
  approvedInput = false
): unknown => {
  requireOutput(bytes.byteLength >= 1 && bytes.byteLength <= maximumBytes);
  const source = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  let cursor = 0,
    nodes = 0;
  const count = (depth: number): void => {
    nodes += 1;
    requireOutput(
      nodes <= (approvedInput ? 50_000 : 100_000) &&
        depth <= (approvedInput ? 48 : 24)
    );
  };
  const space = (): void => {
    while (
      cursor < source.length &&
      /[\x20\t\r\n]/u.test(present(source[cursor]))
    )
      cursor += 1;
  };
  const stringValue = (): string => {
    requireOutput(source[cursor] === '"');
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const ch = present(source[cursor]);
      cursor += 1;
      if (ch === '"') return scalar(JSON.parse(source.slice(start, cursor)));
      requireOutput(ch.charCodeAt(0) >= 32);
      if (ch === "\\") {
        requireOutput(cursor < source.length);
        cursor += 1;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    count(depth);
    space();
    const ch = source[cursor];
    if (ch === '"') return stringValue();
    if (ch === "{") {
      cursor += 1;
      const result: Record<string, unknown> = Object.create(null);
      space();
      if (source[cursor] === "}") {
        cursor += 1;
        return result;
      }
      while (true) {
        count(depth + 1);
        const key = stringValue();
        requireOutput(!own(result, key));
        space();
        requireOutput(source[cursor] === ":");
        cursor += 1;
        result[key] = value(depth + 1);
        space();
        if (source[cursor] === "}") {
          cursor += 1;
          return result;
        }
        requireOutput(source[cursor] === ",");
        cursor += 1;
        space();
      }
    }
    if (ch === "[") {
      cursor += 1;
      const result: unknown[] = [];
      space();
      if (source[cursor] === "]") {
        cursor += 1;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        space();
        if (source[cursor] === "]") {
          cursor += 1;
          return result;
        }
        requireOutput(source[cursor] === ",");
        cursor += 1;
      }
    }
    for (const [token, literal] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, cursor)) {
        cursor += token.length;
        return literal;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      source.slice(cursor)
    );
    if (!match) return fail();
    const token = match[0];
    cursor += token.length;
    if (!approvedInput) return providerNumber(token);
    requireOutput(token.length <= 128 && /^-?(?:0|[1-9][0-9]*)$/u.test(token));
    const exact = BigInt(token);
    return exact >= -9007199254740991n && exact <= 9007199254740991n
      ? Number(token)
      : exact;
  };
  const result = value(0);
  space();
  requireOutput(cursor === source.length);
  return result;
};

// Compile only the ORIGINAL pinned response_format's supported schema subset.
// Visit every branch now, including unused anyOf alternatives: unsupported
// keywords never silently disappear because some other alternative matched.
type Matches = (value: unknown) => boolean;
const schemaMatcher = (schema: unknown, depth = 0): Matches => {
  requireOutput(depth <= 48);
  if (schema === false) return () => false;
  const shape = row(schema);
  if (own(shape, "anyOf")) {
    row(shape, ["anyOf"]);
    const matches = array(shape["anyOf"], 1, 8).map((child) =>
      schemaMatcher(child, depth + 1)
    );
    return (value) => matches.some((match) => match(value));
  }
  if (own(shape, "const")) {
    const expected = shape["const"];
    row(shape, ["const"]);
    requireOutput(
      expected === null ||
        typeof expected === "boolean" ||
        typeof expected === "string" ||
        (typeof expected === "number" && Number.isSafeInteger(expected))
    );
    return (value) => value === expected;
  }
  if (shape["type"] === "string") {
    row(shape, own(shape, "enum") ? ["type", "enum"] : ["type"]);
    const choices = own(shape, "enum")
      ? array(shape["enum"], 1, 32).map(scalar)
      : null;
    if (choices) requireOutput(new Set(choices).size === choices.length);
    return (value) =>
      typeof value === "string" &&
      (choices === null || choices.includes(value));
  }
  if (shape["type"] === "null") {
    row(shape, ["type"]);
    return (value) => value === null;
  }
  if (shape["type"] === "integer") {
    row(shape, ["type", "minimum", "maximum"]);
    const minimum = integer(shape["minimum"]),
      maximum = integer(shape["maximum"]);
    requireOutput(minimum <= maximum);
    return (value) =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0) &&
      value >= minimum &&
      value <= maximum;
  }
  if (shape["type"] === "array") {
    row(shape, ["type", "items", "maxItems"]);
    const maximum = integer(shape["maxItems"], 0, 100_000),
      itemMatches = schemaMatcher(shape["items"], depth + 1);
    return (value) =>
      Array.isArray(value) &&
      value.length <= maximum &&
      value.every(itemMatches);
  }
  if (shape["type"] === "object") {
    row(shape, ["type", "properties", "required", "additionalProperties"]);
    requireOutput(shape["additionalProperties"] === false);
    const properties = row(shape["properties"]),
      keys = Object.keys(properties),
      required = array(shape["required"], 0, 100_000).map(scalar);
    requireOutput(
      required.length === keys.length &&
        new Set(required).size === keys.length &&
        required.every((key) => own(properties, key))
    );
    const matches = new Map(
      keys.map((key) => [key, schemaMatcher(properties[key], depth + 1)])
    );
    return (value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
      const fields = value as Record<string, unknown>;
      return (
        Object.keys(fields).length === keys.length &&
        keys.every(
          (key) => own(fields, key) && present(matches.get(key))(fields[key])
        )
      );
    };
  }
  return fail();
};

const evidenceKeys = [
  "evidence_id",
  "collection_id",
  "snapshot_id",
  "source_id",
  "source_snapshot_id",
  "source_uri",
  "locator",
  "attribution",
  "content_hash",
  "excerpt_digest",
  "excerpt",
  "rights_policy_id",
  "captured_ns",
  "published_ns",
  "valid_until_ns",
  "artifact_digest",
  "accepted_review_id",
  "accepted_review_revision",
  "untrusted_content",
];
const citationKeys = [
  "evidence_id",
  "source_id",
  "source_snapshot_id",
  "content_hash",
  "excerpt_digest",
  "quote",
];
const evidenceEntry = (
  value: unknown,
  pin: VertexResearchChatExecutionPlan["reviewPins"][number],
  plan: Pick<VertexResearchChatExecutionPlan, "snapshotId" | "expiresAt">
): Record<string, unknown> => {
  const item = row(value, evidenceKeys),
    id = identifier(item["evidence_id"]);
  requireOutput(
    id === pin.evidenceId &&
      item["artifact_digest"] === pin.artifactSha256 &&
      item["accepted_review_id"] === pin.reviewId &&
      item["rights_policy_id"] === pin.rightsPolicyId &&
      item["collection_id"] === pin.collectionId &&
      item["snapshot_id"] === plan.snapshotId &&
      item["untrusted_content"] === true
  );
  for (const key of [
    "source_id",
    "source_snapshot_id",
    "collection_id",
    "snapshot_id",
    "rights_policy_id",
    "accepted_review_id",
  ])
    identifier(item[key]);
  for (const key of ["content_hash", "excerpt_digest", "artifact_digest"])
    sha(item[key]);
  for (const key of ["source_uri", "locator", "attribution"])
    requireOutput(
      scalar(item[key]).length >= 1 && scalar(item[key]).length <= 4000
    );
  const excerpt = scalar(item["excerpt"]);
  requireOutput(
    excerpt.length >= 1 &&
      excerpt.length <= 8000 &&
      digest(utf8.encode(excerpt)) === item["excerpt_digest"]
  );
  for (const key of [
    "captured_ns",
    "published_ns",
    "valid_until_ns",
    "accepted_review_revision",
  ]) {
    if (key === "published_ns" && item[key] === null) continue;
    const field = item[key];
    requireOutput(
      typeof field === "bigint" ||
        (typeof field === "number" &&
          Number.isSafeInteger(field) &&
          !Object.is(field, -0))
    );
    const exact = BigInt(field as number | bigint);
    requireOutput(exact >= 0n && exact <= 2n ** 127n - 1n);
  }
  requireOutput(
    BigInt(item["accepted_review_revision"] as number | bigint) > 0n &&
      BigInt(item["captured_ns"] as number | bigint) <
        BigInt(item["valid_until_ns"] as number | bigint)
  );
  requireOutput(
    BigInt(item["valid_until_ns"] as number | bigint) >=
      timestampToEpochNanoseconds(plan.expiresAt)
  );
  return item;
};
const evidenceMap = (
  value: unknown,
  plan: VertexResearchChatExecutionPlan
): Map<string, Record<string, unknown>> => {
  const entries = array(value, 1, 16),
    result = new Map<string, Record<string, unknown>>();
  requireOutput(entries.length === plan.reviewPins.length);
  for (let index = 0; index < entries.length; index += 1) {
    const item = evidenceEntry(
        entries[index],
        present(plan.reviewPins[index]),
        plan
      ),
      id = identifier(item["evidence_id"]);
    requireOutput(!result.has(id));
    result.set(id, item);
  }
  return result;
};
const claim = (
  value: unknown,
  evidence: Map<string, Record<string, unknown>>
): Record<string, unknown> => {
  const item = row(value, ["text", "kind", "citations"]);
  requireOutput(
    ["fact", "hypothesis", "limitation"].includes(scalar(item["kind"]))
  );
  const seen = new Set<string>();
  const citations = array(item["citations"], 1, 8).map((entry) => {
    const ref = row(entry, citationKeys),
      original = evidence.get(identifier(ref["evidence_id"]));
    if (!original) return fail();
    for (const key of [
      "source_id",
      "source_snapshot_id",
      "content_hash",
      "excerpt_digest",
    ])
      requireOutput(ref[key] === original[key]);
    const quote = text(ref["quote"], 1000);
    requireOutput(scalar(original["excerpt"]).includes(quote));
    const retained = {
      evidence_id: ref["evidence_id"],
      source_id: ref["source_id"],
      source_snapshot_id: ref["source_snapshot_id"],
      content_hash: ref["content_hash"],
      excerpt_digest: ref["excerpt_digest"],
      quote,
    };
    const identity = canonicalArtifactJson(retained);
    requireOutput(!seen.has(identity));
    seen.add(identity);
    return retained;
  });
  return { text: text(item["text"], 2000), kind: item["kind"], citations };
};
const advisory = (
  value: unknown,
  evidence: Map<string, Record<string, unknown>>
): Record<string, unknown> => {
  const item = row(value, ["claims", "proposals", "execution_authorized"]);
  requireOutput(item["execution_authorized"] === false);
  const claims = array(item["claims"], 1, 12).map((entry) =>
      claim(entry, evidence)
    ),
    seen = new Set<string>();
  const proposals = array(item["proposals"], 0, 8).map((entry) => {
    const proposal = row(entry, [
        "proposal_id",
        "kind",
        "title",
        "rationale",
        "execution_authorized",
      ]),
      id = identifier(proposal["proposal_id"]);
    requireOutput(
      !seen.has(id) &&
        proposal["execution_authorized"] === false &&
        ["strategy-hypothesis", "backtest-request"].includes(
          scalar(proposal["kind"])
        )
    );
    seen.add(id);
    return {
      proposal_id: id,
      kind: proposal["kind"],
      title: text(proposal["title"], 200),
      rationale: claim(proposal["rationale"], evidence),
      execution_authorized: false,
    };
  });
  return { claims, proposals, execution_authorized: false };
};
const emptyNative = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  value === "" ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0) ||
  (value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

export const decodeResearchChatAdvisoryOutput = async (
  input: ResearchChatAdvisoryOutputInput
): Promise<ResearchChatAdvisoryDecodedOutput> => {
  try {
    // Snapshot before the first await. No callback/property getter is a source.
    const descriptors = Object.getOwnPropertyDescriptors(row(input));
    const keys = [
      "plan",
      "configuration",
      "request",
      "responseBytes",
      "completionInputBytes",
      "modelPolicy",
    ];
    requireOutput(
      Reflect.ownKeys(descriptors).length === keys.length &&
        keys.every(
          (key) =>
            descriptors[key]?.enumerable &&
            own(present(descriptors[key]), "value")
        )
    );
    for (const key of [
      "plan",
      "configuration",
      "request",
      "modelPolicy",
    ] as const)
      canonicalResearchChatInputJson(present(descriptors[key]).value);
    for (const key of ["responseBytes", "completionInputBytes"] as const) {
      const bytes = present(descriptors[key]).value;
      requireOutput(
        bytes instanceof Uint8Array &&
          bytes.buffer instanceof ArrayBuffer &&
          bytes.byteLength >= 1 &&
          bytes.byteLength <= 1_048_576
      );
    }
    const responseBytes = Uint8Array.from(input.responseBytes),
      completionInputBytes = Uint8Array.from(input.completionInputBytes);
    const plan = VertexResearchChatExecutionPlanSchema.parse(input.plan),
      configuration = VertexResearchChatParticipantConfigurationV1Schema.parse(
        input.configuration
      );
    requireOutput(
      configuration.participantId !== "first-mate" ||
        plan.format === "vertex-research-chat-plan-v1"
    );
    const policy = structuredClone(input.modelPolicy),
      rawRequest = structuredClone(input.request);
    const request = await parseModelUseRequest(rawRequest);
    requireOutput(
      plan.participantConfiguration.artifactSha256 ===
        (await hashArtifact(configuration))
    );
    requireOutput(
      canonicalArtifactJson(plan.provider) ===
        canonicalArtifactJson(configuration.provider) &&
        canonicalArtifactJson(plan.reviewPins) ===
          canonicalArtifactJson(configuration.reviewPins)
    );
    requireOutput(
      plan.accountAlias === configuration.accountAlias &&
        plan.environment === configuration.environment &&
        plan.participantId === configuration.participantId &&
        plan.collectionId === configuration.collectionId &&
        plan.snapshotId === configuration.snapshotId &&
        plan.taskContract === configuration.taskContract &&
        plan.advisoryMaximumBytes === configuration.advisoryMaximumBytes
    );
    requireOutput(
      canonicalArtifactJson(plan.inputPolicy.modelPolicy) ===
        canonicalArtifactJson(configuration.modelPolicy)
    );
    requireOutput(
      digest(utf8.encode(canonicalResearchChatInputJson(policy))) ===
        plan.inputPolicy.modelPolicySha256 &&
        plan.inputPolicy.modelPolicySha256 ===
          configuration.modelPolicy.artifactSha256
    );
    const provider = configuration.provider,
      budgets = configuration.budgets;
    requireOutput(
      policy["model_version"] === provider.modelVersion &&
        policy["served_model"] === provider.servedModel &&
        request.operation === "model-completion" &&
        request.purpose === "research" &&
        request.tools.length === 0
    );
    requireOutput(
      request.accountAlias === plan.accountAlias &&
        request.environment === plan.environment &&
        request.researchPrincipalId === plan.ownerActorId &&
        request.selectionId === plan.selectionId &&
        request.selectionSha256 === plan.selectionSha256 &&
        request.providerId === provider.providerId &&
        request.modelVersion === provider.modelVersion
    );
    requireOutput(
      request.tokenizerArtifactId === provider.tokenizerArtifact.artifactId &&
        request.tokenizerSha256 === provider.tokenizerArtifact.artifactSha256 &&
        request.tokenizerSha256 === policy["tokenizer_sha256"] &&
        request.endpointReferenceId === policy["completion_endpoint_id"] &&
        request.endpointSha256 === provider.completionEndpoint.artifactSha256
    );
    requireOutput(request.evidence.length === plan.reviewPins.length);
    for (let index = 0; index < request.evidence.length; index += 1) {
      const ref = present(request.evidence[index]),
        pin = present(plan.reviewPins[index]);
      requireOutput(
        [
          "artifactId",
          "artifactSha256",
          "reviewId",
          "reviewVersion",
          "rightsPolicyId",
          "rightsVersion",
        ].every(
          (key) =>
            (ref as Record<string, unknown>)[key] ===
            (pin as Record<string, unknown>)[key]
        )
      );
    }
    requireOutput(
      request.inputBytes === completionInputBytes.byteLength &&
        request.inputSha256 === digest(completionInputBytes) &&
        request.inputSha256 === plan.completionInput.sha256 &&
        request.inputBytes === plan.completionInput.byteLength
    );
    const complete = row(parseJson(completionInputBytes, 1_048_576, true), [
      "model",
      "messages",
      "store",
      "max_completion_tokens",
      "response_format",
      "stream",
      "n",
      "tool_choice",
      "add_generation_prompt",
      "continue_final_message",
      "add_special_tokens",
      "chat_template_kwargs",
      "truncate_prompt_tokens",
      "skip_special_tokens",
    ]);
    requireOutput(
      canonicalResearchChatInputJson(complete) ===
        new TextDecoder("utf-8", { fatal: true }).decode(completionInputBytes)
    );
    requireOutput(
      complete["model"] === policy["served_model"] &&
        complete["store"] === false &&
        complete["stream"] === false &&
        complete["n"] === 1 &&
        complete["tool_choice"] === "none" &&
        complete["add_generation_prompt"] === true &&
        complete["continue_final_message"] === false &&
        complete["add_special_tokens"] === false &&
        complete["truncate_prompt_tokens"] === null &&
        complete["skip_special_tokens"] === true
    );
    row(complete["chat_template_kwargs"], []);
    const maximumOutput = integer(provider.maximumOutputTokens, 1),
      maximumInput = integer(provider.maximumInputTokens, 1);
    requireOutput(
      complete["max_completion_tokens"] === maximumOutput &&
        request.maximumOutputTokens === maximumOutput &&
        maximumOutput < maximumInput &&
        request.maximumCostUsd === budgets.completionCostUsd
    );
    const format = row(complete["response_format"], ["type", "json_schema"]),
      formatSchema = row(format["json_schema"], ["name", "schema", "strict"]);
    requireOutput(
      format["type"] === "json_schema" &&
        formatSchema["name"] === "vertex_advisory_v1" &&
        formatSchema["strict"] === true
    );
    const matches = schemaMatcher(formatSchema["schema"]);
    const messages = array(complete["messages"], 2, 2),
      system = row(messages[0], ["role", "content"]),
      user = row(messages[1], ["role", "content"]);
    requireOutput(system["role"] === "system" && user["role"] === "user");
    scalar(system["content"]);
    const envelope = row(
      parseJson(utf8.encode(scalar(user["content"])), 500_000, true),
      ["data", "inert_tool_names", "response_contract", "execution_authorized"]
    );
    requireOutput(
      envelope["execution_authorized"] === false &&
        canonicalResearchChatInputJson(envelope["response_contract"]) ===
          canonicalResearchChatInputJson(formatSchema["schema"])
    );
    array(envelope["inert_tool_names"], 0, 0);
    const data = row(envelope["data"], [
      "phase",
      "task",
      "evidence",
      "prior_analyses",
      "tool_results",
      "untrusted_content",
      "human_context",
      ...(plan.format === "vertex-research-chat-plan-v2"
        ? ["derived_context"]
        : []),
    ]);
    requireOutput(
      data["phase"] === "synthesis" &&
        data["untrusted_content"] === true &&
        scalar(data["task"]).length >= 10 &&
        scalar(data["task"]).length <= 2000
    );
    array(data["prior_analyses"], 0, 0);
    array(data["tool_results"], 0, 0);
    const evidence = evidenceMap(data["evidence"], plan);
    if (plan.format === "vertex-research-chat-plan-v2") {
      requireOutput(system["content"] === RESEARCH_CHAT_DEBATE_SYSTEM);
      const human = parseVertexResearchChatHumanContextV1(
          data["human_context"]
        ),
        humanBytes = utf8.encode(
          canonicalVertexResearchChatHumanContextV1(human)
        );
      requireOutput(
        human.owner_actor_id === plan.ownerActorId &&
          human.response_request_id === plan.responseRequestId &&
          human.thread_id === plan.threadId &&
          human.participant_id === plan.participantId &&
          digest(humanBytes) === plan.context.sha256 &&
          humanBytes.byteLength === plan.context.byteLength
      );
      requireOutput(
        (await hashArtifact({
          threadId: human.thread_id,
          parentMessageId: human.parent_message_id,
          snapshotRevision: human.snapshot_revision,
          contextStartSequence: human.start_sequence,
          messages: human.messages,
        })) === plan.debate.humanWindowSha256
      );
      const derived = await parseResearchChatDerivedContext(
        data["derived_context"],
        plan.debate,
        canonicalResearchChatInputJson
      );
      requireOutput(
        budgets.requestTokens <= plan.debate.turnTokens &&
          units(budgets.requestCostUsd) <= units(plan.debate.turnCostUsd)
      );
      for (const prior of derived.predecessors) {
        requireOutput(
          prior.pin.responseRequestId !== plan.responseRequestId &&
            prior.pin.planId !== plan.planId &&
            prior.pin.runId !== plan.runId
        );
        advisory(prior.advisory.output, evidence);
      }
    }
    const response = row(parseJson(responseBytes, 1_048_576));
    requireOutput(response["model"] === policy["served_model"]);
    const rawUsage = row(response["usage"]),
      inputTokens = integer(rawUsage["prompt_tokens"]),
      outputTokens = integer(rawUsage["completion_tokens"]),
      totalTokens = integer(rawUsage["total_tokens"]);
    requireOutput(
      inputTokens === integer(request.inputTokens, 1) &&
        inputTokens <= maximumInput &&
        outputTokens <= maximumOutput &&
        BigInt(totalTokens) === BigInt(inputTokens) + BigInt(outputTokens)
    );
    const tokenLimit = Math.min(
      integer(budgets.requestTokens, 1),
      integer(budgets.attemptTokens, 1),
      integer(policy["maximum_context_tokens"], 1, 1_000_000)
    );
    requireOutput(
      budgets.attemptTokens <= budgets.requestTokens &&
        BigInt(maximumInput) + BigInt(maximumOutput) <= BigInt(tokenLimit) &&
        BigInt(inputTokens) + BigInt(maximumOutput) <= BigInt(tokenLimit) &&
        totalTokens <= tokenLimit
    );
    // Selection ceilings are NOT present in this fixed data contract; the caller
    // independently verifies original selection.research token/cost bounds.
    const inputPrice = units(policy["input_usd_per_million"]),
      outputPrice = units(policy["output_usd_per_million"]);
    requireOutput(inputPrice > 0n && outputPrice > 0n);
    const completionLimit = units(budgets.completionCostUsd),
      combined = units(budgets.tokenizeCostUsd) + completionLimit;
    requireOutput(
      combined <= units(provider.maximumCostUsd) &&
        combined <= units(budgets.attemptCostUsd) &&
        units(budgets.attemptCostUsd) <= units(budgets.requestCostUsd)
    );
    const cost =
      (BigInt(inputTokens) * inputPrice +
        BigInt(outputTokens) * outputPrice +
        999_999n) /
      1_000_000n;
    const worst =
      (BigInt(maximumInput) * inputPrice +
        BigInt(maximumOutput) * outputPrice +
        999_999n) /
      1_000_000n;
    requireOutput(
      cost <= completionLimit &&
        worst <= completionLimit &&
        cost <= units(request.maximumCostUsd)
    );
    const choice = row(array(response["choices"], 1, 1)[0]),
      message = row(choice["message"]);
    requireOutput(
      choice["finish_reason"] === "stop" &&
        message["role"] === "assistant" &&
        emptyNative(message["refusal"]) &&
        emptyNative(message["tool_calls"]) &&
        emptyNative(message["function_call"])
    );
    const decoded = row(
      parseJson(utf8.encode(scalar(message["content"])), 500_000),
      ["output", "tool_requests"]
    );
    requireOutput(matches(decoded));
    array(decoded["tool_requests"], 0, 0);
    const output = advisory(decoded["output"], evidence),
      responseSha256 = digest(responseBytes);
    const usage: ResearchChatAdvisoryUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      completionCostUsd: usd(cost),
    };
    // Explicit allowlist projection: no input envelope, evidence corpus, human
    // text, persona, provider leftovers or full RunResult can cross this seam.
    const profile: Record<string, unknown> = {
      profile:
        plan.format === "vertex-research-chat-plan-v2"
          ? "vertex-research-chat-advisory-v2"
          : "vertex-research-chat-advisory-v1",
      responseRequestId: plan.responseRequestId,
      planId: plan.planId,
      planSha256: plan.planSha256,
      runId: plan.runId,
      traceId: plan.traceId,
      taskContract: plan.taskContract,
      modelVersion: provider.modelVersion,
      modelUseRequestSha256: request.requestSha256,
      responseSha256,
      usage,
      output,
      executionAuthorized: false,
      ...(plan.format === "vertex-research-chat-plan-v2"
        ? { debate: plan.debate }
        : {}),
    };
    const bytes = utf8.encode(canonicalArtifactJson(profile));
    requireOutput(
      bytes.byteLength <=
        Math.min(integer(plan.advisoryMaximumBytes, 1), 262_144)
    );
    deepFreezeArtifact(profile);
    return { profile, bytes, responseSha256, usage };
  } catch {
    // Do not attach source/provider exceptions or input prose to retained errors.
    return fail();
  }
};

// Separate selected-profile decoder: phase one is never recast as a legacy
// plan/input, and the manifest is never used as delivered citation authority.
export const decodeResearchChatNativeEvidenceAdvisoryOutput = async (
  input: ResearchChatNativeEvidenceAdvisoryOutputInput
): Promise<ResearchChatAdvisoryDecodedOutput> => {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(row(input));
    const keys = [
      "plan",
      "configuration",
      "request",
      "responseBytes",
      "completionInputBytes",
      "modelPolicy",
      "phase",
      "toolResultBytes",
    ];
    requireOutput(
      Reflect.ownKeys(descriptors).length === keys.length &&
        keys.every(
          (key) =>
            descriptors[key]?.enumerable &&
            own(present(descriptors[key]), "value")
        )
    );
    for (const key of [
      "plan",
      "configuration",
      "request",
      "modelPolicy",
      "phase",
    ] as const)
      canonicalResearchChatInputJson(present(descriptors[key]).value);
    for (const key of [
      "responseBytes",
      "completionInputBytes",
      "toolResultBytes",
    ] as const) {
      const bytes = present(descriptors[key]).value;
      requireOutput(
        bytes instanceof Uint8Array &&
          bytes.buffer instanceof ArrayBuffer &&
          bytes.byteLength >= 1 &&
          bytes.byteLength <= 1_048_576
      );
    }
    // Own all mutable inputs before any hash/request validation can yield.
    const responseBytes = Uint8Array.from(
        present(descriptors["responseBytes"]).value
      ),
      completionInputBytes = Uint8Array.from(
        present(descriptors["completionInputBytes"]).value
      ),
      toolResultBytes = Uint8Array.from(
        present(descriptors["toolResultBytes"]).value
      );
    const plan = VertexResearchChatNativeEvidencePlanV1Schema.parse(
        present(descriptors["plan"]).value
      ),
      configuration =
        VertexResearchChatNativeEvidenceConfigurationV1Schema.parse(
          present(descriptors["configuration"]).value
        );
    const phase = WorkerNativeEvidencePhaseSchema.parse(
      structuredClone(present(descriptors["phase"]).value)
    );
    const policy = structuredClone(
        present(descriptors["modelPolicy"]).value
      ) as Readonly<Record<string, unknown>>,
      rawRequest = structuredClone(present(descriptors["request"]).value);
    const request = await parseModelUseRequest(rawRequest);
    const { phaseSha256, ...phaseBody } = phase;
    requireOutput(
      phaseSha256 === (await hashArtifact(phaseBody)) &&
        phase.phaseOrdinal === 2 &&
        phase.derivation !== null
    );
    requireOutput(
      phase.accountAlias === plan.accountAlias &&
        phase.environment === plan.environment &&
        phase.responseRequestId === plan.responseRequestId &&
        phase.planSha256 === plan.planSha256
    );
    requireOutput(
      timestampToEpochNanoseconds(phase.expiresAt) <=
        timestampToEpochNanoseconds(plan.expiresAt) &&
        timestampToEpochNanoseconds(phase.expiresAt) >
          timestampToEpochNanoseconds(plan.plannedAt)
    );
    const derivation = present(phase.derivation);
    requireOutput(
      plan.participantConfiguration.artifactSha256 ===
        (await hashArtifact(configuration))
    );
    requireOutput(
      canonicalArtifactJson(plan.provider) ===
        canonicalArtifactJson(configuration.provider) &&
        canonicalArtifactJson(plan.reviewPins) ===
          canonicalArtifactJson(configuration.reviewPins)
    );
    requireOutput(
      plan.accountAlias === configuration.accountAlias &&
        plan.environment === configuration.environment &&
        plan.participantId === configuration.participantId &&
        plan.collectionId === configuration.collectionId &&
        plan.snapshotId === configuration.snapshotId &&
        plan.taskContract === configuration.taskContract &&
        plan.advisoryMaximumBytes === configuration.advisoryMaximumBytes
    );
    const { bundle, ...protocol } = plan.nativeEvidence;
    requireOutput(
      canonicalArtifactJson(protocol) ===
        canonicalArtifactJson(configuration.nativeEvidence)
    );
    requireOutput(
      canonicalArtifactJson(plan.inputPolicy.modelPolicy) ===
        canonicalArtifactJson(configuration.modelPolicy)
    );
    requireOutput(
      digest(utf8.encode(canonicalResearchChatInputJson(policy))) ===
        plan.inputPolicy.modelPolicySha256 &&
        plan.inputPolicy.modelPolicySha256 ===
          configuration.modelPolicy.artifactSha256
    );
    const provider = configuration.provider,
      budgets = configuration.budgets,
      ceiling = protocol.operationCeilings[3];
    requireOutput(
      policy["model_version"] === provider.modelVersion &&
        policy["served_model"] === provider.servedModel &&
        request.operation === "model-completion" &&
        request.purpose === "research" &&
        request.tools.length === 0
    );
    requireOutput(
      request.accountAlias === plan.accountAlias &&
        request.environment === plan.environment &&
        request.researchPrincipalId === plan.ownerActorId &&
        request.selectionId === plan.selectionId &&
        request.selectionSha256 === plan.selectionSha256 &&
        request.providerId === provider.providerId &&
        request.modelVersion === provider.modelVersion
    );
    requireOutput(
      request.tokenizerArtifactId === provider.tokenizerArtifact.artifactId &&
        request.tokenizerSha256 === provider.tokenizerArtifact.artifactSha256 &&
        request.tokenizerSha256 === policy["tokenizer_sha256"] &&
        request.endpointReferenceId === policy["completion_endpoint_id"] &&
        request.endpointSha256 === provider.completionEndpoint.artifactSha256
    );
    requireOutput(request.evidence.length === plan.reviewPins.length);
    for (let index = 0; index < request.evidence.length; index += 1) {
      const ref = present(request.evidence[index]),
        pin = present(plan.reviewPins[index]);
      requireOutput(
        [
          "artifactId",
          "artifactSha256",
          "reviewId",
          "reviewVersion",
          "rightsPolicyId",
          "rightsVersion",
        ].every(
          (key) =>
            (ref as Record<string, unknown>)[key] ===
            (pin as Record<string, unknown>)[key]
        )
      );
    }
    requireOutput(
      request.inputBytes === completionInputBytes.byteLength &&
        request.inputSha256 === digest(completionInputBytes) &&
        request.inputSha256 === phase.completionInput.sha256 &&
        request.inputBytes === phase.completionInput.byteLength
    );
    const complete = row(
      parseJson(completionInputBytes, protocol.maximumIntermediateBytes, true),
      [
        "model",
        "messages",
        "store",
        "max_completion_tokens",
        "response_format",
        "stream",
        "n",
        "tool_choice",
        "add_generation_prompt",
        "continue_final_message",
        "add_special_tokens",
        "chat_template_kwargs",
        "truncate_prompt_tokens",
        "skip_special_tokens",
      ]
    );
    requireOutput(
      canonicalResearchChatInputJson(complete) ===
        new TextDecoder("utf-8", { fatal: true }).decode(completionInputBytes)
    );
    requireOutput(
      complete["model"] === policy["served_model"] &&
        complete["store"] === false &&
        complete["stream"] === false &&
        complete["n"] === 1 &&
        complete["tool_choice"] === "none" &&
        complete["add_generation_prompt"] === true &&
        complete["continue_final_message"] === false &&
        complete["add_special_tokens"] === false &&
        complete["truncate_prompt_tokens"] === null &&
        complete["skip_special_tokens"] === true
    );
    row(complete["chat_template_kwargs"], []);
    const maximumOutput = integer(ceiling.maximumOutputTokens, 1),
      maximumInput = integer(ceiling.maximumInputTokens, 1);
    requireOutput(
      complete["max_completion_tokens"] === maximumOutput &&
        request.maximumOutputTokens === maximumOutput &&
        request.maximumCostUsd === ceiling.maximumCostUsd
    );
    requireOutput(
      maximumInput <= provider.maximumInputTokens &&
        maximumOutput <= provider.maximumOutputTokens &&
        provider.maximumOutputTokens < provider.maximumInputTokens
    );
    const format = row(complete["response_format"], ["type", "json_schema"]),
      formatSchema = row(format["json_schema"], ["name", "schema", "strict"]);
    requireOutput(
      format["type"] === "json_schema" &&
        formatSchema["name"] === "vertex_advisory_v1" &&
        formatSchema["strict"] === true &&
        canonicalResearchChatInputJson(formatSchema["schema"]) ===
          canonicalResearchChatInputJson(researchChatAdvisorySchema())
    );
    const matches = schemaMatcher(formatSchema["schema"]);
    const messages = array(complete["messages"], 4, 4),
      system = row(messages[0], ["role", "content"]),
      user = row(messages[1], ["role", "content"]);
    requireOutput(
      system["role"] === "system" &&
        system["content"] === RESEARCH_CHAT_NATIVE_EVIDENCE_SYSTEM &&
        user["role"] === "user"
    );
    const envelope = row(
      parseJson(utf8.encode(scalar(user["content"])), 500_000, true),
      ["data", "inert_tool_names", "response_contract", "execution_authorized"]
    );
    requireOutput(
      canonicalResearchChatInputJson(envelope) === user["content"] &&
        envelope["execution_authorized"] === false &&
        canonicalResearchChatInputJson(envelope["response_contract"]) ===
          canonicalResearchChatInputJson(formatSchema["schema"])
    );
    array(envelope["inert_tool_names"], 0, 0);
    const data = row(envelope["data"], [
      "phase",
      "task",
      "evidence",
      "evidence_manifest",
      "native_evidence_protocol",
      "prior_analyses",
      "tool_results",
      "untrusted_content",
      "human_context",
    ]);
    requireOutput(
      data["phase"] === "evidence-selection" &&
        data["untrusted_content"] === true &&
        scalar(data["task"]).length >= 10 &&
        scalar(data["task"]).length <= 2000
    );
    array(data["evidence"], 0, 0);
    array(data["prior_analyses"], 0, 0);
    array(data["tool_results"], 0, 0);
    requireOutput(
      canonicalResearchChatInputJson(data["native_evidence_protocol"]) ===
        canonicalResearchChatInputJson(plan.nativeEvidence)
    );
    const human = parseVertexResearchChatHumanContextV1(data["human_context"]),
      humanBytes = utf8.encode(
        canonicalVertexResearchChatHumanContextV1(human)
      );
    requireOutput(
      human.account_alias === plan.accountAlias &&
        human.environment === plan.environment &&
        human.owner_actor_id === plan.ownerActorId &&
        human.response_request_id === plan.responseRequestId &&
        human.thread_id === plan.threadId &&
        human.participant_id === plan.participantId &&
        human.parent_message_id === plan.parentMessageId &&
        human.snapshot_revision === plan.snapshotRevision &&
        human.start_sequence === plan.contextStartSequence &&
        human.participant_label === configuration.participantLabel &&
        human.persona_text === configuration.personaText
    );
    requireOutput(
      digest(humanBytes) === plan.context.sha256 &&
        humanBytes.byteLength === plan.context.byteLength
    );
    // Reconstruct only the phase-one framing from the preserved original two
    // messages; its immutable digest proves the system/user manifest identity.
    const { response_format, ...base } = complete;
    const original = utf8.encode(
      canonicalResearchChatInputJson({
        ...base,
        messages: messages.slice(0, 2),
        max_completion_tokens:
          protocol.operationCeilings[1].maximumOutputTokens,
        tools: [researchChatNativeEvidenceToolSchema()],
        tool_choice: {
          type: "function",
          function: { name: "read_reviewed_evidence" },
        },
        parallel_tool_calls: false,
      })
    );
    requireOutput(
      digest(original) === plan.completionInput.sha256 &&
        original.byteLength === plan.completionInput.byteLength
    );
    const tokenize = utf8.encode(
      canonicalResearchChatInputJson({
        model: complete["model"],
        messages,
        add_generation_prompt: complete["add_generation_prompt"],
        continue_final_message: complete["continue_final_message"],
        add_special_tokens: complete["add_special_tokens"],
        chat_template_kwargs: complete["chat_template_kwargs"],
        tools: null,
        return_token_strs: false,
      })
    );
    requireOutput(
      digest(tokenize) === phase.tokenizeInput.sha256 &&
        tokenize.byteLength === phase.tokenizeInput.byteLength
    );
    const assistant = row(messages[2], ["role", "content", "tool_calls"]),
      call = row(array(assistant["tool_calls"], 1, 1)[0], [
        "id",
        "type",
        "function",
      ]),
      fn = row(call["function"], ["name", "arguments"]);
    const args = canonicalResearchChatInputJson({
      evidence_id: derivation.evidenceId,
    });
    requireOutput(
      assistant["role"] === "assistant" &&
        assistant["content"] === null &&
        call["id"] === derivation.callId &&
        call["type"] === "function" &&
        fn["name"] === "read_reviewed_evidence" &&
        fn["name"] === derivation.toolName &&
        fn["arguments"] === args &&
        derivation.argumentsCanonical === args
    );
    const tool = row(messages[3], ["role", "tool_call_id", "content"]);
    requireOutput(
      tool["role"] === "tool" &&
        tool["tool_call_id"] === derivation.callId &&
        scalar(tool["content"]) ===
          new TextDecoder("utf-8", { fatal: true }).decode(toolResultBytes)
    );
    requireOutput(
      derivation.bundleSha256 === bundle.sha256 &&
        derivation.toolResultSha256 === digest(toolResultBytes)
    );
    const selected = row(
      parseJson(toolResultBytes, protocol.maximumIntermediateBytes, true),
      evidenceKeys
    );
    requireOutput(
      canonicalResearchChatInputJson(selected) === tool["content"] &&
        selected["evidence_id"] === derivation.evidenceId
    );
    const selectedPins = plan.reviewPins.filter(
      (pin) => pin.evidenceId === derivation.evidenceId
    );
    requireOutput(selectedPins.length === 1);
    // Validate the one delivered projection against its original pin. Do not
    // fabricate a subset plan or treat every configured evidence ID as read.
    const delivered = evidenceEntry(selected, present(selectedPins[0]), plan);
    const manifestKeys = [
      "evidence_id",
      "source_id",
      "source_snapshot_id",
      "content_hash",
      "excerpt_digest",
      "attribution",
      "untrusted_content",
    ];
    const manifest = array(data["evidence_manifest"], 1, 16),
      seen = new Set<string>();
    requireOutput(manifest.length === plan.reviewPins.length);
    for (let index = 0; index < manifest.length; index += 1) {
      const item = row(manifest[index], manifestKeys),
        id = identifier(item["evidence_id"]);
      requireOutput(
        !seen.has(id) &&
          id === present(plan.reviewPins[index]).evidenceId &&
          item["untrusted_content"] === true
      );
      seen.add(id);
      identifier(item["source_id"]);
      identifier(item["source_snapshot_id"]);
      sha(item["content_hash"]);
      sha(item["excerpt_digest"]);
      requireOutput(
        scalar(item["attribution"]).length >= 1 &&
          scalar(item["attribution"]).length <= 4000
      );
      if (id === derivation.evidenceId)
        for (const key of manifestKeys)
          requireOutput(item[key] === delivered[key]);
    }
    const evidence = new Map<string, Record<string, unknown>>([
      [derivation.evidenceId, delivered],
    ]);
    const response = row(parseJson(responseBytes, 1_048_576));
    requireOutput(response["model"] === policy["served_model"]);
    const rawUsage = row(response["usage"]),
      inputTokens = integer(rawUsage["prompt_tokens"]),
      outputTokens = integer(rawUsage["completion_tokens"]),
      totalTokens = integer(rawUsage["total_tokens"]);
    requireOutput(
      inputTokens === integer(request.inputTokens, 1) &&
        inputTokens <= maximumInput &&
        outputTokens <= maximumOutput &&
        BigInt(totalTokens) === BigInt(inputTokens) + BigInt(outputTokens)
    );
    const tokenLimit = Math.min(
      integer(budgets.requestTokens, 1),
      integer(budgets.attemptTokens, 1),
      integer(policy["maximum_context_tokens"], 1, 1_000_000)
    );
    requireOutput(
      budgets.attemptTokens <= budgets.requestTokens &&
        protocol.aggregateTokens <= budgets.attemptTokens &&
        BigInt(maximumInput) + BigInt(maximumOutput) <= BigInt(tokenLimit) &&
        BigInt(inputTokens) + BigInt(maximumOutput) <= BigInt(tokenLimit) &&
        totalTokens <= tokenLimit
    );
    const inputPrice = units(policy["input_usd_per_million"]),
      outputPrice = units(policy["output_usd_per_million"]);
    requireOutput(inputPrice > 0n && outputPrice > 0n);
    const completionLimit = units(ceiling.maximumCostUsd),
      aggregateLimit = units(protocol.aggregateCostUsd);
    requireOutput(
      aggregateLimit <= units(provider.maximumCostUsd) &&
        aggregateLimit <= units(budgets.attemptCostUsd) &&
        units(budgets.attemptCostUsd) <= units(budgets.requestCostUsd)
    );
    for (const operation of protocol.operationCeilings)
      requireOutput(
        operation.maximumInputTokens <= provider.maximumInputTokens &&
          operation.maximumOutputTokens <= provider.maximumOutputTokens &&
          BigInt(operation.maximumInputTokens) +
            BigInt(operation.maximumOutputTokens) <=
            BigInt(integer(policy["maximum_context_tokens"], 1, 1_000_000)) &&
          units(operation.maximumCostUsd) <= units(provider.maximumCostUsd)
      );
    const cost =
      (BigInt(inputTokens) * inputPrice +
        BigInt(outputTokens) * outputPrice +
        999_999n) /
      1_000_000n;
    const worst =
      (BigInt(maximumInput) * inputPrice +
        BigInt(maximumOutput) * outputPrice +
        999_999n) /
      1_000_000n;
    requireOutput(
      cost <= completionLimit &&
        worst <= completionLimit &&
        cost <= units(request.maximumCostUsd)
    );
    const choice = row(array(response["choices"], 1, 1)[0]),
      message = row(choice["message"]);
    requireOutput(
      choice["finish_reason"] === "stop" && message["role"] === "assistant"
    );
    requireOutput(
      message["refusal"] === undefined || message["refusal"] === null
    );
    requireOutput(
      message["function_call"] === undefined ||
        message["function_call"] === null
    );
    requireOutput(
      message["tool_calls"] === undefined ||
        message["tool_calls"] === null ||
        (Array.isArray(message["tool_calls"]) &&
          message["tool_calls"].length === 0)
    );
    const decoded = row(
      parseJson(utf8.encode(scalar(message["content"])), 500_000),
      ["output", "tool_requests"]
    );
    requireOutput(matches(decoded));
    array(decoded["tool_requests"], 0, 0);
    const output = advisory(decoded["output"], evidence),
      responseSha256 = digest(responseBytes);
    const usage: ResearchChatAdvisoryUsage = {
      inputTokens,
      outputTokens,
      totalTokens,
      completionCostUsd: usd(cost),
    };
    const profile: Record<string, unknown> = {
      profile: "vertex-research-chat-native-evidence-advisory-v1",
      responseRequestId: plan.responseRequestId,
      planId: plan.planId,
      planSha256: plan.planSha256,
      runId: plan.runId,
      traceId: plan.traceId,
      taskContract: plan.taskContract,
      modelVersion: provider.modelVersion,
      modelUseRequestSha256: request.requestSha256,
      responseSha256,
      usage,
      output,
      executionAuthorized: false,
    };
    const bytes = utf8.encode(canonicalArtifactJson(profile));
    requireOutput(
      bytes.byteLength <=
        Math.min(integer(plan.advisoryMaximumBytes, 1), 262_144)
    );
    deepFreezeArtifact(profile);
    return { profile, bytes, responseSha256, usage };
  } catch {
    return fail();
  }
};
