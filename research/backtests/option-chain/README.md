# Option-chain snapshots: calibration data for the option model

Research only. The option model of the qc-ports runner (`services/research/strategies/qc_ports/options.py`)
assumes two things that the public price data cannot show: the bid/ask half-spread per leg
(`HALF_SPREAD_PCT`) and the volatility skew (`SKEW`). A one-day chain snapshot on 2026-11-11 (allocation
study, card `vertex-allocation-plan`) showed that both assumptions are off: SPY and QQQ trade at a
half-spread of about 0.4% of the mid (model 1% and 1.5%), the call wing is flatter than the model, and DIA
and USO are wider than the model. One day is not a history, so this directory collects the chain every
trading day and turns the days into proposed constants (card `vertex-option-model-calibration`).

It creates no order and reads no account. The data is free public Yahoo data, 15 minutes delayed.

## Files

| File | What it is |
| --- | --- |
| `snapshot.py` | One snapshot run: the monthly expiries 30 to 75 days out of SPY, QQQ, DIA, IWM, GLD, SLV and USO. Writes the raw chains (CSV) and `summary.json`. |
| `calibrate.py` | Reads all stored days. Reports the median half-spread and the median call and put wing slope per ETF next to the model constants, and says if the proposal is ready (20 trading days). |
| `infra/option-chain/` (repository root) | The rig timer that runs `snapshot.py` at 12:30 and 15:30 New York time on weekdays. |
| `services/research/tests/test_option_chain.py` | Tests of both scripts with fake chains (no network). |

## What one run measures

For each ETF and expiry, from the quotes with a bid above zero, an ask above the bid and an implied
volatility:

- **Half-spread** in percent of the mid for four reference legs: the at-the-money call, the call one
  standard deviation out of the money, the put at about 25 delta and the put half a standard deviation
  further out.
- **Skew slope** of each wing: the least-squares slope of IV / ATM IV against the standardized moneyness
  `x = ln(K/S) / (ATM IV * sqrt(T))`, through the point (0, 1), for calls with x from 0 to 1.5 and for puts
  with x from -1.5 to 0. This is the quantity `smile_iv` uses.

A run measures only while the option market trades: SPY must have an option trade in the last 45 minutes.
On a weekend, on a holiday or after the close the bid and ask are stale; the run then writes nothing and
exits 0. When one ETF fails, the run writes the others with `"complete": false` and exits 1.

## Store

`~/.local/share/vertex/option-chain/<New York day>/<HHMMSS>Z/` on the rig: `summary.json` and one CSV per
ETF, expiry and side (about 0.5 MB per run). The store is local data and is not committed. A day counts
once per ETF in the calibration: the latest run of the day that has quotes for the ETF.

`summary.json` has the shape that `research/backtests/allocation/sensitivity.py --chain` reads.

## Run

```bash
# One snapshot (while the US market is open):
uv run --no-project --python 3.12 --with yfinance==0.2.66 \
    python research/backtests/option-chain/snapshot.py --store ~/.local/share/vertex/option-chain

# The report:
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
- `SKEW`: the model has one slope per ETF for both wings. The chains show two (SPY on day 1: calls -0.14,
  puts -0.24), so the replacement needs a call slope and a put slope per ETF in `smile_iv`.
