import { describe, expect, it, vi } from "vitest";
import {
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatCopyCleanupReceiptSchema,
  VertexResearchChatRequestCopyCleanupOutputSchema,
  VertexResearchChatReadCopyCleanupOutputSchema,
} from "./contracts/vertex-research-chat-copy-cleanup.ts";

const input = {
  accountAlias: "fixture-research",
  environment: "research",
  threadId: "thread-a",
  responseRequestId: `response-${"a".repeat(64)}`,
  idempotencyKey: "original-cleanup-key",
};
const receipt = {
  ...input,
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  status: "requested",
  ownerActorId: "fixture-member",
  cleanupRequestId: `copy-cleanup-${"b".repeat(64)}`,
  requestSha256: "b".repeat(64),
  recordedAt: "2026-09-24T00:00:00Z",
  targetKinds: ["context", "model-input", "derived-output"],
};
const inputs = [
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
];

describe("metadata-only explicit cleanup DTO", () => {
  it("detaches and freezes exact five-field inputs and original receipt", () => {
    for (const schema of inputs) {
      const parsed = schema.parse(input);
      expect(parsed).toEqual(input);
      expect(parsed).not.toBe(input);
      expect(Object.keys(parsed).sort()).toEqual([
        "accountAlias",
        "environment",
        "idempotencyKey",
        "responseRequestId",
        "threadId",
      ]);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
    const parsed = VertexResearchChatCopyCleanupReceiptSchema.parse(receipt);
    expect(parsed).toEqual(receipt);
    expect(parsed).not.toBe(receipt);
    expect(parsed.targetKinds).not.toBe(receipt.targetKinds);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.targetKinds)).toBe(true);
    expect(VertexResearchChatRequestCopyCleanupOutputSchema).toBe(
      VertexResearchChatCopyCleanupReceiptSchema
    );
    return expect(VertexResearchChatReadCopyCleanupOutputSchema).toBe(
      VertexResearchChatCopyCleanupReceiptSchema
    );
  });

  for (const field of [
    "actorId",
    "ownerActorId",
    "principal",
    "human",
    "approved",
    "issuer",
    "profile",
    "targetKinds",
    "body",
    "history",
    "ttl",
    "expiresAt",
    "physicalKey",
    "closureId",
    "inventorySha256",
    "ready",
    "proof",
  ]) {
    it(`rejects caller-controlled ${field}`, () => {
      for (const schema of inputs) {
        expect(schema.safeParse({ ...input, [field]: true }).success).toBe(
          false
        );
      }
    });
  }

  it("requires every selector and rejects environment and full-string identifier confusion", () => {
    for (const schema of inputs) {
      for (const key of Object.keys(input)) {
        const missing: Record<string, unknown> = { ...input };
        delete missing[key];
        expect(schema.safeParse(missing).success).toBe(false);
      }
      for (const environment of ["paper", "live", "Research", "research\n"]) {
        expect(schema.safeParse({ ...input, environment }).success).toBe(false);
      }
      for (const key of [
        "accountAlias",
        "threadId",
        "idempotencyKey",
      ] as const) {
        for (const value of ["", "x\n", " x", "x ", "/x", "x".repeat(161)]) {
          expect(schema.safeParse({ ...input, [key]: value }).success).toBe(
            false
          );
        }
      }

      for (const responseRequestId of [
        "response-a",
        `response-${"A".repeat(64)}`,
        `${input.responseRequestId}\n`,
        `response-${"a".repeat(65)}`,
        "a".repeat(64),
      ]) {
        expect(schema.safeParse({ ...input, responseRequestId }).success).toBe(
          false
        );
      }
    }
  });

  it("rejects accessors, hidden and symbol fields and prototypes without invoking getters", () => {
    const getter = vi.fn(() => input.threadId);
    const accessor = { ...input };
    Object.defineProperty(accessor, "threadId", {
      enumerable: true,
      get: getter,
    });
    const hidden = Object.defineProperty({ ...input }, "hidden", {
      value: true,
      enumerable: false,
    });
    const symbol = { ...input, [Symbol("hidden")]: true };
    const inherited = Object.assign(Object.create({ extra: true }), input);
    for (const schema of inputs) {
      for (const raw of [accessor, hidden, symbol, inherited]) {
        expect(schema.safeParse(raw).success).toBe(false);
      }
    }
    expect(getter).not.toHaveBeenCalled();
    const nested = [...receipt.targetKinds];
    Object.defineProperty(nested, "0", { enumerable: true, get: getter });
    expect(
      VertexResearchChatCopyCleanupReceiptSchema.safeParse({
        ...receipt,
        targetKinds: nested,
      }).success
    ).toBe(false);
    return expect(getter).not.toHaveBeenCalled();
  });

  it("rejects physical state, target substitutions, invalid times and digest identities", () => {
    const changes: Record<string, unknown>[] = [
      { status: "complete" },
      { status: "closed" },
      { executionAuthorized: true },
      { checkedAt: receipt.recordedAt },
      { ready: true },
      { proof: "erased" },
      { profile: "private" },
      { body: "private" },
      { physicalKey: "private" },
      { targetKinds: ["context", "model-input"] },
      { targetKinds: ["derived-output", "model-input", "context"] },
      { targetKinds: ["context", "context", "derived-output"] },
      { targetKinds: [...receipt.targetKinds, "transcript"] },
      { recordedAt: "2026-02-30T00:00:00Z" },
      { recordedAt: `${receipt.recordedAt}\n` },
      { requestSha256: `${receipt.requestSha256}\n` },
      { cleanupRequestId: `copy-cleanup-${"c".repeat(64)}` },
      { ownerActorId: "member\n" },
    ];

    for (const change of changes) {
      expect(
        VertexResearchChatCopyCleanupReceiptSchema.safeParse({
          ...receipt,
          ...change,
        }).success
      ).toBe(false);
    }
  });
});
