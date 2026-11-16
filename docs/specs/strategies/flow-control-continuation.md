# Options-side continuation rule (modelled fills): pre-registered study

Status: research only. No live or paper orders. No broker changes. NautilusTrader stays disarmed. The rules, variants,
split and pass/fail rule below were fixed on 2026-11-15 before the first run; the freeze is the commit that first sets
`SPEC_SHA256` in the rule module of `services/research/strategies/flow_control/`, which is the SHA-256 of this file
above the "Results" heading. The study runner refuses to run when that part changes.

The study tests the options side of the flow control signals only, with modelled fills. It does not test the futures
and options agreement. Design and reasons: the flow control signals design document of the Vertex rebuild (section 10).

## Source

- Rule: Vertex (flow control signals feature, 2026-11-15). Options net drift: QuantData net drift endpoint
  (<https://quantdata.us/api/docs/endpoints/net-drift>), one-minute buckets of net call and net put premium per ticker.
- Vendor data is for personal use and is not redistributed. Data and reports stay outside the repository.

## Data

- Tickers: SPX, SPY, QQQ and NDX. Groups: sp500 (primary SPX, check SPY) and nasdaq100 (primary QQQ, check NDX).
- Expiry parts: `total` (all expiries) and `zero_dte`; the rule reads `total`. When a session has no `total` file, the
  total of a minute is the sum of the parts `zero_dte` and `longer` where both have the minute (price of `zero_dte`,
  else of `longer`); such sessions are counted as "derived total".
- Filter profile `otm-clean.v1`: OTM contracts; no complex, floor, tied or cancelled prints (request bodies of the
  golden fixture header `netDriftRequests`).
- Folder layout: `<data dir>/net-drift/<TICKER>/<part>/<YYYY-MM-DD>.json`, the vendor's `data` object (keys epoch
  milliseconds; values `netCallPremium`, `netPutPremium`, `netCallVolume`, `netPutVolume`, `stockPrice`).
- From 2025-01-02; the first session with data is found by the download and reported under Results. Files of earlier
  days are not read (the FOMC list starts in 2025).
- Usable day: a weekday that is not an NYSE holiday and not an early close, on which all four tickers load. Skip reasons
  per ticker, tested in this order: `missing` (no `total` file and not both fallback parts), `empty` (no bucket),
  `thin` (fewer than 300 buckets in minutes 0 to 389), `no_open_price` (no price at 09:30), `missing_price` (after
  carrying the last price forward at most 5 minutes, a bar from 1 to 385 has no price).

## Rules

- Rules version `flow-control-rules.v1`: window 30 minutes, enter ratio 0.30, exit ratio 0.10, 5 minutes in a row,
  at least 10 buckets in the window.
- Options ratio over the window: sum of (net call minus net put premium) over the sum of (absolute net call plus
  absolute net put premium); 0 for a zero divisor. Fewer than 10 buckets in the window gives `no_data` (reason
  `session_start` before 10 minutes have passed since 09:30, else `gap`) and resets the runs; the carried state is kept.
- State: `buyers` after 5 minutes in a row at or above 0.30, lost below 0.10; `sellers` is the mirror (at or below
  -0.30, lost above -0.10). Group state: `no_data` when the primary has no data; `mixed` when the check ticker controls
  the opposite side; else the primary state.
- Trend: +1 when the price of the group's primary ticker is above its 09:30 price and above its price 30 minutes earlier
  (09:30 price before 10:00); -1 for the mirror; else 0.
- Bars: 386 per session (minutes 0 to 385 after 09:30). A decision at the end of minute `m` reads buckets up to `m` and
  fills at the price of minute `m + 1`.
- Entry: from minute 15 (09:45) to minute 120 (11:30), at the end of the first minute with group state `buyers` and
  trend +1 (long) or `sellers` and trend -1 (short). At most one trade per instrument and session.
- Exit, checked from the entry bar to minute 384: hard stop when the price at the end of a minute is 0.40% of the entry
  price or more against the position; else when the group state differs from the entry state. Both fill at the next
  minute. Otherwise at minute 385 (15:55) at that minute's price.
- FOMC days: the 16 scheduled decision days of 2025 and 2026 (Federal Reserve calendar read on 2026-11-15) are skipped.

## Variants

N = 10 trials: five configurations times two forms (futures and debit verticals). Each variant changes one value.

| Id | Change |
| --- | --- |
| C0 | none (primary; the futures form `C0-F` decides the verdict) |
| V1 | window 15 minutes |
| V2 | window 60 minutes |
| V3 | entry until minute 360 (15:30) |
| V4 | FOMC days included |

Slippage levels and the cost stress are not trials.

## Futures model

- ES modelled from the SPX index price per minute, NQ from the NDX index price per minute; no futures bar is read.
- $50 (ES) and $20 (NQ) per point, $12.50 and $5.00 per tick, $4.50 fees per round turn (the ES fee equals the NQ fee
  by decision), slippage 0, 1 or 2 ticks per side; 1 tick is the base. Capital basis $100,000 per contract.

## Option position

- SPY and QQQ follow the rule with their own price and the group's state and trend (sp500 group for SPY, nasdaq100
  group for QQQ). One debit vertical per trade: call vertical for long, put vertical for short.
- Nearest Friday weekly expiry with at least one trading day left; long leg near 0.50 delta, short leg 1 sigma further
  out; Black-Scholes with the smile on the previous close of VIX (SPY) or VXN (QQQ) and the T-bill rate.
- Costs: $0.65 per contract and half the modelled spread per leg, exit cost capped at the worst case. Size: maximum loss
  (debit plus costs) at most 2% of a $100,000 account per symbol.
- Stress row `C0-O-stress`: the spread part of every cost times 2; commissions unchanged.

## Split

- All usable days in order: 60% train, 20% validation, 20% test, with gaps of 5 sessions between the parts. Fewer than
  30 usable days stops the run.
- The sessions from 2026-10-28 to 2026-11-13 (13 sessions) were used to choose the 30-minute window (count of state
  changes only); they are taken out of their part and reported alone.
- No parameter is fitted. The out-of-sample part is the validation part followed by the test part.

## Pass/fail rule

Decided on the out-of-sample part of `C0-F` at 1 tick per side:

- fewer than 100 trades: `needs-more-data`;
- else `edge` when the net is above 0 and the deflated Sharpe ratio (per-session dollars, variance over the per-session
  Sharpe ratios of the 10 trial series, N = 10) is at least 0.95;
- else `no-edge` (also when the deflated Sharpe ratio is not computable).

A NautilusTrader run of the `C0` trades of all four instruments must book the same entry and exit bars and fill prices
as the rule module; otherwise the study has no document.

## Known limit

The futures and options agreement is not tested: large-trade history exists for a few days only. The study tests the
options side alone, with modelled fills.

## Code and tests

- Code: `services/research/strategies/flow_control/`.
- Tests: `services/research/tests/test_flow_control_*.py`.

## Results

Run 2026-11-16 (UTC) on the research machine at commit `5447dd4f` (study code unchanged since; same results as the first run), data hash
`sha256:a2767576433671f51928129018bdd8b54b823e83748e54c9e74c2dc34a604810`. First session with data: 2025-01-02
(earlier vendor files exist from 2024-12-23 and are not read). 463 usable sessions from 2025-01-02 to 2026-11-13; 3
days skipped (`missing_price` on all four tickers), 3 early-close days left out; every usable session has a derived
total (the download holds `zero_dte` plus `longer`). 15 usable sessions are FOMC decision days.

**Verdict: `no-edge` (tested, failed).** No edge: 273 out-of-sample trades, net $-25,923 at 1 tick per side, deflated
Sharpe 0.000 (bar 0.95, N = 10). Options-side rule with modelled fills.

| Check | Pass | Result |
| --- | --- | --- |
| Out-of-sample trades at least 100 | yes | 273 trades in 169 sessions (2026-02-18 to 2026-10-27) |
| Net above 0 at 1 tick per side | no | $-25,923 (0 ticks $-21,123; 2 ticks $-30,723) |
| Deflated Sharpe at least 0.95 | no | 0.000; per-session Sharpe -0.115, expected maximum 0.339 |
| NautilusTrader fill check | yes | same entry and exit bars and fills on 1,432 of 1,432 trades; option ledger gap below $0.01 |

C0-F (1 ES and 1 NQ, modelled, $200,000) at 1 tick per side by part:

| Part | Sessions | Trades | Net | Sharpe (ann.) |
| --- | --- | --- | --- | --- |
| Train | 271 | 412 | $-16,680 | -0.74 |
| Validation | 90 | 146 | $-10,590 | -1.40 |
| Test | 79 | 127 | $-15,333 | -2.31 |
| Window choice (not in the verdict) | 13 | 15 | $24,676 | 5.73 |
| Whole period | 463 | 716 | $-5,555 | -0.12 |

Instruments, C0, whole period (out-of-sample): ES $-9,168 on 356 trades ($-7,291 on 138); NQ $3,613 on 360
($-18,632 on 135). Option form (debit verticals, modelled, 2% maximum loss per trade): SPY $-18,322 on 356 trades,
QQQ $-27,084 on 360; both $-45,405 (out-of-sample $-19,366 on 273); at twice the spread cost $-73,054. No trade was
skipped by the option model.

Variants, futures, whole period: V1 (window 15) $13,912 on 826 trades (out-of-sample $10,925, Sharpe 0.76); V2
(window 60) $-7,398; V3 (entry until 15:30) $-11,585; V4 (FOMC days included) $-7,504. None is a pass: the verdict
is decided on C0 only and the deflated Sharpe ratio counts all 10 trials.

Report: `~/Documents/reports/web/vertex-flow-control/index.html` (copy of the run folder page); run folder
`~/Documents/reports/web/vertex-flow-control-continuation/run` (both outside the repository).
