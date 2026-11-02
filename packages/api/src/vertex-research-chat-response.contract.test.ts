import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { VertexResearchChatSendMessageInputSchema } from "./contracts/vertex-research-chat.ts";
import {
  VertexResearchChatResponseReasonCodeSchema,
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatResponseReceiptSchema,
  VertexResearchChatRequestResponseOutputSchema,
  VertexResearchChatReadResponseOutputSchema,
  type VertexResearchChatResponseReasonCode,
  type VertexResearchChatRequestResponseInput,
  type VertexResearchChatReadResponseInput,
  type VertexResearchChatResponseReceipt,
  type VertexResearchChatRequestResponseOutput,
  type VertexResearchChatReadResponseOutput,
} from "./contracts/vertex-research-chat-response.ts";

// Fictional selectors/pins only. No corpus, membership, policy, worker or model
// is consulted: successful parsing and hashing cannot authorize a response.
const scope = {
  accountAlias: "synthetic-account",
  environment: "research",
} as const;
const selectors = {
  ...scope,
  threadId: "synthetic-thread",
  idempotencyKey: "synthetic-key",
} as const;
const request = {
  ...selectors,
  parentMessageId: "synthetic-parent",
  participantId: "synthetic-expert",
  snapshotRevision: "9007199254740993",
  contextStartSequence: "9007199254740992",
  retrievalQuery: "  Synthetic literal <question> é \u{1d11e}  ",
} as const;
const common = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  ...selectors,
  ownerActorId: "synthetic-owner",
  responseRequestId: "synthetic-request",
  parentMessageId: request.parentMessageId,
  participantId: request.participantId,
  requestSha256: "a".repeat(64),
  recordedAt: "2026-09-24T00:00:00.000000001Z",
  snapshotRevision: request.snapshotRevision,
  contextStartSequence: request.contextStartSequence,
  jobId: null,
} as const;
const unavailable = {
  ...common,
  status: "unavailable",
  reasonCodes: ["participant-unavailable"],
  admission: null,
} as const;
const admission = {
  bindingSha256: "b".repeat(64),
  contextSha256: "c".repeat(64),
  participantConfigSha256: "d".repeat(64),
  collectionId: "synthetic-collection",
  proposal: { artifactId: "synthetic-proposal", sha256: "e".repeat(64) },
  runId: "synthetic-run",
  eventId: "synthetic-event",
} as const;
const admitted = {
  ...common,
  status: "admitted",
  reasonCodes: [],
  admission,
} as const;
const readCommon = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  checkedAt: common.recordedAt,
} as const;
const absent = {
  ...readCommon,
  receipt: unavailable,
  job: null,
  delivery: { status: "not-applicable" },
} as const;
const pending = {
  ...readCommon,
  receipt: admitted,
  job: null,
  delivery: { status: "pending" },
} as const;
const message = {
  messageId: "synthetic-reply",
  sequence: "9007199254740993",
  threadRevision: "9007199254740994",
} as const;
const appended = {
  ...readCommon,
  receipt: admitted,
  job: { jobId: "synthetic-job", state: "succeeded" },
  delivery: { status: "appended", message },
} as const;
const blocked = {
  ...pending,
  delivery: { status: "unavailable", reasonCodes: ["projection-unavailable"] },
} as const;
const reasons = [
  "participant-unavailable",
  "corpus-unavailable",
  "context-limit",
  "context-lineage-unsupported",
  "context-use-unavailable",
  "context-retention-unavailable",
  "model-input-preparation-unavailable",
  "model-input-approval-unavailable",
  "research-runtime-unavailable",
  "worker-unavailable",
  "projection-unavailable",
  "policy-unavailable",
  "policy-revoked",
  "rights-denied",
  "review-unavailable",
  "deadline",
  "worker-failed",
  "cancelled",
  "outcome-unknown",
] as const;
const states = [
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;
const maximum = "999999999999999999999999999999";
const reject = (schema: z.ZodType, value: unknown): void => {
  expect(() => schema.safeParse(value)).not.toThrow();
  expect(schema.safeParse(value).success).toBe(false);
  expect(() => schema.parse(value)).toThrow(z.ZodError);
};

const expectFrozen = (value: unknown): void => {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
};

describe("Pure research-chat response DTOs (not request admission)", () => {
  it("accepts only the frozen closed reason vocabulary", () => {
    expect(VertexResearchChatResponseReasonCodeSchema.options).toEqual(reasons);
    for (const reason of reasons) {
      expect(VertexResearchChatResponseReasonCodeSchema.parse(reason)).toBe(
        reason
      );
    }

    for (const reason of [
      "unknown",
      "queued",
      "not-requested",
      "model-ready",
      "rights-denied\n",
      "",
      null,
    ]) {
      reject(VertexResearchChatResponseReasonCodeSchema, reason);
    }
  });

  it("preserves the explicit literal query and exact selector strings", () => {
    expect(VertexResearchChatRequestResponseInputSchema.parse(request)).toEqual(
      request
    );
    expect(VertexResearchChatReadResponseInputSchema.parse(selectors)).toEqual(
      selectors
    );
    return expect(
      VertexResearchChatRequestResponseInputSchema.parse(request).retrievalQuery
    ).toBe(request.retrievalQuery);
  });

  it("requires every explicit request selector and query rather than inferring a window or query", () => {
    for (const key of Object.keys(request)) {
      const incomplete: Record<string, unknown> = { ...request };
      delete incomplete[key];
      reject(VertexResearchChatRequestResponseInputSchema, incomplete);
    }

    for (const key of Object.keys(selectors)) {
      const incomplete: Record<string, unknown> = { ...selectors };
      delete incomplete[key];
      reject(VertexResearchChatReadResponseInputSchema, incomplete);
    }
  });

  it("rejects caller authority, context bytes, worker identities and multiple participants", () => {
    for (const key of [
      "actorId",
      "ownerActorId",
      "role",
      "corpus",
      "collectionId",
      "participantConfigSha256",
      "permission",
      "budget",
      "context",
      "body",
      "messages",
      "persona",
      "modelEndpoint",
      "jobId",
      "runId",
      "eventId",
      "executionAuthorized",
      "requestedParticipantIds",
      "ranges",
      "highWaterSequence",
      "responseRequestId",
      "admission",
    ]) {
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        [key]: "synthetic-forgery",
      });
      reject(VertexResearchChatReadResponseInputSchema, {
        ...selectors,
        [key]: "synthetic-forgery",
      });
    }
    reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      participantId: ["synthetic-a", "synthetic-b"],
    });
    return reject(VertexResearchChatReadResponseInputSchema, {
      ...selectors,
      retrievalQuery: request.retrievalQuery,
    });
  });

  it("keeps all inputs and receipts research-only with no execution authorization", () => {
    for (const environment of ["paper", "live", "unknown"]) {
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        environment,
      });
      reject(VertexResearchChatReadResponseInputSchema, {
        ...selectors,
        environment,
      });
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        environment,
      });
    }
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      executionAuthorized: true,
    });
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      executionAuthorized: true,
    });
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      schemaVersion: "2.0.0",
    });
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      schemaVersion: "2.0.0",
    });
  });

  it("accepts each explicit one through sixteen message range and rejects empty or wider ranges", () => {
    for (let count = 1; count <= 16; count += 1) {
      const value = {
        ...request,
        snapshotRevision: (
          BigInt(request.contextStartSequence) + BigInt(count)
        ).toString(),
      };
      expect(
        VertexResearchChatRequestResponseInputSchema.safeParse(value).success
      ).toBe(true);
      expect(
        VertexResearchChatResponseReceiptSchema.safeParse({
          ...admitted,
          snapshotRevision: value.snapshotRevision,
        }).success
      ).toBe(true);
    }
    for (const count of [-1, 0, 17]) {
      const snapshotRevision = (
        BigInt(request.contextStartSequence) + BigInt(count)
      ).toString();
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        snapshotRevision,
      });
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        snapshotRevision,
      });
    }
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse({
        ...request,
        snapshotRevision: "2",
        contextStartSequence: "1",
      }).success
    ).toBe(true);
    return reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      snapshotRevision: "1",
      contextStartSequence: "1",
    });
  });

  it("uses exact prefix arithmetic above Number precision rather than rounded ordinals", () => {
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse(request).success
    ).toBe(true);
    reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      contextStartSequence: request.snapshotRevision,
    });
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse({
        ...request,
        contextStartSequence: "9007199254740977",
      }).success
    ).toBe(true);
    return reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      contextStartSequence: "9007199254740976",
    });
  });

  it("accepts the 30 digit boundary and rejects overflow in requests and receipts", () => {
    const contextStartSequence = (BigInt(maximum) - 16n).toString();
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse({
        ...request,
        snapshotRevision: maximum,
        contextStartSequence,
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatResponseReceiptSchema.safeParse({
        ...admitted,
        snapshotRevision: maximum,
        contextStartSequence,
      }).success
    ).toBe(true);
    const snapshotRevision = (BigInt(maximum) + 1n).toString();
    reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      snapshotRevision,
      contextStartSequence: maximum,
    });
    return reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      snapshotRevision,
      contextStartSequence: maximum,
    });
  });

  it("turns malformed numeric inputs into ordinary schema failures without arithmetic throws", () => {
    for (const value of [
      "",
      "0",
      "-1",
      "+2",
      "02",
      "2.0",
      "2e1",
      "2n",
      "NaN",
      "Infinity",
      "2\n",
      " 2",
      "2 ",
      "x",
      "9".repeat(31),
      2,
      null,
    ]) {
      for (const key of ["snapshotRevision", "contextStartSequence"]) {
        reject(VertexResearchChatRequestResponseInputSchema, {
          ...request,
          [key]: value,
        });
        reject(VertexResearchChatResponseReceiptSchema, {
          ...admitted,
          [key]: value,
        });
      }

      for (const key of ["sequence", "threadRevision"]) {
        reject(VertexResearchChatReadResponseOutputSchema, {
          ...appended,
          delivery: {
            ...appended.delivery,
            message: { ...message, [key]: value },
          },
        });
      }
    }
  });

  it("measures retrieval query bounds in UTF-16 without normalizing or truncating", () => {
    for (const retrievalQuery of [
      "x".repeat(10),
      "x".repeat(2000),
      "\u{1d11e}".repeat(5),
      "\u{1d11e}".repeat(1000),
      " e\u0301 literal text ",
    ]) {
      expect(
        VertexResearchChatRequestResponseInputSchema.parse({
          ...request,
          retrievalQuery,
        }).retrievalQuery
      ).toBe(retrievalQuery);
    }

    for (const retrievalQuery of [
      "x".repeat(9),
      "x".repeat(2001),
      "\u{1d11e}".repeat(1001),
      "",
    ]) {
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        retrievalQuery,
      });
    }
  });

  it("rejects blank, control, directional, unpaired-surrogate and multiline queries", () => {
    for (const retrievalQuery of [
      " ".repeat(10),
      "\u00a0".repeat(10),
      "\ufeff".repeat(10),
      "synthetic\tquery",
      "synthetic\rquery",
      "synthetic\nquery",
      "synthetic\r\nquery",
      "synthetic\u0000query",
      "synthetic\u000bquery",
      "synthetic\u007fquery",
      "synthetic\u0085query",
      "synthetic\u061cquery",
      "synthetic\u200equery",
      "synthetic\u202equery",
      "synthetic\u2066query",
      "synthetic\ud800query",
      "synthetic\udfffquery",
    ]) {
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        retrievalQuery,
      });
    }
  });

  it("does not implicitly shorten a valid original human body into a retrieval query", () => {
    const body = "synthetic human text ".repeat(200);
    expect(
      VertexResearchChatSendMessageInputSchema.shape.body.safeParse(body)
        .success
    ).toBe(true);
    reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      retrievalQuery: body,
    });
    const { retrievalQuery: _query, ...withoutQuery } = request;
    return reject(VertexResearchChatRequestResponseInputSchema, {
      ...withoutQuery,
      body,
    });
  });

  it("requires full-string identifiers for every caller selector", () => {
    for (const key of [
      "accountAlias",
      "threadId",
      "parentMessageId",
      "participantId",
      "idempotencyKey",
    ]) {
      for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", " "]) {
        reject(VertexResearchChatRequestResponseInputSchema, {
          ...request,
          [key]: `synthetic-id${suffix}`,
        });
      }
    }

    for (const key of ["accountAlias", "threadId", "idempotencyKey"]) {
      reject(VertexResearchChatReadResponseInputSchema, {
        ...selectors,
        [key]: "synthetic-id\n",
      });
    }
  });

  it("enforces identifier and digest limits without imposing invented namespaces", () => {
    expect(
      VertexResearchChatRequestResponseInputSchema.safeParse({
        ...request,
        participantId: "0",
        parentMessageId: "X".repeat(160),
      }).success
    ).toBe(true);
    expect(
      VertexResearchChatResponseReceiptSchema.safeParse({
        ...admitted,
        responseRequestId: "0",
        admission: {
          ...admission,
          runId: "0",
          eventId: "0",
          collectionId: "0",
          proposal: { artifactId: "0", sha256: "0".repeat(64) },
        },
      }).success
    ).toBe(true);
    for (const participantId of ["", "-id", "id/child", "X".repeat(161)]) {
      reject(VertexResearchChatRequestResponseInputSchema, {
        ...request,
        participantId,
      });
    }

    for (const requestSha256 of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      `sha256:${"a".repeat(64)}`,
    ]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        requestSha256,
      });
    }
  });

  it("requires full-string identifiers and digests at every receipt nesting level", () => {
    for (const key of [
      "accountAlias",
      "threadId",
      "ownerActorId",
      "responseRequestId",
      "parentMessageId",
      "participantId",
      "idempotencyKey",
    ]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        [key]: "synthetic-id\n",
      });
    }
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", " "]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        requestSha256: "a".repeat(64) + suffix,
      });
      for (const key of [
        "bindingSha256",
        "contextSha256",
        "participantConfigSha256",
      ]) {
        reject(VertexResearchChatResponseReceiptSchema, {
          ...admitted,
          admission: { ...admission, [key]: "a".repeat(64) + suffix },
        });
      }
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        admission: {
          ...admission,
          proposal: { ...admission.proposal, sha256: "a".repeat(64) + suffix },
        },
      });
    }
    for (const key of ["collectionId", "runId", "eventId"]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        admission: { ...admission, [key]: "synthetic-id\n" },
      });
    }
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      admission: {
        ...admission,
        proposal: { ...admission.proposal, artifactId: "synthetic-id\n" },
      },
    });
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      job: { ...appended.job, jobId: "synthetic-id\n" },
    });
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      delivery: {
        ...appended.delivery,
        message: { ...message, messageId: "synthetic-id\n" },
      },
    });
  });

  it("aliases immutable request output to the original receipt schema", () => {
    expect(VertexResearchChatRequestResponseOutputSchema).toBe(
      VertexResearchChatResponseReceiptSchema
    );

    for (const receipt of [unavailable, admitted]) {
      expect(VertexResearchChatResponseReceiptSchema.parse(receipt)).toEqual(
        receipt
      );
      expect(
        VertexResearchChatRequestResponseOutputSchema.parse(receipt)
      ).toEqual(receipt);
    }
  });

  it("never invents a future job identity in either immutable receipt", () => {
    for (const receipt of [unavailable, admitted]) {
      for (const jobId of ["synthetic-job", "queued", "", undefined]) {
        reject(VertexResearchChatResponseReceiptSchema, { ...receipt, jobId });
      }
      expect(
        VertexResearchChatResponseReceiptSchema.parse(receipt).jobId
      ).toBeNull();
    }
  });

  it("requires exactly unavailable reasons with no admission or admitted pins with no reasons", () => {
    for (const value of [
      { ...unavailable, reasonCodes: [] },
      { ...unavailable, admission },
      { ...admitted, reasonCodes: ["participant-unavailable"] },
      { ...admitted, admission: null },
      { ...admitted, status: "queued" },
      { ...admitted, status: "not-requested" },
    ]) {
      reject(VertexResearchChatResponseReceiptSchema, value);
    }

    for (const key of Object.keys(admission)) {
      const incomplete: Record<string, unknown> = { ...admission };
      delete incomplete[key];
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        admission: incomplete,
      });
    }
  });

  it("rejects unknown, duplicate, empty and oversized unavailable reason arrays", () => {
    for (const reasonCodes of [
      [],
      ["unknown"],
      ["rights-denied", "rights-denied"],
      new Array(33).fill("deadline"),
    ]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...unavailable,
        reasonCodes,
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...blocked,
        delivery: { status: "unavailable", reasonCodes },
      });
    }
    expect(
      VertexResearchChatResponseReceiptSchema.safeParse({
        ...unavailable,
        reasonCodes: reasons,
      }).success
    ).toBe(true);
    return expect(
      VertexResearchChatReadResponseOutputSchema.safeParse({
        ...blocked,
        delivery: { status: "unavailable", reasonCodes: reasons },
      }).success
    ).toBe(true);
  });

  it("accepts absent and admitted-but-not-bound observations without synthesizing a job", () => {
    expect(VertexResearchChatReadResponseOutputSchema.parse(absent)).toEqual(
      absent
    );
    expect(VertexResearchChatReadResponseOutputSchema.parse(pending)).toEqual(
      pending
    );
    expect(VertexResearchChatReadResponseOutputSchema.parse(blocked)).toEqual(
      blocked
    );
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...pending,
      job: { state: "unknown" },
    });
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...pending,
      job: { jobId: null, state: "unknown" },
    });
  });

  it("accepts all six actual owned job states only as separate current observations", () => {
    for (const state of states) {
      const observation = {
        ...blocked,
        job: { jobId: "synthetic-job", state },
      };
      expect(
        VertexResearchChatReadResponseOutputSchema.parse(observation).job?.state
      ).toBe(state);
      expect(
        VertexResearchChatReadResponseOutputSchema.parse(observation).receipt
          .jobId
      ).toBeNull();
    }

    for (const state of [
      "queued",
      "completed",
      "not-found",
      "unavailable",
      "leased\n",
    ]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...blocked,
        job: { jobId: "synthetic-job", state },
      });
    }
  });

  it("only permits not-applicable for unavailable receipts without a job", () => {
    for (const delivery of [
      pending.delivery,
      blocked.delivery,
      appended.delivery,
    ]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...absent,
        delivery,
      });
    }
    for (const state of states) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...absent,
        job: { jobId: "synthetic-job", state },
      });
    }
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...pending,
      delivery: absent.delivery,
    });
  });

  it("permits pending only for unbound, leased or running jobs", () => {
    for (const state of ["leased", "running"]) {
      expect(
        VertexResearchChatReadResponseOutputSchema.safeParse({
          ...pending,
          job: { jobId: "synthetic-job", state },
        }).success
      ).toBe(true);
    }

    for (const state of ["succeeded", "failed", "cancelled", "unknown"]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...pending,
        job: { jobId: "synthetic-job", state },
      });
    }
  });

  it("requires an actual succeeded job for an appended historical reference", () => {
    expect(VertexResearchChatReadResponseOutputSchema.parse(appended)).toEqual(
      appended
    );
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      job: null,
    });
    for (const state of [
      "leased",
      "running",
      "failed",
      "cancelled",
      "unknown",
    ]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        job: { ...appended.job, state },
      });
    }
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      receipt: unavailable,
    });
  });

  it("requires an appended sequence after the captured high-water with exact next revision", () => {
    const before = {
      ...message,
      sequence: "9007199254740992",
      threadRevision: "9007199254740993",
    };
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      delivery: { ...appended.delivery, message: before },
    });
    for (const threadRevision of [message.sequence, "9007199254740995"]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        delivery: {
          ...appended.delivery,
          message: { ...message, threadRevision },
        },
      });
    }
    const later = {
      ...message,
      sequence: "9007199254740995",
      threadRevision: "9007199254740996",
    };
    return expect(
      VertexResearchChatReadResponseOutputSchema.safeParse({
        ...appended,
        delivery: { ...appended.delivery, message: later },
      }).success
    ).toBe(true);
  });

  it("rejects appended revision overflow while accepting the highest representable next revision", () => {
    const highest = {
      ...message,
      sequence: (BigInt(maximum) - 1n).toString(),
      threadRevision: maximum,
    };
    expect(
      VertexResearchChatReadResponseOutputSchema.safeParse({
        ...appended,
        delivery: { ...appended.delivery, message: highest },
      }).success
    ).toBe(true);
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      delivery: {
        ...appended.delivery,
        message: {
          ...message,
          sequence: maximum,
          threadRevision: (BigInt(maximum) + 1n).toString(),
        },
      },
    });
  });

  it("rejects unknown fields at each input, receipt, job, delivery and message level", () => {
    reject(VertexResearchChatRequestResponseInputSchema, {
      ...request,
      extra: true,
    });
    reject(VertexResearchChatReadResponseInputSchema, {
      ...selectors,
      extra: true,
    });
    reject(VertexResearchChatResponseReceiptSchema, {
      ...unavailable,
      extra: true,
    });
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      extra: true,
    });
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      admission: { ...admission, extra: true },
    });
    reject(VertexResearchChatResponseReceiptSchema, {
      ...admitted,
      admission: {
        ...admission,
        proposal: { ...admission.proposal, extra: true },
      },
    });
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      extra: true,
    });
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      job: { ...appended.job, extra: true },
    });
    for (const observation of [absent, pending, blocked, appended]) {
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...observation,
        delivery: { ...observation.delivery, extra: true },
      });
    }
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      delivery: { ...appended.delivery, message: { ...message, extra: true } },
    });
  });

  it("never exposes copied bodies, private profiles, leases, fences, outputs or citations", () => {
    for (const key of [
      "body",
      "citations",
      "retrievalQuery",
      "context",
      "personaText",
      "sourcePreview",
      "privateProfile",
      "lease",
      "fence",
      "outputArtifactIds",
      "outputRef",
      "error",
      "leaseToken",
      "contentVisible",
    ]) {
      const leak = { [key]: "synthetic-private-content" };
      reject(VertexResearchChatResponseReceiptSchema, { ...admitted, ...leak });
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        admission: { ...admission, ...leak },
      });
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        admission: {
          ...admission,
          proposal: { ...admission.proposal, ...leak },
        },
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        ...leak,
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        job: { ...appended.job, ...leak },
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        delivery: { ...appended.delivery, ...leak },
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        delivery: { ...appended.delivery, message: { ...message, ...leak } },
      });
    }
  });

  it("compares checkedAt against the immutable recordedAt at exact nanosecond precision", () => {
    expect(
      VertexResearchChatReadResponseOutputSchema.safeParse(appended).success
    ).toBe(true);
    expect(
      VertexResearchChatReadResponseOutputSchema.safeParse({
        ...appended,
        checkedAt: "2026-09-24T00:00:00.000000002Z",
      }).success
    ).toBe(true);
    reject(VertexResearchChatReadResponseOutputSchema, {
      ...appended,
      checkedAt: "2026-09-24T00:00:00Z",
    });

    for (const checkedAt of [
      "2026-09-24T01:00:00.000000001+01:00",
      "2026-09-23T23:00:00.000000001-01:00",
    ]) {
      expect(
        VertexResearchChatReadResponseOutputSchema.parse({
          ...appended,
          checkedAt,
        }).checkedAt
      ).toBe(checkedAt);
    }
  });

  it("handles Gregorian edge dates, pre-epoch time and year zero without Number milliseconds", () => {
    for (const recordedAt of [
      "0000-02-29T00:00:00Z",
      "1969-12-31T23:59:59.999999999Z",
      "2000-02-29T00:00:00Z",
      "9999-12-31T23:59:59.999999999Z",
    ]) {
      const receipt = { ...admitted, recordedAt };
      expect(
        VertexResearchChatResponseReceiptSchema.parse(receipt).recordedAt
      ).toBe(recordedAt);
      expect(
        VertexResearchChatReadResponseOutputSchema.safeParse({
          ...pending,
          receipt,
          checkedAt: recordedAt,
        }).success
      ).toBe(true);
    }
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...pending,
      receipt: { ...admitted, recordedAt: "1969-12-31T23:59:59.999999999Z" },
      checkedAt: "1969-12-31T23:59:59.999999998Z",
    });
  });

  it("cleanly rejects malformed calendar, offset, precision and non-full timestamps", () => {
    for (const value of [
      "invalid",
      "",
      "2026-02-30T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-09-24T24:00:00Z",
      "2026-09-24T00:00:60Z",
      "2026-09-24T00:00Z",
      "2026-09-24T00:00:00",
      "2026-09-24T00:00:00+24:00",
      "2026-09-24T00:00:00+00:60",
      "2026-09-24T00:00:00.0000000001Z",
      `${common.recordedAt}\n`,
      null,
      0,
    ]) {
      reject(VertexResearchChatResponseReceiptSchema, {
        ...admitted,
        recordedAt: value,
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        checkedAt: value,
      });
      reject(VertexResearchChatReadResponseOutputSchema, {
        ...appended,
        receipt: { ...admitted, recordedAt: value },
      });
    }
  });

  it("deeply freezes detached output objects and arrays while leaving source values untouched", () => {
    const source = structuredClone(appended);
    const parsed = VertexResearchChatReadResponseOutputSchema.parse(source);
    expectFrozen(parsed);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.receipt.admission.proposal)).toBe(false);
    expect(parsed).not.toBe(source);
    expect(parsed.receipt).not.toBe(source.receipt);
    expect(parsed.receipt.admission?.proposal).not.toBe(
      source.receipt.admission.proposal
    );
    expect(Reflect.set(parsed.delivery, "status", "pending")).toBe(false);
    if (parsed.receipt.status === "admitted") {
      expect(
        Reflect.set(parsed.receipt.admission.proposal, "artifactId", "forged")
      ).toBe(false);
      expect(() =>
        Array.prototype.push.call(parsed.receipt.reasonCodes, "rights-denied")
      ).toThrow();
    }

    for (const value of [
      VertexResearchChatResponseReceiptSchema.parse(unavailable),
      VertexResearchChatResponseReceiptSchema.parse(admitted),
      VertexResearchChatReadResponseOutputSchema.parse(blocked),
    ]) {
      expectFrozen(value);
    }
  });

  it("exposes inferred DTO types with nested readonly references rather than mutable status receipts", () => {
    expectTypeOf<VertexResearchChatResponseReasonCode>().toEqualTypeOf<
      z.infer<typeof VertexResearchChatResponseReasonCodeSchema>
    >();
    expectTypeOf<VertexResearchChatRequestResponseInput>().toEqualTypeOf<
      z.infer<typeof VertexResearchChatRequestResponseInputSchema>
    >();
    expectTypeOf<VertexResearchChatReadResponseInput>().toEqualTypeOf<
      z.infer<typeof VertexResearchChatReadResponseInputSchema>
    >();
    expectTypeOf<VertexResearchChatResponseReceipt>().toEqualTypeOf<
      z.infer<typeof VertexResearchChatResponseReceiptSchema>
    >();
    expectTypeOf<VertexResearchChatRequestResponseOutput>().toEqualTypeOf<VertexResearchChatResponseReceipt>();
    expectTypeOf<VertexResearchChatReadResponseOutput>().toEqualTypeOf<
      z.infer<typeof VertexResearchChatReadResponseOutputSchema>
    >();
    type Accepted = Extract<
      VertexResearchChatResponseReceipt,
      { status: "admitted" }
    >;
    type Appended = Extract<
      VertexResearchChatReadResponseOutput["delivery"],
      { status: "appended" }
    >;
    expectTypeOf<Accepted["admission"]["proposal"]>().toEqualTypeOf<{
      readonly artifactId: string;
      readonly sha256: string;
    }>();
    expectTypeOf<Appended["message"]>().toEqualTypeOf<{
      readonly messageId: string;
      readonly sequence: string;
      readonly threadRevision: string;
    }>();
    expectTypeOf<
      VertexResearchChatResponseReceipt["jobId"]
    >().toEqualTypeOf<null>();
    return expectTypeOf<
      VertexResearchChatResponseReceipt["executionAuthorized"]
    >().toEqualTypeOf<false>();
  });

  it("rejects accessor and noncanonical graphs before reading untrusted properties", () => {
    let accesses = 0;
    const accessor = { ...request };
    Object.defineProperty(accessor, "retrievalQuery", {
      enumerable: true,
      get: () => {
        accesses += 1;
        return request.retrievalQuery;
      },
    });
    reject(VertexResearchChatRequestResponseInputSchema, accessor);
    expect(accesses).toBe(0);
    const hidden = { ...admitted };
    Object.defineProperty(hidden, "body", {
      enumerable: false,
      value: "synthetic-hidden-copy",
    });
    reject(VertexResearchChatResponseReceiptSchema, hidden);
    const symbol = {
      ...appended,
      [Symbol("synthetic")]: "synthetic-hidden-copy",
    };
    return reject(VertexResearchChatReadResponseOutputSchema, symbol);
  });

  it("demonstrates shape and hashes confer no participant, policy, content visibility or compute authority", async () => {
    // A completely fictional participant and unrelated well-shaped pins parse:
    // no schema can attest that these rows, policy decisions or artifacts exist.
    const fictional = VertexResearchChatRequestResponseInputSchema.parse({
      ...request,
      participantId: "nonexistent-expert",
      parentMessageId: "nonexistent-parent",
    });
    const rawHash = await hashArtifact(canonicalArtifactJson(fictional));
    const changedHash = await hashArtifact(
      canonicalArtifactJson({
        ...fictional,
        retrievalQuery: `${fictional.retrievalQuery} `,
      })
    );
    expect(rawHash).not.toBe(changedHash);
    const receipt = VertexResearchChatResponseReceiptSchema.parse({
      ...admitted,
      requestSha256: rawHash,
      participantId: fictional.participantId,
      parentMessageId: fictional.parentMessageId,
    });
    expect(receipt.executionAuthorized).toBe(false);
    expect(receipt.jobId).toBeNull();
    expect(receipt.admission?.bindingSha256).not.toBe(receipt.requestSha256);
    const read = VertexResearchChatReadResponseOutputSchema.parse({
      ...appended,
      receipt,
    });
    expect(Object.keys(read.delivery)).toEqual(["status", "message"]);
    expect(read.executionAuthorized).toBe(false);
    return reject(VertexResearchChatReadResponseOutputSchema, {
      ...read,
      contentVisible: true,
    });
  });
});
