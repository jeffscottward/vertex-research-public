# Leveraged ETF options for 24 to 48 hour windows: backtest study

Research only. This study places no orders, arms nothing and changes no engine setting. A result here
grants no trading authority.

## Question

Do the existing short-window signals, held for a 24 or 48 hour window, do better as options on a
leveraged ETF than as options on the unleveraged ETF? Decay, gap risk and costs are included. There is
one verdict per form row.

## Answer

<!-- answer:start -->
**No.** Run of 2026-11-12, all 7 pairs, data to 2026-11-06, code revision `fb919edf`:

- 0 of 40 form rows pass the gate. 0 of 40 pass the owner's lower bar.
- Every form loses with both signals, both regimes and both windows. Median Sharpe of the 8 rows of a form:
  `etf-option` -0.77, `etf-vertical` -1.81, `lev-option` -1.06, `lev-vertical` -2.18, `lev-shares` -0.72.
- Leverage does not help the option forms: a `lev-option` or `lev-vertical` row has a higher Sharpe than its
  unleveraged twin in 1 of 16 rows. `lev-shares` is above `etf-option` in 6 of 8 rows, and all 8 share rows lose.
- The signals have no edge in this pooled form: the share rows have no time decay and lose too (a loss of 4% to 46%
  of the book). In the option rows the time value of 1 or 2 sessions and the spread on both sides come on top: they
  end with a loss of 58% to 100% of the book. This reading was not measured as a split of the loss.
- The 2% cap is per trade, not per book. With up to 7 pairs open at one time, the largest loss over 2 sessions is
  -21.9% for an option row (`S1/all/48h/etf-option`, 2010-05-10 to 2010-05-11) and -2.3% for a share row.

No form row goes to the Strategy Library. Every option price is a model price ("Model assumptions", "Limits").
<!-- answer:end -->

## Design (fixed before the first run)

No parameter was changed after a result was seen. The readings of the design that had to be chosen are
listed in "Readings and deviations".

### Pairs

| U | Long fund | Inverse fund | Leverage | IV index |
| --- | --- | --- | --- | --- |
| QQQ | TQQQ | SQQQ | 3 | VXN |
| SPY | UPRO | SPXU | 3 | VIX |
| IWM | TNA | TZA | 3 | RVX |
| DIA | UDOW | SDOW | 3 | VXD |
| GLD | UGL | GLL | 2 | GVZ |
| SLV | AGQ | ZSL | 2 | VXSLV |
| USO | UCO | SCO | 2 | OVX |

U is the unleveraged ETF with intraday data. A pair is dropped only when its data cannot be loaded.
Each pair runs from the first day all its inputs exist: U's daily bar with an IV index value and a
rate, and a close of both funds.

### Signals

A signal is a direction (+1 or -1) on U and one entry time. Every form of a pair sees the same signals.

- S1 `session-open-momentum`: the noise-band kernel (`strategies/noise_band.py`) on U's 5-minute IBKR
  bars. Decisions on the bars that end on HH:00 and HH:30, from 10:00 to 15:30 New York. The signal is
  the first entry of the kernel in the session: the first decision bar that closes beyond the noise band
  and beyond the session VWAP. Direction = side of the break. Entry = the close of that bar. At most one
  signal per session and pair.
- S2 `volume-spike-breakout`: the rule of `strategies/volspike/rules.py` on the Dukascopy index of the
  pair (NAS100, US500, US2000, US30, XAUUSD, XAGUSD, WTI), from 2018-01-01. The parameters are
  `strategies.volspike.definition.NO_STOP`: the rule's defaults (`rules.Params()`) with exactly one
  field changed, `stop_kind="none"` instead of `"points"` (so the default `stop=15.0` is not used; see
  reading 2). Every other field is the default: `vol_mult=3.0`, `vol_n=50`, `k=5`, `time_stop=80`,
  session 08:30 to 12:00 tested on the candle close, `skip_weekdays=(2,)` (no Wednesday), `trend=True`
  with `trend_length=20`, `max_entries=2`, both sides. Entry on U at the signal time, at 09:35 New York
  when the signal is before the open.
- Regime `all`: every signal. Regime `calm`: a signal is kept only when, at the previous session's
  close, VIX <= 25 and VIX / VIX3M <= 1.0 (`GATES['volRegime']`) and the signal agrees with U's 200-day
  trend (long above the 200-day simple average, short below).

### Windows

- `24h`: exit at the close of the next session after the entry session.
- `48h`: exit at the close of the second session after the entry session.
- There is no stop inside the window. A new signal of the same pair and direction while a position is
  open is skipped (counted).

### Forms

| Key | Instrument | Structure |
| --- | --- | --- |
| `etf-option` | U | long call (+1) or long put (-1), 0.50 delta |
| `etf-vertical` | U | debit vertical: long 0.50 delta, short leg 1 sigma further out of the money |
| `lev-option` | long fund | long call (+1) or long put (-1), 0.50 delta |
| `lev-vertical` | long fund | debit vertical, same rule |
| `lev-shares` | long fund (+1) or inverse fund (-1) | buy shares, notional at most 2% of equity |

- Expiry of every option form: the first Friday that is at least 3 sessions after the entry session, so
  the 48 hour exit is never on the expiry day. When the Friday is a holiday: the last session of that
  week. The rule is the same for U and for the fund. The rule is also enforced: the exit session is a
  daily bar of U and the expiry is a day of the NYSE calendar, so a trade whose exit session is on or
  after its expiry (a hole in U's daily bars) is not priced and is counted as "exit on or after the
  expiry day".
- Size: whole contracts; premium plus entry costs at most 2% of the current equity. 0 contracts = the
  trade is refused (counted per row). Shares: whole shares; notional plus entry cost at most 2% of
  equity.
- Start capital: 100,000 USD per book.

### Prices and costs

- U: the 5-minute bar close at the entry; the daily close for marks and the exit.
- Fund, daily: real closes from Yahoo. They carry the daily reset, the decay, the fee and the
  financing. Strikes and premiums use AS-TRADED prices: every later split is undone with the splits
  file. A trade whose window holds a split of its instrument is not priced (counted).
- Fund, intraday at the entry: fund previous close x (1 + leverage x (U entry price / U previous
  close - 1)). The error of this formula at the close is in the tracking-error table below.
- Ex-dividend day of U: a fund follows U's total return, not its price return. On U's ex-dividend day U
  opens lower by the dividend and the fund does not. So when the entry session is U's ex-dividend date,
  the dividend is added back before the division: fund previous close x (1 + leverage x ((U entry
  price + dividend) / U previous close - 1)). The dividend comes from U's qc-ports daily file. The file
  has no dividend column; its `adj_close / close` steps on each ex-dividend date, and dividend =
  previous close x (1 - previous factor / factor). A step below 0.001% of the price is the rounding of
  the file and is no dividend (largest rounding step on the rig files 0.0002%, smallest dividend
  0.017%). QQQ, SPY, IWM and DIA pay dividends (90, 136, 107 and 341 ex-dividend dates in their files);
  GLD, SLV and USO pay none. The tracking-error table uses the same formula and shows the error on the
  ex-dividend days with and without the dividend. A fund's own distributions are not modeled (see
  "Limits").
- Option model: Black-Scholes with the qc-ports smile (`strategies/qc_ports/options.py`). IV of U = ATM
  factor x its Cboe index: the previous session's close for the entry, the session's own close for a
  mark and for the exit. Rate = IRX. Dividend yield of U as the model; of a fund 0.
- Costs: 0.65 USD per contract and half the spread per leg and side. U uses the spread class of the
  model. A fund is charged 4% of mid: the maximum the liquidity gate allows, so a fund that passes the
  gate costs at most this. Shares: 10 basis points of the price per side.

### Results unit and verdicts

- A FORM ROW = signal x regime x window x form: 2 x 2 x 2 x 5 = 40 rows. All pairs are pooled into one
  book of 100,000 USD per row. Each row is also booked per pair (own book, for the reader only).
- Statistics: `qc_ports/metrics.py` `summarize` (Sharpe, CAGR, max drawdown, deflated Sharpe with
  n_trials = 40 and the variance of the per-day Sharpes of the 40 rows), out-of-sample Sharpe = last
  40% of the days, Monte Carlo = `allocation.monte_carlo` (bootstrap of the trade profits: P(profit),
  drawdown p5 and the worst run).
- `worst48hLoss` (new, `strategies/leveraged_etf/metrics.py`): the most negative change of the daily
  equity over any 2 consecutive sessions, in percent of the equity at the start of those 2 sessions.
- `gate`: `allocation.gate_checks`. Its baseline check compares with the `etf-option` row of the same
  signal, regime and window (0 for the `etf-option` row itself).
- `lowerBar`: `funded_pie.LOWER_BAR` (Sharpe >= 0.3, positive out of sample, Monte Carlo profit >= 80%,
  max drawdown <= 25%, at least 30 trades).
- `leverageHelps` (only `lev-*` rows): yes when the row's Sharpe is above the Sharpe of its unleveraged
  twin row (`lev-option` against `etf-option`, `lev-vertical` against `etf-vertical`, `lev-shares`
  against `etf-option`). "Yes" means a higher Sharpe than the twin and nothing more: it is also "yes"
  when both rows lose and the `lev-*` row loses less per unit of risk. It is not a pass. When the twin
  row has no booked trade there is nothing to compare with: the row gets no verdict (`n/a`, with the
  reason), not a "yes". A `lev-*` row without a booked trade against a twin that traded is a "no".
- A row passes only when `gate` passes. A fail is never rounded up.
- Study verdict (one word for the whole study, in the `research_studies` document): `edge` when at
  least one `lev-*` row passes `gate`, else `no-edge`. An `etf-*` row that passes does not make an
  edge. The gate compares a row with the `etf-option` row and not with its twin, so `edge` can come from
  a `lev-shares` row, or from a `lev-vertical` row that is above `etf-option` but below its twin
  `etf-vertical`. `leverageHelps` and the lower bar are separate readings and are not part of the
  verdict. In the document's robustness table the gate row shows the same rule (pass = a `lev-*` row
  passes); the lower-bar row shows a count and no pass or fail.
- Complete run: only a run of all 40 rows on all 7 pairs, with no pair dropped, 100,000 USD and
  NautilusTrader booking is the study result. Every other run is marked PARTIAL in `results.json`
  (`complete` false, the reasons in `partial`) and in `results.md`, and gives no study document.
- Booking: every number is the qc-ports ledger's. A row with at least one priced trade is also booked
  on NautilusTrader and must match the ledger (see "How to run"). A row without a priced trade has
  nothing to book and is not run on NautilusTrader; `results.md` gives both counts.

## Model assumptions

These are assumptions, not measurements. Every option price in this study is a model price.

1. The IV of a fund option = |leverage| x the IV of U at the same standardized moneyness: the fund's ATM
   IV is |leverage| x U's, and the smile slope in standardized moneyness is U's. A daily-reset fund has
   |leverage| x the volatility of its benchmark. One measured chain ratio is shown below; the model was
   not fitted to it.
2. The half spread of a fund option is 4% of mid per leg and side for the whole history.
3. The fund's intraday price follows the daily-reset formula from the previous closes.
4. A vertical closes as a package (cost capped at the model's worst case). A position worth less than
   its closing cost is left to expire: the closing cost is capped at the exit value. So the largest loss
   of an option form is premium plus entry costs.
5. Time to expiry = calendar time to 16:00 New York on the expiry day / 365. The 16:00 close also stands
   for the 13:00 close of a half day.
6. The same spread classes, commission and strike grid (1 USD from a price of 25, else 0.50) are used
   back to the start.

## Limits

- Weekly expiries did not exist for every fund before about 2014. Earlier option prices are the model
  only; the trade could not have been made in that form.
- No historical option quotes: the result is as good as the model. The measured IV ratio shows the
  USO pair far from the model (UCO and SCO changed their benchmark in 2020 and track USO loosely; the
  tracking-error table shows it too).
- The entry is priced with the IV index of the previous close, as the design says (there is no intraday
  IV history). At the entry time the market has already moved, and real IV has moved with it (for the
  equity ETFs: lower after a rise, higher after a fall). The exit uses the IV of its own close. So the
  model pays too much for a call bought after a rise and too little for a put bought after a fall. This
  bias is the same for the ETF form and for the fund form of a signal, so it changes the level of a row
  more than the comparison between a `lev-*` row and its twin.
- A row that loses most of its equity refuses most later trades (2% of a small equity buys 0 units).
  The "Refused" column shows it. Such a row trades only the first part of its history.
- U's prices are the split-adjusted prices of the qc-ports model (only USO has a split in the period:
  1-for-8 on 2020-04-29). So before 2020-04-29 the `etf-*` rows of USO use prices 8 times the prices
  that traded. The costs and the grid are not scaled with them: the 1 USD strike grid, the 0.65 USD
  commission and the 0.01 USD minimum half spread are about 8 times smaller relative to the price than
  they were. This makes the USO twin (`etf-vertical`, `etf-option`) and the USO baseline (`etf-option`)
  cheaper to trade than they were. A cheaper twin and baseline work against the `lev-*` rows in
  `leverageHelps` and in the baseline check of the gate. The fund rows (UCO, SCO) use as-traded prices
  and are not affected. Only the USO part of a pooled row is touched.
- The share form trades more signals than the option forms where the IV index has no value. VXSLV
  (SLV) has no value on 810 SLV sessions, 2022-02-22 to 2025-05-14 (the daily file has no VXSLV row
  from 2022-02-12 to 2025-05-14; the loader carries the last value for 5 sessions). There all four option forms skip every SLV signal
  ("no IV") and `lev-shares` still trades it. So in that period `lev-shares` and its twin `etf-option`
  do not trade the same SLV signals. No other pair has a session without an IV index value.
- A fund's financing and borrow state is seen only through its daily close.
- A fund's own distribution is not in the synthetic entry price. On a fund's own ex-distribution date
  the real fund drops by the distribution and the synthetic price does not, so the synthetic price is
  too high. Median signed error at the close on those dates (rig data after the pair start, dates from
  `adj_close / close` of the fund files): inverse funds SQQQ +1.00%, SPXU +0.92%, SDOW +0.90%, TZA
  +0.58% (22 to 26 dates each); long funds TQQQ +0.26%, UDOW +0.22%, TNA +0.18%, UPRO +0.15% (22 to
  54 dates each; one TNA date is +13.0%). These are 0.5% to 1.3% of a fund's sessions. The funds of
  GLD, SLV and USO have no such date. Effect on a trade that enters on such a date: a call on the long
  fund and shares (of the long or the inverse fund) are bought slightly too dear, and a put on the
  long fund slightly too cheap. Only `lev-*` rows are touched. The tracking-error table has no column
  for these dates; they are inside its percentiles and its maximum.
- Inverse funds are used for shares only. A short signal in an option form buys a put on the long fund.
- The IBKR 5-minute bars are trades. The entry is a bar close, not a quote: there is no extra slippage
  beyond the half spread of the option model and the 10 basis points of the share form.
- Per-pair rows are booked in the ledger only and are not verdicts.
- The Monte Carlo columns come from `allocation.monte_carlo`: it resamples the trade profits in USD and adds them to
  the fixed start capital. A path can go below 0 equity, so a drawdown below -100% is possible in a row that loses
  its book. The gate reads such a value as a fail.

## Readings and deviations

The design text left these points open or could not be built as written. Each was fixed before the first
run.

1. S1 uses the kernel `run_futures_backtest` (scale 1) and not the ZAB kernel `run_backtest`. Reason: the
   ZAB kernel sizes shares from an account value and skips a decision when the share count is 0, so its
   entries depend on its own profit. The first entry of a session is the same rule in both kernels
   (checked on QQQ and USO: 0 sessions differ; the futures kernel starts 1 session earlier). A session
   after a missing NYSE session is a reference only (its previous close is 2 days old).
2. S2 runs the rule without its 15-point stop (`NO_STOP`, the defined-risk reading of the volspike
   study): the stop is stated in NAS100 points, and an option form has no stop. The signals are the
   entries of the rule's trades, so the rule's own limits stay: one position at a time (it leaves by the
   opposite signal or the time stop), at most 2 entries per day, no Wednesday, the 4-hour trend filter.
3. S2 entry on U = the close of the first 5-minute bar of U that ends at or after the rule's entry time.
   A signal before the open, or at 09:30, enters at 09:35. A signal on a day without a U session gives no
   trade (counted).
4. Overlap ("a position is open") is decided on the signals before pricing. So a signal whose trade was
   refused or not priced in one form still blocks the next signal of the same pair and direction, and
   every form of a row trades the same signals.
5. Sizing uses the largest possible loss: premium + entry costs for an option form (see assumption 4),
   price + entry cost for a share.
6. A missing IV index or rate at a mark or exit close carries the last value used (counted as stale
   days). A missing IV index at the entry gives no trade; so does a previous daily bar that is more
   than 5 calendar days old. Two limits of these counts: (a) the daily loader of qc-ports
   (`load_market`) already carries an index or rate value for up to 5 bar dates before it reports a
   missing value, and a value carried there is not counted in the stale days (on the rig files after
   the pair start: 5 sessions of IWM and 9 of SLV for the IV index); (b) the 5-day test at the entry is
   on the age of the daily bar, not of the IV value in it, so an entry can use an index value up to 5
   bar dates old.
7. The start of a pair is the same for every form: the `etf-*` rows also wait for the funds. Every form
   of a row sees the same signals (reading 4), but the forms do not all trade the same ones: each form
   has its own "not priced" reasons, counted per row in `results.md`. The four option forms need an IV
   index value at the entry and `lev-shares` does not, so `lev-shares` also trades the SLV signals of
   the VXSLV gap (see "Limits"). A split in the window is per instrument (U or the fund).
8. In the `calm` regime a missing VIX, VIX3M or 200-day average fails. A close equal to the average is
   neither above nor below.
9. A signal whose U price is more than 30% away from the previous daily close is not priced (data
   error guard; the intraday loader already drops such sessions).
10. The split rule is also applied to U (USO, 2020-04-29).
11. Found in review after the first full run, and the study was run again: the synthetic fund entry
    price used U's price return. On U's ex-dividend day that put the long fund too low by about
    leverage x dividend and the inverse fund too high (median error at the close on those days, rig
    data: UPRO -1.32%, TNA -1.03%, TQQQ -0.59%, UDOW -0.56%; other days about 0.07% in size). Only
    `lev-*` rows were touched, in favor of long signals. The formula now adds U's dividend back on its
    ex-dividend date (see "Prices and costs"), and the tracking-error table shows those days before and
    after. This is a correction of an error in the price model, not a parameter chosen from a result;
    the numbers of the first run are not the study result.
12. Found in the same review, with no effect on which trades are taken on the rig data: a trade whose
    exit session is on or after its expiry is now refused (0 cases after any pair start); a NaN in an
    equity series now fails the parity check; `leverageHelps` gives no verdict when the twin row has no
    trade; a run is complete only as defined in "Results unit and verdicts".

## Data

Nothing here is committed. All sources are free and public or already on the rig.

| Input | Source | Folder (env name) |
| --- | --- | --- |
| Fund daily bars and splits (14 funds), U splits | Yahoo, `fetch_data.py` of this folder | `~/Documents/reports/vertex-leveraged-etf/data` (`--data`) |
| U daily bars, Cboe volatility indices, IRX | qc-ports fetch | `~/Documents/reports/vertex-qc-ports/data` (`VERTEX_QC_PORTS_DATA`) |
| U 5-minute bars (IBKR TRADES) | imom fetch | `~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m` (`VERTEX_IMOM_IBKR_DATA`) |
| Index 1-minute bars (Dukascopy) | volspike fetch | `~/Documents/reports/vertex-volume-spike-data` (`VERTEX_VOLSPIKE_DATA_ROOT`) |

## How to run

```sh
# 1. Fund bars and splits (network, Yahoo). --end = the day after the last complete session.
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 --with pydantic==2.13.4 \
  python research/backtests/leveraged-etf/fetch_data.py \
  --out ~/Documents/reports/vertex-leveraged-etf/data --end 2026-11-07

# 2. The study: 40 form rows on NautilusTrader with ledger parity (venv with the Nautilus lock).
systemd-run --user --scope -p MemoryMax=14G \
  ~/.local/share/vertex/nautilus-venv/bin/python research/backtests/leveraged-etf/run.py \
  --data ~/Documents/reports/vertex-leveraged-etf/data \
  --out ~/Documents/reports/vertex-leveraged-etf/results.json \
  --iv-ratio ~/Documents/reports/vertex-leveraged-etf/iv-ratio-20261111.json --workers 20

# Diagnostics. Each makes a PARTIAL run: `complete` is false in the JSON, the tables start with a
# PARTIAL line that names the reasons, and step 3 refuses the file.
#   --no-nautilus  ledger only     --pairs QQQ  one pair     --only 'session-open-momentum/all/24h/*'
#   --capital N    another start capital

# 3. The research_studies document (prints one JSON document; imports nothing).
cd services/research
~/.local/share/vertex/nautilus-venv/bin/python -m strategies.leveraged_etf study \
  --results ~/Documents/reports/vertex-leveraged-etf/results.json --ran 2026-11-12
# It refuses a results file of a partial run, of a run without --iv-ratio, and of a run from
# uncommitted study code (`provenance.dirty` true): commit first, then run step 2.
# Contract check without a database:
#   ... | bun run vertex:research-studies:import --dry-run

# Tests
cd services/research
~/.local/share/vertex/nautilus-venv/bin/python -B -m pytest -q -p no:cacheprovider \
  tests/test_leveraged_etf_study.py tests/test_leveraged_etf_study_forms.py tests/test_leveraged_etf_study_run.py
```

`run.py` writes `results.json` and `results.md` (the tables below and every row per pair) and prints a
short summary. It stops with an error when the ledger and NautilusTrader differ by more than 1e-6
(relative) on the equity of a row, or on the units of a trade, or when an equity value of either book
is not a finite number.

## Results

<!-- results:start -->
Run of 2026-11-12 on the rig, code revision `fb919edf0146`, input hash `sha256:b56c68c6438dc701...`. Wall time 17 minutes with 20 worker processes. NautilusTrader booked 40 of 40 form rows (every row with a trade); the largest relative equity difference to the ledger is 4.3e-16.

Data to 2026-11-06. Start capital 100,000 USD per book. Engine: nautilus-trader-1.227.0. Every number is the qc-ports ledger's. 40 of 40 form rows have a priced trade: each was also booked on NautilusTrader and matches the ledger (relative tolerance 1e-06).

Rows that pass the gate: 0 of 40. Rows that pass the owner's lower bar: 0 of 40. `lev-*` rows where leverage helps (Sharpe above the twin row, also when both lose): 7 of 24.

### Form rows (all pairs pooled, one book per row)

Row = signal/regime/window/form. S1 = session-open-momentum, S2 = volume-spike-breakout. Skipped = signals skipped because a position of the same pair and direction was open. Refused = trades with 0 units at 2% of equity. Mean, median and worst trade are in percent of the equity before the trade. worst48hLoss = most negative change of the daily equity over 2 consecutive sessions, in percent.

| Row | First .. last trade | Trades | Refused | Skipped | Win | Mean % | Median % | Sharpe | OOS | DSR | Max DD | CAGR | MC P(profit) | MC DD p5 | MC worst run | Worst trade % | worst48hLoss % | gate | lowerBar | leverageHelps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1/all/24h/etf-option | 2008-12-04 .. 2020-03-03 | 3130 | 10337 | 4150 | 35.1% | -0.153 | -0.398 | -1.14 | 0.14 | 0.00 | -99.5% | -25.4% | 0% | -146.5% | -194.2% | -1.99 | -13.42 | fail (7 of 8 checks) | fail | - |
| S1/all/24h/etf-vertical | 2008-12-04 .. 2019-12-30 | 1994 | 11473 | 4150 | 33.9% | -0.266 | -0.398 | -1.93 | -0.52 | 0.00 | -99.6% | -26.4% | 0% | -126.2% | -153.3% | -1.99 | -13.89 | fail (7 of 8 checks) | fail | - |
| S1/all/24h/lev-option | 2008-12-04 .. 2025-06-30 | 2114 | 11326 | 4150 | 34.0% | -0.191 | -0.417 | -1.38 | -0.24 | 0.00 | -98.7% | -21.2% | 0% | -132.1% | -163.8% | -2.00 | -11.70 | fail (7 of 8 checks) | fail | no (-1.38 vs -1.14) |
| S1/all/24h/lev-vertical | 2008-12-04 .. 2025-06-30 | 1289 | 12151 | 4150 | 31.5% | -0.346 | -0.485 | -2.37 | 0.17 | 0.00 | -99.0% | -22.5% | 0% | -120.4% | -136.9% | -1.99 | -12.80 | fail (7 of 8 checks) | fail | no (-2.37 vs -1.93) |
| S1/all/24h/lev-shares | 2008-12-04 .. 2026-11-05 | 13809 | 0 | 4150 | 46.7% | -0.004 | -0.004 | -1.12 | -1.11 | 0.00 | -47.0% | -3.4% | 0% | -59.2% | -80.3% | -0.59 | -1.50 | fail (6 of 8 checks) | fail | yes (-1.12 vs -1.14) |
| S1/all/48h/etf-option | 2008-12-04 .. 2020-03-03 | 2320 | 8597 | 6770 | 32.6% | -0.198 | -0.596 | -1.11 | -0.33 | 0.00 | -99.4% | -24.7% | 0% | -136.4% | -166.5% | -2.00 | -21.91 | fail (7 of 8 checks) | fail | - |
| S1/all/48h/etf-vertical | 2008-12-04 .. 2019-12-30 | 1667 | 9250 | 6770 | 33.7% | -0.311 | -0.566 | -1.72 | -0.63 | 0.00 | -99.6% | -26.2% | 0% | -128.7% | -150.8% | -1.99 | -18.03 | fail (7 of 8 checks) | fail | - |
| S1/all/48h/lev-option | 2008-12-04 .. 2026-01-06 | 1756 | 9131 | 6770 | 32.7% | -0.203 | -0.669 | -1.05 | 0.39 | 0.00 | -98.4% | -19.5% | 0% | -130.0% | -158.7% | -2.00 | -15.16 | fail (6 of 8 checks) | fail | yes (-1.05 vs -1.11) |
| S1/all/48h/lev-vertical | 2008-12-04 .. 2025-06-30 | 1272 | 9615 | 6770 | 33.1% | -0.335 | -0.630 | -1.84 | -0.50 | 0.00 | -98.9% | -21.8% | 0% | -122.3% | -145.6% | -2.00 | -10.22 | fail (7 of 8 checks) | fail | no (-1.84 vs -1.72) |
| S1/all/48h/lev-shares | 2008-12-04 .. 2026-11-04 | 11180 | 0 | 6770 | 47.2% | -0.005 | -0.005 | -0.97 | -0.79 | 0.00 | -43.8% | -3.1% | 0% | -58.2% | -69.3% | -1.13 | -2.33 | fail (6 of 8 checks) | fail | yes (-0.97 vs -1.11) |
| S1/calm/24h/etf-option | 2009-07-22 .. 2025-09-15 | 2011 | 3637 | 1604 | 36.5% | -0.189 | -0.347 | -1.16 | 0.15 | 0.00 | -98.6% | -20.4% | 0% | -131.8% | -152.5% | -2.00 | -12.95 | fail (7 of 8 checks) | fail | - |
| S1/calm/24h/etf-vertical | 2009-07-22 .. 2020-02-18 | 1407 | 4241 | 1604 | 33.7% | -0.348 | -0.393 | -2.27 | -0.88 | 0.00 | -99.4% | -24.4% | 0% | -121.2% | -140.9% | -2.00 | -12.31 | fail (7 of 8 checks) | fail | - |
| S1/calm/24h/lev-option | 2009-07-22 .. 2026-01-06 | 1821 | 3816 | 1604 | 34.5% | -0.194 | -0.362 | -1.28 | 0.19 | 0.00 | -98.0% | -18.8% | 0% | -122.5% | -146.9% | -2.00 | -12.40 | fail (7 of 8 checks) | fail | no (-1.28 vs -1.16) |
| S1/calm/24h/lev-vertical | 2009-07-22 .. 2025-08-26 | 1303 | 4334 | 1604 | 32.5% | -0.322 | -0.382 | -2.31 | 0.10 | 0.00 | -98.7% | -21.2% | 0% | -117.5% | -138.6% | -2.00 | -10.95 | fail (7 of 8 checks) | fail | no (-2.31 vs -2.27) |
| S1/calm/24h/lev-shares | 2009-07-22 .. 2026-11-05 | 5780 | 0 | 1604 | 48.3% | -0.005 | -0.002 | -0.87 | -0.84 | 0.00 | -23.5% | -1.5% | 0% | -32.0% | -38.0% | -0.54 | -1.26 | fail (4 of 8 checks) | fail | yes (-0.87 vs -1.16) |
| S1/calm/48h/etf-option | 2009-07-22 .. 2025-08-20 | 1769 | 2879 | 2634 | 35.2% | -0.205 | -0.504 | -0.88 | -0.26 | 0.00 | -98.4% | -20.1% | 0% | -126.8% | -145.7% | -2.00 | -11.74 | fail (7 of 8 checks) | fail | - |
| S1/calm/48h/etf-vertical | 2009-07-22 .. 2021-09-28 | 1240 | 3408 | 2634 | 33.3% | -0.385 | -0.507 | -1.88 | -0.68 | 0.00 | -99.3% | -24.1% | 0% | -121.1% | -136.4% | -2.00 | -11.03 | fail (7 of 8 checks) | fail | - |
| S1/calm/48h/lev-option | 2009-07-22 .. 2026-01-06 | 1419 | 3216 | 2634 | 31.7% | -0.248 | -0.569 | -1.07 | -0.19 | 0.00 | -97.9% | -19.0% | 0% | -119.7% | -142.3% | -2.00 | -10.46 | fail (7 of 8 checks) | fail | no (-1.07 vs -0.88) |
| S1/calm/48h/lev-vertical | 2009-07-22 .. 2026-01-06 | 1124 | 3511 | 2634 | 32.7% | -0.362 | -0.501 | -1.89 | -0.07 | 0.00 | -98.6% | -20.9% | 0% | -119.9% | -143.0% | -2.00 | -10.70 | fail (7 of 8 checks) | fail | no (-1.89 vs -1.88) |
| S1/calm/48h/lev-shares | 2009-07-22 .. 2026-11-03 | 4747 | 0 | 2634 | 49.9% | -0.005 | -0.000 | -0.66 | -0.48 | 0.00 | -21.4% | -1.3% | 0% | -31.6% | -38.9% | -1.13 | -1.14 | fail (4 of 8 checks) | fail | yes (-0.66 vs -0.88) |
| S2/all/24h/etf-option | 2018-01-05 .. 2026-11-02 | 2903 | 972 | 1253 | 37.3% | -0.056 | -0.341 | -0.64 | 0.13 | 0.00 | -90.6% | -20.6% | 2% | -154.1% | -224.6% | -2.00 | -10.44 | fail (7 of 8 checks) | fail | - |
| S2/all/24h/etf-vertical | 2018-01-05 .. 2025-12-22 | 1246 | 2629 | 1253 | 34.9% | -0.251 | -0.433 | -2.26 | 0.08 | 0.00 | -96.5% | -30.8% | 0% | -126.7% | -148.9% | -2.00 | -10.50 | fail (7 of 8 checks) | fail | - |
| S2/all/24h/lev-option | 2018-01-05 .. 2026-09-15 | 2771 | 1097 | 1253 | 35.5% | -0.090 | -0.375 | -0.97 | -0.21 | 0.00 | -96.2% | -27.9% | 0% | -152.2% | -228.7% | -1.99 | -9.09 | fail (7 of 8 checks) | fail | no (-0.97 vs -0.64) |
| S2/all/24h/lev-vertical | 2018-01-05 .. 2025-12-22 | 1322 | 2546 | 1253 | 34.3% | -0.269 | -0.429 | -2.51 | -0.76 | 0.00 | -97.6% | -34.0% | 0% | -124.1% | -147.7% | -1.99 | -9.54 | fail (7 of 8 checks) | fail | no (-2.51 vs -2.26) |
| S2/all/24h/lev-shares | 2018-01-05 .. 2026-11-02 | 4077 | 0 | 1253 | 48.2% | -0.004 | -0.003 | -0.79 | -0.92 | 0.00 | -18.3% | -2.0% | 0% | -26.1% | -30.9% | -0.66 | -2.09 | fail (5 of 8 checks) | fail | no (-0.79 vs -0.64) |
| S2/all/48h/etf-option | 2018-01-05 .. 2026-07-07 | 1966 | 1263 | 1934 | 33.3% | -0.101 | -0.649 | -0.67 | -0.10 | 0.00 | -92.9% | -24.4% | 1% | -154.4% | -207.2% | -2.00 | -12.79 | fail (7 of 8 checks) | fail | - |
| S2/all/48h/etf-vertical | 2018-01-05 .. 2026-01-02 | 1175 | 2054 | 1934 | 34.1% | -0.248 | -0.668 | -1.59 | 0.22 | 0.00 | -96.1% | -29.8% | 0% | -136.4% | -180.5% | -2.00 | -11.03 | fail (7 of 8 checks) | fail | - |
| S2/all/48h/lev-option | 2018-01-05 .. 2025-12-22 | 2041 | 1179 | 1934 | 33.1% | -0.141 | -0.652 | -0.97 | -0.84 | 0.00 | -97.1% | -31.8% | 0% | -151.6% | -197.8% | -2.00 | -12.55 | fail (7 of 8 checks) | fail | no (-0.97 vs -0.67) |
| S2/all/48h/lev-vertical | 2018-01-05 .. 2025-12-22 | 1254 | 1966 | 1934 | 35.0% | -0.278 | -0.679 | -1.90 | -1.16 | 0.00 | -97.6% | -34.1% | 0% | -130.4% | -165.2% | -2.00 | -11.24 | fail (7 of 8 checks) | fail | no (-1.90 vs -1.59) |
| S2/all/48h/lev-shares | 2018-01-05 .. 2026-11-02 | 3393 | 0 | 1934 | 47.9% | -0.004 | -0.005 | -0.48 | -0.40 | 0.00 | -14.2% | -1.4% | 3% | -22.9% | -32.1% | -0.90 | -1.82 | fail (4 of 8 checks) | fail | yes (-0.48 vs -0.67) |
| S2/calm/24h/etf-option | 2018-01-05 .. 2026-11-02 | 1851 | 14 | 607 | 40.6% | -0.033 | -0.289 | -0.29 | 0.36 | 0.00 | -71.4% | -9.3% | 6% | -120.1% | -182.1% | -2.00 | -6.73 | fail (7 of 8 checks) | fail | - |
| S2/calm/24h/etf-vertical | 2018-01-05 .. 2026-10-19 | 1278 | 587 | 607 | 39.7% | -0.175 | -0.275 | -1.75 | -0.48 | 0.00 | -90.8% | -23.3% | 0% | -117.8% | -136.3% | -2.00 | -6.31 | fail (7 of 8 checks) | fail | - |
| S2/calm/24h/lev-option | 2018-01-05 .. 2026-11-02 | 1816 | 46 | 607 | 37.5% | -0.094 | -0.340 | -0.83 | -0.36 | 0.00 | -88.2% | -20.0% | 0% | -141.1% | -177.3% | -1.99 | -6.91 | fail (7 of 8 checks) | fail | no (-0.83 vs -0.29) |
| S2/calm/24h/lev-vertical | 2018-01-05 .. 2026-08-11 | 1288 | 574 | 607 | 37.3% | -0.234 | -0.335 | -2.35 | -1.33 | 0.00 | -95.8% | -29.7% | 0% | -121.5% | -147.4% | -1.99 | -6.28 | fail (7 of 8 checks) | fail | no (-2.35 vs -1.75) |
| S2/calm/24h/lev-shares | 2018-01-05 .. 2026-11-02 | 1961 | 0 | 607 | 49.7% | -0.002 | -0.001 | -0.40 | -0.39 | 0.00 | -6.4% | -0.5% | 6% | -10.8% | -14.2% | -0.40 | -0.63 | fail (5 of 8 checks) | fail | no (-0.40 vs -0.29) |
| S2/calm/48h/etf-option | 2018-01-05 .. 2026-10-29 | 1313 | 234 | 939 | 35.9% | -0.112 | -0.566 | -0.66 | 0.14 | 0.00 | -85.8% | -18.0% | 0% | -132.3% | -178.8% | -2.00 | -11.00 | fail (7 of 8 checks) | fail | - |
| S2/calm/48h/etf-vertical | 2018-01-05 .. 2026-07-07 | 940 | 607 | 939 | 36.6% | -0.260 | -0.546 | -1.65 | -0.51 | 0.00 | -93.0% | -25.3% | 0% | -123.4% | -150.6% | -2.00 | -9.17 | fail (7 of 8 checks) | fail | - |
| S2/calm/48h/lev-option | 2018-01-05 .. 2026-10-16 | 1268 | 275 | 939 | 34.1% | -0.190 | -0.644 | -1.10 | -0.59 | 0.00 | -94.1% | -26.1% | 0% | -135.0% | -170.4% | -2.00 | -10.63 | fail (7 of 8 checks) | fail | no (-1.10 vs -0.66) |
| S2/calm/48h/lev-vertical | 2018-01-05 .. 2026-07-07 | 952 | 591 | 939 | 34.3% | -0.324 | -0.572 | -2.04 | -0.98 | 0.00 | -96.4% | -30.5% | 0% | -124.9% | -144.4% | -2.00 | -9.33 | fail (7 of 8 checks) | fail | no (-2.04 vs -1.65) |
| S2/calm/48h/lev-shares | 2018-01-05 .. 2026-10-29 | 1628 | 0 | 939 | 49.4% | -0.003 | -0.001 | -0.30 | 0.07 | 0.00 | -6.2% | -0.5% | 12% | -11.6% | -16.2% | -0.55 | -0.82 | fail (4 of 8 checks) | fail | yes (-0.30 vs -0.66) |

#### Failed gate checks per row

- `S1/all/24h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/24h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/24h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/24h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/24h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%.
- `S1/all/48h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/48h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/48h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%.
- `S1/all/48h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/all/48h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%.
- `S1/calm/24h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/24h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/24h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/24h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/24h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80.
- `S1/calm/48h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/48h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/48h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/48h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S1/calm/48h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80.
- `S2/all/24h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/24h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/24h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/24h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/24h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G7 Sharpe above its always-on baseline.
- `S2/all/48h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/48h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/48h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/48h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/all/48h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80.
- `S2/calm/24h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/24h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/24h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/24h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/24h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G7 Sharpe above its always-on baseline.
- `S2/calm/48h/etf-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/48h/etf-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/48h/lev-option`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/48h/lev-vertical`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80; G6 Monte Carlo drawdown p5 >= -35%; G7 max drawdown <= 25%; G7 Sharpe above its always-on baseline.
- `S2/calm/48h/lev-shares`: gate fails: G4 Sharpe >= 0.5; G4 out-of-sample Sharpe >= 0.5; G5 deflated Sharpe >= 0.95; G6 Monte Carlo P(profit) >= 0.80.

#### Signals, skips and refusals per row

| Row | Signals | Skipped (overlap) | No exit session | Taken | Priced | Not priced | Refused (size) | Booked | Stale days |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1/all/24h/etf-option | 17992 | 4150 | 3 | 13839 | 13467 | no IV: 370; no rate: 2 | 10337 | 3130 | 14 |
| S1/all/24h/etf-vertical | 17992 | 4150 | 3 | 13839 | 13467 | no IV: 370; no rate: 2 | 11473 | 1994 | 14 |
| S1/all/24h/lev-option | 17992 | 4150 | 3 | 13839 | 13440 | no IV: 370; no rate: 2; split in the window: 27 | 11326 | 2114 | 14 |
| S1/all/24h/lev-vertical | 17992 | 4150 | 3 | 13839 | 13440 | no IV: 370; no rate: 2; split in the window: 27 | 12151 | 1289 | 14 |
| S1/all/24h/lev-shares | 17992 | 4150 | 3 | 13839 | 13809 | split in the window: 30 | 0 | 13809 | 0 |
| S1/all/48h/etf-option | 17992 | 6770 | 8 | 11214 | 10917 | no IV: 296; no rate: 1 | 8597 | 2320 | 11 |
| S1/all/48h/etf-vertical | 17992 | 6770 | 8 | 11214 | 10917 | no IV: 296; no rate: 1 | 9250 | 1667 | 11 |
| S1/all/48h/lev-option | 17992 | 6770 | 8 | 11214 | 10887 | no IV: 296; no rate: 1; split in the window: 30 | 9131 | 1756 | 11 |
| S1/all/48h/lev-vertical | 17992 | 6770 | 8 | 11214 | 10887 | no IV: 296; no rate: 1; split in the window: 30 | 9615 | 1272 | 11 |
| S1/all/48h/lev-shares | 17992 | 6770 | 8 | 11214 | 11180 | split in the window: 34 | 0 | 11180 | 0 |
| S1/calm/24h/etf-option | 7394 | 1604 | 0 | 5790 | 5648 | no IV: 142 | 3637 | 2011 | 0 |
| S1/calm/24h/etf-vertical | 7394 | 1604 | 0 | 5790 | 5648 | no IV: 142 | 4241 | 1407 | 0 |
| S1/calm/24h/lev-option | 7394 | 1604 | 0 | 5790 | 5637 | no IV: 142; split in the window: 11 | 3816 | 1821 | 0 |
| S1/calm/24h/lev-vertical | 7394 | 1604 | 0 | 5790 | 5637 | no IV: 142; split in the window: 11 | 4334 | 1303 | 0 |
| S1/calm/24h/lev-shares | 7394 | 1604 | 0 | 5790 | 5780 | split in the window: 10 | 0 | 5780 | 0 |
| S1/calm/48h/etf-option | 7394 | 2634 | 1 | 4759 | 4648 | no IV: 111 | 2879 | 1769 | 0 |
| S1/calm/48h/etf-vertical | 7394 | 2634 | 1 | 4759 | 4648 | no IV: 111 | 3408 | 1240 | 0 |
| S1/calm/48h/lev-option | 7394 | 2634 | 1 | 4759 | 4635 | no IV: 111; split in the window: 13 | 3216 | 1419 | 0 |
| S1/calm/48h/lev-vertical | 7394 | 2634 | 1 | 4759 | 4635 | no IV: 111; split in the window: 13 | 3511 | 1124 | 0 |
| S1/calm/48h/lev-shares | 7394 | 2634 | 1 | 4759 | 4747 | split in the window: 12 | 0 | 4747 | 0 |
| S2/all/24h/etf-option | 5339 | 1253 | 0 | 4086 | 3875 | no IV: 210; no rate: 1 | 972 | 2903 | 9 |
| S2/all/24h/etf-vertical | 5339 | 1253 | 0 | 4086 | 3875 | no IV: 210; no rate: 1 | 2629 | 1246 | 9 |
| S2/all/24h/lev-option | 5339 | 1253 | 0 | 4086 | 3868 | no IV: 210; no rate: 1; split in the window: 7 | 1097 | 2771 | 9 |
| S2/all/24h/lev-vertical | 5339 | 1253 | 0 | 4086 | 3868 | no IV: 210; no rate: 1; split in the window: 7 | 2546 | 1322 | 9 |
| S2/all/24h/lev-shares | 5339 | 1253 | 0 | 4086 | 4077 | split in the window: 9 | 0 | 4077 | 0 |
| S2/all/48h/etf-option | 5339 | 1934 | 0 | 3405 | 3229 | no IV: 175; no rate: 1 | 1263 | 1966 | 10 |
| S2/all/48h/etf-vertical | 5339 | 1934 | 0 | 3405 | 3229 | no IV: 175; no rate: 1 | 2054 | 1175 | 10 |
| S2/all/48h/lev-option | 5339 | 1934 | 0 | 3405 | 3220 | no IV: 175; no rate: 1; split in the window: 9 | 1179 | 2041 | 10 |
| S2/all/48h/lev-vertical | 5339 | 1934 | 0 | 3405 | 3220 | no IV: 175; no rate: 1; split in the window: 9 | 1966 | 1254 | 10 |
| S2/all/48h/lev-shares | 5339 | 1934 | 0 | 3405 | 3393 | split in the window: 12 | 0 | 3393 | 0 |
| S2/calm/24h/etf-option | 2571 | 607 | 0 | 1964 | 1865 | no IV: 99 | 14 | 1851 | 0 |
| S2/calm/24h/etf-vertical | 2571 | 607 | 0 | 1964 | 1865 | no IV: 99 | 587 | 1278 | 0 |
| S2/calm/24h/lev-option | 2571 | 607 | 0 | 1964 | 1862 | no IV: 99; split in the window: 3 | 46 | 1816 | 0 |
| S2/calm/24h/lev-vertical | 2571 | 607 | 0 | 1964 | 1862 | no IV: 99; split in the window: 3 | 574 | 1288 | 0 |
| S2/calm/24h/lev-shares | 2571 | 607 | 0 | 1964 | 1961 | split in the window: 3 | 0 | 1961 | 0 |
| S2/calm/48h/etf-option | 2571 | 939 | 0 | 1632 | 1547 | no IV: 85 | 234 | 1313 | 0 |
| S2/calm/48h/etf-vertical | 2571 | 939 | 0 | 1632 | 1547 | no IV: 85 | 607 | 940 | 0 |
| S2/calm/48h/lev-option | 2571 | 939 | 0 | 1632 | 1543 | no IV: 85; split in the window: 4 | 275 | 1268 | 0 |
| S2/calm/48h/lev-vertical | 2571 | 939 | 0 | 1632 | 1543 | no IV: 85; split in the window: 4 | 591 | 952 | 0 |
| S2/calm/48h/lev-shares | 2571 | 939 | 0 | 1632 | 1628 | split in the window: 4 | 0 | 1628 | 0 |

### Data start per pair and signal

| U | Long fund | Inverse fund | Leverage | IV index | Inputs from | S1 first signal | S2 first signal | S1 signals (all / calm) | S2 signals (all / calm) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QQQ | TQQQ | SQQQ | 3 | VXN | 2010-02-11 | 2010-02-23 | 2018-01-09 | 2500 / 1058 | 712 / 413 |
| SPY | UPRO | SPXU | 3 | VIX | 2009-06-25 | 2009-06-30 | 2018-01-12 | 2657 / 1120 | 958 / 500 |
| IWM | TNA | TZA | 3 | RVX | 2009-09-16 | 2009-09-17 | 2019-03-28 | 2725 / 1090 | 885 / 387 |
| DIA | UDOW | SDOW | 3 | VXD | 2010-02-11 | 2010-02-18 | 2018-01-09 | 2561 / 1075 | 1025 / 488 |
| GLD | UGL | GLL | 2 | GVZ | 2008-12-03 | 2008-12-04 | 2018-01-05 | 2565 / 1044 | 381 / 173 |
| SLV | AGQ | ZSL | 2 | VXSLV | 2011-03-16 | 2011-03-18 | 2018-01-05 | 2192 / 900 | 597 / 257 |
| USO | UCO | SCO | 2 | OVX | 2008-11-25 | 2008-12-04 | 2018-01-05 | 2792 / 1107 | 781 / 353 |

### Tracking error of the synthetic fund price

Synthetic close (previous close x (1 + leverage x move of U)) against the real close, absolute error in percent of the real close. This is how far the modeled intraday entry price of a fund can be off. The move of U is its total return: on U's ex-dividend day the dividend is added back to U's price. The last three columns are U's ex-dividend days alone: their number and the median SIGNED error (below 0 = synthetic price too low) of the formula without the dividend and of the formula the study uses.

| Fund | U | Leverage | Days | From | Median % | 95th percentile % | Max % | Ex-dividend days | Ex-dividend median, no dividend % | Ex-dividend median, used % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TQQQ | QQQ | 3 | 4202 | 2010-02-12 | 0.065 | 0.287 | 5.6 | 70 | -0.593 | 0.005 |
| SQQQ | QQQ | -3 | 4202 | 2010-02-12 | 0.076 | 0.321 | 5.5 | 70 | 0.587 | 0.008 |
| UPRO | SPY | 3 | 4364 | 2009-06-26 | 0.061 | 0.239 | 3.5 | 69 | -1.318 | 0.036 |
| SPXU | SPY | -3 | 4363 | 2009-06-26 | 0.080 | 0.274 | 4.9 | 69 | 1.348 | -0.009 |
| TNA | IWM | 3 | 4516 | 2008-11-20 | 0.085 | 0.341 | 13.0 | 72 | -1.027 | 0.011 |
| TZA | IWM | -3 | 4511 | 2008-11-20 | 0.097 | 0.373 | 4.4 | 72 | 0.948 | 0.010 |
| UDOW | DIA | 3 | 4205 | 2010-02-12 | 0.065 | 0.264 | 5.5 | 201 | -0.557 | 0.034 |
| SDOW | DIA | -3 | 4205 | 2010-02-12 | 0.077 | 0.268 | 2.5 | 201 | 0.530 | -0.034 |
| UGL | GLD | 2 | 4508 | 2008-12-04 | 0.069 | 0.311 | 2.7 | 0 | n/a | n/a |
| GLL | GLD | -2 | 4505 | 2008-12-04 | 0.075 | 0.339 | 2.7 | 0 | n/a | n/a |
| AGQ | SLV | 2 | 4506 | 2008-12-05 | 0.134 | 0.584 | 7.1 | 0 | n/a | n/a |
| ZSL | SLV | -2 | 4502 | 2008-12-04 | 0.168 | 0.771 | 11.4 | 0 | n/a | n/a |
| UCO | USO | 2 | 4508 | 2008-11-26 | 0.187 | 1.471 | 26.8 | 0 | n/a | n/a |
| SCO | USO | -2 | 4508 | 2008-11-26 | 0.184 | 1.521 | 37.8 | 0 | n/a | n/a |

### Measured IV ratio (not used by the model)

Fund ATM IV / (|leverage| x U ATM IV). Cboe delayed quotes, read 2026-11-12 about 02:00 UTC (after the close of 2026-11-11); ATM IV = mean Cboe iv of calls and puts at the 2 strikes nearest the close

| U | Long fund | Leverage | Expiry | DTE | U ATM IV | Long fund ATM IV | Ratio long fund | Ratio inverse fund |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| QQQ | TQQQ | 3 | 261116 | 5 | 0.210 | 0.623 | 0.99 | n/a |
| QQQ | TQQQ | 3 | 261118 | 7 | 0.243 | 0.714 | 0.98 | n/a |
| QQQ | TQQQ | 3 | 261120 | 9 | 0.256 | 0.759 | 0.99 | 1.01 |
| SPY | UPRO | 3 | 261120 | 9 | 0.141 | 0.429 | 1.02 | 1.11 |
| SPY | UPRO | 3 | 261127 | 16 | 0.131 | 0.396 | 1.01 | n/a |
| SPY | UPRO | 3 | 261204 | 23 | 0.134 | 0.396 | 0.98 | n/a |
| IWM | TNA | 3 | 261120 | 9 | 0.171 | 0.529 | 1.03 | 1.06 |
| IWM | TNA | 3 | 261127 | 16 | 0.163 | 0.510 | 1.04 | n/a |
| IWM | TNA | 3 | 261204 | 23 | 0.169 | 0.532 | 1.05 | n/a |
| DIA | UDOW | 3 | 261120 | 9 | 0.136 | 0.480 | 1.18 | 1.18 |
| DIA | UDOW | 3 | 261218 | 37 | 0.134 | 0.447 | 1.11 | 1.16 |
| GLD | UGL | 2 | 261120 | 9 | 0.227 | 0.444 | 0.98 | 1.07 |
| GLD | UGL | 2 | 261218 | 37 | 0.222 | 0.441 | 0.99 | 1.08 |
| SLV | AGQ | 2 | 261120 | 9 | 0.385 | 0.902 | 1.17 | 1.12 |
| SLV | AGQ | 2 | 261127 | 16 | 0.375 | 0.833 | 1.11 | n/a |
| SLV | AGQ | 2 | 261204 | 23 | 0.376 | 0.795 | 1.06 | n/a |
| USO | UCO | 2 | 261120 | 9 | 0.437 | 0.618 | 0.71 | 0.70 |
| USO | UCO | 2 | 261218 | 37 | 0.476 | 0.675 | 0.71 | 0.73 |

Every row per pair (280 lines) is in `results.md` of the report work directory. `python -m strategies.leveraged_etf tables --results <results.json>` prints it again.
<!-- results:end -->

## Files

| File | Content |
| --- | --- |
| `services/research/strategies/leveraged_etf/pairs.py` | pair table |
| `.../prices.py` | as-traded fund prices, synthetic intraday price, tracking error |
| `.../signals.py` | S1, S2, regime, window, overlap |
| `.../forms.py` | data shapes, pricing of the five forms, booking (ledger and NautilusTrader) |
| `.../metrics.py` | `worst48hLoss`, row statistics, verdicts |
| `.../runner.py` | run plan and results document |
| `.../report.py` | results tables |
| `.../study.py`, `.../__main__.py` | the `research_studies` document and its command |
| `services/research/tests/test_leveraged_etf_study*.py` | tests |
| `research/backtests/leveraged-etf/fetch_data.py`, `run.py` | data fetch and the study run |
