# Consolidated review: history-ibapi-10-30 design (egm-review, full flow, 2026-11-20 UTC)

Mode: "Consolidated report with all review rubrics (runs full flow without stopping)" (standing owner rule). Stages and reports in this folder: Stage 5 `zoom_out_report.md` (zoom-out + inventive catalyst), Stage 6 `comprehension_report.md`, Stage 7 `critic_report.md` (design, structural, style), Stage 8 `intermediate_zoom_out_report.md`, Stage 9 `implementation_readiness_report.md` (implementation readiness, codebase details, style). Each reviewer ran in a fresh context.

Overall: no reviewer found a blocker in the feature sections (lines 1-207). Stage 9 failed the detailed plan with blockers. Stages 5 and 8 found that most findings grow three parts that can be removed. Resolution: simplify first, then fix what is left.

## Action items

| ID | Priority | Action | Source findings | Resolution |
| --- | --- | --- | --- | --- |
| A1 | 🔴 Blocker | Service tests must not need files the deployer does not ship: embed service-test sample answers as Python literals in `test_vertex_history.py`; keep shared JSON fixtures only for the readers | S9 readiness B2, S9 codebase B1 | PROPOSE FIX, applied |
| A2 | 🔴 Blocker | PR #328 is merged (`586600cd`): base the plan on it, drop the wait, `VERSION` 1.6.0, cover tape (tick-by-tick) sizes, re-anchor by symbol not line | S9 codebase B2, readiness M1/M14, style S9 M1/M4, S5 zoom N6, S8 N9 | PROPOSE FIX, applied |
| A3 | 🔴 Blocker | Define the tree hash exactly: keep today's method (`install-history.sh`: SHA-256 over the bytes of the sorted top-level `ibapi/*.py` files, 30 files) with the pinned test vector `bb1de64d...4dcc` | S9 readiness B1, codebase M4 | PROPOSE FIX, applied |
| A4 | 🔴 Blocker | New noise-band test: list it in `services/research/tests/ci-suites.txt`, stub `ibapi` in `sys.modules` | S9 readiness B3, codebase B3, S6 M10, style S9 M5 | PROPOSE FIX, applied |
| A5 | 🔴 Blocker | Web contract shape: no new contract fields (readers already convert volume to shares or contracts; `sizeMultiplier` already carries depth units) | S9 readiness B4 | PROPOSE FIX (removal), applied |
| A6 | 🔴 Blocker | Complete file list (merged-bars, research-lenses, deep-value-sources tests; ci-suites; charts types; order-flow-panel test; `pick-lists.ts:333` Yahoo path; `research/backtests/imom/fetch_ibkr.py`) | S9 codebase B3/M8, S8 M4, S9 readiness M9 | PROPOSE FIX, applied |
| A7 | 🟡 Major | Install shape: re-decided by the advisers (D2r, both B): a `venv-<tree12>` folder next to the old one, `venv` symlink, stop - install - switch - start, existing `rollback-<ts>/` keeps previous code, unit, resolver, Caddyfile and venv target; no release folders, no pruning rule | S5 zoom M3, S5 catalyst M1, S7 design M3/M4, S6 M3/M4, S8 M2 | Adviser re-decision, applied |
| A8 | 🟡 Major | Old-format answers: re-decided by the advisers (Br, both B): readers with a Yahoo fallback accept only v2 (v1 = IBKR failure, Yahoo serves); only the Charts reader keeps "v1 stock volume = no volume" | S5 zoom M2, S8 M3, S7 design M8, S9 codebase M13 | Adviser re-decision, applied |
| A9 | 🟡 Major | Depth: settle the unit question before the switch with one SPY depth read on a spare client id, then drop depth v2, the drop-in, the UI note, the flow-collect gate and deploy step 3 | S5 zoom M1, S8 M1, S5 catalyst M2/M3, S6 M5-M7, S7 design M7, style M11 | ESCALATE: owner question posted (live market-data request is outside the task's "historical requests only") |
| A10 | 🟡 Major | Cache: schema in the cache key for bars only; no cache wipe; accept a few hours without a stale copy for bars after the switch | S8 M5, S7 design M6, style M8, S5 zoom N2 | PROPOSE FIX, applied |
| A11 | 🟡 Major | Remove the exec-node file read and the `docker exec` comparison; the pin is the only client gate | S6 M1, S7 structural M1, S5 catalyst nit, S8 N3, readiness M2 | PROPOSE FIX (removal), applied |
| A12 | 🟡 Major | Correct overclaims: "every page in shares", Charts does not use merged bars, Alternative E reason, IND volume rule as a second G6 exception, "226 of 226 ticks", the IBKR/Yahoo seam stated in `merged-bars.ts` | S7 style M2-M7, S7 design M9/N3, S8 N2/N4 | PROPOSE FIX, applied |
| A13 | 🟡 Major | Evidence in the repository: `evidence.md` (probe table and script); records in `kb-records.md`; decision history out of the feature sections | S6 M9, S7 structural M2, design M11, style M12-M14, S5 zoom M4 | PROPOSE FIX, applied |
| A14 | 🟡 Major | Old research data list: add `research/backtests/imom/fetch_ibkr.py` output; Yahoo-only research fetchers (`freestockalerts`, `quantjourney`) are out of scope (they do not read this service) | S7 design M1/M2, S8 M4 | PROPOSE FIX (scope note), applied |
| A15 | 🟡 Major | Health: drop `error10285` (cannot fire after the start gate); keep `unsetSizes` with a warning, `startedAt`, client and server version | S8 N3, S5 zoom N3, readiness M3 | PROPOSE FIX, applied |
| A16 | 🟡 Major | Smoke checks: one retry after `retry_after` on HTTP 429 before an automatic rollback | S9 readiness M11 | PROPOSE FIX, applied |
| A17 | 🟡 Major | Unit names: reuse `shares`; add `contracts`; `unqualified` (repo term) for stocks outside USD; null for IND and CASH | S8 N5, S7 design N4, S5 zoom N7 | PROPOSE FIX, applied |
| A18 | 🟢 Nit | Nullable depth level size | S5 catalyst N1 | DECLINE (no observed case; drop and count) |
| A19 | 🟢 Nit | Separate card to measure non-USD stocks | S5 catalyst N3 | DECLINE (hiding is the stated cost) |
| A20 | 🟢 Nit | 20-session, 3-symbol ratio finding | S8 N8 | PROPOSE FIX (drop it; keep the 0.4-1 gate), applied |
| A21 | 🟢 Nit | Live rollback drill | S8 M2 | PROPOSE FIX (drop the drill; the automatic rollback and `rollback-history.sh` stay), applied |
| A22 | 🟢 Nit | Project terms undefined | S6 M8, style N1 | PROPOSE FIX (short glossary), applied |
| A23 | 🟢 Nit | Futures `mdSizeMultiplier` "never measured" | S7 style M6 | CONTEST: measured, ES 1 with 9.81.1 (`evidence.md`) |
| A24 | 🟢 Nit | Wheel licence for redistribution | S7 design N8 | CONTEST: the repository holds only the URL and hashes, as for 9.81.1 today |

Counts: 19 PROPOSE FIX applied (including 2 adviser re-decisions, A7 and A8), 1 ESCALATE (A9, owner question), 2 DECLINE (A18, A19), 2 CONTEST (A23, A24).

## Traceability

Every finding in the five stage reports maps to one row above; findings not listed by ID are wording or line-anchor nits covered by A2 (re-anchor), A12 (wording) and A13 (structure).
