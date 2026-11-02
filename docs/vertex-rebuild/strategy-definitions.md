# Strategy definitions and the strategy builder

Updated: 2026-10-23. Research and backtest use only. A strategy definition never creates, routes or simulates broker orders.

## Purpose

A strategy definition is a small declarative description of a long-only strategy. The same definition is edited in two ways on the portal page `/strategy-builder`: with visual controls and as JSON text. Both editors validate the definition on every change. "Run backtest" queues a backtest run (see [backtest-runs.md](backtest-runs.md)) of the definition over a date range of stored bars.

## Parts

| Part | File |
| --- | --- |
| Schema, validation, text parser, templates | `packages/api/src/strategy-dsl.ts` |
| Indicators, compiler, run | `packages/api/src/strategy-dsl-compile.ts` |
| Signal engine (fills, stops, targets, risk sizing) | `runSignalBacktest` in `packages/api/src/instant-backtest-engine.ts` |
| Backtest run rule `{ kind: "dsl", definition }` | `packages/api/src/contracts/backtest-runs.ts`, `packages/api/src/server/backtest-runs.ts` |
| Page `/strategy-builder` | `apps/web/src/app/(portal)/strategy-builder/`, `apps/web/src/components/portal/strategy-builder-workspace.tsx`, `strategy-builder-model.ts` |

## Format (version 1)

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `name`, `description` | Display text. |
| `entry.all` | 1 to 8 conditions. The strategy enters when ALL are true on the signal bar. |
| `exit.any` | 0 to 8 conditions. An open position exits when ANY is true, also on bars where the entry conditions hold. While flat, entry wins when both are true. |
| `sizing` | `{ "mode": "allIn" }` (default) or `{ "mode": "riskPct", "riskPct": 1 }`. Risk sizing needs a stop loss. The position loses about `riskPct` of equity when the stop fills, before costs and gaps, and is capped at the available cash. |
| `stopLoss`, `takeProfit` | `{ "kind": "none" }` (default), `{ "kind": "pct", "pct": 5 }` (percent of the entry price) or `{ "kind": "atr", "length": 14, "multiple": 2 }` (ATR at the signal bar times the multiple). While the ATR is not available yet (too few bars), the strategy does not enter. |
| `session` | Optional `{ "startUtc": "13:30", "endUtc": "20:00" }`. Entries happen only on signal bars whose UTC time is in [start, end). A window can pass midnight. Exits are not limited. |

A condition is `{ "left": <expr>, "op": <op>, "right": <expr> }`. Operators: `>`, `>=`, `<`, `<=`, `crossesAbove`, `crossesBelow`. A cross is true on a bar where the relation holds and did not hold on the previous bar.

Expressions:

- `{ "type": "price", "field": "open" | "high" | "low" | "close", "offset": 0..1000 (optional) }`
- `{ "type": "const", "value": 30 }`
- `{ "type": "indicator", "name": <name>, "length": 1..1000, "source": <price field, default close>, "offset": 0..1000 (optional) }`

Indicators: `sma`, `ema` (seeded with the simple average), `rsi` and `atr` (Wilder smoothing; `atr` ignores `source`), `highest` and `lowest` (of the `length` bars BEFORE the signal bar, a Donchian channel), `adx` and `rvol`. An indicator value is not available until enough bars exist. A comparison with a value that is not available is false.

- `adx`: the Wilder ADX line (trend strength, 0 to 100) with TA-Lib smoothing. `length` is the period. It ignores `source`. DX is 0 when +DI and -DI are both 0. The first value is on bar `2 × length − 1`.
- `rvol`: relative volume at time. It ignores `source` and reads bar volume. A session is the New York (America/New_York) calendar date of the bar time; the slot is the New York minute of day. The value is the session volume up to and including the bar, divided by the mean of the same cumulative volume of each of the `length` previous sessions, taken through their last bar at or before the same slot (0 when such a session has no bar that early). Not available with fewer than `length` previous sessions or a zero mean. `length` is at most 100 sessions for `rvol` (1000 for the other indicators). When every session in the bars has exactly one bar (daily bars), every bar uses the same slot, so the value is volume divided by the mean volume of the previous `length` bars. This also holds when bars are stored at a fixed UTC time, whose New York time moves by one hour at a daylight saving change. Stored bars carry their volume into a run. A run on bar columns without volume fails with an input error.

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

## Execution model

The compiler turns a definition into one signal per bar and runs the engine model of the instant backtest: signals use data up to the close of the signal bar and fill at the next open; stops and targets are checked inside each bar and a gap fills at the open; costs are charged in basis points on each side. In a backtest run, the run-level `stopLossPct` and `takeProfitPct` apply only to the fixed rules; a definition carries its own stop, target and sizing.

## Versioning

A definition run without a library strategy stores a snapshot that depends only on the definition (kind `dsl`) and its SHA-256 revision. Equal definitions get equal revisions; any change makes a new revision. A run linked to a library strategy keeps that strategy's revision.

## Saved revisions

`backtestRuns.definitions.save` stores a definition as append-only revisions; equal content does not create a new revision. The assistant and MCP tools that use it are described in [ai-strategy-builder.md](ai-strategy-builder.md).

## Templates

`STRATEGY_TEMPLATES` holds four templates written for Vertex: SMA cross (20/50), RSI reversion (RSI 14 below 30 above the 200-bar average, exit above 55, 8% stop), Donchian breakout (20/10) and ATR expansion (ATR 5 crosses above ATR 20 in an uptrend, ATR stop and target, 1% risk).

## Tests

- Schema validation and templates: `packages/api/src/strategy-dsl.test.ts`.
- Compile parity: a definition SMA cross equals the golden `smaCross` rule (trades, equity, statistics), and the Donchian template equals the golden `breakout` rule without a trend filter: `packages/api/src/strategy-dsl-compile.test.ts`, `packages/api/src/backtest-runs.test.ts`.
- Builder page: `apps/web/src/components/portal/strategy-builder-workspace.test.tsx`.
- Headless browser flow, including builder-made SMA 10/40 against the golden rule on `/backtest-runs`: `tests/e2e/strategy-builder.spec.ts`.

## Limits

- Long only. No short positions, pyramiding or partial exits.
- The text editor accepts JSON only.
- Research and backtest use only. There is no order or broker path.
- `offset` reaches at most 1000 bars back. `rvol` `length` is at most 100 sessions. `rvol` needs bar volume. Stored bars load their volume; a null stored volume is not available, so `rvol` is not available in that session and the sessions after it that use it.
