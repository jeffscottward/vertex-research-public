# Flow pipeline and /flow

Card `vertex-flow-pipeline` (stack vertex). Research only: nothing here places, changes or cancels
orders, and a confluence reading describes recent flow; it is never an instruction to trade.

## What it does

One pipeline turns the order-flow and options-flow inputs for **SPY**, **ES**, **QQQ** and **NQ**
into time-aligned per-minute features and events in Postgres. The `/flow` page and the agent read the same data.
The control panel of `/flow` shows a futures state for ES and NQ and the agreement of the futures
side with the options side (section "Control document").

| Source | Provider (already paid) | Stored as | Cadence |
| --- | --- | --- | --- |
| Ticks (time & sales) | SPY: IBKR historical ticks through `vertex-history`. ES and NQ: the streamed tape of `vertex-history` (IBKR tick-by-tick streams) | `flow_minutes` (delta, buy/sell volume, VWAP, OHLC, covered seconds, large and off-exchange prints, stacked imbalances, absorption) and `flow_events` | SPY: one fetch of the newest 1000 prints about every 6 minutes. ES and NQ: one tape read per timer run (due every 50 s), complete minutes only |
| Depth (L2) | IBKR market depth through `vertex-history` | `flow_book` (best bid/ask, top-10 bid and ask size, book pressure) | about every minute |
| Options flow | QuantData `order-flow/consolidated` (SPY; SPX for ES) | `flow_option_prints` (aggressor side, sweep/block, moneyness, vol > OI, opening, premium) and option events | about every 2 minutes, paged from the newest stored print; capped ranges resume in `flow_option_gaps` |
| Net drift | QuantData `net-drift` (SPY, SPX, QQQ, NDX; parts `total` and `zero_dte`) | `flow_net_drift` (per-minute signed net call and put premium and volume, price) | every 120 s per ticker: sp500 symbols on even minutes, nasdaq100 symbols on odd minutes |
| Market premium (market-wide) | QuantData `gainers-losers` (trades >= $100,000 each) | `flow_market_premium` (session totals per ticker) and the ledger `flow_market_premium_sessions` | live about every 15 minutes while options trade; otherwise one gap-fill request per run (section "Market premium") |
| GEX | QuantData chain + open interest, same estimate as `/charts` | `flow_gex` (regime, flip, walls, max pain, DEX, 0DTE share, IV regime, basis) | about every 14 minutes |
| Deep trades (ES, NQ) | the streamed tape of the ticks row | `flow_large_trades` (single prints at or above the deep-trade limit: second, sequence, side, size, price, limit, signing method, capture mode) | with each tape read |
| Tape speed counts (ES, NQ) | the streamed tape of the ticks row | `flow_tape_seconds` (per minute: the prints and the contracts of each of its 60 seconds, and which seconds were covered) | with each tape read |

Instrument registry (`FLOW_INSTRUMENTS` in `packages/api/src/flow-features.ts`):

| Symbol | Kind | Group | Options ticker | Sources |
| --- | --- | --- | --- | --- |
| SPY | ETF | sp500 | SPY | ticks, depth, options, gex, net_drift |
| ES | future | sp500 | SPX | ticks, depth, options, gex, net_drift |
| QQQ | ETF | nasdaq100 | QQQ | depth, gex, net_drift |
| NQ | future | nasdaq100 | NDX | ticks, depth, gex, net_drift |

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

- Contract: `packages/api/src/contracts/flow.ts` (`flow.collect`, `flow.snapshot`, `flow.control`, `flow.events`, `flow-snapshot.v1`, `flow-events.v1`).
- Pure features: `packages/api/src/flow-features.ts` (minutes, events, book pressure, shared `findStacks` and `absorptionOf` rules),
  `packages/api/src/flow-options.ts` (QuantData rows to prints and events),
  `packages/api/src/flow-trade-signing.ts` (quote rule, then tick rule; shared with `/charts`).
- Collector: `packages/api/src/server/flow-collect.ts`; snapshot assembly and confluence:
  `packages/api/src/server/flow-snapshot.ts`; procedures: `packages/api/src/server/flow.ts`.
- Storage: `packages/db/src/schema/flow.ts`, `packages/db/src/server/flow.ts` (`readEvents` reads stored `flow_events` by symbol, range, kind and limit), migration
  `0052_flow_pipeline` (rollback `packages/db/rollback/0052_flow_pipeline.down.sql`).
- Streamed tape: service `infra/quant-vps/history/vertex_history.py` (endpoint `/tape`), client
  `fetchMarketTape` in `packages/api/src/server/market-data.ts`, migration
  `packages/db/migrations/0083_flow_capture_streamed.sql`.
- Tape speed (section "Tape speed (ES, NQ)"): counting `packages/api/src/flow-tape-seconds.ts`
  (pure), burst rule `packages/api/src/flow-tape-speed-rules.ts` (pure), document assembly
  `packages/api/src/server/flow-tape-speed.ts`, procedure `flow.tapeSpeed`
  (`flow-tape-speed.v1`), table `flow_tape_seconds`, migration
  `packages/db/migrations/0091_flow_tape_seconds.sql` (rollback file
  `packages/db/rollback/0091_flow_tape_seconds.down.sql`).
- Scheduler: `scripts/flow/tick.ts` (`bun run vertex:flow:tick [--dry-run]`) and the QuantVPS timer in
  `infra/flow/quantvps/`.
- Tape speed panel: `apps/web/src/components/portal/flow-tape-speed-panel.tsx`, view-model
  `apps/web/src/features/flow/tape-speed-view-model.ts`.
- Hedging pressure (section "Hedging pressure (SPY, ES)"): rules
  `packages/api/src/flow-hedging-pressure-rules.ts` (pure), response assembly
  `packages/api/src/server/flow-hedging-pressure.ts`, procedure `flow.hedgingPressure`
  (`flow-hedging-pressure.v1`), read `readHedgingPrints` of `flow_option_prints`; panel
  `apps/web/src/components/portal/flow-hedging-pressure-panel.tsx`, view-model
  `apps/web/src/features/flow/hedging-pressure-view-model.ts`.
- Pages: `apps/web/src/app/(portal)/flow/` and `apps/web/src/app/(portal)/charts/` (price chart overlays stored `stacked_imbalance` and `absorption` marks from `flow.events` with an Order-flow marks toggle; the Footprint tab highlights diagonal stacked-imbalance cells and bucket absorption using `findStacks` and `absorptionOf` and correlates matching stored `flow_events`). Agent: MCP tool `flow_snapshot` (read-only), and
  `flow.snapshot`, `flow.control` and `flow.events` are readable with an agent read key.

## IBKR budget (owner decisions 2026-11-08: sampled now, streaming later; 2026-11-16: streaming for ES and NQ)

On 2026-11-16 the owner chose streaming for the ES and NQ tape (owner Discord message (private)).
ES and NQ ticks are streamed (section "Streamed tape (ES, NQ)"). A tape read
(`GET /vertex-history/v1/tape`) sends no IBKR request. It has no pacing gate and does not count in
the budget. It is due every 50 s (the timer runs every 60 s). SPY is the only sampled tick symbol
now, so the tick rules below apply to SPY only.

`vertex-history` paces every historical request, bars and ticks alike: at least 10 s apart, at most
6 per 120 s, with a 10-minute back-off after an IBKR pacing violation. `/charts` and the collector
share that budget, and `/charts` keeps priority, except for a starved symbol (below):

- One tick fetch costs two historical requests (TRADES, then BID_ASK).
- A SPY tick fetch reads trades and quotes (two requests). The collector has one tick turn
  (`flowTickTurns` returns SPY only): SPY is fetched about every 360 s. SPY is due again 350 s
  after its last attempt (`FLOW_DUE_SECONDS.ticks` stays 350). The stagger rule (110 s between
  two tick fetches) reads sampled symbols only, so a tape read of ES or NQ does not delay SPY.
  2 of the 6 slots per 120 s at most.
- Before each tick fetch it reads the pacer through `GET /vertex-history/v1/health`
  (`pacing.recent_requests`, `pacing.backoff_seconds`). It normally fetches only when at most 2
  requests are in the current window and no back-off is running, so at least 2 slots stay free for
  `/charts`. If the health read fails, it does not fetch.
- The wait behind a busy window has a limit. A sampled symbol whose newest tick attempt (ok, empty or
  unavailable) is older than 410 s (the seventh 60 s timer run after the attempt, so only a missed
  normal turn makes a symbol starved), or that has none, is starved: it fetches as soon as the window
  has room for its two requests (at most 4 in the window). A steady client such as a long bar
  backfill then cannot keep SPY ticks stale (stale on `/flow` means older than 600 s for sampled
  ticks). A starved fetch
  can fill the window to 6 of 6, so a new bar request may be paced (or get a cached copy) for up to
  about 70 s. A failed starved fetch counts as an attempt: the symbol yields again for 410 s. A
  back-off still stops every tick fetch. The operator seed (`seed: true`) always keeps the limit of 2.
- The turn guard test of `packages/api/src/server/flow-collect.test.ts` asserts that one turn every
  360 s is below the starved limit of 410 s (`FLOW_TICKS_STARVED_SECONDS`).
- A tick answer marked `cache.stale` (the previous payload, served because a request was paced out)
  is recorded as `unavailable` and not stored, so `/flow` never shows old ticks as a fresh sample.
- Depth uses its own subscription pacer (one at a time, at least 3 s apart) and does not count
  against the historical budget.
- The service pacer remains the hard limit: it never sends more than 6 per 120 s, whatever the
  callers do.

The tick client prints one line per symbol and source to the journal of `vertex-flow.service`, with
the reason when a fetch was held back (`IBKR window busy (n/6 in 120 s); /charts has priority`, or
for a starved symbol `IBKR window full (n/6 in 120 s); no room for 2 requests`).

Sampling means coverage gaps for SPY only: 1000 SPY prints can cover only seconds of a busy regular
session. Each SPY minute records `coveredSeconds` (how much of it a sample saw), and the page shows
the coverage. For ES and NQ the coverage is the share of covered seconds of the stream (section
"Streamed tape (ES, NQ)").

QQQ sends no tick request. ES and NQ send no historical tick request any more. SPY keeps its
interval of about 360 s; faster SPY sampling with the freed IBKR budget is a future improvement.

## Streamed tape (ES, NQ)

Plan: [flow-streaming-tape/plan.md](designs/flow-streaming-tape/plan.md). The streamed tape is the
set of prints that the tape feeds of `vertex-history` deliver. A tape feed is the trade stream and
the quote stream of one symbol, with their memory ring. The database stores per-minute rows and
deep trades computed from the streamed tape; it does not store the prints.

Service (`vertex-history` 1.5.0, `infra/quant-vps/history/`):

- **Subscriptions.** The service keeps four IBKR tick-by-tick subscriptions without a web request:
  for ES and for NQ, the quote stream first and the trade stream 16 s later. One background thread
  (the stream thread) keeps them subscribed. The streams cost no IBKR fee.
- **Ring.** Each symbol keeps its newest 200,000 prints in memory. Each print holds the bid and the
  ask that were in force when it arrived (null before the first quote message). Nothing is written
  to disk, and the ring is empty after a restart of the service.
- **Covered second.** An exchange second is covered when it lies between two received prints of one
  live trade stream that are at most 60 s apart, and before the exchange second of the newest
  print (the plan, section 2, gives the exact rule). A covered interval ends at a lost
  subscription, at a late print (a print that arrives more than 5 s after its exchange second), at
  a print that arrives out of order (`/health` counts them as `disordered`) and at an IBKR notice
  that a market-data farm is broken.
- **Read endpoint.** `GET /vertex-history/v1/tape?symbol=ES&since=<epoch second>` returns whole
  exchange seconds from `since`, oldest first, with at most 20,000 prints. `more` says that settled
  prints remain. The answer also holds the covered intervals, the price of the newest print before
  `since` (`previousPrice`), the newest earlier price that differs from it
  (`previousDifferentPrice`) and the state of the feed (`live`, `down` or `off`, with the cause).
- **Off switch.** While the file `/etc/vertex-history/tape-off` exists, the service holds no
  tick-by-tick subscription. The stream thread checks the file once per second, so the operator
  turns the stream off and on without a restart.
- **Subscription cap.** When IBKR refuses a tape subscription with error 10190, the service cancels
  all tape subscriptions and requests none until the process restarts. Research gives way to
  trading.

Collector (`flow.collect`, tick mode `stream` for ES and NQ; the source name `ticks` does not
change):

- **Start of a read.** Each run reads from one minute before the minute of the last stored `ok`
  sample of the symbol (two minutes before the present minute when no such sample exists, so the
  first read always holds one complete minute), but never from more
  than 10 minutes before the present minute (`FLOW_TAPE_LOOKBACK_SECONDS`): after a longer outage
  of the collector the older minutes are not read back. It follows `more` until the answer is
  complete.
- **Complete minutes.** The run processes complete minutes only; the next run reads the minute in
  progress. The minute that is read again heals a minute that a print reached late.
- **Signing.** The collector signs the prints with the existing quote rule and the existing tick
  rule. `previousPrice` and `previousDifferentPrice` seed the tick rule, so a second read signs a
  print the same way.
- **Covered seconds.** Each minute row gets its covered seconds from the covered intervals. A later
  read of the tape replaces a minute row when it holds at least as many prints, also with fewer
  covered seconds: the service lowers the coverage of a minute when a late or out-of-order print
  reaches it. A read after a restart of the service (empty ring) holds fewer prints and does not
  replace a fuller row. The sampled ticks keep their rule (at least as many covered seconds).
- **Deep trades.** The run stores them with the capture mode `streamed` (section "Deep trades").
- **Statuses.** `ok`: the run stored complete minutes; the message is `streamed tape <contract>:
  <P> prints in <M> complete minutes, <C> of <S> s covered; <D> deep trades, <I> new; <K> prints
  signed by the tick rule, <U> without a side`. `empty`: the feed is live and the newest complete minute holds no print and no covered
  second. `unavailable`: the same with a feed that is not live (message
  `tape stream <state>: <cause>`), or a request failed. In both cases the run still stores the
  minute it read again.
- **No fallback.** The collector does not fall back to sampled ticks when the stream is down. The
  futures side of the control document reports the outage.

Coverage is the share of covered seconds in a time range. It says that the stream was live. It does
not prove that no print was lost: the coverage is not checked against a second source. A continuous
check of the tape against IBKR history is a future improvement.

## Features and events

- **ES and NQ:** the events of the streamed tape (large print, absorption, stacked imbalance) come
  from complete minutes only.
- **Delta / CVD:** signed volume per minute (quote rule, then tick rule); CVD over the window.
- **Large prints:** SPY at least 10,000 shares, ES at least 50 contracts (`large_print`). The
  `large_print` limits do not change (ES 50, NQ 10); deep trades have their own limit (ES 40, NQ
  10 contracts, measured 2026-11-13; `deepTradeLimit`).
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
  Event only; no `flow_minutes` column, no migration (`flow_events.kind` is free text). Exhaustion
  events are not produced for ES and NQ: the detector needs a run of full minutes with a full
  minute on each side inside one read, and a tape read holds one or two minutes. Exhaustion events
  from stored minute rows are a future improvement.
- **Book pressure:** (bid size − ask size) ÷ (bid size + ask size) over the top 10 rows.
- **Options:** premium by right, sentiment, aggressor side (QuantData `tradeSideCode`), sweep/block,
  moneyness, unusual, vol > OI, opening, 0DTE; option events for prints at or above $500k (SPY) or
  $1M (SPX), and every golden sweep.
- **GEX:** estimate (dealers assumed long calls, short puts). ES uses SPX levels shifted by the
  ES − SPX basis (ES book mid or last price minus the SPX spot at the snapshot).

## Deep trades

- **One pass, one write.** `buildMinuteFeatures` finds the events and the prints at or above the
  deep-trade limit (`deepPrints`) in the same pass; `deepTradesOf`
  (`packages/api/src/flow-deep-trades.ts`) turns them into rows, and the collector stores the
  events and the rows of a tape read in one transaction (`insertTickSample`).
- **Capture modes.** `sampled` and `streamed` (`FLOW_CAPTURE_MODES`). Migration
  `0083_flow_capture_streamed` widens the check constraint on `flow_large_trades.capture` to accept
  `streamed`. ES and NQ deep trades come from the streamed tape, so new rows are `streamed`. The
  rows that the sampled collector stored earlier keep `sampled`.
- **Edges.** A tape read holds whole seconds, so no second of its range is cut. For a sampled
  capture the first and the last sampled second are left out: the sample edge can cut them.
- **No side, bad price.** A deep print that neither rule could sign, or whose price is not a
  positive number, is not stored (one row that fails the table check would roll back the whole
  sample); the message of a sampled sample counts both (`<n> deep trades, <new> new, <u> deep
  prints without a side, <i> with an invalid price`).
- **No grouping.** Each row is one print; prints are never added up. Sweep detection is not part of
  the streamed tape.
- **Signing.** The quote rule against the quote stream of the same contract (the bid and ask in
  force when the print arrived); the tick rule is the fallback for a print without a quote-rule
  side. Each row stores its method, and the notes of the control document give the share that the
  tick rule signed.
- **Table and key.** `flow_large_trades`, key (`symbol`, `second`, `seq`): `seq` is the order of
  the deep prints inside their second. The ring keeps the arrival order, so a second read gives the
  same keys. A row is inserted once; a row that the sampled collector stored earlier keeps its
  capture mode `sampled`. The control document calls the deep trades of a session `streamed` only
  when no row of that session has the mode `sampled` (the day of the first deploy stays `sampled`).
- **Coverage.** For a streamed capture: the share of covered seconds of the trailing rule window
  (30 minutes that end after the newest stored minute, or after the last ended minute of the
  session when the newest stored minute is more than 2 minutes behind the last ended minute of
  the clock; the same rule holds after the close, so the window ends after 15:59 from 16:02), from
  `flow_minutes.covered_seconds`. The page reads "Streamed tape: N% of seconds covered in the last M min"
  and says that the share is not checked against a second source. For a sampled capture the
  coverage is approximate (it counts the edge seconds that detection leaves out), and the words
  "sampled" and "lower bound" stay. No sums are stored; `flow.control` adds up the rows on read.
- **Retention.** 730 days.
- **Counts can differ.** Two equal prints in one second are one `large_print` event (same event
  key) but two deep-trade rows (`seq` 0 and 1).

## Tape speed (ES, NQ)

Design: [vertex-viz-tape-speed/design.md](designs/vertex-viz-tape-speed/design.md). Research only:
the counts describe how fast the tape traded. Nothing here places, changes or cancels an order.

Storage (`flow_tape_seconds`, migration 0091): one row per symbol (ES or NQ) and minute.

| Column | Meaning |
| --- | --- |
| `trades` | integer array of 60 elements: the prints of each exchange second of the minute |
| `contracts` | integer array of 60 elements: the contracts of each second (the size sum as a whole number) |
| `covered` | text of 60 characters, `0` or `1` per second: `1` means that the second was covered (section "Streamed tape (ES, NQ)") |
| `total_trades` | the sum of `trades` |
| `contract` | the local symbol of the contract that the stream followed, for example `ESZ6` |

- **Row rule.** A row exists for each complete minute of a tape read that has at least one covered
  second or at least one print. A covered minute without a print holds zeros. A minute with no
  covered second and no print has no row. `flow_minutes` has a row only for a minute with a print,
  so the two tables differ on quiet covered minutes on purpose.
- **All prints are counted.** The arrays hold every print of the minute, also the prints of a
  second that is not covered (the service ends a covered span at a late or out-of-order print, so
  such a second can be incomplete). A reader that needs a rate uses the covered seconds only.
- **Replace rule.** A later read of the minute replaces the row when it holds at least as many
  trades. This is the `trades` rule of the minute rows, so both tables keep the same read of a
  minute.
- **Check constraint.** `flow_tape_seconds_check`: the symbol list, 60 elements in each array
  (`cardinality`, so an empty array is refused), no NULL and no negative element, the mask
  pattern, `total_trades >= 0`, and a contract name of 1 to 20 characters.
- **Raw counts only.** The table holds no burst, no baseline and no bucket.

Collector (`collectTape`, after the minute rows, the deep trades and the events are stored):

- **One guarded step.** `countTapeSeconds` folds the prints of the read, the covered pairs and the
  read range into rows, and `upsertTapeSeconds` stores them. One `try` holds both. A dry run
  stores nothing.
- **A failure is a note.** On an error the step adds a note to the sample message:
  `; per-second counts not stored (<error name> <code>)`. The error name is the most specific
  name in the error and its causes (for example a `TypeError` below the wrappers of the collector
  and of the query builder), cut to 40 characters. The Postgres driver gives its error the plain
  name, so a database fault reads `(Error 42501)`. The code is the SQLSTATE code when the error
  or one of its causes has one (42P01: no table; 42501: no grant; 23514: check constraint), else
  a system code such as `ECONNREFUSED` (no connection). The note stands
  before the note "older minutes skipped", and the text before both is cut, so the message keeps
  its 300 characters.
- **Nothing else changes.** The step changes no status, no item count and no event count of the
  sample, and it runs after the other writes. A missing table or grant therefore does not stop
  the minute rows, and the next tape read starts where it would start without this step. A run
  without a fault writes the same sample message as before.
- **No retry.** The next run reads the previous minute again and stores its row. One failed run
  of a normal read (two minutes) loses no row; after an outage it can lose up to nine rows. A
  lasting fault loses every row until it is repaired.
- **Limit.** The guard catches an error; it does not bound a write that waits for a lock. The only
  statement that locks the table is the rollback file, which runs after a stop of the timer.

Burst rule (`FLOW_TAPE_SPEED_RULES`, version `flow-tape-speed-rules.v1`):

| Field | Value | Meaning |
| --- | --- | --- |
| `baselineSeconds` | 600 | the baseline of a second is the mean trades per second of the covered seconds in the 600 seconds before it |
| `minBaselineCoveredSeconds` | 300 | with fewer covered seconds in the baseline the second is not evaluated |
| `multiple` | 8 | a burst second has at least 8 times its baseline |
| `floorTrades` | 20 | and at least 20 trades |

- **Burst.** A run of burst seconds whose exchange seconds follow each other. Its baseline is the
  baseline of its first second.
- **Exchange seconds only.** The rule does not use the window or the bars, so a second has the
  same verdict in every window. The read procedure reads 20 minutes before the first bar: 10 for the
  first second of the axis, and 10 more so that a burst that began in the 10 minutes before the
  axis has the same row in every window. A burst is not followed back further.
- **Trades only.** The rule marks trades per second. Contracts per second are shown and not
  marked: one large print is already a deep trade.
- **Computed on read.** No burst is stored. A new rule version marks all stored history again.
- **Evidence.** The numbers come from one sample: the ring of 2026-11-20, 15:26 to 17:00 New York
  (ES: mean 35.6 trades per second, median 13, maximum 2,740). In that sample the rule marked 10
  ES bursts in 88 judged minutes and 14 NQ bursts in 125 judged minutes, about 7 per hour each.
  The rule describes the tape. It is not tested as a signal.

Procedure `flow.tapeSpeed` (`GET /flow/tape-speed`, input `symbol` ES or NQ and `minutes` 15 to
390, default 120; operator session; no API key; the read-only viewer account can call it as a GET
procedure). It returns `flow-tape-speed.v1`:

- **Window and axis.** The window ends at the newest stored data of the symbol and not later than
  now, like `flow.snapshot`. The axis runs from the start of the minute of the window start to
  the end of the minute of the window end (`minutes + 1` whole minutes).
- **Bars.** 10 s for a window of at most 60 minutes, 20 s for at most 120 minutes, 60 s above:
  366, 363, 241 and 391 bars for the four page windows. A bar holds its covered seconds, the
  trades and the contracts of those seconds, the peak trades and the peak contracts of one
  covered second, and its burst seconds.
- **Bar states**, in this order: `counted` (the minute has a per-second row and the bar has a
  covered second); `not_recorded` (the minute has no per-second row and has a row in
  `flow_minutes`: it was collected before this feature, or the per-second write failed);
  `no_data` (every other bar).
- **Other fields.** `axisStart`, `bucketSeconds`, `storedUntil` (the end of the newest minute of
  the axis with a per-second row), `contract`, `rules`, `tape` (the freshness row of the ticks
  source, built like the rows of `flow.snapshot`), `totals` (covered seconds, evaluated seconds,
  bursts) and `bursts` (the newest 50 that have a second on the axis, oldest first: start,
  seconds, peak trades, contracts, baseline, multiple).
- **Read cost.** At most 411 rows of `flow_tape_seconds`, 391 minute starts of `flow_minutes` and
  the newest tape sample per call (7 queries). No cache. Target: under 300 ms.

Panel "Tape speed" on `/flow` (below the control panel):

- **Which tape.** The panel shows the future of the selected symbol's index group: ES for SPY and
  ES, NQ for QQQ and NQ. The title names the future, and the group for SPY and QQQ. On SPY and QQQ
  the panel has its own time axis: its window ends at the newest stored data of the future.
- **Own call.** The page starts `flow.tapeSpeed` with each load and does not wait for it with the
  other two calls. A slow answer delays no other panel.
- **States.** Loading ("Loading tape speed…", before the first answer; the panel keeps the
  height of the two charts). Failed: one error line
  inside the panel ("Tape speed not loaded: ...", with the retry time); the last document stays
  below it. Document: all parts below; when no bar is counted, the charts show shades only and
  the panel adds "No per-second counts in this window."
- **Newest minute.** The collector writes the minute row a moment before the per-second row, so a
  page read between the two writes shows the newest minute as "Collected, but no per-second
  counts" until the next reload.
- **Charts.** Two charts on one axis: trades per second and contracts per second. A bar is the
  mean per second over the covered seconds of its bucket. A tick marks the busiest second of the
  bar. A bar with fewer covered seconds than its bucket is drawn lighter. The scale is
  logarithmic, from 0 to the largest second of the window: the measured tape has a mean of 36 and
  a maximum of 2,740 trades per second, so a linear scale would flatten every bar.
- **Shades.** "No data" (the stream was not live, or it had no trade for more than 60 s), "After
  the newest stored minute" (not stored yet, or the stream has stopped; a healthy tape always has
  1 to 2 such minutes, because only complete minutes are stored) and, in the warning tone,
  "Collected, but no per-second counts" (before the panel was deployed, or the per-second write
  failed). The legend gives the minutes of each. A covered second without a
  trade counts as zero inside its bar; shaded time is never drawn as a bar of zero.
- **Burst marks.** A diamond above each bar that holds a burst second, and a table of the bursts
  (New York time with seconds, length, peak trades in one second, contracts, baseline, multiple).
  A burst that crosses two bars has two marks and one row.
- **Texts.** The tape line (state, contract, newest stored minute with its date, and the sentence
  that the data is 1 to 2 minutes behind and that the newest minute can still change), the rule
  sentence with its numbers and version, and the count of evaluated seconds when the rule could
  not evaluate all covered seconds. When the newest tape message holds the note of a failed
  per-second write, the panel shows "Per-second counts are not being stored" with the error name
  and code, in every tape state.
- **Fixtures.** `/lab/flow` shows the ES case (busy start, three bursts, a gap, partly covered
  bars) and the NQ case (not recorded, covered without a trade, a write fault; with the
  390-minute window: nothing stored).

## Liquidity heatmap (ES, NQ)

Design: [vertex-viz-liquidity-heatmap/design.md](designs/vertex-viz-liquidity-heatmap/design.md).
Research only: resting book size and trade dots describe market depth and prints, never a trade
signal.

- **Streamed depth (`vertex-history` 1.7.0).** `DepthStream` maintains continuous CME L2
  subscriptions (`reqMktDepth`, 10 rows per side, `isSmartDepth=false`) for ES and NQ, staying
  within 2 of IBKR's 3 simultaneous L2 slots. Every 5 s it records a settled snapshot into a
  720-entry memory ring (1 hour) and serves `GET /vertex-history/v1/depth-history?symbol=ES|NQ&since=<epoch>`
  with zero extra IBKR requests. `/v1/depth` reuses the live stream snapshot for ES and NQ when
  ready. Kill switch: `/etc/vertex-history/depth-off` cancels both L2 subscriptions within ~1 s
  without a restart; IBKR error 309 halts both subscriptions until restart.
- **Storage (`flow_book_snapshots`, migration 0094).** One row per `(symbol, captured_at)` for
  ES and NQ holding finite positive 1D arrays (`bid_prices`, `bid_sizes`, `ask_prices`,
  `ask_sizes`, max 20 levels per side), `best_bid`, `best_ask`, `min_tick`, `contract`, and
  `capture` (`'streamed'` or `'sampled'`). `upsertBookSnapshots` keeps `'streamed'` over
  `'sampled'` on key conflict. Retention: 7 days, pruned on the hourly collector sweep.
- **Dual-mode collector.** `flow.collect` reads `/v1/depth-history` first for ES and NQ; if the
  stream is `off`, `down`, or unreachable, it falls back to one-shot `/v1/depth` and stores a
  1-minute `'sampled'` snapshot. While the stream is `starting` (or `live` with no settled snapshot
  yet), the collector records `empty` and `/v1/depth` refuses one-shot `fetch_depth` so no
  duplicate L2 slot is opened. When the stream reports `halted`, the collector records
  `unavailable` and avoids adding another L2 request.
- **Read procedure and page.** `flow.liquidityHeatmap` (`GET /flow/liquidity-heatmap`, schema
  `flow-liquidity-heatmap.v1`) bins snapshots into up to 240 time columns (`15m -> 5s`,
  `30m -> 10s`, `60m -> 15s`, `120m -> 30s`, `240m -> 60s`, `390m -> 120s`; 60 s minimum when
  sampled-only) and up to 80 price buckets, normalizes intensity to the window 95th percentile,
  detects up to 10 persistent resting walls, projects the newest snapshot as right-edge DOM bars,
  and overlays large futures prints from `flow_large_trades` (up to 500). `FlowLiquidityHeatmapPanel`
  sits below Tape speed on `/flow` with dark/light-safe tokens, keyboard column scrubbing
  (`ArrowLeft`/`ArrowRight`/`Home`/`End`/`Escape`), `aria-live="polite"` inspection strip,
  and accessible wall and print tables.

## Hedging pressure (SPY, ES)

Design: [vertex-viz-hedging-pressure/design.md](designs/vertex-viz-hedging-pressure/design.md).
Research only: the line is an estimate of the underlying that dealers would buy or sell to
delta-hedge the stored option prints. It is not a trade signal and no engine reads it. Nothing
here places, changes or cancels an order.

Data: the stored rows of `flow_option_prints` only (no new table, no migration, no vendor call).
Symbol SPY reads SPY options; symbol ES reads SPX options, and its price is the SPX index. QQQ
and NQ have no stored option prints and no panel.

Rules (`HEDGING_PRESSURE_RULES`, version `hedging-pressure.v1`):

| Field | Value | Meaning |
| --- | --- | --- |
| `rate` | 0.04 | risk-free rate of the delta (`OPTIONS_CHAIN_RISK_FREE_RATE`, the options chain assumption) |
| `dividendYield` | 0.015 | dividend yield of the delta (the SPY yield of `DIVIDEND_YIELD`; SPX has the same index yield) |
| `volFallback` | 0.2 | volatility used when the stored IV is below 1% (the vendor sends 0.0477% on deep in-the-money prints) |

- **Range.** The prints of the options session (09:30 to 16:15 New York, end-exclusive) of the
  newest stored print's session date (`flowSessionDate`: a weekend or a pre-open print maps to the
  weekday before). Prints before 09:30 are not read.
- **Sign.** `above_ask` and `ask`: +1; `bid` and `below_bid`: -1; `mid` and `unknown`: no sign
  (`OPTION_SIDE_SIGN` in `flow-options.ts`, the same table as the cross-check of `flow.control`).
  The rule assumes that the dealer took the other side of every signed print.
- **Per print, in this order.** Count it. No sign: not signed. No `iv`, `dte` or
  `underlying_price`, or an input that the Black-Scholes delta refuses (not finite, a spot,
  strike or volatility of 0 or less): not priced. Else the delta at the print time
  (`bsDelta`, `T = max(dte, 0) ÷ 365`, `σ = iv ÷ 100`, or the fallback, counted as IV adjusted)
  and the hedge notional `sign × delta × size × 100 × underlying_price` (US dollars), added to
  the net sum and to the call or put sum.
- **Minutes.** One point per minute with at least one counted print (at most 405): the running
  sums at the end of the minute, the minute's own sum, its counted prints and the newest
  underlying price above 0 of any print up to the end of the minute. The largest rise and fall
  are the minutes with the largest positive and the most negative own sum (the first wins).
- **Frozen delta.** The delta is not updated as price and time move. The line is "signed delta at
  print time", not the dealers' current hedge need.
- **Read cap.** At most `HEDGING_READ_CAP` = 200,000 prints per session (the busiest stored day
  has 25,688). The read asks for one more; when it returns more, the newest are dropped and
  `truncated` is true.

Procedure `flow.hedgingPressure` (`GET /flow/hedging-pressure`, input `symbol` SPY or ES; operator
session; no API key; the read-only viewer account can call it as a GET procedure). It reads
`newestOptionPrintAt`, `readHedgingPrints` (the line's columns, ascending by `traded_at`, then
`id`, with the limit), `optionGaps` and the options sample, and returns
`flow-hedging-pressure.v1`:

- **Fields.** `symbol`, `ticker` (SPY or SPX), `session` (null when no print is stored: no points
  and zero totals), `rules`, `options` (the freshness row of the options source),
  `storedUntil` (the trade time of the newest counted print), `truncated`, `unread`, `totals`
  (prints, signed, not signed, not priced, IV adjusted; net, calls, puts and gross in US dollars;
  largest rise and fall) and `points`.
- **Unread.** The open gaps of the collector (section "Options paging and gaps") that overlap the
  session, as one span (the oldest start to the newest end, both clipped to the session) and
  their count. A filled gap adds prints to the past of the line.
- **Read cost.** One indexed read of the session's prints (measured: 15 ms of database time for
  25,688 rows), the gaps and the newest options sample per call. No cache. Target: under 300 ms.

Panel "Hedging pressure" on `/flow` (below the Tape speed panel, SPY and ES only):

- **Own call.** The page starts `flow.hedgingPressure` with each load and does not wait for it
  with the other calls. A forbidden answer shows the access screen, like tape speed. A symbol
  change clears the panel; the window select does not (the line covers the whole session).
- **States.** Loading ("Loading hedging pressure…"; the panel keeps its height). Failed: one error
  line ("Hedging pressure not loaded: ... · retrying with the next refresh at HH:MM ET"); the
  last response stays below it. Empty: "No option prints stored for <symbol> in the last 14
  days." No counted print: "No counted print in this session." and the counts.
- **Header.** "Session <date> · as of <HH:MM> ET · options <freshness>", plus the read cap note
  ("read cap reached, later prints not read" when no print was counted)
  when truncated and "Incomplete: prints of HH:MM–HH:MM ET not read yet; earlier parts of the line
  can still change." when `unread` is set.
- **Charts.** Stepped net (solid, foreground), call (dashed, info color) and put (dotted, warning
  color) lines from 09:30 to the end of the newest point's minute, a zero line, 3 to 5 y-axis
  labels in signed compact dollars and the unread span shaded (the legend names the shade only
  when the chart draws it); below it the underlying price with
  its low and high. Green and red are not used: a rising put line or a falling call line is
  normal. Each chart is an image with a text alternative (session, end values, largest rise and
  fall; low and high price).
- **Texts.** Totals ("Net · calls · puts · gross"), the largest rise and fall with their times,
  the counts, and the rule text built from `rules` (the dealer-side assumption, the frozen
  Black-Scholes delta with its rate, yield and fallback, the $10,000 minimum premium of the stored
  prints, the 09:30 start, research only, the version).
- **Fixtures.** `/lab/flow` shows the SPY case (a rise, then a fall, one open gap) and the ES case
  (prints that are not signed, not priced and IV adjusted).

## Put/call ratio (SPY, ES)

Design: [vertex-viz-pc-ratio-line/design.md](designs/vertex-viz-pc-ratio-line/design.md).
Research only: the lines describe gross put/call premium and volume ratios of the stored option
prints. They are not a trade signal and no engine reads them. Nothing here places, changes or
cancels an order.

Data: the stored rows of `flow_option_prints` only (no new table, no migration, no vendor call).
Symbol SPY reads SPY options; symbol ES reads SPX options, and its price is the SPX index. QQQ
and NQ have no stored option prints and no panel. `flow_net_drift` stores signed net values
(ask minus bid) and is not used.

Rules (`PUT_CALL_RATIO_RULES`, version `put-call-ratio.v1`):

| Field | Value | Meaning |
| --- | --- | --- |
| `minPremiumUsd` | 10000 | minimum print premium stored by the collector ($10,000) |
| `retentionDays` | 14 | retention window of `flow_option_prints` (calendar days) |
| `parity` | 1 | equal put and call reference line (1.00) |

- **Session range.** Regular options hours (09:30 to 16:15 New York, end-exclusive) of the newest
  stored print's session date (`flowSessionDate`). All stored prints in those hours count
  regardless of aggressor side.
- **Ratios.** Gross `putPremium / callPremium` and `putVolume / callVolume`; `null` when the call
  denominator is 0 (never `Infinity` or `NaN`).
- **Session series (`points`).** One point per minute with at least one print (at most 405):
  running cumulative sums and ratios from 09:30 ET, the minute's print count, and the carried-forward
  newest positive underlying price. `totals` records the session totals and the first-win high and
  low minutes of each running ratio.
- **Daily series (`days`).** One entry per stored weekday options session (09:30 to 16:15 New York,
  at most 20 sessions over a 20-day lookback, oldest first), aggregated directly in Postgres
  (`readOptionPrintMinutes` and `readOptionPrintDays`), with `incomplete: true` when any open
  `flow_option_gaps` range overlaps that session or its 09:30 ET open precedes the rolling 14-day
  retention cutoff (`now - 14 days`).

Procedure `flow.putCallRatio` (`GET /flow/put-call-ratio`, input `symbol` SPY or ES; operator
session; no API key; the read-only viewer account can call it as a GET procedure) returns
`flow-put-call-ratio.v1`.

Panel "Put/call ratio" on `/flow` (below the Hedging pressure panel, SPY and ES only):

- **Own call.** Starts with each load independently of the other panels, with its own loading,
  failure-with-retry, and forbidden hold states. Switching symbols clears the panel; changing the
  window does not.
- **Views.** Toggle between **Session** (stepped running premium and volume P/C lines with a 1.00
  parity line, open collector gap shade, underlying price, totals, session range and print counts)
  and **Days (N)** (daily session P/C lines with distinct circle/square markers, incomplete-session
  bands, underlying price and daily table).
- **Fixtures.** `/lab/flow` shows the SPY case (starts below parity, turns above parity, 8 stored
  sessions, one open gap on the newest session) and the ES case (SPX options, 8 stored sessions,
  no open gap).

## Options flow heatmap (SPY, ES)

Design: [vertex-viz-flow-strike-time-heatmap/design.md](designs/vertex-viz-flow-strike-time-heatmap/design.md).
Research only: the heatmap shows signed net option premium by strike and time bucket from stored
option prints. It is not a trade signal, and no trading engine reads it. Nothing here places,
changes, or cancels an order.

Data: stored rows of `flow_option_prints` and open `flow_option_gaps` only (no new table, no
migration, and no vendor call). Symbol SPY reads SPY options; symbol ES reads SPX options. QQQ and
NQ have no stored option prints and no panel.

Rules (`STRIKE_HEATMAP_RULES`, version `strike-heatmap.v1`):

| Field | Value | Meaning |
| --- | --- | --- |
| `minPremiumUsd` | 10000 | minimum print premium stored by the collector ($10,000) |
| `retentionDays` | 14 | retention window of `flow_option_prints` (calendar days) |
| `maxStrikes` | 20 | maximum strike rows returned, ranked by session gross premium |
| `defaultBucketMinutes` | 15 | default time bucket width (`5`, `15`, or `30` minutes) |

- **Session range.** Regular options hours (09:30 to 16:15 New York, end-exclusive) of the newest
  stored print's session date (`flowSessionDate`).
- **Signed net premium.** `readOptionPrintStrikeBuckets` groups rows in Postgres by
  `(strike, slotIndex, right, side)`. `packages/api/src/flow-strike-heatmap-rules.ts` classifies
  direction using `OPTION_SIDE_SIGN` from `packages/api/src/flow-options.ts`: bullish is call at
  ask/above ask or put at bid/below bid (`+1`), bearish is put at ask/above ask or call at
  bid/below bid (`-1`), and mid/unknown fills are unsigned (`0`, counted in `unsignedPrints` and
  included in `grossPremium`).
- **Slot prices and gaps.** `readOptionPrintSlotPrices` reads the newest positive finite
  `underlying_price` per slot via `DISTINCT ON` the slot expression ordered by `(slotIndex ASC,
  traded_at DESC, id DESC)`, and `foldStrikeHeatmap` carries prices forward across later slots. Any
  slot overlapping an open `flow_option_gaps` range is flagged `unread: true`.
- **Strike cap.** `strikes` and `cells` include the top 20 strikes by session `grossPremium`
  (sorted descending by strike). `slots` and `totals` aggregate all strikes in the session and
  report `omittedStrikes`, `omittedGrossPremium`, `omittedNetPremium`, and `omittedPrints`.

Procedure `flow.strikeHeatmap` (`GET /flow/strike-heatmap`, input `symbol` SPY or ES and optional
`bucketMinutes` `5 | 15 | 30`, default `15`; operator session; no API key; read-only viewer account
can call it as a GET procedure) returns `flow-strike-heatmap.v1`.

Panel "Options flow heatmap" on `/flow` (below the Put/call ratio panel, SPY and ES only):

- **Own call.** Runs in its own `loadStrikeHeatmap` sequence. Switching `5m` / `15m` / `30m` or
  clicking **Retry** refetches only `flow.strikeHeatmap` without refetching other panels or
  resetting the 60 s refresh timer.
- **Matrix and controls.** Scrollable strike × time table (`TableScroll`) with a sticky `Strike`
  column, diverging `oklab` semantic cell tints (`--color-success` / `--color-destructive`,
  10%–42% mix) plus explicit `+` / `-` / `$0` labels, dashed neutral borders for flat/unsigned
  active cells, hatched unread-gap shading, latest spot reference marker, roving-`tabIndex` arrow
  navigation, and a live cell inspector readout bar.
- **Fixtures.** `/lab/flow` renders deterministic SPY (23 strikes with 3 omitted, open collector
  gap, unsigned flat cell, spot between strikes) and ES (12 SPX strikes, exact-strike spot, no gap)
  responses across 5m, 15m, and 30m buckets.

## Option print bubbles (SPY, ES)

The option print bubbles panel overlays big stored option prints (`flow_option_prints`, premium
>= `$10,000`, retained 14 days) onto the intraday underlying price path of the newest options
session (`09:30` to `16:15` New York, end-exclusive) for `SPY` (SPY options) and `ES` (SPX
options). `QQQ` and `NQ` have no stored option prints and do not render this panel. Research only:
bubbles describe stored trades, never a trade signal. Design:
[docs/vertex-rebuild/designs/vertex-viz-option-bubbles/design.md](designs/vertex-viz-option-bubbles/design.md).

- **Underlying price path.** `readOptionPrintMinutes` supplies 1-minute `lastPrice` points and
  full-session print counts/gross premium across all stored prints. Any minute overlapping an open
  `flow_option_gaps` range is marked `unread: true`, and clipped gap ranges are returned in `gaps`
  and `unread` so the chart breaks the price line and shades unread intervals explicitly.
- **Big prints and cap.** `readLargeOptionPrints` selects prints with `premium >= minPremiumUsd`
  (`$100K`, `$250K` default, `$500K`, or `$1M`) ordered by `(premium DESC, traded_at DESC, id DESC)`
  up to `120 + 1` rows. `foldOptionBubbles` caps to the top 120 prints (setting `truncated: true`
  when more matched), maps stored `side` and `moneyness` to contract values, computes directional
  sign via `OPTION_SIDE_SIGN`, sorts returned bubbles chronologically (`at ASC, id ASC`), and
  counts prints without a positive finite `underlying_price` in `totals.unplottedBubbles` without
  fabricating coordinates.

Procedure `flow.optionBubbles` (`GET /flow/option-bubbles`, input `symbol` SPY or ES and optional
`minPremiumUsd` `100000 | 250000 | 500000 | 1000000`, default `250000`; operator session; no API
key; read-only viewer account can call it as a GET procedure) returns `flow-option-bubbles.v1`.

Panel "Option print bubbles" on `/flow` (between Put/call ratio and Options flow heatmap, SPY and
ES only):

- **Own call.** Runs in its own `loadOptionBubbles` sequence. Switching the minimum premium floor
  or clicking **Retry** refetches only `flow.optionBubbles` without refetching sibling panels or
  resetting the 60 s refresh timer.
- **Visual encoding (never color alone).** Bubble radius scales with square root of premium
  (with a 3-circle size legend); calls use `--color-success` with centered `C` glyph (`r >= 10`),
  puts use `--color-destructive` with `P` glyph; ask/above-ask fills are solid (`above_ask` and
  golden sweeps add an outer ring), bid/below-bid fills are hollow thick rings, and mid/unclassified
  fills are dashed rings. Includes client-side Right (`All`/`Calls`/`Puts`) and Side
  (`All sides`/`Ask-side`/`Bid-side`) filters, keyboard navigation (`ArrowLeft`/`ArrowRight`/
  `Home`/`End`/`Escape`), a pinned inspector strip, and a synced accessible top-prints table.
- **Fixtures.** `/lab/flow` renders deterministic SPY (mixed sides, golden sweeps, open collector
  gap, one unplotted print) and ES (SPX options, no gap) responses across all four premium floors.

## Net drift

Per symbol and turn the collector sends two requests to QuantData `net-drift` for the options
ticker and the session date (the newest weekday; before 09:30 the previous weekday): `total` (all expiries) and `zero_dte` (same day).
Both use the filter profile `otm-clean.v1`: out-of-the-money options only, without complex, floor,
tied and cancelled trades. Each answered bucket is upserted into `flow_net_drift` by ticker, part and
minute; a row is rewritten only when a value or the filter profile changed. No sums are stored;
`longer` is total minus `zero_dte` on read. The sample is `ok` when the newest `total` bucket started
at most 300 s ago, `empty` for no bucket or an older one, `unavailable` when `total` failed (a vendor
rate limit names its end time in ET). A failed `zero_dte` part is named in the message. A `total`
request refused for the caller reserve is `skipped` and stores no sample. Net drift is stale after
300 s (09:30 to 16:20 New York). The worst case of one run is 24 QuantData requests (4 net drift, 16
option pages, 3 GEX, 1 market premium) against 30 minus the caller reserve of 6.

## Market premium

Smart money PR 2 ([plan-pr2.md](designs/smart-money/plan-pr2.md)). The source `market_premium` is
market-wide: one QuantData `gainers-losers` request returns, for every ticker with at least one large
trade, the session totals of the trades with premium >= $100,000 each (filter profile
`premium-gte-100k.v1`: `premium >= 100000` and `isCancelled = false`; multi-leg trades count, each
leg as its own trade, as in QuantData's own tool). The source has no symbol of its own: its attempts
are recorded under SPY in `flow_samples`, so `flow.collect` with `symbols` that leave out SPY skips it.

Each run makes at most one request (`packages/api/src/server/flow-market-premium-collect.ts`):

1. **Live capture.** While options trade (09:30-16:15 New York, the options and GEX session), today's
   session is captured when its ledger row is missing or its last attempt is at least 840 s old
   (about every 15 minutes with the 60 s timer).
2. **Gap fill.** Otherwise the collector requests the oldest weekday of the last 400 days (before
   today) whose ledger row is missing, or is `partial` or `unavailable` and was last tried at least
   6 hours ago. This is the one-year backfill (about 280 weekdays at one request per run, about 5
   hours after the first deploy), the settle fetch of each live session after midnight, and the
   repair of missed sessions. QuantData kept at least 371 days on 2026-11-20.

Storage: `flow_market_premium` keeps one row per (session date, ticker); a capture replaces the
session's whole row set in one transaction (rows of older captures are deleted). An answer with
fewer than half the tickers the ledger holds for the session is not stored (`unavailable`, "answer
shrank"). `flow_market_premium_sessions` is the ledger: one row per session date with the status
`complete` (fetched on a New York day after the session date: final totals), `partial` (a live
capture: running totals), `no_data` (an answer without rows, including HTTP 422, fetched after the session date) or
`unavailable` (failed, no rows yet), the capture time, the ticker count, the attempt count and the
last message. A session with rows keeps its rows and status when a later attempt fails. Neither
table is pruned (about 0.2M rows and 260 ledger rows a year).

Read path: `smartMoney.ranking` (operator session or agent read key; MCP tool
`openbb_smart_money_ranking`; page `/smart-money`) sums the newest 1, 5 or 20 sessions with rows.
Its coverage reads today's ledger row: `fresh` when today's capture is at most 30 minutes old while
options trade, `stale` when it is older (or missing after the first 30 minutes; `overdueSince` names
the time), `never` before the first capture, `closed` outside that window. A complete session with
fewer than 50 tickers is a market holiday and takes no slot in the session window. The `/flow`
freshness strip does not list this source.

## Confluence

Three directional votes plus GEX as context:

| Factor | Bullish / bearish when |
| --- | --- |
| Order flow | delta ÷ volume over the stored minutes of the last 15 min ≥ +10% / ≤ −10% |
| Book | newest book pressure ≥ +20% / ≤ −20% |
| Options flow | (bullish − bearish premium) ÷ both over the last 30 minutes ≥ +15% / ≤ −15% |

Fewer than two known votes: "Not enough fresh data". Bullish and bearish votes together:
"Flows disagree". Two or more on one side and none on the other: "Flows agree". A source counts
only while it is fresh (or its market is closed, so the last session is shown).

On `/flow` this block is titled "Short-term factors (last 15 to 30 min)", and its badge counts the
factors ("2 of 3 short-term factors bullish", "Short-term factors split: 1 bullish, 1 bearish of 3",
"No short-term factor has data yet"). The page uses the word "agree" only for futures against options
(the control panel). The page shows the control panel of the selected symbol's group first
(symbols SPY, QQQ, ES, NQ), then a line that names what is not collected for QQQ and NQ, then the
snapshot; the freshness list is folded behind "Show sources" while every source is fresh.

## Control document

`flow.control` (`GET /flow/control`, input `group`: `sp500` or `nasdaq100`) returns
`flow-control.v1`: who is in control of one index group on the options side and the futures side,
the agreement of the two sides, the net drift series of the primary and the check ticker, a
cross-check, the study status and the freshness of the net drift and of the tape. Assembly: `packages/api/src/server/flow-control.ts`; rules and texts:
`packages/api/src/flow-control-rules.ts`. It is readable with an agent read key and by the viewer
role.

Options rules (`flow-control-rules.v1`, field `rules`):

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
`source_unavailable`, `storage_failed` (the answer came but could not be stored), `stale`, `gap`,
`session_start`, `not_collected`. The reason `sampled_tape` is removed from the contract, because
no instrument produces it any more: seven reasons remain. Each net
drift series has a parts status: `complete`, `partial` (the same-day part is missing or more than 5
minutes behind; the totals stay complete) or `no_data`. Points after the newest same-day bucket
have no `zeroDte` and `longer` values, and the part totals are taken at the last minute that has both
parts.

Futures rules (`flow-futures-rules.v1`, the new top-level field `futuresRules` of the document):

| Field | Value | Meaning |
| --- | --- | --- |
| `windowMinutes` | 30 | trailing window, as on the options side |
| `enterRatio` | 0.30 | a control side starts at or above this ratio |
| `exitRatio` | 0.10 | a control side ends below this ratio |
| `minMinutes` | 5 | minutes in a row at or above `enterRatio` |
| `minBuckets` | 10 | covered minutes needed in the window |
| `maxMissingMinutes` | 5 | minutes of the window, since 09:30, that may lack coverage |
| `minCoveredSeconds` | 55 | a minute counts when the tape covers at least this many of its seconds |
| `minTrades` | 10 | deep trades needed in the window for an entry |

The futures state comes from the streamed tape of the group's future. It exists only from 09:30 to
16:00 New York time.

- **Ratio.** Over the covered minutes of the window: deep-trade buy volume minus deep-trade sell
  volume, divided by their sum; 0 when the window holds no deep trade. The range is -1 to +1.
- **Entry checks.** A ratio at or beyond the enter ratio counts toward an entry only when all three
  checks pass. The field `hold` reports the first failed check, in this order (null when none
  fails, when the ratio is inside the enter ratio, or while a side is in control):
  - `few_trades`: the window holds fewer than `minTrades` deep trades.
  - `delta_against`: the delta of all prints in the covered minutes of the window does not have the
    sign of the ratio.
  - `price_against`: the last price (the close of the newest covered minute) is not on the ratio's
    side of the window VWAP (above it for buying, below it for selling).
- **State.** `buyers` starts after 5 minutes in a row in which the ratio is at or above the enter
  ratio and the checks pass. It ends when the ratio falls below the exit ratio. The checks gate the
  entry only: they do not end a state, and the exit follows the ratio alone, as on the options
  side. `sellers` is the mirror; otherwise the state is `balanced`. The start time (`since`) is the
  first minute of the run that entered. The minute in progress is left out. The futures side is
  never `mixed`.
- **No data.** The reasons apply in this order: `market_closed`; `storage_failed` or
  `source_unavailable` (the newest tape sample failed and no `ok` sample is inside the stale
  limit); `stale` (the newest stored `ok` tape read is older than 180 s); `session_start` (fewer
  than 10 minutes have passed since 09:30); `gap` (the window holds fewer than 10 covered minutes,
  or more than 5 of its minutes since 09:30 are not covered). Holidays and half days are not
  modelled: on a weekday holiday the futures side computes a state from 09:30 while the options side
  has no data (agreement `not_comparable`), and after an early close the futures line reads stale
  until 16:00.
- **Gap rule.** A gap ends a running futures state, and the next state needs a new entry: the tape
  of a gap cannot be read later. The options fold carries its state through a gap, because the
  vendor's net drift of a gap is read again later. The fold runs to the newest stored minute,
  covered or not, so a state also ends when more than 5 of the newest minutes are stored without
  coverage; `asOf` stays the end of the newest covered minute. A minute without a covered row
  breaks the entry count: a state starts only after 5 covered minutes in a row.
- **Fields of the futures side.** The state, `ratio` (the ratio before the checks), `since`, the
  window, the inputs (net and total deep volume, covered minutes), and two new fields: `hold` and
  `trades` (deep trades in the window).
- **Start values.** The numbers of the futures rules are start values; `minTrades`,
  `minCoveredSeconds` and `maxMissingMinutes` have no source. A state-stability count after the
  first 5 streamed sessions may change the numbers under a new version. The continuation study is
  run again after 20 streamed sessions.

Agreement (`agreement.state`, with `agreement.since`):

| State | When (futures state, options state) | Direction |
| --- | --- | --- |
| `agree` | both `buyers`, or both `sellers` | bullish or bearish |
| `diverge` | one `buyers` and the other `sellers` | neutral |
| `one_sided` | one is `buyers` or `sellers` and the other is `balanced` | neutral |
| `both_balanced` | both `balanced` | neutral |
| `not_comparable` | either is `no_data`, or the options state is `mixed` | neutral |

`since` is the later start time of the two sides for `agree` and `diverge`, and null otherwise. Only
`agree` counts as agreement. The agreement is not tested as an entry rule yet, and the panel says
so.

The `freshness` list has one new row for the tape of the group's future (source `ticks`), after the
net drift rows.

The `deepTrades` block lists the deep trades of the group's future from 09:30 to 16:00 New York: the
limit, the capture mode (`streamed` for ES and NQ when no deep-trade row of the session is
`sampled`), the signing method (`quote`, `tick`, or null when the rows of the session hold both or
the session has no row), sums, the newest 60 trades with the total count, the
minutes with their covered seconds, absorption marks, and the coverage of the trailing rule window
(covered seconds of the window, from `flow_minutes.covered_seconds`; the window ends after the
newest stored minute when that is at most 2 minutes behind the last ended minute of the clock, so
the minute the collector has not stored yet does not count as a gap; otherwise it ends after the
last ended minute of the session. The clock minute is not clamped to 16:00, so the same rule
covers the 15:59 row, which the collector stores some seconds after 16:00).
`levels` gives the session open, high and low
of the primary ticker from one-minute closes and the previous close (the last bucket at or before
15:59 of the weekday before). `session.event` is `fomc` when `openbb_event_calendar` holds a row of
kind `fomc_meeting` and source `federal_reserve` for the session date (job `fed-events`); when that
read fails, the notes say the calendar was not read and there is no FOMC mark. The cross-check compares stored SPX option prints with the vendor ratio (sp500 only; it never changes a
state). It is `not_comparable` when the fold window lies outside the range the prints were read for
(the prints of the options session up to now are read). The study line reads the stored study
`flow-control-continuation`.

Measured time of one `flow.control` call after the deploy: not measured yet (target under 300 ms).

## Freshness

Per source: `fresh`, `stale` (older than 10 min for sampled ticks (SPY), 180 s for the streamed
tape of ES and NQ (`FLOW_TAPE_STALE_SECONDS`), 3 min for depth, 5 min for options, 30 min for GEX
while its market is open), `closed` (market closed; last session shown) or `never`.
Net drift is stale after 5 min (session 9:30-16:20 New York); its freshness is in `flow.control`
only. `flow.control` also has one freshness row for the tape of the group's future (source `ticks`,
stale after 180 s, Globex session). Snapshot freshness lists only the sources a symbol collects (QQQ: depth and GEX; NQ: ticks, depth
and GEX).
Sessions: options and GEX 9:30-16:15 New York; SPY extended hours; ES Globex (Sunday 18:00 to
Friday 17:00, daily break 17:00-18:00). Holidays are not modelled.

## Retention

The collector prunes each table with its own cutoff, at most once an hour (`FLOW_RETENTION_DAYS` in
`packages/api/src/server/flow-collect.ts`): 730 days for `flow_net_drift`, `flow_large_trades`, `flow_minutes` and `flow_gex`, 14 days for every other
flow table except `flow_market_premium` and `flow_market_premium_sessions`, which are never pruned. `flow_gex` was kept 14 days
until 2026-11-22. It is kept 730 days so that the gamma flip of every session stays available for the forward test of the
bearish put-spread rule ([spec](../specs/strategies/bearish-put-spread.md)); a rollback to a 14-day build deletes the older rows. `flow_minutes` was kept 14 days before the streamed tape. It is kept 730 days so that
the continuation study can replay the futures state of every streamed session; the value applies
to all four symbols. A build from before the streamed tape prunes `flow_minutes` at 14 days again:
within 14 days a rollback to it deletes no row; after that it deletes the older minutes that the
study needs. A build from before net drift does not prune `flow_net_drift`, so a rollback to it
deletes no net drift row.

`flow_tape_seconds` is not pruned: single prints exist only in the memory of `vertex-history`, so
its counts cannot be collected again, and a later burst study sets the cutoff. Estimate: about
0.65 kB per row and 2,760 rows per trading day (two symbols), so about 0.45 GB per year without
index and backup overhead. The deploy subsection "Tape speed (migration 0091)" has the size query;
set a cutoff before the table passes 2 GB. A build from before the table does not write or read it.

`flow_book_snapshots` is pruned at 7 days (`FLOW_RETENTION_DAYS.flow_book_snapshots = 7`) on the hourly
collector sweep so continuous 5 s L2 history stays bounded.

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
"storage: write failed (<error class>)", no SQL text), and the run goes on with the next source. Any
other error inside one source reads "collector failed (<error class>)", so the control panel does not
name storage for it. When
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
- Tape coverage says that the stream was live. It is not checked against a second source: IBKR
  sends no sequence number, so the service does not see a print that is lost without a sign. A
  continuous check of the tape against IBKR history is a future improvement.
- A stall of both trade streams in the regular session without an IBKR notice lasts up to 30
  minutes and shows as a gap. The service has no market calendar, so it requests new subscriptions
  for two silent tape feeds only after 30 minutes without a print.
- The trading engine's own tick-by-tick subscriptions were not counted. The slot test accepted 8
  tick-by-tick subscriptions at the same time and did not find the IBKR cap. When IBKR refuses a
  tape subscription with error 10190, the tape stops until the process restarts.
- The tape of a gap cannot be read later: the ring is in memory only, and the collector does not
  fall back to sampled ticks.
- Exhaustion events are not produced for ES and NQ (section "Features and events").
- After an outage of the collector of more than 10 minutes, the minutes before the look-back limit
  are not read back, although the ring can still hold them. A catch-up from the newest stored
  minute is a future improvement.
- The tape is read while the Globex session is open. The last minute before the daily break
  (16:59 New York) is not stored, and the minute before it is read once only: no read happens in
  the break, and the first read after it starts at the look-back limit (its sample carries the
  note "older minutes skipped"). These minutes are outside the regular session, so the futures
  state does not use them.
- SPY ticks stay sampled, so SPY totals cover only the sampled seconds.
- A failed per-second write of the tape speed counts is not caught up: the collector does not read
  back minutes that lack a `flow_tape_seconds` row, although the ring can still hold them.
- The tape speed burst rule is version 1 and is not tested as a signal. Its baseline is a mean, so
  a strong burst raises the limit of the next 10 minutes and later bursts are marked less. It is
  measured on one afternoon; the night session and the open are not measured yet.
- A page read between the two writes of one collector run shows the newest minute of the tape
  speed panel as "collected, but no per-second counts" until the next reload.

## Terms

QuantData terms (quantdata.us/legal/terms): personal use, no redistribution. `/flow` is operator-only
on the tailnet and nothing is redistributed. QuantData allows 240 requests per 60 s per account,
shared with `/charts` and the market-watch bot; the shared client keeps its own limits
(`packages/api/src/server/quantdata-client.ts`), and the collector's caller reserve keeps 6 of the
client's 30 starts per 60 s free for `/charts`. No new paid provider was added. The tick-by-tick
streams of the streamed tape cost no IBKR fee.

Words of the streamed tape that the page shows:

- **Streamed tape:** the prints that the tape feeds of `vertex-history` deliver for ES and NQ.
- **Covered second:** an exchange second between two received prints of one live trade stream that
  are at most 60 s apart. The column `flow_minutes.covered_seconds` counts them per minute.
- **Covered minute:** a minute with at least 55 covered seconds.
- **Coverage:** the share of covered seconds in a time range. It says that the stream was live. It
  does not prove that no print was lost.

## Continuation study

The options-side continuation study tests the options side of the flow control signals with modelled fills
(research only): code in `services/research/strategies/flow_control/`, spec in
[flow-control-continuation.md](../specs/strategies/flow-control-continuation.md), operator guide in
[the study README](../../research/backtests/flow-control-continuation/README.md). Futures results are modelled from
index prices and option prices from Black-Scholes; the futures and options agreement is not tested. The study is run
again after 20 streamed sessions, and it then replays the futures state from the stored rows. The panel's study
line reads the stored study `flow-control-continuation`. Store it with
`bun run vertex:research-studies:import < <out>/study.json` after the dry run. The download and the study run on the
research machine and never on the trading server.

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

Deep trades and catalog terms (migrations 0078 and 0081; 0076 is already applied on the base, and 0081 does not depend on 0079 or 0080):

1. Apply `packages/db/migrations/0078_flow_large_trades.sql` alone, then
   `packages/db/migrations/0081_semantic_terms_flow_control.sql` alone, each with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container.
2. Check that `flow_large_trades` exists, that `vertex_research` has SELECT, INSERT, UPDATE and
   DELETE on it, and that the three term rows `options_net_drift`, `futures_deep_trades` and
   `flow_control_state` exist.
3. Check the calendar: `select count(*) from openbb_event_calendar where kind = 'fomc_meeting' and
   date >= current_date` (0 means no FOMC mark until the job `fed-events` runs).
4. Deploy the app; `vertex-history` does not change.
5. Rollback: deploy the previous app. `packages/db/rollback/0078_flow_large_trades.down.sql` and
   `packages/db/rollback/0081_semantic_terms_flow_control.down.sql` are not the rollback path.

### Streamed tape (service 1.5.0, migration 0083)

The order is that of the plan, section 9
([flow-streaming-tape/plan.md](designs/flow-streaming-tape/plan.md)). No deploy between 08:30 and
16:00 New York time.

1. Owner answer: the owner answers the question about the four tick-by-tick subscriptions. No
   probe and no deploy before a yes.
2. RTH probe: a read-only script runs the tape-feed code of the pull request with its own client id
   on QuantVPS from 09:28 to 09:40 New York time. If one of its pass rules fails, nothing is
   deployed and the plan is revised.
3. After 16:00 New York time: merge with `scripts/merge-pr`.
4. Install `vertex-history` 1.5.0 with the existing install script
   (`infra/quant-vps/history/install-history.sh`). It runs the service tests on the server before it
   installs, and it keeps a copy of the previous program file. One restart of `vertex-history`
   only: this deploy does not restart the gateway, the trading engine or a trading container.
5. Apply `packages/db/migrations/0083_flow_capture_streamed.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container. It widens the
   check constraint on `flow_large_trades.capture` to accept `streamed`.
6. Deploy the app through `infra/quantvps/restart-when-idle.sh`.
7. Live check the same evening: `/health` of the service, one collector run, the stored rows, and
   the tape of one window against `/ticks`. The next regular session repeats the comparison and
   checks the futures state, the agreement line and the coverage sentence on `/flow`.
8. Rollback: deploy the previous app with the same script; it runs on the migrated database and
   writes `sampled` only, so the widened check constraint stays. To remove the streams, create the
   off-switch file `/etc/vertex-history/tape-off`; the service can stay at 1.5.0 and needs no
   restart. `packages/db/rollback/0083_flow_capture_streamed.down.sql` is not the rollback path: it
   deletes the streamed deep trades and runs only on an explicit owner decision. The previous app
   prunes `flow_minutes` at 14 days again (section "Retention").

### Flow control term texts (migration 0084)

1. Apply `packages/db/migrations/0084_semantic_terms_flow_streamed_tape.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container. It needs 0081.
2. Check that the descriptions of `futures_deep_trades` and `flow_control_state` name the streamed
   tape and no longer hold `sampled_tape`. A row with an operator mark keeps its text.
3. Deploy the app (`infra/quantvps/restart-when-idle.sh`) for the new MCP tool descriptions.
4. Rollback: deploy the previous app. The 0084 texts stay correct while the app has the streamed tape
   (migration 0083). Run the down script only when the app goes back to before the streamed tape: it
   restores the 0081 texts only while both rows still have the 0084 text and no operator mark.
   Otherwise it stops with the error `refusing rollback` and changes nothing.

### Market premium (migration 0088)

Deploy after 16:00 ET or before 08:30 ET (owner rule 2026-11-16). The tick script does not change.

1. Pause the timer: `systemctl stop vertex-flow.timer`.
2. Apply `packages/db/migrations/0088_flow_market_premium.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container (never
   `db:migrate`).
3. Check that `flow_market_premium` and `flow_market_premium_sessions` exist, that `vertex_research`
   has SELECT, INSERT, UPDATE and DELETE on the first and SELECT, INSERT and UPDATE on the second,
   and that `flow_samples_check` lists `market_premium`.
4. Deploy the app with `infra/quantvps/restart-when-idle.sh`.
5. Start the timer: `systemctl start vertex-flow.timer`. The gap fill then stores the past year at
   one session per run (about 5 hours); `select status, count(*) from flow_market_premium_sessions
   group by 1` shows the progress.
6. Rollback: deploy the previous app; it runs on the migrated database and leaves both tables alone.
   `packages/db/rollback/0088_flow_market_premium.down.sql` is not the rollback path: before it
   runs, a person must delete the `market_premium` rows of `flow_samples`, and it drops the stored
   sessions (the gap fill can fetch them again only while QuantData keeps them).

### Tape speed (migration 0091)

Deploy after 16:00 ET or before 08:30 ET (owner rule 2026-11-16). The migration adds one table and
locks no existing table. The tick script and `vertex-history` do not change.

1. Apply `packages/db/migrations/0091_flow_tape_seconds.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container (never
   `db:migrate`).
2. Write probe. The collector's dry run does not write, so it cannot find a missing grant. Run this
   in `psql -v ON_ERROR_STOP=1`; it must end without an error and print `1` and then `0`:

   ```sql
   BEGIN;
   SET LOCAL ROLE vertex_research;
   INSERT INTO flow_tape_seconds (contract, contracts, covered, minute, symbol, total_trades, trades)
   VALUES ('PROBE', array_fill(0, ARRAY[60]), repeat('1', 60), '2000-01-03 00:00:00+00', 'ES', 0,
           array_fill(0, ARRAY[60]))
   ON CONFLICT (symbol, minute) DO UPDATE SET contract = excluded.contract,
     contracts = excluded.contracts, covered = excluded.covered,
     total_trades = excluded.total_trades, trades = excluded.trades
   WHERE excluded.total_trades >= flow_tape_seconds.total_trades;
   SELECT count(*) FROM flow_tape_seconds WHERE minute = '2000-01-03 00:00:00+00';
   DELETE FROM flow_tape_seconds WHERE minute = '2000-01-03 00:00:00+00';
   SELECT count(*) FROM flow_tape_seconds WHERE minute = '2000-01-03 00:00:00+00';
   ROLLBACK;
   ```

3. Deploy the app with `infra/quantvps/restart-when-idle.sh`. It restarts `vertex-web` only.
4. Page check with headless Chrome and the viewer account: `/flow` shows the Tape speed panel.
   In a closed market the window ends at the last session, and the panel shows that session
   shaded as "Collected, but no per-second counts".
5. Checks with a live tape. The collector reads no tape while the Globex session is closed, so
   after a deploy in a closed market run them after the first two collector runs of the next
   session (Sunday 18:00 New York time for a weekend deploy):
   - The journal of the last runs, on QuantVPS: `journalctl -u vertex-flow.service -n 40 --no-pager`.
     The ES and NQ tape messages must not hold `per-second counts not stored`.
   - The newest rows:
     `select symbol, max(minute), count(*) filter (where minute > now() - interval '10 minutes') from flow_tape_seconds group by 1`.
     Each symbol has one row per complete minute, and its newest minute is at most 3 minutes old.
   - The page shows counted bars, and one `flow.tapeSpeed` call takes less than 300 ms.
   - The size of the table: `select pg_size_pretty(pg_total_relation_size('flow_tape_seconds'))`.
   A fault is fixed forward: nothing but the per-second counts is affected.
6. Rollback, two paths:
   - A defect in the read or in the panel: revert those commits and deploy forward. The collector
     keeps storing counts.
   - A defect in the collector step: deploy the previous app. It runs on the migrated database
     and does not write or read the table. That period leaves a permanent hole in the per-second
     counts.
   `packages/db/rollback/0091_flow_tape_seconds.down.sql` is not a rollback path: it drops the
   stored counts, which cannot be collected again. It runs only on an owner decision, after
   `systemctl stop vertex-flow.timer`.

### Liquidity heatmap (service 1.7.0, migration 0094)

Deploy after 16:00 ET or before 08:30 ET (owner rule 2026-11-16). The migration adds one table and
locks no existing table.

1. Apply `packages/db/migrations/0094_flow_book_snapshots.sql` alone with
   `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container (never
   `db:migrate`).
2. Write probe as `vertex_research` in `psql -v ON_ERROR_STOP=1` (must print `1` then `0`):

   ```sql
   BEGIN;
   SET LOCAL ROLE vertex_research;
   INSERT INTO flow_book_snapshots (
     ask_prices, ask_sizes, best_ask, best_bid, bid_prices, bid_sizes,
     capture, captured_at, contract, min_tick, symbol
   ) VALUES (
     ARRAY[6000.25], ARRAY[10], 6000.25, 6000.0, ARRAY[6000.0], ARRAY[12],
     'streamed', '2000-01-03 00:00:00+00', 'PROBE', 0.25, 'ES'
   ) ON CONFLICT (symbol, captured_at) DO UPDATE SET capture = excluded.capture;
   SELECT count(*) FROM flow_book_snapshots WHERE captured_at = '2000-01-03 00:00:00+00';
   DELETE FROM flow_book_snapshots WHERE captured_at = '2000-01-03 00:00:00+00';
   SELECT count(*) FROM flow_book_snapshots WHERE captured_at = '2000-01-03 00:00:00+00';
   ROLLBACK;
   ```

3. Deploy `vertex-web` with `infra/quantvps/restart-when-idle.sh`. The collector immediately
   records 1-minute `sampled` L2 snapshots even before `vertex-history` upgrades.
4. Upgrade `vertex-history` to 1.7.0 under `/opt/vertex-history` (backup first, run
   `test_vertex_history.py`, copy `vertex_history.py`, restart `vertex-history` off-hours,
   verify `/vertex-history/v1/health` shows `depth.off = false`, `depth.halted = null`, and
   `depth.feeds.ES`/`NQ` live).
5. Rollback: `sudo touch /etc/vertex-history/depth-off` disables continuous L2 streaming within
   1 s without restart; optional DB rollback uses
   `packages/db/rollback/0094_flow_book_snapshots.down.sql` after stopping `vertex-flow.timer`.

## Agent semantic layer

Agents read these features through the read-only MCP tools `flow_snapshot` (SPY, QQQ, ES or NQ;
the same `flow-snapshot.v1` document as the page) and `flow_control` (`flow-control.v1` of one
group). The catalog (`docs/vertex-rebuild/agent-semantic-layer.md`) holds three uncertified terms
with source `none` (migration 0081): `options_net_drift`, `futures_deep_trades` and
`flow_control_state`. Each points to the tool `flow_control`.

Migration `0084_semantic_terms_flow_streamed_tape` (card `vertex-flow-terms-streamed-tape`) replaces
the 0081 texts of `futures_deep_trades` and `flow_control_state`, which said that the tape is sampled
and that the futures side is `no_data` with the reason `sampled_tape`. The new texts say:

- The deep trades come from the streamed tape (capture `streamed`). Coverage means that the stream
  was live and is not checked against a second source. A session with a sampled part has the capture
  `sampled`, and its sums are lower bounds.
- The futures side has a state from the deep-trade ratio over the covered minutes. `hold` names the
  first failed entry check and is null when no entry is checked. A gap ends a futures state.
- The seven no-data reasons, the five agreement states and the field `futuresRules`.

0084 changes a row only while the row has the 0081 text (md5) and no operator mark (edit,
certification or certification note). The guarded rollback
`packages/db/rollback/0084_semantic_terms_flow_streamed_tape.down.sql` restores the 0081 texts. The
MCP descriptions of `flow_control` and `flow_snapshot` changed the same way (`flow_snapshot`: ES and
NQ from the streamed tape, SPY from sampled ticks, QQQ without trades). The recorded semantic-layer
eval was recorded again for these texts (`docs/vertex-rebuild/agent-semantic-layer.md`). The streamed
tape adds no new agent tool.
