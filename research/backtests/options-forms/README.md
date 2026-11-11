# Options forms study

Research only. The allocation study of 2026-11-11 (`research/backtests/allocation/README.md`) found 42 tradable
library strategies without a defined-risk options form. Check G2 of its gate refuses them for that reason
alone. This study gives each of them an options form, runs the form on the qc-ports option book and on
NautilusTrader, and applies the same gate. It creates no order, no deployment request, no preset and no row in
Postgres.

Result on 2026-11-11 (data to 2026-11-10): **36 of the 42 strategies now have an options form with an own
NautilusTrader run. In the study model none of them passes the gate and none passes the owner's lower bar.**
With the option model the allocation study measured for the Core 7, three forms pass the lower bar: one is
below its always-on baseline, one equals it within 0.01, and the iron condor has no baseline. The other 6
strategies are not run (reasons below). The report with
the tables is outside the repository (rig reports directory `vertex-options-forms`).

## Files

| File | What it does |
| --- | --- |
| `services/research/strategies/qc_ports/forms.py` | The form: stance per symbol and day, stance to spreads under the owner exit rule, proxy IV index and cost model for underlyings without a Cboe index, indicators |
| `services/research/strategies/qc_ports/forms_orders.py` | Rules of the 9 QuantJourney order strategies (limit, stop, stop-limit, trailing stop, OCO) |
| `services/research/strategies/qc_ports/forms_weights.py` | Rules of the 16 QuantJourney weights and rotation strategies and of the 151 Strategies sector rotation |
| `services/research/strategies/qc_ports/forms_other.py` | Rules of the pairs, the FX and futures twins, the 10-month SMA timing, the iron condor and the leader pullback |
| `services/research/strategies/qc_ports/forms_library.py` | Registry: the 42 library slugs, each with its form or the reason it has none; the baselines |
| `services/research/tests/test_qc_ports_forms*.py` | Synthetic tests (base Python lane) |
| `research/backtests/options-forms/fetch_data.py` | Fetches the daily bars of the extra underlyings |
| `research/backtests/options-forms/run.py` | The study: runs every form and writes one JSON document and a results table to `--out` |

`run.py` writes its output to a report work directory. The app does not read it (AGENTS.md rule 13).

## Run it (rig)

```sh
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
  python research/backtests/qc-ports/fetch_data.py --out <data dir> --end <tomorrow of the last complete session>
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 --with pydantic==2.13.4 \
  python research/backtests/options-forms/fetch_data.py --out <data dir> --end <the same date>
<venv with services/research/requirements-nautilus-linux-py312.lock>/bin/python \
  research/backtests/options-forms/run.py --data <data dir> --capital <account value, rounded> --out <work dir>/results.json
```

The run fails when the reference ledger and NautilusTrader differ on a trade or on daily equity by more than
`1e-6` (the parity rule of the qc-ports runner). One run takes about 55 minutes.

## Method (fixed on 2026-11-11 before the first run of a form)

### What a form keeps

A form keeps the stance of the shares rule per traded symbol and day: +1 (the rule is long or has decided to be
long), -1 (short) or 0 (flat), known at the close of that day. A rule reads daily bars up to that day only
(a test truncates the bars and compares). Prices are total-return prices (open, high, low and close scaled by
adjusted close over close), as Vertex's adapter gives them to the QuantJourney engine.

- +1 holds the monthly call debit vertical of the qc study (`MONTHLY_CALL`: 60 days to expiry, long leg at 0.5
  delta, 1 sigma wide, at most 2% of equity at risk). -1 holds the same put debit vertical (`MONTHLY_PUT`).
  Two forms hold another structure: the iron condor (a put and a call credit vertical, 1% at risk each, opened
  together or not at all) and the leader forms (the call vertical with 0.5% at risk).
- One open spread per symbol and side. A stance on day `i` opens the spread at the close of day `i+1`. The
  spread closes at the close of the day after the stance ends, or under the owner exit rule of 2026-11-03 (a
  winner may run to expiry, a loser closes 3 days before expiry). While the stance lasts, the next spread opens
  the day after the last one closed.
- Different from the 8 QuantJourney forms of the allocation study: there the slot of a cut loser stays taken until
  its expiry day, here the next spread opens the day after the cut. The Sharpe of the always-on Core 7 basket is
  about 0.05 lower with the rule of this study.
- No spread opens before 1993-01-29 or before the first IV value of its underlying. The equity curve of a form
  starts on the first day one of its underlyings has an IV value. A form holds only the underlyings that have an
  IV value on a day: a Core 7 form holds SPY alone until 2001 and all seven from 2011. A pair starts when both
  legs have an IV value.
- The iron condor and the leader forms are entry-only: their rule says when to open, and the spread then stays
  open until the owner exit rule closes it.
- A market-order rule changes its stance on the signal day. A resting order (limit, stop, stop-limit, trailing
  stop) changes it on the day whose high or low fills the order. The option trade is one close later than the
  shares fill.
- The bars are split-adjusted. A spread on an underlying outside the Core 7 is priced at the prices of its entry
  day: every close times the product of the split ratios after that day (`<SYMBOL>.splits.csv` of the fetch).
  The strike grid, the commission per contract and the contract count are then those of the price the underlying
  traded at (NVDA is under $1 before 2016 in split-adjusted prices). A split during a trade changes nothing, as
  for a listed option. The Core 7 stay on split-adjusted closes, as in the qc study and the allocation study.
- A one-day distribution the split history does not hold (a spin-off: the close falls, the adjusted close does
  not, by a factor of 1.2 or more) is treated like a split. The results list them (`distributions`); some are
  just above 1.2. A smaller special dividend stays in the prices as a fall.
- A spread less than 2 strike steps wide, or with a premium per contract below the entry commission of its two
  legs, is not opened. There the strike grid and the fee floors decide the result, not the rule. The results
  count the refused signal days per form (`refusedBars`).
- The weight of the shares rule is not kept. A rule that only sets weights (inverse volatility W05, risk parity
  W19 and W20) becomes the always-on basket of its universe after its warm-up; the results mark it as a copy of
  its baseline. A volatility target (W17, W18) changes sizes only, so W17 trades like the trend rule W02.

Limits of the daily model are those of the allocation study: option prices are modeled (Black-Scholes with an
IV index, a linear skew and a cost per leg), "3 trading days" is 3 calendar days, and the close stands for
15:45 ET.

### Underlyings and the proxy IV index

The option book needs an implied-volatility index per underlying. The Core 7 ETFs have a Cboe index. The other
underlyings of this study (sector ETFs, EFA, EEM, TLT, IEF, DBC, VNQ, GDX, EWA, EWC, the currency ETFs, CORN and
single stocks) have none in the data set. They get a proxy index:

`proxy = sqrt( VIX x clamp(RV60 / RV60_SPY, 0.5, 6) x 1.15 x RV60 )`

`RV60` is the annualized volatility of the last 60 daily log returns of the adjusted close, in percent. The
proxy is the geometric mean of two estimates: VIX scaled by the realized-volatility ratio to SPY, and 1.15
times the symbol's own realized volatility. ATM IV is 0.9 times the proxy, as for VIX. The formula was chosen
on 2026-11-11 by comparing three candidates with the Cboe indices of QQQ, DIA, IWM, GLD, SLV and USO, before
any form ran. `run.py` writes that comparison to the results (`proxy.check`).

The comparison covers the Core 7 only: no Cboe index of a single stock or of a sector ETF is in the data set.
The proxy does not see an earnings date. A single stock's options cost more before earnings than the proxy
says, so the single-stock forms are optimistic there.

Cost model of a proxy underlying (model assumptions, in the range of the Core 7 table of `options.py`):

| Class | Half spread per leg | Skew slope | Symbols |
| --- | ---: | ---: | --- |
| Liquid equity | 2% | -0.25 | EEM EFA XLE XLF XLK GDX and the S&P 100 stocks except KO and PEP |
| Equity | 3% | -0.25 | XLB XLI XLP XLU XLV XLY XLRE XLC KO PEP (also as leaders) |
| Thin equity | 4% | -0.25 | VNQ EWA EWC |
| Liquid rates | 2% | 0 | TLT |
| Thin rates, currencies, commodities | 4% | 0 | IEF DBC FXE FXB FXA CORN |

The same half spread is used for every year back to 1993; spreads were wider before about 2010. The dividend
yield of a proxy underlying is its mean yield in the data (total-return drift minus price drift per
year, at most 6%).

### Universes

| Strategies | Traded underlyings | IV |
| --- | --- | --- |
| QuantJourney order strategies O03 to O14 | Core 7 ETF twins (as the 8 QuantJourney forms of the allocation study) | Cboe index |
| QuantJourney multi-asset strategies | SPY EFA EEM TLT IEF GLD DBC VNQ | index (SPY, GLD), proxy (6) |
| QuantJourney sector strategies | 9 Select Sector SPDRs | proxy |
| 151 Strategies sector rotation | 11 Select Sector SPDRs | proxy |
| Pairs | KO/PEP, EWA/EWC, GLD/GDX | proxy, GLD index |
| QuantJourney FX strategies | FXE FXB FXA for EURUSD GBPUSD AUDUSD (NZDUSD has no ETF with options) | proxy |
| QuantJourney futures strategies | W25: SPY QQQ IEF USO GLD CORN for MES MNQ ZN CL GC ZC; O20: SPY QQQ USO GLD for MES MNQ CL GC | index, proxy (IEF, CORN) |
| 10-month SMA timing | SPY | Cboe index |
| Short strangle | Core 7, as an iron condor | Cboe index |
| Leader pullback | S&P 100 stocks of `research/backtests/freestockalerts/universe.py` | proxy |

The FX and futures rules read the bars of the ETF twin, not of the currency pair or the future. The currency
ETF options and CORN options are thin in the market; a pass there would still need live quotes.

A leader spread risks 0.5% of equity, not 2%: up to 97 names can be open at once. A contract that costs more
than that is not bought (`sizeSkips` in the results). The leader baseline holds the same spread.

The leader list is today's S&P 100, written from memory and not point-in-time. Companies that failed are
missing, so the absolute result of the leader forms is too good. The comparison with the always-on baseline of
the same names (check G7) has the same list on both sides. The lower bar has no baseline check, so a leader form
that passes the lower bar passes it with that bias.

### Gate, baselines and trials

The gate is `allocation.gate_checks` with the thresholds of `allocation.GATE`; this study adds none. Checks
G1 and G2 (own NautilusTrader run, defined-risk options form) hold for every form here by construction.

The baseline of check G7 is the always-on form of the same universe (a call spread on every symbol, the next
one the day after the last one closed, same exit rule). Pairs and the iron condor have no long-only baseline.
The spreads of a symbol follow each other on the monthly expiries, so the day of the first entry sets every later
entry day: there are two chains, about a month apart, and the Sharpe of the basket differs between them (by 0.00
to 0.18 in the table below). The baseline Sharpe is therefore the mean of two runs that start 0 and 21 days after
the first IV value; the first runs on NautilusTrader, the second in the reference ledger only. A form has the
same dependence on its entry days; read a Sharpe difference of that size as noise.

The deflated Sharpe counts the 61 runs the allocation study counted (they run again here in the reference ledger,
so the across-trial variance is exact) plus every form and baseline of this study that traded. Copies count too,
as in the allocation study. Not counted: the second phase of a baseline, the diagnostic runs of this study, and
the sensitivity scenarios and the funded-pie runs of the allocation study.

The results table also shows the lower bar: Sharpe at least 0.3, out-of-sample Sharpe above 0, Monte Carlo 80%
profitable, max drawdown at most 25%, at least 30 trades, no deflated Sharpe and no baseline check. The owner
picked it on 2026-11-11 for the funded pie of the allocation study (`allocation/funded_pie.py`, `LOWER_BAR`). It
is an owner decision, not a repository gate.

Two diagnostics run everything again under another option model. They are not the study model, and a pass there
does not make a form eligible.

- `run.py --chain <chain summary>`: the Core 7 use the half spreads and the skew the allocation study measured
  in its chain snapshot of 2026-11-11 (`allocation/sensitivity.py`). The other underlyings keep their class
  model: no snapshot exists for them. The owner's funded pie was judged under this measured model too.
- `run.py --cost-scale 0`: commissions only, no bid/ask spread. A form that fails there cannot be rescued by a
  better cost model.

The daily option-chain snapshots of card `vertex-option-model-calibration` will replace the assumed spreads.

### Not run

| Library strategy | Why it is not run |
| --- | --- |
| `quantjourney-o15-intraday-5m-bracket-reversion` | The rule reads 5-minute bars. The option book prices daily closes only, and the data set has no intraday bars and no intraday option prices for it. |
| `quantjourney-o16-intraday-30m-stop-breakout` | The rule reads 30-minute bars. The option book prices daily closes only, and the data set has no intraday bars and no intraday option prices for it. |
| `quantjourney-w07-intraday-rsi-15m` | The rule reads 15-minute bars. The option book prices daily closes only, and the data set has no intraday bars and no intraday option prices for it. |
| `quantjourney-w08-intraday-1m-ema-scalp` | The rule reads 1-minute bars. The option book prices daily closes only, and the data set has no intraday bars and no intraday option prices for it. |
| `quantjourney-w09-intraday-1h-sma-trend` | The rule reads 1-hour bars. The option book prices daily closes only, and the data set has no intraday bars and no intraday option prices for it. |
| `long-calendar-spread` | The strategy is a defined-risk option structure already, but it holds two expiries. The option book prices single-expiry verticals only, and the data set has no IV term structure per symbol. |

## Results

Data to 2026-11-10, capital = the rounded account value (not stated here), engine qc-ports ledger +
nautilus_trader 1.227.0. Ledger and Nautilus agree on all 141 runs (47 in each of the three option models;
largest relative equity gap 4.3e-16). 97 of the 98 leader stocks have data (BK has none). The three runs take
about 60 minutes side by side; the always-on leader basket alone has about 8,000 booked trades.

| | Study model | Measured Core 7 model (diagnostic) | Commissions only (diagnostic) |
| --- | ---: | ---: | ---: |
| Forms with a positive Sharpe, of 35 distinct trade lists | 8 | 15 | 26 |
| Pass the gate | 0 | 0 | 0 |
| Pass the lower bar | 0 | 3 (`qj/O09`, `lib/zakamulin-sma`, `lib/short-strangle`) | 1 (`qj/W18`) |

Trials counted in the deflated Sharpe: 108 (61 of the allocation study + 47 here).

| Form | Underlyings, IV | Sharpe | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR | Trades | Baseline Sharpe | Gate checks failed | Lower bar | Sharpe, measured Core 7 | Lower bar, measured Core 7 | Sharpe, commissions only | Lower bar, commissions only |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | --- |
| `qj/W18` | 8, index and proxy | +0.18 | +0.16 | 0.00 | 83% | -23.2% | +1.2% | 561 | -0.08 | 4 of 8 | fail | +0.27 | fail | +0.42 | pass |
| `lib/zakamulin-sma` | 1, index | +0.14 | +0.23 | 0.00 | 75% | -16.4% | +0.5% | 169 | +0.12 | 5 of 8 | fail | +0.33 | pass | +0.18 | fail |
| `qj/W11` | 8, index and proxy | +0.10 | +0.24 | 0.00 | 66% | -39.7% | +0.5% | 536 | -0.08 | 6 of 8 | fail | +0.18 | fail | +0.29 | fail |
| `leaders/dip` | 97, proxy | +0.06 | +0.08 | 0.00 | 42% | -61.6% | -0.1% | 4281 | -0.15 | 6 of 8 | fail | +0.06 | fail | +0.26 | fail |
| `qj/O17` | 8, index and proxy | +0.05 | +0.03 | 0.00 | 51% | -32.2% | +0.0% | 572 | -0.08 | 6 of 8 | fail | +0.14 | fail | +0.28 | fail |
| `qj/O09` | 7, index | +0.05 | +0.09 | 0.00 | 54% | -28.3% | +0.1% | 491 | +0.09 | 7 of 8 | fail | +0.31 | pass | +0.28 | fail |
| `lib/pairs-divergence` | 2, index and proxy | +0.01 | +0.53 | 0.00 | 51% | -13.5% | +0.0% | 104 | none | 3 of 7 | fail | +0.14 | fail | +0.30 | fail |
| `qj/O11` | 7, index | +0.01 | +0.04 | 0.00 | 37% | -30.5% | -0.2% | 478 | +0.09 | 7 of 8 | fail | +0.24 | fail | +0.23 | fail |
| `lib/short-strangle` | 7, index | -0.01 | -0.04 | 0.00 | 49% | -8.5% | -0.0% | 952 | none | 4 of 7 | fail | +0.34 | pass | +0.19 | fail |
| `leaders/reclaim` | 97, proxy | -0.01 | +0.14 | 0.00 | 30% | -44.4% | -0.3% | 1733 | -0.15 | 6 of 8 | fail | -0.01 | fail | +0.18 | fail |
| `qj/W21` | 9, proxy | -0.03 | +0.29 | 0.00 | 10% | -63.4% | -1.0% | 1065 | -0.13 | 6 of 8 | fail | -0.03 | fail | +0.42 | fail |
| `qj/O10` | 7, index | -0.03 | -0.06 | 0.00 | 26% | -36.8% | -0.6% | 608 | +0.09 | 7 of 8 | fail | +0.20 | fail | +0.20 | fail |
| `qj/W04` | 8, index and proxy | -0.06 | -0.10 | 0.00 | 29% | -43.6% | -0.6% | 350 | -0.08 | 6 of 8 | fail | +0.04 | fail | +0.12 | fail |
| `qj/O03` | 7, index | -0.09 | -0.05 | 0.00 | 9% | -51.8% | -1.2% | 619 | +0.09 | 7 of 8 | fail | +0.12 | fail | +0.13 | fail |
| `qj/O08` | 7, index | -0.09 | -0.10 | 0.00 | 7% | -59.1% | -1.6% | 677 | +0.09 | 7 of 8 | fail | +0.19 | fail | +0.11 | fail |
| `qj/W02` | 8, index and proxy | -0.09 | -0.35 | 0.00 | 18% | -62.7% | -1.9% | 816 | -0.08 | 7 of 8 | fail | -0.00 | fail | +0.15 | fail |
| `qj/W17` | 8, index and proxy | -0.10 | -0.27 | 0.00 | 15% | -62.2% | -2.0% | 821 | -0.08 | 7 of 8 | fail | -0.01 | fail | +0.15 | fail |
| `qj/W05` (= `base/multi8`) | 8, index and proxy | -0.11 | -0.19 | 0.00 | 9% | -66.7% | -2.7% | 1141 | -0.08 | 7 of 8 | fail | -0.01 | fail | +0.19 | fail |
| `qj/W19` (= `qj/W05`) | 8, index and proxy | -0.11 | -0.19 | 0.00 | 9% | -66.7% | -2.7% | 1141 | -0.08 | 7 of 8 | fail | -0.01 | fail | +0.19 | fail |
| `qj/W10` | 8, index and proxy | -0.12 | -0.31 | 0.00 | 14% | -64.4% | -2.2% | 818 | -0.08 | 7 of 8 | fail | -0.02 | fail | +0.14 | fail |
| `qj/W20` (= `base/sector9`) | 9, proxy | -0.17 | +0.02 | 0.00 | 0% | -92.4% | -7.9% | 1438 | -0.13 | 7 of 8 | fail | -0.17 | fail | +0.09 | fail |
| `qj/W25` | 6, index and proxy | -0.18 | -0.13 | 0.00 | 7% | -69.1% | -2.3% | 891 | -0.06 | 7 of 8 | fail | -0.01 | fail | +0.15 | fail |
| `qj/W06` | 8, index and proxy | -0.19 | -0.35 | 0.00 | 3% | -77.0% | -3.3% | 1127 | -0.08 | 7 of 8 | fail | -0.09 | fail | +0.11 | fail |
| `lib/151-4-1` | 11, proxy | -0.22 | -0.09 | 0.00 | 1% | -50.4% | -2.2% | 427 | -0.13 | 7 of 8 | fail | -0.22 | fail | +0.01 | fail |
| `qj/W12` | 9, proxy | -0.28 | -0.19 | 0.00 | 0% | -93.4% | -8.9% | 1439 | -0.13 | 7 of 8 | fail | -0.28 | fail | +0.04 | fail |
| `qj/O20` | 4, index | -0.31 | -0.21 | 0.00 | 0% | -70.7% | -3.5% | 712 | +0.18 | 7 of 8 | fail | -0.15 | fail | -0.12 | fail |
| `qj/O07` | 7, index | -0.34 | -0.37 | 0.00 | 0% | -66.0% | -2.9% | 1351 | +0.09 | 7 of 8 | fail | +0.01 | fail | +0.18 | fail |
| `qj/O05` | 7, index | -0.36 | -0.32 | 0.00 | 0% | -69.3% | -2.9% | 1550 | +0.09 | 7 of 8 | fail | +0.01 | fail | +0.26 | fail |
| `qj/O04` | 7, index | -0.48 | -0.59 | 0.00 | 0% | -75.8% | -3.6% | 1351 | +0.09 | 7 of 8 | fail | -0.12 | fail | +0.14 | fail |
| `qj/W14` | 2, proxy | -0.54 | -0.30 | 0.00 | 1% | -43.4% | -1.7% | 219 | none | 6 of 7 | fail | -0.54 | fail | +0.00 | fail |
| `qj/O14` | 7, index | -0.67 | -0.57 | 0.00 | 0% | -85.5% | -5.3% | 1782 | +0.09 | 7 of 8 | fail | -0.30 | fail | -0.03 | fail |
| `qj/W13` | 2, proxy | -0.68 | -1.11 | 0.00 | 0% | -54.4% | -2.3% | 364 | none | 6 of 7 | fail | -0.68 | fail | -0.20 | fail |
| `qj/W23` | 3, proxy | -0.70 | -1.17 | 0.00 | 0% | -78.9% | -6.6% | 456 | -0.67 | 7 of 8 | fail | -0.70 | fail | -0.29 | fail |
| `qj/O19` | 3, proxy | -0.84 | -1.09 | 0.00 | 0% | -83.8% | -8.0% | 736 | -0.67 | 7 of 8 | fail | -0.84 | fail | -0.16 | fail |
| `qj/W24` | 3, proxy | -0.90 | -1.09 | 0.00 | 0% | -59.1% | -4.2% | 352 | -0.67 | 7 of 8 | fail | -0.90 | fail | -0.25 | fail |
| `qj/W22` | 9, proxy | -1.00 | -0.44 | 0.00 | 0% | -98.1% | -13.1% | 1787 | -0.13 | 7 of 8 | fail | -1.00 | fail | -0.26 | fail |
| `qj/W15` | 9, proxy | -1.08 | -1.08 | 0.00 | 0% | -95.9% | -10.6% | 1099 | -0.13 | 7 of 8 | fail | -1.08 | fail | -0.49 | fail |
| `qj/W16` | 9, proxy | -2.16 | -1.11 | 0.00 | 0% | -98.8% | -14.5% | 1845 | -0.13 | 7 of 8 | fail | -2.16 | fail | -0.63 | fail |

`(= key)` marks a form with the trades of another form or of its baseline. The last four columns are the two
diagnostic runs: the measured Core 7 model and commissions only.

### Always-on baselines

| Form | Underlyings, IV | Sharpe | Out-of-sample | Deflated Sharpe | MC P(profit) | Max drawdown | CAGR | Trades | Sharpe of the 2 start phases | Lower bar | Sharpe, measured Core 7 | Lower bar, measured Core 7 | Sharpe, commissions only | Lower bar, commissions only |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | ---: | --- |
| `base/futures4` | 4, index | +0.14 | +0.36 | 0.00 | 78% | -37.3% | +1.0% | 585 | +0.14 / +0.21 | fail | +0.37 | fail | +0.29 | fail |
| `base/spy` | 1, index | +0.12 | +0.39 | 0.00 | 74% | -28.3% | +0.5% | 203 | +0.12 / +0.12 | fail | +0.32 | pass | +0.18 | fail |
| `base/core7` | 7, index | +0.08 | +0.24 | 0.00 | 53% | -54.8% | +0.0% | 889 | +0.08 / +0.11 | fail | +0.33 | fail | +0.26 | fail |
| `base/sector9` | 9, proxy | -0.08 | +0.02 | 0.00 | 0% | -88.6% | -6.0% | 1463 | -0.08 / -0.18 | fail | -0.08 | fail | +0.19 | fail |
| `base/futures6` | 6, index and proxy | -0.08 | -0.03 | 0.00 | 17% | -50.8% | -1.4% | 826 | -0.08 / -0.04 | fail | +0.16 | fail | +0.19 | fail |
| `base/multi8` | 8, index and proxy | -0.10 | -0.21 | 0.00 | 11% | -64.8% | -2.6% | 1142 | -0.10 / -0.07 | fail | -0.02 | fail | +0.19 | fail |
| `base/sector11` | 11, proxy | -0.10 | -0.03 | 0.00 | 0% | -90.0% | -7.0% | 1573 | -0.10 / -0.17 | fail | -0.10 | fail | +0.17 | fail |
| `base/leaders` | 97, proxy | -0.20 | -0.21 | 0.00 | 0% | -96.1% | -7.5% | 8059 | -0.20 / -0.10 | fail | -0.20 | fail | +0.12 | fail |
| `base/fx3` | 3, proxy | -0.58 | -0.96 | 0.00 | 0% | -77.7% | -6.2% | 366 | -0.58 / -0.76 | fail | -0.58 | fail | -0.27 | fail |

### Proxy IV index against the Cboe index

| Symbol | Cboe index | Days | Median proxy / index | Mean absolute error |
| --- | --- | ---: | ---: | ---: |
| QQQ | VXN | 6489 | 1.01 | 10% |
| DIA | VXD | 5269 | 0.96 | 11% |
| IWM | RVX | 4310 | 1.02 | 9% |
| GLD | GVZ | 4640 | 1.05 | 16% |
| SLV | VXSLV | 3119 | 1.05 | 18% |
| USO | OVX | 4908 | 1.02 | 15% |

Reading:

- The missing options form no longer blocks these 36 strategies. They fail on the Sharpe checks, like the 19
  candidates of the allocation study.
- Study model: the best form is the volatility-targeted momentum `qj/W18` (Sharpe +0.18, max drawdown -23%). It
  passes the lower bar only without a bid/ask spread. It needs measured quotes of EFA, EEM, TLT, IEF, DBC and VNQ
  before it can be judged.
- Measured Core 7 model: the always-on Core 7 basket goes from +0.08 to +0.33. The 10-month SMA timing on SPY
  (+0.33) passes the lower bar as the always-on SPY spread does (+0.32). The trailing-stop trend `qj/O09` (+0.31)
  has a lower Sharpe than its baseline (+0.34); it passes with a max drawdown of -24.99% against the limit of
  -25%, and the always-on Core 7 basket fails on its drawdown (-40%). Neither timing rule adds Sharpe to the
  index call spread. This repeats the finding of the allocation study.
- The short strangle as an iron condor passes the lower bar in the measured model: Sharpe +0.34, 84% winners, max
  drawdown -6%, +0.5% a year at 1% risk per side. It is the only passer that is not a long index call spread. Its
  Sharpe is -0.01 in the study model and +0.19 with commissions only, so the pass depends on the skew of one
  chain snapshot.
- Dip-buying leaders: buying the dip state has a Sharpe of +0.06 in the study model and +0.26 with commissions
  only; the always-on spreads on the same names have -0.15 and +0.18. Buying the reclaim is weaker (-0.01 and
  +0.18). The max drawdown is -44% to -62%: a single-form run has no account cap, and up to 36% of equity was at
  risk at one time. The stock list has survivorship bias, and no single stock has measured quotes. The leader
  forms are not validated.
- A short side loses: its put debit spread pays a premium of its own. The pairs (`qj/W13` -0.68, `qj/W14` -0.54),
  the long/short sector forms (`qj/W15` -1.08, `qj/W16` -2.16) and the FX forms (-0.70 to -0.90) are at the bottom
  in every model.
- The sector, multi-asset and FX baskets have a negative Sharpe in the study model. Their half spreads (2% to 4%
  per leg) are assumptions; with commissions only the sector and multi-asset baskets are at +0.2.

Not checked here: live option quotes of the underlyings outside the Core 7, account-level risk caps for a form
with many names, intraday exits, interest on cash.
