# Style Goldfish — REVIEW report (Feature range)

![EGM review overview: 9 goldfish reviewers, 15 consolidated actions; this style review's calibrations and wording nits batched into A14 shown here](review-overview.png)

**Target:** `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md`, lines 1–235 (FeatureRange). Persona applied verbatim; ASD-STE100-style audit (short sentences, active voice, one term per concept, no promotional adjectives). All claims below were checked against the baseline files (`jobs/cboe.py`, `options_math.py`, `context.py`, `options-chain-greeks.ts`, `options-chain-merge.ts`, `view-model.ts`, `vertex-option-chain-run`, `docs/vertex-rebuild/openbb.md`, predecessor plan). No 🔴 Blockers: the document is largely dry, evidence-anchored, and well structured. Findings: 7 🟡 Major, 12 🟢 Nit.

---

## 🟡 Major

**M1 — Line 25: uncalibrated duration claim.**
"The blocked state can last weeks" is a prediction; the cited evidence ("started before 2026-11-19 and is still active", checked 2026-11-21) supports ~2 days, not weeks. Action: **CALIBRATE**.
Rewrite: "The block's duration is unknown (active since at least 2026-11-19). The IV percentile needs a continuous daily history; every blocked day is a hole in it."

**M2 — Lines 97–99: retry regime misstated; bound does not follow.**
"hourly retry while blocked" contradicts `docs/vertex-rebuild/openbb.md:311-312`: the blocked backoff is 1 h after the first blocked run and 6 h from the second. Also, while the Yahoo fallback succeeds the run is `partial`, not blocked, so the hourly stage runs uninterrupted — up to 5 slots in the 16:20–21:00 window, not "~4". The "~716 requests/day" bound rests on both errors. Action: **CALIBRATE**.
Rewrite: "At the job's window (`mon-fri@16:20-21:00`, hourly stage) a working fallback runs up to 5 times a day: ≤ 895 requests/day. When all sources fail, the run is `blocked_upstream` and the tick backoff (1 h, then 6 h) reduces the count."

**M3 — Line 99: unmeasured comparison.**
"far below what the twice-daily research snapshot plus portal reads already send" — no request count for the research snapshot or portal reads is given anywhere in the document; "far below" is unprovable as written. Action: **CALIBRATE** (state the comparison numbers) or **DROP** the clause.
Rewrite (drop variant): "…this is at most N requests/day." Keep only bounds the document itself derives.

**M4 — Lines 114–115: speculative claim about an unmeasurable comparison.**
"Against the Cboe exchange series the difference is of the same order" asserts a magnitude the next clause admits cannot be measured. The constraint is real (KEEP it); the magnitude guess is not evidence-backed. Action: **CALIBRATE**.
Rewrite: "The difference against the Cboe exchange series is unknown while Cboe is blocked; model and quote time differ."

**M5 — Lines 116–118: "the exact conventions of `optionsChain`" overstates the match.**
The formulas and rate match (`options-chain-greeks.ts:77-88`, `OPTIONS_CHAIN_RISK_FREE_RATE = 0.04` in `options-chain-merge.ts:62`), but `T` does not: the plan uses integer `dte/365` from the session date; `optionsChain` uses fractional years from `now` to the expiry close (`yearsToExpiry`, `options-chain-greeks.ts:140-142`; `daysToExpiry` is a separate helper). "Exact" outruns the evidence. Action: **CALIBRATE**.
Rewrite: "…rate fixed 0.04 — the same formulas and rate as `optionsChain` (`OPTIONS_CHAIN_RISK_FREE_RATE = 0.04`). T differs: this job uses integer dte/365 from the session date; `optionsChain` uses fractional years from now to the expiry close (ACT/365)."

**M6 — Lines 137–139: subjective size judgment without a metric.**
"The ~0.5-point level difference is small against the day-to-day IV range" — no day-to-day range is measured or cited; "is worse for the percentile" is likewise unquantified. Action: **CALIBRATE**.
Rewrite: "The measured level difference is 0.55–0.57 vol points (see above). A percentile across the boundary mixes two methods; the panel note states this. The alternative removes one sample per blocked day from the percentile history." (Or cite a measured daily IV range to keep "small".)

**M7 — Line 190: acceptance criterion reads as a completed verification.**
"Verified live after the rig install." — past tense in a plan whose implementation has not happened; a fresh reader cannot tell whether this evidence exists. No post-install verification is shown in the document. Action: **CALIBRATE** to an instruction.
Rewrite: "Verify live after the rig install." Also (precision): the bullet checks only `openbb_option_iv_daily`; goal 1 (line 45–46) promises "the same two tables" — add `openbb_option_iv_term` to the acceptance bullet.

---

## 🟢 Nit

**N1 — Line 3: 65-word single-sentence alt text.**
STE: short sentences. Rewrite as three: "Before: Cboe answers HTTP 403; the Core 7 IV panel shows a blocked notice and old rows. After: the job reads every listed expiration from Yahoo through the pinned yfinance client and computes delta and gamma with Black-Scholes. It writes the same two tables and names the source in the run warning and on the panel."

**N2 — Lines 5–6: ambiguous antecedent "its plan".**
"its" could attach to either card. Rewrite: "(feature, follow-up of `vertex-openbb-cboe-403`; the predecessor plan listed this as a non-goal: `docs/vertex-rebuild/designs/openbb-blocked-upstream/plan.md`)." Verified against predecessor lines 79–82.

**N3 — Lines 19, 33, 64, 154, 187: two naming layers for the same tables, unexplained.**
`openbb_option_iv_daily`/`openbb_option_iv_term` (DB names, `packages/db/src/schema/openbb.ts:168,211`) vs `option_iv_daily`/`option_iv_term` (fetcher names, `jobs/cboe.py:189,205`). Both are correct, but a fresh reader sees four tables. Add one Terms line: "Table names: the fetcher writes `option_iv_daily` / `option_iv_term`; the database tables are `openbb_option_iv_daily` / `openbb_option_iv_term`." Then use each name only in its own layer.

**N4 — Lines 34–35: universal claim where measurement shows a tendency.**
"the call and the put at one strike carry different values" — the evidence (line 107–108) is a median disagreement, not a per-contract guarantee. Rewrite: "the call and the put at one strike can carry different values."

**N5 — Lines 60 vs 78: inconsistent frequency term; filler "standard".**
"twice a day" (60) vs "twice every trading day" (78); the timer is Mon–Fri 12:30/15:30 and skips closed markets (`vertex-option-chain.timer:9-10`). Use "twice per trading day" in both places. Delete "standard" in "the standard pinned `yfinance` library" — promotional filler; "the pinned `yfinance` library" carries the full meaning.

**N6 — Lines 107, 111: "expiry" vs "expiration".**
One term per concept (STE). The prose standard elsewhere is "expiration"; rewrite "the 2027-01-15 expiry" → "the 2027-01-15 expiration" (both lines). Code-block `expiries` (151–152) may stay as API shorthand.

**N7 — Lines 109–110: vague effect claim "so it absorbs part of this".**
Averaging two sides does not reduce a model difference; the sentence's factual content is already complete without the clause. **DROP** "so it absorbs part of this": "The existing ATM rule (mean of call and put IV at the nearest strike with both) averages the two sides; the 25-delta interpolation uses each side separately, as with Cboe."

**N8 — Line 93: unmarked rounding in a measured table.**
Fetch-time column sums to 18.7 s; Total says "20 s" with no approximation marker while every other cell is exact. Rewrite Total as "**≈20 s** (sum 18.7 s)" or "**18.7 s**". (Contract and expiration totals verified exact: 38,681 and 179.)

**N9 — Lines 113, 137, 216: three names for one unit.**
"vol points", "~0.5-point", "~0.5 vol points". Define once at first use (line 113): "vol points (1 vol point = 0.01 IV)", then use "0.5–0.6 vol points" consistently at 137 and 216 (measured: 0.55 and 0.57).

**N10 — Lines 160–161, 169, 171–172, 176, 179: informal/compressed wording in Architecture.**

- 160–161: "runs on every non-empty failure" → "runs on every failure except `empty`" (matches `jobs/cboe.py:100-103`).
- 169: "JSON-able" → "JSON-serializable".
- 171–172: "keeps the fixture keys stable and the replay simple" — "simple" is subjective → "keeps one fixture key per symbol, independent of the expiration list".
- 176: "a broken venv" → "a missing or incompatible `yfinance` import".
- 179: "Its heavy deps" → "Its largest dependencies" (STE: no abbreviations, no subjective size words).

**N11 — Lines 173–174: unbounded retry hedge.**
"even with retries per symbol it stays far inside the budget" — no retry count or policy is defined anywhere in the range, so the claim is unverifiable. Action: **CALIBRATE**. Rewrite: "Measured full fallback ≈ 20 s of fetching against the 240 s deadline. If per-symbol retries are added, cap them at <n> so the worst case stays under the deadline." (Name the cap, or drop the clause.)

**N12 — Lines 207–208, 214–216, 221, 223, 227: informal verbs and subjective phrasing in Alternatives/Risks.**

- 207: "which we do not want to maintain in the fetcher" — first-person preference → "which adds browser-impersonation maintenance to the fetcher".
- 208: "proven on this rig" — promotional; evidence exists, so state it: "its 2026-11-20 runs completed for all 7 symbols" (already at line 78; here just "already pinned and hash-locked").
- 214: "more faithful to tradeable prices" → "computes IV from tradeable bid/ask mids instead of a vendor model column"; "the full parity machinery" → "the parity-forward calculation".
- 215: "which would gut GEX and the walls" → "which would remove most far-strike contracts from GEX and the wall calculation".
- 216: "The Yahoo IV column covers every contract" overstates: the document itself drops IV ≤ 0 (line 229) and lists stale far-strike values (227). **CALIBRATE**: "The Yahoo IV column is present for every contract; zero or missing values are dropped as today."
- 221: "it already 429s the plain client" → "it already returns HTTP 429 to the plain client".
- 223: "no retry storm" → "the tick client's blocked backoff (1 h, then 6 h) limits retries".
- 227: "Yahoo IV column quirks" → "Known Yahoo IV column issues".

---

## Redundancy note (editorial action: DROP)

The "this is not a way around the Cboe block" disclaimer appears five times: lines 10–11, 59–61, 75, 80, 206–207. The scope statement (9–11) and the non-goal (59–61) are the right homes; the alternatives entry (205–207) needs it for the raw-client rejection. **DROP** line 80's second sentence ("This is the same access pattern the research snapshot uses; it is not aimed at Cboe.") — lines 77–79 already establish the shared client and host, and 59–61 already make the distinction.

## Claims verified and kept (no finding)

Baseline commit framing (7–8); 403/`blocked_upstream` behavior and panel title (17–21, matches `conftest.py:98`, `openbb-panels.tsx:340`); 179-request arithmetic (95–97); `yfinance==0.2.66` pin and `--exclude-newer 2026-11-08` lock header (77, 178–179, matches runner line 13 and lock line 2 — note the runner itself uses `--exclude-newer 2026-11-11`, which the plan does not claim otherwise); 56-day tenor (113, = 2026-11-20→2027-01-15); gamma unit compatibility (119–120, `options_math.py:3-4`); `partial`-never-`ok` status rule (132–133, `openbb.md:303-305`); IV bound [0, 10] (228, `contracts/openbb.ts:222`); per-source failure isolation via `ctx.take` (233–234, `context.py:79-105`); 240 s deadline / 420 s step timeout (173–175, `openbb.md:52,113`); `_trim_chain` and `_settlement_fallback` references (193–194, 160–161). These are evidence-backed; per persona, KEEP is not reported as a finding.
