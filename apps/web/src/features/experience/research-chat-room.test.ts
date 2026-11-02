import { describe, expect, it } from "vitest";
import {
  assertResearchRoomSnapshot,
  sameResearchChatRequest,
} from "./research-chat-room.tsx";
import {
  VertexResearchChatAgentReferenceMessageSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
} from "@darkfactory/api/vertex";
import {
  researchDeadline,
  researchLifetime,
  researchLifetimeCurrent,
  researchLifetimeRemaining,
  researchResponseRequest,
  selectResearchHumanWindow,
} from "./research-chat-conversation.ts";

const thread = {
  schemaVersion: "1.0.0",
  accountAlias: "synthetic-account",
  environment: "research",
  executionAuthorized: false,
  threadId: "synthetic-room",
  title: "Synthetic room",
  ownerActorId: "synthetic-human",
  participantIds: ["synthetic-expert"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  revision: "2",
} as const;
const message = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  threadId: "synthetic-room",
  messageId: "synthetic-message",
  sequence: "1",
  author: { kind: "user", actorId: "synthetic-human" },
  kind: "statement",
  body: "Synthetic question",
  citations: [],
  recordedAt: "2026-01-01T00:00:01Z",
} as const;
const page = {
  schemaVersion: "1.0.0",
  executionAuthorized: false,
  thread,
  snapshotRevision: "2",
  highWaterSequence: "1",
  items: [message],
  nextCursor: null,
} as const;

describe("research room snapshot and explicit retry boundaries", () => {
  it("accepts a fixed human transcript even when its current head has advanced", () => {
    expect(() => assertResearchRoomSnapshot(page)).not.toThrow();
    expect(() =>
      assertResearchRoomSnapshot({
        ...page,
        thread: { ...thread, revision: "3" },
      })
    ).not.toThrow();
    return expect(() =>
      assertResearchRoomSnapshot({
        ...page,
        thread: { ...thread, revision: "1" },
        snapshotRevision: "1",
        highWaterSequence: "0",
        items: [],
      })
    ).not.toThrow();
  });

  it("refuses cross-thread and cross-owner human messages without admitting agents", () => {
    for (const candidate of [
      { ...page, items: [{ ...message, threadId: "other-room" }] },
      {
        ...page,
        items: [
          { ...message, author: { kind: "user", actorId: "other-human" } },
        ],
      },
      {
        ...page,
        items: [
          {
            ...message,
            author: {
              kind: "agent",
              participantId: "synthetic-expert",
              runId: "run",
            },
          },
        ],
      },
    ]) {
      expect(() =>
        assertResearchRoomSnapshot(candidate as unknown as typeof page)
      ).toThrow();
    }
  });

  it("validates final tails against high water rather than mutable thread revision", () => {
    for (const candidate of [
      { ...page, thread: { ...thread, revision: "1" } },
      { ...page, snapshotRevision: "3" },
      { ...page, items: [] },
      { ...page, items: [{ ...message, sequence: "2" }] },
      { ...page, highWaterSequence: "01" },
    ]) {
      expect(() => assertResearchRoomSnapshot(candidate)).toThrow();
    }
  });

  it("permits bounded earlier pages and compares large snapshot ordinals exactly", () => {
    expect(() =>
      assertResearchRoomSnapshot({
        ...page,
        thread: { ...thread, revision: "3" },
        snapshotRevision: "3",
        highWaterSequence: "2",
        nextCursor: "synthetic_cursor",
      })
    ).not.toThrow();
    const large = {
      ...page,
      thread: { ...thread, revision: "9007199254740995" },
      snapshotRevision: "9007199254740994",
      highWaterSequence: "9007199254740993",
      items: [{ ...message, sequence: "9007199254740993" }],
    };
    expect(() => assertResearchRoomSnapshot(large)).not.toThrow();
    return expect(() =>
      assertResearchRoomSnapshot({
        ...large,
        items: [{ ...message, sequence: "9007199254740992" }],
      })
    ).toThrow();
  });

  return it("retains a retry key only for an exactly unchanged immutable request", () => {
    const request = {
      accountAlias: "synthetic-account",
      environment: "research",
      threadId: "synthetic-room",
      expectedRevision: "2",
      body: "Question\nline two",
      requestedParticipantIds: [],
      mode: "discuss",
      idempotencyKey: "fixed-key",
    };
    expect(sameResearchChatRequest(request, { ...request })).toBe(true);
    for (const change of [
      { body: "different" },
      { expectedRevision: "3" },
      { threadId: "other" },
      { idempotencyKey: "new-key" },
      { requestedParticipantIds: ["expert"] },
    ]) {
      expect(sameResearchChatRequest(request, { ...request, ...change })).toBe(
        false
      );
    }
    return expect(
      sameResearchChatRequest(request, { ...request, hidden: undefined })
    ).toBe(false);
  });
});

describe("explicit human windows and conservative private lifetimes", () => {
  const digest = "a".repeat(64);
  const reference = VertexResearchChatAgentReferenceMessageSchema.parse({
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    threadId: thread.threadId,
    messageId: "reference-2",
    sequence: "2",
    kind: "advisory-reference",
    author: { kind: "agent", participantId: "synthetic-expert", runId: "run" },
    parentMessageId: message.messageId,
    replyToMessageId: message.messageId,
    recordedAt: message.recordedAt,
    response: {
      responseRequestId: "response",
      planId: "plan",
      planSha256: digest,
      requestSha256: digest,
      contextSha256: digest,
      snapshotRevision: "2",
      contextStartSequence: "1",
      jobId: "job",
      traceId: "trace",
      eventId: "event",
      runArtifact: { artifactId: "run", artifactSha256: digest },
      advisoryArtifact: { artifactId: "advisory", artifactSha256: digest },
      fenceAcknowledgementsSha256: digest,
    },
  });
  it("selects H3 H4 from H1 A2 H3 H4 without silently filtering or renumbering", () => {
    const mixed = VertexResearchChatReadTranscriptPageOutputSchema.parse({
      ...page,
      thread: { ...thread, revision: "5" },
      snapshotRevision: "5",
      highWaterSequence: "4",
      items: [
        message,
        reference,
        { ...message, messageId: "human-3", sequence: "3" },
        { ...message, messageId: "human-4", sequence: "4" },
      ],
    });
    expect(
      selectResearchHumanWindow(mixed, "3", "4").map((item) => item.sequence)
    ).toEqual(["3", "4"]);
    expect(
      researchResponseRequest(
        mixed,
        "3",
        "4",
        "synthetic-expert",
        "Literal retrieval query",
        "original-key"
      )
    ).toMatchObject({
      parentMessageId: "human-4",
      snapshotRevision: "5",
      contextStartSequence: "3",
      idempotencyKey: "original-key",
    });
    expect(() => selectResearchHumanWindow(mixed, "1", "4")).toThrow();
    expect(() => selectResearchHumanWindow(mixed, "2", "4")).toThrow();
    return expect(() => selectResearchHumanWindow(mixed, "3", "5")).toThrow();
  });

  it("uses the original human-ending snapshot before a trailing agent reference", () => {
    const second = { ...message, messageId: "human-2", sequence: "2" };
    const trailing = {
      ...reference,
      sequence: "3",
      messageId: "reference-3",
      parentMessageId: second.messageId,
    };
    const mixed = VertexResearchChatReadTranscriptPageOutputSchema.parse({
      ...page,
      thread: { ...thread, revision: "4" },
      snapshotRevision: "4",
      highWaterSequence: "3",
      items: [message, second, trailing],
    });
    expect(
      researchResponseRequest(
        mixed,
        "1",
        "2",
        "synthetic-expert",
        "Literal retrieval query",
        "original-key"
      )
    ).toMatchObject({
      parentMessageId: "human-2",
      snapshotRevision: "3",
      contextStartSequence: "1",
    });
    return expect(() => selectResearchHumanWindow(mixed, "1", "3")).toThrow();
  });

  it("rejects omitted bounds, gaps and more than sixteen rather than truncating", () => {
    expect(() => selectResearchHumanWindow(page, "", "1")).toThrow();
    expect(() => selectResearchHumanWindow(page, "01", "1")).toThrow();
    expect(() =>
      selectResearchHumanWindow({ ...page, highWaterSequence: "17" }, "1", "17")
    ).toThrow();
    expect(() =>
      selectResearchHumanWindow(
        {
          ...page,
          highWaterSequence: "3",
          items: [{ ...message, sequence: "3" }],
        },
        "1",
        "3"
      )
    ).toThrow();
    expect(() =>
      researchResponseRequest(
        page,
        "1",
        "1",
        "synthetic-expert",
        "short",
        "key"
      )
    ).toThrow();
    return expect(() =>
      researchResponseRequest(
        page,
        "1",
        "1",
        "synthetic-expert",
        "literal query\nsecond",
        "key"
      )
    ).toThrow();
  });

  it("consumes network delay and rounds fractional authority bounds down", () => {
    const wall = Date.parse("2026-09-25T00:00:00.000Z");
    const deadline = researchDeadline(
      "2026-09-25T00:00:00.000000001Z",
      "2026-09-25T00:00:01.000000000Z",
      100,
      wall
    );
    expect(deadline).toBe(1099);
    expect(deadline - 900).toBe(199);
    expect(
      researchDeadline(
        "2026-09-25T00:00:00.000Z",
        "2026-09-25T00:00:00.000999999Z",
        100,
        wall
      )
    ).toBe(100);
    expect(
      researchDeadline(
        "2026-09-25T00:00:00.000Z",
        "2026-09-25T01:00:00.000Z",
        100,
        wall
      )
    ).toBe(15_100);
    expect(
      researchDeadline(
        "2026-09-25T00:00:00.000Z",
        "2026-09-25T00:00:01.000Z",
        100,
        wall + 900
      )
    ).toBe(200);
    return expect(researchDeadline("invalid", "invalid", 100, wall)).toBe(100);
  });

  return it("retains both original-start deadlines across suspended monotonic time and wall rollback", () => {
    const wall = Date.parse("2026-09-25T00:00:00.000Z");
    const lifetime = researchLifetime(
      "2026-09-25T00:00:00.000000001Z",
      "2026-09-25T00:00:01.000000000Z",
      100,
      wall
    );
    expect(lifetime).toEqual({ deadline: 1099, wallDeadline: wall + 999 });
    expect(researchLifetimeCurrent(lifetime, 100, wall + 998)).toBe(true);
    expect(researchLifetimeRemaining(lifetime, 100, wall + 998)).toBe(1);
    expect(researchLifetimeCurrent(lifetime, 100, wall + 999)).toBe(false);
    expect(researchLifetimeRemaining(lifetime, 100, wall + 20_000)).toBe(0);
    expect(researchLifetimeCurrent(lifetime, 1099, wall - 50_000)).toBe(false);
    expect(researchLifetimeRemaining(lifetime, 1098.75, wall - 50_000)).toBe(0);
    expect(
      researchLifetimeCurrent(
        researchLifetime("invalid", "invalid", 100, wall),
        100,
        wall
      )
    ).toBe(false);
    return expect(
      researchLifetimeCurrent(
        {
          deadline: Number.POSITIVE_INFINITY,
          wallDeadline: Number.POSITIVE_INFINITY,
        },
        100,
        wall
      )
    ).toBe(false);
  });
});
