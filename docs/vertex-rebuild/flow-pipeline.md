# Flow pipeline and /flow

Card `vertex-flow-pipeline` (stack vertex). Research only: nothing here places, changes or cancels
orders, and a confluence reading describes recent flow; it is never an instruction to trade.

## What it does

One pipeline turns the order-flow and options-flow inputs for **SPY** and **ES** into time-aligned
per-minute features and events in Postgres. The `/flow` page and the agent read the same data.

| Source | Provider (already paid) | Stored as | Cadence |
| --- | --- | --- | --- |
| Ticks (time & sales) | IBKR historical ticks through `vertex-history` | `flow_minutes` (delta, buy/sell volume, VWAP, OHLC, covered seconds, large and off-exchange prints, stacked imbalances, absorption) and `flow_events` | one fetch of the newest 1000 prints per symbol about every 4 minutes |
| Depth (L2) | IBKR market depth through `vertex-history` | `flow_book` (best bid/ask, top-10 bid and ask size, book pressure) | about every minute |
| Options flow | QuantData `order-flow/consolidated` (SPY; SPX for ES) | `flow_option_prints` (aggressor side, sweep/block, moneyness, vol > OI, opening, premium) and option events | about every 2 minutes, paged from the newest stored print; capped ranges resume in `flow_option_gaps` |
| GEX | QuantData chain + open interest, same estimate as `/charts` | `flow_gex` (regime, flip, walls, max pain, DEX, 0DTE share, IV regime, basis) | about every 14 minutes |

Every attempt writes one `flow_samples` row (status `ok`, `empty`, `unavailable` or `skipped`, with
a message), which drives the freshness strip. Rows older than 14 days are pruned at most once an
hour. The server runs one collect at a time; an overlapping call (a manual or seed run during a timer
run) answers `busy: true` and does nothing, so the IBKR budget is never spent twice. A run older
than 180 s (past the timer's 170 s limit) counts as abandoned, so a cancelled request cannot stop
sampling.

Code:

- Contract: `packages/api/src/contracts/flow.ts` (`flow.collect`, `flow.snapshot`, `flow-snapshot.v1`).
- Pure features: `packages/api/src/flow-features.ts` (minutes, events, book pressure),
  `packages/api/src/flow-options.ts` (QuantData rows to prints and events),
  `packages/api/src/flow-trade-signing.ts` (quote rule, then tick rule; shared with `/charts`).
- Collector: `packages/api/src/server/flow-collect.ts`; snapshot assembly and confluence:
  `packages/api/src/server/flow-snapshot.ts`; procedures: `packages/api/src/server/flow.ts`.
- Storage: `packages/db/src/schema/flow.ts`, `packages/db/src/server/flow.ts`, migration
  `0052_flow_pipeline` (rollback `packages/db/rollback/0052_flow_pipeline.down.sql`).
- Scheduler: `scripts/flow/tick.ts` (`bun run vertex:flow:tick [--dry-run]`) and the QuantVPS timer in
  `infra/flow/quantvps/`.
- Page: `apps/web/src/app/(portal)/flow/`. Agent: MCP tool `flow_snapshot` (read-only), and
  `flow.snapshot` is readable with an agent read key.

## IBKR budget (owner decision 2026-11-08: sampled now, streaming later)

`vertex-history` paces every historical request, bars and ticks alike: at least 10 s apart, at most
6 per 120 s, with a 10-minute back-off after an IBKR pacing violation. `/charts` and the collector
share that budget, and `/charts` keeps priority:

- One tick fetch costs two historical requests (TRADES, then BID_ASK).
- The collector fetches ticks for one symbol at a time, at most once every ~2 minutes across both
  symbols (so each symbol about every 4 minutes): 2 of the 6 slots per 120 s at most.
- Before each tick fetch it reads the pacer through `GET /vertex-history/v1/health`
  (`pacing.recent_requests`, `pacing.backoff_seconds`). It fetches only when at most 2 requests are in
  the current window and no back-off is running, so at least 2 slots stay free for `/charts`. If the
  health read fails, it does not fetch.
- Depth uses its own subscription pacer (one at a time, at least 3 s apart) and does not count
  against the historical budget.
- The service pacer remains the hard limit: it never sends more than 6 per 120 s, whatever the
  callers do.

The tick client prints one line per symbol and source to the journal of `vertex-flow.service`, with
the reason when a fetch was held back (`IBKR window busy (n/6 in 120 s); /charts has priority`).

Sampling means coverage gaps: 1000 SPY prints can cover only seconds of a busy regular session.
Each minute records `coveredSeconds` (how much of it a sample saw), and the page shows coverage.
Full-session tape needs streaming tick-by-tick data (a later owner decision).

## Features and events

- **Delta / CVD:** signed volume per minute (quote rule, then tick rule); CVD over the window.
- **Large prints:** SPY at least 10,000 shares, ES at least 50 contracts (`large_print`).
- **Off-exchange prints (SPY):** prints on the FINRA TRF venue; share of volume per minute
  (`off_exchange_print` for large ones).
- **Stacked imbalances:** diagonal buy vs sell volume of at least 3:1 on 3 or more adjacent price
  levels inside one minute (`stacked_imbalance`).
- **Absorption:** a minute with at least 30 trades and |delta| at least 40% of volume whose price did
  not move the delta's way (`absorption`).
- **Book pressure:** (bid size − ask size) ÷ (bid size + ask size) over the top 10 rows.
- **Options:** premium by right, sentiment, aggressor side (QuantData `tradeSideCode`), sweep/block,
  moneyness, unusual, vol > OI, opening, 0DTE; option events for prints at or above $500k (SPY) or
  $1M (SPX), and every golden sweep.
- **GEX:** estimate (dealers assumed long calls, short puts). ES uses SPX levels shifted by the
  ES − SPX basis (ES book mid or last price minus the SPX spot at the snapshot).

## Confluence

Three directional votes plus GEX as context:

| Factor | Bullish / bearish when |
| --- | --- |
| Order flow | delta ÷ volume over the last 15 sampled minutes ≥ +10% / ≤ −10% |
| Book | newest book pressure ≥ +20% / ≤ −20% |
| Options flow | (bullish − bearish premium) ÷ both over the last 30 minutes ≥ +15% / ≤ −15% |

Fewer than two known votes: "Not enough fresh data". Bullish and bearish votes together:
"Flows disagree". Two or more on one side and none on the other: "Flows agree". A source counts
only while it is fresh (or its market is closed, so the last session is shown).

## Freshness

Per source: `fresh`, `stale` (older than 10 min for ticks, 3 min for depth, 5 min for options,
30 min for GEX while its market is open), `closed` (market closed; last session shown) or `never`.
Sessions: options and GEX 9:30-16:15 New York; SPY extended hours; ES Globex (Sunday 18:00 to
Friday 17:00, daily break 17:00-18:00). Holidays are not modelled.

## Options paging and gaps

QuantData serves `order-flow/consolidated` newest first, 50 rows per page. Per symbol and run the
collector reads the new window (from the newest stored print to now) with at most 6 requests (300
prints). Ranges it leaves unread become rows in `flow_option_gaps` (migration 0053), stored before
the window's prints, so no failure can move the newest stored print past an unread range:

- a capped window's older part, [window start, 1 ms after the oldest fetched row] (the whole
  window when no row carries a trade time; the sample message says "page cap 6 reached, older
  prints of this window queued as a gap");
- after an outage longer than the 15-minute look-back, [newest stored print, look-back floor].

The same run then reads gaps, newest end first, with the rest of its 8 requests (none after a
failed window page); a gap's prints are stored before its row changes, and one start is read once
even when a quiet window queues it again. A gap read to its end is deleted. A capped one keeps its
start and moves its end back to 1 ms after the oldest row fetched (rows that fail the print schema
count, so a schema change cannot stall it): rows sharing that millisecond are read again whether
QuantData treats `endTime` as inclusive or exclusive (stored print ids are skipped), and each resume
moves at least 1 ms. A gap whose capped rows carry no trade time at all stays as it is. After
the options close (16:15 New York) the collector keeps reading gaps every ~2 minutes with all 8
requests per symbol (about 12,000 prints per hour) until none are left; without gaps it answers
"market closed" with no request. Gaps whose end is older than the 14-day retention are pruned. The
sample message shows the gaps left and the oldest gap start.

Budget: at most 8 QuantData requests per symbol per ~2 minutes, failed ones included (16 for both
symbols), inside the vertex-web client limit of 30 per minute that `/charts` shares, and the account
limit of 240 per 60 s. A refused request stops the run's paging; the gap stays for the next run.
If the gap list cannot be read (for example before 0053 is applied), the options sample is
`unavailable` while the session is open; after the close the run is skipped ("gaps unavailable").

## Known gaps

- Options totals cover the stored prints. A busy window that is still in `flow_option_gaps` (see
  "Options paging and gaps") is complete only after later runs read the gap; in a long busy session
  the older gaps wait for the close. Prints QuantData publishes late, with a trade time before the
  newest stored print, are not fetched. If more prints than one run's requests cover (at least 100
  during the session, 400 after the close) share the last millisecond of a gap, the 1 ms step skips
  the rest of that millisecond.
- The GEX snapshot shown is the newest one up to now, even when the order-flow window ended at a
  closed market's last print (GEX uses previous-session open interest).

## Terms

QuantData terms (quantdata.us/legal/terms): personal use, no redistribution. `/flow` is operator-only
on the tailnet and nothing is redistributed. QuantData allows 240 requests per 60 s per account,
shared with `/charts` and the market-watch bot; the shared client keeps its own limits
(`packages/api/src/server/quantdata-client.ts`). No new paid provider was added.

## Deploy

1. Merge, then deploy the app as in `infra/quantvps/README.md` (build on the rig, rsync `dist`,
   `infra/quantvps/restart-when-idle.sh`). Do not run `db:migrate` against the QuantVPS database (its
   Drizzle ledger is incomplete): apply `packages/db/migrations/0052_flow_pipeline.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container, then check
   that the six `flow_*` tables exist and `vertex_research` has SELECT, INSERT, UPDATE and DELETE.
   Apply `0053_flow_option_gaps.sql` the same way (alone, one transaction) before the collector that
   reads gaps is deployed, and check `flow_option_gaps` and its grants.
2. Install the timer from a clean checkout of the deployed commit:
   `infra/flow/quantvps/install.sh` (needs `/etc/vertex-autopilot/autopilot.env` with an operator write
   key). `journalctl -u vertex-flow.service` shows each run.
3. Optional on a weekend or after an outage: one operator backfill so the page shows the last
   session, `bun run vertex:flow:tick --seed` with the operator write key (no session or due checks,
   options look-back 72 h; the IBKR budget check still applies).
4. Rollback: disable `vertex-flow.timer`; the tables can stay (`flow.snapshot` then shows stale data).
   Dropping them uses `packages/db/rollback/0052_flow_pipeline.down.sql`; to re-apply later, delete
   the 0052 row from `drizzle.__drizzle_migrations` first. `flow_option_gaps` alone:
   `packages/db/rollback/0053_flow_option_gaps.down.sql`, after the previous collector is deployed.

## Agent semantic layer

Until the certified term catalog (`docs/vertex-rebuild/agent-semantic-layer.md`) is built, agents
read these features through the read-only MCP tool `flow_snapshot`, which returns the same
`flow-snapshot.v1` document as the page. When the catalog lands, flow terms map to `flow.snapshot`.
