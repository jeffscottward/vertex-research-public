import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AssistantCompletionRequest } from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  type EvalBackend,
  type RecordedCompletion,
  runTrial,
  startEvalBackend,
  inputDigest,
  toCompletion,
} from "./harness.ts";
import { EVAL_QUESTIONS, type Grade, gradeAnswer } from "./questions.ts";

// Replays the recorded semantic-layer eval (record.ts) against the built layer:
// the real Plan-mode assistant turn, the real oRPC handler, Postgres with the synthetic fixture and the
// synthetic feeds. Each recorded model reply is returned in order; the semantic-layer tool results the
// model sees must equal the recorded ones (else the recording is stale: re-record). Every final answer is
// graded with the fixed rubric in questions.ts.
// Acceptance (docs/vertex-rebuild/agent-semantic-layer.md): main set >= 58/60 correct, 0 wrong account
// answers.

type RecordedTrial = Readonly<{
  question: string;
  trial: number;
  answer: string;
  grade: Grade;
  // Independent Claude grader verdict against the reference (recorded with the trial, audited by hand).
  audit: Grade;
  completions: readonly RecordedCompletion[];
}>;

type RecordingHeader = Readonly<{
  audit: Readonly<{ grader: string; instructions: string; gradedAt: string }>;
}>;

const recording = JSON.parse(
  readFileSync(
    new URL("./eval-recording.fixture.json", import.meta.url),
    "utf8"
  )
) as RecordingHeader & Readonly<{ trials: readonly RecordedTrial[] }>;

const byId = new Map(EVAL_QUESTIONS.map((question) => [question.id, question]));
let backend: EvalBackend;

describe("semantic layer eval replay", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("names where the independent grade came from", () => {
    expect(recording.audit.grader.length).toBeGreaterThan(0);
    expect(recording.audit.instructions.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(recording.audit.gradedAt))).toBe(false);
  });

  it("covers every question three times", () => {
    for (const question of EVAL_QUESTIONS) {
      expect(
        recording.trials.filter((trial) => trial.question === question.id),
        question.id
      ).toHaveLength(3);
    }
  });

  it.each(
    recording.trials.map(
      (trial) => [`${trial.question}.${trial.trial}`, trial] as const
    )
  )(
    "%s replays against the built layer",
    async (_name, recorded) => {
      const question = byId.get(recorded.question);
      if (question === undefined)
        throw new Error(`unknown question ${recorded.question}`);
      let call = 0;
      const replay = async (request: AssistantCompletionRequest) => {
        const next = recorded.completions[call];
        if (next === undefined)
          throw new Error("the turn asked for more model calls than recorded");
        expect(
          inputDigest(request),
          `terms results before model call ${call}`
        ).toBe(next.inputDigest);
        call += 1;
        return toCompletion(next);
      };
      const result = await runTrial(backend, question, replay);
      expect(call).toBe(recorded.completions.length);
      expect(result.answer).toBe(recorded.answer);
      const grade = gradeAnswer(question, result.answer);
      expect(grade).toBe(recorded.grade);
      expect(["correct", "wrong", "declined"]).toContain(recorded.audit);
    },
    30_000
  );

  it("meets the acceptance bar: main set >= 58/60 correct and no wrong account answer", () => {
    // Grades come from the recording itself (the replay tests above prove each answer is reproduced).
    // Correct needs both the fixed rubric and the independent recorded grade; wrong by either counts.
    const graded = recording.trials.map((trial) => {
      const question = byId.get(trial.question);
      if (question === undefined)
        throw new Error(`unknown question ${trial.question}`);
      return {
        audit: trial.audit,
        grade: gradeAnswer(question, trial.answer),
        question,
      };
    });
    const main = graded.filter((entry) => entry.question.set === "main");
    expect(main).toHaveLength(60);
    expect(
      main.filter(
        (entry) => entry.grade === "correct" && entry.audit === "correct"
      ).length
    ).toBeGreaterThanOrEqual(58);
    const wrongAccount = graded.filter(
      (entry) =>
        entry.question.kind === "account" &&
        (entry.grade === "wrong" || entry.audit === "wrong")
    );
    expect(wrongAccount).toEqual([]);
  });
});
