# QuantVPS web app (`vertex-web.service`)

This folder runs the production build of the web app on QuantVPS:

- `vertex-web.service`: the systemd unit. It serves the prebuilt `dist/` folder of `apps/web` with `vite preview` on `127.0.0.1:3450`.
- `run-preview.mjs`: the runner that the unit starts. It checks the private bindings and needs `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json`.
- `Caddyfile`: the `vertex-web-tailnet` proxy. It serves `https://<VERTEX_TAILNET_HOST>:3451` on the tailnet only. The host values come from the server (see "Host config" below).
- `recreate-tailnet-proxies.sh`: installs the committed `Caddyfile` on QuantVPS (`--caddyfile-only`: with a reload, no container removed) and recreates `vertex-web-tailnet` and `vertex-status-tailnet` with the tailscaled socket directory mount (see below).
- `tailscaled-preserve-runtime-dir.conf`: the tailscaled drop-in that keeps `/run/tailscale` across tailscaled restarts.
- `restart-when-idle.sh`: **the only restart route for `vertex-web`**. Do not run `systemctl restart vertex-web` directly.
- `stage-build.sh`: copies the build output of a build commit next to the live one on QuantVPS (`.build-next/` in `apps/web`). The restart script moves it into place with the restart (see "Build stage").
- `stage-runtime.sh`: copies the runtime tree of a build commit (tracked files and `node_modules`) next to the live one on QuantVPS. The restart script moves it into place (see "Runtime tree").
- `prune-web-backups.sh`: keeps the newest 10 web build backup pairs in `apps/web` on QuantVPS and deletes older ones (see "Backup retention").
- `prune-runtime-backups.sh`: keeps the newest 2 runtime tree backups (`.runtime-bak-<TS>/`) in the checkout on QuantVPS and deletes older ones (see "Backup retention").

## Restart route

Run the script on the rig from a checkout of this repository. It reaches QuantVPS through the `quantvps` SSH alias. A real run (no `--dry-run`) needs bash 5.3 or newer; on an older bash it prints `NOT RESTARTED: bash <version> is older than 5.3. ...` and exits with code 2 before it takes the lock. Reason: bash 5.2 can run the INT, TERM or HUP trap inside the parser of a `$(...)` command substitution. The trap then fails with a false `unexpected EOF` syntax error, the stop signal has no effect, and the script can leave the idle wait and restart `vertex-web` while it is busy ([bug-bash report](https://lists.gnu.org/archive/html/bug-bash/2023-09/msg00058.html), fixed in bash 5.3; bash older than 5.2 is refused untested). The rig has bash 5.3. On another host, put bash 5.3 or newer first in `PATH`: the script starts with `#!/usr/bin/env bash`.

```sh
infra/quantvps/restart-when-idle.sh --dry-run   # print the idle decision only; exit 0 = idle, 10 = busy
infra/quantvps/restart-when-idle.sh             # wait until idle, restart, check health, roll back on failure
infra/quantvps/restart-when-idle.sh --deploy <sha>   # the same, and swap the staged build of <sha> in with the restart
```

The script restarts only `vertex-web`. It never starts, stops or restarts Nautilus, the IB gateway, the exec node, the recovery bridge, Docker or any container. After a restart it compares every container start time with the values before the restart and prints `protected containers: start times unchanged`.

Steps:

1. Gate: the build output (`dist/server/wrangler.json` and `.wrangler/deploy/config.json`) and a rollback source (`dist.bak-<TS>` with `.wrangler.bak-<TS>`, where `<TS>` has the form `20261101T125501Z`; both must be directories and no symlinks) must exist in `apps/web` on QuantVPS. If not, the script does not restart (exit 3). With `--deploy <sha>` a complete stage of that commit must exist (exit 3 if not), and the rollback source is the backup pair that the build swap of this run makes (see "Build stage").
2. Wait until `vertex-web` is idle on two polls in a row (default every 5 s).
3. Restart the unit. With `--deploy <sha>` the same remote command first moves the staged build into place. Then wait up to 120 s (wall clock) for this health result: `/` returns 200 and `/dashboard` returns 307 to `/sign-in`.
4. If the health check fails, move the failed build to `dist.failed-<now>` and `.wrangler.failed-<now>`, copy the newest backup pair (or `--backup <TS>`) into place, restart and check health again. The script deletes nothing. Send one notice to #omp-alerts (exit 5 when the rollback is healthy, exit 6 when it is not).
5. If the waiter has not seen two idle polls in a row 60 min (wall clock, `VERTEX_RESTART_GIVE_UP_AFTER` in seconds) after the first busy poll, give up with one notice to #omp-alerts (exit 4). There is no forced restart.

Only one waiter runs at a time (`flock` on `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock`, the same path for every caller). A second waiter does nothing and exits with code 8. Only a held lock gives exit 8. Exit 8 can also mean that `stage-build.sh`, `stage-runtime.sh` or a prune script holds the lock; run the restart again when that script has ended. When the lock file cannot be opened (for example a full disk, no permission, or a directory at that path) or `flock` fails in another way, the script prints `NOT RESTARTED: cannot open lock file <path>: <reason>` (or `cannot lock <path> (flock exit <n>)`), does nothing and exits with code 11. Treat exit 11 as a failed run: fix the cause, then run the script again.

The container start-time baseline is taken after the idle wait, right before the restart, because the wait can cross the scheduled 03:00 UTC exec-node container restarts. Only containers in the baseline are compared. A changed start time, or a baseline container that is missing after the restart, sends one notice to #omp-alerts (exit 7). One-off `compose run` containers (`*-run-<hex>`) may vanish, and new containers are ignored. A failed start-time check after the restart also exits 7, without a notice.

Exit codes: 0 restarted and healthy; 2 usage error, or a real run on bash older than 5.3 (nothing done); 3 gate, build guard or probe failed, or the `vertex-web` start time did not change (no restart happened), or the deploy is not confirmed (`--deploy`: the swap or the restart); 4 gave up while busy; 5 rolled back and healthy; 6 rollback failed and the web app is down, or the health check got no answer over ssh (state unknown, no rollback); 7 a container start time changed or could not be checked; 8 another waiter holds the lock; 9 the version guard refused the build; 11 the lock file could not be opened or `flock` failed (no restart happened); 12 the runtime guard refused (see "Runtime tree"); 14 the market hours guard refused (see "Market hours guard"; 13 is not used, it means "partial or unknown" in the prune scripts). `--dry-run`: 0 idle, 10 busy.

### Market hours guard

Owner rule of 2026-11-16: no restart or deploy of a QuantVPS service in US market hours. A real run of `restart-when-idle.sh` refuses with exit 14 on Monday to Friday from 08:30 to 16:00 New York time (16:00 itself is allowed; market holidays count as trading days). It checks before the lock and before any call to QuantVPS, again before each idle poll and after the idle wait, so a run that started at 08:00 stops at 08:30 with no restart. A time that cannot be read counts as market hours: the script reads `TZ=America/New_York date` and needs the zone name `EST` or `EDT`.

- `--allow-market-hours "<reason>"` skips the guard. Use it only with an owner decision. The script prints the reason and sends one notice to #omp-alerts, at the first check that falls inside the window; the run can still end without a restart.
- `--dry-run` prints the decision (`market hours: outside ...` or `market hours guard would refuse: ...`) and never refuses.
- The stage scripts (`stage-build.sh`, `stage-runtime.sh`) have no guard: they change no file that a running process reads. A deploy in market hours stops at the restart.
- `infra/quant-vps/history/install-history.sh` has the same check as its first step after the host-config check (exit 3, "nothing changed") and no override. `infra/quant-vps/odte-quotes/install.sh` has its own check of the same window.
- `prune-runtime-backups.sh` has another window (09:15 to 16:05) for its deletes; see "Runtime tree backups".

### Idle signal

All of these must be true. The quiet window is 30 s (`VERTEX_RESTART_QUIET`).

- The last journal line of `vertex-web` is older than the quiet window. `vite preview` logs every completed request (`GET /path 200 OK (12ms)`).
- On every established TCP connection to port 3450 (`ss -tni`): no bytes are queued, and no data was sent or received inside the quiet window (`lastsnd`, `lastrcv`). Idle keep-alive connections from Caddy count as idle.
- No connection has an open request. A request still waits for its response (for example a slow database query) when data was received after the last data sent (`lastrcv` is smaller than `lastsnd`), or when a new connection received bytes and has sent none.
- The probe is complete: the `ss` output ends with an end marker. A failed or cut probe counts as busy.
- A unit that is not active has no request to protect. It counts as idle.

Limit: a streamed response that already sent some bytes and then stalls for longer than the quiet window, with no other traffic, reads as idle.

Clients that poll `vertex-web` must leave gaps longer than the quiet window plus one poll (35 s), or the app never reads as idle. The Nautilus backtest worker on the rig can poll every 3 s, so the script pauses it: right before the idle wait it writes its PID and the time to the worker pause file (`VERTEX_WORKER_PAUSE_FILE`, default `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-nautilus-worker.pause`; the script and the worker run as the same user on the rig) and removes it on every exit (trap on EXIT, INT, TERM and HUP). While the file exists the worker claims nothing; a run in progress finishes first, which only delays the idle decision. The worker ignores a file older than 90 min, so a script killed with SIGKILL cannot stop it for good. The worker also pauses while another process holds this script's lock file, so older copies of the script that never write the pause file work too. `--dry-run` never touches the file, so a dry run while the worker polls reads busy. A file that cannot be written is a warning; the wait may then give up. The Autopilot tick (once a minute) also logs a line and is not paused; it leaves gaps of about 60 s. See [infra/research-worker/README.md](../research-worker/README.md#web-restarts).

Nautilus backtests never run on QuantVPS (owner decision 2026-11-05): `vertex-web` only queues them. With `VERTEX_ENGINE_COMPARISON=on` in the web app environment, instant backtests, sweep cells and Autopilot gate runs are also queued for the Nautilus worker on the rig, and `VERTEX_HOST_LABEL` (for example `QuantVPS web (in-request)`) labels the TypeScript times ([docs/vertex-rebuild/nautilus-backtest-engine.md](../../docs/vertex-rebuild/nautilus-backtest-engine.md#dual-run-engine-comparison)).

## Deploy a new web build

1. On the rig, build the merged SHA in a worktree: `pnpm install --frozen-lockfile && bun run build`, then record it: `git rev-parse HEAD > apps/web/dist/DEPLOYED_SHA`. Use `bun run build`, not a bare `turbo run build`: the root script sets `VERTEX_BUILD_SHA` to `HEAD`, and the web build's turbo cache key includes it, so a new commit never replays a cached bundle with the previous commit's click-log SHA (fixed 2026-11-07).
2. Take the deploy claim: `fm claim <card> deploy:quantvps-web` (`fm` is the job tracker on the rig). A held claim means that another deploy runs: wait for it or talk to its job. Release the claim after step 8.
3. In the build worktree of step 1, run `infra/quantvps/stage-build.sh`. It copies `apps/web/dist/` and the deploy config to `.build-next/` in `apps/web` on QuantVPS and writes the marker `STAGED_SHA` last (see "Build stage"). It changes no file that the running web app reads, and it never copies `dist/server/.dev.vars`: only the host has this bindings file, and `run-preview.mjs` writes it again at each start. Never copy a build over the live `dist`: until the restart the running process would serve from a folder that it was not started from, and requests for the asset files of its own build would get HTTP 500 (2026-11-19, 30 minutes).
4. In the build worktree of step 1, run `infra/quantvps/stage-runtime.sh`. It stages the runtime tree of the build commit in `.runtime-next/` on QuantVPS and changes no live file (see "Runtime tree"). It must run in the build worktree, because only that worktree holds the installed packages of the build commit; this is why the restart script does not call it.
5. Run `infra/quantvps/restart-when-idle.sh --deploy <sha>` from an up-to-date rig checkout, with the commit of step 1. After the idle wait it swaps the staged build and the staged runtime tree in with the restart, in one remote command. Its rollback source is the live build, which the swap keeps as the backup pair `dist.bak-<TS>` with `.wrangler.bak-<TS>`. Exit 3 with a `build stage:` line means that step 3 is missing for this commit; exit 12 means that step 4 is missing; exit 14 means US market hours (see "Market hours guard"): run the deploy after 16:00 or before 08:30 New York time. An old copy of the script rejects `--deploy` (exit 2): update the checkout. Without `--deploy` the script restarts the build that is live in `dist` and ignores a stage. A run without `--deploy` whose `version:` line shows a new commit in `dist` is the retired route (a build was copied over the live `dist`).
6. Run `infra/quantvps/recreate-tailnet-proxies.sh --caddyfile-only` from the same checkout. It installs the committed `Caddyfile` with a reload and no proxy outage, and when the installed proxy file already equals the committed one it changes nothing and only repeats the reload (see "Change the installed Caddyfile"). The web deploy itself does not copy the proxy file.
7. After the restart, check one page response through the proxy: `content-security-policy` must contain `script-src 'self' 'nonce-`.
8. When the restart of step 5 ended with exit code 0 and step 7 passed, run `infra/quantvps/prune-web-backups.sh --apply` and then `infra/quantvps/prune-runtime-backups.sh --apply` from the same checkout (see "Backup retention"). Run the second one whatever the first one returns. A prune never fails the deploy. Report the exit code and last line of each with the deploy. On exit code 8 do not wait; the next deploy prunes.

Locks of a deploy: the stage, restart and prune scripts take the restart lock themselves (`${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock` on the rig), without waiting. Never wrap a deploy step in another lock. A deploy does not take the git locks of the rig jobs, `/tmp/vertex-research-public-integrate.lock` (merges) and `/tmp/vertex-research-public-prepush.lock` (pushes): on 2026-11-19 a restart waited 27 minutes behind a merge lock. The deploy claim of step 2 is the only thing that orders two deploys.

Host values (2026-11-05, public repository): the committed tree names no real host. The real values are server-side config on QuantVPS and never committed: `run-preview.mjs` takes the tailnet origin from `APP_URL` in `private/basic-app-named/.prod.vars`, and the research fetch User-Agent takes its contact from `VERTEX_RESEARCH_CONTACT_EMAIL`. The proxy and install scripts read `/etc/vertex/hosts.env` (see "Host config"). Copy no build file by hand: `stage-build.sh` copies `apps/web/dist/` and `.wrangler/deploy/config.json`, and nothing else. Do not copy the committed unit over the installed one (`/etc/systemd/system/vertex-web.service`; the copy in the checkout is not the installed file), and install the committed Caddyfile only with `recreate-tailnet-proxies.sh` (step 6). The runner `run-preview.mjs` is part of the runtime tree since 2026-11-15: `stage-runtime.sh` brings the committed runner with every build, so a server-side edit of it does not survive the next deploy.

Version guard across repositories: when the deployed SHA comes from another repository (the first public deploy after private `c328e600`), fetch that repository into the rig checkout so both commits exist in one git directory, for example `git fetch <private-checkout> <deployed-sha>`. Unrelated histories count as diverged, so the guard passes; set `VERTEX_DEPLOY_GIT_DIR` to use another checkout.

Version guard (added 2026-11-03 after 97fc8803, an ancestor of the live 99c1e1b1, was deployed and removed #163 and #165): before the idle wait, the script reads the new SHA from `DEPLOYED_SHA` in the staged build (`.build-next/dist`, with `--deploy`; without it from `dist/DEPLOYED_SHA`) and the deployed SHA from `DEPLOYED_SHA` in `apps/web` on QuantVPS. It stops with exit 9 and no restart when the new SHA is a strict ancestor of the deployed SHA, when either SHA is unknown, or when the rig checkout does not contain both commits. An equal SHA or a newer or diverged SHA passes. After a healthy restart the script writes the checked SHA to `DEPLOYED_SHA` in `apps/web`, only while `dist/DEPLOYED_SHA` still holds it; after a rollback it records the restored build's SHA. On exit 9 with `--deploy` the refused build stays in `.build-next` and is never used without `--deploy`. On exit 9 without `--deploy` the refused build is in `dist` (a build that was copied over the live `dist`, the retired route): restore the newest backup pair at once, so a crash restart cannot serve it. For a deliberate rollback, or the first deploy before `DEPLOYED_SHA` in `apps/web` exists, pass `--allow-older "<reason>"`; the script prints the warning and the reason. `--dry-run` prints what the guard would decide.

## Build stage

A deploy never changes the live `dist`: the running process serves only from the folder that it was started from.

- **Stage** (`stage-build.sh`, deploy step 3): it runs on the rig in the build worktree and holds the restart lock. It refuses (exit 3, nothing changed) a worktree with changed tracked files, a missing build output, and a `apps/web/dist/DEPLOYED_SHA` that is not `HEAD`. It removes the marker of an earlier stage, copies the build output to `.build-next/dist/` and the deploy config to `.build-next/.wrangler/deploy/config.json` in `apps/web` on QuantVPS, checks the copy and writes `.build-next/STAGED_SHA` last. A stage without this marker is incomplete and is never used. Exit codes: 0 staged; 2 usage; 3 refused before any change; 5 the copy or the check failed; 8 the restart lock is held; 11 lock file error.
- **Build guard** (in `restart-when-idle.sh`, first step after the lock): with `--deploy <sha>` the stage must be complete and hold that commit, else exit 3. Without `--deploy` a stage is ignored, and the script prints `build: the staged build <sha> in .build-next is ignored (no --deploy)`. So a stage that was left behind does nothing; the next `stage-build.sh` run replaces it.
- **Swap:** inside the one remote command that restarts the unit, after the idle decision: check the stage again; copy `.wrangler` to `.wrangler.bak-<TS>` (it also holds local state of the app, so it is not moved); rename `dist` to `dist.bak-<TS>`; rename `.build-next/dist` to `dist`; replace `.wrangler/deploy/config.json`; then the runtime tree swap, when one is staged; then `systemctl restart`. The command prints `build: <n> ms from the first rename to the restart call`: only for this time the old process runs with the new `dist`.
- **Failure:** a refusal before the first rename prints `build: nothing moved`. A later failure, also a failed runtime tree swap, puts the build back and prints `build: undone`; the stage is then complete again. In both cases the restart is not sent, the old process keeps serving its own `dist`, and the run ends with exit 3. A half pair `.wrangler.bak-<TS>` can stay; no script uses it. When the restart was sent but the unit start time did not change, one more remote call puts the build back (exit 3).
- **Rollback:** when the health check fails after the swap, the rollback copies the pair of this run back, as for every restart; the failed build is kept as `dist.failed-<now>`.
- **Confirmed deploy:** a deploy counts only when the swap and the restart are both confirmed. A reported swap needs a changed unit start time (or, when the start times could not be read, exit 0 of the restart command). The steps of the restart command write to `.build-next/restart.log` on the host, and the command prints that file at its end, so a closed connection cannot stop it between the swap and the restart. With no closing line from the restart command (for example a lost connection) and a changed unit start time, one more remote call must prove the swap of this run (`dist.bak-<TS>` exists, `.build-next/dist` is gone, `dist/DEPLOYED_SHA` holds the new commit, the live deploy config equals the staged one). With an unchanged start time, one more remote call puts the build back. An undo that did not finish never counts as a deploy. A run that ends without a confirmed deploy exits 3 with a `NOT DEPLOYED:` or `NOT RESTARTED:` line and, for an unknown or contradictory state, one notice to #omp-alerts that names `dist`, `.build-next/dist` and `dist.bak-<TS>`.
- **Disk:** a stage costs about the size of one build (126 MB on 2026-11-22) until the swap; the backup pair is then a rename and costs nothing more. A consumed or abandoned `.build-next` is never deleted by the restart script.

### Repair a cut build swap

The restart command can be cut between its steps by a reboot of the host or a kill of the remote shell (a lost connection does not cut it). The sign: `restart-when-idle.sh` ends with `NOT RESTARTED: build output missing`, or the notice says that the deploy is not confirmed. Read `.build-next/restart.log` in `apps/web` on QuantVPS first: it holds the output of the steps that ran. Then look at three names there: `dist`, `.build-next/dist` and the newest `dist.bak-<TS>`.

- `dist` is missing: the newest `dist.bak-<TS>` is the build of the running process. Put it back: `mv -T dist.bak-<TS> dist`.
- `dist` exists, `.build-next/dist` is missing, and `vertex-web` did not restart (its `ActiveEnterTimestamp` is older than `dist.bak-<TS>`): the old process runs with the new `dist`. Put the old build back: `mv -T dist .build-next/dist && mv -T dist.bak-<TS> dist && cp .wrangler.bak-<TS>/deploy/config.json .wrangler/deploy/config.json`.

- `dist` exists, `.build-next/dist` is missing, and `vertex-web` did restart after the swap (for example a host reboot): the new build runs, but this run did not check its health. Check it with `infra/quantvps/restart-when-idle.sh --dry-run` (`health now:`). When it is healthy, write its commit to `DEPLOYED_SHA` in `apps/web`. When it is not, put the old build back as in the second case and restart with `infra/quantvps/restart-when-idle.sh`.

Then run `infra/quantvps/restart-when-idle.sh --dry-run` and check the `build:` and `health now:` lines. After one of the first two cases, run the deploy again from step 5.

## Runtime tree

The checkout on QuantVPS is a plain copy of the repository tree, without `.git` and without a package store. `vertex-web` reads more than the build output from it: the runner, `apps/web/vite.config.ts`, `apps/web/src/proxy.ts`, `package.json` files of workspace packages and the installed packages (measured from file access times on 2026-11-15). Until 2026-11-15 no deploy step updated these files, so the web app ran a new build on packages of 2026-10-21 (card `quantvps-checkout-seroval-node-modules`).

- **Runtime tree:** every tracked file of the build commit, and `node_modules` of the root and of each workspace package. `RUNTIME_SHA` in the checkout root names the commit.
- **Server-side state:** `private/`, and in `apps/web` the build output (`dist`, `.wrangler`), its backups, the build stage (`.build-next`), `DEPLOYED_SHA`, `.next` and `.vinext`. No stage or swap touches these. Keep server-only files only there: an untracked file in any other tracked directory moves to the backup directory with the next swap. A server-side tool must not name a package version path in the checkout (`node_modules/.pnpm/<name>@<version>`): the path changes with the lockfile.
- **Stage** (`stage-runtime.sh`, deploy step 4): it runs on the rig in the build worktree and holds the restart lock. It refuses a worktree with changed tracked files, an unfinished earlier swap, and less than 5 GiB free on QuantVPS (`VERTEX_RUNTIME_MIN_FREE_KB`). It copies the tree to `.runtime-next/` in the checkout; a file with the same content, owner and mode as the live file becomes a hard link (file times are not copied and do not count). It starts the staged `vite` and `workerd` with `--version`. It writes `PATHS` (the swap units) and then `RUNTIME_SHA`; a stage without `RUNTIME_SHA` is incomplete. Exit codes: 0 staged; 2 usage; 3 refused before any copy; 4 program check failed; 5 copy failed; 8 the restart lock is held; 11 lock file error.
- **Runtime guard** (in `restart-when-idle.sh`, after the version guard): `RUNTIME_SHA` equals the new build SHA: plain restart. A complete stage for the new build SHA exists: the restart swaps it in. Anything else stops the run with exit 12: another commit with no stage, no answer over ssh, an unknown build SHA, or an unfinished swap.
- **Swap:** one remote command moves each path in `PATHS` from the checkout to `.runtime-bak-<TS>/`, moves the staged path into its place and restarts the unit. A failed move puts the finished paths back and the directory gets an `UNDONE` file; the restart command is then not sent, the old process keeps serving, and the run ends with exit 3.
- **Rollback:** when the health check fails after a swap, the rollback command first moves the new tree to `.runtime-failed-<now>/` and the saved tree back, and then restores the build output as before. With no health answer over ssh (exit 6) nothing is rolled back; the alert names the swapped tree and its backup. The runtime rollback pairs with the build backup of the same deploy (the pair that the build swap made). With an older `--backup <TS>` the web app runs an older build on the previous runtime tree until the next run, whose guard reports the difference.
- **Override:** `--allow-stale-runtime <reason>` restarts although the runtime tree is at another commit, for an urgent restart while a stage is refused (for example by the free-space gate). It sends the reason to `#omp-alerts`. It does not skip the "no answer" and "unfinished swap" refusals.
- **Disk:** `prune-runtime-backups.sh` (deploy step 8) keeps the newest 2 `.runtime-bak-<TS>/` that hold a tree and deletes older ones (see "Backup retention"). `.runtime-failed-<now>/` folders are never deleted by a script. Unchanged files share their data with the live tree through hard links, so a stage and the backup it leaves cost about the size of the changed files. Measured on 2026-11-15, for the first stage against the packages of 2026-10-21: 36,580 of 88,555 files linked, 1.1 GB of new data. Do not edit a file of the runtime tree in place on the server: the edit would also change the backup, and the next swap replaces the file anyway. When the free-space gate refuses a stage, web deploys stop until old backups are removed: run both prune scripts with `--apply`; removing anything they keep needs an owner decision.

### Repair an unfinished runtime swap

A swap is unfinished when the remote command died between two renames (lost connection, reboot), or when an undo could not put a path back. The sign: a `.runtime-bak-<TS>/` or `.runtime-failed-<now>/` directory in the checkout with neither `COMPLETE` nor `UNDONE`. The guard and the stage script then refuse to run and name the directory.

One swap handles each unit (each line of `<directory>/PATHS`) in two renames: the live unit moves into `<directory>/`, then the unit from the source directory moves into its place. The source is `.runtime-next/` for a swap in and `.runtime-bak-<TS>/` for a swap back. `<directory>/DONE` lists the finished units, but a unit can be fully moved and still be absent from `DONE`. So look at each unit before a move, and use `mv -T` (it never moves a path into an existing directory). Both repairs end with the previous runtime tree live.

First find the list and the source. Use `PATHS` of the unfinished directory. When that directory has no `PATHS`, or it holds no unit at all (only `PATHS` and `DONE`), nothing was moved: `touch <directory>/UNDONE` and stop here. In every other case use the rules below, also when `DONE` is empty: the first rename of a unit moves the live unit into the unfinished directory before `DONE` gets a line. The source of a swap back is the newest `.runtime-bak-<TS>/` that has `COMPLETE` (the tree that the failed deploy replaced).

Swap in (`.runtime-bak-<TS>/` is unfinished): undo it. For each unit in `PATHS`:

1. When `.runtime-next/<unit>` is missing and the live unit exists, the staged unit was moved in. Move it back: `mv -T <unit> .runtime-next/<unit>`.
2. When `.runtime-bak-<TS>/<unit>` exists and the live unit is now missing, move the saved unit back: `mv -T .runtime-bak-<TS>/<unit> <unit>`.

Then `touch .runtime-bak-<TS>/UNDONE`.

Swap back (`.runtime-failed-<now>/` is unfinished): finish it. For each unit in `PATHS`:

1. When `.runtime-failed-<now>/<unit>` is missing and the live unit exists, the new unit was not moved out yet: `mkdir -p` the parent in `.runtime-failed-<now>/`, then `mv -T <unit> .runtime-failed-<now>/<unit>`.
2. When `.runtime-bak-<TS>/<unit>` exists and the live unit is missing: `mv -T .runtime-bak-<TS>/<unit> <unit>`.

Then `touch .runtime-failed-<now>/COMPLETE`.

After either repair, `cat RUNTIME_SHA` in the checkout must show the previous commit. Run `infra/quantvps/restart-when-idle.sh --dry-run` and check the `runtime:` lines. The build output is a separate matter: when `dist` in `apps/web` holds a newer build than the runtime tree, the next run swaps the stage in again (swap in) or needs the build backup restored (swap back; see "Build stage").

## Backup retention

Every deploy adds one backup pair in `apps/web` on QuantVPS: `dist.bak-<TS>` with `.wrangler.bak-<TS>` (about 126 MB on 2026-11-22; the build swap of the restart makes it from the live build, see "Build stage"). `prune-web-backups.sh` keeps the newest 10 complete pairs and deletes older ones, at most 3 pairs per run (owner decision 2026-11-15, rule A). Design: `docs/vertex-rebuild/designs/quantvps-web-backup-retention/design.md`.

```sh
infra/quantvps/prune-web-backups.sh           # preview: keep/delete lines and a summary; changes nothing
infra/quantvps/prune-web-backups.sh --apply   # rename and delete up to 3 pairs of the plan
```

How a pair is deleted: under the restart lock (one remote call, no wait) the script renames both folders to `dist.prune-<TS>` and `.wrangler.prune-<TS>`. Then it releases the lock and deletes the renamed folders, oldest first. The restart script selects its rollback source with the glob `dist.bak-<TS>`, so a renamed folder is never a rollback source, and `restart-when-idle.sh --backup <TS>` never reaches a renamed pair. Pairs over the keep count stay reachable until a run renames them. A run that stops is finished by a later `--apply` run: renamed folders count toward the limit of 3 and are deleted first.

Never touched: names with characters other than `A-Z a-z 0-9 . _ -`, half pairs (except the second half of an interrupted rename, which is finished and deleted), symlinks or files in place of a folder, names of another form, and the `dist.failed-*`, `.wrangler.failed-*`, `dist.undeployed-*` and `.wrangler.undeployed-*` folders. The plan output lists or counts them as skip and "not managed" lines.

Exit codes and their effect:

- 0: preview printed, or the run did its work. The last line says when more pairs remain.
- 2: usage error. 3: a precondition failed (no SSH answer, folder not found, no live build, incomplete listing, plan check failed, a kept pair is missing). Nothing changed.
- 8: the restart lock is held by a restart, a stage or another prune. Nothing changed. In a deploy, do not wait: the next deploy prunes. In the catch-up loop, follow its stop rules.
- 11: the lock file could not be opened or `flock` failed. Nothing changed.
- 13: partial or unknown: the rename, the delete or the check after it did not complete. Run `--apply` again. After a failed rename step the delete step still runs for renamed pairs.

Log: a run that reaches the rename step appends to `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-prune.log` on QuantVPS (best effort). Read it with `ssh quantvps 'tail -n 30 "${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-prune.log"'`. Line formats:

```text
<UTC time> delete <TS> <sha|none>                 a pair that this run renamed
<UTC time> finish <TS> none                       the second half of an interrupted rename
<UTC time> run renamed=<n> keep=<KEEP> rc=<0|1>   once per run that reached the rename step
```

Escalation: when the prune ends with exit code 3, 11 or 13 in two deploys in a row, or its summary shows more than 10 pairs over the keep count, the agent that runs the deploy opens or updates a card and says so in its deploy report. Then a person or an agent runs the catch-up loop: the design's "First deletion" steps 3 to 5 (before state, a keep-list check before each `--apply` run, the stop rules for exit 8, 13, 2, 3 and 11), inside the time window and with the deploy claim `deploy:quantvps-web` of steps 1 and 2. The loop ends when the summary line holds `over_after=0 leftover_folders=0`.

### Runtime tree backups

Every restart that swaps a new runtime tree in leaves one `.runtime-bak-<TS>/` in the checkout root on QuantVPS (see "Runtime tree"). `prune-runtime-backups.sh` keeps the newest 2 backups that hold a tree and deletes older ones, 1 per run (owner decision 2026-11-15, rule A; deletion approved 2026-11-16). Design: `docs/vertex-rebuild/designs/quantvps-runtime-backup-retention/design.md`.

```sh
infra/quantvps/prune-runtime-backups.sh           # preview: keep/delete lines and a summary; changes nothing
infra/quantvps/prune-runtime-backups.sh --apply   # rename and delete 1 backup of the plan
```

A backup is a directory `.runtime-bak-<TS>` with `COMPLETE`, without `UNDONE`, that still holds at least one unit of its `PATHS`. It is deleted in two steps, as for the build backups: under the restart lock (no wait) one remote call renames it to `.runtime-prune-<TS>`, which the unfinished-swap checks of the restart and stage scripts never look at; after the lock is released a second call deletes it with `nice` and `ionice -c3` and prints the seconds it took. A renamed folder of an interrupted run is deleted first and counts toward the limit of 1.

`--apply` renames and deletes nothing during US trading hours (Monday to Friday, 09:15 to 16:05 New York time; market holidays count as trading days) and when the time cannot be read or the New York zone data is missing: it prints `NOT PRUNED: US trading hours ...` and ends with exit 0, and the next deploy outside these hours prunes. The run stops with exit 3 and changes nothing while a swap is unfinished (see "Repair an unfinished runtime swap"). Never touched and listed as "not managed": `.runtime-failed-<now>/` folders (with their `du` size, which includes files shared by hard link), backups with `UNDONE`, and backups that a rollback emptied (every unit of `PATHS` moved back live). `.runtime-next/` is never listed. Names of another form, symlinks and files are listed as skip.

Exit codes are the same as for `prune-web-backups.sh` (0, 2, 3, 8, 11, 13, above). Log: `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-runtime-prune.log` on QuantVPS, one `<UTC time> delete <TS> <sha|none>` line per renamed backup and one `<UTC time> run renamed=<n> keep=2 rc=<0|1>` line per run that reached the rename step.

Escalation: when the runtime prune ends with exit code 3, 11 or 13 in two deploys in a row, or its summary shows more than 3 backups over the keep count, or one delete took more than 120 s (the `deleted <TS> (<n> s)` line; a run skipped in trading hours also prints the summary line), the agent that runs the deploy opens or updates a card and runs the catch-up loop of the design's "First deletion" (time window, claim, before state, a keep-list check before each run, stop rules). The loop ends when the summary line holds `over_after=0 leftover_folders=0`.

## Change the installed Caddyfile

`recreate-tailnet-proxies.sh` is the only writer of the proxy file on QuantVPS (2026-11-15, card `vertex-web-tailnet-caddyfile-template`). Do not edit the installed file by hand: change `infra/quantvps/Caddyfile`, merge, then run the script from that checkout.

| Path on QuantVPS | Content | In the container |
| --- | --- | --- |
| `/opt/vertex-web-tailnet/caddy/Caddyfile` | Byte-identical copy of the committed `Caddyfile`. The directory holds nothing else. | `/etc/caddy`, read-only directory mount |
| `/opt/vertex-web-tailnet/staging/` | The new copy while `caddy validate` checks it. Removed when the script ends. | no |
| `/opt/vertex-web-tailnet/Caddyfile.prev` | `--caddyfile-only`: the replaced file, until a reload has passed. It is present only after a run that stopped or failed. | no |
| `/opt/vertex-web-tailnet/Caddyfile.bak-<TS>-literal`, older `Caddyfile.bak-*` | Files of the old single-file mount. They have the host values as literal text. | no |
| `/etc/vertex/hosts.env` | The host values (see "Host config"). | environment (`--env-file`) |

The container mounts the directory, so a file that `mv` replaced is visible in the container (a single-file bind mount keeps the old inode). No file with literal host values is inside the mount.

```sh
infra/quantvps/recreate-tailnet-proxies.sh --caddyfile-only --dry-run   # print the remote program only
infra/quantvps/recreate-tailnet-proxies.sh --caddyfile-only             # check, install, reload; no container is removed
```

Steps of `--caddyfile-only` on QuantVPS:

1. Preconditions (exit 3, nothing changed): valid host values in `/etc/vertex/hosts.env`; `vertex-web-tailnet` is running, mounts the `caddy/` directory and has the same two host values in its environment; `caddy/Caddyfile` exists. A container in the old form, or a changed `hosts.env`, needs one full run of the script first (see the next section). The checks of the status proxy files and the tailscaled socket run in full mode only.
2. If the installed file differs from the committed one: write the committed file to `staging/` and run `caddy validate` on it in a temporary container (`--rm --network none`, image `caddy:2-alpine`, `--env-file /etc/vertex/hosts.env`; measured on QuantVPS on 2026-11-15: it passes for the committed file and fails for a broken file). Failure: exit 3, nothing changed. Then copy the installed file to `Caddyfile.prev` (unless an earlier run left one) and rename the new file into `caddy/`.
3. Run `caddy reload` in the container, also when the file did not change. A reload keeps the container, its start time and its listeners; long-lived connections (streams, WebSockets) through the proxy are closed. Caddy ignores a reload of a config that it already runs. The repeat matters after a run that stopped between the rename and the reload.
4. If the reload fails, Caddy keeps the old config; the script puts `Caddyfile.prev` back (the file of the config that still runs) and exits 7. After a good reload it removes `Caddyfile.prev`.

The script prints the SHA-256 of the file that it checked (`caddyfile checked: sha256=...`); compare it with `sha256sum infra/quantvps/Caddyfile` of the commit that you deploy. Run it from an up-to-date checkout of the deployed commit: it installs the `Caddyfile` of the working tree. The default mode without `--caddyfile-only` recreates both proxies (a few seconds of outage each), so type the flag in a web deploy.

Check the running config after a change. It must equal the dry render of the committed file (see "Host config"):

```sh
sudo curl -s --unix-socket /proc/$(docker inspect -f '{{.State.Pid}}' vertex-web-tailnet)/root/tmp/caddy-admin.sock http://localhost/config/ | jq -S .
```

Roll back a change: check out the earlier commit (or revert the change) and run `--caddyfile-only` again. After a good reload the script keeps no copy of a replaced file, because each installed file is a copy of a committed one.

## Tailnet proxies and the tailscaled socket

`vertex-web-tailnet` (port 3451) and `vertex-status-tailnet` (port 8443) get their TLS certificate from tailscaled through `/var/run/tailscale/tailscaled.sock`. On 2026-11-02 tailscaled restarted at 06:21Z. Both containers mounted the socket file, kept the old inode and failed every TLS handshake until a manual `docker restart` at about 13:10Z.

Fix: both containers mount the directory read-only (`-v /var/run/tailscale:/var/run/tailscale:ro`; a read-only mount still allows `connect()` on the socket, checked on QuantVPS with a throwaway container that got 200 from the local API). A directory mount alone is not enough: tailscaled uses `RuntimeDirectory=tailscale`, so systemd deletes and re-creates `/run/tailscale` at each restart. The drop-in `tailscaled-preserve-runtime-dir.conf` sets `RuntimeDirectoryPreserve=yes`; the directory then stays, and tailscaled re-creates only the socket inside it. A test on QuantVPS with a throwaway container confirmed both cases: a socket re-created in the same directory was visible in the container; a re-created directory was not.

```sh
infra/quantvps/recreate-tailnet-proxies.sh --dry-run   # print the remote program only
infra/quantvps/recreate-tailnet-proxies.sh             # check and install the Caddyfile, install drop-in, daemon-reload, recreate both proxies, check inodes
```

A full run first checks the committed `Caddyfile` with `caddy validate` (exit 3 and no change on failure), then installs it in `/opt/vertex-web-tailnet/caddy/` and starts `vertex-web-tailnet` with that directory mounted at `/etc/caddy`. Each proxy is down between its `docker rm` and `docker run` (a few seconds). A changed `Caddyfile` alone does not need a full run: use `--caddyfile-only`. A full run is needed after a change to the container flags or mounts in the script.

If the `docker run` of `vertex-web-tailnet` fails, or the new container is not running with restart count 0 after 3 seconds (exit 6), the script stops; `vertex-status-tailnet` is not touched, and a container that did not stay up is left in place for `docker logs`. On a server that was already in the directory form, roll back with the script: check out the earlier commit and do a full run. Only when the run failed on the first move to the directory form, start a container of the old form from the file with literal host values, which is then still `/opt/vertex-web-tailnet/Caddyfile` (after a successful move it is a `Caddyfile.bak-<TS>-literal`, which can be older than later committed proxy changes):

```sh
docker rm -f vertex-web-tailnet
docker run -d --name vertex-web-tailnet --restart unless-stopped --network host --read-only \
  --tmpfs /tmp --tmpfs /config --tmpfs /data --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -v /opt/vertex-web-tailnet/<literal file>:/etc/caddy/Caddyfile:ro \
  -v /var/run/tailscale:/var/run/tailscale:ro caddy:2-alpine
```

The script does not restart tailscaled, `vertex-web` or any trading container. Exit codes: 0 done (full mode: the inodes match); 2 usage error; 3 a precondition or the `caddy validate` check failed (nothing changed); 4 a container does not see the host socket inode; 5 the drop-in was written but systemd does not report it (containers unchanged); 6 a `docker run` failed or `vertex-web-tailnet` did not stay up, and that proxy is down; 7 (`--caddyfile-only`) `caddy reload` failed, Caddy keeps the old config and its file is back. Check after a tailscaled restart: `docker exec <container> stat -c %i /var/run/tailscale/tailscaled.sock` must equal `stat -c %i /var/run/tailscale/tailscaled.sock` on the host.

## Host config (`/etc/vertex/hosts.env`)

The committed templates name no real host. QuantVPS keeps the values in `/etc/vertex/hosts.env` (root, mode 0644, not in git; created 2026-11-05). The file has `KEY=value` lines without quotes, so that both `docker --env-file` and the scripts read it:

| Key | Value | Read by |
| --- | --- | --- |
| `VERTEX_TAILNET_HOST` | MagicDNS name of QuantVPS (`<name>.<tailnet>.ts.net`) | `Caddyfile` (`{$VERTEX_TAILNET_HOST}`) |
| `VERTEX_TAILNET_IPV4` | QuantVPS tailnet IPv4 (`100.x.y.z`) | `Caddyfile` (`{$VERTEX_TAILNET_IPV4}`), `exec-node/exec_node.py verify` (ibkr-monitor health URL) |
| `VERTEX_RIG_IPS` | the rig's tailnet IPv4 and IPv6, space separated | `install-history.sh`, `install-portfolio.sh`, `install-recovery.sh`, `status/install-tailnet.sh` (rig allow-list) |

Rules:

- `recreate-tailnet-proxies.sh` and the four install scripts stop before any change (exit 3) when a value is missing or malformed.
- `recreate-tailnet-proxies.sh` starts `vertex-web-tailnet` with `--env-file /etc/vertex/hosts.env`; Caddy fills the placeholders of the installed copy of the committed `Caddyfile` from these variables when it starts or reloads. After a change to `hosts.env`, do one full run of the script: a container keeps the values from its creation, and `--caddyfile-only` refuses (exit 3) while they differ. An unset value falls back to a name under the reserved `.invalid` domain, so Caddy cannot bind its listener; an empty value leaves the site without an address, so Caddy starts no listener. In both cases it serves nothing and never binds every interface.
- Dry render after a change to the file or the template (no container changes; `--network none`):

```sh
docker run --rm --network none --env-file /etc/vertex/hosts.env \
  -v "$PWD/infra/quantvps/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile
```

  On 2026-11-05 the adapted JSON of the template with this file was byte-identical to the adapted JSON of the installed `/opt/vertex-web-tailnet/Caddyfile`. On 2026-11-15, after the Content-Security-Policy line of the installed file got the `?` of the template, the adapted JSON of the template with this file, the adapted JSON of the installed file and the running config of the proxy were byte-identical.
