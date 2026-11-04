# Sector rotation map

Updated: 2026-11-02. Research only. The sector rotation map shows how strong each sector (or each symbol of a custom list) is against a benchmark, and whether that strength is rising or falling. A quadrant describes past prices. It is not an instruction to trade, it places no order and it has no broker client.

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
| oRPC contract `sectorRotation.map`, `.collect`, `.snapshot` | `packages/api/src/contracts/sector-rotation.ts` |
| Pure math (formula, weekly bars, quadrants, streaks, changes) | `packages/api/src/sector-rotation.ts` |
| Procedures, Yahoo fetch, cache and alert delivery | `packages/api/src/server/sector-rotation.ts` |
| Tables `sector_rotation_points` and `sector_rotation_alerts`, repository | `packages/db/src/schema/index.ts`, `packages/db/src/server/sector-rotation.ts`, migration `0047_sector_rotation`, rollback `packages/db/rollback/0047_sector_rotation.down.sql` |
| Scheduler client | `scripts/sector-rotation/tick.ts`, `bun run vertex:sector-rotation:tick` |
| User systemd units (not enabled) | `infra/sector-rotation/vertex-sector-rotation.{service,timer}` |
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

`bun run vertex:sector-rotation:tick` calls `sectorRotation.collect`. The client reads `VERTEX_ORIGIN` and `VERTEX_AGENT_API_KEY` (an operator write key), prints the JSON result and one line per alert, and never prints the key. `bun run vertex:sector-rotation:tick -- --dry-run` sends `dryRun: true`.

Second alert route (optional): when `VERTEX_ALERT_POST_URL` (a loopback chat bot endpoint that takes `{channel, text}`, for example the rig Discord bot at `http://127.0.0.1:47821/post`) and `VERTEX_ALERT_CHANNEL` (for example `trading-alerts`) are both set, the client posts each alert line that the server could not deliver (`not-configured` or `failed`) to that channel. The server returns an alert only in the run that recorded it, so each line is posted once. A failed post makes the run exit with code 1 after it tries every line. A dry run posts nothing.

The units in `infra/sector-rotation/` are not installed or enabled. The timer runs Monday to Friday at 16:50 and 18:40 New York time (the second run picks up late or corrected bars) with `Persistent=true`:

```sh
install -m 0600 /dev/null ~/.config/vertex/sector-rotation.env   # then add VERTEX_ORIGIN, VERTEX_AGENT_API_KEY and, optionally, VERTEX_ALERT_POST_URL and VERTEX_ALERT_CHANNEL
cp infra/sector-rotation/vertex-sector-rotation.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vertex-sector-rotation.timer
```

The service expects the checkout at `~/Github/trading/vertex-research-platform`; edit `WorkingDirectory` for another path.

## Rollback

1. Stop the timer: `systemctl --user disable --now vertex-sector-rotation.timer`.
2. Revert the application change.
3. Run `packages/db/rollback/0047_sector_rotation.down.sql`. It refuses while `sector_rotation_alerts` has rows, because that table is the record that stops repeat alerts; export or delete those rows on purpose first. Stored points are derived from market bars and do not block the rollback. Reconcile the Drizzle migration ledger separately before re-applying `0047`.
