# Stage 6: Comprehension Test

Target: design.md (draft), FeatureRange 1-167 and DetailedRange 168-251. Reviewer: egm-comprehension (completed).

What this proposes

The design adds a research-only "Hedging pressure" panel to the `/flow` page for SPY and ES. For ES, it uses SPX options. For each stored option trade (a "print"), it estimates how many dollars of the underlying a dealer must buy or sell to stay delta-neutral. The direction comes from the vendor's aggressor side (ask = customer bought, bid = customer sold; mid and unknown are ignored). The delta is a Black-Scholes delta computed from the print's own stored IV, with IV clamped to 1%–500%. The panel plots per-minute running sums for net, calls and puts for one New York calendar day, with the underlying price plotted under them. It also shows totals, counts of excluded prints, and a paragraph stating the assumptions.

The work is a new read-only tRPC/HTTP procedure, `flow.hedgingPressure`, plus a view-model, a panel component, lab fixtures and documentation. It needs no new tables, no new vendor calls and no migration. The read is capped at 200,000 prints, with a `truncated` flag when the cap is hit.

How the existing system works, per this document

A collector stores QuantData "consolidated order flow" option prints for SPY and SPX in `flow_option_prints` and keeps them for 14 days. Only prints of $10,000 premium or more are stored. Each row has the side, IV in percent, dte, `underlying_price` and strike. Greeks are dropped. The `/flow` page already has a Tape speed panel served by `flow.tapeSpeed`. That panel uses a read-rows/assemble handler pattern, an operator or agent read key, a freshness concept for "sources" (fresh/stale/closed/never) and a lab page at `/lab/flow` with fixtures. QQQ and NQ are flow instruments with no stored option prints. A `bsDelta` function already exists in the options engine.

The paraphrase above was writable for every section. The findings below are gaps and contradictions within it.

---

## Findings

C1 — 🟡 Major — lines 13, 34–35, 137 (ES vs SPX identity)

- **Discrepancy:** The document calls SPX options "the options of the ES index group". It shows them under symbol `ES`, but its price chart plots SPX (line 120) and the contract carries `ticker` = `SPX`. "Index group" is never defined. The document never says whether the hedge notional for ES is in SPX index dollars or in ES futures dollars. It also never says why the symbol is ES rather than SPX.
- **Rationale:** A new reader cannot tell what instrument the ES line is measured in. They also cannot tell whether `underlying_price` on SPX rows is the index or the future.
- **Fix:** Add a Terms entry, "Symbol vs ticker". It should say that Vertex groups ES/SPX under symbol `ES` (with a link or one sentence on `FLOW_INSTRUMENTS`), that SPX option prints carry the SPX index as `underlying_price`, and that the ES line is therefore SPX-index notional, as an estimate of ES futures hedging.

C2 — 🟡 Major — line 156 vs lines 121–122 and 143 (largest minute)

- **Discrepancy:** The Risks mitigation says "the aria label and the totals name the largest minute". The Totals line (lines 121–122) and the `totals` contract field (line 145) contain no largest-minute value. Only the aria label (lines 125–126, step 4) names the largest rise and fall.
- **Rationale:** The stated mitigation is not backed by the UX or the contract. A sighted user would never see the largest minute.
- **Fix:** Either add the largest one-minute rise and fall (value and time) to the totals line and the `totals` schema, or change the mitigation to say "the aria label names…".

C3 — 🟡 Major — lines 133, 165, 205–211, 233 (access-control vocabulary)

- **Discrepancy:** One access rule is described with five different names: "operator or agent read key" (line 133), "agent viewer account" (line 165), "the agent read list" (step 3), "viewer key allowed" (line 211), and `requireOperator` (line 206). None is defined. A handler named `requireOperator` that also admits a viewer key looks contradictory. The "access screen" (line 233) is never shown in User experience.
- **Rationale:** The reader cannot tell who may call the procedure, or whether "viewer key", "agent read key" and "agent viewer account" are the same thing.
- **Fix:** Add one Terms entry defining "operator" and "agent read (viewer) key", and use one name throughout. Say in one sentence that `requireOperator` also accepts keys on the agent read list. Add the forbidden state to the States bullet on line 110.

C4 — 🟡 Major — lines 204–205 vs 194–196 (finding the newest print)

- **Discrepancy:** `readFlowHedgingPressureRows` begins with "newest print → session". The only new repository method, `readHedgingPrints`, needs `from`/`to` bounds. No step says which query or existing method finds the newest print's `traded_at` for a symbol.
- **Rationale:** Rule 1's default session cannot be implemented from the plan as written.
- **Fix:** Name the existing repository method that returns the newest print, or add a `readNewestPrintTime(symbol)` method with a test in step 3.

C5 — 🟡 Major — lines 201–203 vs step 1 (pipeline wiring)

- **Discrepancy:** `buildFlowHedgingPressure(rows)` takes only rows. Yet it must produce `symbol`, `ticker`, `session`, the options freshness (which needs `latestSamples` output) and `truncated`. The plan never says where step 1's `hedgingPressure(prints)` is called.
- **Rationale:** A reader cannot connect the pure rules (step 1) to the assembled document (step 3).
- **Fix:** Give the full signature, for example `buildFlowHedgingPressure({ symbol, session, rows, samples, now })`. State that it cuts to `readCap`, calls `hedgingPressure()` and calls `buildSourceFreshness()`.

C6 — 🟡 Major — line 191 (unknown regeneration command)

- **Discrepancy:** The step says "`bun run openapi:generate` or the script the repo uses". The author does not know the command.
- **Rationale:** This is an assumed workflow prerequisite. The implementer must go and find it.
- **Fix:** State the exact script name from `package.json`.

C7 — 🟡 Major — lines 76–79 (time and IV units in rule 3)

- **Discrepancy:** "time = `max(dte, 1 minute) ÷ 365` days" mixes units. dte is in days and 1 minute is 1/1440 day, but the result is in years, not days. The phrase "`iv` was outside that range" compares a percent field to a 0.01–5.00 range. The reader must work out whether the boundary is applied to `iv` or to `iv ÷ 100`, and whether the edges are inclusive.
- **Rationale:** An implementer could produce off-by-unit times, or count prints at exactly 1% or 500% as IV limited.
- **Fix:** Write it as `T_years = max(dte_days, 1/1440) / 365` and `σ = clamp(iv/100, 0.01, 5.00)`. Define IV limited as `iv/100 < 0.01 or iv/100 > 5.00`.

C8 — 🟡 Major — line 83 (ambiguous "price")

- **Discrepancy:** "a strike or price of 0 or less" does not say whether "price" means the option fill price or `underlying_price`. The rule also does not say how `iv = 0` is handled. As written, 0 is outside the range, so it would be "IV limited", not "not priced".
- **Rationale:** The "not priced" and "IV limited" counts on screen depend on this.
- **Fix:** Name the field, for example "`underlying_price` ≤ 0". State explicitly whether `iv ≤ 0` is "not priced" or "IV limited".

C9 — 🟡 Major — lines 113, 115, 142 (freshness and "source" are undefined)

- **Discrepancy:** The document uses several terms without defining them: the "options source", the freshness values "fresh, stale, closed or never", "the stored samples", "the `flow.snapshot` row shape", `buildSourceFreshness` and `latestSamples`. Nothing says what makes a source stale or closed.
- **Rationale:** The header line shows this status to users, and a reader cannot explain or test what it means.
- **Fix:** Add a Terms entry, "Source freshness", with one sentence per state, or link the existing flow-pipeline doc section that defines it.

C10 — 🟢 Nit — lines 27–29 (sign used before it is defined)

- **Discrepancy:** The "Hedge notional" term uses `sign` before it is defined. Sign is first defined in rule 2.
- **Rationale:** It forces a forward read.
- **Fix:** Add "(sign: +1 customer bought, −1 customer sold; see rule 2)".

C11 — 🟢 Nit — lines 91, 112–113 ("document")

- **Discrepancy:** "the document says `truncated: true`" and "the last document stays below it" use "document" to mean the API response, the same word as this design doc.
- **Fix:** Define "document = one `flow-hedging-pressure.v1` response", or say "response".

C12 — 🟢 Nit — line 112 ("retry time")

- **Discrepancy:** "with the retry time" is not defined. It is presumably the next 60 s refresh.
- **Fix:** Say "with the time of the next automatic refresh".

C13 — 🟢 Nit — lines 113 and 148–149 (empty and out-of-retention cases)

- **Discrepancy:** The contract says an out-of-retention date returns `session` = that date with no points. The UX defines only one empty state, "No option prints stored… last 14 days", which matches `session` = null. The UI never sends `date`, so it is unclear whether the other case can ever appear in the panel.
- **Fix:** State that the panel never sends `date`. Alternatively, add the message shown for a dated session with no points.

C14 — 🟢 Nit — lines 4, 43, 47, 50, 54, 104, 128, 148, 163 (unlinked project names)

- **Discrepancy:** Several project names have no definition or link: "research card" and "chart O28", `design-system/darkfactory/MASTER.md`, "engine, rule or confluence vote", "the collector", "QuantVPS", the "Tape speed panel", `/lab/flow` ("Lab"), `FLOW_API_ERRORS` and `FLOW_INSTRUMENTS`.
- **Fix:** Add a short "Context" list giving a one-line definition or a repo path link for each.

C15 — 🟢 Nit — lines 180 and 183 (`right` field)

- **Discrepancy:** The `right` field and "sign × right cases" are used, but `right` (call or put) is never defined.
- **Fix:** Add "`right`: call or put" to Terms.

C16 — 🟢 Nit — lines 198 and 200 (conditional and unnamed references)

- **Discrepancy:** "(and the integration database test if the repository methods are listed there)" and "the existing New York time helper" leave the implementer to search.
- **Fix:** Name the integration test file and the helper function.

There are no 🔴 Blocker findings: every section could be paraphrased.
