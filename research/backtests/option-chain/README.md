# Option-chain snapshots: calibration data for the option model

Research only. The option model of the qc-ports runner (`services/research/strategies/qc_ports/options.py`)
assumes two things that the public price data cannot show: the bid/ask half-spread per leg
(`HALF_SPREAD_PCT`) and the volatility skew (`SKEW`). The first stored day (2026-11-11) does not agree
with the assumptions: SPY and QQQ quote a half-spread of about 0.4% of the mid (model 1% and 1.5%), DIA
and USO are wider than the model (3.7% and 4.5%, model 3% and 4%), and the SPY call wing is flatter than
the model (slope -0.18, model -0.30) while the put wing is close to it (-0.29). One day is not a history,
so this directory collects the chain every trading day and turns the days into proposed constants (card
`vertex-option-model-calibration`).

It creates no order and reads no account. The data is free public Yahoo data, 15 minutes delayed.

## Files

| File | What it is |
| --- | --- |
| `snapshot.py` | One snapshot run: up to three standard monthly expiries per ETF (next two monthlies >= 21 DTE covering 30-75 DTE calibration, plus nearest LEAPS >= 365 DTE) of SPY, QQQ, DIA, IWM, GLD, SLV and USO. Overlays IBKR live quotes from `optionsChain.chain` onto Yahoo gaps and posts each snapshot to Postgres (`optionsChain.ingestSnapshot`), while keeping local Yahoo CSVs and `summary.json` for `calibrate.py`. Also supports `--backfill` for historical day folders. |
| `calibrate.py` | Reads all stored days. Reports the median half-spread and the median call and put wing slope per ETF next to the model constants, and says if the proposal is ready (20 trading days). |
| `infra/option-chain/` (repository root) | The rig timer that runs `snapshot.py` at 12:30 and 15:30 New York time on weekdays. |
| `services/research/tests/test_option_chain.py` | Tests of both scripts with fake chains (no network). |

## What one run measures

For each ETF and expiry, from the quotes with a bid above zero and an ask above the bid:

- **Half-spread** in percent of the mid for four reference legs: the at-the-money call, the call one
  standard deviation out of the money, the put at about 25 delta and the put half a standard deviation
  further out.
- **Implied volatility** of each quote, computed from its mid: Black-76 on the forward that put-call
  parity gives near the money (median over the five nearest strikes with both quotes, within 6% of spot),
  with a fixed 4% rate for the discount factor. The implied-volatility column of Yahoo is not used. Its calls and puts disagree at the
  same strike (SPY at the money on day 1: 15.5% and 13.1%), and that shifts the wing slopes (SPY on day 1:
  the call slope by +0.05, the put slope by +0.06).
- **Skew slope** of each wing: the least-squares slope of IV / ATM IV against the standardized moneyness
  `x = ln(K/S) / (ATM IV * sqrt(T))`, through the point (0, 1), for calls with x from 0 to 1.5 and for puts
  with x from -1.5 to 0. This is the quantity `smile_iv` uses.

An expiry is not measured when fewer than three strikes near the money have a call and a put quote, or
when the nearest quoted strike is more than 2% from spot.

A run measures only while the option market trades: a weekday between 09:45 and 16:00 New York time, and
SPY with an option trade in the last 45 minutes (this covers holidays and half days). Otherwise the bid
and ask are stale; the run then writes nothing and exits 0.

Failures exit 1, so the systemd unit shows them:

- Yahoo sends no data for SPY (three attempts): nothing is written.
- One ETF fails, or one of its expiries has no usable quotes: the run writes the rest, with
  `"complete": false` and the reason in `errors`.

## Store (Postgres + local CSV mirror)

- **Postgres (`option_chain_snapshots` + `option_chain_snapshot_quotes`, migration `0092`):** the
  platform store. When `VERTEX_ORIGIN` (or `VERTEX_API_URL`) and `VERTEX_AGENT_API_KEY` are set,
  `snapshot.py` overlays IBKR live quotes from `optionsChain.chain` onto Yahoo gaps and posts every
  captured `(snapshotAt, underlying, expiry)` batch to `optionsChain.ingestSnapshot` (write key).
  Research agents read stored snapshots through `optionsChain.snapshot` (agent read key).
- **Local CSV mirror (`~/.local/share/vertex/option-chain/<New York day>/<HHMMSS>Z/`):** kept
  through phase-2 calibration (`calibrate.py`) and go-live candidate generation. `summary.json`
  measures only `DTE_RANGE` (30–75 DTE) monthlies in `symbols` (while listing all captured expiries
  in `storedExpiries`), so `calibrate.py` and `--remeasure` report the exact same day count and
  calibration constants.

`summary.json` keeps the keys that `research/backtests/allocation/sensitivity.py --chain` reads (`fetchedAt`,
`source` and, per expiry, `halfSpreadPct`, `callSlope` and `putSlope`).

## Run

```bash
# One snapshot (while the US market is open), with the same pinned packages as the timer:
OPTION_CHAIN_RUNNER_DIR="$PWD" infra/option-chain/vertex-option-chain-run

# Backfill historical stored day folders into Postgres (add --dry-run to preview):
OPTION_CHAIN_RUNNER_DIR="$PWD" infra/option-chain/vertex-option-chain-run --backfill

# The calibration report:
python3 research/backtests/option-chain/calibrate.py --store ~/.local/share/vertex/option-chain

# Tests:
cd services/research && python -m pytest tests/test_option_chain.py
```

## From the report to the model

The proposal is ready when every ETF has 20 trading days (4 weeks; the first day is 2026-11-11). Until then
`options.py` stays unchanged. The replacement is a separate change with its own review because it moves the
results of every options backtest:

- `HALF_SPREAD_PCT`: the proposed half-spread per ETF (median over the days of the mean over the four legs).
  The report also gives the 75th percentile; quoted spreads widen in stress.
- `SKEW`: the model has one slope per ETF for both wings. The chains show two (SPY on day 1: calls -0.18,
  puts -0.29), so the replacement needs a call slope and a put slope per ETF in `smile_iv`.
