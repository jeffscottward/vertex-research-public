# Research lens data push (rig → QuantVPS)

Read-only JSON documents for the `/rotation-matrix` and `/deep-value` portal pages. Full data path, limits and rollback: [`docs/vertex-rebuild/research-lenses.md`](../../../docs/vertex-rebuild/research-lenses.md).

## Install

On dev-rig:

```sh
install -D -m 0755 push-research-lenses.sh ~/.local/share/vertex-research-lenses/push-research-lenses.sh
cp vertex-research-lenses-push.service vertex-research-lenses-push.path ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start vertex-research-lenses-push.service
systemctl --user enable --now vertex-research-lenses-push.path
```

On QuantVPS: add `Caddyfile.snippet` to `/opt/vertex-status/Caddyfile.tailnet` (back up the file first), reload Caddy with `docker exec vertex-status-tailnet caddy reload --config /etc/caddy/Caddyfile --address unix//tmp/caddy-admin.sock`, and set `VERTEX_RESEARCH_LENSES_URL` in the web app's private `.dev.vars`.

## Check

```sh
ssh quantvps 'ls -l /opt/vertex-status/private-v2/research-lenses/'
journalctl --user -u vertex-research-lenses-push.service -n 20
```
