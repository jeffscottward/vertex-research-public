# Vertex Research as an always-on local tool

Set up 2026-09-30. URL on the Mac: **<http://vertex.localhost/>**

## Path

Mac Chrome → `http://vertex.localhost` → Mac portless proxy (127.0.0.1:80, same one that serves `knowledge-base.localhost`) → Mac `127.0.0.1:3450` → SSH tunnel → rig `127.0.0.1:3450` (vinext dev) → rig Postgres `127.0.0.1:5433`.

Nothing listens on a LAN or public interface. All hops are loopback or the existing trusted SSH route.

## Units

| Host | Unit | Purpose |
| --- | --- | --- |
| rig | `vertex-postgres.service` (user, enabled) | PostgreSQL 18, `private/basic-postgres`, 127.0.0.1:5433 |
| rig | `vertex-web.service` (user, enabled) | `private/basic-app-named/run.mjs`, 127.0.0.1:3450, `APP_URL=http://vertex.localhost` |
| Mac | `vertex-rig-tunnel.service` (user, enabled) | `ssh -L 127.0.0.1:3450:127.0.0.1:3450 dev-rig`, BatchMode, StrictHostKeyChecking=yes, ExitOnForwardFailure |
| Mac | portless alias `vertex` → 3450 | in `~/.local/state/portless-kb-chat/routes.json` |

Rig has linger enabled, so rig units run at boot. Mac linger is off, so the tunnel starts at Mac login (same as the knowledge-base tunnel).

## App change

Plain-HTTP `http://*.localhost` (no port, no credentials) is accepted as the app origin only when `APP_ENV=development`. Test and production always require HTTPS. The rule is defined once in `isDevelopmentLocalhostHttpOrigin` (`packages/config/src/client.ts`) and used by every app-origin check: the env schema (`packages/config/src/server.ts` superRefine), `apps/web/src/app/layout.tsx`, `apps/web/src/lib/server-session.ts`, `apps/web/src/lib/dashboard-transport.ts` and `apps/web/src/lib/server-theme-api.ts`. The email package has no config dependency, so it mirrors the same rule in `packages/email/src/server/trusted-origin.ts` for reset and verification links; the Resend port passes `APP_ENV` to it. Browsers treat `*.localhost` as a secure context and resolve it to loopback. Vite named mode: `VERTEX_LOCAL_NAMED=1` in `apps/web/vite.config.ts` (allowedHosts `vertex.localhost`, HMR via port 80).

## Email

- The named instance sends real email through Resend (`EMAIL_TRANSPORT=resend`) with the send-only key reused from Glen Ross (`~/Github/glen-ross/os/.env`). `run.mjs` accepts this mode only with no preview bindings and redacts the key from logs.
- Sender: Resend's test sender `onboarding@resend.dev`, which delivers only to the Resend account owner's address. `glenrossmail.com` is NOT a verified domain in that account (Resend rejected it on 2026-10-04), so Glen Ross email with that sender also fails. For mail to other recipients, verify a domain you own (for example `vertex.xyz` on Cloudflare) in Resend and set `EMAIL_FROM` to an address on it.
- Backups of the named `.dev.vars` before each change: `private/basic-app-named/.dev.vars.before-*`.

## Limits

- Sessions are per origin: sign in once at `http://vertex.localhost`.
- vinext allows one dev server per app directory, so the old `https://localhost:3443` instance is stopped.
- `run.mjs` exits with code 1 when systemd stops it, so `systemctl --user stop vertex-web` leaves the unit in `failed`. This is cosmetic; the next start is clean.

## Operate

```sh
# rig
systemctl --user status vertex-postgres vertex-web
journalctl --user -u vertex-web -f
systemctl --user restart vertex-web     # if the dev server wedges
# mac
systemctl --user status vertex-rig-tunnel
```

## Roll back

```sh
# Mac
systemctl --user disable --now vertex-rig-tunnel.service
rm ~/.config/systemd/user/vertex-rig-tunnel.service; systemctl --user daemon-reload
PORTLESS_STATE_DIR=~/.local/state/portless-kb-chat PORTLESS_PORT=80 PORTLESS_HTTPS=0 portless alias --remove vertex
# rig
systemctl --user disable --now vertex-web.service vertex-postgres.service
rm ~/.config/systemd/user/vertex-{web,postgres}.service; systemctl --user daemon-reload
# then restore the old https://localhost:3443 stack (transient units; P=~/Github/trading/vertex-research-platform/private, N=~/.local/share/mise/installs/node/22.13.1/bin/node):
systemd-run --user --unit=vertex-basic-postgres -p Restart=on-failure $P/basic-postgres/runtime/usr/bin/postgres -D $P/basic-postgres/data -c config_file=$P/basic-postgres/config/postgresql.conf   # copy the exact ExecStart from vertex-postgres.service before deleting it
systemd-run --user --unit=vertex-local-web -p Restart=on-failure -p WorkingDirectory=$P/basic-app $N $P/basic-app/run.mjs
systemd-run --user --unit=vertex-email-preview -p Restart=on-failure -p WorkingDirectory=$P/basic-email-preview $N --experimental-strip-types --no-warnings $P/basic-email-preview/start-receiver.mjs
# Mac: restore the old forward
systemd-run --user --unit=vertex-local-app-forward -p Restart=on-failure /usr/bin/ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:3443:127.0.0.1:3443 dev-rig
```
