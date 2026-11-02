import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  AT,
  LATER,
  END,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  answerText,
  readSelector,
  revokeGrant,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import {
  TIMEOUT,
  append,
  closures,
  contentInput,
  currentCallerGrants,
  eligibleResponse,
  head,
  history,
  messages,
  originalPins,
  preserveCallerBeyondOriginalDeadline,
} from "./vertex-research-chat-conversation-runtime-suite.test-support.ts";

// SOURCE ONLY: no execution, PostgreSQL concurrency, live provider/storage or
// operational qualification claim. All positive conversation authority below
// comes from the original owners, never fabricated agent/history/authority rows.
describe("private body is ephemeral; unavailable content never poisons human/reference history", () => {
  const deadlineCases = [
    ["original-storage-review", "external-read"],
    ["original-storage-review", "final-commit"],
    ["coincident-caller-and-original", "external-read"],
    ["coincident-caller-and-original", "final-commit"],
  ] as const;
  for (const unavailable of ["rights", "plan-expiry", "cleanup"] as const)
    it(
      `${unavailable} preserves metadata-only history and the original append ACK`,
      async () => {
        const f = await eligibleResponse(),
          agent = await append(f),
          selector = contentInput(f, agent.message.messageId);
        const immutableOriginal = originalPins(f),
          immutableHistory = canonicalArtifactJson(f.table(messages));
        if (unavailable === "plan-expiry")
          await preserveCallerBeyondOriginalDeadline(f);
        expect(originalPins(f)).toBe(immutableOriginal);
        const body = await f.runtime.conversation.readResponseContent(
          owner,
          selector
        );
        expect(body.status).toBe("available");
        if (body.status !== "available")
          throw new Error("Initial original body unavailable");
        if (unavailable === "plan-expiry") {
          const callerGrants = currentCallerGrants(f);
          expect(body.notAfter).toBe(END);
          expect(f.plan.expiresAt).toBe(END);
          for (const grant of callerGrants)
            expect(
              timestampToEpochNanoseconds(grant.expiresAt)
            ).toBeGreaterThan(timestampToEpochNanoseconds(body.notAfter));
        }
        if (unavailable === "rights") {
          const previous = f.corpus.metadata.rights;
          f.state.at = LATER;
          await f.store.putRights(
            { actorId: "fixture-grant-admin" },
            scope,
            "corpus",
            {
              ...previous,
              version: "2.0.0",
              status: "expired",
              checkedAt: LATER,
              expiresAt: LATER,
            }
          );
        } else if (unavailable === "plan-expiry") {
          f.state.at = body.notAfter;
        } else {
          // Actual original loss followed by independently authorized cleanup
          // fences the retained answer; closeApprovedInputs alone is input-only.
          await f.revokeContext();
          await f.runtime.drainApprovedCopyCleanup(f.cleaner, f.selector);
        }
        expect(
          await f.runtime.conversation.readResponseContent(owner, selector)
        ).toMatchObject({ status: "unavailable", reference: agent.message });
        expect(await history(f)).toMatchObject({
          items: [{ sequence: "1", author: { kind: "user" } }, agent.message],
        });
        expect(
          await f.runtime.conversation.readResponse(owner, readSelector(f))
        ).toMatchObject({ delivery: { status: "appended" } });
        expect(
          await f.runtime.conversation.appendResponse(owner, {
            ...f.selector,
            expectedRevision: "2",
          })
        ).toEqual(agent);
        expect(head(f)).toBe("3");
        expect(canonicalArtifactJson(f.table(messages))).toBe(immutableHistory);
        expect(
          f
            .table(messages)
            .find((row) => row["message_id"] === agent.message.messageId)?.[
            "response"
          ]
        ).toEqual(agent);
        expect(
          f
            .table(closures)
            .map((row) => row["domain"])
            .sort()
        ).toEqual(["derived", "inputs"]);
        const h3 = await f.append("3", `human-after-${unavailable}`);
        expect(h3).toMatchObject({
          threadRevision: "4",
          message: { sequence: "3", author: { kind: "user" } },
        });
        expect(canonicalArtifactJson(await history(f))).not.toContain(
          answerText
        );
        if (unavailable !== "rights") {
          const next = await f.runtime.conversation.prepareResponse(owner, {
            ...f.request,
            idempotencyKey: `new-human-after-${unavailable}`,
            contextStartSequence: "3",
            snapshotRevision: "4",
            parentMessageId: (h3["message"] as { messageId: string }).messageId,
          });
          if (unavailable === "plan-expiry") {
            const originalDeadline = f.plan.expiresAt;
            expect(f.state.at).toBe(originalDeadline);
            expect(next).toMatchObject({
              status: "unavailable",
              reasonCodes: ["model-input-preparation-unavailable"],
            });
            expect(next).not.toHaveProperty("preview");
            return expect(originalPins(f)).toBe(immutableOriginal);
          }
          return expect(next).toMatchObject({
            status: "prepared",
            preview: {
              context: {
                messageCount: 1,
                contextStartSequence: "3",
                snapshotRevision: "4",
              },
            },
          });
        }
        return;
      },
      TIMEOUT
    );

  it(
    "denies wrong owner, request-side session spoofing, thread and scope without closing the original family",
    async () => {
      const f = await eligibleResponse(),
        agent = await append(f),
        selector = contentInput(f, agent.message.messageId),
        other = { actorId: "not-the-thread-owner" };
      await f.grant(other.actorId, "account-scope", ["read"]);
      await f.grant(other.actorId, "research-chat", ["read", "publish"]);
      for (const [principal, attempted] of [
        [other, selector],
        [owner, { ...selector, threadId: "other-thread" }],
        [owner, { ...selector, accountAlias: "other-account" }],
        [owner, { ...selector, messageId: "other-message" }],
      ] as const)
        await expect(
          f.runtime.conversation.readResponseContent(principal, attempted)
        ).rejects.toThrow();
      // Actor identity is supplied by the adapter; request-side session fields
      // must not substitute a caller or become part of the exact content selector.
      await expect(
        f.runtime.conversation.readResponseContent(owner, {
          ...selector,
          actorId: other.actorId,
          sessionId: "forged-session",
        })
      ).rejects.toThrow();
      expect(f.table(closures).map((row) => row["domain"])).toEqual(["inputs"]);
      return expect(
        await f.runtime.conversation.readResponseContent(owner, selector)
      ).toMatchObject({ status: "available" });
    },
    TIMEOUT
  );

  it(
    "entry caller denial still observes genuine original loss, but caller-only denial does not close derived output",
    async () => {
      const f = await eligibleResponse(),
        agent = await append(f),
        selector = contentInput(f, agent.message.messageId);
      await revokeGrant(f, "research-chat");
      await expect(
        f.runtime.conversation.readResponseContent(owner, selector)
      ).rejects.toMatchObject({ code: "denied" });
      expect(f.table(closures).map((row) => row["domain"])).toEqual(["inputs"]);
      await f.revokeContext();
      await expect(
        f.runtime.conversation.readResponseContent(owner, selector)
      ).rejects.toMatchObject({ code: "denied" });
      return expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
    },
    TIMEOUT
  );

  for (const permission of ["research-chat", "account-scope"] as const)
    it(
      `losing current caller ${permission} during external read releases no private profile`,
      async () => {
        const f = await eligibleResponse(),
          agent = await append(f),
          selector = contentInput(f, agent.message.messageId);
        let reads = 0;
        f.copies.state.afterRead = async (binding) => {
          const advisory = binding.copyId === f.recipe.copies.advisory.copyId;
          if (advisory && reads === 0) {
            reads += 1;
            await revokeGrant(f, permission);
          }
          return;
        };
        await expect(
          f.runtime.conversation.readResponseContent(owner, selector)
        ).rejects.toMatchObject({ code: "denied" });
        expect(reads).toBe(1);
        expect(f.table(messages)).toHaveLength(2);
        return expect(f.table(closures).map((row) => row["domain"])).toEqual([
          "inputs",
        ]);
      },
      TIMEOUT
    );

  return it.each(deadlineCases)(
    "honors exact %s notAfter at %s, never returning a stale available body",
    async (expiry, boundary) => {
      const f = await eligibleResponse(
          expiry === "original-storage-review"
            ? { storageReviewExpiresAt: LATER }
            : {}
        ),
        agent = await append(f),
        selector = contentInput(f, agent.message.messageId);
      const immutableOriginal = originalPins(f),
        immutableHistory = canonicalArtifactJson(f.table(messages)),
        immutableHead = canonicalArtifactJson(
          f.table("vertex_research_chat_threads")
        );
      const current = await f.runtime.conversation.readResponseContent(
        owner,
        selector
      );
      if (current.status !== "available")
        throw new Error("Initial body unavailable");
      expect(current.checkedAt).toBe(AT);
      const review = f
        .table("vertex_research_chat_storage_reviews")
        .find((row) => row["response_request_id"] === f.responseRequestId)![
        "payload"
      ];
      expect(current.notAfter).toBe(review.expiresAt);
      expect(current.notAfter).toBe(
        expiry === "original-storage-review" ? LATER : END
      );
      const callerGrants = currentCallerGrants(f);
      expect(callerGrants).toHaveLength(2);
      for (const grant of callerGrants) {
        const callerEnd = timestampToEpochNanoseconds(grant.expiresAt),
          originalEnd = timestampToEpochNanoseconds(current.notAfter);
        expect(grant.expiresAt).toBe(END);
        if (expiry === "original-storage-review") {
          expect(originalEnd).toBeLessThan(callerEnd);
        } else expect(originalEnd).toBe(callerEnd);
      }
      let crossed = false;
      f.copies.state.afterRead = async (binding) => {
        const advisory = binding.copyId === f.recipe.copies.advisory.copyId;
        if (!advisory) return;
        if (boundary === "external-read") {
          crossed = true;
          f.state.at = current.notAfter;
          return;
        }
        let finalReferenceRead = false;
        // Arm only after external bytes; wait for the conversation's final
        // historical-reference transaction, not an inner output-owner commit.
        f.state.afterQuery = (query) => {
          const isReference = query.sql.includes(
            "request->>'operation' = 'appendResponse'"
          );
          if (isReference) return (finalReferenceRead = true);
          return;
        };
        return (f.state.afterCommit = () => {
          const deadline = current.notAfter;
          if (finalReferenceRead) {
            crossed = true;
            return (f.state.at = deadline);
          }
          return;
        });
      };
      const reading = f.runtime.conversation.readResponseContent(
        owner,
        selector
      );
      if (expiry === "coincident-caller-and-original") {
        const deniedRead = reading;
        await expect(deniedRead).rejects.toMatchObject({ code: "denied" });
        await expect(deniedRead).rejects.not.toHaveProperty("profile");
        await expect(deniedRead).rejects.not.toHaveProperty("body");
      } else {
        const result = await reading;
        expect(result).toMatchObject({
          status: "unavailable",
          reference: agent.message,
        });
        expect(result).not.toHaveProperty("profile");
        expect(canonicalArtifactJson(result)).not.toContain(answerText);
      }
      expect(crossed).toBe(true);
      expect(f.state.at).toBe(current.notAfter);
      expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
      expect(canonicalArtifactJson(f.table(messages))).toBe(immutableHistory);
      expect(
        canonicalArtifactJson(f.table("vertex_research_chat_threads"))
      ).toBe(immutableHead);
      expect(
        f
          .table(messages)
          .find((row) => row["message_id"] === agent.message.messageId)?.[
          "response"
        ]
      ).toEqual(agent);
      expect(head(f)).toBe("3");
      expect(originalPins(f)).toBe(immutableOriginal);
      if (expiry === "original-storage-review") {
        const derived = f
          .table(closures)
          .find((row) => row["domain"] === "derived")!["payload"];
        expect(derived.cause).toBe("storage-review-expired");
        expect(await history(f)).toMatchObject({
          items: [{ author: { kind: "user" } }, agent.message],
        });
        expect(
          await f.runtime.conversation.readResponse(owner, readSelector(f))
        ).toMatchObject({ delivery: { status: "appended" } });
        expect(
          await f.runtime.conversation.appendResponse(owner, {
            ...f.selector,
            expectedRevision: "2",
          })
        ).toEqual(agent);
        const h3 = await f.append("3", `human-after-${expiry}-${boundary}`);
        expect(h3).toMatchObject({
          threadRevision: "4",
          message: { sequence: "3", author: { kind: "user" } },
        });
        expect(
          await f.runtime.conversation.prepareResponse(owner, {
            ...f.request,
            idempotencyKey: `new-human-after-${expiry}-${boundary}`,
            contextStartSequence: "3",
            snapshotRevision: "4",
            parentMessageId: (h3["message"] as { messageId: string }).messageId,
          })
        ).toMatchObject({
          status: "prepared",
          preview: {
            context: {
              messageCount: 1,
              contextStartSequence: "3",
              snapshotRevision: "4",
            },
          },
        });
        return expect(originalPins(f)).toBe(immutableOriginal);
      }
      return;
    },
    TIMEOUT
  );
});
