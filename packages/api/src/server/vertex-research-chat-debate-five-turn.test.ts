import { describe, expect, it } from "vitest";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import {
  SENTINELS,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  consumeAndStageAdvisory,
  publishAdvisory,
  completeResponse,
  fenceInputs,
  readSelector,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import {
  pending,
  unchanged,
  debateFixture,
  createDebateDiagnostic,
  participants,
  readRun,
  stepPlan,
  recordDerivedReview,
  counters,
  nativeOutput,
  decodeBase64,
} from "./vertex-research-chat-debate.test-support.ts";
import {
  VertexResearchChatDebateStepInputSchema,
  VertexResearchChatPublishedPredecessorV1Schema,
  type VertexResearchChatPublishedPredecessorV1,
} from "../contracts/vertex-research-chat-debate.ts";
import {
  VertexResearchChatAdvisoryV2ProfileSchema,
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import { WorkerReadArtifactOutputSchema } from "../contracts/vertex-worker.ts";
import { parseVertexResearchChatHumanContextV1 } from "../contracts/vertex-research-chat-context.ts";
import {
  researchParityPythonSkip,
  researchParityPythonSkipNote,
} from "./research-python.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// Split from vertex-research-chat-debate.test.ts (owner 2026-11-15, card
// vertex-debate-5turn-ci-speed): this one test takes 10 to 15 minutes on a
// GitHub-hosted runner. It is the named coverage shard debate-five-turn
// (scripts/lib/coverage-shards.ts), which a pull request runs only when it
// changes a debate file (scripts/ci/ci-changes.sh).
//
// This deliberately runs the actual source owners over the existing synthetic
// SQL/object boundaries, not a callback-only planner or live qualification suite.
describe("stepwise bounded debate source-owner acceptance", () => {
  it(
    "requires five separate approvals, publishes/fences each turn, and round-trips actual API buffers through the native consumer before explicit synthesis",
    async ({ skip }) => {
      // The native consumer round trip runs under the Python parity interpreter.
      skip(researchParityPythonSkip, researchParityPythonSkipNote);
      const diagnostic = createDebateDiagnostic();
      try {
        const scenario = await diagnostic.run(0, "prepare", () =>
            debateFixture(diagnostic)
          ),
          profiles: unknown[] = [];
        let pins: readonly VertexResearchChatPublishedPredecessorV1[] = [],
          selectionSha256: string | undefined,
          contextSha256: string | undefined;
        for (let ordinal = 1; ordinal <= 5; ordinal++) {
          const f = await diagnostic.run(ordinal, "prepare", () =>
            scenario.turn(ordinal, pins, async (prepared) => {
              const before = unchanged(prepared);
              expect(prepared.prepared).toMatchObject({
                status: "prepared",
                preview: {
                  request: prepared.request,
                  debate: {
                    ordinal,
                    kind: ordinal === 5 ? "synthesis" : "statement",
                  },
                },
              });
              // Parsing the preview/pins, original source read access and a prior turn's
              // approval do not replace this turn's independent exact reuse review.
              expect(
                await diagnostic.measure("missingReviewProbe", () =>
                  pending(prepared)
                )
              ).toMatchObject({ status: "blocked" });
              expect(unchanged(prepared)).toEqual(before);
              await diagnostic.measure("derivedReview", () =>
                recordDerivedReview(prepared)
              );
              expect(unchanged(prepared)).toEqual(before);
              const altered = {
                ...prepared.approveInput,
                planSha256: "f".repeat(64),
              };
              await expect(
                diagnostic.measure("alteredPlanProbe", () =>
                  prepared.runtime.conversation.approveAndRequestDebateStep(
                    owner,
                    altered
                  )
                )
              ).rejects.toMatchObject({ code: "integrity" });
              return expect(unchanged(prepared)).toEqual(before);
            })
          );
          const inspectRun = () =>
            diagnostic.run(ordinal, "readRun", () => readRun(f));
          const plan = stepPlan(f),
            expectedParticipant =
              ordinal === 5 ? participants[1] : participants[(ordinal - 1) % 2];
          expect(plan.participantId).toBe(expectedParticipant);
          expect(plan.debate).toMatchObject({
            ordinal,
            kind: ordinal === 5 ? "synthesis" : "statement",
            participantIds: participants,
            synthesizerId: participants[1],
            predecessors: pins,
          });
          expect(f.recipe.profile).toBe("vertex-research-chat-job-v2");
          expect(f.recipe.execution).toMatchObject({ debate: plan.debate });
          expect(Object.keys(f.recipe.copies).sort()).toEqual([
            "advisory",
            "completionInput",
            "context",
            "tokenizeInput",
          ]);
          if (selectionSha256 === undefined) {
            selectionSha256 = plan.selectionSha256;
            contextSha256 = plan.debate.humanWindowSha256;
          }
          expect(plan.selectionSha256).toBe(selectionSha256);
          expect(plan.debate.humanWindowSha256).toBe(contextSha256);
          expect(counters(f).charges).toHaveLength(ordinal);
          expect(counters(f).dispatches).toHaveLength(2 * (ordinal - 1));
          expect(await inspectRun()).toMatchObject({
            status: "available",
            nextStep: null,
            complete: false,
          });
          const humanCopy = WorkerReadArtifactOutputSchema.parse(
            await diagnostic.measure("readContextArtifact", () =>
              f.worker.invoke(f.identity, "readArtifact", {
                ...f.fence,
                collectionId: null,
                artifactId: f.recipe.copies.context.copyId,
              })
            )
          );
          const human = parseVertexResearchChatHumanContextV1(
            JSON.parse(
              new TextDecoder().decode(decodeBase64(humanCopy.contentBase64))
            )
          );
          expect(human.messages).toMatchObject([
            {
              sequence: "1",
              author: { kind: "user", actor_id: owner.actorId },
              body: SENTINELS.human,
            },
          ]);
          expect(human.messages).toHaveLength(1);
          expect(human).not.toHaveProperty("derived_context");
          const input = WorkerReadArtifactOutputSchema.parse(
            await diagnostic.measure("readCompletionArtifact", () =>
              f.worker.invoke(f.identity, "readArtifact", {
                ...f.fence,
                collectionId: null,
                artifactId: f.recipe.copies.completionInput.copyId,
              })
            )
          );
          const providerBody = JSON.parse(
              new TextDecoder().decode(decodeBase64(input.contentBase64))
            ),
            envelope = JSON.parse(providerBody.messages[1].content);
          expect(envelope.data.prior_analyses).toEqual([]);
          expect(envelope.data.phase).toBe("synthesis");
          expect(envelope.data.tool_results).toEqual([]);
          expect(providerBody).not.toHaveProperty("tools");
          expect(envelope.data.derived_context.predecessors).toEqual(
            pins.map((pin, index) => ({ pin, advisory: profiles[index] }))
          );
          expect(envelope.data.derived_context.kind).toBe(
            ordinal === 5 ? "synthesis" : "statement"
          );
          const advisory = await diagnostic.run(ordinal, "consumeStage", () =>
            consumeAndStageAdvisory(f, () => nativeOutput(f))
          );
          const profile = VertexResearchChatAdvisoryV2ProfileSchema.parse(
            advisory.decoded.profile
          );
          expect(profile.debate).toEqual(plan.debate);
          profiles.push(profile);
          expect(await inspectRun()).toMatchObject({
            status: "available",
            nextStep: null,
            complete: false,
          });
          await diagnostic.run(ordinal, "publish", () =>
            publishAdvisory(f, advisory)
          );
          expect(await inspectRun()).toMatchObject({
            status: "available",
            nextStep: null,
            complete: false,
          });
          await diagnostic.run(ordinal, "complete", () => completeResponse(f));
          expect(await inspectRun()).toMatchObject({
            status: "available",
            nextStep: null,
            complete: false,
          });
          await diagnostic.run(ordinal, "fence", () => fenceInputs(f));
          const revision = f
            .table("vertex_research_chat_threads")
            .find((row) => row["thread_id"] === f.request.threadId)![
            "revision"
          ];
          const appended = VertexResearchChatAppendResponseOutputSchema.parse(
            await f.runtime.conversation.appendResponse(owner, {
              ...f.selector,
              expectedRevision: revision,
            })
          );
          if (appended.status !== "appended")
            throw new Error("Real terminal output was not appended");
          const content =
            VertexResearchChatReadResponseContentOutputSchema.parse(
              await f.runtime.conversation.readResponseContent(owner, {
                ...f.selector,
                messageId: appended.message.messageId,
              })
            );
          expect(content).toMatchObject({
            status: "available",
            profile,
            sha256: advisory.contentSha256,
          });
          const history = await f.store.readResearchChatTranscriptPage(
            owner,
            scope,
            f.request.threadId,
            { limit: 100, cursor: null }
          );
          if (!history) throw new Error("Transcript page absent");
          const items = history["items"] as readonly unknown[];
          expect(items).toHaveLength(ordinal + 1);
          for (const message of items.slice(1)) {
            expect(message).toHaveProperty("kind", "advisory-reference");
            expect(message).not.toHaveProperty("body");
          }
          const metadata = canonicalArtifactJson({
            history,
            reconciliation: await f.runtime.conversation.readResponse(
              owner,
              readSelector(f)
            ),
            run: await inspectRun(),
          });
          for (const item of profiles) {
            const retained =
              VertexResearchChatAdvisoryV2ProfileSchema.parse(item);
            for (const claim of retained.output.claims)
              expect(metadata).not.toContain(claim.text);
          }
          const beforeReplay = counters(f);
          expect(
            await f.runtime.conversation.approveAndRequestDebateStep(
              owner,
              f.approveInput
            )
          ).toMatchObject({
            status: "recorded",
            receipt: { responseRequestId: f.responseRequestId },
          });
          expect(
            await f.runtime.conversation.appendResponse(owner, {
              ...f.selector,
              expectedRevision: revision,
            })
          ).toEqual(appended);
          expect(counters(f)).toEqual(beforeReplay);
          const run = await inspectRun();
          if (run.status !== "available")
            throw new Error("Actual bounded run disappeared");
          expect(run.steps.map((step) => step.ordinal)).toEqual(
            Array.from({ length: ordinal }, (_, index) => index + 1)
          );
          expect(run.chargedTokens).toBe(String(ordinal * 2000));
          expect(run.chargedUsdUnits).toBe(
            (BigInt(ordinal) * 10n ** 18n).toString()
          );
          if (ordinal < 5) {
            if (run.nextStep === null)
              throw new Error(
                "Publication and fence ACK did not enable next preparation"
              );
            pins = run.nextStep.predecessors;
            expect(pins).toHaveLength(ordinal);
            expect(
              VertexResearchChatPublishedPredecessorV1Schema.parse(
                pins[ordinal - 1]
              )
            ).toMatchObject({
              responseRequestId: f.responseRequestId,
              participantId: expectedParticipant,
              contentSha256: advisory.contentSha256,
            });
          } else {
            expect(run).toMatchObject({ complete: true, nextStep: null });
            expect(run.steps[4]).toMatchObject({
              ordinal: 5,
              kind: "synthesis",
              participantId: participants[1],
              state: "spent",
            });
            const sixth = {
              ...f.request,
              idempotencyKey: "forbidden-sixth-step",
              debate: {
                ...VertexResearchChatDebateStepInputSchema.parse(f.request)
                  .debate,
                ordinal: 6,
              },
            };
            expect(
              VertexResearchChatDebateStepInputSchema.safeParse(sixth).success
            ).toBe(false);
            await expect(
              f.runtime.conversation.prepareDebateStep(owner, sixth)
            ).rejects.toThrow();
            expect(counters(f)).toEqual(beforeReplay);
          }
        }
        expect(
          scenario.base.table("vertex_research_chat_debate_runs")
        ).toHaveLength(1);
        expect(
          scenario.base.table("vertex_research_chat_debate_steps")
        ).toHaveLength(5);
        return expect(
          scenario.base.table("vertex_research_chat_model_dispatches")
        ).toHaveLength(10);
      } finally {
        diagnostic.finish();
      }
    },
    // Owner 2026-11-08 (card vertex-debate-predecessor-query-blowup): 841 s on a
    // GitHub-hosted coverage shard (run 42526763554); limit raised to 1200 s.
    scaledTimeout(1_200_000)
  );
});
