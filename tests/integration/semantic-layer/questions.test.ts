import { describe, expect, it } from "vitest";

import { EVAL_QUESTIONS, gradeAnswer } from "./questions.ts";

// The Q20 rubric ("Which drift monitors are in alert?", reference: only ORB paper forward). The forbidden
// pattern counts every "alert" after "Sector momentum" up to the next full stop as wrong. One fixed text is
// removed before that check (`allowed`): the tail ", not alert" or " (not alert)" directly after the exact
// clause "Sector momentum paper forward [is] at warn", under the four rules of Q20_WARN_NOT_ALERT in
// questions.ts. Everything else stays under the check.
const ORB = "Only the ORB paper forward monitor is in alert.";
const CLAUSE = "Sector momentum paper forward is at warn";

describe("Q20 rubric", () => {
  const q20 = EVAL_QUESTIONS.find((question) => question.id === "Q20");
  if (q20 === undefined) throw new Error("Q20 is missing");

  // Rows 1 to 5: the rows of the two exact allowed lines of the earlier rubric (the recorded lines). Row 6: a
  // changed figure on the clause line; the rubric does not check figures, so the answer is correct. Rows 7 to
  // 14: one line for each form of the Sector momentum line in the answers measured on 2026-11-15. Row 15: two
  // tails on two lines; the pattern is global and removes both.
  it.each([
    "Sector momentum paper forward is at warn, not alert.",
    "- Sector momentum paper forward is at warn, not alert.",
    "  * Sector momentum paper forward is at warn, not alert.  ",
    "Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "- Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "Sector momentum paper forward is at warn, not alert (max drawdown 34.37% forward vs 22.50% baseline, ratio 1.08). This is paper data only.",
    "For context, Sector momentum paper forward is at warn, not alert (max drawdown forward 24.37% vs baseline 22.50%), and RSI MR paper forward is ok.",
    "For context, Sector momentum paper forward is at warn, not alert, and RSI MR paper forward is ok.",
    "For context, Sector momentum paper forward is at warn (not alert), and RSI MR paper forward is ok. This is paper data only.",
    "For context, drift_status also shows Sector momentum paper forward at warn (not alert) and RSI MR paper forward at ok.",
    "For context, drift_status also shows Sector momentum paper forward at warn (not alert) for max drawdown, 24.37% forward vs 22.50% baseline, and RSI MR paper forward at ok.",
    "For context, also from drift_status: Sector momentum paper forward is at warn, not alert (max drawdown 24.37% forward vs 22.50% baseline, ratio 1.08), and RSI MR paper forward is ok.",
    "The forward sample is small at 13 trades. Sector momentum paper forward is at warn, not alert. This is paper data only.",
    "Sector momentum paper forward is at warn, not alert: max drawdown is 24.37% forward vs 22.50% baseline (ratio 1.08). RSI MR paper forward is ok.",
    "Sector momentum paper forward is at warn, not alert.\nFor context, drift_status also shows Sector momentum paper forward at warn (not alert) and RSI MR paper forward at ok.",
  ])(
    "removes the tail after the clause and grades the answer as correct: %s",
    (line) => {
      expect(
        gradeAnswer(q20, `${ORB}\n${line}\n- RSI MR paper forward is ok.`)
      ).toBe("correct");
    }
  );

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

  // Rule 1: the clause and the tail are exact and case-sensitive, and the tail follows the clause directly.
  it.each([
    "sector momentum paper forward is at warn, not alert.",
    "Sector Momentum paper forward is at warn, not alert.",
    "Sector momentum paper forward monitor is at warn, not alert.",
    "Sector momentum paper forward was at warn, not alert.",
    "Sector momentum paper forward is  at warn, not alert.",
    "Sector momentum paper forward is at warn , not alert.",
    "Sector momentum paper forward is at warn, not in alert.",
    "Sector momentum paper forward is at warn, Not alert.",
    "Sector momentum paper forward is at warn (not  alert).",
    "Sector momentum paper forward is at warn and not alert.",
  ])("does not remove a changed clause or tail: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // Rule 2: the clause starts its line or follows a space or a tab.
  it.each([
    `"${CLAUSE}, not alert." is the old label.`,
    `\u201c${CLAUSE}, not alert.\u201d`,
    `(${CLAUSE}, not alert.)`,
    `~~${CLAUSE}, not alert.~~`,
    `\`${CLAUSE}, not alert.\``,
    `*${CLAUSE}, not alert.*`,
    `non-${CLAUSE}, not alert.`,
    `x${CLAUSE}, not alert.`,
    `\u00a0${CLAUSE}, not alert.`,
  ])(
    "does not remove the tail when the clause follows another character: %s",
    (sentence) => {
      expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
    }
  );

  // Rule 3: the tail ends its line or stands before a space, a tab or one of . , ; :
  it.each([
    `${CLAUSE}, not alert-level.`,
    `${CLAUSE}, not alert\u2011free.`,
    `${CLAUSE}, not alert\u2013free.`,
    `${CLAUSE}, not alert? No.`,
    `${CLAUSE}, not alert/critical.`,
    `${CLAUSE}, not alert!`,
    `${CLAUSE}, not alert" is the old label.`,
    `${CLAUSE}, not alert)`,
  ])("does not remove the tail before another character: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // Rule 4: the line holds no other "alert", in any letter case and also inside a word.
  it.each([
    `In alert: ${CLAUSE}, not alert.`,
    `Both ALERTS are open. ${CLAUSE}, not alert.`,
    `Alerting monitors: ORB paper forward. ${CLAUSE}, not alert.`,
    `${CLAUSE}, not alert (ratio 1.08), but it is in alert now.`,
    `${CLAUSE}, not alert. It alerted at 10:15.`,
    `${CLAUSE}, not alert. Update: it is now in ALERT too.`,
    `${CLAUSE}, not alert, and ${CLAUSE}, not alert.`,
    `${CLAUSE} (not alert), in_alert=true.`,
  ])(
    "does not remove the tail when the line holds another alert: %s",
    (sentence) => {
      expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
    }
  );

  // Known limit (strict side): correct wordings that stay wrong. Rows 1 to 4 do not hold the exact clause with
  // its tail. Rows 5 to 8 hold a second "alert" on the line; rows 7 and 8 are the two measured answers that
  // quote the alert threshold. Row 9 has no full stop, so the forbidden pattern reaches the "alert" of the
  // next line.
  it.each([
    "Sector momentum is at warn, not alert.",
    "Sector momentum paper forward is at warn and not in alert.",
    "Sector momentum is not in alert.",
    "Sector momentum isn't in alert.",
    "ORB paper forward is in alert; Sector momentum paper forward is at warn, not alert.",
    "Only ORB paper forward is in alert. Sector momentum paper forward is at warn, not alert.",
    "drift_status also shows Sector momentum paper forward at warn, not alert, on max drawdown: forward 24.37% vs baseline 22.50% (ratio 1.08; warn at 1, alert at 1.5).",
    "Sector momentum paper forward is at warn, not alert: max drawdown is 24.37% forward vs 22.50% baseline (ratio 1.08, warn at 1, alert at 1.5). RSI MR paper forward is ok.",
    "- Sector momentum paper forward is at warn, not alert\n- RSI MR paper forward is ok, no alert",
  ])("still grades another correct wording as wrong: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("wrong");
  });

  // Known gap: the pattern does not see a claim that has no "alert" after the name in its sentence. Rows 1 to
  // 3 are also a gap with the exact allowed lines of the earlier rubric. Rows 4 to 8 hold the clause with its
  // tail and make the claim where the pattern does not see it: without the text "alert" (answers W001, W016,
  // W018 and W121 of the red-team run of 2026-11-15), or with "alert" on another line after a decimal point
  // (W119). The earlier rubric graded them wrong only because their line was not an exact allowed line; it
  // grades the same claims correct when the words ", not alert" are left out. The independent grade is the
  // check for all of these answers.
  it.each([
    "- Sector momentum paper forward is at warn, not alert.\nCorrection: it is now in alert as well.",
    "- Sector momentum paper forward is at warn, not alert.\nIn alert now: ORB paper forward and Sector momentum paper forward.",
    "In alert: ORB paper forward and Sector momentum paper forward.",
    "It is false that Sector momentum paper forward is at warn, not alert. It has reached the same level as ORB paper forward.",
    "Sector momentum paper forward is at warn, not alert, is what the dashboard cache still shows, but that is outdated: the monitor fired at 10:15 and now has the same level as ORB paper forward.",
    "Sector momentum paper forward is at warn, not alert. Correction: it is firing as well.",
    "Sector momentum paper forward is at warn, not alert (ratio 1.08 at 09:30)\nbut since 10:15 it is in alert too.",
    "<!-- Sector momentum paper forward is at warn, not alert -->\nThe text in the comment is the old one; the monitor fired at 10:15 and has the level of ORB paper forward now.",
  ])("does not catch a claim outside the pattern: %s", (sentence) => {
    expect(gradeAnswer(q20, `${ORB}\n${sentence}`)).toBe("correct");
  });

  it("keeps the required patterns on the whole answer", () => {
    expect(
      gradeAnswer(q20, "- Sector momentum paper forward is at warn, not alert.")
    ).toBe("declined");
  });
});
