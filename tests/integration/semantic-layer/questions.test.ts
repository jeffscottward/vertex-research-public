import { describe, expect, it } from "vitest";

import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";

// The Q20 rubric ("Which drift monitors are in alert?", reference: only ORB paper forward). Naming Sector
// Momentum as in alert is wrong. One form that states the reference is exempt: "... warn ... not alert".
const ORB = "Only the ORB paper forward monitor is in alert.";

describe("Q20 rubric", () => {
  const q20 = EVAL_QUESTIONS.find((question) => question.id === "Q20");
  if (q20 === undefined) throw new Error("Q20 is missing");

  it.each([
    "Sector momentum paper forward is at warn, not alert.",
    "Sector momentum is at warn and not in alert.",
    "Sector momentum paper forward: warn (not at alert).",
  ])("grades warn with a negated alert as correct: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("correct");
  });

  it.each([
    "Sector Momentum is in alert.",
    "ORB paper forward and Sector momentum paper forward are in alert.",
    "Sector momentum: alert",
    "Sector momentum is not ok, it is in alert.",
    "Sector momentum is in alert, not alert-free.",
    "Sector momentum is in alert; RSI MR is not in alert.",
    "Two monitors are in alert: ORB paper forward and Sector momentum paper forward; RSI MR is not in alert.",
    "In alert: ORB paper forward and Sector momentum paper forward (RSI MR paper forward: not alert).",
    "In alert: ORB paper forward, Sector momentum paper forward; not in alert: RSI MR paper forward.",
    "In alert:\n- ORB paper forward\n- Sector momentum paper forward\n\nNot in alert:\n- RSI MR paper forward",
    "Alert: ORB paper forward and Sector momentum paper forward (not alert: RSI MR paper forward).",
    "ORB paper forward and Sector momentum paper forward; the third monitor is not in alert.",
    "Sector momentum is past warn, not alert-free: it is in alert.",
  ])("grades Sector Momentum in alert as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("wrong");
  });

  // Known limit: every other wording of the negation still counts as wrong, so the rubric errs on the
  // strict side. "[^.]" also crosses line breaks: a sentence ends only at a full stop.
  it.each([
    "Sector momentum is not in alert.",
    "Sector momentum isn't in alert.",
    "Sector momentum is at warn rather than alert.",
    "Sector momentum is at warn, not alert; ORB is in alert.",
    "- Sector momentum paper forward: warn, not alert\n- RSI MR paper forward: ok, not alert",
  ])("still grades an unlisted correct wording as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB} ${sentence}`)).toBe("wrong");
  });
});
