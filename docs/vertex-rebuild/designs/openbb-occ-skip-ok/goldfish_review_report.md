# EGM Goldfish Review Resolution Report — `openbb-occ-skip-ok`

- **Target Document:** `docs/vertex-rebuild/designs/openbb-occ-skip-ok/plan.md`
- **Resolution Mode:** Auto accept (standing owner rule 2026-11-13)
- **Summary Counts:** 8 `PROPOSE FIX` (applied to `plan.md`), 2 `CONTEST` (recorded below with scope/limit documentation applied to `plan.md`), 0 `DECLINE`, 0 `ESCALATE`.

## Resolutions

### F1 (Blocker) — `PROPOSE FIX` (Applied)

Added a dedicated `## Alternatives Considered` section comparing: (1) Python `ctx.info` to `stderr` only, (2) a structured `notes`/`info` channel in `openbb-batch.v1` plus DB migration, (3) placing the classifier constant in `packages/api/src/contracts/openbb.ts`, and (4) the chosen `scripts/openbb/tick.ts` single-job filter.

### F2 (Blocker) — `PROPOSE FIX` (Applied)

Removed the non-existent the gamma-flip-sources design doc (unmerged branch) path from `plan.md`, stated the behavioral decision and rationale directly in the spec, defined project-local terms briefly (`coverage-baseline.json`, `openbb-batch.v1`, file claims), and replaced vague workflow jargon in the Verification Plan with concrete commands.

### F3 (Major) — `PROPOSE FIX` (Applied)

Corrected downstream consumer descriptions to name `openbb_ingest_runs`, `openbb.status` API, and MCP `openbb_status` (`packages/api/src/server/mcp.ts`) rather than portal panels. Corrected the Cboe vs. Yahoo skip comparison to note that `options_math.parse_contracts` also increments `skipped` on invalid OCC calendar dates, while Yahoo additionally skips missing/non-positive strikes and is already a `partial` fallback path.

### F4 (Major) — `PROPOSE FIX` (Applied)

Promoted `### Risks and Mitigations` to peer H2 `## Risks and Limits`. Documented MCP `openbb_status` raw-warning visibility, `--dry-run`/`stderr` warning-count behavior, the follow-up obligation to update `docs/vertex-rebuild/openbb.md` once `openbb-iv-history-caveat` releases it, and an explicit single-job architectural ceiling (a second job needing informational notes triggers a structured `notes`/`info` field in `openbb-batch.v1`).

### F5 (Major) — `PROPOSE FIX` (Applied)

Clarified `recordBlocked` (`blocked_upstream`) vs. `recordOutcome` (`document === null` -> `failed`, else `statusOf`), explained why `document` is guaranteed non-null when `statusOf` runs yet optional-chained in the `recordRun` payload, added explicit exit codes to CUJ 2 and CUJ 3 (`0` for warning-only `partial`), clarified that `"cboe-option-iv: every table is empty"` is a `document.warnings` entry, and stated the exact string `"used the Yahoo option chain"` for `OPENBB_YAHOO_FALLBACK_NOTE` / `YAHOO_FALLBACK_NOTE` and how the Yahoo session guard reads the newest run's warnings.

### F6 (Major) — `PROPOSE FIX` (Applied)

Lifted `Overview` and `Technical Plan (Architecture)` to component, contract, and data-flow altitude; moved exact regex literals, helper signatures, and call-site code exclusively into `Detailed Implementation Plan`.

### F7 (Major) — `PROPOSE FIX` (Applied)

Updated the implementation design to:

1. Reuse `TICKER_SYMBOL_PATTERN` exported by `packages/api/src/contracts/openbb.ts` rather than duplicating `[A-Z0-9.^=-]{1,16}`.
2. Keep `statusOf(outcome, warnings)` job-agnostic and compute the partial warning count at the `recordOutcome` call site via a private `partialWarningCount(job, warnings)` helper.
3. Keep the OCC skip regex private inside `scripts/openbb/tick.ts` and test every behavior and edge case through `runOpenbbTick`.
4. Drop brittle raw Python `.py` file scraping from `scripts/openbb/tick.test.ts` and use explicit format-pinning behavior tests consistent with the rest of the repository.

### F8 (Major) — `CONTEST` (Documented in `plan.md`)

**Rationale:** `services/openbb/vertex_openbb/jobs/cboe.py`, `services/openbb/tests/test_jobs.py`, `packages/api/src/contracts/openbb.ts`, `packages/db/src/schema/openbb.ts`, and `docs/vertex-rebuild/openbb.md` are actively claimed by `openbb-iv-history-caveat`. Classifying the exact Cboe OCC skip line in `scripts/openbb/tick.ts` fulfills the goal now, keeps the skip count in `openbb_ingest_runs` and `openbb.status` without a schema migration, and avoids merge collisions. The structural safeguard requested by reviewers — a strict single-job ceiling in `## Risks and Limits` — is adopted.

### F9 (Major) — `CONTEST` (Accepted limit documented in `plan.md`)

**Rationale:** Adding a skipped-to-total ratio threshold in `tick.ts` by cross-referencing `option_iv_daily.contracts` introduces uncalibrated magic constants (ceiling ratio and small-chain floor) that can create new false `partial` runs on illiquid or heavily adjusted underlyings while coupling `tick.ts` to table-row internals. Total breakage (`0` surviving contracts) already triggers `"cboe chain <SYM>: no unexpired contracts"` -> `partial`, and the skip count remains persisted in `openbb_ingest_runs.warnings` for inspection. This accepted blind spot and monitoring path are documented explicitly in `## Risks and Limits`.

### F10 (Nits) — `PROPOSE FIX` (Applied)

Applied all style, structure, and verification nits: corrected "16-to-21-character" OCC description and added `services/openbb/vertex_openbb/options_math.py`; replaced subjective/colloquial wording; consolidated `## Goals & Non-Goals`; promoted `### Terms`; removed empty `## Open Questions`; narrowed the Security note; and specified the exact single-file coverage command (`pnpm exec vitest run --config vitest.config.ts --project operations --coverage --coverage.include=scripts/openbb/tick.ts scripts/openbb/tick.test.ts`) plus `bun run verify:coverage`.
