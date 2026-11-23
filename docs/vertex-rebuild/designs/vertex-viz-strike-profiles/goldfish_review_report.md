# Goldfish review resolutions: strike bar profiles design

Resolution gate: "Auto accept" (standing owner rule of 2026-11-13): every PROPOSE FIX is applied
to `design.md`; CONTEST and DECLINE stay as recorded here. No finding needs a fact only the owner
has, so there is no ESCALATE.

Counts: 26 PROPOSE FIX, 2 CONTEST, 1 DECLINE (action items of
[consolidated_review_report.md](consolidated_review_report.md)).

| # | Verdict | Resolution in `design.md` |
| --- | --- | --- |
| A1 | PROPOSE FIX | Goal 2, Read path, Stored prints query: flow profiles for SPY, SPX, QQQ and NDX come from `flow_option_prints` over the whole window (the card names this source); other symbols show the real time span of the page prints and "First provider page only." Risk 1 rewritten; CUJ 2 rewritten. |
| A2 | CONTEST (partly) | The `heat-map` request is now Alternative V1 with its cost; it is deferred because its response is not checked against a live answer here and it costs shared quota. The card's "QuantData OI/volume and stored flow_option_prints" is met by OI plus print contracts; the label is "Flow volume" and the caption says it is not exchange volume. Recorded as a job decision under Open Questions (not an owner gate: no new paid cost). |
| A3 | PROPOSE FIX | Counted prints exclude negative premiums (`isCountedPrint`), so the premium fields stay "finite >= 0". |
| A4 | PROPOSE FIX | Phase A step 2 names `selectDisplayStrikes(rows, spot, size)` and keeps `displayStrikes(rows, spot)`. |
| A5 | PROPOSE FIX | `trades` = number of counted prints, neutral included (Ladder step 3). |
| A6 | PROPOSE FIX | One ladder: the GEX display strikes plus the max-pain strike; flow values join onto it; prints elsewhere are counted in `offLadderTrades` and shown in the caption. |
| A7 | PROPOSE FIX | The max-pain strike is always on the ladder; the marker is `strike === exposure.maxPain`. |
| A8 | PROPOSE FIX | Max pain bars show the payout above the smallest payout on the ladder; the text shows the payout. |
| A9 | PROPOSE FIX | New top-level `strikeProfiles`; `ExposureStrikeSchema` and `gex-context.ts` do not change. |
| A10 | PROPOSE FIX | The contract has `bullishPremium` and `bearishPremium` only; the web computes the net; the caption says "bullish minus bearish". |
| A11 | PROPOSE FIX | The GEX table renders from the highest strike, like the new ladder; Figure 1 BEFORE shows the real table. |
| A12 | PROPOSE FIX | Alternatives P3 (extend the GEX table), R1 (SVG) and R2 (strike on the x-axis) added with reasons; prefixes defined; chosen design stated. |
| A13 | PROPOSE FIX | Strike-rule captions per case (spot or not; OI or premium). |
| A14 | PROPOSE FIX | Status rules in User experience: which section gates each profile, the zero case, the coverage lines. |
| A15 | PROPOSE FIX | Phase B step 1 gives the metric type, row fields, `spotAfter` rule (equal strike below the line), "Spot 512.34" format, scale rules and the formatters from `features/flow/format.ts`. |
| A16 | PROPOSE FIX | API, database and fixture changes go in one commit. |
| A17 | PROPOSE FIX | File table with Action column, exact test paths, the doc and the integration test. |
| A18 | PROPOSE FIX | Phase A step 9 and Phase B step 5 list inputs and expected results. |
| A19 | PROPOSE FIX | The fixture computes payout with the Terms formula and sets `maxPain` to the smallest payout; `fixtures.test.ts` checks it. |
| A20 | PROPOSE FIX | Both figures redrawn: real labels, spot line between 515 and 510, OI to the ladder, stored prints, colours as in the text. |
| A21 | PROPOSE FIX | Terms add Vertex, QuantData, GEX section, display strikes, counted print, stored prints, `/lab`, QuantVPS. |
| A22 | PROPOSE FIX | Risks 5-8 added (gaps, phone width with a risk sentence, access, response size and cost). |
| A23 | PROPOSE FIX | The card text is quoted in the header; Open Questions states the job decisions. |
| A24 | PROPOSE FIX | Goal 5 gives pass criteria; Risk 6 no longer says "tested". |
| A25 | PROPOSE FIX | Non-Goal 1 says the expiry filter exists and why it is deferred. |
| A26 | PROPOSE FIX | Acceptance gives the coverage flags, the integration command, all four widths and the live check. |
| A27 | PROPOSE FIX | One predicate `isCountedPrint`, used by the chain and the profiles. |
| A28 | PROPOSE FIX | Native radio group with legend "Profile"; arrow keys change the profile. |
| A29 | PROPOSE FIX / DECLINE | Wording, units, rollback, metadata and the model folder (`components/portal/strike-profiles-model.ts`) fixed. DECLINE: ZoomOutS5 10 (no literal types in the plan): the readiness reviewers asked for exact signatures, so the plan keeps them. CONTEST: CatalystS5 5 (side-by-side profiles): kept as Future Improvement 3 to keep the first build small. |

## Stage 8 (intermediate zoom out) resolutions

Report: [intermediate_zoom_out_report.md](intermediate_zoom_out_report.md). Auto accept applies.

| # | Verdict | Resolution |
| --- | --- | --- |
| S8-1 🔴 | PROPOSE FIX | Stored prints only where `FLOW_INSTRUMENTS` sources include `"options"` (`storedPrintsSymbol`: SPY, SPX); text and Figure 2 say "SPY and SPX"; a QQQ test makes no query. |
| S8-2 🟡 | PROPOSE FIX | `complete` is false when the collector's options source is stale or never ran (`buildSourceFreshness`), as well as with a gap; caption says so. |
| S8-3 🟡 | PROPOSE FIX | `unreadOf` from `flow-hedging-pressure.ts` is exported and reused; hedging pressure named as the precedent. |
| S8-4 🟡 | PROPOSE FIX | No ladder from flow prints when OI is missing; `selectDisplayStrikes` and the "by premium" caption dropped; `displayStrikes` unchanged. |
| S8-5 🟢 | PROPOSE FIX | One helper `center-marked-row.ts` for both strike tables. |
| S8-6 🟢 | PROPOSE FIX | `### Changed` line in the CHANGELOG for the GEX table order. |
| S8-7 🟢 | DECLINE | The fixture is generated per symbol from seeded random OI, so literal payouts do not fit; it computes the payout inline and a fixture test checks that max pain is the smallest payout. |
| S8-8 🟢 | PROPOSE FIX | The query filters on `symbol` only; the plan states behaviour and tests. The `spotAfter` encoding stays in the plan because the readiness reviewers asked for it. |
| S8-9 🟢 | PROPOSE FIX | `packages/api/src/server/mcp.ts` path written in full. |
