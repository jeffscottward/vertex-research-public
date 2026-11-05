# Technical indicators

Vertex has one indicator formula set in two places. Both are for research, backtests, paper review and chart display. No indicator value gives trading authority, and no indicator code places or changes orders.

## Where the code is

|Layer|Path|Use|
|---|---|---|
|Python research library|`services/research/indicators/`|Pure functions for research and backtest code. No pandas, numpy, clock, network or provider access.|
|Web chart math|`apps/web/src/features/charts/indicator-math.ts`|The same formulas as IEEE doubles, for drawing only.|
|Web chart studies|`apps/web/src/features/charts/vertex-studies.ts`|Registers each study as a KLineCharts 9.8.12 custom indicator. The `/charts` page shows one checkbox per study.|
|Exact indicator series|`apps/web/src/features/charts/indicators.ts`|Unchanged: SMA, EMA, VWAP and RSI with exact bigint arithmetic and data-rights checks.|

## Indicators

|Indicator|Python|Chart study (fixed parameters)|Formula convention|
|---|---|---|---|
|SMA|`sma`|built-in MA|Trailing mean.|
|EMA|`ema`|built-in EMA|Alpha 2/(n+1), seeded with the first full SMA (TA-Lib EMA).|
|SMMA|`smma`|SMMA 20|Wilder smoothing (RMA): SMA seed, then (previous·(n−1)+value)/n.|
|LWMA|`lwma`|LWMA 20|Weights 1..n, newest bar heaviest (TA-Lib WMA).|
|RSI|`rsi`|none|Wilder RSI (TA-Lib RSI). A flat window gives 50.|
|Rolling VWAP|`rolling_vwap`|none|Volume-weighted typical price over n candles. Zero volume gives a gap.|
|True range, ATR|`true_range`, `atr`|ATR 14|TA-Lib TRANGE and ATR (Wilder). `method="sma"` gives the plain mean of true range.|
|Bollinger Bands|`bollinger_bands`|Bollinger 20, 2|SMA ± k population standard deviations (TA-Lib BBANDS).|
|Parabolic SAR|`parabolic_sar`|Parabolic SAR|Wilder SAR (TA-Lib SAR), acceleration 0.02, maximum 0.2.|
|MACD|`macd`|MACD 12, 26, 9|TA-Lib MACD seeding. The MACD line starts at bar slow−1; TA-Lib hides it until the signal starts.|
|Stochastic|`stochastic`|Stochastic 14, 3, 3|TA-Lib STOCH with SMA smoothing. %K starts at bar k+s−2; TA-Lib hides it until %D starts. A zero high-low range gives raw %K 50.|
|ADX, +DI, −DI|`adx`|ADX 14|TA-Lib ADX, PLUS_DI and MINUS_DI smoothing. DX is 0 when +DI and −DI are both 0.|
|Relative volume at time (RVOL)|`rvol_at_time`|RVOL at time 20|Volume so far in the session divided by the mean volume of the previous n sessions up to the same time of day. Undefined while fewer than n earlier sessions exist or when that mean is 0.|
|Rolling z-score|`zscore`|none|(x − mean) / sample standard deviation (ddof 1) of the trailing n values, the bar included. A flat window (all values equal) has no value. Same convention as gs-quant `zscores`. Strategy DSL: `zscore`.|
|Realized volatility|`realized_volatility`|none|Sample standard deviation (ddof 1) of the trailing n simple returns × √252 × 100 (annualized percent; the factor is a parameter). Same convention as gs-quant `volatility`. Strategy DSL: `realizedVol`.|

### Relative volume at time

RVOL at bar i = cum(i) / mean of cumAsOf(P, slot(i)) over the n sessions P just before the session of bar i (default n = 20).

- cum(i) is the volume of the session of bar i up to and including bar i.
- cumAsOf(P, s) is the volume of session P through its last bar with a time of day at or before s. It is 0 when P has no bar at or before s. After the close of a short session (half-day) the full-session total is used.
- The Python function takes explicit session keys and integer time-of-day slots. The chart study and the strategy DSL use the America/New_York calendar date as the session and the New York minute of day as the slot.
- With one bar per session (daily bars) RVOL is the volume divided by the mean volume of the previous n bars. The chart study and the DSL detect this case (every session has exactly one bar) and use one slot for all bars, so daily bars stored at a fixed UTC time are not shifted by daylight saving time.
- Missing volume: the chart counts a missing stored volume as 0. The DSL counts it as not available, so RVOL is not available for that session and for later sessions whose average includes it.

The functions differ from TA-Lib in two ways. Values on bars that both define are equal.

- Earlier first values: the MACD line and Stochastic %K start before the signal line and %D. TA-Lib starts all outputs of these functions on the same bar.
- Flat input: TA-Lib returns 0 for a flat RSI window and for a zero stochastic range, and it keeps the previous ADX when both DI values are 0.

The reference fixture was generated with TA-Lib C 0.8.1 through Python TA-Lib 0.8.2.

## Tests

- Hand-computed cases: `services/research/tests/test_indicators.py` and `apps/web/src/features/charts/indicator-math.test.ts` use the same small inputs and the same expected values.
- TA-Lib reference: `services/research/tests/fixtures/indicator-reference.json` holds 80 synthetic bars and TA-Lib output. Both test files compare every bar that TA-Lib defines.
- To regenerate the fixture, follow the steps in `services/research/tests/fixtures/make_indicator_reference.py`. TA-Lib is not a project dependency; use a throwaway virtual environment.
- Run the Python tests from `services/research` with `python -m pytest tests/test_indicators.py`. The CI lanes do not run the Python research suite, so RSI parity, the SMMA, VWAP and ATR(1) hand cases and the Python input guards are checked only by local runs. The web tests cover the same formulas except RSI and rolling VWAP.
- The Python Bollinger, rolling VWAP and Stochastic kernels use running windows (O(rows)). A brute-force test checks them on 600 random bars.
- Z-score and realized volatility: hand cases and a brute-force check in `services/research/tests/test_indicators.py`.
- gs-quant parity (`services/research/tests/test_gs_quant.py`, CI gs-quant run): SMA, z-score and realized volatility equal gs-quant 2.2.4 within 1e-9. gs-quant Bollinger Bands use the sample deviation, so they equal ours with k·√(n/(n−1)). gs-quant seeds SMMA, RSI and MACD at the first bar instead of with a full SMA; the values converge and agree within 1e-8 after 300 bars. gs-quant `macd(x, 12, 26, 9)` is our MACD `signal`. See [gs-quant](vertex-rebuild/gs-quant.md).
- RVOL: `services/research/tests/test_rvol_at_time.py` has hand cases (also used by the chart tests), a brute-force check on random sessions, an identity check on the golden SPY daily bars (RVOL 20 = volume / SMA 20 of volume on the previous bar) and an independent pandas reference that runs when pandas is installed.
- Real-data check: the [golden battery](golden-battery/README.md) runs the chart math, the Python library and the backtest engine's SMA and RSI over 10 years of SPY and QQQ daily bars and compares them with TA-Lib (pandas for SMMA) within 1e-9. The chart-math part runs in CI through `scripts/golden-battery/battery.test.ts`.
