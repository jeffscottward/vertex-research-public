import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EVAL_QUESTIONS, type Grade, gradeAnswer } from "./questions.ts";

// Grader self-test of the independent grade (card vertex-eval-independent-grader-weak,
// docs/vertex-rebuild/agent-semantic-layer.md). The independent grader of the recording
// (eval-recording.fixture.json, `audit`) graded known answers in three separate runs: constructed wrong
// Q20 answers of two red teams, correct Q20 answers, and a held-out set of 2 wrong and 1 correct answer
// for each of the 30 questions. The grade of an answer is the majority of its three grades. This test
// calls no model: it checks the stored grades against the bars below, it grades every answer with the
// fixed rubric to find the wrong answers that pass both checks of the replay, and it checks that the
// recording names the same grader and instructions. A new grader or new instructions therefore need a
// new self-test run (same prompt format, every item, three runs) before the recording can use them.

type SelfTestItem = Readonly<{
  id: string;
  question: string;
  source: string;
  expected: "correct" | "wrong";
  grades: readonly Grade[];
  answer: string;
}>;

type SelfTest = Readonly<{
  grader: string;
  via: string;
  instructions: string;
  prompt: string;
  gradedAt: string;
  questions: Readonly<
    Record<string, Readonly<{ question: string; reference: string }>>
  >;
  sources: Readonly<Record<string, string>>;
  items: readonly SelfTestItem[];
}>;

type RecordingAudit = Readonly<{
  audit: Readonly<{ graderModel: string; instructions: string }>;
}>;

const selfTest = JSON.parse(
  readFileSync(
    new URL("./grader-self-test.fixture.json", import.meta.url),
    "utf8"
  )
) as SelfTest;
const recording = JSON.parse(
  readFileSync(
    new URL("./eval-recording.fixture.json", import.meta.url),
    "utf8"
  )
) as RecordingAudit;

const RUNS = 3;
/** Share of the wrong answers of each source that the majority grade must grade wrong. */
const MIN_WRONG_CAUGHT: Readonly<Record<string, number>> = {
  "held-out": 0.95,
  "red-team-1": 0.9,
  "red-team-2": 0.85,
};
/** Share of all constructed wrong Q20 answers (both red teams) that must be graded wrong. */
const MIN_RED_TEAM_CAUGHT = 0.9;
/**
 * Wrong answers that pass both checks of the replay (rubric correct and majority grade correct), as
 * measured on 2026-11-20. A grader or rubric change that lets one more wrong answer through fails the
 * test. When a change closes a gap, remove it here: the list may only shrink.
 */
const KNOWN_GAPS = [
  "W041",
  "W052",
  "X004",
  "X005",
  "X016",
  "X020",
  "X024",
  "X025",
  "X026",
  "X059",
];

const byId = new Map(EVAL_QUESTIONS.map((question) => [question.id, question]));

/** The grade that more than half of the runs gave; with no such grade, `declined` (counts as neither). */
const majority = (grades: readonly Grade[]): Grade =>
  (["correct", "wrong", "declined"] as const).find(
    (grade) =>
      grades.filter((given) => given === grade).length * 2 > grades.length
  ) ?? "declined";

const wrongItems = selfTest.items.filter((item) => item.expected === "wrong");
const correctItems = selfTest.items.filter(
  (item) => item.expected === "correct"
);
const caughtShare = (items: readonly SelfTestItem[]): number =>
  items.filter((item) => majority(item.grades) === "wrong").length /
  items.length;

describe("grader self-test of the independent grade", () => {
  it("holds every known answer once, with three grades", () => {
    // The set may grow; it may not shrink below the answers of 2026-11-20.
    expect(wrongItems.length).toBeGreaterThanOrEqual(260);
    expect(correctItems.length).toBeGreaterThanOrEqual(135);
    expect(new Set(selfTest.items.map((item) => item.id)).size).toBe(
      selfTest.items.length
    );
    for (const item of selfTest.items) {
      expect(item.grades, item.id).toHaveLength(RUNS);
      for (const grade of item.grades) {
        expect(["correct", "wrong", "declined"], item.id).toContain(grade);
      }
      expect(Object.keys(selfTest.sources), item.id).toContain(item.source);
      expect(Object.keys(selfTest.questions), item.id).toContain(item.question);
      expect(item.answer, item.id).toMatch(/\S/);
    }
    expect(Number.isNaN(Date.parse(selfTest.gradedAt))).toBe(false);
  });

  it("was graded with the questions and references of questions.ts", () => {
    for (const [id, graded] of Object.entries(selfTest.questions)) {
      const question = byId.get(id);
      expect(question?.question, id).toBe(graded.question);
      expect(question?.reference, id).toBe(graded.reference);
    }
  });

  it("grades enough wrong answers wrong", () => {
    for (const [source, share] of Object.entries(MIN_WRONG_CAUGHT)) {
      const items = wrongItems.filter((item) => item.source === source);
      expect(items.length, source).toBeGreaterThan(0);
      expect(caughtShare(items), source).toBeGreaterThanOrEqual(share);
    }
    const redTeams = wrongItems.filter((item) =>
      item.source.startsWith("red-team-")
    );
    expect(caughtShare(redTeams)).toBeGreaterThanOrEqual(MIN_RED_TEAM_CAUGHT);
  });

  it("grades every correct answer correct", () => {
    const missed = correctItems
      .filter((item) => majority(item.grades) !== "correct")
      .map((item) => item.id);
    expect(missed).toEqual([]);
  });

  it("lets no more wrong answers pass both the rubric and the grader", () => {
    const passBoth = wrongItems
      .filter((item) => {
        const question = byId.get(item.question);
        return (
          question !== undefined &&
          gradeAnswer(question, item.answer) === "correct" &&
          majority(item.grades) === "correct"
        );
      })
      .map((item) => item.id);
    expect(passBoth).toEqual(KNOWN_GAPS);
  });

  it("is the grader that graded the recording", () => {
    expect(recording.audit.graderModel).toBe(selfTest.grader);
    expect(recording.audit.instructions).toBe(selfTest.instructions);
  });
});
