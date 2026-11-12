# Leveraged ETF options for 24 to 48 hour windows: backtest study

Research only. This study places no orders, arms nothing and changes no engine setting. A result here
grants no trading authority.

## Question

Do the existing short-window signals, held for a 24 or 48 hour window, do better as options on a
leveraged ETF than as options on the unleveraged ETF? Decay, gap risk and costs are included. There is
one verdict per form row.

## Answer

<!-- answer:start -->
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
  ex-dividend days with and without the dividend. A fund's own distributions are not modeled.
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
- Inverse funds are used for shares only. A short signal in an option form buys a put on the long fund.
- The IBKR 5-minute bars are trades. The entry is a bar close, not a quote: there is no extra slippage
  beyond the half spread of the option model and the 10 basis points of the share form.
- Per-pair rows are booked in the ledger only and are not verdicts.

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
  --results ~/Documents/reports/vertex-leveraged-etf/results.json --ran 2026-11-11
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
