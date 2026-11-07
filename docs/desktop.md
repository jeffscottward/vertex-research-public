# Desktop shell

`apps/desktop` (`@darkfactory/desktop`) is an Electron app that wraps the live Vertex site (LuxAlgo gap P8). It adds three things the browser cannot do on its own:

- **One window per workspace.** Dashboard, Charts, Watchlist, Alerts, Calendar, Journal, News, Markets and Quant each open in their own native window (Workspaces menu, Ctrl/Cmd+1..9). Opening a workspace that is already open focuses its window. The shell remembers each window's size and position and which windows were open at quit.
- **Tray (menu-bar) watchlist.** The tray menu lists the signed-in user's watchlist (first 15 symbols) with the last daily close, the change from the close before it and an "in buy zone" mark. It refreshes every 10 minutes. Clicking a symbol opens its chart. Prices come from `marketData.bars` with the same request the Watchlist page makes, so both share the server's bars cache. Users who cannot read bars see the symbols without prices.
- **Native alert notifications.** The shell polls `priceAlerts.signals.events` every minute and shows an OS notification when signal alerts fire after it started. No Alerts tab has to be open. Fires up to a minute before the start still count, to allow for clock skew. A fire the server commits more than 5 minutes behind the newest one already seen is not notified, but the Alerts page still lists it. The notification text is the same fixed text as on the web page, so symbol names and prices stay off the lock screen. Clicking it opens Alerts. The tray's "Send test notification" item checks that the OS shows notifications.

The shell is for research display only. The tray and menus contain no order, arm, disarm or risk controls, and every API call the shell makes itself is a read (oRPC GET).

## Why Electron, not Tauri

Electron fits this repo better:

- The repo is TypeScript and pnpm only. Electron needs no Rust toolchain in CI and no WebKitGTK or appindicator system libraries.
- The main process imports the typed oRPC contract (`@darkfactory/api/client`) directly.
- `session.fetch` sends the window session's sign-in cookie, so one sign-in covers the windows, the tray and the notifier.
- Tray, notifications and single-instance handling behave the same on macOS, Windows and Linux (StatusNotifierItem and libnotify).

The cost is a larger download (about 100 MB for Electron against a few MB for a Tauri build). CI never downloads Electron: `pnpm-workspace.yaml` sets `allowBuilds.electron: false`, and the unit tests mock the `electron` module.

## Run it

```sh
pnpm --filter @darkfactory/desktop electron:install   # once: fetch the Electron binary
pnpm --filter @darkfactory/desktop build              # bundle src/main.ts into dist/main.js
VERTEX_DESKTOP_URL=https://your-vertex-host pnpm --filter @darkfactory/desktop start
```

The site comes from `--url=<origin>`, then `VERTEX_DESKTOP_URL`, then the origin saved from the last start. The origin in use is saved at every start, so a later launch without a flag opens the same site. The repo ships no host. The shell accepts only `https` origins, or `http` on loopback for development (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`). Sign in inside any window. The session is stored in the persistent `persist:vertex` partition.

On a headless Linux host, keep the shell off the real desktop. Unset `WAYLAND_DISPLAY`, pass `--ozone-platform=x11` and run it under `xvfb-run`.

## Security

| Rule | Where |
| --- | --- |
| Windows run with `contextIsolation`, `sandbox`, no Node integration and web security on; there is no preload | `src/electron-ports.ts` |
| Same-origin navigation stays in the app; other http(s) links open in the system browser; other schemes are blocked | `src/site-url.ts` `classifyNavigation` |
| No page can open a new window. A same-site workspace link opens or focuses that workspace's window; another same-site link loads in the current window; other http(s) links go to the system browser, at most one per second | `src/electron-ports.ts`, `src/app.ts` |
| The page may only write the clipboard and go fullscreen; it gets no web notification permission, because the shell delivers notifications itself | `GRANTED_PERMISSIONS` |
| Downloads use Electron's default Save dialog | Electron default |
| Settings (site origin, open windows, bounds) are written with mode 0600 and replaced atomically; each field is read on its own, so one bad entry never drops the saved site | `src/settings.ts` |

## Layout

| File | Role |
| --- | --- |
| `src/main.ts` | Entry: single-instance lock, then `startDesktop` |
| `src/app.ts` | Composition root over the ports |
| `src/electron-ports.ts` | The only Electron adapter |
| `src/window-manager.ts` | One window per workspace, restore and bounds |
| `src/tray-watchlist.ts` | Tray menu model and refresh loop |
| `src/alert-notifier.ts` | Signal alert polling and notifications |
| `src/desktop-api.ts` | Read-only oRPC calls (GET) |
