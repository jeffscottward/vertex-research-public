# Leveraged ETF options for 24 to 48 hour windows: study spec and verdict

Research only. This study places no orders, arms nothing and changes no engine setting. A result here grants no trading
authority. Card: `vertex-leveraged-etf-options`.

## Source

Owner decision of 2026-11-11: leveraged ETFs (2x, 3x, any leverage) are allowed for very short windows of 24 to 48 hours.
Options on them come first. Shares are a fallback where no usable option market exists, as a temporary holding. The 2%
maximum loss per trade of 2026-11-02 stays.

The study asks one question: do the existing short-window signals, held for 24 or 48 hours, do better as options on a
leveraged ETF than as options on the unleveraged ETF, with decay, gap risk and costs included?

## Rules (fixed before the first run)

The full method, the model assumptions and the limits are in
[research/backtests/leveraged-etf/README.md](../../../research/backtests/leveraged-etf/README.md). In short:

- Signals: session-open momentum and volume spike breakout, each with every signal and with the calm regime only.
- Pairs: QQQ/TQQQ, SPY/UPRO, IWM/TNA, DIA/UDOW (3x) and GLD/UGL, SLV/AGQ, USO/UCO (2x), with their inverse funds for the
  share form of a short signal.
- Windows: exit at the close of the next session (24 h) or of the second session (48 h). No stop inside the window.
- Forms: a long option and a debit vertical on the unleveraged ETF; a long option and a debit vertical on the leveraged
  fund; shares of the leveraged fund. 2 signals x 2 regimes x 2 windows x 5 forms = 40 form rows.
- Size: premium plus entry costs at most 2% of the current equity per trade; a share position at most 2%.
- Prices: real daily closes of the funds (they hold the daily reset, the decay, the fee and the financing); option prices
  are model prices (Black-Scholes, fund IV = leverage x ETF IV); commission and half spread on every leg and side.
- Booking: one book of 100,000 USD per form row with all 7 pairs. The ledger is the result; NautilusTrader books the same
  trades as a cross-check.

## Pass rule (set before the first run)

A form row passes only when it passes the allocation gate (`allocation.gate_checks`): at least 30 trades, Sharpe and
out-of-sample Sharpe at least 0.5, deflated Sharpe at least 0.95 with 40 trials, Monte Carlo probability of profit at
least 80%, Monte Carlo drawdown p5 not below -35%, maximum drawdown at most 25%, and a Sharpe above its baseline (the
ETF long option row of the same signal, regime and window). The lower bar of the funded pie
(Sharpe at least 0.3, positive out of sample, Monte Carlo profit at least 80%, maximum drawdown at most 25%, at least 30
trades) is reported beside it. A fail is never rounded up.

Only a form row that passes the gate may get a research-only row in the Strategy Library.

## Options expression (for any live use; not armed)

For a fund whose options pass the liquidity gate of the table `leveraged_etf_universe`
([leveraged-etf-universe.md](../../vertex-rebuild/leveraged-etf-universe.md)): a long call or a long put at 0.50 delta,
or a debit vertical whose short leg is 1 sigma further out of the money; expiry on the first Friday that is at least 3
sessions after the entry; premium plus costs at most 2% of the account. Shares are possible only after an owner decision
on the order gate: [leveraged-etf-share-fallback-gate.md](../research/leveraged-etf-share-fallback-gate.md).

## Results

Run of 2026-11-12 on the rig, code revision `fb919edf`, data to 2026-11-06 (QQQ from 2010; volume spike breakout from
2018). The run is complete: 40 of 40 form rows, 7 of 7 pairs. The largest relative equity difference between
NautilusTrader and the ledger is 4.3e-16.

| Form | Rows | Pass the gate | Pass the lower bar | Median Sharpe | Best Sharpe | Worst 2-session loss |
| --- | --- | --- | --- | --- | --- | --- |
| ETF long option | 8 | 0 | 0 | -0.77 | -0.29 | -21.9% |
| ETF debit vertical | 8 | 0 | 0 | -1.81 | -1.59 | -18.0% |
| Leveraged ETF long option | 8 | 0 | 0 | -1.06 | -0.83 | -15.2% |
| Leveraged ETF debit vertical | 8 | 0 | 0 | -2.18 | -1.84 | -12.8% |
| Leveraged ETF shares | 8 | 0 | 0 | -0.72 | -0.30 | -2.3% |

- Every option row ends with a loss of 58% to 100% of its book (maximum drawdown 71% to 100%). The share rows end with
  a loss of 4% to 46% (maximum drawdown 6% to 47%).
- A leveraged row has a higher Sharpe than its unleveraged twin in 7 of 24 rows: 6 share rows and 1 option row. "Higher"
  means less negative here: both rows of each of these pairs lose.
- The 2% cap is per trade. The book holds trades of up to 7 pairs at one time, so the largest loss over 2 sessions is far
  above 2%: -21.9% for the ETF long option (2010-05-10 to 2010-05-11).

All 40 rows are in the README of the study.

### Verdict

**No form passes.** 0 of 40 form rows pass the gate and 0 pass the lower bar. Leverage does not turn these signals into
a tradable options form: the option forms on the leveraged fund are worse than the same trades on the unleveraged ETF in
15 of 16 rows. No row was added to the Strategy Library.

The result is a model result (no historical option quotes). It does not say that leveraged ETFs cannot be used. It says
that these two signals, bought as weekly options or as shares on every signal and held for 24 or 48 hours, lose money
in this model. The share rows have no time decay and lose too, so the signals have no edge in this pooled form.
