# Engine comparison driver (rig timer)

Step 4 of the [Nautilus switch plan](../../docs/vertex-rebuild/nautilus-backtest-engine.md#switch-plan) needs two weeks of live side-by-side data before the owner decides on 2026-11-20. Until 2026-11-10 nothing called the dual-run features, so no instant or gate comparisons were recorded after 2026-11-06. Owner choice 2026-11-10 ("Daily driver + 1 research campaign"): a rig timer runs a fixed set of instant backtests and one sweep once a day through the API with an operator write key, ticks one research Autopilot campaign so the gate is compared, and rebuilds the report page. Research only: the driver calls `instantBacktest.run`, `backtestRuns.sweep`, `backtestRuns.comparisons.list` and `autopilot.campaigns.tick`, and nothing that places orders, arms trading or deploys.

## What one run does

1. Instant backtests ([driver.ts](../../scripts/engine-comparison-driver/driver.ts) `DRIVER_INSTANT_SET`): SMA cross 20/100 on SPY, QQQ, IWM, GLD, ES=F, NQ=F, GC=F and CL=F daily bars, and a SPY 55/20 breakout with a 200-day trend filter and a 5 % stop, all at 1 bp cost. A series without stored bars is reported and skipped. Agent keys may call `instantBacktest.run` only once it is in the agent key scope (`AGENT_API_KEY_PROCEDURE_PATHS` in `packages/api/src/server/handler.ts`, a separate change); until that is deployed every instant request answers 403 and the driver reports it. The runs go one at a time: the API fails a user's still-queued older instant runs when a new instant request arrives, so the driver waits until the research worker has claimed each run (polls every 15 s, at most 15 min; on a timeout it stops the instant runs and exits 1). When the API answers `reused` (an identical group queued in the last 24 hours), the driver waits until that group is 24 hours old and asks again once, if that is at most 20 minutes away.
2. One sweep: the 20-cell SPY SMA grid of the first live sweep (fast 5 to 25 step 5, slow 40 to 100 step 20) from 2015-01-02 to yesterday (UTC), so every day is a new comparison group.
3. The research Autopilot campaign named in `VERTEX_DRIVER_CAMPAIGN_ID`: `VERTEX_DRIVER_CAMPAIGN_TICKS` tick slices (default 3, at most 20); each tick that gates candidates queues the gate runs on Nautilus. Creating the campaign needs an operator session (agent keys may only tick), so the owner creates it on the Autopilot page and its id goes into the environment file.
4. After a 10 minute wait for the worker (`VERTEX_DRIVER_REPORT_WAIT_S`), the report page is rebuilt with `bun run vertex:engine-comparison-report -- --out "$VERTEX_DRIVER_REPORT_OUT"` when the runner checkout has that script. The report gets the key file path, never the key.

The driver prints one line per request and a summary; it exits 1 when any request failed, and the wrapper keeps that exit code (else the report's).

## Install (rig)

```sh
git -C ~/Github/trading/vertex-research-public fetch origin
git -C ~/Github/trading/vertex-research-public worktree add --detach ~/Github/trading/vertex-research-public-driver-runner origin/vertex/rebuild-darkfactory-20260921
(cd ~/Github/trading/vertex-research-public-driver-runner && pnpm install --frozen-lockfile)
install -m 0755 infra/engine-comparison-driver/vertex-engine-comparison-driver-run ~/.local/bin/
cp infra/engine-comparison-driver/vertex-engine-comparison-driver.{service,timer} ~/.config/systemd/user/
install -m 0600 /dev/null ~/.config/vertex/engine-comparison-driver.env   # then fill in the keys below
systemctl --user daemon-reload && systemctl --user enable --now vertex-engine-comparison-driver.timer
```

Environment file (nonsecret values only; the key stays in its own 0600 file):

| Key | Value |
| --- | --- |
| `VERTEX_ORIGIN` | The Vertex portal origin (tailnet, port 3451) |
| `VERTEX_DRIVER_KEY_FILE` | Path of an operator agent key file with write access (read keys queue nothing) |
| `VERTEX_DRIVER_CAMPAIGN_ID` | The research Autopilot campaign to tick (empty: no ticks) |
| `VERTEX_DRIVER_CAMPAIGN_TICKS` | Ticks per run (default 3) |
| `VERTEX_DRIVER_REPORT_OUT` | Report folder, `~/Documents/reports/web/vertex-engine-comparison` (empty: no report) |
| `VERTEX_DRIVER_RUNNER_DIR` | Runner checkout (default `~/Github/trading/vertex-research-public-driver-runner`) |

Run once by hand: `systemctl --user start --no-block vertex-engine-comparison-driver.service`, then `journalctl --user -u vertex-engine-comparison-driver -o cat`. The new rows show in `backtestRuns.comparisons.list` (feature `instant`, `sweep`, `autopilotGate`) and on the report page.
