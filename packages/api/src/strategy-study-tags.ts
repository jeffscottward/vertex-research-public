// Strategy library tags that say a strategy has a Vertex backtest study stored under its slug
// (research_studies.id = slug), and the study kind each tag expects. The strategyLibrary list/get
// helper and the web Backtests tab both use these, so the list badge and the tab follow one rule.
// Research only: a study verdict grants no trading authority.
import {
  QC_PORT_STUDY_KIND,
  STRATEGY_BACKTEST_STUDY_KIND,
} from "./contracts/research-studies.ts";

/** QuantConnect idea ports: a qc-port study (verdict PASS or FAIL). */
export const QC_IDEA_TAG = "quantconnect-idea";
/** Strategy backtest studies: verdict edge, no-edge or needs-more-data. */
export const BACKTEST_STUDY_TAG = "backtest-study";

export type StrategyStudyKind =
  | typeof QC_PORT_STUDY_KIND
  | typeof STRATEGY_BACKTEST_STUDY_KIND;

export const STUDY_KIND_BY_TAG: Readonly<Record<string, StrategyStudyKind>> =
  Object.freeze({
    [QC_IDEA_TAG]: QC_PORT_STUDY_KIND,
    [BACKTEST_STUDY_TAG]: STRATEGY_BACKTEST_STUDY_KIND,
  });

/** The study kinds a strategy with these tags can show; empty when it has no study tag. */
export const studyKindsForTags = (
  tags: readonly string[]
): ReadonlySet<StrategyStudyKind> => {
  const kinds = new Set<StrategyStudyKind>();
  for (const tag of tags) {
    const kind = Object.hasOwn(STUDY_KIND_BY_TAG, tag)
      ? STUDY_KIND_BY_TAG[tag]
      : undefined;
    if (kind !== undefined) kinds.add(kind);
  }
  return kinds;
};
