# QuantVPS exec node (`ibkr-nautilus-exec-node`)

The exec node is the Docker Compose project `ibkr-nautilus-exec-node` on QuantVPS: `ib-gateway`, `nautilus-trader` (always on, DISARMED unless the owner arms it), `watchdog`, `postgres`, `redis`, `portfolio-ui`, `caddy`, `uptime-kuma` and `netdata`. Until 2026-10-31 it ran from the vertex-quant checkout `/opt/vertex-quant`. Vertex Research now owns its definition, and the runtime root is `/opt/vertex-exec-node`.

## What this directory owns

| Path | Content |
| --- | --- |
| `runtime/` | Vertex-owned files placed into the runtime root: `docker-compose.yml`, `watchdog/`, the arm gate (`nautilus/arm_gate.py`, `nautilus/arm_cli.py`), the owner arm CLI (`runtime/scripts/nautilus-arm.sh`, run on the rig), the IBKR 2FA script with the IBKR-only readiness fix (`runtime/scripts/request-ibkr-2fa-until-ready.sh`, `runtime/scripts/ibkr_account_snapshot.py`), the account heartbeat (pm2 `vertex-ibkr-account-heartbeat`), the Nautilus down alert and their shell helpers. |
| `systemd/` | Units that name the runtime root: `vertex-nautilus-node`, `vertex-nautilus-health-alert` (+timer), `vertex-ibkr-snapshot-retention` (+timer), `vertex-quant-ibkr-gate-8am` (+timer, disabled; the switch keeps it disabled). |
| `consumers/` | `ibkr-monitor-forced-2fa.sh`, installed as `/opt/ibkr-monitor/forced-2fa.sh`, and `ibkr-monitor-forced-2fa.paused.sh`, which denies 2FA triggers while a switch or rollback runs. `../recovery/vertex_ibkr_recovery.py`, `../recovery/test_vertex_ibkr_recovery.py` and `../status/collect.py` are the other consumers. Each installed consumer must equal its bundle file with only the root path swapped; the switch refuses otherwise. |
| `frozen-manifest.sha256` | SHA-256 of every runtime file carried from `/opt/vertex-quant` (Nautilus node code, portfolio-ui and its build output, `src/`, other scripts), except state, `.env`, installed dependencies and caches. It is the live tree of 2026-10-31 (deploy commit `3511184` plus recorded live edits). Refresh it with `exec_node.py manifest`. |
| `exec_node.py` | `stage`, `gate`, `switch`, `verify`, `rollback`. |

Every file under `runtime/` equals its frozen bytes, with three documented exceptions that `test_exec_node.py` checks:

- `runtime/scripts/nautilus-arm.sh` and `runtime/scripts/nautilus_health_alert.py` differ only in the root path.
- `runtime/nautilus/ibkr_account.py` is the reader from vertex-quant commit `ef1b38b` (merged to its main). The live tree paired the new snapshot script with the old reader, so the snapshot failed with a `TypeError` and the IBKR-only readiness check could never pass. The new reader is a superset of the old one. It is used by the 2FA readiness snapshot and the portfolio-ui snapshot; the running Nautilus image is not rebuilt.
- `runtime/watchdog/watchdog.py` and `runtime/nautilus/arm_gate.py` carry the kill-switch safety fix (state-machine audit 2026-11-03). While `data/KILL_SWITCH` exists, the gate and the watchdog delete the owner arm record `data/nautilus/ARMED`, so removing the kill switch never re-arms the node; the owner must arm again. `arm_gate.py` also enforces the options-only, defined-risk order policy `options_only_defined_risk_v1` (owner rule 2026-11-04) in `place_order`: an armed node may only buy options or close/reduce a position held in the newest fresh account snapshot (`test_order_policy.py`). `test_arm_killswitch.py` tests the kill switch; `python-safety.test.ts` runs both Python tests in CI; `test_exec_node.py` pins both digests. They take effect when the watchdog and Nautilus containers are next rebuilt.
- `runtime/nautilus/run_live.py` has no trade-intent source (owner 2026-11-04, card remove-charan-signals). It no longer imports `nautilus/charan.py`, polls the CHARAN Discord signal feed or owns the CHARAN live order transmitter; a legacy `charan` config section and `CHARAN_*` variables are ignored. The node keeps health, IBKR connection state, the arm gate and protection. `test_no_signal_intake.py` checks the file; `test_exec_node.py` pins its digest. It takes effect only after the Nautilus image is rebuilt and the node restarted, which needs an owner-approved time.

## Invariants

- The compose project name stays `ibkr-nautilus-exec-node` (`name:` in the compose file, `-p` in every command). A new name would create empty named volumes and rename the containers and the network `ibkr-nautilus-exec-node_prototype` that `../history/resolve-gateway.sh` and `../portfolio/resolve-gateway.sh` name. The gate also checks the name each root resolves without `-p`, which the runtime scripts use.
- `gate` compares `docker compose config` of the old and new roots. It passes only when, after replacing the old root path with the new one, both configs are identical, and when the project, container, network, volume and image names are identical. It also requires that the running `ib-gateway` container's config hash equals the new root's hash. Every compose command of the switch and the rollback names the eight other services only, so compose never stops, recreates or converges `ib-gateway`: no IBKR re-login, no 2FA, and the same bridge IP for vertex-history and vertex-portfolio. The switch refuses to run without a passing gate.
- State is reused: `switch` renames `/opt/vertex-quant/data` (and `portfolio-ui/data`, which holds the portfolio-ui kill switch, when it exists) into `/opt/vertex-exec-node` with `os.rename` after the services that mount it stop. A rename never copies; it fails across filesystems, and the preflight checks that `data/` is not a mount and is on the same filesystem. Nothing is copied or reset.
- The Nautilus node stays DISARMED. The tool reads the arm state (`arm_cli status --json`) and never arms, never sends orders and never prints `.env` values, tokens or compose config values.

## Procedure (root on QuantVPS)

Copy `infra/quant-vps` to the host (for example `/opt/vertex-exec-node-bundle/<commit>/quant-vps`), then:

```sh
python3 exec-node/exec_node.py stage --commit <sha>    # builds /opt/vertex-exec-node; no service changes; rerunnable
python3 exec-node/exec_node.py gate                    # must print "ok": true
python3 exec-node/exec_node.py --dry-run switch        # prints the switch commands
python3 exec-node/exec_node.py switch                  # prints switchDir=/var/lib/vertex-exec-node/switch-<ts>
python3 exec-node/exec_node.py verify --switch-dir <switchDir> --wait 1200
python3 exec-node/exec_node.py rollback --switch-dir <switchDir>   # only when verify fails
```

`switch` first checks the preflight (old root still matches the manifest, new root staged, `.env` unchanged since staging, consumers without drift, no 2FA run in progress, Nautilus DISARMED) and the gate. It then stops `vertex-ibkr-recovery`, installs the paused forced command, stops the health alert timer and the heartbeat, stops and removes the eight non-gateway containers, renames the state, installs the units and consumers (keeping their file modes), runs `docker compose up -d --no-build` for the eight services from the new root, restarts `vertex-nautilus-node`, starts `vertex-ibkr-recovery`, re-creates the pm2 heartbeat from the new root and starts the alert timer again. Backups, the journal and stderr (mode 0600) stay in the switch directory. When a step fails, `switch` runs the rollback at once. `rollback` tolerates a partial switch: stop steps accept absent units and processes, and a state directory that is already back is left in place.

`verify` checks: all nine containers running and healthy, the eight recreated ones from the new root; the gateway container and network unchanged; IBKR account snapshot (the 2FA script with `--check-only`; skipped for the old root, whose reader is broken); vertex-portfolio `state=live`; ibkr-monitor `bridge=live`; Nautilus `armed=false`, no `ARMED` file and an unchanged `arm-audit.jsonl`; watchdog health; recovery health schema and script path; `vertex-nautilus-node`, the alert timer and recovery active; the 8am gate timer unchanged; the pm2 heartbeat online in the root; no live unit, cron entry, consumer or pm2 entry naming the other root.

Known gap: `vertex-quant-ibkr-gate-8am.service` runs the script open_ibkr_trading_gate_8am.sh, which does not exist in the live tree. Its timer is disabled, and the switch keeps it disabled.

## Switch record

The switch ran on 2026-11-01 at 03:00:02Z (23:00 ET on 2026-10-31) from bundle `1890fd02` (merged as `fa6dc142`). It took 32 seconds. `verify` passed all 18 checks at 03:21Z. The record is in `/var/lib/vertex-exec-node/switch-20261101T030002Z` on QuantVPS. The ib-gateway container was not recreated, so its compose labels still name `/opt/vertex-quant/docker-compose.yml`, and `docker compose ls` lists both files until the gateway is next recreated. The gateway mounts nothing from `/opt/vertex-quant`.

## Freeze

After a verified switch, vertex-quant gets a FROZEN banner. `/opt/vertex-quant` stays in place, untouched, as the rollback source for 7 days. After 7 stable days it is renamed to `/opt/vertex-quant-frozen-20261031`. Nothing on the host references it after the switch.
