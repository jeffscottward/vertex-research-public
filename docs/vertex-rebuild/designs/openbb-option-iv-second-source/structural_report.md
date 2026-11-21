# Structural Goldfish — REVIEW report

**Target:** `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md`, FeatureRange lines 1–235
**Standard:** feature-spec-standard.md · **Template baseline:** predecessor `openbb-blocked-upstream/plan.md`

## Compliance summary (passes)

- **Mandatory sections all present, correctly spelled:** Problem Statement (L13), Goals & Non-Goals (L41), Proposed Architecture (L143), Alternatives Considered (L200), Risks & Mitigations (L219).
- **Heading hierarchy clean:** one H1 (L1), ten H2s, no skipped levels, blank line before every heading; section order preserves the predecessor's relative sequence (Problem → Terms → Goals → Architecture → Acceptance → Alternatives → Risks) with three extra H2s inserted before Architecture.
- **Alternatives Rule satisfied:** five rejected options (L201–217) with concrete technical/scope trade-offs; no unlinked maintainer attribution.
- **Link integrity:** the only Markdown link, the image at L3 → `plan-overview.png`, resolves (file exists in the same folder). The predecessor plan path cited at L6 exists and its Non-goals (predecessor L79–80) do declare this feature, so the follow-up claim is structurally anchored. All full repo paths cited in the range exist (`options_math.py`, `options-chain-greeks.ts`, `contracts/openbb.ts`, `infra/option-chain/vertex-option-chain-run`, which really pins `yfinance==0.2.66`).
- **Tables well-formed:** both tables (L70–75, L84–93) have uniform 4-column pipe counts and `| --- |` separators matching predecessor style; expirations sum to 179 and contracts to 38,681 exactly. Code fence L145/L158 opens and closes with surrounding blank lines. Bullet marker `-` used uniformly; Goals and Alternatives both numbered 1–5.

## Findings

**1. 🟡 Major — L66–100 ("Source choice") vs L200–217 ("Alternatives Considered"): duplicated, divergent alternatives evaluation.**
The same rejections are documented twice in two H2 sections, and the two copies disagree. The Source-choice table evaluates 4 candidates; Alternatives lists 5 (the CSV-read option #4 and Black-76-mids option #5 appear only in the latter). The Quant Data rejection rationale also differs: the table (L72) says "spends paid quota, adds a control-plane dependency", while Alternatives #1 (L201–203) adds "its IV/delta come from term-structure prints, not a full chain snapshot". Two maintenance surfaces for one decision will drift further.
*Suggested change:* keep the measured comparison table under "Source choice" but strip its Verdict column to "Chosen / see Alternatives Considered #n", and make "Alternatives Considered" the single canonical rejection list covering all 5 options with one rationale each (or fold the table into Alternatives and leave only the chosen-client measurements under Source choice).

**2. 🟡 Major — L28–39 ("Terms"): term set asymmetric with the predecessor and with this document's own usage.**
The predecessor's Terms defines Rig, Tick client, Run ledger, Fetcher (predecessor L44–55). This plan uses "the rig" (L15, L67), "tick client" (L39, L222), "run ledger" (L132), and "the CFE pattern / CFE settlement file" (L46–47, L126, L160–161) but defines none of them; a fresh reader — the standard's core-principle audience — cannot resolve them from this document alone.
*Suggested change:* either add one-line entries for Rig, Tick client, Run ledger and CFE settlement fallback to Terms, or add an explicit sentence: "Rig, tick client, run ledger and the CFE fallback pattern are defined in the predecessor plan, `docs/vertex-rebuild/designs/openbb-blocked-upstream/plan.md` §Terms."

**3. 🟡 Major — L45–53 (Goals) vs L185–198 (Acceptance check): goal-to-acceptance mapping is incomplete.**
Goal 3 (L50: request count stated and bounded, no IBKR gateway load) has no acceptance bullet; the four bullets cover Goals 1, 2, 5 and the degradation case only. The mixed-run behavior that Architecture explicitly introduces (L162–163) is likewise absent from Acceptance check, although a test for it exists in the DetailedRange (L299–300). Goal 4 (L51–52) is a meta-goal about the plan text itself, satisfied by sections L102/L124 rather than a check.
*Suggested change:* add an acceptance bullet asserting the bound (≤179 upstream requests per snapshot, zero IBKR/Quant Data calls — e.g., the replay test requests no IBKR helper key) and one for the mixed run ("one symbol Cboe, one Yahoo: only the Yahoo symbol's warning carries the marker"); optionally number acceptance items and reference the goal each verifies.

**4. 🟡 Major — L124–141 ("How a source change is marked") vs Goal 2 (L48–49) and L195: the panel note text is promised but never specified.**
The section pins the fetcher marker and full warning string verbatim (L127–130) and promises the panel note "says this in one sentence" (L137–138) about percentile mixing, but the note's actual sentence appears nowhere in the FeatureRange, and L195 says the view-model test "pins the note text against the contract constant" without naming which constant holds the note (only `OPENBB_YAHOO_FALLBACK_NOTE`, the marker, is named at L128). The marking section is asymmetric: fetcher side exact, panel side unspecified.
*Suggested change:* quote the exact panel-note sentence (including the one-sentence percentile caveat) in this section and name the constant/module that owns it, mirroring the `YAHOO_FALLBACK_NOTE` / `OPENBB_YAHOO_FALLBACK_NOTE` pairing.

**5. 🟢 Nit — L33 vs L19, L64, L187: two names for the same tables.**
Terms defines the Snapshot via `option_iv_daily` / `option_iv_term` (the document-key names used in `jobs/cboe.py`), while L19/L64/L187 use `openbb_option_iv_daily` / `openbb_option_iv_term` (the stored-table names). Both exist in the repo, but the document never states they are the same thing.
*Suggested change:* in Terms, write "one `option_iv_daily` row (stored table `openbb_option_iv_daily`)…" or use the full stored names consistently.

**6. 🟢 Nit — L93: Total fetch time does not equal the column sum.**
5.4+3.2+1.9+2.5+2.4+1.8+1.5 = 18.7 s, but the **Total** row reads **20 s**. Expirations and contracts totals are exact sums, so the row implies summation.
*Suggested change:* label the cell "≈20 s wall" (or "18.7 s fetch / ~20 s wall") so the total's basis is explicit.

**7. 🟢 Nit — L97–99: "~4 snapshots a day" is not derived from the stated window.**
Hourly retry inside `mon-fri@16:20-21:00` admits five firing slots (16:20…20:20), i.e., up to ~895 requests/day, not ~716.
*Suggested change:* state the retry assumption that yields 4 (e.g., backoff skips a slot) or correct to "at most ~5 snapshots, ~895 requests/day".

**8. 🟢 Nit — L177–181: bare file names break the document's full-path convention.**
`requirements-openbb.in`, `requirements-openbb-linux-py312.lock` and `pyproject.toml` are cited without the `services/openbb/` prefix (they do not resolve from repo root), while every other file citation in the range (L20, L36, L128, L164) and the Files table (L242–244) uses full repo-relative paths.
*Suggested change:* prefix all three with `services/openbb/` at first mention.

**9. 🟢 Nit — L194: `_trim_chain` cited without its module.**
The pattern lives in `services/openbb/tests/record.py:100`, not in the job module the surrounding bullets discuss; a fresh reader will look in `jobs/cboe.py` and not find it (unlike `_settlement_fallback`/`_cboe_chain`, which are there).
*Suggested change:* write "the `_trim_chain` pattern in `services/openbb/tests/record.py`".

**10. 🟢 Nit — L118: `OPTIONS_CHAIN_RISK_FREE_RATE` attributed only to "`optionsChain`".**
The constant is exported from `packages/api/src/options-chain-merge.ts:62`, not from `options-chain-greeks.ts` cited in Terms (L36); the ACT/365 convention is in greeks.ts. The citation is findable but imprecise.
*Suggested change:* cite `packages/api/src/options-chain-merge.ts` for the constant.

**11. 🟢 Nit — L108: raw `|call IV − put IV|` pipes in prose.**
Unescaped pipe characters at the start of a continuation line are a table-parsing hazard in some Markdown renderers and inconsistent with the code-span convention used for formulas elsewhere.
*Suggested change:* wrap in a code span (`` `|call IV − put IV|` ``) or escape as `\|`.

**12. 🟢 Nit — L190: acceptance bullet mixes criterion with a completed-verification claim.**
"Verified live after the rig install." reads as a past-tense assertion inside a pre-implementation plan, while the sibling bullets are checkable conditions.
*Suggested change:* rephrase as an instruction ("Verify with a live rig run after install") or move the verification evidence to the measurements/Problem Statement section once performed.

## Verdict

No 🔴 Blockers: all mandatory headers, hierarchy, table syntax, and link targets pass. Four 🟡 Majors concern structural symmetry — duplicated/divergent alternatives sections (1), an incomplete Terms set relative to the declared template and the document's own vocabulary (2), Goals↔Acceptance coverage gaps (3), and an unspecified panel-note deliverable in the marking section (4) — plus eight 🟢 Nits on naming, numeric, path and formatting consistency.
