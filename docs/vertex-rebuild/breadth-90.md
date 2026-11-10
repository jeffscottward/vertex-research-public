# Breadth-90 signal

Updated: 2026-11-09. Research only. The breadth-90 signal watches NYSE up and down volume for the capitulation-then-thrust pattern in Paul Desmond's (Lowry Research) 90% day studies. A state is a description of past sessions. It is not an instruction to trade, it places no order and it has no broker client.

## Spec

Per session, from `scripts/breadth-90/classifier.ts`:

```text
upPct  = 100 × UVOL ÷ (UVOL + DVOL)     (NYSE up-volume share; USI:UVOL, USI:DVOL)
advPct = 100 × ADV ÷ (ADV + DECL)       (advancer share; USI:ADV, USI:DECL; the points proxy)
```

Both are rounded to two decimals. A session without a valid volume pair is dropped; `advPct` is null when advancers and decliners are both zero.

| upPct | Day kind |
| --- | --- |
| ≥ 90 | `UP_90` |
| ≥ 80 | `UP_80` |
| ≤ 10 | `DOWN_90` |
| ≤ 20 | `DOWN_80` |
| otherwise | `NEUTRAL` |

States (`IDLE`, `ARMED`, `FORMING`, `FIRED`):

- ARMED: a final 80%+ down day (`upPct ≤ 20`) is in the last 30 final sessions. `strict` when a 90% down day (`upPct ≤ 10`) is in the window. `armedOn` is the newest arming day; `sessionsLeft` counts the upcoming sessions that stay armed by it.
- FIRED: while armed, a final 90% up day (`upPct ≥ 90`, trigger `UP_90`), or the session and the prior final session both 80% up days (trigger `UP_80_X2`). Grade `major` when `advPct` also clears the bar (≥ 90 for a 90% day, ≥ 80 on both days for the pair), else `volume-only` (Desmond: a one-component day is often short-lived). The state stays FIRED for the fire session and the one after it.
- FORMING: today's unfinished (intraday) session meets the FIRED rule while armed. It counts only at the close.
- THRUST: a final 90% up day while not armed. An event (a notice), not a state.
- IDLE: none of the above.

Events are `ARMED`, `FORMING`, `FIRED` and `THRUST`. Each has a dedupe tier: `strict` or `standard` for ARMED, the grade for the others. An event is recorded and alerted once per (kind, date, tier), so an upgrade from standard to strict, or from volume-only to major, is a new event.

## Data sources

- TradingView public websocket (primary): daily bars for `USI:UVOL`, `USI:DVOL`, `USI:ADV` and `USI:DECL`, plus today's cumulative 5-minute value during the session (`scripts/breadth-90/tradingview.ts`). The timeout is `BREADTH90_TV_TIMEOUT_MS`.
- WSJ markets diary (fallback and cross-check, `scripts/breadth-90/wsj.ts`): NYSE up and down volume and issues. When both sources have today, the tick records the difference; a gap of more than 5 percentage points is a disagreement in `crossChecks`.
- Dip basket (`scripts/breadth-90/basket.ts`): the research desk's `dip-basket.v1` file, default `~/Documents/reports/trading/dip-basket/basket.json` (override `BREADTH90_BASKET`). The tick reads the summary, report path, rules note and tiers; a missing or unreadable file only drops the basket lines.

## Rig timer, CLI and state

- CLI: `bun run vertex:breadth-90:tick [--mode auto|intraday|final|backfill] [--dry-run] [--test-alert] [--no-push]` (`scripts/vertex-breadth-90-tick.ts`, `scripts/breadth-90/tick.ts`). `auto` (default) is final from 10 minutes after the close, else intraday. Weekends and NYSE holidays are skipped (`scripts/breadth-90/calendar.ts`); backfill and `--test-alert` still run. `--dry-run` fetches and reports only. `--test-alert` sends one "🧪 TEST" alert to every channel and no real alert. Backfill stores up to 1000 daily sessions and never alerts.
- Timer: `infra/breadth-90/vertex-breadth-90.timer` runs weekdays, New York time, at 10:30, 12:00, 13:30, 14:30, 15:00, 15:30 and 15:45 (intraday) and 16:20 and 17:00 (final; the later run picks up corrected bars). `infra/breadth-90/vertex-breadth-90.service` runs `infra/breadth-90/vertex-breadth-90-run` with the nonsecret environment file `~/.config/vertex/breadth-90.env` (table below). The wrapper changes to the runner checkout and uses the bun version that the checkout pins in `.bun-version` (installed by mise); the unit sets no `WorkingDirectory`.
- Runner checkout: a detached worktree of this repository with its own dependencies, default `~/Github/trading/vertex-research-public-ticks-runner`. Create it from the main checkout with `git worktree add --detach ../vertex-research-public-ticks-runner origin/vertex/rebuild-darkfactory-20260921`, then run `pnpm install --frozen-lockfile` in it. To update it, run `git fetch`, `git checkout --detach <commit>` and `pnpm install --frozen-lockfile` in it.
- Install (user units): copy the `.service` and `.timer` to `~/.config/systemd/user/`, copy `vertex-breadth-90-run` to `~/.local/bin/` (mode 0755), create the environment file, then `systemctl --user daemon-reload && systemctl --user enable --now vertex-breadth-90.timer`.
- State: `~/.local/share/vertex-breadth-90/state.json` (`scripts/breadth-90/state.ts`) holds the stored sessions, per-channel alert delivery (the dedupe record), source cross-checks and test sends. `history.jsonl` beside it gets one summary line per tick.

Environment (`~/.config/vertex/breadth-90.env`, nonsecret values only):

| Variable | Default | Use |
| --- | --- | --- |
| `BREADTH90_EMAIL_TO` | none | Email recipient. Without it the email channel fails (see Alerts). |
| `BREADTH90_RUNNER_DIR` | `~/Github/trading/vertex-research-public-ticks-runner` | Runner checkout of the wrapper. |
| `BREADTH90_STATE_DIR` | `~/.local/share/vertex-breadth-90` | State directory. |
| `BREADTH90_PUSH` | unset | `1` pushes each tick to Vertex (`breadth90.collect`). It needs `VERTEX_ORIGIN` and the key file; without them the wrapper prints a warning and runs with `--no-push`. |
| `VERTEX_ORIGIN` | none | Portal origin for the push. |
| `BREADTH90_KEY_FILE` | `~/.config/vertex/sector-rotation-key` | File (mode 0600) with an operator agent API key with write access. The default is the key file of the sector rotation rig unit. The wrapper reads the key and never prints it. |

## Alerts

`scripts/breadth-90/alerts.ts` sends each new FORMING, FIRED or THRUST event once per channel. An ARMED event goes to Discord and ntfy only:

- ntfy: the owner's phone topic from `~/.config/omp-notify/ntfy.json` (override `BREADTH90_NTFY_CONFIG`), JSON publish. The topic is never printed.
- Email: mutt (`BREADTH90_MUTT`) to `BREADTH90_EMAIL_TO`, with a local sent copy. The recipient has no default: set it in `~/.config/vertex/breadth-90.env`; without it the email channel fails with `BREADTH90_EMAIL_TO is not set` and sends nothing.
- Discord: the loopback omp-discord-bot `/post` route (`BREADTH90_DISCORD_URL`, channel `BREADTH90_DISCORD_CHANNEL`, default #trading-alerts).

A channel that fails is retried on the next tick while the event is in the last two sessions; after that the alert is not sent on that channel. A channel that succeeded is never sent the same alert again. A tick with a failed channel exits 1, so the unit shows as failed. This includes a missing ntfy configuration and an unset `BREADTH90_EMAIL_TO`: configure every channel, or expect exit 1 on each tick with a due alert. Alerts carry the basket lines (summary, report path, rules note) when the basket file is available.

## API

Contract `packages/api/src/contracts/breadth-90.ts`, procedures `packages/api/src/server/breadth-90.ts`, storage `packages/db/src/server/breadth-90.ts` (migration `packages/db/migrations/0066_breadth_90.sql`).

| Procedure | Route | Access |
| --- | --- | --- |
| `breadth90.collect` | `POST /breadth-90/collect` (RPC `/api/orpc/breadth90/collect`) | Operator agent API key with **write** access only. A read key gets 403 (read-only key), a browser session gets 403 (needs an agent API key), a bad key 401. |
| `breadth90.get` | `GET /breadth-90` | Operator session, agent viewer session, or an operator agent key (read or write). |

`breadth90.collect` takes exactly what the tick pushes (`pushToVertex` in `scripts/breadth-90/tick.ts`): `state`, `armedOn`, `strict`, `sessionsLeft`, `asOf` (ISO time of the tick), `basket` (`asOf`, `reportPath`, `rulesNote`, `summary`, `tiers[]` of `id`, `label`, `tickers`, `weightPctNlv`), `days[]` (`date`, `upPct`, `advPct`, `kind`, `final`, `uvol`, `dvol`, `adv`, `decl`, `source`, `sourceAsOf`; at most 2500) and `events[]` (`kind`, `date`, `tier`, `upPct`, `advPct`, `armedOn`, `strict`, `trigger`, `grade`; at most 1000). Unknown fields are rejected. It upserts every session by date (a newer push replaces the stored row, so a closed session replaces its intraday row; a push that is not final never replaces a stored final session), inserts each event once by (kind, date, tier) and replaces the single status row (`nyse`). It returns the events this push recorded first and the counts written.

`breadth90.get` returns `status` (`state`, `armedOn`, `strict`, `sessionsLeft`, `asOf`, `basket`; null before the first push), `days` (the last 30 sessions, oldest first: final sessions plus a trailing intraday session; an intraday row older than the newest session is left out), `events` (the newest 20) and `thresholds` (`down90` 10, `down80` 20, `up80` 80, `up90` 90).

Tables (`packages/db/src/schema/index.ts`):

- `breadth90_days`: `date` (primary key), `uvol`, `dvol` (double precision), `adv`, `decl` (integer), `up_pct`, `adv_pct`, `kind`, `final`, `source`, `source_as_of` (text, kept as each source sends it), `updated_at`.
- `breadth90_events`: `id`, `kind`, `date`, `tier`, `up_pct`, `adv_pct`, `armed_on`, `strict`, `trigger`, `grade`, `created_at`; unique (`kind`, `date`, `tier`).
- `breadth90_status`: one row `id = 'nyse'` with `state`, `armed_on`, `strict`, `sessions_left`, `as_of`, `basket` (jsonb), `updated_at`.

The app role `vertex_research` gets SELECT, INSERT, UPDATE on days and status and SELECT, INSERT on events.

## Web card

The markets page (`/markets`, `apps/web/src/app/(portal)/markets/page.tsx`) shows the breadth-90 card (`apps/web/src/components/portal/breadth-90-card.tsx`) first, above the market context and feeds. It is the most visible signal surface for an operator; the card marks itself "High priority".

- State badge: FIRED loud green, FORMING orange, ARMED amber, IDLE muted; the text always names the state. A strict flag, the arming day and the sessions left.
- Today: `upPct` and `advPct` of the newest session, labelled Close or Intraday (unfinished session).
- Chart (`apps/web/src/components/portal/breadth-90-chart.tsx`): one bar per session of the last 30 for `upPct`, dashed reference lines at 10, 20, 80 and 90%, the intraday bar hollow. The values are also in a visually hidden table.
- Recent events (newest first), the dip basket (summary, tiers with weights and tickers, rules note, report path as text) and the source and time of the newest session.
- Empty state before the first push; an operator notice on 403; an error with Retry. The card refreshes every minute and has its own Retry. It sits in the `belowHeader` slot of `MarketContextPage`; the Refresh button and the status chip in the page header do not cover it.

## Rollback

- Web: remove `belowHeader={<Breadth90Card />}` from the markets page (`apps/web/src/app/(portal)/markets/page.tsx`).
- API: remove `breadth90` from `packages/api/src/contract.ts` and `packages/api/src/server/router.ts`, and `breadth90.collect` and `breadth90.get` from `AGENT_API_KEY_PROCEDURE_PATHS` (`packages/api/src/server/handler.ts`) and `AGENT_API_KEY_READ_PROCEDURES` (`packages/api/src/server/operator-access.ts`); regenerate `packages/api/openapi.json`.
- Rig: `systemctl --user disable --now vertex-breadth-90.timer`, or run with `--no-push` (unset `BREADTH90_PUSH`) to keep local alerts without Vertex.
- Database: `packages/db/rollback/0066_breadth_90.down.sql` drops the three tables. It refuses while any event exists, so the event history is never silently discarded; stored sessions and the status row are derived data that the tick pushes again. Drizzle ledger reconciliation is not automated; coordinate it before re-applying.
