import { describe, expect, it } from "vitest";

import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";

// The Q20 rubric ("Which drift monitors are in alert?", reference: only ORB paper forward). The forbidden
// pattern counts every "alert" after "Sector momentum" up to the next full stop as wrong. Two exact lines
// that state the reference are removed before that check (`allowed`); nothing else is exempt.
const ORB = "Only the ORB paper forward monitor is in alert.";

describe("Q20 rubric", () => {
  const q20 = EVAL_QUESTIONS.find((question) => question.id === "Q20");
  if (q20 === undefined) throw new Error("Q20 is missing");

  it.each([
    "Sector momentum paper forward is at warn, not alert.",
    "- Sector momentum paper forward is at warn, not alert.",
    "  * Sector momentum paper forward is at warn, not alert.  ",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "- Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
  ])("grades the allowed line as correct: %s", (line) => {
    expect(
      gradeAnswer(q20, `${ORB}\n${line}\n- RSI MR paper forward is ok.`)
    ).toBe("correct");
  });

  it.each([
    "Sector Momentum is in alert.",
    "ORB paper forward and Sector momentum paper forward are in alert.",
    "Sector momentum: alert",
    "Sector momentum is in alert; RSI MR is not in alert.",
    "In alert: ORB paper forward and Sector momentum paper forward (RSI MR paper forward: not alert).",
    "In alert: ORB paper forward, Sector momentum paper forward; not in alert: RSI MR paper forward.",
    "In alert:\n- ORB paper forward\n- Sector momentum paper forward\n\nNot in alert:\n- RSI MR paper forward",
    "ORB paper forward and Sector momentum paper forward; the third monitor is not in alert.",
    "Sector momentum paper forward is in alert; it was at warn, not alert.",
    "Sector momentum paper forward: level alert (was warn, not alert, at the previous check).",
    "Sector momentum is in alert; it passed warn on Monday and will not alert again until it is reset.",
    "Sector momentum is at warn, not alert\n\nAlerting monitors:\n- ORB paper forward\n- Sector momentum paper forward",
    "Alert: ORB paper forward, Sector momentum paper forward (previously warn, not alert).",
    "Monitors in alert:\n1. ORB paper forward\n2. Sector momentum paper forward (was warn, not alert).",
    "In alert: ORB paper forward (drawdown 1.6x baseline) and Sector momentum paper forward (previously warn, not alert).",
    "Sector momentum paper forward is __alert__ (previously warn, not alert).",
    "In alert: ORB paper forward and Sector momentum paper forward is at warn, not alert.",
    "Sector momentum paper forward is at warn, not alert, but it is in alert now.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only. It is in alert now.",
    "In alert: Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
  ])("grades Sector Momentum in alert as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // Known limit: every other correct wording that holds "alert" after the name stays wrong (strict side),
  // also the allowed sentence when it does not stand alone on its line.
  it.each([
    "Sector momentum is at warn, not alert.",
    "Sector momentum paper forward is at warn and not in alert.",
    "Sector momentum is not in alert.",
    "Sector momentum isn't in alert.",
    "ORB paper forward is in alert; Sector momentum paper forward is at warn, not alert.",
  ])("still grades another correct wording as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // The second allowed line is exact: a changed digit or a changed escaped character is not exempt.
  it.each([
    "Sector momentum paper forward is at warn, not alert (max drawdown 34.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24x37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22x50% baseline, ratio 1.08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1x08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08)x This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data onlyx",
    "sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08. This is paper data only.",
  ])("does not exempt the line when a character differs: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // Known gap, the same as on the base branch: the pattern does not see a claim in a sentence that has no
  // "alert" after the name. The independent grade is the check for it (wrong by either grade counts).
  it.each([
    "- Sector momentum paper forward is at warn, not alert.\nCorrection: it is now in alert as well.",
    "- Sector momentum paper forward is at warn, not alert.\nIn alert now: ORB paper forward and Sector momentum paper forward.",
    "In alert: ORB paper forward and Sector momentum paper forward.",
  ])("does not catch a claim outside the pattern: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("correct");
  });

  it("keeps the required patterns on the whole answer", () => {
    expect(
      gradeAnswer(q20, "- Sector momentum paper forward is at warn, not alert.")
    ).toBe("declined");
  });
});
