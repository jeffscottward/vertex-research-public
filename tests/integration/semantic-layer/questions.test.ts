import { describe, expect, it } from "vitest";

import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";

// The Q20 rubric ("Which drift monitors are in alert?", reference: only ORB paper forward). Naming Sector
// Momentum as in alert is wrong; saying that it is not in alert agrees with the reference.
const ORB = "Only the ORB paper forward monitor is in alert.";

describe("Q20 rubric", () => {
  const q20 = EVAL_QUESTIONS.find((question) => question.id === "Q20");
  if (q20 === undefined) throw new Error("Q20 is missing");

  it.each([
    "Sector momentum paper forward is at warn, not alert.",
    "Sector momentum is not in alert.",
    "Sector momentum is not at alert.",
  ])("grades a negated alert as correct: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("correct");
  });

  it.each([
    "Sector Momentum is in alert.",
    "ORB paper forward and Sector momentum paper forward are in alert.",
    "Sector momentum: alert",
    "Sector momentum is not ok, it is in alert.",
    "Sector momentum is in alert, not alert-free.",
    "Sector momentum is in alert; RSI MR is not in alert.",
  ])("grades Sector Momentum in alert as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("wrong");
  });

  // Known limit: other wordings of the negation still count as wrong, so the rubric errs on the strict side.
  it.each([
    "Sector momentum isn't in alert.",
    "Sector momentum is at warn rather than alert.",
  ])("still grades an unlisted negation as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("wrong");
  });
});
