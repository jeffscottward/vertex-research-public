import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EvalBackend, replayTrial, startEvalBackend } from "./harness.ts";
import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";
import {
  RECORDING_SCHEMA_VERSION,
  type RecordedTrial,
  trialKey,
} from "./recording.ts";
import { unexpectedToolFailures } from "./tool-failures.ts";

// Replays the recorded semantic-layer eval (record.ts) against the built layer:
// the real Plan-mode assistant turn, the real oRPC handler, Postgres with the synthetic fixture and the
// synthetic feeds. Each recorded model reply is returned in order; the semantic-layer tool results the
// model sees must equal the recorded ones (else the recording is stale: re-record). Every final answer is
// graded with the fixed rubric in questions.ts. A tool call that fails in a replayed trial fails the
// test unless tool-failures.ts lists it as an expected input rejection (a server error never is). A
// terms_query answer with status unknown also fails the test; no list allows it (tool-failures.ts).
// Acceptance (docs/vertex-rebuild/agent-semantic-layer.md): main set >= 58/60 correct, 0 wrong account
// answers; engine runs with no strategy (U1-U5) >= 13/15 correct and none wrong.

type RecordingHeader = Readonly<{
  audit: Readonly<{ grader: string; instructions: string; gradedAt: string }>;
  schemaVersion: number;
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

  it("stores the model and the date on every trial, not in the header", () => {
    expect(recording.schemaVersion).toBe(RECORDING_SCHEMA_VERSION);
    expect(recording).not.toHaveProperty("model");
    expect(recording).not.toHaveProperty("recordedAt");
    for (const trial of recording.trials) {
      expect(trial.model, trialKey(trial)).toMatch(/\S/);
      expect(Number.isNaN(Date.parse(trial.recordedAt)), trialKey(trial)).toBe(
        false
      );
    }
  });

  it("covers every question three times", () => {
    for (const question of EVAL_QUESTIONS) {
      expect(
        recording.trials.filter((trial) => trial.question === question.id),
        question.id
      ).toHaveLength(3);
    }
  });

  it.each(recording.trials.map((trial) => [trialKey(trial), trial] as const))(
    "%s replays against the built layer",
    async (_name, recorded) => {
      const question = byId.get(recorded.question);
      if (question === undefined)
        throw new Error(`unknown question ${recorded.question}`);
      const replayed = await replayTrial(backend, question, recorded);
      // stale null: every model call saw the recorded input and the final answer is the recorded one.
      // A grade counts only when the tools worked: a failed call must be a listed input rejection, and
      // no terms_query answer may have status unknown (the call worked but gave no value). One assertion
      // shows all three, so a stale trial also shows a term that answers unknown since the recording.
      expect({
        failedCalls: unexpectedToolFailures(recorded.question, replayed.trace),
        stale: replayed.stale,
        unknownTerms: replayed.unknownTerms,
      }).toEqual({ failedCalls: [], stale: null, unknownTerms: [] });
      const grade = gradeAnswer(question, recorded.answer);
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

  it("answers backtest questions about engine runs with no strategy: >= 13/15 correct and none wrong", () => {
    const unlinked = recording.trials.flatMap((trial) => {
      const question = byId.get(trial.question);
      if (question?.set !== "unlinked") return [];
      return [
        { audit: trial.audit, grade: gradeAnswer(question, trial.answer) },
      ];
    });
    expect(unlinked).toHaveLength(15);
    expect(
      unlinked.filter(
        (entry) => entry.grade === "correct" && entry.audit === "correct"
      ).length
    ).toBeGreaterThanOrEqual(13);
    expect(
      unlinked.filter(
        (entry) => entry.grade === "wrong" || entry.audit === "wrong"
      )
    ).toEqual([]);
  });
});
