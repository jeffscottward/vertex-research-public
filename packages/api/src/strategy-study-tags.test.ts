import { describe, expect, it } from "vitest";

import {
  BACKTEST_STUDY_TAG,
  QC_IDEA_TAG,
  STUDY_KIND_BY_TAG,
  studyKindsForTags,
} from "./strategy-study-tags.ts";

describe("strategy study tags", () => {
  it("maps each study tag to its study kind", () => {
    expect(STUDY_KIND_BY_TAG).toEqual({
      "backtest-study": "strategy-backtest",
      "quantconnect-idea": "qc-port",
    });
    expect([...studyKindsForTags([QC_IDEA_TAG])]).toEqual(["qc-port"]);
    expect([...studyKindsForTags(["x", BACKTEST_STUDY_TAG])]).toEqual([
      "strategy-backtest",
    ]);
  });

  it("gives no kind without a study tag, including inherited object keys", () => {
    expect(studyKindsForTags([]).size).toBe(0);
    expect(studyKindsForTags(["failed", "toString", "constructor"]).size).toBe(
      0
    );
  });

  it("gives both kinds when both tags are present", () => {
    expect([
      ...studyKindsForTags([BACKTEST_STUDY_TAG, QC_IDEA_TAG, QC_IDEA_TAG]),
    ]).toEqual(["strategy-backtest", "qc-port"]);
  });
});
