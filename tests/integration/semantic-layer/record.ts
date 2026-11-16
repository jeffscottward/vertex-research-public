// Records the agent semantic-layer eval (docs/vertex-rebuild/agent-semantic-layer.md): every question of
// tests/integration/semantic-layer/questions.ts, TRIALS times, through the real Plan-mode assistant turn
// against the eval backend (real Postgres + synthetic feeds). The model is bridged over stdio so the
// operator's OMP session can answer each call with its completion model (no new provider):
//   stdout: "@@EVAL " + {"type":"request","key","messages","tools"}
//   stdin:  {"key","content","toolCalls":[{"name","arguments"}],"model"?}   (one JSON object per line)
// The recording is written to tests/integration/semantic-layer/eval-recording.fixture.json (synthetic data only);
// eval-replay.test.ts replays and grades it in CI.
// Run: bun run eval:semantic:record -- [trials] [concurrency] [stale | ids...]
//   no ids: every question; the run replaces all trials and keeps the header.
//   ids:    those questions.
//   stale:  every recorded trial that no longer replays against the built layer, and every missing trial.
//           The run first prints "@@EVAL " + {"type":"stale","keys":[...],"reasons":{key: reason}} and
//           asks the model for those trials only. With no stale trial it writes nothing.
// A run with ids or `stale` replaces the trials it recorded and keeps everything else of the existing file:
// the header (the `audit` block) and every other trial with its model, date and audit grade (recording.ts).
// Each new trial stores its own `model` and `recordedAt` and has no `audit` grade until it is graded; the
// replay test fails on it until then. The text of the `audit` header is not updated by the recorder.
// The last line is "@@EVAL " + {"type":"finished","count": trials in the file,"recorded": trials of this run}.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AssistantCompletion,
  AssistantCompletionRequest,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type EvalBackend,
  runTrial,
  staleReason,
  startEvalBackend,
} from "./harness.ts";
import { writeFrozenMasterRules } from "./master-rules-freeze.ts";
import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";
import {
  assertTrialsHaveModelAndDate,
  mergeRecording,
  parseCount,
  parseSelection,
  type RecordedTrial,
  type Recording,
  trialKey,
} from "./recording.ts";

const [trialsArg, concurrencyArg, ...selectors] = process.argv.slice(2);
const TRIALS = parseCount("trials", trialsArg, 3);
const CONCURRENCY = parseCount("concurrency", concurrencyArg, 6);
const OUTPUT = fileURLToPath(
  new URL("./eval-recording.fixture.json", import.meta.url)
);
const NOTE =
  "Synthetic data only (docs/vertex-rebuild/agent-semantic-layer/fixture.sql and tests/integration/semantic-layer/fixtures.ts). Recorded with the OMP completion model through the real Plan-mode assistant turn.";
const selection = parseSelection(
  selectors,
  EVAL_QUESTIONS.map((question) => question.id)
);
const readRecording = (): Recording | undefined =>
  existsSync(OUTPUT)
    ? (JSON.parse(readFileSync(OUTPUT, "utf8")) as Recording)
    : undefined;
// Checked here, before the backend starts and before any model request.
const atStart = readRecording();
if (atStart !== undefined && selection.kind !== "all") {
  assertTrialsHaveModelAndDate(atStart);
}

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

// The model of a trial: every distinct id that the replies of the trial named, joined with " + " (one id
// in the normal case). A bridge that names none gives the placeholder "omp-completion".
const models = new Map<string, Set<string>>();
const bridge =
  (trial: string) =>
  async (request: AssistantCompletionRequest): Promise<AssistantCompletion> => {
    const call = request.messages.filter(
      (message) => message.role === "assistant"
    ).length;
    const key = `${trial}#${call}`;
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
    if (typeof reply.model === "string" && reply.model.trim() !== "") {
      models.set(trial, (models.get(trial) ?? new Set()).add(reply.model));
    }
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

type Job = Readonly<{
  question: (typeof EVAL_QUESTIONS)[number];
  trial: number;
}>;

/**
 * The trials of this run: all, the named questions, or (stale) every recorded trial that no longer
 * replays plus every missing trial up to the trials argument. A stale run prints its list with the reason
 * per trial before the first model request.
 */
const selectJobs = async (evalBackend: EvalBackend): Promise<Job[]> => {
  const all = EVAL_QUESTIONS.flatMap((question) =>
    Array.from({ length: TRIALS }, (_, trial) => ({
      question,
      trial: trial + 1,
    }))
  );
  if (selection.kind === "all") return all;
  if (selection.kind === "questions") {
    return all.filter((job) => selection.ids.includes(job.question.id));
  }
  const recorded = readRecording()?.trials ?? [];
  const recordedKeys = new Set(recorded.map(trialKey));
  const stale: Job[] = [];
  const reasons: Record<string, string> = {};
  // One at a time: the replay needs no model, and the order of the printed keys stays fixed.
  for (const question of EVAL_QUESTIONS) {
    for (const existing of recorded) {
      if (existing.question !== question.id) continue;
      // The replay test also compares the rubric grade, so a changed rubric makes the trial stale too.
      const reason =
        (await staleReason(evalBackend, question, existing)) ??
        (gradeAnswer(question, existing.answer) === existing.grade
          ? null
          : "the rubric grade of the recorded answer changed");
      if (reason === null) continue;
      stale.push({ question, trial: existing.trial });
      reasons[trialKey(existing)] = reason;
    }
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const key = trialKey({ question: question.id, trial });
      if (recordedKeys.has(key)) continue;
      stale.push({ question, trial });
      reasons[key] = "the recording has no such trial";
    }
  }
  process.stdout.write(
    `@@EVAL ${JSON.stringify({ keys: Object.keys(reasons), reasons, type: "stale" })}\n`
  );
  return stale;
};

const backend = await startEvalBackend({ masterRules: "record" });
const results: RecordedTrial[] = [];
let jobs: Job[] = [];
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    if (job === undefined) return;
    const key = trialKey({ question: job.question.id, trial: job.trial });
    const result = await runTrial(backend, job.question, bridge(key));
    results.push({
      answer: result.answer,
      completions: result.completions,
      grade: gradeAnswer(job.question, result.answer),
      model: [...(models.get(key) ?? ["omp-completion"])].join(" + "),
      question: job.question.id,
      recordedAt: new Date().toISOString(),
      tools: result.trace.map(
        (entry) => `${entry.tool}(${entry.args})${entry.ok ? "" : " failed"}`
      ),
      trial: job.trial,
    });
    process.stdout.write(`@@EVAL ${JSON.stringify({ key, type: "done" })}\n`);
  }
};
try {
  jobs = await selectJobs(backend);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
} finally {
  // Searches first seen in this run are frozen first, so a failed close cannot lose them.
  writeFrozenMasterRules(backend.masterRules);
  await backend.close();
  lines.close();
}
// The file is read again here, not taken from the start of the run: a grading step may have written it
// while the model answered. A run of every question keeps the header only.
const existing = readRecording();
const merged = mergeRecording(
  existing !== undefined && selection.kind === "all"
    ? { ...existing, trials: [] }
    : existing,
  results,
  EVAL_QUESTIONS.map((question) => question.id),
  NOTE
);
// A stale run that found nothing leaves the file untouched. Write whole: temporary file, then rename.
if (results.length > 0) {
  writeFileSync(`${OUTPUT}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(`${OUTPUT}.tmp`, OUTPUT);
}
process.stdout.write(
  `@@EVAL ${JSON.stringify({ count: merged.trials.length, recorded: results.length, type: "finished" })}\n`
);
process.exit(0);
