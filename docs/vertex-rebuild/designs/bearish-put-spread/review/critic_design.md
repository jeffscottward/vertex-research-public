# Design Critic review: bearish put-spread design (Stage 7, FeatureRange)

- **Document:** `docs/vertex-rebuild/designs/bearish-put-spread/design.md`
- **Scope:** FeatureRange, lines 1-148 (Overview through Alternatives Considered). DetailedRange (149-189) is read only to check whether a FeatureRange gap is closed later.
- **Standard:** `resources/document_standards/feature-spec-standard.md` (problem, goals/non-goals, architecture, alternatives with concrete rejection reasons, risks and limits with mitigations).
- **Mode:** REVIEW, design-critic lens (assumptions, statistical validity, failure modes, security, operations). Claims were checked against the repository on 2026-11-22; code paths are cited.

## Summary

The pricing tool (G1), the breadth registry (G2) and the academy phase (G4) are sound in shape and mostly match the code. The weak point is the research method that G3/G5 pre-register. The decision rule D5 can pass on noise: the bootstrap block is shorter than one trade, and the signal count ignores overlap. The engine also trades a different structure than the consult: different expiries, a narrower width and an inert invalidation. The out-of-sample window also contains the period that inspired the rule. The standard's Risks & Limits requirement has no FeatureRange section, and several operational and security risks are not named.

| Severity | Count | Findings |
| --- | --- | --- |
| 🔴 Blocker | 2 | C1, C2 |
| 🟡 Major | 10 | C3-C12 |
| 🟢 Nit | 8 | C13-C20 |

---

## 🔴 Blockers

### C1. The pre-registered pass rule (D5) can pass on noise: the bootstrap block is shorter than a trade and "30 signals" ignores overlap

- **Lines:** 72 (D4), 73 (D5), 37, 120.
- **Finding:** D4 allows overlapping trades and resamples blocks of 20 sessions. A trade lasts from entry to 3 days before expiry, or to expiry. With `dte {target 52, min 45}` that is about 42-77 calendar days, or about 29-54 sessions (see C3 for the DTE range). Returns of trades entered within one holding period share most of their path, so they are strongly dependent over horizons longer than 20 sessions. A 20-session block cuts these dependencies. The bootstrap interval is then too narrow, and D5's "95% interval above 0" is too easy to meet. The SMA20 proxy entry (`high >= sma20[1]`, `close < sma20[1]`, `close >= 0.98 × sma20[1]`, line 117) also fires on runs of consecutive days. "At least 30 signals" can therefore mean a handful of independent episodes. The rule is fixed before the runs (G5), so an error here cannot be corrected afterwards without breaking the pre-registration. The error leans toward a false pass.
- **Recommendation:** Before any run, fix (a) the block length at no less than the longest holding period, for example 60 sessions, or use a stationary bootstrap with a mean block of at least that length, and (b) the resampling unit: sessions with the trades that start in them, for both the rule and the baseline on the same resampled calendar. Replace "≥ 30 signals" with a count of non-overlapping episodes (signals at least one holding period apart), or report both and gate on episodes. Name the rejected alternatives in Alternatives Considered: a non-overlapping subsample, and a mean difference with a Newey-West/HAC error whose lag is at least the holding period. State the reason for the choice.

### C2. No Risks & Mitigations in the FeatureRange; the standard's "Risks & Limits" requirement is unmet

- **Lines:** whole FeatureRange; partly covered only by Limitations (182-189, DetailedRange).
- **Finding:** The standard requires failure modes, security implications and scalability limits, each with a mitigation. "Facts that limit the test" (39-45) and the pathway (79-84) cover data gaps. Nothing covers: exposure of a new live-quote procedure (C8); load on Yahoo/IBKR/Quant Data from the new procedure; runs that queue across a web rollback (C19); revision of breadth data under stored runs (C16); the driver and a human user overwriting each other's queued academy runs (C14); and the size-skip bias in engine metrics (C7). Limitations (182-189) lists model caveats without mitigations and sits outside the reviewed range. (The structural review rated the missing section a Blocker as well; this finding adds the concrete risks that the section must hold.)
- **Recommendation:** Add a "Risks and mitigations" section after the Technical Plan. Give each risk one line with its mitigation, covering at least C3, C7, C8, C9, C14, C16 and C19. Move the method caveats there or cross-reference them.

---

## 🟡 Major

### C3. The runner's expiry choice puts about half of the entries outside the consult's 45-60 DTE window

- **Lines:** 37 (consult: "monthly expiry 45 to 60 days out"), 75 (D7: target 52, min 45), 120.
- **Finding:** `choose_expiry` (`services/research/strategies/qc_ports/book.py:251`, mirrored in `options-engine/book.ts:9`) picks the monthly expiry with DTE ≥ min that is nearest the target, with no maximum. Monthly expiries are 4-5 weeks apart, so the first eligible expiry has a DTE of about 45 to about 80, spread roughly evenly, and it nearly always wins. About half of all entries will be 60-80 DTE. The design calls these runs and the event study "the consult's rule", but the structure differs.
- **Recommendation:** State the realized DTE distribution as a limitation, and report DTE at entry in the job report. Where the code allows it, apply the 45-60 window in the event study: skip, or pick the 45-60 expiry, and say which. A `dte.max` field in the runner is a non-goal under line 60, so name it in Non-Goals explicitly.

### C4. The SMA200 "invalidation" as `crossesAbove` is inert for most entries, and the design does not explain why

- **Lines:** 37 ("closes back above its 200-day average"), 75, 119.
- **Finding:** "Back above" assumes that QQQ is below its 200-day average at entry, but no entry condition requires this. Brainstorm B1 found that a level exit closes about 91% of trades within one bar, so most signals occur above the SMA200. The design switched to `crossesAbove`. For an entry taken above the SMA200, a cross can happen only after a dip below, so the invalidation rarely fires. The tested rule is in effect "no invalidation". The decision record cites "brainstorm B1" without stating this consequence.
- **Recommendation:** Choose and record one interpretation: (a) add entry condition `close < sma(200)`, which reduces signals and changes the C1 power math, or (b) keep `crossesAbove` and state in D7 and Limitations that the invalidation applies only to entries below the SMA200. Report the share of trades that left by `signal`. Apply the same choice in the event study (C6).

### C5. The out-of-sample window overlaps the period that produced the hypothesis

- **Lines:** 26-28, 42, 70-71 (D2, D3).
- **Finding:** The consult built the rule from 2022-11 to 2026-11 breadth data and a spread priced on 2026-11-19. In window B, the out-of-sample segment is 2019-01-01 to 2026-11-20, so about half of it is the inspiring period. A positive OOS difference (a D5 condition) therefore partly re-measures the data that motivated the rule. Window A is correctly descriptive, but D5's OOS gate is not independent.
- **Recommendation:** Define the B out-of-sample segment as 2019-01-01 to 2022-11-09, or report 2019-01 to 2022-11 and 2022-11 to 2026-11 separately, with the gate on the uncontaminated segment. Record the reason in D3.

### C6. The event study (D4) is underspecified where the outcome is decided

- **Lines:** 72, 73, 76, 37, 83.
- **Finding:** D5 fixes a pass rule, but these inputs are left open:
  1. Entry timing. Signal-day close (as the rule says, using a full-day close and final breadth for a 15:45 decision) or the next close (as the engine does)? Pathway item 3 implies that same-session entry is "still missing", which contradicts "the exact owner rule per trade" (line 76).
  2. "In profit" for the owner exit. Against the debit with or without entry and exit costs? Judged on the mark at T-3 trading days, or on each day?
  3. Whether the SMA200 invalidation applies in the event study (C4).
  4. The role of the D6 sensitivities (IV ±4 vol points, skew ±0.1). Must D5 hold under them, or are they reported only? Without an answer, the analyst has free choices after the fact.
  5. "Return on risk" for trades with different DTEs (comprehension F8).
- **Recommendation:** Add a short "Event study protocol" sub-table under D4 that answers 1-5, and state that D5 is judged on the base model only, with the sensitivities descriptive (or the reverse).

### C7. Engine runs at $100,000 and 2% max loss skip trades in high-volatility regimes and size coarsely

- **Lines:** 75, 123; G3 (51).
- **Finding:** `contracts_for` sizes at floor(2% × equity / max loss per contract). The ledger skips a trade with 0 contracts (reason `"size"`, `qc_ports/ledger.py:112-116`). At QQQ near 645, the spread width is `0.6 × 0.9 × VXN/100 × √T × spot`. When VXN is high, the width and the debit grow past $2,000 per contract, so entries are skipped exactly in stress periods, when a bearish rule matters most. In calmer periods the size is 1 contract, so the equity metrics in G3 (drawdown, average result) are coarse. D4/D5 use per-trade return on risk and are not affected, but G3's stored runs are.
- **Recommendation:** Use an initial capital large enough that a 1-contract floor never binds, for example $1,000,000, or report the `size` skip count next to each run's metrics. Add this risk to C2.

### C8. "An agent gets…" (G1) requires a new read-key permission, which the design neither states nor justifies

- **Lines:** 49 (G1), 90, 106.
- **Finding:** The handler is gated by `requireOperator`. A read-access agent key may call only `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts:28-89`), and that set holds neither `optionsChain.chain` nor a spread procedure. As designed, read keys get FORBIDDEN, and the live acceptance at line 180 fails. (The comprehension and style reviews found the same.) The design-critic point is what is missing: the decision to expose a live-quote procedure to read keys is a security and quota choice. Every request may trigger three upstream reads (Quant Data, IBKR, Yahoo, `options-chain.ts:186-195`). The cache is per symbol and expiry, with at most 200 entries. An agent that sweeps symbols and expiries bypasses it and can trigger Yahoo throttling, which also degrades the operator's chain page.
- **Recommendation:** Add `optionsChain.spread` to the allowlist explicitly in the Technical Plan, and give the reason. Name the existing agent-key rate limit as the mitigation, or add a per-call bound (for example, no expiry discovery inside spread; the expiry is required, as the input schema already says). Record this in C2.

### C9. The model mixes a live spot with the previous day's IV index close; staleness is hidden, and G1's 5% tolerance cannot catch a wrong port

- **Lines:** 49, 106.
- **Finding:** The model takes the chain's live spot and "the latest stored close" of VXN and IRX. During a session these can be a day old. On a volatile day VXN moves 10-20%, which moves a 45-60 DTE spread's model value by several percent. `modelVsMidPct` will then look like mispricing. The output schema (line 155) does not carry the VXN level, its date or the rate, so an agent cannot tell. Separately, G1 accepts "model value within 5% of 12.76". The model is deterministic for fixed inputs, so a 5% band would pass real porting errors: dropping QQQ's q = 0.007, using IRX in percent instead of a fraction, or a t off by one day. Each moves a 45-wide put spread by well under 5%.
- **Recommendation:** Return `ivIndex {id, level, date}`, `rate {level, date}` and `t` in the model part, and flag a stale index. For G1, fix the consult inputs (spot, VXN, IRX, DTE as of 2026-11-19) as a fixture. Assert the model value to the cent against `bsPrice` and `smileIv` on those inputs, and keep the 5% band only as the "model vs consult hand value" check.

### C10. The backtest trades a narrower spread than the consult, and D7's "short leg near delta 0.25" check is circular

- **Lines:** 26, 37, 75 (D7), 77 (D9), 142.
- **Finding:** The consult spread is 640/595, 45 wide, with a real-chain short leg near delta -0.25. With `widthSigma` 0.6 the engine width is `0.6 × σ√T × spot`. For σ about 0.2-0.23 and T about 57/365 that is about 30-35 points, roughly 25-35% narrower. The phrase "checked with the pricing function" means checked with the same constant-skew model (skew -0.25), which is flatter than real QQQ put skew. The model's 0.25-delta strike is therefore closer to spot than the chain's. Cost as a share of width, return on risk and the condition-4 comparison all depend on width. The alternative rejection at line 142 relies on this placement.
- **Recommendation:** Price the consult's 640/595 spread on the model at the 2026-11-19 inputs. Report the model short-leg delta and the engine's chosen width for the same day. State the width difference as a limitation. If exact width parity matters, choose `widthSigma` so the engine width matches the consult (about 0.8-0.9), and record that trade-off in D7.

### C11. Breadth semantics: series fill-forward and the 15:45 decision against the final daily value are not addressed (brainstorm M2 open)

- **Lines:** 34, 50 (G2), 108-112.
- **Finding:** Both engines carry a series value forward for up to 5 bars (`STRATEGY_SERIES_MAX_FILL_DAYS = 5`, `strategy-dsl-compile.ts:1562`; `signals.py:169`). For a one-day breadth reading, a missing session would inherit the previous day's up-volume. The registry filters `final = true` but sets no fill policy. Today the window has no gaps (line 43), but live and future runs will hit days without a final row. The rule checks at 15:45, while the series is the final end-of-day value. That is a look-ahead that neither the FeatureRange nor Limitations names. Brainstorm M2 asked for both.
- **Recommendation:** Decide the fill policy for `NYSE_UPVOL_PCT`. Either 0 days, with a per-series setting mirrored in Python, or state that the 5-day carry is accepted because there are no gaps. Name the 15:45 versus final-value difference as a limitation of window A.

### C12. The decision-critical code and the pre-registration are not anchored where they can be audited

- **Lines:** 53 (G5), 65, 72, 81, 124.
- **Finding:** The event study decides pass or fail, but it is "a script in the job report folder … not product code" (line 124). It is not covered by CI and has no fixture test, and its database exports have no recorded identity. The KB answers and the 5 real-flip sessions are "in the job report", which has no location (comprehension F2). G5 says "written down before the runs", but nothing proves the order: the design is Proposed and the runs happen in the same job.
- **Recommendation:** Commit the decision record (`docs/specs/strategies/bearish-put-spread.md`) before the first `backtestRuns.submit`, and put its commit SHA in each run name or in the report. Give the job report a stable path in the repo or a link. Record the commit SHA of the event-study script and the SHA-256 of each export. Alternatively, add the script with one fixture test as a research module. Then name the "script versus module" choice in Alternatives Considered.

---

## 🟢 Nits

### C13. The proxy rationale rests on one observation, and that observation fails the rule's own condition 2

- **Lines:** 69 (D1), 144.
- **Finding:** "Observed flips sit near price (666 against a 645 close on 2026-11-19), as SMA20 does" uses one day. 645/666 means the close was 3.2% below the flip, which is outside the rule's "at most 2% below" (line 33). Five real-flip sessions exist (line 41).
- **Recommendation:** Tabulate SMA20[1] against the real flip, and whether each condition held, for all 5 sessions. Use that table instead of the single example.

### C14. The academy phase can be superseded or wait for nothing

- **Lines:** 52 (G4), 100, 128.
- **Finding:** `queueAcademyComparison` enqueues with `latest: true` (`server/academy.ts:258-265`): a newer academy request from the same user replaces older queued runs. If the key owner uses the Academy page around 06:15, the page and the driver overwrite each other. The function also returns no comparison when `academyEngineResult` gives null (equity ≤ 0) or when the queue is off. The driver then has no `groupId` to wait on.
- **Recommendation:** State that the driver logs "no comparison queued" and moves on when the answer carries no `groupId`, and that a superseded run is logged, as the instant phase does. Name the shared-user collision as a risk, or use a dedicated driver identity.

### C15. The rejection of a daily bearish submission is inconsistent with the daily academy runs

- **Lines:** 128, 147.
- **Finding:** Line 147 rejects a daily submission because it stores "a stored run every day for an unchanged definition". The academy phase does exactly that, with `end today` making a new comparison group each day. Daily runs are useful for parity drift detection, and the rationale "the 1e-6 gate already checks each submitted run" covers only one point in time.
- **Recommendation:** State the real reason (for example, storage growth or noise in `backtestRuns.list` compared with the comparison table), or accept a weekly re-check.

### C16. The breadth history can change under stored runs

- **Lines:** 110, 140.
- **Finding:** The `breadth90_days` upsert overwrites a final row with a later final row (`setWhere final = false or excluded.final = true`, `packages/db/src/server/breadth-90.ts:288`). Reading in place avoids copy drift, which is the reason for rejecting the alternative at line 140, but source revisions change past values silently. `seriesSha256` makes reruns detectable but not reproducible.
- **Recommendation:** Say so in the rationale at line 140, and record export SHA-256s for the event study (C12).

### C17. The virtual series is invisible to catalog paths but visible in the strategy builder

- **Lines:** 110-111.
- **Finding:** `listSeries` and `latestPoints` do not know `NYSE_UPVOL_PCT` (brainstorm M1). The web strategy builder lists every `STRATEGY_SERIES_REFS` entry (`apps/web/src/components/portal/strategy-builder-workspace.tsx:433`), so users can pick it for any symbol and range. A run that ends before 2022-11-10 then fails with a missing-series error.
- **Recommendation:** Document the availability (2022-11-10 onward, daily only) in the `STRATEGY_SERIES_IDS` comment, and make sure the refusal message names the start date.

### C18. The hold-to-expiry variant flatters the owner exit

- **Lines:** 37, 76 (D8).
- **Finding:** The engine settles expiry at intrinsic value without costs (`options-engine/book.ts:14`). The owner closes at 15:45 on expiry day and pays the half-spread and commission. The `BEAR_PUT_EXPIRY` results are therefore optimistic.
- **Recommendation:** Name this next to the D8 limitation. The event study can charge the exit cost on the expiry day.

### C19. Web rollback after runs are queued is not analyzed

- **Lines:** 130-136.
- **Finding:** "Roll-forward only" covers the worker. If the web is rolled back while runs that read `NYSE_UPVOL_PCT` are queued or stored, completion re-parses `spec.rule.definition` with the older schema (`server/backtest-run-engine.ts:236`), and those runs fail. Stored definitions may also fail to parse wherever a reader validates them.
- **Recommendation:** Add one line on what a web rollback does to queued and stored runs, and the procedure: drain or cancel the five runs before a rollback.

### C20. The forward test depends on another card with no fallback

- **Lines:** 81.
- **Finding:** The real-flip forward test starts only after card vertex-gamma-flip-sources lands. `flow_gex` keeps 14 days, so every day before then loses real-flip history for good (brainstorm M14).
- **Recommendation:** Name an interim step, for example a daily snapshot of the QQQ `flow_gex` flip at 15:45 into the job report or a table, or state that the loss is accepted until the card lands.
