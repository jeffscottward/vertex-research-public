# Rig status push (rig → QuantVPS): engine status and market context

Owner choice A, 2026-11-02 (card vertex-phases): the Vertex Engines view shows rig timer state only.
Card vertex-markets-gex-macro-news, 2026-11-03: the same route carries public market context (GEX, macro,
news) for the Market context view (`/markets`).

## What runs

| Where | Unit / file | Purpose |
| --- | --- | --- |
| rig (user) | `vertex-rig-push.timer` → `.service` | every 60 s runs `tick-runner vertex-rig-push ~/.local/share/vertex-engine-status/vertex-rig-push.steps` |
| rig | step `engine-status` (every run) | `collect.py`: engine timer state → `vertex-engine-status-v1` |
| rig | step `market-context` (every 300 s) | `market_context.py`: market-watch-bot `state/{gex,macro,news}.json` → `vertex-market-context-v1` |
| rig | `~/.ssh/vertex_engine_status_ed25519` | dedicated key, used only by the two steps above |
| QuantVPS | `/root/.ssh/authorized_keys` entry `command="/usr/local/sbin/vertex-engine-status-write",restrict` | the key can only replace one of two fixed files from stdin (max 256 KiB), chosen by the document's `schema`: `status.json` or `markets.json` |
| QuantVPS | `vertex-engine-status.service` | `python3 -m http.server` on **127.0.0.1:3462** only, `DynamicUser`, read-only directory `/var/lib/vertex-engine-status` |
| QuantVPS | `vertex-web` binding `ENGINE_STATUS_URL=http://127.0.0.1:3462` | `engines.status` reads `/status.json`; `marketContext.get` reads `/markets.json` (both operator-only oRPC) |

No new port is reachable from outside the VPS; the route reuses the existing rig → QuantVPS SSH path.

## Access listing

Every user of each resource on this route (checked 2026-11-03):

| Resource | Users | Access |
| --- | --- | --- |
| key `~/.ssh/vertex_engine_status_ed25519` (rig) | `vertex-rig-push.service` steps `engine-status` and `market-context` | push only; the forced command ignores the client command |
| forced command `vertex-engine-status-write` (QuantVPS) | the key above | writes `status.json` or `markets.json` in `/var/lib/vertex-engine-status`; rejects other documents |
| `/var/lib/vertex-engine-status` (QuantVPS, root 0755, files 0644) | the forced command (write), `vertex-engine-status.service` (read-only) | no other reader or writer |
| `127.0.0.1:3462` (QuantVPS loopback) | `vertex-web` (`engines.status`, `marketContext.get`) | GET of the two files; nothing listens on other interfaces |
| market-watch-bot `state/{gex,macro,news}.json` (rig) | `market-watch-gex`, `-macro`, `-news` (writers); `market_context.py` (read-only) | the push reads the files and never changes them |

## Data

- Engine status: per engine timer (`market-watch-*`, `crown-*`, `crowncopy-*`): timer active, service state,
  result, exit status, last run, last exit, next run. No logs, command lines, environment, descriptions or
  account data.
- Market context: public market data only. GEX index rows for SPY and QQQ (QuantData OI+IV estimate);
  FRED/EIA/BLS macro series, regime labels and the next BLS release dates; macro news themes and headlines
  (title, publisher, link, time, sentiment, materiality). Not copied: positions, stops, account values, the
  held/watchlist/re-entry symbol universe, per-symbol news and GEX, theme symbol lists, scorer costs.
  When a state file is missing or unreadable, the step pushes the other sections (the missing one is
  `null` and listed in `missing`) and then exits 1, so the failure counts toward the alert.

## Alerts

`tick-runner` (`~/Github/tools/self-healing-harness/bin/tick-runner`) counts failures per step. The third
consecutive failure of a step sends one `#omp-alerts` error through `omp-notify`; the next successful run of
that step sends one recovery notice. A run that never finishes counts as a runner failure with the same rule.
State: `~/.local/state/tick-runner/vertex-rig-push/`. Rerun one step:
`tick-runner vertex-rig-push ~/.local/share/vertex-engine-status/vertex-rig-push.steps --only market-context`.

`VERTEX_MARKET_CONTEXT_HOST` (default `quantvps`) selects the SSH host of the market-context step. A failure
test sets it to an unknown host in the user manager (`systemctl --user set-environment`) and unsets it after.

## Tests

`cd infra/rig/engine-status && python3 -m unittest test_collect test_market_context`

`fixtures/market-context.v1.json` is the collector output for the test inputs. The Python test compares it with
`collect_document()`, and `packages/api/src/market-context.test.ts` parses it with the API schema, so the two
sides cannot drift. After a schema change, regenerate it with
`MC_WRITE_FIXTURE=1 python3 -m unittest test_market_context`, format it with
`bunx --bun --no-install biome format --write infra/rig/engine-status/fixtures` and update both sides in the same commit.

## Install

Rig:

```sh
install -D -m 0755 infra/rig/engine-status/collect.py infra/rig/engine-status/market_context.py -t ~/.local/share/vertex-engine-status/
install -D -m 0644 infra/rig/engine-status/vertex-rig-push.steps -t ~/.local/share/vertex-engine-status/
install -D -m 0644 infra/rig/engine-status/vertex-rig-push.{service,timer} -t ~/.config/systemd/user/
ssh-keygen -t ed25519 -N '' -C vertex-engine-status-push -f ~/.ssh/vertex_engine_status_ed25519   # first install only
systemctl --user daemon-reload && systemctl --user enable --now vertex-rig-push.timer
```

Replaced units (before 2026-11-03): `systemctl --user disable --now vertex-engine-status-push.timer`, then
delete `~/.config/systemd/user/vertex-engine-status-push.{service,timer}`.

QuantVPS (root): install `infra/quantvps/engine-status/vertex-engine-status-write` to `/usr/local/sbin/`
(0755), create `/var/lib/vertex-engine-status` (0755), add the public key with the forced command above,
install and start `vertex-engine-status.service`.

## Remove

Rig: `systemctl --user disable --now vertex-rig-push.timer`; delete the key pair.
QuantVPS: delete the authorized_keys line, `systemctl disable --now vertex-engine-status`.
