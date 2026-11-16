# Research lenses: rotation matrix and deep value screen

Updated: 2026-11-16. Research use only. Nothing in this feature creates, routes or simulates broker orders.

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
| Data jobs (rig): rotation matrix, deep value | `scripts/research-lenses/` |
| Rig units, fetch and push scripts (rig → QuantVPS) | `infra/quant-vps/research-lenses/` |
| Tailnet Caddy route | `infra/quant-vps/status/Caddyfile.tailnet` (`@lens_caller`) |
| Browser test | `tests/e2e/research-lenses.spec.ts` |

All three procedures are operator-only (`requireOperator`). Agent API keys and MCP tools cannot reach them.

## Data path

The data jobs live in this repo (`scripts/research-lenses/`, ported on 2026-11-10 from the archived vertex-research repo) and run on dev-rig. The web app reads their output; it does not recompute the matrix or the ranking.

1. Rig jobs write JSON. Before each run, `vertex-research-lenses-fetch` (ExecStartPre) exports `scripts/research-lenses` from `origin/vertex/rebuild-darkfactory-20260921` of the local vertex-research-public clone into `~/.local/share/vertex-research-lenses/app`, so no job runs from a working checkout (`LENSES_BRANCH` in `~/.config/vertex/research-lenses.env` overrides the branch).
   - Rotation matrix: `vertex-rotation-matrix.timer` (weekdays 16:40 and 18:30 New York time, at boot) runs `collect-rotation-matrix.ts` and writes `~/.local/share/vertex-research-lenses/data/rotation-matrix/latest.json` (Nasdaq screener metadata, daily closes from IBKR for our names and Yahoo for the rest, see "IBKR first" below; about 1.8 MB).
   - Deep value: `vertex-deep-value.timer` (weekdays 16:55 and 18:50 New York time, at boot) runs `collect-deep-value.ts` with the rotation matrix document, ordered after the rotation matrix job; the fetch script takes a lock, so the two jobs never replace the runner directory at once and writes `~/.local/share/vertex-research-lenses/data/deep-value/latest.json` (SEC XBRL, daily bars from IBKR for our names and Yahoo for the rest; about 2 MB).
2. `vertex-research-lenses-push.path` (rig user unit) starts `push-research-lenses.sh` when either file changes. The script checks that each file is valid JSON, copies it with `scp` to QuantVPS and renames it into place, so a reader never sees a partial file.
3. On QuantVPS the files live in `/opt/vertex-status/private-v2/research-lenses/{rotation-matrix.json,deep-value.json}`. The `vertex-status-tailnet` Caddy container mounts `/opt/vertex-status/private-v2` read-only as `/srv` and serves the folder at `https://quant-vps-host.example-tailnet.ts.net:8443/vertex-research-lenses/v1/*` to the rig and the VPS's own tailnet addresses (Vertex web reads from the VPS) with the status bearer token (`@lens_caller` in `infra/quant-vps/status/Caddyfile.tailnet`; the install scripts that re-render that template keep the route).
4. The web app (`vertex-web.service` on QuantVPS) sets `VERTEX_RESEARCH_LENSES_URL=https://quant-vps-host.example-tailnet.ts.net:8443/vertex-research-lenses/v1` in its private `.dev.vars`. The server fetches each document with a 20 s timeout and a 16 MiB cap, parses it against the contract and caches it for 60 s. A missing file returns `NOT_FOUND` ("not yet collected").

The on-demand score is different: the server fetches Yahoo Finance daily bars and the SEC ticker list and XBRL companyfacts directly (descriptive SEC User-Agent, 64 MiB cap for large filers). The industry and its median EV ÷ sales come from the stored deep-value document when it is available; without it, Upside uses the 52-week-high fallback and the page says so.

## IBKR first

Owner rule since PR #169: IBKR first, Yahoo fills gaps. The jobs read IBKR daily bars (`ADJUSTED_LAST`, `1 Y`) through vertex-history (`scripts/research-lenses/history-bars.ts`, a self-contained twin of the server's `ibkr-history.ts`, because the jobs run from a `git archive` extract). Plan and numbers: card vertex-lens-jobs-ibkr-first.

- **Which names**: only our names (wish list and re-entry list; in deep value also the rotation leaders and `--tickers`). The universes (about 3,000 and 1,000 symbols) do not fit the pacing: vertex-history allows 6 historical requests per 120 s for all callers, and the flow collector uses about 2 of them all day. Yahoo reads every other symbol and the days before IBKR's first bar.
- **Pacing**: one request at a time, our names first (45 s client timeout). 40 s after each answer that the service fetched from IBKR or that failed (none after a fresh cache hit). A paced or busy answer, or a stale copy, waits the service's retry time (else 40 s) and asks again, at most 3 times per symbol; the third such answer counts as a failure. A 4xx about the symbol itself (for example `no_contract`) sends only that symbol to Yahoo. A pacing violation, a wait longer than 120 s (the service's back-off), any other 429, HTTP 401 or 403, or 3 failures in a row end IBKR for the run. While the service backs off it often answers with a stale copy instead of the 429; the reader then stops after 3 failures in a row.
- **Run budget**: IBKR is asked only during the first 75 minutes of a run, counted from the first IBKR request (`LENS_IBKR_BUDGET_MINUTES`, a whole number from 0 to 75; 0 turns IBKR off; it can only lower the budget). The units allow 5,400 s and run one job at a time (`flock` on `~/.local/share/vertex-research-lenses/jobs.lock`), so two runs never ask IBKR together.
- **IBKR day cache**: each IBKR answer is stored for the day in `data/rotation-matrix/cache/<day>/_ibkr-bars/` (`IBKR_CACHE_DIR`; the rotation matrix job deletes older days). Deep value reads the same folder (next to its `--rotation` file), so a name the rotation matrix read today costs no second request, and the second run of each job asks IBKR only for names not read that day. A run during the session stores that day's unfinished bar for the rest of the day, as the Yahoo cache does.
- **One day for all names**: the rotation matrix cuts every series at the most common last day (`alignToAsOf`). An IBKR series that already has the day's close while Yahoo's is still empty loses that bar and stays in the matrix.
- **Provenance**: `source.bars` (rotation matrix) and `sources.prices` (deep value) state the names per source, for example "names: 98 IBKR, 3 IBKR with older days from Yahoo, 2898 Yahoo". The run log has one `bars:` or `prices:` line and one line per IBKR failure, never the token or the address.
- **Configuration**: `VERTEX_HISTORY_URL` (the tailnet `/vertex-history/v1` address) and `VERTEX_DEPLOY_STATUS_TOKEN` in `~/.config/vertex/research-lenses.env` (mode 0600). Without them the jobs read Yahoo only, as before.
- **Effect on other callers**: during the IBKR window the portal's own IBKR history reads get paced answers more often and use Yahoo or a stale copy for those reads.

## Port notes

- Scoring matches the vertex-research module deep-value.mjs (ffa345d). A local check on 20,000 random fact sets gave identical scores, evidence, flags and reasons. Fact extraction matched the original on 9 real SEC and Yahoo documents, with one intended difference: for filers that report mainly in another currency, operating cash flow is now dropped together with the other USD fundamentals (the original removed the fields before it read operating cash flow).
- Known data issue (both codebases): the latest annual revenue tag for some filers is old. Example on 2026-10-21: TG shows revenue for FY 2011 and ranks first. The evidence text shows the fiscal year, so the age is visible. A staleness rule is open work for the deep-value job.

## Rollback

Unset `VERTEX_RESEARCH_LENSES_URL` (the pages then report "not configured"), or revert the merge. Remove the `@lens_caller` handler and the `research-lenses` folder on QuantVPS, and disable `vertex-rotation-matrix.timer`, `vertex-deep-value.timer` and `vertex-research-lenses-push.path` on the rig.
