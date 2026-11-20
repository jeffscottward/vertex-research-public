import { describe, expect, it } from "vitest";
import {
  VertexContinuityReadSchema,
  VertexPortfolioReadSchema,
} from "./vertex-control.ts";
import {
  VertexContinuityStatusReadSchema,
  VertexPortfolioStatusReadSchema,
} from "./vertex-experience-status-reads.ts";
import {
  VertexResearchChatAdvisoryAvailabilitySchema,
  VertexResearchChatCorpusSchema,
} from "./vertex-research-chat.ts";
import {
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatApproveAndRequestResponseOutputSchema,
  VertexResearchChatPrepareResponseOutputSchema,
} from "./vertex-research-chat-conversation.ts";
import { VertexResearchChatReadDebateRunOutputSchema } from "./vertex-research-chat-debate.ts";
import { VertexResearchChatResponseReasonCodeSchema } from "./vertex-research-chat-response.ts";

// Status facts added 2026-11 are additive: a payload without them still parses,
// a payload with them parses, and a malformed fact is rejected.
const at = "2026-09-25T00:00:00.000Z";
const record = { schemaVersion: "1.0.0", executionAuthorized: false };
const scope = { accountAlias: "synthetic-research", environment: "research" };
const selector = { ...scope, threadId: "thread", idempotencyKey: "key" };
const appendSelector = {
  ...scope,
  threadId: "thread",
  responseRequestId: "response-request",
};
const accepts = (
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown
): boolean => schema.safeParse(value).success;

describe("additive research chat status facts", () => {
  it("accepts the definite reason codes next to the older ones", () => {
    for (const code of [
      "research-runtime-not-configured",
      "model-input-denied",
      "projection-read-denied",
      "model-input-approval-denied",
      "projection-read-failed",
      "projection-unavailable",
      "outcome-unknown",
    ])
      expect(accepts(VertexResearchChatResponseReasonCodeSchema, code)).toBe(
        true
      );
    return expect(
      accepts(VertexResearchChatResponseReasonCodeSchema, "not-a-code")
    ).toBe(false);
  });

  it("keeps the check time optional on states that were not prepared, approved or appended", () => {
    const old = { ...record, selector, reasonCodes: ["deadline"] };
    for (const [schema, status, base] of [
      [VertexResearchChatPrepareResponseOutputSchema, "unavailable", old],
      [VertexResearchChatApproveAndRequestResponseOutputSchema, "blocked", old],
      [
        VertexResearchChatAppendResponseOutputSchema,
        "unavailable",
        { ...old, selector: appendSelector },
      ],
    ] as const) {
      expect(accepts(schema, { ...base, status })).toBe(true);
      expect(accepts(schema, { ...base, status, checkedAt: at })).toBe(true);
      expect(accepts(schema, { ...base, status, checkedAt: "soon" })).toBe(
        false
      );
    }
  });

  it("keeps stage and start time optional on an outcome that is not confirmed", () => {
    const reasonCodes = ["outcome-unknown"];
    for (const [schema, base, stage] of [
      [
        VertexResearchChatApproveAndRequestResponseOutputSchema,
        { ...record, selector, status: "unknown", reasonCodes },
        "copies",
      ],
      [
        VertexResearchChatAppendResponseOutputSchema,
        { ...record, selector: appendSelector, status: "unknown", reasonCodes },
        "append",
      ],
    ] as const) {
      expect(accepts(schema, base)).toBe(true);
      expect(accepts(schema, { ...base, stage, startedAt: at })).toBe(true);
      expect(accepts(schema, { ...base, stage: "later" })).toBe(false);
      expect(accepts(schema, { ...base, startedAt: "soon" })).toBe(false);
    }
  });

  it("keeps the debate run cause and read window end optional", () => {
    const debateSelector = { ...scope, threadId: "thread", runKey: "run" };
    const old = {
      ...record,
      status: "unavailable",
      selector: debateSelector,
      checkedAt: at,
    };
    const schema = VertexResearchChatReadDebateRunOutputSchema;
    expect(accepts(schema, old)).toBe(true);
    for (const code of [
      "research-runtime-not-configured",
      "debate-runtime-not-configured",
      "debate-not-found",
    ])
      expect(accepts(schema, { ...old, reasonCodes: [code] })).toBe(true);
    expect(
      accepts(schema, { ...old, reasonCodes: ["debate-expired"], notAfter: at })
    ).toBe(true);
    expect(accepts(schema, { ...old, reasonCodes: [] })).toBe(false);
    expect(accepts(schema, { ...old, reasonCodes: ["deadline"] })).toBe(false);
    return expect(accepts(schema, { ...old, notAfter: "soon" })).toBe(false);
  });

  it("names a participant without a corpus and a runtime that is not wired", () => {
    const pins = { collectionId: null, snapshotSha256: null, reviewId: null };
    for (const status of ["unknown", "incomplete", "not-applicable"])
      expect(accepts(VertexResearchChatCorpusSchema, { ...pins, status })).toBe(
        true
      );
    expect(
      accepts(VertexResearchChatCorpusSchema, { ...pins, status: "absent" })
    ).toBe(false);
    const advisory = (status: string, code: string) =>
      accepts(VertexResearchChatAdvisoryAvailabilitySchema, {
        status,
        authorization: "requires-governed-prepare",
        reasonCodes: [code],
      });
    expect(advisory("configured", "governed-prepare-required")).toBe(true);
    expect(
      advisory("unavailable", "first-mate-configuration-unavailable")
    ).toBe(true);
    expect(advisory("unavailable", "research-runtime-not-configured")).toBe(
      true
    );
    // The reason must agree with the status in both directions.
    expect(advisory("configured", "research-runtime-not-configured")).toBe(
      false
    );
    return expect(advisory("unavailable", "governed-prepare-required")).toBe(
      false
    );
  });

  it("keeps the check time optional on portfolio and continuity reads without data", () => {
    const old = {
      status: "unavailable",
      reason: "not-found",
      executionAuthorized: false,
    };
    for (const schema of [
      VertexPortfolioStatusReadSchema,
      VertexContinuityStatusReadSchema,
    ]) {
      expect(accepts(schema, old)).toBe(true);
      expect(accepts(schema, { ...old, checkedAt: at })).toBe(true);
      expect(accepts(schema, { ...old, checkedAt: "soon" })).toBe(false);
      // The proven state is optional too, and only the one literal is accepted.
      expect(accepts(schema, { ...old, state: "not-yet-received" })).toBe(true);
      expect(accepts(schema, { ...old, state: "received" })).toBe(false);
    }
  });

  it("leaves the frozen native read schemas unchanged", () => {
    const old = {
      status: "unavailable",
      reason: "not-found",
      executionAuthorized: false,
    };
    for (const schema of [
      VertexPortfolioReadSchema,
      VertexContinuityReadSchema,
    ]) {
      expect(accepts(schema, old)).toBe(true);
      expect(accepts(schema, { ...old, checkedAt: at })).toBe(false);
      expect(accepts(schema, { ...old, state: "not-yet-received" })).toBe(
        false
      );
    }
  });
});
