# Drift report 2026-11-25

`egm-drift-report` check of [design.md](design.md) and the study spec against the code at `6eff43e65`, run by a
fresh-context `egm-codebase-details` subagent. Result: 0 Blocker, 3 Major, 6 Nit. The rule module matched both
documents on every frozen value, code, check order, truth-table cell and golden case. All items are fixed in the next
commit.

| Item | Drift | Fixed in |
| --- | --- | --- |
| 1 (Major) | `/stock` analytics for another symbol returns `ticker_mismatch`, the design said `gex_missing` | design inputs and Pages |
| 2 (Major) | After a failed `/flow` refresh the badge keeps grading the last answers until an age limit applies | design Pages |
| 3 (Major) | A rate-limited analytics answer sends no `flow.control` request | design Pages and Performance |
| 4 (Nit) | Context line said "No wall in band" for `both_walls_near` and `wall_geometry` | view-model: "Both walls in band", "Call wall not above put wall" |
| 5 (Nit) | A `closed` freshness row only adds its collector message | design Pages |
| 6 (Nit) | Spec measured level age from `m` and did not name `drift_stale` | spec Rules (read time is the end of `m`) |
| 7 (Nit) | Spec said "within 2% of the GEX spot"; the code divides by price | spec Rules |
| 8 (Nit) | Code comment pointed the truth table at the design | rule module comment |
| 9 (Nit) | Files table wording | covered by the file table rows |
