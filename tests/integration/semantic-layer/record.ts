// Records the agent semantic-layer eval (docs/vertex-rebuild/agent-semantic-layer.md): every question of
// tests/integration/semantic-layer/questions.ts, TRIALS times, through the real Plan-mode assistant turn
// against the eval backend (real Postgres + synthetic feeds). The model is bridged over stdio so the
// operator's OMP session can answer each call with its completion model (no new provider):
//   stdout: "@@EVAL " + {"type":"request","key","system","messages","tools"}
//   stdin:  {"key","content","toolCalls":[{"name","arguments"}]}   (one JSON object per line)
// The recording is written to tests/integration/semantic-layer/eval-recording.fixture.json (synthetic data only);
// eval-replay.test.ts replays and grades it in CI.
// Run: bun run eval:semantic:record -- [trials] [concurrency] [ids...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type {
  AssistantCompletion,
  AssistantCompletionRequest,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type RecordedCompletion,
  runTrial,
  startEvalBackend,
} from "./harness.ts";
import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";

const [trialsArg, concurrencyArg, ...ids] = process.argv.slice(2);
const TRIALS = Number(trialsArg ?? "3");
const CONCURRENCY = Number(concurrencyArg ?? "6");
const OUTPUT = new URL("./eval-recording.fixture.json", import.meta.url);

type Reply = Readonly<{
  key: string;
  content: string;
  toolCalls: readonly Readonly<{ name: string; arguments: unknown }>[];
  model?: string;
}>;

const pending = new Map<string, (reply: Reply) => void>();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const reply = JSON.parse(line) as Reply;
  pending.get(reply.key)?.(reply);
  pending.delete(reply.key);
});

let modelName = "omp-completion";
const bridge =
  (trialKey: string) =>
  async (request: AssistantCompletionRequest): Promise<AssistantCompletion> => {
    const call = request.messages.filter(
      (message) => message.role === "assistant"
    ).length;
    const key = `${trialKey}#${call}`;
    // Executor form: the tests tsconfig targets a lib without Promise.withResolvers.
    let resolve: (reply: Reply) => void = () => undefined;
    const promise = new Promise<Reply>((done) => {
      resolve = done;
    });
    pending.set(key, resolve);
    process.stdout.write(
      `@@EVAL ${JSON.stringify({ key, messages: request.messages, tools: request.tools, type: "request" })}\n`
    );
    const reply = await promise;
    if (reply.model !== undefined) modelName = reply.model;
    return {
      content: reply.content,
      finishReason: reply.toolCalls.length > 0 ? "tool_calls" : "stop",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: reply.toolCalls.map((toolCall, index) => ({
        function: {
          arguments:
            typeof toolCall.arguments === "string"
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments ?? {}),
          name: toolCall.name,
        },
        id: `${key}.${index}`.replaceAll("#", "_"),
        type: "function" as const,
      })),
    };
  };

type Recorded = Readonly<{
  question: string;
  trial: number;
  answer: string;
  grade: string;
  tools: readonly string[];
  completions: readonly RecordedCompletion[];
}>;

const backend = await startEvalBackend();
const questions = EVAL_QUESTIONS.filter(
  (question) => ids.length === 0 || ids.includes(question.id)
);
const jobs = questions.flatMap((question) =>
  Array.from({ length: TRIALS }, (_, trial) => ({ question, trial: trial + 1 }))
);
const results: Recorded[] = [];
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    if (job === undefined) return;
    const key = `${job.question.id}.${job.trial}`;
    const result = await runTrial(backend, job.question, bridge(key));
    results.push({
      answer: result.answer,
      completions: result.completions,
      grade: gradeAnswer(job.question, result.answer),
      question: job.question.id,
      tools: result.trace.map(
        (entry) => `${entry.tool}(${entry.args})${entry.ok ? "" : " failed"}`
      ),
      trial: job.trial,
    });
    process.stdout.write(`@@EVAL ${JSON.stringify({ key, type: "done" })}\n`);
  }
};
try {
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
} finally {
  await backend.close();
  lines.close();
}
// With question ids, the new trials replace those questions' trials in the existing recording.
if (ids.length > 0 && existsSync(OUTPUT)) {
  const previous = JSON.parse(readFileSync(OUTPUT, "utf8")) as {
    trials: Recorded[];
  };
  results.push(
    ...previous.trials.filter((trial) => !ids.includes(trial.question))
  );
}
const order = new Map(
  EVAL_QUESTIONS.map((question, index) => [question.id, index])
);
results.sort(
  (left, right) =>
    (order.get(left.question) ?? 0) - (order.get(right.question) ?? 0) ||
    left.trial - right.trial
);
writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    {
      model: modelName,
      note: "Synthetic data only (docs/vertex-rebuild/agent-semantic-layer/fixture.sql and tests/integration/semantic-layer/fixtures.ts). Recorded with the OMP completion model through the real Plan-mode assistant turn.",
      recordedAt: new Date().toISOString(),
      schemaVersion: 1,
      trials: results,
    },
    null,
    2
  )}\n`
);
process.stdout.write(
  `@@EVAL ${JSON.stringify({ count: results.length, type: "finished" })}\n`
);
process.exit(0);
