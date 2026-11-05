# QuantVPS web app (`vertex-web.service`)

This folder runs the production build of the web app on QuantVPS:

- `vertex-web.service`: the systemd unit. It serves the prebuilt `dist/` folder of `apps/web` with `vite preview` on `127.0.0.1:3450`.
- `run-preview.mjs`: the runner that the unit starts. It checks the private bindings and needs `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json`.
- `Caddyfile`: the `vertex-web-tailnet` proxy. It serves `https://<VERTEX_TAILNET_HOST>:3451` on the tailnet only. The host values come from the server (see "Host config" below).
- `recreate-tailnet-proxies.sh`: recreates `vertex-web-tailnet` and `vertex-status-tailnet` with the tailscaled socket directory mount (see below).
- `tailscaled-preserve-runtime-dir.conf`: the tailscaled drop-in that keeps `/run/tailscale` across tailscaled restarts.
- `restart-when-idle.sh`: **the only restart route for `vertex-web`**. Do not run `systemctl restart vertex-web` directly.

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

Exit codes: 0 restarted and healthy; 2 usage error; 3 gate or probe failed, or the `vertex-web` start time did not change (no restart happened); 4 gave up while busy; 5 rolled back and healthy; 6 rollback failed and the web app is down, or the health check got no answer over ssh (state unknown, no rollback); 7 a container start time changed or could not be checked; 8 another waiter holds the lock; 9 the version guard refused the build; 11 the lock file could not be opened or `flock` failed (no restart happened). `--dry-run`: 0 idle, 10 busy.

### Idle signal

All of these must be true. The quiet window is 30 s (`VERTEX_RESTART_QUIET`).

- The last journal line of `vertex-web` is older than the quiet window. `vite preview` logs every completed request (`GET /path 200 OK (12ms)`).
- On every established TCP connection to port 3450 (`ss -tni`): no bytes are queued, and no data was sent or received inside the quiet window (`lastsnd`, `lastrcv`). Idle keep-alive connections from Caddy count as idle.
- No connection has an open request. A request still waits for its response (for example a slow database query) when data was received after the last data sent (`lastrcv` is smaller than `lastsnd`), or when a new connection received bytes and has sent none.
- The probe is complete: the `ss` output ends with an end marker. A failed or cut probe counts as busy.
- A unit that is not active has no request to protect. It counts as idle.

Limit: a streamed response that already sent some bytes and then stalls for longer than the quiet window, with no other traffic, reads as idle.

Clients that poll `vertex-web` must leave gaps longer than the quiet window plus one poll (35 s), or the app never reads as idle. The Nautilus backtest worker on the rig waits up to 40 s between empty claims for this reason (`VERTEX_WORKER_IDLE_MAX_MS`, [infra/research-worker/README.md](../research-worker/README.md#request-budget)); changing the quiet window or that cap needs the other one checked.

## Deploy a new web build

1. On the rig, build the merged SHA in a worktree: `pnpm install --frozen-lockfile && bun run build`, then record it: `git rev-parse HEAD > apps/web/dist/DEPLOYED_SHA`.
2. On QuantVPS, keep a rollback copy in `apps/web`: `TS=$(date -u +%Y%m%dT%H%M%SZ); cp -a dist dist.bak-$TS && cp -a .wrangler .wrangler.bak-$TS`. The backup keeps its own `DEPLOYED_SHA`.
3. Copy `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json` from the rig into that `apps/web/` (rsync over the `quantvps` alias). Copy both together.
4. Run `infra/quantvps/restart-when-idle.sh` from an up-to-date rig checkout (`git fetch` first). Its rollback source is the backup from step 2.

Host values (2026-11-05, public repository): the committed tree names no real host. The real values are server-side config on QuantVPS and never committed: `run-preview.mjs` takes the tailnet origin from `APP_URL` in `private/basic-app-named/.prod.vars`, and the research fetch User-Agent takes its contact from `VERTEX_RESEARCH_CONTACT_EMAIL`. The proxy and install scripts read `/etc/vertex/hosts.env` (see "Host config"). Deploy only `apps/web/dist/` and `.wrangler/deploy/config.json`; do not copy the committed unit, Caddyfile or runner over the installed ones.

Version guard across repositories: when the deployed SHA comes from another repository (the first public deploy after private `c328e600`), fetch that repository into the rig checkout so both commits exist in one git directory, for example `git fetch <private-checkout> <deployed-sha>`. Unrelated histories count as diverged, so the guard passes; set `VERTEX_DEPLOY_GIT_DIR` to use another checkout.

Version guard (added 2026-11-03 after 97fc8803, an ancestor of the live 99c1e1b1, was deployed and removed #163 and #165): before the idle wait, the script reads the new SHA from `dist/DEPLOYED_SHA` and the deployed SHA from `DEPLOYED_SHA` in `apps/web` on QuantVPS. It stops with exit 9 and no restart when the new SHA is a strict ancestor of the deployed SHA, when either SHA is unknown, or when the rig checkout does not contain both commits. An equal SHA or a newer or diverged SHA passes. After a healthy restart the script writes the checked SHA to `DEPLOYED_SHA` in `apps/web`, only while `dist/DEPLOYED_SHA` still holds it; after a rollback it records the restored build's SHA. On exit 9 the refused build is still in `dist`: restore the step-2 backup at once, so a crash restart cannot serve it. For a deliberate rollback, or the first deploy before `DEPLOYED_SHA` in `apps/web` exists, pass `--allow-older "<reason>"`; the script prints the warning and the reason. `--dry-run` prints what the guard would decide.

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
- The `vertex-web-tailnet` container gets the file with `--env-file /etc/vertex/hosts.env`. An unset value falls back to a name under the reserved `.invalid` domain, so Caddy cannot bind its listener; an empty value leaves the site without an address, so Caddy starts no listener. In both cases it serves nothing and never binds every interface.
- Dry render after a change to the file or the template (no container changes; `--network none`):

```sh
docker run --rm --network none --env-file /etc/vertex/hosts.env \
  -v "$PWD/infra/quantvps/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile
```

  On 2026-11-05 the adapted JSON of the template with this file was byte-identical to the adapted JSON of the installed `/opt/vertex-web-tailnet/Caddyfile`.
