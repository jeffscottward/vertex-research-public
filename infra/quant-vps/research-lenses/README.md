# Research lens data jobs and push (rig → QuantVPS)

Read-only JSON documents for the `/rotation-matrix` and `/deep-value` portal pages. The collectors are `scripts/research-lenses/`. Full data path, limits and rollback: [`docs/vertex-rebuild/research-lenses.md`](../../../docs/vertex-rebuild/research-lenses.md).

| File | Role |
| --- | --- |
| `vertex-research-lenses-fetch` | ExecStartPre: exports `scripts/research-lenses` from `origin/vertex/rebuild-darkfactory-20260921` into `~/.local/share/vertex-research-lenses/app` |
| `vertex-rotation-matrix.{service,timer}` | Rotation matrix job (weekdays 16:40 and 18:30 New York time, at boot) |
| `vertex-deep-value.{service,timer}` | Deep value job (weekdays 16:55 and 18:50 New York time, at boot), runs after the rotation matrix job and reads its document |
| `push-research-lenses.sh`, `vertex-research-lenses-push.{service,path}` | Push each `latest.json` to QuantVPS when it changes |

## Install

On dev-rig (needs a clone of this repo at `~/Github/trading/vertex-research-public` and bun 1.4.2 from mise):

```sh
install -D -m 0755 vertex-research-lenses-fetch ~/.local/bin/vertex-research-lenses-fetch
install -D -m 0755 push-research-lenses.sh ~/.local/share/vertex-research-lenses/push-research-lenses.sh
cp vertex-rotation-matrix.service vertex-rotation-matrix.timer vertex-deep-value.service vertex-deep-value.timer \
  vertex-research-lenses-push.service vertex-research-lenses-push.path ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vertex-research-lenses-push.path vertex-rotation-matrix.timer vertex-deep-value.timer
```

Optional `~/.config/vertex/research-lenses.env`: `VERTEX_RESEARCH_CONTACT_EMAIL` (SEC User-Agent contact) and `LENSES_BRANCH` (branch override).

On QuantVPS the route is `@lens_caller` in `infra/quant-vps/status/Caddyfile.tailnet`; the install scripts that render that template keep it. Set `VERTEX_RESEARCH_LENSES_URL` in the web app's private `.dev.vars`.

## Check

```sh
systemctl --user start vertex-rotation-matrix.service vertex-deep-value.service
journalctl --user -u vertex-rotation-matrix.service -u vertex-deep-value.service -u vertex-research-lenses-push.service -n 30
ssh quantvps 'ls -l /opt/vertex-status/private-v2/research-lenses/'
```
