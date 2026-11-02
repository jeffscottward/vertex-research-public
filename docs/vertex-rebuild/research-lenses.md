# Research lenses: rotation matrix and deep value screen

Updated: 2026-10-21. Research use only. Nothing in this feature creates, routes or simulates broker orders.

## Purpose

Two read-only portal pages, ported from the vertex-research workspace views `?view=rotation` and `?view=deep-value`:

- `/rotation-matrix`: sector → industry → cap bucket median returns for 1D, 1M, 3M and 6M, leading and lagging industries, standouts (more than 2σ from their industry) and our names (wish list, re-entry, held) tagged as leading, middle or lagging. Click a cell to list its symbols.
- `/deep-value`: the TRUE SLAP scorecard from IG reel Dew5OAejyOH (@willbchou). TRUE (Time horizon, Risk, Upside, Entry) and SLAP (Substance, Longevity, Alignment, Price) each score 0–2 with written evidence. The page shows the stored ranking (our names plus an optional low-price universe), filters for role, minimum score and penny/illiquid/dilution flags, and scores any ticker on demand.

The reel gives no numbers. Every proxy and cutoff is ours, not the reel's, and the page says so. The creator's claims are unverified.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `researchLenses.rotationMatrix`, `researchLenses.deepValue`, `researchLenses.deepValueScore` | `packages/api/src/contracts/research-lenses.ts` |
| TRUE SLAP scoring (pure) | `packages/api/src/deep-value-score.ts` |
| SEC companyfacts and Yahoo chart parsing (pure) | `packages/api/src/deep-value-facts.ts` |
| Procedures, operator gate, bounded fetch, 60 s cache | `packages/api/src/server/research-lenses.ts` |
| Setting `VERTEX_RESEARCH_LENSES_URL` (with `VERTEX_DEPLOY_STATUS_TOKEN`) | `packages/config/src/server.ts`, `apps/web/src/app/api/orpc/[...rest]/route.ts` |
| Pages | `apps/web/src/app/(portal)/rotation-matrix/`, `apps/web/src/app/(portal)/deep-value/`, `apps/web/src/components/portal/{rotation-matrix,deep-value}-workspace.tsx` |
| Data push (rig → QuantVPS) | `infra/quant-vps/research-lenses/` |
| Browser test | `tests/e2e/research-lenses.spec.ts` |

All three procedures are operator-only (`requireOperator`). Agent API keys and MCP tools cannot reach them.

## Data path

The data jobs stay in the vertex-research codebase on dev-rig. This app reads their output; it does not recompute the matrix or the ranking.

1. Rig jobs write JSON:
   - Rotation matrix: `vertex-rotation-matrix.timer` runs collect-rotation-matrix.mjs (vertex-research) from an export of vertex-research `main` and writes `~/Github/trading/vertex-research/data/rotation-matrix/latest.json` (Nasdaq screener metadata, Yahoo daily closes; about 1.8 MB).
   - Deep value: collect-deep-value.mjs (vertex-research) (vertex-research branch `ws/deep-value-screen`, merged as PR #10 plus local fix ffa345d) writes `~/Github/trading/vertex-research-wt-deep-value/data/deep-value/latest.json` (SEC XBRL, Yahoo bars; about 1.8 MB). On 2026-10-21 it has no timer; it runs by hand.
2. `vertex-research-lenses-push.path` (rig user unit) starts `push-research-lenses.sh` when either file changes. The script checks that each file is valid JSON, copies it with `scp` to QuantVPS and renames it into place, so a reader never sees a partial file.
3. On QuantVPS the files live in `/opt/vertex-status/private-v2/research-lenses/{rotation-matrix.json,deep-value.json}`. The `vertex-status-tailnet` Caddy container mounts that folder read-only as `/srv/research-lenses` and serves it at `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-research-lenses/v1/*` with the same source-IP rule and bearer token as the portfolio and history paths (`Caddyfile.snippet`).
4. The web app (`vertex-web.service` on QuantVPS) sets `VERTEX_RESEARCH_LENSES_URL=https://quant-vps-host.example-tailnet.ts.net:8443/vertex-research-lenses/v1` in its private `.dev.vars`. The server fetches each document with a 20 s timeout and a 16 MiB cap, parses it against the contract and caches it for 60 s. A missing file returns `NOT_FOUND` ("not yet collected").

The on-demand score is different: the server fetches Yahoo Finance daily bars and the SEC ticker list and XBRL companyfacts directly (descriptive SEC User-Agent, 64 MiB cap for large filers). The industry and its median EV ÷ sales come from the stored deep-value document when it is available; without it, Upside uses the 52-week-high fallback and the page says so.

## Port notes

- Scoring matches the vertex-research module deep-value.mjs (ffa345d). A local check on 20,000 random fact sets gave identical scores, evidence, flags and reasons. Fact extraction matched the original on 9 real SEC and Yahoo documents, with one intended difference: for filers that report mainly in another currency, operating cash flow is now dropped together with the other USD fundamentals (the original removed the fields before it read operating cash flow).
- Known data issue (both codebases): the latest annual revenue tag for some filers is old. Example on 2026-10-21: TG shows revenue for FY 2011 and ranks first. The evidence text shows the fiscal year, so the age is visible. A staleness rule is open work for the deep-value job.

## Rollback

Unset `VERTEX_RESEARCH_LENSES_URL` (the pages then report "not configured"), or revert the merge. Remove the Caddy handler and the `research-lenses` folder on QuantVPS, and disable `vertex-research-lenses-push.path` on the rig.
