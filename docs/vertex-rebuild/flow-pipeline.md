# Flow pipeline and /flow

Card `vertex-flow-pipeline` (stack vertex). Research only: nothing here places, changes or cancels
orders, and a confluence reading describes recent flow; it is never an instruction to trade.

## What it does

One pipeline turns the order-flow and options-flow inputs for **SPY**, **ES**, **QQQ** and **NQ**
into time-aligned per-minute features and events in Postgres. The `/flow` page and the agent read the same data.

| Source | Provider (already paid) | Stored as | Cadence |
| --- | --- | --- | --- |
| Ticks (time & sales) | IBKR historical ticks through `vertex-history` | `flow_minutes` (delta, buy/sell volume, VWAP, OHLC, covered seconds, large and off-exchange prints, stacked imbalances, absorption) and `flow_events` | one fetch of the newest 1000 prints per symbol about every 4 minutes |
| Depth (L2) | IBKR market depth through `vertex-history` | `flow_book` (best bid/ask, top-10 bid and ask size, book pressure) | about every minute |
| Options flow | QuantData `order-flow/consolidated` (SPY; SPX for ES) | `flow_option_prints` (aggressor side, sweep/block, moneyness, vol > OI, opening, premium) and option events | about every 2 minutes, paged from the newest stored print; capped ranges resume in `flow_option_gaps` |
| Net drift | QuantData `net-drift` (SPY, SPX, QQQ, NDX; parts `total` and `zero_dte`) | `flow_net_drift` (per-minute signed net call and put premium and volume, price) | every 120 s per ticker: sp500 symbols on even minutes, nasdaq100 symbols on odd minutes |
| GEX | QuantData chain + open interest, same estimate as `/charts` | `flow_gex` (regime, flip, walls, max pain, DEX, 0DTE share, IV regime, basis) | about every 14 minutes |

Instrument registry (`FLOW_INSTRUMENTS` in `packages/api/src/flow-features.ts`):

| Symbol | Kind | Group | Options ticker | Sources |
| --- | --- | --- | --- | --- |
| SPY | ETF | sp500 | SPY | ticks, depth, options, gex, net_drift |
| ES | future | sp500 | SPX | ticks, depth, options, gex, net_drift |
| QQQ | ETF | nasdaq100 | QQQ | depth, gex, net_drift |
| NQ | future | nasdaq100 | NDX | depth, gex, net_drift |

Groups (`FLOW_GROUPS`): sp500 (S&P 500: future ES, primary ticker SPX, check ticker SPY) and
nasdaq100 (Nasdaq 100: future NQ, primary ticker QQQ, check ticker NDX). A symbol is read only for
the sources its registry entry lists.

Every attempt writes one `flow_samples` row (status `ok`, `empty`, `unavailable` or `skipped`, with
a message), which drives the freshness strip. Rows older than their table's retention are pruned at most once an
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
share that budget, and `/charts` keeps priority, except for a starved symbol (below):

- One tick fetch costs two historical requests (TRADES, then BID_ASK).
- The collector fetches ticks for one symbol at a time, at most once every ~2 minutes across both
  symbols (so each symbol about every 4 minutes): 2 of the 6 slots per 120 s at most.
- Before each tick fetch it reads the pacer through `GET /vertex-history/v1/health`
  (`pacing.recent_requests`, `pacing.backoff_seconds`). It normally fetches only when at most 2
  requests are in the current window and no back-off is running, so at least 2 slots stay free for
  `/charts`. If the health read fails, it does not fetch.
- The wait behind a busy window has a limit. A symbol whose newest tick attempt (ok, empty or
  unavailable) is older than 350 s, or that has none, is starved: it fetches as soon as the window
  has room for its two requests (at most 4 in the window). A steady client such as a long bar
  backfill then cannot keep ticks stale (stale on `/flow` means older than 600 s). A starved fetch
  can fill the window to 6 of 6, so a new bar request may be paced (or get a cached copy) for up to
  about 70 s. A failed starved fetch counts as an attempt: the symbol yields again for 350 s. A
  back-off still stops every tick fetch. The operator seed (`seed: true`) always keeps the limit of 2.
- A tick answer marked `cache.stale` (the previous payload, served because a request was paced out)
  is recorded as `unavailable` and not stored, so `/flow` never shows old ticks as a fresh sample.
- Depth uses its own subscription pacer (one at a time, at least 3 s apart) and does not count
  against the historical budget.
- The service pacer remains the hard limit: it never sends more than 6 per 120 s, whatever the
  callers do.

The tick client prints one line per symbol and source to the journal of `vertex-flow.service`, with
the reason when a fetch was held back (`IBKR window busy (n/6 in 120 s); /charts has priority`, or
for a starved symbol `IBKR window full (n/6 in 120 s); no room for 2 requests`).

Sampling means coverage gaps: 1000 SPY prints can cover only seconds of a busy regular session.
Each minute records `coveredSeconds` (how much of it a sample saw), and the page shows coverage.
Full-session tape needs streaming tick-by-tick data (a later owner decision).

QQQ and NQ send no tick request in this pull request, so the IBKR share of ES and SPY does not
change.

## Features and events

- **Delta / CVD:** signed volume per minute (quote rule, then tick rule); CVD over the window.
- **Large prints:** SPY at least 10,000 shares, ES at least 50 contracts (`large_print`).
- **Off-exchange prints (SPY):** prints on the FINRA TRF venue; share of volume per minute
  (`off_exchange_print` for large ones).
- **Stacked imbalances:** diagonal buy vs sell volume of at least 3:1 on 3 or more adjacent price
  levels inside one minute (`stacked_imbalance`).
- **Absorption:** a minute with at least 30 trades and |delta| at least 40% of volume whose price did
  not move the delta's way (`absorption`).
- **Exhaustion:** 3+ consecutive minutes making new highs (lows) while volume and the delta in
  that direction both shrink (`exhaustion`, bearish after highs, bullish after lows). Only fully
  covered minutes count, and only runs with a fully covered minute before and after them, so the
  newest run shows up one sample later; keyed by run start so repeated samples do not duplicate it.
  Event only; no `flow_minutes` column, no migration (`flow_events.kind` is free text).
- **Book pressure:** (bid size − ask size) ÷ (bid size + ask size) over the top 10 rows.
- **Options:** premium by right, sentiment, aggressor side (QuantData `tradeSideCode`), sweep/block,
  moneyness, unusual, vol > OI, opening, 0DTE; option events for prints at or above $500k (SPY) or
  $1M (SPX), and every golden sweep.
- **GEX:** estimate (dealers assumed long calls, short puts). ES uses SPX levels shifted by the
  ES − SPX basis (ES book mid or last price minus the SPX spot at the snapshot).

## Net drift

Per symbol and turn the collector sends two requests to QuantData `net-drift` for the options
ticker and the session date (the newest weekday): `total` (all expiries) and `zero_dte` (same day).
Both use the filter profile `otm-clean.v1`: out-of-the-money options only, without complex, floor,
tied and cancelled trades. Each answered bucket is upserted into `flow_net_drift` by ticker, part and
minute; a row is rewritten only when a value or the filter profile changed. No sums are stored;
`longer` is total minus `zero_dte` on read. The sample is `ok` when the newest `total` bucket started
at most 300 s ago, `empty` for no bucket or an older one, `unavailable` when `total` failed (a vendor
rate limit names its end time in ET). A failed `zero_dte` part is named in the message. A `total`
request refused for the caller reserve is `skipped` and stores no sample. Net drift is stale after
300 s (09:30 to 16:20 New York). The worst case of one run is 23 QuantData requests (4 net drift, 16
option pages, 3 GEX) against 30 minus the caller reserve of 6.

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

## Control document

`flow.control` (`GET /flow/control`, input `group`: `sp500` or `nasdaq100`) returns
`flow-control.v1`: who is in control of one index group on the options side and the futures side,
the net drift series of the primary and the check ticker, a cross-check, the study status and net
drift freshness. Assembly: `packages/api/src/server/flow-control.ts`; rules and texts:
`packages/api/src/flow-control-rules.ts`. It is readable with an agent read key and by the viewer
role.

Rules (`flow-control-rules.v1`):

| Rule | Value |
| --- | --- |
| Window | 30 min |
| Enter ratio | 0.30 |
| Exit ratio | 0.10 |
| Minutes in a row to enter | 5 |
| Buckets needed in the window | 10 |

Ratio = Σ(call − put) / Σ(abs(call) + abs(put)) over the window of settled `total` buckets (0 for a
zero denominator). While the net drift session is open the newest bucket is left out, because its
minute may still be in progress. From `balanced`, 5 minutes in a row at or above the enter ratio give
`buyers` (at or below the negative enter ratio: `sellers`), dated at the first of them; a ratio below
the exit ratio ends `buyers` (above the negative exit ratio ends `sellers`). The group state is the
primary ticker's state; opposite control of the check ticker gives `mixed`.

A side without a state is `no_data` with the first reason that applies: `market_closed`,
`source_unavailable`, `stale`, `gap`, `session_start`, `sampled_tape`, `not_collected`. Each net
drift series has a parts status: `complete`, `partial` (the same-day part is missing or more than 5
minutes behind; the totals stay complete) or `no_data`. The agreement is `not_comparable` only. The
futures side is `no_data` with `not_collected` until the futures trades are collected. The
cross-check compares stored SPX option prints with the vendor ratio (sp500 only; it never changes a
state). The study line reads the stored study `flow-control-continuation`.

Measured time of one `flow.control` call after the deploy: not measured yet (target under 300 ms).

## Freshness

Per source: `fresh`, `stale` (older than 10 min for ticks, 3 min for depth, 5 min for options,
30 min for GEX while its market is open), `closed` (market closed; last session shown) or `never`.
Net drift is stale after 5 min (session 9:30-16:20 New York); its freshness is in `flow.control`
only. Snapshot freshness lists only the sources a symbol collects (QQQ and NQ: depth and GEX).
Sessions: options and GEX 9:30-16:15 New York; SPY extended hours; ES Globex (Sunday 18:00 to
Friday 17:00, daily break 17:00-18:00). Holidays are not modelled.

## Retention

The collector prunes each table with its own cutoff, at most once an hour (`FLOW_RETENTION_DAYS` in
`packages/api/src/server/flow-collect.ts`): 730 days for `flow_net_drift`, 14 days for every other
flow table, `flow_minutes` included. The previous app does not prune `flow_net_drift`, so a rollback
deletes no row.

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
start and moves its end back to 1 ms after the oldest trade time fetched inside the gap (rows that
fail the print schema count; times outside the gap, such as a bad 0, are ignored): rows sharing that
millisecond are read again whether QuantData treats `endTime` as inclusive or exclusive (stored
print ids are skipped), and each resume moves at least 1 ms. A gap whose capped rows carry no
usable trade time stays as it is and holds the gap budget (newest end first) until it can be read;
after the close such a run records an `unavailable` options sample, so it shows on the freshness
strip. After
the options close (16:15 New York) the collector keeps reading gaps every ~2 minutes with all 8
requests per symbol (about 12,000 prints per hour) until none are left; without gaps it answers
"market closed" with no request. Gaps whose end is older than the 14-day retention are pruned. The
sample message shows the gaps left and the oldest gap start.

Budget: at most 8 QuantData requests per symbol per ~2 minutes, failed ones included (16 for both
symbols), inside the vertex-web client limit of 30 per minute that `/charts` shares, and the account
limit of 240 per 60 s. A refused request stops the run's paging; the gap stays for the next run.
If the gap list cannot be read (for example before 0053 is applied), the options sample is
`unavailable` while the session is open; after the close the run is skipped ("gaps unavailable").

Caller reserve: the collector uses a view of the shared QuantData client
(`withCallerReserve`, `FLOW_QUANTDATA_CALLER_RESERVE = 6`). Its requests (option pages, GEX) are
refused with the reason `reserved` once only 6 of the 30 starts per 60 s are left, so two `/charts`
option reads of 3 requests each always fit, across runs. Before each QuantData source the run
compares the free starts beyond the reserve with the source's worst case (8 for options, 3 for GEX);
when they do not fit, the run entry is `skipped` with "budget: <free> QuantData starts free beyond
the reserve of 6, <n> needed" and no sample is stored, so the source stays due. Seed runs keep this
check. One GEX estimate runs per run: after one symbol ran it, the others are `skipped` ("staggered:
GEX ran for another symbol in this run") and stay due.

Storage errors: a repository error inside one source becomes that source's sample (`unavailable`,
"storage: write failed (<error class>)", no SQL text), and the run goes on with the next source. When
the sample write fails too, the run entry is still returned. An error while reading the last samples
or while pruning ends the run.

Budget line: the collect output carries `budget` (free QuantData starts beyond the reserve at the
end of the run, the reserve, the IBKR requests of the last 120 s and the limit 6, the run time), and
`vertex:flow:tick` prints it after the run lines:
`budget quantdata_free=17 reserve=6 ibkr=2/6 run=41s` (`unread` when a value was not read).

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
(`packages/api/src/server/quantdata-client.ts`), and the collector's caller reserve keeps 6 of the
client's 30 starts per 60 s free for `/charts`. No new paid provider was added.

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

Net drift (migration 0077), in this order:

1. Pause the timer: `systemctl stop vertex-flow.timer`.
2. Apply `packages/db/migrations/0077_flow_net_drift.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container.
3. Check that `flow_net_drift` exists, that `vertex_research` has SELECT, INSERT, UPDATE and DELETE on
   it, and that one replaced check (for example `flow_samples_check`) lists QQQ, NQ and `net_drift`.
4. Deploy the app.
5. Re-run `infra/flow/quantvps/install.sh` (it installs the new tick script).
6. Run `bun run vertex:flow:tick --dry-run`, then start the timer: `systemctl start vertex-flow.timer`.
7. Rollback: deploy the previous app; it runs on the migrated database. The down script
   `packages/db/rollback/0077_flow_net_drift.down.sql` is not the rollback path: before it runs, a
   person must delete the QQQ, NQ and `net_drift` rows, and it drops the stored net drift series.

## Agent semantic layer

Until the certified term catalog (`docs/vertex-rebuild/agent-semantic-layer.md`) is built, agents
read these features through the read-only MCP tool `flow_snapshot`, which returns the same
`flow-snapshot.v1` document as the page. When the catalog lands, flow terms map to `flow.snapshot`.
The tool input stays pinned to SPY and ES (the recorded semantic-layer eval); pull request 2 widens
it to four symbols and records the eval again.
