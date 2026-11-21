# Consolidated EGM Review Report

![CI trigger and lane documentation before and after](./ci-trigger-before-after.svg)

**Target:** `docs/vertex-rebuild/designs/ci-trigger-documentation/plan.md`

**Mode:** REVIEW · **Step:** uninterrupted · **Semantic split:** FeatureRange 1–17; DetailedRange 18–24. The reviewers examined the initial plan; this report records resolution and its updates.

## Reviewer status

| Stage | Reviewer | Result |
| --- | --- | --- |
| 5 — Initial zoom out | `egm-zoom-out` | Completed; no findings |
| 5 — Initial zoom out | `egm-inventive-catalyst` | Completed; no false compromise |
| 6 — Comprehension | `egm-comprehension` | Completed; two Nits |
| 7 — Critic | `egm-design` | Completed; two Majors, one Nit |
| 7 — Critic | `egm-structural` | Completed; one Major, one Nit |
| 7 — Critic | `egm-style` | Completed; one contested Major, one Nit |
| 8 — Intermediate zoom out | `egm-zoom-out` | Completed; one Nit |
| 9 — Implementation readiness | `egm-implementation-readiness` | Completed; two Majors, two Nits |
| 9 — Implementation readiness | `egm-codebase-details` | Completed; one Major, two Nits |
| 9 — Implementation readiness | `egm-style` | Completed; one Major, two Nits |

## Consolidated findings and resolution

**20 raw findings:** 8 Majors and 12 Nits. Duplicate recommendations were combined below.

1. **Accepted — triggers and planner behavior:** document all four pull-request event types, the live-branch push, nightly schedule, manual dispatch, core-always behavior, docs/draft core-only selection, full-lane conditions for code changes and scheduled/manual runs, and fail-closed behavior for failed, unknown, or empty changed-path discovery.
2. **Accepted — lane detail:** name the four verification checks and scripts. Distinguish coverage checks from the baseline and conditional shards. State that the browser check joins a full run only when `BROWSER_TESTS=on` or manual `browser_tests=on`.
3. **Accepted — deployment evidence:** require manual dispatch against the ref resolving to the intended deployment SHA; require observed `head_sha` equality and success from all four verification checks; state how to enable the browser check; distinguish `ci-gate (manual)` from the pull-request gate.
4. **Accepted — verification and scope:** name `bun run docs:check`; define and link Graphify; map claims to their sources; define pass and diff-boundary criteria; name the exact target sections.
5. **Contested — five verification lanes:** `egm-style` recommended preserving five lanes from stale policy text. The recommendation conflicts with `package.json`'s four `verify:*` scripts, the four verification checks in `.github/workflows/ci.yml`, and the four checks listed in `docs/deploy.md` lines 47 and 60–63. Keep four verification lanes; describe coverage shards separately.

**Resolution:** Auto-accept all source-supported fixes. One Major is contested with evidence. No findings were declined or escalated to the owner. The updated plan records the implementation boundary and acceptance checks.

## Post-resolution correction

A follow-up review spotted that the diagram connected passing selected verification lanes directly to “mergeable,” although a passing lane run alone does not satisfy effective branch protection. The diagram now labels CI verification success separately and identifies the Vertex branch's strict required status `ci-gate`, as checked live on 2026-11-21. The eight-check example in `docs/deploy.md` configures `jeffscottward/darkfactory/main`, not this Vertex branch; readers must inspect effective rules before every merge. This was an in-scope documentation correction, not an EGM finding, and is not included in the 20-finding count.

## Traceability

| Source finding | Resolution evidence | Changed plan or policy section |
| --- | --- | --- |
| Exact trigger events, core/full selection, and fallback behavior | `.github/workflows/ci.yml`; `scripts/ci/ci-changes.sh` | Plan “Observed behavior”; `AGENTS.md` work sequence step 9 and lifecycle gates; `ARCHITECTURE.md` CI lanes/ADR-011 |
| Optional browser and coverage shards; four checks versus five-lane claim | Workflow matrix, planner, `package.json`, `docs/deploy.md` | Plan “Observed behavior”; CI summary, trigger diagram, ADR-011; AGENTS lifecycle gates |
| Exact ref/SHA and manual run requirements | `docs/deploy.md`; workflow manual gate naming | Plan deployment item; AGENTS deployment paragraph |
| Executable check, source mapping, and diff scope | `package.json`; `AGENTS.md` Work sequence; declared policy-file sections | Plan “Implementation Plan” and “Verification and limits” |
| Verification-to-merge relationship | Live Vertex branch-protection query (2026-11-21); `docs/deploy.md` lines 43–50 | Diagram separates lane success from mergeability, names the current required `ci-gate`, and directs readers to inspect live rules; the eight-check example targets DarkFactory `main` |

## Stage reports

- [Stage 5 — Initial zoom out](./zoom_out_report.md)
- [Stage 6 — Comprehension](./comprehension_report.md)
- [Stage 7 — Critic](./critic_report.md)
- [Stage 8 — Intermediate zoom out](./intermediate_zoom_out_report.md)
- [Stage 9 — Implementation readiness](./implementation_readiness_report.md)
- [Stage 9 — Codebase details](./codebase_details_report.md)
- [Stage 9 — Style](./style_readiness_report.md)
- [Resolution decisions](./resolution_report.md)
