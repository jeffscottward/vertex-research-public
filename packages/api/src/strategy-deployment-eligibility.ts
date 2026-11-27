// Which strategies may get a paper deployment request. The web (library detail, request form) and
// the server (deploymentRequests create, edit, submit, approve) use this one rule, so the page and
// the API give the same answer. A block removes a request path; it grants no trading authority.
import type { StrategyVertexStudy } from "./contracts/strategy-library.ts";

/** A strategy with this tag has no deployment or order action. */
export const RESEARCH_ONLY_TAG = "research-only";
/** Vertex tested the strategy and it failed; the library badge "Tested, failed" reads this tag. */
export const FAILED_TAG = "failed";

export type StrategyDeploymentBlockCode =
  | "research-only"
  | "study-no-edge"
  | "study-failed"
  | "tagged-failed";

export type StrategyDeploymentBlock = Readonly<{
  code: StrategyDeploymentBlockCode;
  /** The short line shown in place of the request action. */
  label: string;
  /** One full sentence: the server refusal message and the hint of the label. */
  reason: string;
}>;

const BLOCKS: Readonly<
  Record<StrategyDeploymentBlockCode, StrategyDeploymentBlock>
> = Object.freeze({
  "research-only": {
    code: "research-only",
    label: "Research only: no deployment",
    reason:
      "This strategy is tagged research-only; a paper deployment cannot be requested for it.",
  },
  "study-no-edge": {
    code: "study-no-edge",
    label: "No edge: no paper deployment",
    reason:
      "The Vertex study of this strategy found no edge; a paper deployment cannot be requested for it.",
  },
  "study-failed": {
    code: "study-failed",
    label: "Failed backtest: no paper deployment",
    reason:
      "The Vertex backtest of this strategy failed its pass rule; a paper deployment cannot be requested for it.",
  },
  "tagged-failed": {
    code: "tagged-failed",
    label: "Tested, failed: no paper deployment",
    reason:
      "This strategy is tagged failed (Vertex tested it and it failed); a paper deployment cannot be requested for it.",
  },
});

// The study verdicts that block a request. The verdicts of the two study kinds do not overlap, so
// the verdict alone selects the block. edge, PASS and needs-more-data do not block.
const BLOCK_BY_VERDICT: Readonly<
  Partial<Record<StrategyVertexStudy["verdict"], StrategyDeploymentBlockCode>>
> = Object.freeze({
  "no-edge": "study-no-edge",
  FAIL: "study-failed",
});

/**
 * Why this strategy has no paper deployment request, or null when it may have one. The order is
 * the order of the library badge, so the line and the badge never disagree:
 * 1. the tag research-only;
 * 2. the Vertex study verdict that the library list and get show (`vertexStudy`): no-edge and FAIL
 *    block, and edge, PASS and needs-more-data do not, whatever the tags say;
 * 3. with no study shown (`vertexStudy` null or absent), the tag failed.
 */
export const strategyDeploymentBlock = (
  strategy: Readonly<{
    tags: readonly string[];
    vertexStudy?: StrategyVertexStudy | null;
  }>
): StrategyDeploymentBlock | null => {
  if (strategy.tags.includes(RESEARCH_ONLY_TAG)) return BLOCKS["research-only"];
  const verdict = strategy.vertexStudy?.verdict;
  if (verdict === undefined)
    return strategy.tags.includes(FAILED_TAG) ? BLOCKS["tagged-failed"] : null;
  const code = BLOCK_BY_VERDICT[verdict];
  return code === undefined ? null : BLOCKS[code];
};
