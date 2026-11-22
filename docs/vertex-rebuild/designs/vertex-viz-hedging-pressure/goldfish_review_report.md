# Goldfish review report: resolutions

Resolution gate: "Auto accept" (owner rule of 2026-11-13): every PROPOSE FIX is applied to
`design.md`; CONTEST and DECLINE items stay as recorded here. No item needed ESCALATE.
Item numbers refer to [consolidated_review_report.md](consolidated_review_report.md).

## Prioritized Findings & AI Suggestions

| Item | Sev | AI suggestion | Resolution in `design.md` |
| --- | --- | --- | --- |
| A1 | Blocker | PROPOSE FIX | Terms "Operator session and agent viewer"; Procedure section; phase A step 5 tests (`isAgentApiKeyProcedurePath` and `AGENT_API_KEY_READ_PROCEDURES` false; reviewed viewer list updated; `operator-access.ts` and `handler.ts` unchanged) |
| A2 | Blocker | PROPOSE FIX | Section "Alternatives Considered" with C1-C3, D1-D3, S1-S2, T1, P1, each with its reason |
| A3 | Blocker | PROPOSE FIX | Section "Technical Plan (Architecture)" (read path, computation, procedure and response, page) and Figure 2 `data-flow.svg` |
| A4 | Major | PROPOSE FIX | Term "Gap", read path step 4, `gaps` field, header sentence, shading, journey 3, risk row |
| A5 | Major | PROPOSE FIX | Line = options session 09:30-16:15 (`optionsSessionRange`); pre-open prints as `preOpen` totals; session date by `flowSessionDate(newest print)`; at most 405 points (also resolves A36) |
| A6 | Major | PROPOSE FIX | Moneyness checked on the database: 7,295 of 7,297 placeholder prints are in the money; 965 within 2% of spot with under 0.5 days. Rule changed: `iv < 1` uses volatility 0.20 (not 0.01), `iv > 500` uses 5.00, both counted "IV adjusted" |
| A7 | Major | PROPOSE FIX | `r = OPTIONS_CHAIN_RISK_FREE_RATE` (0.04), `q = DIVIDEND_YIELD.get("SPY")` (0.015), named in the rule text |
| A8 | Major | PROPOSE FIX | "Estimated", "would", "delta at the time of the print"; risk row on frozen delta (gamma); alternative C3; "stores the prints that QuantData returns" |
| A9 | Major | PROPOSE FIX | Data facts: "smallest stored premium; consistent with a QuantData minimum, not confirmed"; rule text says "Only prints with premium of $10,000 or more are stored" |
| A10 | Major | PROPOSE FIX | `largestRise` and `largestFall` in `totals`, a visible totals line and the aria label |
| A11 | Major | PROPOSE FIX | Computation step 4 gives the count order, units (`iv` percent, `dte` days, `T` years), `underlying_price` by name, `iv <= 0`, non-finite guards and `gross` |
| A12 | Major | PROPOSE FIX | Response table with types; exact `rules` keys; `FlowHedgingPressureRulesSchema` in the contract, imported by the rules module |
| A13 | Major | PROPOSE FIX | `HedgingPrint` declared in the rules module; database returns `FlowHedgingPrintRecord` |
| A14 | Major | PROPOSE FIX | `FLOW_HEDGING_SYMBOLS` with a contract test against `FLOW_INSTRUMENTS` sources |
| A15 | Major | PROPOSE FIX | `date` input removed; non-goal 4; future improvement |
| A16 | Major | PROPOSE FIX | Reason recorded independent of the unchecked fact (D1 works on every stored print; D2 leaves stored rows empty and needs a migration); open question 1 and a revisit trigger. The vendor field was not checked: no raw row is stored and a live vendor request is outside this design step |
| A17 | Major | PROPOSE FIX | "Files" table with Create/Modify and full paths, including the contract keys test, both repository doubles, the db index, the lab gateway and `research.test.tsx` |
| A18 | Major | PROPOSE FIX | Phases A, B, C that each build; `openapi:check`, `docs:check`, `verify:core`, `verify:coverage` |
| A19 | Major | PROPOSE FIX | Lab serves SPY and ES responses through the workspace; empty, truncated and failed states in component tests |
| A20 | Major | PROPOSE FIX | `hedgingForbidden` ref, end-of-load check of both refs, two workspace tests |
| A21 | Major | PROPOSE FIX | Exact text templates in "User experience"; `formatSignedCompactUsd` with examples and U+2212; tick rule. Not moved from smart money: that formatter uses a hyphen-minus, `/flow` uses U+2212 |
| A22 | Major | PROPOSE FIX | `tests/integration/database/flow-hedging-prints.test.ts` with its cases; return type and re-export |
| A23 | Major | PROPOSE FIX | `newYorkTime(date, 0)`, `newYorkTime(date, 570)`, `optionsSessionRange(date).to`, `flowSessionDate` named |
| A24 | Major | PROPOSE FIX | `FlowHedgingPressureRows` type, `newestOptionPrintAt`, `session: null` path, never-throw delta |
| A25 | Major | PROPOSE FIX | Overflow by `scrollWidth <= innerWidth`; independent script, $1 tolerance, not committed |
| A26 | Major | PROPOSE FIX | "Risks and Mitigations" with access, stale collector, bad row, read cost rows |
| A27 | Major | PROPOSE FIX | Overview, Open Questions, CUJs, Technical Plan, Alternatives, NFRs, Future Improvements; Data facts moved after the design sections |
| A28 | Major | PROPOSE FIX | Private link removed (the public-names CI check also forbids real tailnet labels); the gap row is quoted |
| A29 | Major | PROPOSE FIX | Figure 1 caption states what the mock leaves out; alt text "Figure 1. …" |
| A30 | Major | PROPOSE FIX | Goal 4 points to MASTER.md; accessibility states "no interactive control", WCAG AA 4.5:1, dash patterns; acceptance names widths and themes |
| A31 | Major | PROPOSE FIX | Terms "Symbol and ticker" (SPX index dollars for ES), "Source freshness"; chart 2 says "SPX index for ES" |
| A32 | Major | PROPOSE FIX | `bun run openapi:generate` |
| A33 | Nit | PROPOSE FIX | Truncation is a suffix on the header line; the newest prints dropped are named. Keyset paging DECLINED: the cap is 7.8 times the busiest day |
| A34 | Nit | DECLINE | No cache in version 1 (15 ms read; end-to-end target under 300 ms is measured after deploy). Recorded in Risks and NFRs |
| A35 | Nit | PROPOSE FIX | Info and warning tokens, not success and destructive |
| A36 | Nit | PROPOSE FIX | Resolved by A5 (at most 405 minutes) |
| A37 | Nit | PROPOSE FIX | `dte` null counts as not priced; no expiry-time path |
| A38 | Nit | DECLINE | The rules module keeps its own sign table; the design names it as the same grouping as `flow.snapshot`. A shared map would change `server/flow-snapshot.ts`, outside this change |
| A39 | Nit | PROPOSE FIX | Computation step 3 states the difference from the GEX convention |
| A40 | Nit | PROPOSE FIX | Applied during the rewrite (metadata block, heading names, terms, "about 7.8 times", restart window, stroke widths, test paths, window select, doc placement) |

## Counts

- Accepted fixes (PROPOSE FIX): 38 items.
- Contested: 0. Escalated: 0.
- Declined: 1 Nit item (A34), plus the keyset paging part of A33. A38 was first declined and then fixed by Z8-N5.
- Remaining unaddressed: 0.

## Stage 8 findings (on the revised document)

Same gate ("Auto accept").

| Item | Sev | AI suggestion | Resolution in `design.md` |
| --- | --- | --- | --- |
| Z8-M1 | Major | PROPOSE FIX | Pre-open totals dropped; the read is `optionsSessionRange(date)` only; the rule text says prints before 09:30 ET are not counted; alternative T1 records why |
| Z8-M2 | Major | PROPOSE FIX | Input guards cut to null checks; `σ = iv ÷ 100`, or `volFallback` when `iv < 1`; `T = max(dte, 0) ÷ 365`; a reachable catch of `bsDelta` counts as not priced; `volMax` and `minDays` removed |
| Z8-N1 | Nit | PROPOSE FIX | `rules` limited to `version`, `rate`, `dividendYield`, `volFallback`; `hedgingRuleText(rules)` builds the text; the read cap is a server constant |
| Z8-N2 | Nit | PROPOSE FIX | `unread` = one covering span plus a range count, like the `flow.control` cross-check; no cap of 20 |
| Z8-N3 | Nit | PROPOSE FIX | No panel for QQQ and NQ; the page's `notCollectedLine` already names the missing prints |
| Z8-N4 | Nit | PROPOSE FIX | `HedgingPrint = Pick<FlowOptionPrintRow, …>` |
| Z8-N5 | Nit | PROPOSE FIX | `SIDE_SIGN` moves to `flow-options.ts` as `OPTION_SIDE_SIGN`; `flow-control.ts` and the rules use it (supersedes the A38 decline) |
| Z8-N6 | Nit | PROPOSE FIX | `formatSignedMoney` on top of `formatMoney`; gross uses `formatMoney` |
| Z8-N7 | Nit | PROPOSE FIX | Figure row removed from the files table |

Stage 8 counts: 9 accepted, 0 contested, 0 escalated, 0 declined. The review is closed after
stage 8 (one consolidated pass; the cap of one re-audit per stage is not used).
