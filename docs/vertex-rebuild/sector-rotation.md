# Sector rotation map

Updated: 2026-11-04. Research only. The sector rotation map shows how strong each sector (or each symbol of a custom list) is against a benchmark, and whether that strength is rising or falling. A quadrant describes past prices. It is not an instruction to trade, it places no order and it has no broker client.

## Purpose

Each symbol is one point on a chart: the x axis is the relative strength ratio and the y axis is its momentum, both centered on 100. The point moves through four quadrants as a sector gains and loses strength against the market. A trail of past points shows the path. The stored universe is the 11 Select Sector SPDR ETFs against SPY; an operator can also compute a custom list (watchlist, basket or typed symbols, at most 30) against any benchmark on request. The snapshot procedure gives research agents the same data as a versioned document.

This is our own documented formula. It is not the proprietary JdK RS-Ratio and RS-Momentum algorithm, and the product does not use that name.

## Formula

From `packages/api/src/sector-rotation.ts`:

```text
rs_t       = 100 × close_t ÷ benchmarkClose_t                 (dates where both closed)
smooth_t   = EMA(rs, rsSmoothing)_t                           (EMA seeded with the first value)
ratio_t    = 100 × smooth_t ÷ SMA(smooth, trendWindow)_t      (above 100 = stronger than its trend)
roc_t      = 100 × ratio_t ÷ ratio_{t − momentumLag}          (rate of change of the ratio)
momentum_t = EMA(roc, momentumSmoothing)_t                    (above 100 = ratio rising)
```

The first `rsSmoothing + trendWindow + momentumLag + momentumSmoothing` aligned periods are dropped, so EMA seeding and the trend window do not bias the output. Weekly series use the last close of each ISO week (Monday start); the current, partial week uses its latest close. Stored weekly points hold final weeks only: a week is stored once a later week starts or on its Friday, so the partial week never leaves one row per weekday. Custom lists computed on request still show the partial week.

Quadrants:

| Ratio | Momentum | Quadrant |
| --- | --- | --- |
| ≥ 100 | ≥ 100 | leading |
| ≥ 100 | < 100 | weakening |
| < 100 | < 100 | lagging |
| < 100 | ≥ 100 | improving |

## Parameters

| Timeframe | rsSmoothing | trendWindow | momentumLag | momentumSmoothing | Warm-up periods |
| --- | --- | --- | --- | --- | --- |
| daily | 10 | 50 | 10 | 5 | 75 trading days |
| weekly | 4 | 26 | 4 | 3 | 37 weeks |

Every map response returns the parameters it used (`params`).

## Parts

| Part | File |
| --- | --- |
| oRPC contract `sectorRotation.map`, `.collect`, `.recordChatDelivery`, `.snapshot` | `packages/api/src/contracts/sector-rotation.ts` |
| Pure math (formula, weekly bars, quadrants, streaks, changes) | `packages/api/src/sector-rotation.ts` |
| Procedures, Yahoo fetch, cache and alert delivery | `packages/api/src/server/sector-rotation.ts` |
| Tables `sector_rotation_points` and `sector_rotation_alerts`, repository | `packages/db/src/schema/index.ts`, `packages/db/src/server/sector-rotation.ts`, migration `0047_sector_rotation`, rollback `packages/db/rollback/0047_sector_rotation.down.sql` |
| Scheduler client | `scripts/sector-rotation/tick.ts`, `bun run vertex:sector-rotation:tick` |
| QuantVPS system units and install script (live) | `infra/sector-rotation/quantvps/` |
| Rig user units (not used) | `infra/sector-rotation/vertex-sector-rotation.{service,timer}` |
| Snapshot compatibility fixture | `packages/api/src/fixtures/sector-rotation-snapshot.v1.json` |

## Data path

1. **Collect (stored universe).** `sectorRotation.collect` reads five years of daily bars for SPY and the 11 sector ETFs from `https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=5y&interval=1d`. Each request is a bounded GET through `fetchBoundedJson` (10 s, 4 MiB, no redirects, descriptive User-Agent), at most 4 at a time, and the document is schema-parsed. The adjusted close series is used when Yahoo sends it (dividends and splits), otherwise the close series; the two are never mixed row by row, and a row without a value is dropped. A bar's date is the UTC date of its timestamp. When the quote time is on the newest bar's date, the newest bar is dropped before the regular session ends (6.5 hours after the bar opens), so a live price never becomes a close; after the session an empty newest close is filled with the quote price.
2. The procedure computes daily and weekly points for every computed date, not only the last 12 months, because the strategy filter and backtests need the history. It upserts them by `(timeframe, symbol, date)` in batches of 500 rows. A rerun overwrites the same rows.
3. **Map (stored).** `sectorRotation.map` with the sector universe and the SPY benchmark reads the stored points: the newest stored date is `asOf`, and the response holds the 366 calendar days before it. Points older than 13 months are not read, so a store that has not been collected for over a year returns `NOT_FOUND`. `generatedAt` is the newest `computed_at`. A sector without stored points is listed in `errors` with "Not yet collected". `source` is `stored`.
4. **Map (computed).** A custom list, or the sectors against another benchmark, is computed on request from two years of daily bars. `asOf` is the benchmark's last bar. A symbol that Yahoo does not know, that has no bars, or that has too little history for the warm-up is listed in `errors` and has no series. An unknown benchmark is `NOT_FOUND`; a benchmark outage is `UNAVAILABLE`. The result is cached in process for 10 minutes, keyed by timeframe, benchmark, universe kind and sorted symbols (at most 50 entries). `source` is `computed`, and nothing is stored.
5. **Snapshot.** `sectorRotation.snapshot` reads the stored points of one timeframe (default daily) and returns `schemaVersion: 1`, `asOf`, `previousDate` (the stored period before `asOf`, or null), each sector's current quadrant with its streak (`since`, `periods`), the `changes` between `previousDate` and `asOf`, and up to 20 `recentTransitions` of the last 366 days, newest first.

## Procedures and access

All procedures require an operator (`VERTEX_OPERATOR_EMAILS`).

| Procedure | Session operator | Agent API key |
| --- | --- | --- |
| `sectorRotation.map` | yes | no (session only) |
| `sectorRotation.collect` | no (`FORBIDDEN`) | write key only (the scheduler) |
| `sectorRotation.recordChatDelivery` | no (`FORBIDDEN`) | write key only (the scheduler) |
| `sectorRotation.snapshot` | yes | read or write key |

Errors: `BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND` ("Sector rotation not yet collected"), `STORAGE_ERROR` (no repository), `UNAUTHORIZED`, `UNAVAILABLE` (SPY or every sector failed in collect; benchmark outage in a computed map). In collect, a single sector that fails is reported in `fetchErrors` and the others are still stored.

## Alerts and dedupe

After a collection, the procedure looks at the newest daily date. Each daily quadrant change on that date is a transition (returned in `transitions`). A sector whose current daily streak is `leading` or `lagging` and began at most 7 calendar days before the newest date is an alert, dated on the first day of the streak. This way a missed run still alerts, and an entry that already reversed does not. One alert has one line, for example:

```text
Sector rotation: XLK (Technology) entered Leading on 2026-11-02 (latest ratio 101.2, momentum 100.4). Research only.
```

- The alert is recorded insert-once in `sector_rotation_alerts` by `(symbol, quadrant, entered_on)` with delivery `pending`. Only an alert that this run created is sent, so the second daily run (or any rerun) never sends it again and does not return it.
- The line goes to the price alert ntfy destination (`VERTEX_PRICE_ALERTS_NTFY_ORIGIN`, `_TOPIC`, `_TOKEN`; see [price-alerts.md](price-alerts.md)) with the title "Vertex sector rotation", through `createNtfyNotificationAdapter`. The ntfy idempotency key is derived from the alert key.
- The outcome (`sent`, `not-configured` or `failed`) is stored on the alert row. An alert that stays `pending` means the process stopped before the result was stored.
- `dryRun: true` computes the points, transitions and alert lines and returns them with delivery `dry-run`; nothing is stored, recorded or sent.
- The migration grants the app role `vertex_research` (if it exists) `SELECT, INSERT, UPDATE` on both tables.

## Strategy filter (backtests and Autopilot)

A strategy definition may list up to 4 filters `{ "type": "sectorQuadrant", "sector": "XLK", "timeframe": "weekly", "quadrants": ["leading", "improving"] }` (`packages/api/src/strategy-dsl.ts`). An entry on a bar is allowed only when every filter passes: the latest stored point of that sector and timeframe dated on or before the bar date (strictly before it for intraday bars) is in one of the listed quadrants. No point at or before the bar means no entry. Exits are never blocked. Definitions without filters keep byte-identical canonical JSON.

- Backtest runs load the series from `sector_rotation_points` (`packages/api/src/server/sector-quadrant-series.ts`). Missing data fails the run with "Sector quadrant data is not available for XLK (weekly)".
- An Autopilot campaign may set the same `filters` at creation (the create form has an optional "Sector filter"; it uses weekly points). Every candidate definition of the campaign carries them, and the in-sample, neighbour and gate runs use the stored series. When the data is missing, the campaign stays running and the next tick retries.

## Scheduler

`bun run vertex:sector-rotation:tick` calls `sectorRotation.collect`. The client reads `VERTEX_ORIGIN` and `VERTEX_AGENT_API_KEY` (an operator write key), prints the JSON result and one line per alert, and never prints the key. `bun run vertex:sector-rotation:tick -- --dry-run` sends `dryRun: true`. When the response is not JSON or does not have the expected `alerts` shape, the client posts nothing and exits with code 1; the log names each schema issue by path.

Second alert route (optional): when `VERTEX_ALERT_POST_URL` (a loopback chat bot endpoint that takes `{channel, text}`, for example the rig Discord bot at `http://127.0.0.1:47821/post`) and `VERTEX_ALERT_CHANNEL` (for example `trading-alerts`) are both set, the client posts each alert line that the server could not deliver (`not-configured` or `failed`) to that channel. The server returns an alert only in the run that recorded it, so each line is posted once. A failed post makes the run exit with code 1 after it tries every line. The log names each failed line (symbol, quadrant, date) and the reason: the connection error, the HTTP status or a reply other than `{"ok":true}`. A dry run posts nothing. After each post the client calls `sectorRotation.recordChatDelivery` with the alert key (`symbol`, `quadrant` = the alert's `to`, `enteredOn` = the alert's `date`) and `delivery`: `sent` when the endpoint replied 2xx with `{"ok":true}`, otherwise `failed`. The server updates the row only when its delivery is `not-configured` or `failed` and never inserts a row; it returns `{updated}`. A failed write-back is printed and makes the run exit with code 1, but the line is not posted again: the next run does not return that alert.

### QuantVPS deployment (live)

The live scheduler runs on QuantVPS as the system units `vertex-sector-rotation.service` and `vertex-sector-rotation.timer` (owner decision 2026-11-04). It is the only scheduler: the rig user timer also ran the collection from 2026-11-05 to 2026-11-10 and is retired (see [Rig user units](#rig-user-units-retired)). The repository copies are in `infra/sector-rotation/quantvps/`; they are byte-identical to the files in `/etc/systemd/system/`. The timer runs Monday to Friday at 16:50 and 18:40 New York time (the second run picks up late or corrected bars) with `Persistent=true`.

QuantVPS has no bun and no source checkout. `bun build --target=node` bundles `scripts/vertex-sector-rotation-tick.ts` into one file, `/opt/vertex-sector-rotation/vertex-sector-rotation-tick.mjs`, with the source commit in `/opt/vertex-sector-rotation/SOURCE_SHA`. The service runs it with the Autopilot Node (`/opt/vertex-autopilot/bin/node`, Node 24) and the systemd sandbox settings of the Autopilot unit.

Settings come from root-only (mode 0600) environment files that stay on QuantVPS and are never in the repository:

| File | Keys | Used by |
| --- | --- | --- |
| `/etc/vertex-autopilot/autopilot.env` | `VERTEX_ORIGIN`, `VERTEX_AGENT_API_KEY` (the Autopilot operator write key) | the service (it uses this key only when `agent-key.env` is missing) |
| `/etc/vertex-sector-rotation/agent-key.env` | `VERTEX_AGENT_API_KEY` (the collection's own operator write key, read and write, made by the owner on 2026-11-05) | the drop-in `vertex-sector-rotation.service.d/agent-key.conf`; systemd reads it after `autopilot.env`, so this key replaces the Autopilot key |
| `/etc/vertex-sector-rotation/alert.env` | `VERTEX_ALERT_POST_URL=http://127.0.0.1:47821/post`, `VERTEX_ALERT_CHANNEL=trading-alerts` | the drop-in `vertex-sector-rotation.service.d/alert-route.conf` |

The collection has its own key since 2026-11-10 (card vertex-sector-rotation-two-schedulers), so it no longer shares the Autopilot key. The key was written on QuantVPS from its rig copy without showing it:

```sh
{ printf 'VERTEX_AGENT_API_KEY='; tr -d '\r\n' <~/.config/vertex/sector-rotation-key; echo; } |
  ssh quantvps 'umask 077; cat >/etc/vertex-sector-rotation/agent-key.env'
```

The web app has no ntfy settings, so the server stores each alert as `not-configured`, and the client posts the line through the chat route. Port 47821 on QuantVPS is the reverse SSH tunnel to the rig Discord bot; `vertex-nautilus-health-alert` uses the same route for `#omp-alerts`. Since card vertex-rrg-alert-writeback (2026-11-04), the client writes the chat result back, so a posted line moves its row from `not-configured` to `sent` (or `failed`). The three alerts stored before the route existed (XLB 2026-10-27, XLF 2026-10-30, XLRE 2026-11-02) were posted once by hand on 2026-11-04 and their rows were set to `sent`.

To install or update, run the install script on the rig from a clean checkout of the commit to deploy, with dependencies installed:

```sh
infra/sector-rotation/quantvps/install.sh                   # build, copy over `ssh quantvps`, install, enable the timer
infra/sector-rotation/quantvps/install.sh --build-only DIR   # build the files into DIR only
```

The script refuses uncommitted changes and stops before any change when the Autopilot Node or `autopilot.env` is missing, or when `agent-key.env` exists without mode 0600. It checks that Node can parse the bundle. When the bundle changes, it keeps the replaced bundle and `SOURCE_SHA` as `*.prev`; a repeated install of the same build keeps the earlier `*.prev`. Then it installs the units, installs the key drop-in only when `agent-key.env` exists (and removes it when that file is missing, because the drop-in names the file without the `-` prefix and every start would fail), installs the chat route drop-in only when `alert.env` exists, then runs `systemctl daemon-reload` and `systemctl enable --now vertex-sector-rotation.timer`. It does not start a collection. To compare a checkout with the live bundle, run `--build-only` and compare `sha256sum` with `/opt/vertex-sector-rotation/vertex-sector-rotation-tick.mjs`.

To remove the chat route: delete the drop-in and `alert.env`, then run `systemctl daemon-reload`. To go back to the Autopilot key: delete `agent-key.env` and the drop-in `agent-key.conf`, then run `systemctl daemon-reload`.

### Rig user units (retired)

The user units `infra/sector-rotation/vertex-sector-rotation.{service,timer}` were the first plan for the rig. They run `bun run vertex:sector-rotation:tick` from a checkout at `~/Github/trading/vertex-research-public` with `~/.config/vertex/sector-rotation.env` (mode 0600, the same keys as above). On 2026-11-05 (card vertex-sector-rotation-key) the rig timer was enabled with the collection's new key, beside the QuantVPS timer, so each slot ran the collection twice. That did no harm: the alert table keeps one row per `(symbol, quadrant, entered_on)`, so only the run that inserts the row returns and posts the alert. On 2026-11-10 (card vertex-sector-rotation-two-schedulers) the key moved to QuantVPS and the rig timer was disabled with `systemctl --user disable --now vertex-sector-rotation.timer`; the unit files stay installed on the rig. Do not enable them beside the QuantVPS timer.

## Rollback

1. Stop the timer on QuantVPS: `systemctl disable --now vertex-sector-rotation.timer`. To go back to the previous bundle instead, copy `vertex-sector-rotation-tick.mjs.prev` and `SOURCE_SHA.prev` in `/opt/vertex-sector-rotation` over the current files.
2. Revert the application change.
3. Run `packages/db/rollback/0047_sector_rotation.down.sql`. It refuses while `sector_rotation_alerts` has rows, because that table is the record that stops repeat alerts; export or delete those rows on purpose first. Stored points are derived from market bars and do not block the rollback. Reconcile the Drizzle migration ledger separately before re-applying `0047`.
