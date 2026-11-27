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

## Live check of 2026-11-27

The live check of build `18db0bda` (58 portal pages, 11 public and sign-in pages, 4 not-found addresses, at 1440 and 375 px) found 2 differences between the plan and the site. A follow-up pull request corrects both.

| Plan item | Difference | Resolution |
| --- | --- | --- |
| Goal 4, table "Subtitles" | The subtitles of Research dossiers and of one dossier still repeated the notice ("Research only; a recommendation does not authorize a trade."). The table did not list them. | Code: both subtitles lose the sentence. Plan: the table has the 2 rows. Test: a guard reads every `PageHeader` description. |
| D5 (words in place of raw codes on Flow) | The collector message of the net drift feed printed the provider part name `zero_dte` in the Wall × drift panel. | Code: `packages/api/src/server/flow-collect.ts` writes `0DTE` in the message. |

Agent runs prints the agent name `inthemoneyadam_desk` as written. That is a name, and D5 keeps names and identifiers as written.
