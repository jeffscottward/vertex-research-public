# UI lab

The UI lab is a component browser for layout review. Route `/lab` lists one entry per portal page. Route `/lab/<id>` renders that page's real workspace component with fake gateways and dummy data, inside a portal-like frame (same sidebar groups and inset as the portal). Screenshots of a lab entry look like the real page, without a session, a database or live services.

## Safety rules

- `/lab` returns 404 unless `VERTEX_UI_LAB=on` and `APP_ENV` is `development` or `test` (`isUiLabEnabled` in `packages/config/src/server.ts`; gate in `apps/web/src/lab/gate.ts`).
- The env schema rejects `VERTEX_UI_LAB=on` when `APP_ENV=production` (Cloudflare Worker).
- The QuantVPS production serve runs with `APP_ENV=development`, so `infra/quantvps/run-preview.mjs` refuses to start when `VERTEX_UI_LAB` is set to any value other than `off`.
- The lab is outside the `(portal)` session gate. It never calls the oRPC API: every gateway is a fake. Write actions (create, update, submit, approve) fail with "UI lab: dummy data only".
- Fixtures are deterministic and fictional: account "Demo Capital" (`DU0000000`), tickers from the Core 7 ETF twins plus AAPL, NVDA, MSFT, TSLA and AMZN, people and emails on `example.test`. Never put real account data in `apps/web/src/lab/fixtures/`.
- The frame shows a "Demo data" badge.

## Layout

|Path|Content|
|---|---|
|`apps/web/src/lab/registry.ts`|`LabEntry` (`id`, `title`, `group`, `route`, `render(params)`), validation, grouping|
|`apps/web/src/lab/entries/*.tsx`|Entries per area; `entries/index.ts` lists them in sidebar order|
|`apps/web/src/lab/fixtures/*.ts`|Seeded dummy data (`fixtures/core.ts`: clock, account, tickers, seeded random)|
|`apps/web/src/lab/lab-frame.tsx`, `lab-views.tsx`|Frame, index and entry views|
|`apps/web/src/app/lab/**`|Routes `/lab` and `/lab/[entry]`|
|`scripts/vertex-ui/`|`capture.ts`, `review.ts` (with `stack.py`), `demo.ts`|

`apps/web/src/lab/entries/index.test.ts` fails when a `(portal)` page has no lab entry. A page job that changes a page also updates its lab entry.

## Query params

- `theme=dark|light` (default `dark`).
- Each entry reads the params its page reads, for example `/lab/charts?symbol=NVDA`, `/lab/backtests?id=<id>`, `/lab/baskets?symbol=<basket>`, `/lab/portfolio?tab=options`.

## Commands

Run the demo server for this worktree (tailnet only, never Funnel):

```sh
bun scripts/vertex-ui/demo.ts --port 9450 --serve 8450
```

It writes development-only bindings to `apps/web/.dev.vars` (git-ignored, mode 0600, random per-run secrets, a placeholder database), starts `vinext dev` on `127.0.0.1:<port>`, waits for `/lab`, runs `tailscale serve --bg --https=<serve>`, checks the tailnet URL and prints it. When the server stops, it removes the serve (`tailscale serve --https=<serve> off`) and deletes `apps/web/.dev.vars`. If `tailscale serve` fails, it stops the dev server. It refuses to overwrite an `apps/web/.dev.vars` that it did not write. Each job uses its own port pair (program file).

Capture entries as full-page PNGs (headless Chromium, dark mode, capture only):

```sh
bun scripts/vertex-ui/capture.ts --base http://127.0.0.1:9450 --entry charts --out /tmp/charts \
  [--widths 1440,820,375] [--name after] [--query "symbol=NVDA"] [--theme light]
bun scripts/vertex-ui/capture.ts --base http://127.0.0.1:9450 --entry all --widths 1440,375 \
  --name before --out ~/Documents/reports/vertex-ui-review
```

Widths 375, 820 and 1440 use 375x812 (iPhone), 820x1180 (iPad) and 1440x900 (laptop) viewports (the owner review widths). Other widths, such as 768 and 1024 from the UI constitution, use a 900 px high viewport. The page clock is frozen at the fixture time (2026-10-30 20:00 UTC), so time text matches between BEFORE and AFTER. The skip link is hidden in captures. `--entry all` writes `<out>/<entry>/<name>-<width>.png`.

Post a vertical BEFORE/AFTER review image with the demo link to the review channel:

```sh
bun scripts/vertex-ui/review.ts --page charts --before before-1440.png --after after-1440.png \
  --caption caption.txt --demo https://<host>.ts.net:8450/lab/charts
```

The image goes to `~/Documents/reports/vertex-ui-review/<page>/review.jpg` (never committed). `--out` must stay inside `~/Documents/reports/vertex-ui-review/`. The script reads the message back and fails when the post has no image. `--no-post` only builds the image. The image step runs `scripts/vertex-ui/stack.py`, a port of the owner-approved review-card script. It needs Python 3 with Pillow 10.1 or later on the rig. The task for this tool allowed a Python helper under `scripts/vertex-ui/`; it is not part of the app or CI.

## Tests

- Unit: `apps/web/src/lab/**/*.test.ts(x)`, `apps/web/src/app/lab/route-files.test.tsx` (404 when off or in production), `packages/config/src/ui-lab-env.test.ts`, `scripts/vertex-ui/*.test.ts`.
- Browser (CI only): `tests/e2e/ui-lab.spec.ts`. The E2E server sets `VERTEX_UI_LAB=on` (`tests/e2e/env.ts`).
