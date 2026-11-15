# QuantVPS web app (`vertex-web.service`)

This folder runs the production build of the web app on QuantVPS:

- `vertex-web.service`: the systemd unit. It serves the prebuilt `dist/` folder of `apps/web` with `vite preview` on `127.0.0.1:3450`.
- `run-preview.mjs`: the runner that the unit starts. It checks the private bindings and needs `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json`.
- `Caddyfile`: the `vertex-web-tailnet` proxy. It serves `https://<VERTEX_TAILNET_HOST>:3451` on the tailnet only. The host values come from the server (see "Host config" below).
- `recreate-tailnet-proxies.sh`: recreates `vertex-web-tailnet` and `vertex-status-tailnet` with the tailscaled socket directory mount (see below).
- `tailscaled-preserve-runtime-dir.conf`: the tailscaled drop-in that keeps `/run/tailscale` across tailscaled restarts.
- `restart-when-idle.sh`: **the only restart route for `vertex-web`**. Do not run `systemctl restart vertex-web` directly.
- `stage-runtime.sh`: copies the runtime tree of a build commit (tracked files and `node_modules`) next to the live one on QuantVPS. The restart script moves it into place (see "Runtime tree").

## Restart route

Run the script on the rig from a checkout of this repository. It reaches QuantVPS through the `quantvps` SSH alias.

```sh
infra/quantvps/restart-when-idle.sh --dry-run   # print the idle decision only; exit 0 = idle, 10 = busy
infra/quantvps/restart-when-idle.sh             # wait until idle, restart, check health, roll back on failure
```

The script restarts only `vertex-web`. It never starts, stops or restarts Nautilus, the IB gateway, the exec node, the recovery bridge, Docker or any container. After a restart it compares every container start time with the values before the restart and prints `protected containers: start times unchanged`.

Steps:

1. Gate: the build output (`dist/server/wrangler.json` and `.wrangler/deploy/config.json`) and a rollback source (`dist.bak-<TS>` with `.wrangler.bak-<TS>`, where `<TS>` has the form `20261101T125501Z`) must exist in `apps/web` on QuantVPS. If not, the script does not restart (exit 3).
2. Wait until `vertex-web` is idle on two polls in a row (default every 5 s).
3. Restart the unit. Then wait up to 120 s (wall clock) for this health result: `/` returns 200 and `/dashboard` returns 307 to `/sign-in`.
4. If the health check fails, move the failed build to `dist.failed-<now>` and `.wrangler.failed-<now>`, copy the newest backup pair (or `--backup <TS>`) into place, restart and check health again. The script deletes nothing. Send one notice to #omp-alerts (exit 5 when the rollback is healthy, exit 6 when it is not).
5. If the waiter has not seen two idle polls in a row 60 min (wall clock, `VERTEX_RESTART_GIVE_UP_AFTER` in seconds) after the first busy poll, give up with one notice to #omp-alerts (exit 4). There is no forced restart.

Only one waiter runs at a time (`flock` on `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock`, the same path for every caller). A second waiter does nothing and exits with code 8. Only a held lock gives exit 8. When the lock file cannot be opened (for example a full disk, no permission, or a directory at that path) or `flock` fails in another way, the script prints `NOT RESTARTED: cannot open lock file <path>: <reason>` (or `cannot lock <path> (flock exit <n>)`), does nothing and exits with code 11. Treat exit 11 as a failed run: fix the cause, then run the script again.

The container start-time baseline is taken after the idle wait, right before the restart, because the wait can cross the scheduled 03:00 UTC exec-node container restarts. Only containers in the baseline are compared. A changed start time, or a baseline container that is missing after the restart, sends one notice to #omp-alerts (exit 7). One-off `compose run` containers (`*-run-<hex>`) may vanish, and new containers are ignored. A failed start-time check after the restart also exits 7, without a notice.

Exit codes: 0 restarted and healthy; 2 usage error; 3 gate or probe failed, or the `vertex-web` start time did not change (no restart happened); 4 gave up while busy; 5 rolled back and healthy; 6 rollback failed and the web app is down, or the health check got no answer over ssh (state unknown, no rollback); 7 a container start time changed or could not be checked; 8 another waiter holds the lock; 9 the version guard refused the build; 11 the lock file could not be opened or `flock` failed (no restart happened); 12 the runtime guard refused (see "Runtime tree"). `--dry-run`: 0 idle, 10 busy.

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
2. On QuantVPS, keep a rollback copy in `apps/web`: `TS=$(date -u +%Y%m%dT%H%M%SZ); cp -a dist dist.bak-$TS && cp -a .wrangler .wrangler.bak-$TS`. The backup keeps its own `DEPLOYED_SHA`.
3. Copy `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json` from the rig into that `apps/web/` (rsync over the `quantvps` alias). Copy both together.
4. In the build worktree of step 1, run `infra/quantvps/stage-runtime.sh`. It stages the runtime tree of the build commit in `.runtime-next/` on QuantVPS and changes no live file (see "Runtime tree"). It must run in the build worktree, because only that worktree holds the installed packages of the build commit; this is why the restart script does not call it.
5. Run `infra/quantvps/restart-when-idle.sh` from an up-to-date rig checkout (`git fetch` first). Its rollback source is the backup from step 2. It swaps the staged runtime tree in with the restart. Exit 12 means that step 4 is missing for this build.
6. If `git diff <deployed SHA> <new SHA> -- infra/quantvps/Caddyfile` is not empty, also do "Change the installed Caddyfile". The web deploy does not copy the proxy file.
7. After the restart, check one page response through the proxy: `content-security-policy` must contain `script-src 'self' 'nonce-`.

Host values (2026-11-05, public repository): the committed tree names no real host. The real values are server-side config on QuantVPS and never committed: `run-preview.mjs` takes the tailnet origin from `APP_URL` in `private/basic-app-named/.prod.vars`, and the research fetch User-Agent takes its contact from `VERTEX_RESEARCH_CONTACT_EMAIL`. The proxy and install scripts read `/etc/vertex/hosts.env` (see "Host config"). Copy by hand only `apps/web/dist/` and `.wrangler/deploy/config.json`. Do not copy the committed unit or Caddyfile over the installed ones (`/etc/systemd/system/vertex-web.service` and `/opt/vertex-web-tailnet/Caddyfile`; the copies in the checkout are not the installed files). The runner `run-preview.mjs` is part of the runtime tree since 2026-11-15: `stage-runtime.sh` brings the committed runner with every build, so a server-side edit of it does not survive the next deploy.

Version guard across repositories: when the deployed SHA comes from another repository (the first public deploy after private `c328e600`), fetch that repository into the rig checkout so both commits exist in one git directory, for example `git fetch <private-checkout> <deployed-sha>`. Unrelated histories count as diverged, so the guard passes; set `VERTEX_DEPLOY_GIT_DIR` to use another checkout.

Version guard (added 2026-11-03 after 97fc8803, an ancestor of the live 99c1e1b1, was deployed and removed #163 and #165): before the idle wait, the script reads the new SHA from `dist/DEPLOYED_SHA` and the deployed SHA from `DEPLOYED_SHA` in `apps/web` on QuantVPS. It stops with exit 9 and no restart when the new SHA is a strict ancestor of the deployed SHA, when either SHA is unknown, or when the rig checkout does not contain both commits. An equal SHA or a newer or diverged SHA passes. After a healthy restart the script writes the checked SHA to `DEPLOYED_SHA` in `apps/web`, only while `dist/DEPLOYED_SHA` still holds it; after a rollback it records the restored build's SHA. On exit 9 the refused build is still in `dist`: restore the step-2 backup at once, so a crash restart cannot serve it. For a deliberate rollback, or the first deploy before `DEPLOYED_SHA` in `apps/web` exists, pass `--allow-older "<reason>"`; the script prints the warning and the reason. `--dry-run` prints what the guard would decide.

## Runtime tree

The checkout on QuantVPS is a plain copy of the repository tree, without `.git` and without a package store. `vertex-web` reads more than the build output from it: the runner, `apps/web/vite.config.ts`, `apps/web/src/proxy.ts`, `package.json` files of workspace packages and the installed packages (measured from file access times on 2026-11-15). Until 2026-11-15 no deploy step updated these files, so the web app ran a new build on packages of 2026-10-21 (card `quantvps-checkout-seroval-node-modules`).

- **Runtime tree:** every tracked file of the build commit, and `node_modules` of the root and of each workspace package. `RUNTIME_SHA` in the checkout root names the commit.
- **Server-side state:** `private/`, and in `apps/web` the build output (`dist`, `.wrangler`), its backups, `DEPLOYED_SHA`, `.next` and `.vinext`. No stage or swap touches these. Keep server-only files only there: an untracked file in any other tracked directory moves to the backup directory with the next swap.
- **Stage** (`stage-runtime.sh`, deploy step 4): it runs on the rig in the build worktree and holds the restart lock. It refuses a worktree with changed tracked files, an unfinished earlier swap, and less than 5 GiB free on QuantVPS (`VERTEX_RUNTIME_MIN_FREE_KB`). It copies the tree to `.runtime-next/` in the checkout; a file with the same content as the live file becomes a hard link. It starts the staged `vite` and `workerd` with `--version`. It writes `PATHS` (the swap units) and then `RUNTIME_SHA`; a stage without `RUNTIME_SHA` is incomplete. Exit codes: 0 staged; 2 usage; 3 refused before any copy; 4 program check failed; 5 copy failed; 8 the restart lock is held; 11 lock file error.
- **Runtime guard** (in `restart-when-idle.sh`, after the version guard): `RUNTIME_SHA` equals the new build SHA: plain restart. A complete stage for the new build SHA exists: the restart swaps it in. Anything else stops the run with exit 12: another commit with no stage, no answer over ssh, an unknown build SHA, or an unfinished swap.
- **Swap:** one remote command moves each path in `PATHS` from the checkout to `.runtime-bak-<TS>/`, moves the staged path into its place and restarts the unit. A failed move puts the finished paths back and the directory gets an `UNDONE` file; the restart command is then not sent, the old process keeps serving, and the run ends with exit 3.
- **Rollback:** when the health check fails after a swap, the rollback command first moves the new tree to `.runtime-failed-<now>/` and the saved tree back, and then restores the build output as before. With no health answer over ssh (exit 6) nothing is rolled back; the alert names the swapped tree and its backup. The runtime rollback pairs with the build backup of the same deploy (step 2). With an older `--backup <TS>` the web app runs an older build on the previous runtime tree until the next run, whose guard reports the difference.
- **Override:** `--allow-stale-runtime <reason>` restarts although the runtime tree is at another commit, for an urgent restart while a stage is refused (for example by the free-space gate). It sends the reason to `#omp-alerts`. It does not skip the "no answer" and "unfinished swap" refusals.
- **Disk:** `.runtime-bak-<TS>/` and `.runtime-failed-<now>/` are never deleted by a script. Unchanged files share their data with the live tree through hard links, so one backup costs about the size of the changed packages. Do not edit a file of the runtime tree in place on the server: the edit would also change the backup, and the next swap replaces the file anyway. When the free-space gate refuses a stage, web deploys stop until old backups are removed; removal needs an owner decision.

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

After either repair, `cat RUNTIME_SHA` in the checkout must show the previous commit. Run `infra/quantvps/restart-when-idle.sh --dry-run` and check the `runtime:` lines. The build output is a separate matter: when `dist` in `apps/web` holds a newer build than the runtime tree, the next run swaps the stage in again (swap in) or needs the build backup restored (swap back; see deploy step 2).

## Change the installed Caddyfile

The installed proxy file is `/opt/vertex-web-tailnet/Caddyfile` on QuantVPS. The web deploy never copies it. On 2026-11-15 it had the host values as literal text, and the running `vertex-web-tailnet` container had no `VERTEX_*` variable (`docker exec vertex-web-tailnet env`). Until card `vertex-web-tailnet-caddyfile-template` moves it to the template form, change it by hand:

1. Make the same edit in a copy of the installed file. Do not copy the committed template over it: without the variables, `caddy reload` adapts the template with the `.invalid` fallback names and fails.
2. Back up next to the file (`Caddyfile.bak-<TS>`). Dry render the installed file and the new file with the image of the running container (see "Host config"; a file with literal host values needs no `--env-file`) and compare the JSON (`jq -S`, `diff`): only the intended change may differ, and the new file must give the same JSON as the committed template with `--env-file /etc/vertex/hosts.env`.
3. Write the new content into the existing file: `sudo sh -c 'cat /tmp/Caddyfile.new > /opt/vertex-web-tailnet/Caddyfile'`. The container bind-mounts this single file. A replace by `mv`, `cp` to a new file or `sed -i` makes a new inode; the container then keeps the old file, and `caddy reload` loads the old config with no error.
4. Check inside the container that it sees the new content (`docker exec vertex-web-tailnet sha256sum /etc/caddy/Caddyfile`), then reload only this proxy: `docker exec vertex-web-tailnet caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock`. A reload keeps the container and its start time. A failed reload keeps the old config.
5. Check the running config: `sudo curl -s --unix-socket /proc/$(docker inspect -f '{{.State.Pid}}' vertex-web-tailnet)/root/tmp/caddy-admin.sock http://localhost/config/ | jq -S .` must equal the dry render of the new file.

Roll back: write the backup into the same file (`cat Caddyfile.bak-<TS> > Caddyfile`), then repeat steps 4 and 5.

## Tailnet proxies and the tailscaled socket

`vertex-web-tailnet` (port 3451) and `vertex-status-tailnet` (port 8443) get their TLS certificate from tailscaled through `/var/run/tailscale/tailscaled.sock`. On 2026-11-02 tailscaled restarted at 06:21Z. Both containers mounted the socket file, kept the old inode and failed every TLS handshake until a manual `docker restart` at about 13:10Z.

Fix: both containers mount the directory read-only (`-v /var/run/tailscale:/var/run/tailscale:ro`; a read-only mount still allows `connect()` on the socket, checked on QuantVPS with a throwaway container that got 200 from the local API). A directory mount alone is not enough: tailscaled uses `RuntimeDirectory=tailscale`, so systemd deletes and re-creates `/run/tailscale` at each restart. The drop-in `tailscaled-preserve-runtime-dir.conf` sets `RuntimeDirectoryPreserve=yes`; the directory then stays, and tailscaled re-creates only the socket inside it. A test on QuantVPS with a throwaway container confirmed both cases: a socket re-created in the same directory was visible in the container; a re-created directory was not.

```sh
infra/quantvps/recreate-tailnet-proxies.sh --dry-run   # print the remote program only
infra/quantvps/recreate-tailnet-proxies.sh             # install drop-in, daemon-reload, recreate both proxies, check inodes
```

The script does not restart tailscaled, `vertex-web` or any trading container. Exit codes: 0 done and inodes match; 2 usage error; 3 precondition failed (nothing changed); 4 a container does not see the host socket inode; 5 the drop-in was written but systemd does not report it (containers unchanged); 6 a `docker run` failed and that proxy is down. Check after a tailscaled restart: `docker exec <container> stat -c %i /var/run/tailscale/tailscaled.sock` must equal `stat -c %i /var/run/tailscale/tailscaled.sock` on the host.

## Host config (`/etc/vertex/hosts.env`)

The committed templates name no real host. QuantVPS keeps the values in `/etc/vertex/hosts.env` (root, mode 0644, not in git; created 2026-11-05). The file has `KEY=value` lines without quotes, so that both `docker --env-file` and the scripts read it:

| Key | Value | Read by |
| --- | --- | --- |
| `VERTEX_TAILNET_HOST` | MagicDNS name of QuantVPS (`<name>.<tailnet>.ts.net`) | `Caddyfile` (`{$VERTEX_TAILNET_HOST}`) |
| `VERTEX_TAILNET_IPV4` | QuantVPS tailnet IPv4 (`100.x.y.z`) | `Caddyfile` (`{$VERTEX_TAILNET_IPV4}`), `exec-node/exec_node.py verify` (ibkr-monitor health URL) |
| `VERTEX_RIG_IPS` | the rig's tailnet IPv4 and IPv6, space separated | `install-history.sh`, `install-portfolio.sh`, `install-recovery.sh`, `status/install-tailnet.sh` (rig allow-list) |

Rules:

- `recreate-tailnet-proxies.sh` and the four install scripts stop before any change (exit 3) when a value is missing or malformed.
- A `vertex-web-tailnet` container that `recreate-tailnet-proxies.sh` created gets the file with `--env-file /etc/vertex/hosts.env`. On 2026-11-15 the running container (created 2026-11-07) had no `VERTEX_*` variable, and the installed file had the host values as literal text (see "Change the installed Caddyfile"). An unset value falls back to a name under the reserved `.invalid` domain, so Caddy cannot bind its listener; an empty value leaves the site without an address, so Caddy starts no listener. In both cases it serves nothing and never binds every interface.
- Dry render after a change to the file or the template (no container changes; `--network none`):

```sh
docker run --rm --network none --env-file /etc/vertex/hosts.env \
  -v "$PWD/infra/quantvps/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile
```

  On 2026-11-05 the adapted JSON of the template with this file was byte-identical to the adapted JSON of the installed `/opt/vertex-web-tailnet/Caddyfile`. On 2026-11-15, after the Content-Security-Policy line of the installed file got the `?` of the template, the adapted JSON of the template with this file, the adapted JSON of the installed file and the running config of the proxy were byte-identical.
