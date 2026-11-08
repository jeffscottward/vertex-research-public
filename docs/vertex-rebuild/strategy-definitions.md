# Strategy definitions and the strategy builder

Updated: 2026-11-08. Research and backtest use only. A strategy definition never creates, routes or simulates broker orders.

## Purpose

A strategy definition is a small declarative description of a long-only strategy. The same definition is edited in two ways on the portal page `/strategy-builder`: with visual controls and as JSON text. Both editors validate the definition on every change. "Run backtest" queues a backtest run (see [backtest-runs.md](backtest-runs.md)) of the definition over a date range of stored bars.

## Parts

| Part | File |
| --- | --- |
| Schema, validation, text parser, templates | `packages/api/src/strategy-dsl.ts` |
| Indicators, compiler, run, entry filters | `packages/api/src/strategy-dsl-compile.ts` |
| Python mirror of the compiler (Nautilus engine), golden parity fixture | `services/research/nautilus_backtest/signals.py`, `scripts/research/nautilus-golden.ts` |
| Signal engine (fills, stops, targets, risk sizing) | `runSignalBacktest` in `packages/api/src/instant-backtest-engine.ts` |
| Backtest run rule `{ kind: "dsl", definition }` | `packages/api/src/contracts/backtest-runs.ts`, `packages/api/src/server/backtest-runs.ts` |
| Page `/strategy-builder` | `apps/web/src/app/(portal)/strategy-builder/`, `apps/web/src/components/portal/strategy-builder-workspace.tsx`, `strategy-builder-model.ts` |

## Format (version 1)

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `name`, `description` | Display text. |
| `entry.all` | 0 to 8 conditions. The strategy enters when ALL are true on the signal bar. |
| `entry.any` | Optional, 0 to 8 conditions, no default. When it is not empty, at least one of them must also be true on the signal bar. `entry.all` may be empty when `entry.any` is not; together they need at least one condition. |
| `exit.any` | 0 to 8 conditions. An open position exits when ANY is true, also on bars where the entry conditions hold. While flat, entry wins when both are true. |
| `sizing` | `{ "mode": "allIn" }` (default) or `{ "mode": "riskPct", "riskPct": 1 }`. Risk sizing needs a stop loss. The position loses about `riskPct` of equity when the stop fills, before costs and gaps, and is capped at the available cash. With the optional `"maxLeverage": 1..50` (riskPct only, no default) the cap is cash × `maxLeverage` instead (see [Stop management and leverage](#stop-management-and-leverage)). |
| `stopLoss`, `takeProfit` | `{ "kind": "none" }` (default), `{ "kind": "pct", "pct": 5 }` (percent of the entry price) or `{ "kind": "atr", "length": 14, "multiple": 2 }` (ATR at the signal bar times the multiple). While the ATR is not available yet (too few bars), the strategy does not enter. |
| `management` | Optional stop management of an open position, no default: `{ "breakevenR": 2, "trail": { "activateR": 1, "length": 14, "multiple": 2 } }`, either part or both. Needs a stop loss and no `options` block (see [Stop management and leverage](#stop-management-and-leverage)). |
| `session` | Optional `{ "startUtc": "13:30", "endUtc": "20:00" }`. Entries happen only on signal bars whose UTC time is in [start, end). A window can pass midnight. Exits are not limited. |
| `filters` | Optional, 1 to 4 entry filters (see [Entry filters](#entry-filters)). Every filter must pass for an entry; exits are never blocked. |
| `options` | Optional defined-risk option vertical traded on the signals (see [Options block](#options-block)). |

A condition is `{ "left": <expr>, "op": <op>, "right": <expr>, "oncePerLevel": true (optional) }`. Operators: `>`, `>=`, `<`, `<=`, `crossesAbove`, `crossesBelow`, `breaksAbove`, `breaksBelow`. A cross is true on a bar where the relation holds and did not hold on the previous bar. A break compares the previous left value with the current right value: `breaksAbove` at bar i is `left[i] > right[i]` and `left[i − 1] <= right[i]` (`breaksBelow`: `left[i] < right[i]` and `left[i − 1] >= right[i]`). It differs from a cross when the level moves: when the level rises past a close that was above the old level, the next close above the new level is a break but not a cross; when the level falls below an unchanged close, that bar is a cross but not a break. Both are false on the first bar and when a value is not available.

`oncePerLevel` (optional, no default) works only with `crossesAbove`, `crossesBelow`, `breaksAbove` and `breaksBelow`. When true, a bar where the condition holds is dropped if the same right value (an exact number) already made it hold on an earlier bar, so each level fires once. With a constant right value the condition fires at most once in the whole run. A level is used up on any bar where the condition holds, whether or not a trade follows (already in a position, another condition false, a filter closed), so the result depends on where the run starts: a walk-forward fold that starts later can fire on a level the full run already used.

Expressions:

- `{ "type": "price", "field": "open" | "high" | "low" | "close", "offset": 0..1000 (optional) }`
- `{ "type": "const", "value": 30 }`
- `{ "type": "indicator", "name": <name>, "length": 1..1000, "source": <price field, default close>, "offset": 0..1000 (optional), "timeframe": "1d" (optional) }`

Indicators: `sma`, `ema` (seeded with the simple average), `rsi` and `atr` (Wilder smoothing; `atr` ignores `source`), `highest` and `lowest` (of the `length` bars BEFORE the signal bar, a Donchian channel), `adx`, `rvol`, `zscore` and `realizedVol`. An indicator value is not available until enough bars exist. A comparison with a value that is not available is false.

- `adx`: the Wilder ADX line (trend strength, 0 to 100) with TA-Lib smoothing. `length` is the period. It ignores `source`. DX is 0 when +DI and -DI are both 0. The first value is on bar `2 × length − 1`.
- `rvol`: relative volume at time. It ignores `source` and reads bar volume. A session is the New York (America/New_York) calendar date of the bar time; the slot is the New York minute of day. The value is the session volume up to and including the bar, divided by the mean of the same cumulative volume of each of the `length` previous sessions, taken through their last bar at or before the same slot (0 when such a session has no bar that early). Not available with fewer than `length` previous sessions or a zero mean. `length` is at most 100 sessions for `rvol` (1000 for the other indicators). When every session in the bars has exactly one bar (daily bars), every bar uses the same slot, so the value is volume divided by the mean volume of the previous `length` bars. This also holds when bars are stored at a fixed UTC time, whose New York time moves by one hour at a daylight saving change. Stored bars carry their volume into a run. A run on bar columns without volume fails with an input error.
- `zscore`: rolling z-score of `source` (gs-quant `zscores` convention): (value − mean) / sample standard deviation (ddof 1) of the `length` values ending at the bar, the bar included. The first value is on bar `length − 1`. Not available on a flat window (all values equal). `length` is at least 2.
- `realizedVol`: annualized realized volatility of `source` in percent (gs-quant `volatility` convention): sample standard deviation (ddof 1) of the `length` simple returns ending at the bar × √252 × 100. The factor 252 assumes daily bars; on other timeframes the value is per-bar deviation × √252 × 100. The first value is on bar `length`. A flat window gives 0; a window with a non-positive price is not available. `length` is at least 2.
- Both match gs-quant 2.2.4 on the fixture `services/research/tests/fixtures/gs-quant-reference.json` (see [gs-quant](gs-quant.md)).

`offset` means bars ago: the value at bar i is the value of the series at bar i − offset, and it is not available before that bar exists. It is optional and has no default, so a definition without it keeps the same JSON and the same revision. The builder writes no `offset` key when the "bars ago" field is empty or 0. An explicit `"offset": 0` written in the JSON editor gives the same signals but a different revision than a definition without the key, because the revision hashes the JSON as written.

Example, ADX filter "ADX(14) > 20":

```json
{ "left": { "type": "indicator", "name": "adx", "length": 14 }, "op": ">", "right": { "type": "const", "value": 20 } }
```

Example, "ADX(14) falling over 5 bars" (use `>` for rising):

```json
{ "left": { "type": "indicator", "name": "adx", "length": 14 }, "op": "<", "right": { "type": "indicator", "name": "adx", "length": 14, "offset": 5 } }
```

A cross operator works with an offset too: `close crossesAbove close offset 1` is true on the first bar of a series of higher closes.

### Daily levels on intraday bars (`timeframe: "1d"`)

An indicator with `"timeframe": "1d"` (optional, no default) runs on daily bars built from the signal bars, so an hourly strategy can read daily levels. A session day starts at 17:00 New York: the day of a bar is the New York date of its time + 7 hours, so US regular-hours bars keep their date and FX or futures days start at the 17:00 New York roll, on both sides of a daylight saving change. A daily bar is the first open, the highest high, the lowest low, the last close and the summed volume of its signal bars.

The daily values map back to the signal bars without look-ahead:

- `highest` and `lowest` on a bar of day D read the value at day D, which is the extreme of the `length` days BEFORE D (the current day is never in the window), so a breakout of yesterday's 20-day high can fire during day D.
- Every other indicator (`sma`, `ema`, `rsi`, `atr`, `adx`, `zscore`, `realizedVol`) reads day D − 1, the last completed day. On the first day the value is not available.
- `length` counts days and must not exceed the number of daily bars in the run (an input error, even when there are enough signal bars). `realizedVol` keeps its √252 factor, which is right for daily bars.
- `offset` still counts signal bars and applies after the mapping.
- The first session day may be partial (the data starts in the middle of it); it still counts as a day in the windows.
- `rvol` takes no `timeframe`: it already compares whole sessions.

### Stop management and leverage

`management` moves the stop of an open position up; it never moves it down. R is the entry price minus the initial stop. At the close of every bar the position is open (the entry bar included), after that bar's stop and target check:

- `breakevenR` (above 0, at most 100): once the highest high since entry reaches entry + `breakevenR` × R, the stop becomes at least the entry price.
- `trail` (`activateR` and `multiple` above 0 and at most 100, `length` 1 to 1000): once the highest high since entry reaches entry + `activateR` × R, the stop becomes at least the highest close since entry − `multiple` × ATR(`length`) of that bar (the Wilder ATR of the signal bars). A bar where that ATR is not available leaves the stop.
- A new stop applies from the next bar, so the bar that raised it cannot stop out on it; a gap through the raised stop fills at the open.

With both parts the higher stop wins. Without a stop loss nothing moves, which is why the schema needs one.

`sizing.maxLeverage` (1 to 50, riskPct only) caps the position cost at cash × `maxLeverage` instead of the cash. The borrowed part makes the unused cash negative; equity is that cash plus the position marked at the close. The TypeScript engine and the Nautilus engine charge no financing; the LD34 study runner (`services/research/strategies/ld34/metrics.py`) charges it in research.

Ruin rule (both engines, every definition): when equity marked at a bar's close is at or below 0, an open position exits at that close with reason `stop`, and the run takes no further entries; equity stays at the cash left (which can be negative). With leverage this usually follows a gap through the stop: riskPct 10 with a stop 1 below an entry at 100 and `maxLeverage` 20 buys 0.1 units with 9 borrowed; a gap to 50 fills the stop at 50 and leaves equity at −4, after which the strategy no longer trades. Entry costs at high leverage can also take the marked equity below 0 before the stop is reached; then the position exits at the close.

### LD34 example

LD34 (nested Donchian long-only breakout) enters when the close breaks above any of the 20, 50, 100 and 200-day highest highs or lowest lows (a return above a Donchian low counts too), once per level, risks 1% of equity on a 2 × ATR(14) stop with up to 20× leverage, moves the stop to breakeven at 2R and trails 2 × ATR(14) below the highest close from 1R. The golden fixture runs it on 400 days of hourly FX-week bars (`reel:ld34:*` in `scripts/research/nautilus-golden.ts`).

```json
{
  "version": 1,
  "name": "LD34 nested Donchian long-only breakout",
  "entry": {
    "all": [],
    "any": [
      { "left": { "type": "price", "field": "close" }, "op": "breaksAbove", "oncePerLevel": true,
        "right": { "type": "indicator", "name": "highest", "length": 20, "source": "high", "timeframe": "1d" } },
      { "left": { "type": "price", "field": "close" }, "op": "breaksAbove", "oncePerLevel": true,
        "right": { "type": "indicator", "name": "lowest", "length": 20, "source": "low", "timeframe": "1d" } }
    ]
  },
  "stopLoss": { "kind": "atr", "length": 14, "multiple": 2 },
  "sizing": { "mode": "riskPct", "riskPct": 1, "maxLeverage": 20 },
  "management": { "breakevenR": 2, "trail": { "activateR": 1, "length": 14, "multiple": 2 } }
}
```

The full definition repeats both conditions for 50, 100 and 200 days (eight `entry.any` conditions).

## Entry filters

A filter gates entries only: the entry signal needs every entry condition and every filter; exit conditions still close a position on any bar. `filters`, the filter fields marked optional and `options` have no default, so a definition without them keeps the same canonical JSON and revision (pinned in `strategy-dsl.test.ts`).

| Filter | Passes on a bar when |
| --- | --- |
| `{ "type": "sectorQuadrant", "sector": "XLK", "quadrants": ["leading"], "timeframe": "weekly" }` | The latest stored sector rotation point of `sector` dated on or before the bar has a quadrant in `quadrants` ([sector-rotation.md](sector-rotation.md)). `timeframe` defaults to `weekly`. |
| `{ "type": "ivRank", "length": 252, "min": 50, "max": 100 }` | The IV rank of the traded symbol's implied-volatility index on the bar date is in [`min`, `max`]. IV rank = 100 × (v − min) / (max − min) over the last `length` index values (20 to 1000, default 252), the current one included. Not available before `length` values, on a flat window, or without an index value on the bar date. At least one of `min`, `max` (0 to 100). |
| `{ "type": "vixTermStructure", "maxRatio": 0.95, "minRatio": 0.8 }` | VIX / VIX3M on the bar date is in [`minRatio`, `maxRatio`] (below 1 is contango). Both indices need a value on that date. At least one bound. |
| `{ "type": "volRegime", "maxVix": 20, "maxTermRatio": 1, "trendLength": 200 }` | On the bar date VIX ≤ `maxVix`, VIX / VIX3M ≤ `maxTermRatio` and the SPY close is above its `trendLength`-day simple average (default 200, over the SPY series' own dates). |
| `{ "type": "calendarWindow", "window": "turnOfMonth", "fromDay": -2, "toDay": 3 }` | The bar is one of the last `-fromDay` trading days of its month (-1 is the last) or one of the first `toDay` trading days (1 is the first). `fromDay` -10 to -1, `toDay` 1 to 10. |
| `{ "type": "calendarWindow", "window": "opexWeek" }` | The bar is between the last trading day before the Monday-to-Friday week of the monthly expiration and the expiration itself (the third Friday, or the trading day before it when that Friday is a holiday). |
| `{ "type": "calendarWindow", "window": "months", "months": [1, 12] }` | The bar is in one of the listed months (1 to 12, no repeats). |
| `{ "type": "series", "series": "ES=F", "condition": <condition> }` | `condition` holds on another daily series (cross-asset). |

Calendar windows run on daily bars only and take trading days from the NYSE holiday rules (`nyseHolidays` / `isNyseTradingDay` in `strategy-dsl-compile.ts`, Python `nyse_holidays`; the same rules as the qc-ports research calendar): weekdays except New Year (not observed on a Saturday), Martin Luther King Jr. Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day, Thanksgiving and Christmas, with Saturday holidays observed on Friday and Sunday holidays on Monday. Special full-day closures since 1998 are listed in `NYSE_SPECIAL_CLOSURES` (Python `signals.NYSE_SPECIAL_CLOSURES`): 2001-09-11 to 2001-09-14, 2004-06-11, 2007-01-02, 2012-10-29, 2012-10-30, 2018-12-05 and 2025-01-09. A Python test checks the calendar against the qc-ports research calendar over the SPY bar dates (the repo fixture, and the local qc-ports data when present). A bar on a day that does not trade is outside the `turnOfMonth` and `opexWeek` windows. On intraday bars the UTC date misplaces the exchange session, so `runStrategyDefinition(..., timeframe)` and `plan_run` (spec `timeframe`) refuse a `calendarWindow` filter on a known timeframe other than `1d` or `1w`, and as a fallback compiling one on bars spaced less than 20 hours apart throws `StrategyUnsupportedError` with code `STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED`.

Series ids: Core 7 ETFs `SPY QQQ DIA IWM GLD SLV USO`, futures `ES=F NQ=F YM=F RTY=F GC=F SI=F CL=F`, indices `VIX VIX3M VXN VXD RVX GVZ OVX VXSLV IRX TNX`, and `EY_TNX_RATIO` (Shiller earnings yield lagged 6 months over TNX). The IV index of each traded symbol: SPY VIX, QQQ VXN, DIA VXD, IWM RVX, GLD GVZ, SLV VXSLV, USO OVX.

A series is one value per date (the close), so a `series` condition may use only the close price, constants and close-sourced indicators other than `atr`, `adx` and `rvol`. Its indicators and offsets run over the series' own dates; then each side takes the latest series value dated on or before the bar date (a series date missing in the bars, such as a futures Sunday, carries forward), and the operator compares the aligned sides bar by bar, so a cross is relative to the previous bar.

Series data reaches the compiler like the sector points: `compileStrategy(bars, definition, sectorQuadrants?, seriesInput?)`, where `seriesInput` is `{ context: { [seriesId]: { "YYYY-MM-DD": value } }, symbol }`; `symbol` is the traded symbol for `ivRank`. Values that are not finite count as missing. A filter whose series is not in the context throws `StrategySeriesDataError` ("Series data is not available for VIX"); `ivRank` without a known traded symbol throws an input error. The Python port takes the same mapping: `compile_strategy(bars, definition, sector_quadrants, context, symbol)`; `plan_run` is the server engine and refuses series filters. The server paths do not load series or pass a symbol yet; they refuse these filters up front (see [Where definitions run](#where-definitions-run)). The research runners pass the context.

Look-ahead: a daily value is known after its close. Daily bars (signal at the close) use values dated on the bar date; intraday bars use only values dated before the bar date. `ivRank`, `vixTermStructure` and `volRegime` need the value on the bar date itself (the latest earlier date for intraday bars); `series` carries the latest earlier value for at most 5 trading days (`STRATEGY_SERIES_MAX_FILL_DAYS`: distinct bar dates without a newer value, as in the research loader `qc_ports/data.align`). After that the value is missing and the filter blocks entries.

## Options block

```json
{
  "structure": "putCreditVertical",
  "dte": { "target": 45, "min": 21 },
  "shortDelta": 0.2,
  "widthSigma": 0.5,
  "profitTakePct": 50,
  "exitDte": 7,
  "maxLossPct": 2
}
```

| Field | Meaning |
| --- | --- |
| `structure` | `callDebitVertical`, `putDebitVertical`, `putCreditVertical` or `callCreditVertical`. Defined risk only. |
| `dte` | `target` 7 to 400, `min` 1 to 400 and at most `target`: the standard monthly expiry nearest `target` with at least `min` days. |
| `longDelta`, `shortDelta` | 0.05 to 0.95. `longDelta` only on debit verticals (runner default 0.5), `shortDelta` only on credit verticals (runner default 0.25). |
| `widthSigma` | 0.1 to 3. Strike distance between the legs = `widthSigma` × ATM IV × √T × spot, at least one strike step. |
| `profitTakePct` | Optional, 1 to 100. Credit: close when the spread value ≤ (1 − p/100) × credit. Debit: close at +p% of the debit. |
| `exitDte` | Optional, 0 to 400 and below `dte.min`: close when DTE ≤ `exitDte`. |
| `maxLossPct` | Above 0 and at most 2: contracts = floor(`maxLossPct`% of equity / max loss per contract). Above 2 is refused. |

With `options`, `sizing` must be `allIn` (or omitted) and `stopLoss` and `takeProfit` must be `none`: the options block sizes and exits the spread. The compiler still produces the entry and exit signal arrays, and `CompiledStrategy.options` (Python `Compiled.options`) is the block unchanged for the options runner, which turns signal bars into spreads. The equity engine run of such a definition is the underlying signal run, not the option P&L.

## Where definitions run

The server engines run equity strategies and load sector points only. `serverStrategyRefusal` (`strategy-dsl.ts`) names what they cannot run, and every server path refuses it rather than ignoring it:

| Code | Refused |
| --- | --- |
| `STRATEGY_OPTIONS_UNSUPPORTED` | A definition with an `options` block. The block runs only in the options research runner. |
| `STRATEGY_SERIES_FILTERS_UNSUPPORTED` | An `ivRank`, `vixTermStructure`, `volRegime` or `series` filter (no series loader on the server). `sectorQuadrant` and `calendarWindow` filters are allowed. |
| `STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED` | A `calendarWindow` filter on an intraday timeframe (every timeframe except `1d` and `1w`). |

| Path | Refusal |
| --- | --- |
| `backtestRuns.submit` (portal, assistant and MCP `backtest_runs_submit`) | `VALIDATION_ERROR` (422) with the code in the message; nothing is queued. |
| Queued run on the server engine, Nautilus worker claim (single or batch) | The run fails with the refusal message (a row written past the submit check); a batch claim goes on to the next run. |
| `autopilot.campaigns.create` filters | `VALIDATION_ERROR`; no campaign is stored. A stored campaign with such filters (or calendar filters on an intraday timeframe) fails on its next tick before breeding. |
| `autopilot.candidates.sendToPaper` | `VALIDATION_ERROR` before any write. |
| `autopilot.candidates.get` | The tearsheet shows, but `nautilus` (the paper config) is null for a refused definition. |
| `runStrategyDefinition` (TypeScript) and `plan_run` (Python Nautilus engine) | Always `StrategyUnsupportedError`, whatever data is passed: code `STRATEGY_OPTIONS_UNSUPPORTED` for an options block, `STRATEGY_SERIES_FILTERS_UNSUPPORTED` for series filters (the golden fixture `engineRefusals` pins the same codes and messages in both). Research runners call `compileStrategy` / `compile_strategy` with their series context instead; it returns the signals and the options block. |

`backtestRuns.definitions.validate` and `.save` accept these definitions: saving stores a revision and runs nothing (decision 2026-11-08, card vertex-qc-ports: save accepts, every execution path refuses, so a saved options or series definition stays usable by the research runner and can never run ungated). Paper-forward monitors run fixed rules only (a definition run has no fixed-rule parameters), and pick lists do not read definitions.

## Execution model

The compiler turns a definition into one signal per bar and runs the engine model of the instant backtest: signals use data up to the close of the signal bar and fill at the next open; stops and targets are checked inside each bar and a gap fills at the open; costs are charged in basis points on each side. `management` raises the stop at bar closes as described in [Stop management and leverage](#stop-management-and-leverage). In a backtest run, the run-level `stopLossPct` and `takeProfitPct` apply only to the fixed rules; a definition carries its own stop, target, sizing, management and leverage.

## Versioning

A definition run without a library strategy stores a snapshot that depends only on the definition (kind `dsl`) and its SHA-256 revision. Equal definitions get equal revisions; any change makes a new revision. A run linked to a library strategy keeps that strategy's revision.

## Saved revisions

`backtestRuns.definitions.save` stores a definition as append-only revisions; equal content does not create a new revision. The assistant and MCP tools that use it are described in [ai-strategy-builder.md](ai-strategy-builder.md).

## Templates

`STRATEGY_TEMPLATES` holds four templates written for Vertex: SMA cross (20/50), RSI reversion (RSI 14 below 30 above the 200-bar average, exit above 55, 8% stop), Donchian breakout (20/10) and ATR expansion (ATR 5 crosses above ATR 20 in an uptrend, ATR stop and target, 1% risk).

## Tests

- Schema validation, templates, the filters and options schema, and the pinned revisions of existing definitions: `packages/api/src/strategy-dsl.test.ts`.
- Compile parity: a definition SMA cross equals the golden `smaCross` rule (trades, equity, statistics), and the Donchian template equals the golden `breakout` rule without a trend filter: `packages/api/src/strategy-dsl-compile.test.ts`, `packages/api/src/backtest-runs.test.ts`. The entry filters are covered there too.
- DSL extensions (`timeframe: "1d"`, breaks, `oncePerLevel`, `entry.any`, `management`, `maxLeverage`): schema checks in `strategy-dsl.test.ts`, compiled series in `strategy-dsl-compile.test.ts` (hand-built session days across the 17:00 New York roll), the engine stop management and leverage sizing in `packages/api/src/instant-backtest-engine.test.ts`, and the same cases in Python in `services/research/tests/test_nautilus_backtest_signals.py` and `test_nautilus_backtest_engine.py`.
- TypeScript and Python parity: `bun run research:nautilus-golden` writes `services/research/tests/fixtures/nautilus_backtest/golden.json` with definitions using each filter (the `qc:*` cases, on synthetic VIX, VIX3M, VXN, SPY, ES=F and GC=F series and a spring 2019 calendar with a Good Friday expiration) and the `reel:*` cases (LD34 and a mixed daily-level definition that enters, on 400 days of hourly bars); `services/research/tests/test_nautilus_backtest_signals.py` must match the signals exactly, and `scripts/research/nautilus-golden.test.ts` checks the committed file is current.
- Builder page: `apps/web/src/components/portal/strategy-builder-workspace.test.tsx`. The visual builder edits `entry.all`, `exit.any`, the stop, target and sizing; it keeps `entry.any`, `oncePerLevel`, `timeframe`, `management` and `maxLeverage` written in the JSON editor.
- Headless browser flow, including builder-made SMA 10/40 against the golden rule on `/backtest-runs`: `tests/e2e/strategy-builder.spec.ts`.

## Limits

- Long only. No short positions, pyramiding or partial exits.
- The text editor accepts JSON only.
- Research and backtest use only. There is no order or broker path.
- `offset` reaches at most 1000 bars back. `rvol` `length` is at most 100 sessions. `rvol` needs bar volume. Stored bars load their volume; a null stored volume is not available, so `rvol` is not available in that session and the sessions after it that use it.
