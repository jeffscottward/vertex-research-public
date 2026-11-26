# Goldfish review resolution: GEX wall × net drift read

**Target:** [design.md](design.md) and
[gex-wall-drift-confluence.md](../../../specs/strategies/gex-wall-drift-confluence.md).
**Source:** [consolidated_review_report.md](consolidated_review_report.md).
**Gate:** "Auto accept" (standing owner rule of 2026-11-13): every PROPOSE FIX is applied; CONTEST and DECLINE stay as
recorded here. No finding needed a fact only the owner has (no ESCALATE).

**Counts:** 24 PROPOSE FIX (applied, plus the Nits), 4 CONTEST, 2 DECLINE (moved to Future Improvements).

| Id | Disposition | What changed or why not |
| --- | --- | --- |
| C1 | PROPOSE FIX | Spec: H2 compares `hold-A` with `flat` above the flip only; H1 is stratified by flip side (Mantel-Haenszel). |
| C2 | PROPOSE FIX | Spec: power statement (about 170 touches per group for a 15-point difference at 80%), minimum 170 per compared group, end date 2027-11-26 with a final `needs-more-data`. |
| C3 | PROPOSE FIX | Spec: a touch is any first entry into the band from the inside; re-arm after 30 min outside; new strike = new wall; wall strike fixed at the touch; jump-throughs reported. |
| C4 | PROPOSE FIX | Spec: no split; every counted touch is after the freeze and out of sample. |
| C5 | PROPOSE FIX | Spec: Holm-Bonferroni at 0.05 stated with its two cut-offs. |
| C6 | PROPOSE FIX | Design: code / read / condition table; terms section. |
| C7 | PROPOSE FIX | Badge reserves 128 px; the reason line reserves two lines. |
| C8 | PROPOSE FIX | `/stock` badge renders in the loading, failed and rate-limited states with the reason. |
| C9 | PROPOSE FIX | Rule: price is the newest minute's price; no price there gives `no_price`. |
| C10 | PROPOSE FIX | Spec: session-block bootstrap p-value (10,000 resamples, fixed seed). |
| C11 | PROPOSE FIX | Spec: counted touches start the session after the freeze; looks before the run print counts only. |
| C12 | PROPOSE FIX | Spec: ten golden cases; `gex-wall-drift-spec.test.ts` runs them against the code. |
| C13 | PROPOSE FIX | Spec: vendor `total` only (a missing minute is a gap); revisions are a stated limit. |
| C14 | PROPOSE FIX | `StockWallDrift` re-checks every 60 s; tested with fake timers. |
| C15 | PROPOSE FIX | Rule: `not_read` flip side for no-data reads before price is known; the flip side is set once price is known. |
| C16 | PROPOSE FIX | Rule: `gex_no_walls` no-data code. |
| C17 | PROPOSE FIX | `/flow`: "flow snapshot not loaded: <error>". |
| C18 | PROPOSE FIX | A `stale` or `never` collector row is passed through as the no-data reason with its message. |
| C19 | PROPOSE FIX | Design: user journeys, open questions (none), alternatives with pros and cons, security and privacy, file table with Create/Modify. |
| C20 | PROPOSE FIX | Design: terms for band, window, share, rising, touch, read time, operator, member, sources, levels; task file path. |
| C21 | PROPOSE FIX | Design: the spec's "Rules" section is the authority; the design keeps the explanation and the code table. |
| C22 | CONTEST | The task asks for the stock page; the badge names its levels source and the spec lists it as untested. |
| C23 | CONTEST | The owner asked for a visible hold/break grade; the unvalidated marker sits next to the pill. |
| C24 | CONTEST | The slope is one call-minus-put number built from server sums; a per-side window in the rule module keeps the study runner independent of the server. |
| C25 | PROPOSE FIX | Help text says the read is shown every minute and the study counts first touches only. |
| C26 | DECLINE | An accrual counter is useful but is a new scheduled job; listed in Future Improvements. |
| C27 | CONTEST | v1 follows the reel (rising lines only); put selling at the put wall is reported as its own row in the study. |
| C28 | PROPOSE FIX | Design: "A badge that describes the drift without a grade" added and rejected with its reason. |
| C29 | PROPOSE FIX | Rule: age limits written as numbers; a test keeps them no looser than the collector limits. |
| Nits | PROPOSE FIX | Renamed vague words (`no_flip`, `hold_no_flip`), New York input times, `groupOfSymbol(flowSymbolForTicker())` for the group, help text, money text through `Intl`, `page.tsx` prop order restored, SPX band in strikes. |
| Study runner | DECLINE | Out of scope for this card; Future Improvements. |
