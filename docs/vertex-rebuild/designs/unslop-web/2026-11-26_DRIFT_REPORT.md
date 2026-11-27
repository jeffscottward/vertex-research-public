# Drift Report: `unslop-web` plan against the code

- **Plan:** `docs/vertex-rebuild/designs/unslop-web/plan.md`
- **Head checked:** `3f39f927a` (6 commits, rebased on `582623a34`), by a fresh-context agent with the `egm-drift-report` skill. Static check only.
- **Result:** 70 plan statements and all 101 named file paths matched. 18 differences: 4 needed a code change or a decision, 14 were plan wording.

## Differences that needed code or a decision

| Plan item | Difference | Resolution |
| --- | --- | --- |
| D9, Alternative 14 | The comment and the sentence of the app-root not-found page said that it serves every unmatched address. The router serves an unmatched address with the public not-found page. | Code: comment and sentence corrected; a portal not-found page added for portal routes. |
| Goal 7 | 5 Flow badges still had the pill shape. | Code: the freshness rows are plain text. Plan: goal 7 names the 4 badges that keep their shape and says why. |
| D5, "the code stays in a `data-*` attribute" | True for run status, run flags, control state and freshness only. | Plan: the sentence names these four. |
| Goal 4, Problem 6 | The Baskets subtitle ends with "Tracking only: no orders." | Decision: it stays; Non-Goal 2 names it. |

## Plan wording that was corrected

- D5: the metric labels are in `labelledMetrics`; existing Flow labels changed case; code values of metrics.
- File lists: the public footer, the badge export of the Strategy library detail, the placeholder case of two ticker inputs, the edit form of Semantic terms, the Academy lesson tags, the border of the stop-order warning, the research chat style sheet.
- Goal 9: 6 labels, of which 1 is removed.
- Test Plan: which tests change; the case names of the Breadth 90 card test.
- Header and risks: the two baseline commits, the file count, one rollback statement in place of two.

A second check after the review fixes is in the pull request description.
