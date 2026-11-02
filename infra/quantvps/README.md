# QuantVPS web app (`vertex-web.service`)

This folder runs the production build of the web app on QuantVPS:

- `vertex-web.service`: the systemd unit. It serves the prebuilt `dist/` folder of `apps/web` with `vite preview` on `127.0.0.1:3450`.
- `run-preview.mjs`: the runner that the unit starts. It checks the private bindings and needs `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json`.
- `Caddyfile`: the `vertex-web-tailnet` proxy. It serves `https://quant-vps-host.example-tailnet.ts.net:3451` on the tailnet only.
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

Only one waiter runs at a time (`flock` on `${XDG_STATE_HOME:-$HOME/.local/state}/vertex-web-restart.lock`, the same path for every caller). A second waiter does nothing and exits with code 8.

The container start-time baseline is taken after the idle wait, right before the restart, because the wait can cross the scheduled 03:00 UTC exec-node container restarts. Only containers in the baseline are compared. A changed start time, or a baseline container that is missing after the restart, sends one notice to #omp-alerts (exit 7). One-off `compose run` containers (`*-run-<hex>`) may vanish, and new containers are ignored. A failed start-time check after the restart also exits 7, without a notice.

Exit codes: 0 restarted and healthy; 2 usage error; 3 gate or probe failed, or the `vertex-web` start time did not change (no restart happened); 4 gave up while busy; 5 rolled back and healthy; 6 rollback failed and the web app is down, or the health check got no answer over ssh (state unknown, no rollback); 7 a container start time changed or could not be checked; 8 another waiter holds the lock. `--dry-run`: 0 idle, 10 busy.

### Idle signal

All of these must be true. The quiet window is 30 s (`VERTEX_RESTART_QUIET`).

- The last journal line of `vertex-web` is older than the quiet window. `vite preview` logs every completed request (`GET /path 200 OK (12ms)`).
- On every established TCP connection to port 3450 (`ss -tni`): no bytes are queued, and no data was sent or received inside the quiet window (`lastsnd`, `lastrcv`). Idle keep-alive connections from Caddy count as idle.
- No connection has an open request. A request still waits for its response (for example a slow database query) when data was received after the last data sent (`lastrcv` is smaller than `lastsnd`), or when a new connection received bytes and has sent none.
- The probe is complete: the `ss` output ends with an end marker. A failed or cut probe counts as busy.
- A unit that is not active has no request to protect. It counts as idle.

Limit: a streamed response that already sent some bytes and then stalls for longer than the quiet window, with no other traffic, reads as idle.

## Deploy a new web build

1. On the rig, build the merged SHA in a worktree: `pnpm install --frozen-lockfile && bun run build`.
2. On QuantVPS, keep a rollback copy in `apps/web`: `TS=$(date -u +%Y%m%dT%H%M%SZ); cp -a dist dist.bak-$TS && cp -a .wrangler .wrangler.bak-$TS`.
3. Copy `apps/web/dist/` and `apps/web/.wrangler/deploy/config.json` from the rig into that `apps/web/` (rsync over the `quantvps` alias). Copy both together.
4. Run `infra/quantvps/restart-when-idle.sh`. Its rollback source is the backup from step 2.
