# Engine comparison driver (rig timer)

Step 4 of the [Nautilus switch plan](../../docs/vertex-rebuild/nautilus-backtest-engine.md#switch-plan) needs two weeks of live side-by-side data before the owner decides on 2026-11-20. Until 2026-11-10 nothing called the dual-run features, so no instant or gate comparisons were recorded after 2026-11-06. Owner choice 2026-11-10 ("Daily driver + 1 research campaign"): a rig timer runs a fixed set of instant backtests and one sweep once a day through the API with an operator write key, ticks one research Autopilot campaign so the gate is compared, and rebuilds the report page. Research only: the driver calls `instantBacktest.run`, `backtestRuns.sweep`, `backtestRuns.comparisons.list` and `autopilot.campaigns.tick`, and nothing that places orders, arms trading or deploys.

Dependencies:

- The instant leg calls `instantBacktest.run` with the driver's operator write key. It is in the agent key scope (`AGENT_API_KEY_PROCEDURE_PATHS` in `packages/api/src/server/handler.ts`) since card vertex-step4-live-data (2026-11-12); `instantBacktest.series` and `instantBacktest.universes` stay session-only. A server without that change answers 403 on the first instant request; the driver then logs one FAIL, skips the other instant runs and exits 1.
- The report step needs `vertex:engine-comparison-report` (PR #167) in the runner checkout. Without it the wrapper exits 3 after the driver (or with the driver's own failure code).

## What one run does

1. Instant backtests ([driver.ts](../../scripts/engine-comparison-driver/driver.ts) `DRIVER_INSTANT_SET`): SMA cross 20/100 on SPY, QQQ, IWM, GLD, ES=F, NQ=F, GC=F and CL=F daily bars, and a SPY 55/20 breakout with a 200-day trend filter and a 5 % stop, all at 1 bp cost. A series without stored bars (404 "No stored bars for this series") is reported and skipped; any other 404 is a failure. The runs go one at a time: the API fails a user's still-queued older instant runs when a new instant request of the same user arrives, so the driver waits until the research worker has claimed each run (polls every 15 s, at most 15 min per run) and fails a run that something else superseded meanwhile. When the API answers `reused` (an identical group queued in the last 24 hours), the driver waits until that group is 24 hours old and asks again once, if that is at most 20 minutes away. The whole instant phase stops after 45 minutes; each request times out after 2 minutes.
2. One sweep: the 20-cell SPY SMA grid of the first live sweep (fast 5 to 25 step 5, slow 40 to 100 step 20) from 2015-01-02 to yesterday (UTC), so every day is a new comparison group.
3. The research Autopilot campaign named in `VERTEX_DRIVER_CAMPAIGN_ID`: `VERTEX_DRIVER_CAMPAIGN_TICKS` tick slices (default 3, at most 20); each tick that gates candidates queues the gate runs on Nautilus. Creating the campaign needs an operator session (agent keys may only tick), so the owner creates it on the Autopilot page and its id goes into the environment file. Do not set a campaign id while the every-minute `vertex-autopilot.timer` (`infra/autopilot`) is active: two ticks of one campaign at once can lose an update. On 2026-11-10 that timer was not installed on the rig.
4. After a 10 minute wait for the worker (`VERTEX_DRIVER_REPORT_WAIT_S`), the report page is rebuilt with `bun run vertex:engine-comparison-report -- --out "$VERTEX_DRIVER_REPORT_OUT"`. The report gets a key file path (`VERTEX_DRIVER_REPORT_KEY_FILE`, a read key is enough; default the driver's key file), never the key.

The driver prints each line as it happens and a summary. Exit codes: 0 all requests fine, 1 a request failed, 2 configuration refused (missing origin or key, an origin that is not https, a bad tick count; the wrapper then skips the report). The wrapper keeps the driver's failure code, else the report's.

The key's owner is the `requestedBy` of every queued run. With the owner's own key, an instant request of the driver supersedes the owner's still-queued interactive instant runs and the other way round; the 06:15 schedule keeps them apart, and a key of a separate service user removes the overlap.

## Install (rig)

All paths in the environment file must be absolute: systemd does not expand `~`.

```sh
cd ~/Github/trading/vertex-research-public
git fetch origin
git worktree add --detach ~/Github/trading/vertex-research-public-driver-runner origin/vertex/rebuild-darkfactory-20260921
(cd ~/Github/trading/vertex-research-public-driver-runner && mise install && pnpm install --frozen-lockfile)
install -D -m 0755 infra/engine-comparison-driver/vertex-engine-comparison-driver-run ~/.local/bin/vertex-engine-comparison-driver-run
mkdir -p ~/.config/systemd/user && cp infra/engine-comparison-driver/vertex-engine-comparison-driver.{service,timer} ~/.config/systemd/user/
install -D -m 0600 /dev/null ~/.config/vertex/engine-comparison-driver.env   # then fill in the keys below
systemctl --user daemon-reload && systemctl --user enable --now vertex-engine-comparison-driver.timer
```

Update the runner checkout after a merge that changes the driver or the report (the timer runs whatever it has checked out):

```sh
git -C ~/Github/trading/vertex-research-public fetch origin
git -C ~/Github/trading/vertex-research-public-driver-runner checkout --detach origin/vertex/rebuild-darkfactory-20260921
(cd ~/Github/trading/vertex-research-public-driver-runner && mise install && pnpm install --frozen-lockfile)
```

Environment file (nonsecret values only; the keys stay in their own 0600 files, and the wrapper refuses a key file that group or others can read):

| Key | Value |
| --- | --- |
| `VERTEX_ORIGIN` | The Vertex portal origin (https, tailnet, port 3451) |
| `VERTEX_DRIVER_KEY_FILE` | Absolute path of an operator agent key file with write access (read keys queue nothing) |
| `VERTEX_DRIVER_REPORT_KEY_FILE` | Optional: key file for the report (read access is enough) |
| `VERTEX_DRIVER_CAMPAIGN_ID` | The research Autopilot campaign to tick (empty: no ticks) |
| `VERTEX_DRIVER_CAMPAIGN_TICKS` | Ticks per run (default 3) |
| `VERTEX_DRIVER_REPORT_OUT` | Report folder, for example `/home/<user>/Documents/reports/web/vertex-engine-comparison` (empty: no report) |
| `VERTEX_DRIVER_RUNNER_DIR` | Runner checkout (default `$HOME/Github/trading/vertex-research-public-driver-runner`) |

Run once by hand: `systemctl --user start --no-block vertex-engine-comparison-driver.service`, then `journalctl --user -u vertex-engine-comparison-driver -o cat`. The new rows show in `backtestRuns.comparisons.list` (feature `instant`, `sweep`, `autopilotGate`) and on the report page.
