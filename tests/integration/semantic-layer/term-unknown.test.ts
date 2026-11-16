import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  AssistantCompletion,
  AssistantCompletionRequest,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type EvalBackend,
  replayTrial,
  runTrial,
  setLiveAccountFeed,
  startEvalBackend,
} from "./harness.ts";
import { EVAL_QUESTIONS, type EvalQuestion } from "./questions.ts";
import { unexpectedToolFailures } from "./tool-failures.ts";

// A terms_query answer with status unknown is a call that worked: the trace marks it ok, so the
// tool-failure gate does not see it. These tests record one scripted turn and replay it while the
// live-account feed is down (answer 503). replayTrial must report the unknown answer both when the
// recording has it (the replay is not stale) and when the term answered ok at recording time (the replay
// is stale, and the line names the cause). The tests also fail when the procedure of terms_query is
// renamed and the check in unknownTermAnswer no longer matches it.

const ANSWER = "Net liquidation: see the term result.";
const UNKNOWN_LINE =
  /^terms_query\(\{"term":"net_liquidation"\}\): status unknown: Unknown: the vertex-portfolio feed is unavailable/u;

/** A scripted model: one terms_query call, then the final answer. */
const scripted = async (
  request: AssistantCompletionRequest
): Promise<AssistantCompletion> => {
  const called = request.messages.some((message) => message.role === "tool");
  return {
    content: called ? ANSWER : "",
    finishReason: called ? "stop" : "tool_calls",
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: called
      ? []
      : [
          {
            function: {
              arguments: '{"term":"net_liquidation"}',
              name: "terms_query",
            },
            id: "call_0",
            type: "function",
          },
        ],
  };
};

let backend: EvalBackend;
let question: EvalQuestion;

describe("a terms_query answer with status unknown in a replayed trial", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
    const found = EVAL_QUESTIONS.find((entry) => entry.id === "Q1");
    if (found === undefined) throw new Error("question Q1 is missing");
    question = found;
  }, 120_000);

  afterEach(() => {
    setLiveAccountFeed("live");
  });

  afterAll(async () => {
    await backend.close();
  });

  it("is reported when the recording has it, although the replay is not stale and no call failed", async () => {
    setLiveAccountFeed("down");
    const recorded = await runTrial(backend, question, scripted);

    const replayed = await replayTrial(backend, question, recorded);
    expect(replayed.stale).toBeNull();
    expect(replayed.trace.map((call) => call.ok)).toEqual([true]);
    expect(unexpectedToolFailures(question.id, replayed.trace)).toEqual([]);
    expect(replayed.unknownTerms).toHaveLength(1);
    expect(replayed.unknownTerms[0]).toMatch(UNKNOWN_LINE);
  });

  it("is reported with the stale reason when the term answered ok at recording time", async () => {
    setLiveAccountFeed("live");
    const recorded = await runTrial(backend, question, scripted);

    setLiveAccountFeed("down");
    const replayed = await replayTrial(backend, question, recorded);
    expect(replayed.stale).toMatch(/^the input of model call 1 changed/u);
    // The turn threw at model call 1; the trace keeps the call made before.
    expect(replayed.trace.map((call) => call.ok)).toEqual([true]);
    expect(replayed.unknownTerms).toHaveLength(1);
    expect(replayed.unknownTerms[0]).toMatch(UNKNOWN_LINE);
  });

  it("is not reported when the feed is live", async () => {
    const recorded = await runTrial(backend, question, scripted);

    const replayed = await replayTrial(backend, question, recorded);
    expect(replayed.stale).toBeNull();
    expect(replayed.unknownTerms).toEqual([]);
  });
});
