# Drift Report — Smart money PR 7 (backtests)

- **Date:** 2026-11-25
- **Documents:** `docs/vertex-rebuild/designs/smart-money/plan-pr7.md` (whole document) and `docs/vertex-rebuild/designs/smart-money/design.md` (goal 7 and section "PR 7: Backtests"). The other files in the folder describe PRs 1 to 6, which merged earlier, and were not in scope.
- **Method:** `egm-drift-report` with one fresh-context reader (`egm-codebase-details`) on the working tree before the PR. The reader found 10 major and 10 minor divergences. Each one is resolved below; the list shows what changed.

## plan-pr7.md

Divergences fixed in the code:

- **Unparsed House PTRs (line 35, line 106).** The collector counted scanned paper PTRs only and labelled the range "2020–2026". The collector ledger is now per chamber and filing year (`fetch_data.py`), and the runner builds the gap rows from it (`__main__.py`, `_congress_coverage_gaps`): scanned paper per chamber, and House PTRs with an unknown PDF layout (`171` of `2,501` in `2022`–`2026`, `151` of them in `2022`). The Congress spec and the migration description state the same counts.
- **Study notes limit (line 125).** `document.py` cut notes at 16,000 characters; the contract allows 4,000. The cut is now 4,000 (`NOTES_MAX_CHARS`).
- **Dropped events of Signal 3 (line 44).** `build_signal3_events` now counts ticker-sessions without bars and illiquid ticker-sessions, and the study has a robustness row and a gap row for overlap, capacity and missing-bar skips.
- **Entry day before the window (line 55).** The entry day now comes from the full SPY calendar; an event whose entry day is outside the study window is dropped and counted (`skipped_outside_window`). No recorded event was affected.
- **Tests named in the plan (line 176).** Tests for the skew and raw kurtosis passed to `deflated_sharpe_ratio` and for pure-stdlib imports now exist.

Divergences fixed in the documents (the code was right):

- `provenance.runId` uses the run date (`2026-11-25` for the recorded run), not a fixed `2026-11-23` (line 133).
- `multi-member-30d` has a 14-day per-ticker cooldown (line 111; also rule 5 of the Congress spec).
- The Form 4 filter is `DOCUMENT_TYPE = '4'`, `TRANS_CODE = 'P'`, shares and price above zero; the insider spec no longer names `TRANS_ACQUIRED_DISP_CD` (line 85).
- The Congress spec names `openbb_congress_trades` and `openbb_congress_filings`; the premium spec names `flow_market_premium_sessions` with `status = 'complete'` (lines 100 and 117).
- Deflated Sharpe wording: trials with a finite Sharpe count, a zero-variance trial counts as `0.0`, and a `ValueError` gives "DSR unavailable", which the gate treats as `0.0` (line 68).
- The Signal 3 stop compares trading sessions of the observed window with `490` (line 119).
- The 600-ticker cap includes SPY and the 146 stocks (line 44).
- The benchmark return after a stock-bar gap runs from the session of the stock's previous bar (line 59).
- Member-name prefixes and suffixes, the confirmation cooldown, the 55-bar minimum, the baseline rule's own liquidity floor and the 5-bar minimum of the liquidity check are stated (lines 44, 91, 94, 103).
- The SEC column list names `TRANS_DATE` and `AFF10B5ONE`; the stale sentence about a later design update is removed (line 83).
- The knowledge-base archive path is `~/Documents/reports/web/vertex-smart-money-pr7/kb/` (line 39).

Sections 5 and 6: every named command, script and path exists in the repository.

## design.md

- **Section "PR 7: Backtests".** The section said that the SEC quarterly datasets match PR 3's note, which names a research-only table. PR 7 keeps the multi-year rows in a research-only file on the rig and creates no table. The sentence now says so.
- Goal 7: No drift detected.

## Open after this report

- None in the code or the documents. The deploy and live-check steps of plan section 6 run after the merge.
