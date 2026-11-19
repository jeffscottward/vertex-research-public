# Flow control signals: implementation plan for pull request 2 (deep trades, tick turns and agent terms)

- **Author:** Jeff Scott Ward
- **Status:** Reviewed and resolved (2026-11-16)
- **Date:** 2026-11-15

This document is the detailed implementation plan of pull request 2 of the design [Flow control signals](design.md). It builds on the plan of pull request 1 ([plan-pr1.md](plan-pr1.md)) and uses its names. It is a plan: it holds no implementation code.

Path rule (scripts/docs/docs.ts, `findBrokenDocPaths`): a backticked span that contains "/" and starts with a repository top-level folder must name an existing file. A file that does not exist yet (created by pull request 1 or by this one) is written as plain text without backticks, and no `#symbol` suffix is used.

## Detailed Implementation Plan

### PR 2: Deep trades, tick turns, session levels and event, catalog terms

Scope: design sections 4 (deep trades on the sampled tape, tick schedule), 6 (the blocks `deepTrades`, `levels`, `session.event`; the futures side and the agreement stay without a state), 7 (deep trades section), 8, 9 item 2 and 11. This is one pull request. Deep trades ship on the sampled tape now, whatever the owner decides about completing the futures tape (design, Open Questions). No existing ES behaviour changes: ES keeps its quote request, its signing and its `large_print` limit of 50. This pull request builds no futures fold and no agreement logic: the futures side is `no_data` with the reason `sampled_tape`, and the agreement is `not_comparable`. Research and display only; no order, arming or risk path is touched.

Interfaces: this pull request changes no oRPC or OpenAPI contract (`flow-control.v1` and `packages/api/openapi.json` stay as they are). It does change MCP tool definitions (files 24 and 41) and deletes two unused exports of the contract file (file 42).

Facts from the code that the plan depends on (each was read at commit `417166b2`; line numbers refer to that commit):

- The `large_print` limit is the registry field `largePrint`: 50 for ES and 10,000 for SPY (`packages/api/src/flow-features.ts:24-40`); `totalMinute` counts a print with `trade.size >= instrument.largePrint` and makes a `large_print` event (`:199-203`, event text `:141-152`, event key `print:${t}:${price}:${size}:${venue}` at `:145`). Pull request 1 sets NQ `largePrint: 10`. This pull request does not change any `largePrint` value.
- A signed print is `SignedTrade { t (seconds), price, size, venue, conditions, side: "buy" | "sell" | "unknown", method: "quote" | "tick" | "none", bid, ask }` (`packages/api/src/flow-trade-signing.ts:12-27`); `signTrades(trades, quotes)` keeps the IBKR order inside one second (`:67-72`) and returns the prints sorted by `t` (`:76-77`). The tick-rule side depends on the previous different price inside the sample (`:92-100`).
- Tick schedule today: `FLOW_DUE_SECONDS.ticks = 230`, `FLOW_TICKS_STAGGER_SECONDS = 110` (not exported), `FLOW_IBKR_MAX_RECENT = 2`, `FLOW_TICKS_STARVED_SECONDS = 350`, `FLOW_IBKR_MAX_RECENT_STARVED = 4` (`packages/api/src/server/flow-collect.ts:47-70`). `ticksBlocked(state, symbol)` staggers against the newest tick attempt of any symbol and adds 2 to the window count per fetch (`:179-206`, the `+ 2` at `:204`). `collectTicks` is at `:208-251`; it already declares the locals `last` (a minute row, `:233`) and `first` (a print, `:239`). The collector timer runs every 60 s.
- The collector asks for quotes always: `quotes: true` (`packages/api/src/server/flow.ts:121-127`). This does not change: every tick symbol, NQ included, fetches trades and quotes (2 IBKR requests). The vertex-history service does not change.
- Flow repository: insert-once methods use `insertOnce` with `onConflictDoNothing().returning(...)` (`packages/db/src/server/flow.ts:181-212`); `FLOW_UPSERT_BATCH = 250` (`:37`); `FlowWindowQuery.to` is inclusive (`:41-44`). Migration 0053 ends with a hand-added grant block (`packages/db/migrations/0053_flow_option_gaps.sql:10-19`); its rollback is `packages/db/rollback/0053_flow_option_gaps.down.sql`.
- Migration numbers: `0076_research_screen` is the newest migration on the base branch. Pull request 1 takes 0077 (`0077_flow_net_drift`). This pull request expects 0078 (`flow_large_trades`) and 0079 (`semantic_terms_flow_control`). The rule is the next free number at build time (`CONVENTIONS.md:90-92`); when the base gains a migration first, run `pnpm db:renumber` and then `pnpm db:generate`, which must print "No schema changes" (`CONVENTIONS.md:94-105`), and reset any local or preview database that applied the old numbers (`CONVENTIONS.md:109`). Every number below is written for 0078 and 0079 and moves with the renumber.
- Note 2026-11-19 (build): two other migrations took 0079 and 0080 first, so the terms migration of this plan was built as `0081_semantic_terms_flow_control`. Where this plan says "0079" for the terms migration, its snapshot or its journal entry, read 0081; the 0081 snapshot equals the 0080 snapshot except `id` and `prevId`.
- Event calendar: the table `openbb_event_calendar` (`packages/db/migrations/0064_openbb_sources.sql:19-29`) is filled by the OpenBB job `fed-events`; the job writes rows of kind `fomc_meeting` from the Federal Reserve events calendar and warns when no future meeting is listed (`services/openbb/vertex_openbb/jobs/fed.py:134`, `:284-291`). Such a row is dated on the second meeting day with time 14:00 and source `federal_reserve` (`services/openbb/tests/fixtures/fed-events.json:27-44`). `OpenbbRepository.events(from, to, kinds)` reads by date range and kind (`packages/db/src/server/openbb.ts:179-183`, `:303-320`). The API helper `repositoriesFor` throws `STORAGE_ERROR` when the repository is missing (`packages/api/src/server/openbb.ts:67-77`), so this plan does not use it. The feed keeps 30 days back and all future rows (`docs/vertex-rebuild/openbb.md:89`), which is enough for the current or last session.
- Catalog seed 0074 is one `INSERT ... ON CONFLICT ("id") DO NOTHING` with ten columns (`packages/db/migrations/0074_semantic_terms_trend_indicators.sql`); its rollback refuses when a row was edited, certified, noted or has a SQL attribute. Its tests: `packages/db/src/server/semantic-terms-trend-indicators-migration.test.ts`, `tests/integration/database/semantic-terms-trend-indicators.test.ts`, `tests/integration/semantic-layer/trend-terms.test.ts`. The existing term `drift_level` has the synonym `drift` (`packages/db/migrations/0056_semantic_layer.sql:104`). The sorted catalog is pinned in `tests/integration/database/semantic-layer.test.ts:107-125`.
- The eval replay compares a digest of every model input (`inputDigest`, `tests/integration/semantic-layer/harness.ts:204-220`; the tool definitions are hashed at `:213`). Plan mode offers every read-only MCP tool (`packages/api/src/server/assistant-runtime.ts:116`, `:141`), and `tests/integration/semantic-layer/read-tools.test.ts:35-75` must hold one call per read tool (`:123-124`). So a changed tool description makes all 90 recorded trials stale, and new terms change the `terms_list` result (`docs/vertex-rebuild/agent-semantic-layer.md:229` for the tool list, `:233` for the terms catalog). The flow procedures read a module clock (`setFlowClockForTesting`, `packages/api/src/server/flow.ts:48`) that the harness does not set today.

Decisions used below (from the design and pull request 1):

- No-data reasons: `FLOW_NO_DATA_REASONS` of pull request 1 holds seven values in priority order: `market_closed`, `source_unavailable`, `stale`, `gap`, `session_start`, `sampled_tape`, `not_collected`. `partial` is not a reason; it is a value of `partsStatus` on each net drift series. For the futures side the order is `market_closed`, `source_unavailable`, `stale`, then `sampled_tape`.
- Agreement: `FLOW_AGREEMENT_STATES` holds only `not_comparable`. There is no agreement function besides `describeAgreement(futures, options)` of pull request 1, which this pull request does not change.
- Contract (pull request 1, every object `.strict()`): the side object has no `sincePrecisionSeconds`, and its `inputs` are `numerator`, `denominator` and `rows` only. `deepTrades` has `limitSize`, `signing` (`quote`, `tick` or null), `capture` (only `sampled`), `coverage`, `sums`, `trades` (each with `signing`), `totalTrades`, `minutes` (`minute` is a timestamp, plus `coveredSeconds`) and `absorptions`.
- The MCP tool `flow_control` is added in this pull request, not in pull request 1, so the eval recording changes once.
- Tick turns: every tick symbol fetches trades and quotes (2 requests), so each turn serves one symbol. The turns go round SPY, ES and NQ (`[["SPY"], ["ES"], ["NQ"]]`). The IBKR gate keeps its thresholds and is applied per fetch as today.
- Deep-trade limit: a new registry field per future, separate from `largePrint`: ES 40 and NQ 10 contracts, measured 2026-11-13. One pass over the signed prints of a sample gives the deep-trade rows (size at or above the deep-trade limit) and the existing events (the `large_print` events at or above `largePrint`); both are stored in one write.
- A meeting without a decision (26 and 27 October 2027) is also a `fomc_meeting` row and is marked like the others; the page says "FOMC meeting day".

#### 1. `packages/db/src/schema/flow.ts` (Modify)

- **Type / Scope**: Drizzle schema.
- **Proposed Changes**: Export `FLOW_TRADE_SIDE_VALUES = ["buy","sell"] as const`, `FLOW_SIGNING_VALUES = ["quote","tick"] as const`, `FLOW_CAPTURE_VALUES = ["sampled"] as const` (one value, as in the contract; a later migration widens the check when another capture mode is built) and the types `FlowTradeSideValue`, `FlowSigningValue`, `FlowCaptureValue`. New table `flowLargeTrades` (`flow_large_trades`), columns in the file's alphabetical order: `capture text NOT NULL` (`.$type<FlowCaptureValue>()`), `limit_size double precision NOT NULL`, `price double precision NOT NULL`, `sampled_at timestamptz NOT NULL`, `second timestamptz NOT NULL`, `seq integer NOT NULL`, `side text NOT NULL` (`.$type<FlowTradeSideValue>()`), `signing text NOT NULL` (`.$type<FlowSigningValue>()`), `size double precision NOT NULL`, `symbol text NOT NULL` (`.$type<"ES" | "NQ">()`). Primary key (`symbol`, `second`, `seq`). Check `flow_large_trades_check`: `symbol in ('ES', 'NQ')` (deep trades are futures only; `symbolCheck` would also allow SPY and QQQ) and `side in ('buy', 'sell')` and `signing in ('quote', 'tick')` and `capture in ('sampled')` and `seq >= 0` and `price > 0` and `limit_size > 0` and `size >= limit_size`. No extra index (range reads use the key). The header comment (line 16) names the per-table retention.

#### 2. packages/db/migrations/0078_flow_large_trades.sql (Create)

- **Type / Scope**: Migration, written by `pnpm db:generate --name flow_large_trades` (same command and fallback as file 11 of plan-pr1.md) and then edited. Its number is the next free one after pull request 1's 0077 (see the facts).
- **Proposed Changes**: Generated part: `CREATE TABLE "flow_large_trades"` only. Hand-added part at the end, copied from `packages/db/migrations/0053_flow_option_gaps.sql:10-19`: a comment (the collector inserts, `flow.control` reads, prune deletes) and the `DO $$ ... IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_research') THEN GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flow_large_trades" TO "vertex_research"; END IF; ... $$;` block. No statement starts with `ALTER`, `UPDATE`, `DELETE`, `INSERT`, `TRUNCATE` or `DROP`; these words appear only inside the `GRANT` list.

#### 3. packages/db/migrations/meta/0078_snapshot.json (Create)

- **Type / Scope**: Generated artifact (JSON class "generated", `scripts/ci/json-data.ts:34-38`).
- **Proposed Changes**: Written by the command of file 2. Its `prevId` is the `id` of pull request 1's 0077 snapshot, and it includes every table of the base (the `research_screen_*` tables of 0076 included). Never edited by hand.

#### 4. `packages/db/migrations/meta/_journal.json` (Modify)

- **Type / Scope**: Generated artifact.
- **Proposed Changes**: Two new entries written by drizzle-kit: `0078_flow_large_trades` (command of file 2) and `0081_semantic_terms_flow_control` (command of file 32). Each `when` is newer than the one before (`packages/db/src/server/migration-journal.test.ts:87`). Never edited by hand (`CONVENTIONS.md:86`).

#### 5. packages/db/rollback/0078_flow_large_trades.down.sql (Create)

- **Type / Scope**: Guarded reversal, same form as `packages/db/rollback/0053_flow_option_gaps.down.sql`.
- **Proposed Changes**: Header comment: this file is not the rollback path (the rollback is "deploy the previous app"; it runs on the migrated database and ignores the table); dropping the table loses every stored deep trade, and they cannot be fetched again; check `select count(*) from flow_large_trades` first; the Drizzle ledger row stays. Body: `BEGIN; SET LOCAL search_path = pg_catalog, public; SET LOCAL row_security = off; LOCK TABLE "public"."flow_large_trades" IN ACCESS EXCLUSIVE MODE; DROP TABLE "public"."flow_large_trades"; COMMIT;`. No cascade, no `IF EXISTS`.

#### 6. `packages/db/src/server/flow-migration.test.ts` (Modify)

- **Type / Scope**: Unit test of migration SQL and rollback (no database).
- **Proposed Changes**: New `describe("0078_flow_large_trades migration")`: "only creates flow_large_trades and grants the app role" (no statement that starts with `TRUNCATE`, `UPDATE`, `DELETE`, `INSERT`, `DROP` or `ALTER`; contains the grant line); "matches the drizzle columns, key and check of flow_large_trades" (through `getTableConfig`, as lines 49-68 do); "has a journal entry with its tag" (finds the tag; pins no index and no neighbour, `CONVENTIONS.md:111`); "the rollback drops only flow_large_trades, without cascade".

#### 7. `packages/db/src/server/flow.ts` (Modify)

- **Type / Scope**: Flow repository (Drizzle only).
- **Proposed Changes**:
  - `export type FlowLargeTradeRecord = typeof flowLargeTrades.$inferSelect`; `export type FlowLargeTradeQuery = Readonly<{ symbol: "ES" | "NQ"; from: Date; to: Date }>`. `FlowPruneTable` (pull request 1) gains `"flow_large_trades"`.
  - `insertTickSample(input: Readonly<{ events: readonly FlowEventRecord[]; trades: readonly FlowLargeTradeRecord[] }>): Promise<Readonly<{ events: number; trades: number }>>`: one `database.transaction` that inserts all events of one futures tick sample (every kind: `large_print`, absorption, stacked imbalance, exhaustion) and its deep-trade rows, both in batches of `FLOW_UPSERT_BATCH` with `onConflictDoNothing().returning(...)`; returns the counts of new rows. Either both kinds are stored or none. An existing key is never rewritten (the first sample that saw a second wins). Inside the transaction the deep-trade rows are inserted first and the events second. With no events and no trades it opens no transaction and returns zeros. The executor offers a transaction: `DatabaseExecutor = Database | Transaction` (`packages/db/src/server/client.ts:11-12`), and `packages/db/src/server/research-studies.ts:173` and `packages/db/src/server/openbb.ts:531` already call `database.transaction`.
  - `readLargeTrades(query: FlowLargeTradeQuery): Promise<FlowLargeTradeRecord[]>`: `symbol` equal, `from <= second < to` (end-exclusive, unlike `FlowWindowQuery`; the doc comment says so), ordered by `second`, then `seq`, ascending.
  - `netDriftPriceAtOrBefore(ticker: FlowOptionTickerValue, at: Date): Promise<Readonly<{ minute: Date; price: number }> | null>`: the newest `flow_net_drift` row with `ticker` equal, `part = 'total'`, `minute <= at` and `underlying_price is not null` (`order by minute desc limit 1`). The filter on `part` lets the primary key (`ticker`, `part`, `minute`) serve the query. Used for the previous close.
  - `prune(cutoffs)`: one more delete, `flow_large_trades` by `second`.

#### 8. `packages/db/src/server/flow.test.ts` (Modify)

- **Type / Scope**: Unit test with a mocked executor.
- **Proposed Changes**: Update "deletes from each flow table before its own cutoff and sums removed rows" (one more table). New cases: "inserts the events and the large trades of one sample in one transaction and counts only new rows"; "writes nothing and opens no transaction for no input"; "stores neither kind when one insert fails"; "reads the large trades of a symbol and time range in second and seq order, end-exclusive"; "returns the newest total net drift price at or before a time, or null" (the mocked SQL has the `part = 'total'` predicate).

#### 9. `packages/db/src/server/index.ts` (Modify)

- **Type / Scope**: Public server surface of the database package.
- **Proposed Changes**: Add `FlowLargeTradeRecord` and `FlowLargeTradeQuery` to the flow type re-export block.

#### 10. `tests/integration/database/database.test.ts` (Modify)

- **Type / Scope**: Integration test (real Postgres, all migrations applied).
- **Proposed Changes**: Add `flow_large_trades: "symbol,second,seq"` to the table list after `flow_gex` (line 87).

#### 11. packages/api/src/flow-deep-trades.ts (Create)

- **Type / Scope**: Pure leaf module: turns the deep prints that `buildMinuteFeatures` found into deep-trade rows. It does not compare sizes itself: the one detection pass is `totalMinute` (`packages/api/src/flow-features.ts:199`), which file 13 extends to return the prints at or above the deep-trade limit as `deepPrints`. So the deep-trade rows and the events of a sample come from the same pass, and the collector stores both in one write (files 15 and 7).
- **Proposed Changes**:
  - `export type FlowDeepTradeRow = Readonly<{ symbol: "ES" | "NQ"; second: Date; seq: number; side: "buy" | "sell"; size: number; price: number; limitSize: number; signing: "quote" | "tick"; capture: "sampled"; sampledAt: Date }>` (same shape as `FlowLargeTradeRecord`).
  - `export const deepTradesOf = (instrument: FlowInstrument, deepPrints: readonly SignedTrade[], sample: Readonly<{ first: number; last: number }>, sampledAt: Date): Readonly<{ rows: readonly FlowDeepTradeRow[]; unsigned: number }>`. `sample.first` and `sample.last` are the smallest and largest `t` over all prints of the fetched sample (file 15). Deep prints in the first and the last sampled seconds are dropped, because the sample edge can cut those seconds: only prints with `first < t < last` are used. Within each remaining second, `seq` restarts at 0 and counts the deep prints of that second in input order (IBKR order). `seq` is counted before the side is looked at, so the key of a print does not depend on the signing. A numbered print gives a row only when its `method` is `quote` or `tick`; a deep print with method `none` is not stored and adds 1 to `unsigned`. `limitSize = instrument.deepTradeLimit`, `signing = method`, `capture = "sampled"`, `second = new Date(t * 1000)`. Prints are never added up. An instrument with `deepTradeLimit` null gives no rows.
  - `export type FlowDeepMinute = Readonly<{ minute: number; buyVolume: number; sellVolume: number; trades: number }>` (`minute` = whole minutes after 09:30 New York of the session).
  - `export const sumDeepTradesByMinute = (rows: readonly FlowDeepTradeRow[], sessionOpen: Date): readonly FlowDeepMinute[]`: one entry per minute that has a deep trade, ascending; rows before `sessionOpen` are left out.

#### 12. packages/api/src/flow-deep-trades.test.ts (Create)

- **Type / Scope**: Unit test of file 11 (100% of lines and branches).
- **Proposed Changes**: Cases: "returns one row per deep print inside the sample"; "leaves out the first and the last sampled second"; "returns nothing for no deep print and for a sample of fewer than three seconds"; "numbers the deep trades of one second in print order"; "does not add up same-side prints of one second"; "keeps the signing method and the limit on each row"; "does not store a deep print whose signing is none, counts it as unsigned and still numbers it"; "returns no rows for an instrument without a deep-trade limit"; "two overlapping samples give the same keys for the seconds both hold complete" (one tape through `signTrades` and `buildMinuteFeatures`; sample A = seconds 0 to 90, sample B = seconds 60 to 150, deep prints in seconds 61 to 89; for these seconds both give equal `second`, `seq`, `size`, `price` and `limitSize`; `side` and `signing` are not compared, because both rules depend on what else the sample holds); "an ES print of 40 contracts is a deep trade and no large_print event, and one of 50 is both" (through `buildMinuteFeatures`); "sums buy and sell volume per session minute and drops rows before the open".

#### 13. `packages/api/src/flow-features.ts` (Modify)

- **Type / Scope**: The instrument registry and the minute features.
- **Proposed Changes**:
  - `FlowInstrument` gains `deepTradeLimit: number | null` (contracts; null for instruments without deep trades) and `deepTradeLimitMeasuredOn: string | null` (ISO date of the measurement). Values: ES `deepTradeLimit: 40`, NQ `deepTradeLimit: 10`, both `deepTradeLimitMeasuredOn: "2026-11-13"`; SPY and QQQ both null. The doc comment says: the size that about the largest 0.1% of prints reach (14 samples of 1000 prints per market, 2026-11-13); separate from `largePrint`, which keeps its value and its meaning. `largePrint` does not change for any instrument (ES 50, NQ 10 from pull request 1).
  - NQ gains `ticks: "trades_and_quotes"` and `sources: ["ticks", "depth", "gex", "net_drift"]`. The type of `ticks` stays `"trades_and_quotes" | "none"`.
  - `MinuteFeatures` gains `deepPrints: readonly SignedTrade[]`: the prints of the sample with `trade.size >= instrument.deepTradeLimit`, in time order, collected in the same `totalMinute` pass that counts `large_print`; empty when `deepTradeLimit` is null. No rule in `totalMinute` changes. Futures have `offExchange: false`, so a futures print never becomes an `off_exchange_print` event.

#### 14. `packages/api/src/flow-features.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: "describes SPY and ES" keeps `largePrint: 50` for ES (line 46) and adds `deepTradeLimit: 40`. New cases: "ES and NQ carry the measurement date of their deep-trade limit; SPY and QQQ have none"; "NQ lists the ticks source and fetches trades and quotes"; "buildMinuteFeatures returns the deep prints at or above the deep-trade limit, and none without a limit". The case "returns nothing for no trades" (line 124) expects `deepPrints: []` too. The registry cases of pull request 1 keep passing (NQ now maps to four sources).

#### 15. `packages/api/src/server/flow-collect.ts` (Modify)

- **Type / Scope**: The collector run.
- **Proposed Changes**:
  - Export `FLOW_TICKS_STAGGER_SECONDS` (value 110 unchanged). Add `export const flowTickTurns = (instruments: Readonly<Record<FlowSymbol, FlowInstrument>>): readonly (readonly FlowSymbol[])[]`: one turn per symbol whose `ticks` is `trades_and_quotes`, in `FLOW_SYMBOLS` order. After this pull request: `[["SPY"], ["ES"], ["NQ"]]`.
  - `ticksBlocked(state, symbol)` does not change: each fetch is one turn of one symbol and spends 2 requests, as today. Seed runs keep their present exemption from the stagger and the starved test. With `FLOW_DUE_SECONDS.ticks = 230` and the stagger of 110 s against the newest tick attempt of any symbol, the symbols take turns in `FLOW_SYMBOLS` order (SPY, ES, NQ), and each symbol is fetched once per three turns. With the 60 s timer this is about 3 × 120 s = 360 s (it was about 240 s for SPY and ES). Timer cadence (decided by the integration owner on 2026-11-16; a technical constant, the IBKR share does not change): the collector timer runs every 60 s, so a turn starts at the first run at least 110 s after the previous tick attempt, in practice every 120 s, and each symbol is fetched about every 360 s. `FLOW_TICKS_STARVED_SECONDS` therefore changes from 350 to 410 (the seventh 60 s timer run after the attempt), so a symbol uses the starved gate (limit 4) only when its normal turn was missed; normal fetches keep the limit 2. A starved fetch at 420 s still comes before `FLOW_STALE_SECONDS.ticks` (600 s).
  - `collectTicks`, for a future (`instrument.kind === "future"`): after `signTrades`, when `signed.length > 0`: `const sample = { first: signed[0].t, last: signed[signed.length - 1].t }` (named `sample`, so it does not clash with the locals `first` and `last`); `const deep = deepTradesOf(instrument, features.deepPrints, sample, state.deps.now)`. When `signed` is empty there are no deep trades and no call. The events and `deep.rows` are stored together with `repository.insertTickSample({ events: features.events, trades: deep.rows })` in place of `storeEvents`. A dry run stores nothing and reports the counts it would write (as `store()` does: `rows.length`). The message gains `; <n> deep trades, <new> new, <u> deep prints without a side` for futures only (`<n>` = `deep.rows.length`, `<new>` = the `trades` count returned, `<u>` = `deep.unsigned`); `items` stays the minute count. SPY keeps `storeEvents` and its message.
  - `FLOW_RETENTION_DAYS.flow_large_trades = 730` (the map of pull request 1; `pruneIfDue` already builds one cutoff per key).
  - The doc comment of `FLOW_TICKS_STARVED_SECONDS` (lines 60-67) says: "The 60 s timer starts a turn about every 120 s; three turns (360 s) fit below 410 s, so a symbol is starved only when its normal turn was missed, and it still gets a sample before /flow calls ticks stale (600 s). The turn guard test of flow-collect.test.ts (turns × 120 s ≤ 410 s) fails when a fourth turn is added."
  - QuantData: this pull request adds no QuantData request. The collector's QuantData calls keep the caller reserve of pull request 1 (`withCallerReserve(…, FLOW_QUANTDATA_CALLER_RESERVE)`).

#### 16. `packages/api/src/server/flow-collect.test.ts` (Modify)

- **Type / Scope**: Unit test with a fake repository.
- **Proposed Changes**: The fake repository gains `insertTickSample`. Updated case: "fetches ticks for one symbol and staggers the other" becomes "fetches the SPY turn and staggers ES and NQ" (both `staggered: another tick sample 0 s ago`). The pacing cases (lines 464-596) keep their thresholds and texts; where they name ES, NQ gets the same answer. New cases: "the turns times the turn length stay inside the starved limit" (`flowTickTurns(FLOW_INSTRUMENTS).length * FLOW_TICKS_STAGGER_SECONDS <= FLOW_TICKS_STARVED_SECONDS`; the case also asserts the turn list `[["SPY"], ["ES"], ["NQ"]]` and the value 360, so a new turn must be reviewed here; a fourth turn, 480 s, fails the inequality); "the three symbols take turns: SPY, then ES 120 s later, then NQ"; "stores the events and the deep trades of a future in one write, and SPY events as before"; "does not call the deep-trade detector for an empty sample"; "counts new deep trades and deep prints without a side in the message"; "stores nothing on a dry run and reports the counts"; "prunes flow_large_trades with the 730-day cutoff".

#### 17. `packages/api/src/server/flow.ts` (Modify)

- **Type / Scope**: The `flow.*` procedures.
- **Proposed Changes**: The tick request (line 125) does not change. `readFlowControl` (pull request 1) takes one more repository, `openbb: OpenbbRepository | undefined`, read directly as `context.repositories.openbb` in the `control` handler (possibly `undefined`), the way pull request 1 reads `researchStudies`; it never calls `repositoriesFor`. It also reads:
  - `repository.readWindow({ symbol: group.future, from, to })` over `optionsSessionRange` for both groups (minutes and events; `crossPrints` stays `window.prints` for sp500 and null for nasdaq100; `optionGaps` only for sp500). This read also returns books and GEX rows, which are not used; the existing method is kept rather than adding a narrower one.
  - `repository.readLargeTrades({ symbol: group.future, from, to })` over `futuresSessionRange` (09:30 to 16:00, end-exclusive; a print at 16:00:00 is outside the session).
  - The previous close through `const readPreviousClose = async (repository, ticker, sessionDate): Promise<number | null>`: `prevDay` = the weekday before `sessionDate`; `row = netDriftPriceAtOrBefore(ticker, 15:59 New York on prevDay)`; no row gives null. If the row's New York date D is earlier than `prevDay` (a holiday lay between), the row may be a bucket after 15:59 of D, so read again with `at` = 15:59 New York on D and use that row. A row before 09:30 New York of its own date gives null. On a half day the value is the last bucket at or before 15:59, not the 13:00 close (holidays are not modelled, as `packages/api/src/server/flow-snapshot.ts:28` states).
  - The session event through `const readSessionEvent = async (openbb, sessionDate): Promise<FlowSessionEventRead>` (the type lives in file 21, so no import cycle arises), with `openbb.events(sessionDate, sessionDate, ["fomc_meeting"])`. Every case returns the object: a row with `source === "federal_reserve"` gives `{ event: "fomc", calendar: "read" }`; no such row gives `{ event: null, calendar: "read" }`; no repository or a thrown error gives `{ event: null, calendar: "not_read" }` (the control read never fails because of the calendar).
  - The latest `ticks` samples of `group.future` (`flow.latestSamples`) are part of `samples` for both groups (pull request 1 reads the samples of the tickers' symbols; for nasdaq100 these are QQQ and NQ, for sp500 SPY and ES).

#### 18. `packages/api/src/server/flow.test.ts` (Modify)

- **Type / Scope**: Unit test of the procedures.
- **Proposed Changes**: "wires history and QuantData into the collector" keeps `quotes: true` for every tick symbol and adds NQ. "reads prints and gaps only for sp500" becomes "reads the future's window for both groups and gaps only for sp500". New cases: "reads the deep trades of the group's future for the futures session"; "previous close: the last bucket of the day before, one more read after a holiday, null without a row and for a pre-market row"; "session event: fomc for a federal_reserve fomc_meeting row of the session date, null without a row, null for a row of another source, each with calendar read"; "session event is not_read without the repository and when the read throws, and the document is still returned".

#### 19. packages/api/src/flow-control-rules.ts (Modify)

- **Type / Scope**: Pure leaf module of pull request 1. New futures text function; no futures fold, no new rule number, no change to `FLOW_CONTROL_RULES`, `describeSide`, `describeAgreement` or their templates.
- **Proposed Changes**:
  - `export type FlowFuturesSideFacts = Readonly<{ instrument: string; reason: "market_closed" | "source_unavailable" | "stale" | "sampled_tape"; cause: string | null; newestSampleEt: string | null; staleMinutes: number; sessionDate: string }>`.
  - `export const describeFuturesSide = (facts: FlowFuturesSideFacts): FlowText`, with the rows below. `<F>` is the futures instrument, `<cause>` the message of the newest `unavailable` sample, `<t>` the time of the newest `ok` sample (`HH:MM ET`), `<s>` `staleMinutes`, `<d>` the session date. A detail longer than 300 characters is cut to 300.

| Case | `label` | `detail` |
| --- | --- | --- |
| `sampled_tape` | `Futures: deep trades only (sampled tape, no state)` | `<F> deep trades are listed below; a futures state needs the full tape` |
| `market_closed` | `Market closed` | `The <F> deep-trade window is 09:30 to 16:00 ET; the last window was <d>` |
| `source_unavailable` | `No answer from IBKR ticks` | `<cause>`, or `the last request failed` when `cause` is null |
| `stale`, with an `ok` sample | `Futures ticks are stale` | `Newest <F> tick sample is <t>; stale after <s> min` |
| `stale`, `newestSampleEt` null | `Futures ticks are stale` | `No <F> tick sample since 09:30 ET; stale after <s> min` |

- The `sampled_tape` and `not_collected` rows of `describeSide` (pull request 1) stay; the futures side no longer uses them. The agreement text stays `describeAgreement(futures, options)` of pull request 1 ("Cannot compare", `<label>: <detail>` of the futures side). No text of the new table holds a word that the status-language test rejects.

#### 20. packages/api/src/flow-control-rules.test.ts (Modify)

- **Type / Scope**: Unit test of file 19 (100%).
- **Proposed Changes**: New cases: one per row of the `describeFuturesSide` table; "cuts a futures detail at 300 characters"; "the futures texts take the instrument, time, stale minutes and date from the facts" (changed facts change the text). The golden fixture of pull request 1 (packages/api/src/fixtures/flow-control-golden.fixture.json) is not changed: no futures case is added.

#### 21. packages/api/src/server/flow-control.ts (Modify)

- **Type / Scope**: Pure assembly of `flow-control.v1` (pull request 1).
- **Proposed Changes**:
  - `FlowControlRows` gains `largeTrades: readonly FlowDeepTradeRow[]`, `tape: readonly FlowMinuteRow[]`, `tapeEvents: readonly FlowEventRow[]`, `previousClose: number | null`, `sessionEvent: FlowSessionEventRead`. New `export type FlowSessionEventRead = Readonly<{ event: "fomc" | null; calendar: "read" | "not_read" }>`. New `export const futuresSessionRange = (date: string): Readonly<{ from: Date; to: Date }>` = `{ from: newYorkTime(date, 570), to: newYorkTime(date, 960) }` (09:30 and 16:00 New York). Every deep-trade field uses this range; the tape read of file 17 uses `optionsSessionRange` and is filtered to this range here.
  - `futures` side: always `no_data`. The reason is the first rule that applies (`ticks` samples of `group.future`; S = `FLOW_STALE_SECONDS.ticks`; `from` = `futuresSessionRange(newYorkClock(now).day).from`):

| Order | Condition | Reason | Facts for `describeFuturesSide` |
| --- | --- | --- | --- |
| 1 | `now` is not on a weekday or is outside `futuresSessionRange` of its New York day | `market_closed` | `sessionDate` = `rows.sessionDate` |
| 2 | the newest `ticks` sample has the status `unavailable` and no `ok` sample is at most S seconds old | `source_unavailable` | `cause` = that sample's message |
| 3 | `now − max(newest ok sample time, from) > S` seconds; with no `ok` sample at all the newest time is `from` (newest samples with the status `empty` or `skipped` count as no `ok` sample) | `stale` | `newestSampleEt` = `etClock` of the newest `ok` sample, or null; `staleMinutes` = S / 60 |
| 4 | otherwise | `sampled_tape` | none |

- Shape of the futures side: `{ instrument: group.future, state: "no_data", noDataReason: <reason>, direction: "neutral", label and detail from describeFuturesSide, since: null, asOf: the newest ok tick sample time or null, ratio: null, enterRatio: FLOW_CONTROL_RULES.enterRatio, windowStart: null, windowEnd: null, inputs: { numerator: null, denominator: null, rows: deepTrades.totalTrades } }`. These are exactly the keys of `FlowControlSideSchema`; no ratio and no state are computed from deep trades. The `not_collected` futures branch of pull request 1 is removed.
- `agreement`: no change in code: `{ state: "not_comparable", direction: "neutral", since: null }` with `describeAgreement(futures, options)`.
- `deepTrades` (R = `futuresSessionRange(rows.sessionDate)`; the session minute index n of a time x is `floor((x − R.from) / 60 000)`):
  - `symbol` = `group.future`; `limitSize` = `FLOW_INSTRUMENTS[group.future].deepTradeLimit`; `capture` = `"sampled"`.
  - `signing`: the one method when every session row has the same `signing`; null when the rows mix `quote` and `tick` or there is no row.
  - `coverage`: `end` = `min(now, R.to)`. When `end <= R.from`: `{ seenSeconds: 0, windowSeconds: windowMinutes × 60, share: null }`. Else m = n of `end`, capped at 389 (so after 16:00 m is the last minute of the stored session, 15:59); `windowSeconds = min(windowMinutes, m + 1) × 60`; `seenSeconds` = the sum of `coveredSeconds` of the tape rows of `group.future` with n in (m − `windowMinutes`, m]; `share = seenSeconds / windowSeconds`, or null when no tape row has n in 0..389.
  - `sums` over the rows in R: `buyVolume`, `sellVolume`, `netVolume = buyVolume − sellVolume`, `cumulativeFrom` = `R.from`, or null without a row.
  - `trades`: newest first, at most `FLOW_CONTROL_MAX_TRADES`, each `{ at: second, side, size, price, signing }`; `totalTrades` = the row count in R.
  - `minutes`: one entry per tape row of `group.future` in R (a sampled minute), ascending, at most `FLOW_CONTROL_MAX_MINUTES`: `minute` = the tape row's `minute` (= `R.from + n × 60 s`), `buyVolume` and `sellVolume` from the `sumDeepTradesByMinute(rows, R.from)` entry with the same n (0 when there is none), `coveredSeconds` = the tape row's `coveredSeconds` (from `flow_minutes.covered_seconds`). A minute without a tape row has no entry.
  - `absorptions`: the `absorption` events of `tapeEvents` in R, newest first, at most `FLOW_CONTROL_MAX_ABSORPTIONS`, each `{ at, direction, price, detail }` as stored.
- `levels`: `{ ticker: primaryTicker, sessionOpen, sessionHigh, sessionLow, previousClose, source: "one_minute_closes" }` from the `underlyingPrice` of the primary ticker's rows from 09:30 to 16:00 (the `total` row of a minute, else the `zero_dte` row): first, largest, smallest; each null without a price; `levels` is null when the session has no priced row and no previous close.
- `session.event = rows.sessionEvent.event`.
- `notes`: remove "Futures deep trades are not collected yet."; add, in this order, "Deep trades are single prints of at least <limit> contracts on <future>, from a sampled tape; sums are lower bounds.", "Futures sides come from the quote rule where the sampled quotes cover a print, else from the tick rule; no futures control state is shown until the full tape exists.", "Session levels are from one-minute closes of <ticker>; on a half day the previous close is not the official close.", "Coverage is approximate: it comes from flow_minutes.covered_seconds, which counts the edge seconds that deep-trade detection leaves out.", on an event day "FOMC meeting day (Federal Reserve calendar).", and for `calendar: "not_read"` "The event calendar was not read; no FOMC mark for this session." The total stays within `FLOW_CONTROL_MAX_NOTES` (12).
- `freshness`: no change (pull request 1 lists one `net_drift` row per ticker). The futures tick age is shown by the futures side (`asOf` and the `stale` reason).

#### 22. packages/api/src/server/flow-control.test.ts (Modify)

- **Type / Scope**: Unit test of file 21 (100%).
- **Proposed Changes**: Replace "returns the futures side as no_data not_collected and an empty deep trades block" by "futures side is no_data in the stated order: market_closed, source_unavailable, stale, sampled_tape; no ratio is computed", with one case per row of the reason table, plus "stale without any ok tick sample" and "stale when the newest samples are empty or skipped". Update "agreement is not_comparable with the futures cause" to the new futures label. New cases: "deep trades block: limit, session sums, newest 60 of the total, sampled minutes only with their covered seconds, absorption marks"; "signing is the one method of the rows, null for mixed rows and for no row"; "coverage: share of the trailing window, shorter window at the open, null without a tape minute, last stored minute after 16:00, empty before 09:30"; "levels from one-minute closes with the previous close, null parts and a null block"; "session.event is fomc on a meeting day and null on another, with its note"; "adds the note when the calendar was not read"; "both groups still pass the contract schema" (`FlowControlSchema.parse`, which rejects any extra key).

#### 23. `apps/web/src/features/flow/view-model.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: The case of pull request 1 "names what is not collected for QQQ and NQ and nothing for SPY and ES": NQ now lacks option prints only (`notCollectedLine` is built from the registry, so the source file does not change).

#### 24. `packages/api/src/server/mcp.ts` (Modify)

- **Type / Scope**: MCP tool table. The tool is new in this pull request (moved here from pull request 1).
- **Proposed Changes**:
  - New entry after `flow_snapshot` (lines 521-529): `name: "flow_control"`, `title: "Who is in control (futures and options flow)"`, `procedure: "flow/control"`, `input: FlowControlInputSchema`, `readOnly: true`, description: "Read-only control document for one index group (group: sp500 or nasdaq100): options state from net drift (buyers, sellers, balanced, mixed or no_data with a reason), since when, the measured ratio next to its limit, net drift totals per option ticker; deep trades of the future (single large prints of ES or NQ on a sampled tape, each with its signing method: list, sums of the sampled trades, coverage, absorption marks); session levels, an FOMC meeting day mark, freshness and the continuation study status. The futures side is no_data with the reason sampled_tape until the full tape exists, so the agreement is not_comparable. Catalog terms: options_net_drift, futures_deep_trades, flow_control_state. Read the enums, not the label text. A no_data side has a reason: report it and do not estimate. Research only; never a trade instruction."
  - Remove the pin of pull request 1: `flow_snapshot` uses `input: FlowSnapshotInputSchema` again (four symbols); the import at line 33 changes back; the pin comment of pull request 1 is deleted. The description says "SPY, QQQ, ES or NQ" in place of "SPY or ES" (line 525), with one added sentence: "QQQ has no sampled trades and no option prints; NQ has no option prints."
  - A read-only tool is offered in Plan mode (`packages/api/src/server/assistant-runtime.ts:116`), and the tool JSON is part of the eval digest (`tests/integration/semantic-layer/harness.ts:213`), so this entry makes every recorded eval trial stale (file 38).

#### 25. apps/web/src/features/flow/control-view-model.ts (Modify)

- **Type / Scope**: Pure view-model of the control panel (pull request 1).
- **Proposed Changes**: New exports, all pure. No literal may contain a word that the status-language guard rejects (`apps/web/src/status-language.test.ts:36-52`).
  - `deepTradesLimitLine(deep): string | null`: "A deep trade is one print of at least <limitSize> contracts on <symbol>." plus a signing sentence from `deep.signing`: `tick` gives "Sides come from the tick rule."; `quote` gives "Sides come from the quote rule."; null with rows gives "Sides come from the quote rule where a quote was seen, else from the tick rule; the tick rule signed <k> of the <n> trades listed." (k and n counted over `deep.trades`); null without rows gives no second sentence. The line is null when `limitSize` is null.
  - `deepTradesCoverageLine(deep): string`: "Tape seen: about 31% of seconds in the last 30 min (558 of 1,800 s). Busy periods are seen least: each fetch holds the newest 1000 prints, which span less time when trading is busy. The figure is approximate: it counts the first and last second of each sample, which deep-trade detection leaves out. Every sum is a lower bound."; a null share gives "Tape seen: no sampled second in this window yet."
  - `deepTradesSum(deep): Metric`: label "Sum of sampled deep trades since 09:30 ET", value "+212 contracts (buy 520, sell 308)".
  - `export type DeepTradesChart = Readonly<{ width: 320; height: 96; segments: readonly string[]; zeroY: number; min: number; max: number }>`. `buildDeepTradesChart(deep): DeepTradesChart`: values are the running signed sum (buy minus sell) at each entry of `deep.minutes`. n = the minutes after 09:30 of the entry; x = `n / 389 × 320`; `min` and `max` over the values and 0; y = `4 + (max − value) / (max − min) × 88`, or 48 when `max === min` (the same frame as `buildNetDriftChart` of pull request 1). One segment per run of consecutive n, as `x,y` pairs with one decimal joined by a space, so an unsampled stretch is a visible gap. A run of one minute is drawn from x to x + 1 at its y. No minutes: no segments, `min` and `max` 0, `zeroY` 48.
  - `deepTradeRows(deep): readonly Readonly<{ key: string; time: string; side: "Buy" | "Sell"; tone: Tone; size: string; price: string; signing: "tick rule" | "quote rule" }>[]` (time "10:42:07 ET"; tone `success` for Buy and `destructive` for Sell, as `STATE_TONE` does for buyers and sellers); `deepTradesMoreLine(deep): string | null` ("Showing the newest 60 of 143 deep trades").
  - `absorptionMarks(deep): readonly Readonly<{ key: string; time: string; text: string }>[]` ("10:40 ET", the server `detail` plus " at 6,870.50" when a price exists).
  - `sessionEventLine(control): string | null` ("FOMC meeting day."); `levelsLine(control): string | null` ("SPX session (from one-minute closes; on a half day this is not the official close): open 6,852.10, high 6,880.40, low 6,841.00, previous close 6,848.30"; a missing part reads "no value yet").
  - `controlLines` does not change: the futures line is `<futures.label>; <study.agreementDetail>` (pull request 1), which now reads "Futures: deep trades only (sampled tape, no state); futures and options agreement is not compared or tested".

#### 26. apps/web/src/features/flow/control-view-model.test.ts (Modify)

- **Type / Scope**: Unit test of file 25 (100%).
- **Proposed Changes**: New cases: "states the size limit and the signing rule for tick only, quote only, mixed signing with the tick count, and without rows"; "hides the limit line without a limit"; "states coverage as a share and in seconds, and says so before the first sampled second"; "labels the running sum as a sum of sampled deep trades"; "places minutes by time, breaks the line at unsampled minutes, draws a one-minute run and is empty without minutes"; "lists trades with time, side, tone, size, price and rule"; "says how many trades are not shown"; "lists absorption marks with and without a price"; "shows the FOMC line only on an event day"; "prints the levels and names a missing part"; "the futures line joins the sampled-tape label and the agreement detail".

#### 27. apps/web/src/components/portal/flow-control-panel.tsx (Modify)

- **Type / Scope**: Client component (pull request 1).
- **Proposed Changes**: The panel keeps its two `[data-flow-control-side]` rows (Options, Futures) and has no agreement row. Under the futures row: the `sessionEventLine` (when not null) and the `levelsLine`. After the net drift block, a section with the heading "Deep trades: <future>" and `data-flow-deep-trades`: the limit line, the coverage line, the sum metric, an inline `<svg role="img">` of `buildDeepTradesChart` whose `aria-label` is "Sum of sampled deep trades" plus the current value, the trade list as a table inside a container that scrolls on its own (rows `data-flow-deep-trade`; side as text with a `StatusBadge`, never colour alone), the more line, and the absorption marks as a list (`data-flow-absorption`). No trade rows: "No deep trade in the sampled tape since 09:30 ET." No marks: the list is not rendered. Width: no sideways scroll of the page at 375 px.

#### 28. apps/web/src/components/portal/flow-control-panel.test.tsx (Modify)

- **Type / Scope**: Component test of file 27 (100%).
- **Proposed Changes**: Replace "shows the futures side as not collected with its reason" by "shows the futures row with the sampled-tape label and the agreement detail, and no agreement row". New cases: "shows the deep trades section: limit, coverage sentence, labelled sum, chart name"; "lists trades and absorption marks"; "says that the sampled tape holds no deep trade"; "shows the FOMC line and the levels line".

#### 29. `apps/web/src/lab/fixtures/flow.ts` (Modify)

- **Type / Scope**: Dev-lab fixture (TypeScript, fictional values).
- **Proposed Changes**: The NQ snapshot gains sampled minutes and a `ticks` freshness row (`flow-snapshot.v1`). Both control documents: futures `no_data` with `sampled_tape`, agreement `not_comparable`. `labFlowControl("sp500")`: `levels` filled, `event: null`, deep trades of ES (limit 40, signing null, 14 trades of which 9 are signed by the quote rule, 90 sampled minutes with two gaps, 2 absorption marks, coverage share 0.31). `labFlowControl("nasdaq100")`: `event: "fomc"`, 3 NQ trades (limit 10, signing `tick`), coverage share 0.06.

#### 30. `apps/web/src/lab/entries/research.test.tsx` (Modify)

- **Type / Scope**: Lab test.
- **Proposed Changes**: The flow case also expects one `[data-flow-deep-trades]` section, 14 `[data-flow-deep-trade]` rows and 2 `[data-flow-absorption]` marks for ES.

#### 31. `docs/vertex-rebuild/openbb.md` (Modify)

- **Type / Scope**: The OpenBB feed doc.
- **Proposed Changes**: One sentence after the job table (line 89 is the `fed-events` row): `flow.control` reads the `openbb_event_calendar` rows of kind `fomc_meeting` and source `federal_reserve` for the session date to set `session.event`; when the job has not run there is no FOMC mark, and the document says "not read" only when the read itself failed.

#### 32. packages/db/migrations/0081_semantic_terms_flow_control.sql (Create)

- **Type / Scope**: Data migration; same statement form, column list and order as `packages/db/migrations/0074_semantic_terms_trend_indicators.sql`. Its number is the next free one after file 2.
- **How it gets its journal entry and snapshot**: there is no schema change, so `pnpm db:generate` writes nothing. Inside `packages/db`, with `DATABASE_URL` set (`packages/db/drizzle.config.ts:4-7` throws without it; any value works, the command does not connect), run the command of `packages/db/package.json:62` with two more flags, the same form that the plan of pull request 3 records for its data migration: `bunx --bun --no-install drizzle-kit generate --config drizzle.config.ts --custom --name semantic_terms_flow_control`. Checked on 2026-11-15: `drizzle-kit generate --help` lists `--custom` ("Prepare empty migration file for custom SQL") and `--name`; the 0074 snapshot differs from the 0073 snapshot only in `id` and `prevId`, and its `prevId` is the 0073 `id`. The command writes an empty SQL file, the journal entry and file 33; then the SQL is written by hand. `pnpm db:generate` afterwards must print "No schema changes".
- **Proposed Changes**: Header comment (seed of three vocabulary terms, source "none", not certified, existing ids are never overwritten, the texts hold no rule number). `INSERT INTO "semantic_terms" ("id", "label", "description", "synonyms", "source", "feed_path", "mapped_columns", "unit", "params", "certified") VALUES (...) ON CONFLICT ("id") DO NOTHING;` with `source 'none'`, `feed_path null`, `mapped_columns '[]'::jsonb`, `params '[]'::jsonb`, `certified false` and:
  - `options_net_drift`; label "Options net drift"; unit "USD"; synonyms `["net drift", "net premium drift", "options premium flow", "call minus put premium"]` (not the bare word "drift"). Description: "Options net drift (vendor: QuantData): for one option ticker (SPY, QQQ, SPX or NDX) and one minute, the premium in US dollars of options bought at the ask minus the premium sold at the bid, separately for calls and for puts, for out-of-the-money options without complex, tied, floor and cancelled trades (filter profile otm-clean.v1). Sign: a positive call-minus-put value means call buying leads (bullish); a negative value means put buying leads (bearish). Horizon: the regular options session, 09:30 to 16:15 New York, in one-minute buckets; every running sum starts at 09:30 and is given for all expiries (total) and for same-day expiries (zero_dte). Coverage: the vendor series is complete for this filter; when the same-day part is missing, the series has partsStatus partial and partsDetail says which part. This is not drift_level: drift_level is the drift of a paper forward monitor against its backtest. Vertex has no stored query for this term. Call the tool flow_control with group sp500 or nasdaq100 and read netDrift (totals, slopeUsdPerMinute, points). When the tool says no_data, give its reason and do not estimate. Research input only; not a trade instruction."
  - `futures_deep_trades`; label "Futures deep trades"; unit "contracts"; synonyms `["deep trades", "large futures trades", "large futures prints", "big futures prints"]`. Description: "Futures deep trades: single large trade prints on the futures ES (S&P 500) and NQ (Nasdaq 100). One deep trade is one print at or above the deep-trade size limit of its market; the limit in force is the field limitSize of the tool answer. Unit: contracts. Sign: buy means the print was signed as buyer-initiated, sell as seller-initiated; netVolume is buy volume minus sell volume and is positive when large buying leads. Horizon: the regular session, 09:30 to 16:00 New York; sums start at 09:30. Coverage caveat: the tape is sampled, not complete. The field coverage gives the seconds seen and their approximate share of the rule window; busy periods are seen least, because each fetch holds a fixed number of prints. Every sum is a sum of the sampled trades only, so it is a lower bound, and a minute that was not sampled is a gap, not zero. Sides come from the quote rule where the sampled quotes cover a print, else from the tick rule, which follows the last price change; each trade carries its signing method. Vertex has no market-by-order data, so the size of resting orders is not shown. Vertex has no stored query for this term. Call the tool flow_control with group sp500 (ES) or nasdaq100 (NQ) and read deepTrades and futures. The futures side itself has no state on a sampled tape (reason sampled_tape): report the trades and the coverage, not a state. Research input only; not a trade instruction."
  - `flow_control_state`; label "Flow control state (who is in control)"; unit "state"; synonyms `["who is in control", "control state", "buyers in control", "sellers in control"]`. Description: "Flow control state: for one index group (sp500: ES futures with SPX and SPY options; nasdaq100: NQ futures with QQQ and NDX options), one state for the options side (from options_net_drift) and one for the futures side. States: buyers, sellers, balanced, mixed or no_data; no_data always has a reason (market_closed, source_unavailable, stale, gap, session_start, sampled_tape, not_collected). The futures state needs the full futures tape with quote-rule sides. Vertex samples the tape, so in this version the futures side is no_data with the reason sampled_tape, and the agreement of the two sides is not_comparable: it is not computed. The deep trades are still listed (see futures_deep_trades). Sign: buyers is bullish, sellers is bearish. Unit: none; the options side carries its measured ratio and the limit it is compared with, and the field rules holds every number of the rule with its version. Horizon: a trailing window inside the regular session, anchored at 09:30 New York; since is the start of the present state. Coverage caveat: the options side is complete for the vendor filter; the futures side has no state on a sampled tape. The field study says whether the continuation rule was tested and with what verdict. Vertex has no stored query for this term. Call the tool flow_control with group sp500 or nasdaq100. Read the enums, not the label text. For a no_data side report the reason and do not estimate. A state describes recent flow; it is never a trade instruction."

#### 33. packages/db/migrations/meta/0079_snapshot.json (Create)

- **Type / Scope**: Generated artifact.
- **Proposed Changes**: Written by the command of file 32; equal to the 0078 snapshot except `id` and `prevId`. Never edited by hand.

#### 34. packages/db/rollback/0081_semantic_terms_flow_control.down.sql (Create)

- **Type / Scope**: Guarded reversal, copied from `packages/db/rollback/0074_semantic_terms_trend_indicators.down.sql` with the three ids.
- **Proposed Changes**: Same header (deletes the three rows only while none was edited, certified, given a certification decision or note, or a SQL attribute; ledger not reconciled; run without `--single-transaction`), same `BEGIN`, `SET LOCAL`, `LOCK TABLE "public"."semantic_terms"`, the `DO $$` guard with `RAISE EXCEPTION 'flow control terms have operator edits or linked rows; refusing rollback'`, then `DELETE FROM "public"."semantic_terms" WHERE "id" IN ('options_net_drift', 'futures_deep_trades', 'flow_control_state'); COMMIT;`.

#### 35. packages/db/src/server/semantic-terms-flow-control-migration.test.ts (Create)

- **Type / Scope**: Unit test of the SQL and rollback of files 32 and 34; same structure as `packages/db/src/server/semantic-terms-trend-indicators-migration.test.ts`.
- **Proposed Changes**: Cases: "seeds exactly the three uncertified terms with source none within the schema check" (label 1 to 120, unit 1 to 40, description 1 to 2000 characters, synonyms an array of strings of at least 3 characters); "each description names the tool flow_control, a sign, a horizon and a coverage statement" (contains `flow_control`, "Sign:", "Horizon:", "Coverage"); "flow_control_state says the futures state needs the full tape, is no_data sampled_tape until then, and the agreement is not_comparable"; "flow_control_state lists the seven no-data reasons and not partial"; "options_net_drift says it is not drift_level and has no bare drift synonym"; "no description holds a rule number" (none of the values of `FLOW_CONTROL_RULES` and no registry size limit as text: "0.3", "0.1", "0.15", "30 min", "40 contracts", "10 contracts", "50 contracts"; the list is written in the test, the db package cannot import the API package); "never overwrites an existing term"; "has a journal entry with its tag" (no pinned neighbour, unlike the 0074 test, `CONVENTIONS.md:111`); "has a guarded rollback that refuses on operator work and deletes only these terms".

#### 36. tests/integration/database/semantic-terms-flow-control.test.ts (Create)

- **Type / Scope**: Integration test on real Postgres; same structure as `tests/integration/database/semantic-terms-trend-indicators.test.ts`.
- **Proposed Changes**: Cases: "inserts the three uncertified terms with source none once and leaves the other terms alone" (applying the file again changes nothing; `drift_level` is unchanged); "refuses the rollback while an operator edited a term"; "... while a term is certified"; "... while a term has a certification note"; "... while a SQL attribute belongs to a term"; "deletes only the three terms when nothing was edited".

#### 37. tests/integration/semantic-layer/flow-control-terms.test.ts (Create)

- **Type / Scope**: Integration test through the real oRPC handler; same structure as `tests/integration/semantic-layer/trend-terms.test.ts`. A new file, so the files that another open pull request may change (`tests/integration/semantic-layer/questions.ts`, `tests/integration/semantic-layer/questions.test.ts`) are not touched: no question is added and no rubric changes.
- **Proposed Changes**: Cases: "lists the three terms as uncertified with source none" (`semanticTerms/list`); "terms_query answers not_available for each term and returns the description that names flow_control" (`semanticTerms/query`); "drift_level still answers from Postgres" (`options_net_drift` and `drift_level` do not shadow each other).

#### 38. `tests/integration/semantic-layer/eval-recording.fixture.json` (Modify)

- **Type / Scope**: Recorded eval fixture (JSON class "fixture"). It must change: file 24 adds a tool definition and widens the `flow_snapshot` input schema and description, which is part of every recorded input digest, and file 32 changes the `terms_list` result (see the facts above). It is the only file that the recorder rewrites.
- **Proposed Changes**: One recording step, in the last commit, after files 24, 32 and 46 are in place and after the base branch was merged: `bun run eval:semantic:record -- 3 4` (`package.json:107`; 3 trials, 4 at a time, all 30 questions, 90 trials). Then grade as the doc describes (fixed rubric of the questions file, independent grade, manual audit of low-confidence answers) and update the `audit` header. Files under `tests/integration/semantic-layer/` may be claimed by another job: run `fm claims` (it lists the resources that other cards hold through the `fm` claim tool, `AGENTS.md:179`) before the commit, and if the fixture is claimed, wait for that job, merge the base and record again; never merge the fixture by hand. The step needs model access and a private test Postgres. No question and no rubric changes, so `tests/integration/semantic-layer/questions.ts` and `tests/integration/semantic-layer/questions.test.ts` are not touched.

#### 39. `docs/vertex-rebuild/flow-pipeline.md` (Modify)

- **Type / Scope**: The pipeline doc, changed in the same commits as the code.
- **Proposed Changes**:
  - "What it does": NQ gains the ticks row; a new table row for `flow_large_trades`.
  - "IBKR budget" (lines 40-73): every tick symbol fetches trades and quotes (2 requests); one symbol per turn; the turns go round SPY, ES and NQ, so each symbol is fetched once per three turns (about 360 s with the 60 s timer, it was about 240 s for SPY and ES); the normal gate keeps its limit 2; the starved limit becomes 410 s; the test guards turns × 120 s <= 410 s; expected coverage is lower than today for SPY and ES and lowest in the first minutes after the open.
  - "Features and events" (line 78): one sentence: the `large_print` limits do not change (ES 50, NQ 10); deep trades have their own limit (ES 40, NQ 10, measured 2026-11-13).
  - New section "Deep trades": one detection pass for the events and the rows and one write for both; the first and last sampled seconds left out; deep prints without a side not stored and counted in the sample message; no grouping and why; signing (quote rule where the sampled quotes cover a print, else the tick rule; each row stores its method); table and key; insert-once; the one capture mode `sampled`; coverage is approximate, and busy periods are seen least because each fetch holds the newest 1000 prints; no stored sums; retention 730 days; two equal prints in one second are one `large_print` event (same event key) but two deep-trade rows (`seq` 0 and 1), so the counts can differ.
  - "Control document": the futures side is `no_data` with the reason `sampled_tape` and the agreement is `not_comparable` until a streamed tape with quote-rule sides exists (owner decision; the fold, `minLargeTrades`, `coverageFloor`, price progress and start precision come then); the `deepTrades` block and its coverage window; `levels`; `session.event` from `openbb_event_calendar` rows of kind `fomc_meeting` (job `fed-events`), and what the document says when the calendar was not read; remove "not collected until the next release".
  - "Deploy": 0076 is already applied on the base; apply 0078 and then 0079, each alone with `psql -v ON_ERROR_STOP=1 --single-transaction`; check the table, its grants and the three term rows; check the calendar with `select count(*) from openbb_event_calendar where kind = 'fomc_meeting' and date >= current_date` (0 means no FOMC mark until the job runs); no service change in `vertex-history`. Rollback: deploy the previous app; both down files are not the rollback path.
  - "Agent semantic layer" (lines 189-193): replace the paragraph by the three terms, their source `none` and the tool they point to.

#### 40. `docs/vertex-rebuild/agent-semantic-layer.md` (Modify)

- **Type / Scope**: The catalog doc. Another open pull request may edit it, so the edit is additive: no existing line is changed except the "Updated:" line (line 3).
- **Proposed Changes**: One new paragraph at the end of the re-recording notes: "Re-recording <date> (flow control terms, migration 0079)": the catalog gained three uncertified terms with source `none` (`options_net_drift`, `futures_deep_trades`, `flow_control_state`) that point to the tool `flow_control`; the tool `flow_control` was added, so every trial was stale; the command of file 38, the model, the count of answers and model calls, and both grades. One sentence: `options_net_drift` is not `drift_level`, and "drift" alone stays a synonym of `drift_level` only.

#### 41. `packages/api/src/server/mcp.test.ts` (Modify)

- **Type / Scope**: Unit test.
- **Proposed Changes**: Add `"flow_control"` after `"flow_snapshot"` (line 72) in the pinned list (lines 56-95); new case "forwards flow_control to flow/control" (as the forwarding case of `flow_snapshot` at line 160); new case "flow_snapshot accepts QQQ and NQ"; remove the pull request 1 case "keeps the recorded definition of flow_snapshot".

#### 42. `packages/api/src/contracts/flow.ts` (Modify)

- **Type / Scope**: oRPC contract file (pull request 1 file 20). No schema of a procedure changes, so `packages/api/openapi.json` does not change.
- **Proposed Changes**: Delete `FlowSnapshotToolInputSchema` and `FLOW_SNAPSHOT_TOOL_SYMBOLS` (added by pull request 1 only for the pin). The constant `snapshotMinutes` stays, used by `FlowSnapshotInputSchema`.

#### 43. packages/api/src/flow-control.contract.test.ts (Modify)

- **Type / Scope**: Contract test of pull request 1 (its file 21).
- **Proposed Changes**: Remove the case "the tool input of flow_snapshot accepts SPY and ES and rejects QQQ". No other case changes.

#### 44. `tests/integration/semantic-layer/read-tools.test.ts` (Modify)

- **Type / Scope**: Integration test of every Plan-mode read tool.
- **Proposed Changes**: Add `flow_control: ok({ group: "sp500" })` to `READ_TOOL_CALLS` (lines 35-75), after `flow_snapshot` (line 43). Expected answer on the evaluation backend: a `flow-control.v1` document (empty flow tables give the futures side `no_data` and empty deep trades), so the call is `ok`.

#### 45. `tests/integration/database/semantic-layer.test.ts` (Modify)

- **Type / Scope**: Integration test of the seeded catalog.
- **Proposed Changes**: In the sorted catalog of lines 107-125 insert `["flow_control_state", "none", false]` and `["futures_deep_trades", "none", false]` after `drift_level`, and `["options_net_drift", "none", false]` after `open_risk`. The title becomes "seeds ten certified terms, the five uncertified trend indicator terms and the three uncertified flow control terms, ..." (rest unchanged), and the comment names migration 0079.

#### 46. `tests/integration/semantic-layer/harness.ts` (Modify)

- **Type / Scope**: Eval and read-tool test harness.
- **Proposed Changes**: In `startEvalBackend`, next to the other `now: () => EVAL_NOW` settings (around line 150), call `setFlowClockForTesting(() => EVAL_NOW)` (`packages/api/src/server/flow.ts:48`), so `flow_control` and `flow_snapshot` answers do not depend on the wall clock and the replay digest stays stable. `read-tools.test.ts` uses this harness, so it needs no own call.

#### Commit order

Each commit holds its tests, generated artifacts and doc text, and passes `bun run check` and its focused tests alone.

1. `feat(db): flow_large_trades table, repository methods and 730-day prune (0078)` — files 1 to 10, the retention entry of file 15 with its case in file 16, the `flow_large_trades` row in "What it does" and the "Deploy" text of file 39.
2. `feat(api): deep-trade limit and detector` — files 11 and 12, the `deepTradeLimit`, `deepTradeLimitMeasuredOn` and `deepPrints` parts of files 13 and 14, and the "Features and events" sentence of file 39. The detector and the field it reads ship together.
3. `feat(api): NQ tick turn, deep trades stored` — the NQ `ticks` and `sources` parts of files 13 and 14, files 15 and 16, file 23, the NQ snapshot part of file 29, the "IBKR budget" text and the "Deep trades" section of file 39.
4. `feat(api): futures-side texts for the sampled tape` — files 19 and 20. `describeFuturesSide` is new and unused until commit 5; the texts of pull request 1 do not change, so its tests keep passing.
5. `feat(api): deep trades, levels and session event in flow.control` — files 21 and 22, the control parts of files 17 and 18, the "Control document" text of file 39, file 31. Order inside the commit: failing tests, then the assembly.
6. `feat(web): deep trades section, levels and event line` — files 25 to 30 (the rest of file 29).
7. `feat(db): catalog terms and flow_control tool (0079)` — files 32 to 37, files 24 and 41 to 46, file 40, the 0079 journal entry of file 4, the "Agent semantic layer" text of file 39, and last file 38. The tool and the terms are one commit so that the eval is recorded once.

#### Verification

- `pnpm db:generate` after commits 1 and 7: prints "No schema changes" (the newest snapshot equals the schema). After a base merge that adds a migration: `pnpm db:renumber`, then `pnpm db:generate` (`CONVENTIONS.md:94-105`).
- `pnpm exec vitest run packages/db/src/server/flow-migration.test.ts packages/db/src/server/migration-journal.test.ts packages/db/src/server/flow.test.ts packages/db/src/server/semantic-terms-flow-control-migration.test.ts`: SQL, rollbacks, journal order, repository queries and the term texts.
- `pnpm exec vitest run packages/api/src/flow-deep-trades.test.ts packages/api/src/flow-features.test.ts`: the detector, the overlap case, the deep-trade limit and the unchanged `large_print` limit.
- `pnpm exec vitest run packages/api/src/server/flow-collect.test.ts packages/api/src/server/flow.test.ts`: turns, the starved-limit guard, events and deep trades in one write, the previous close and the session event.
- `pnpm exec vitest run packages/api/src/flow-control.contract.test.ts packages/api/src/flow-control-rules.test.ts packages/api/src/server/flow-control.test.ts packages/api/src/server/mcp.test.ts`: the contract of pull request 1 accepts the document, the futures texts, the document with deep trades, levels and the event, no futures state, and the tool table.
- `pnpm exec vitest run apps/web/src/features/flow apps/web/src/components/portal/flow-control-panel.test.tsx apps/web/src/lab/entries/research.test.tsx apps/web/src/status-language.test.ts`: the page, the lab entry, and the status-language guard (`apps/web/src/status-language.test.ts:36-52`): every new literal of files 25 and 27 names its state ("Tape seen: no sampled second in this window yet", "no value yet"), so `apps/web/src/status-language-allowlist.ts` gets no entry and `MAX_OPEN` stays 206; server sentences arrive as data.
- `bun run test:integration` (needs `bun run db:test:up`, as in plan-pr1.md): both migrations apply to an empty database, `flow_large_trades` has the listed key, the three terms exist and the sorted catalog matches, the 0079 rollback guard works, every read tool answers, and the eval replay passes on the new recording.
- `bun run openapi:check`: the artifact did not change.
- `bun run test:json-data`: no new JSON data name (the fixtures only changed).
- `bun run check`, `bun run docs:check`, `bun run verify:coverage` (100% for the new file 11, and 100% for every changed file that pull request 1 created: 19, 21, 25 and 27; files 7, 13 and 15 existed before and keep the repository's coverage gate), `bun run verify:prepush`; then the required checks on the pull request.
- Not run: the Python tests of `infra/quant-vps/history/test_vertex_history.py` (the service does not change).
- After deploy: `bun run vertex:flow:tick --dry-run` in three runs about 2 minutes apart; the lines show `SPY ticks`, then `ES ticks`, then `NQ ticks`, and the budget line stays at `ibkr=<n>/6` with n at most 4 while `/charts` is idle (6 is the vertex-history limit of 6 requests per 120 s, `ibkrLimit` of the budget block).
- Manual, in the dev lab at 375, 768, 1024 and 1440 px: the deep trades section has no sideways page scroll, and side and state are readable without colour.
