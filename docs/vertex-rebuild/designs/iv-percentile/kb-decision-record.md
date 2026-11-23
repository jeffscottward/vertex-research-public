# KB decision record — 1-year IV percentile and IV rank basis for index ETFs

- Card: `vertex-iv-percentile` (consult gap 8, split from `vertex-consult-gaps-1119` on 2026-11-19)
- Date: 2026-11-22
- Scope: research volatility context only (`openbb.volContext`, MCP `openbb_vol_context`, `/markets` Core 7 IV table). Touches no order, execution, arming, risk gate, or capital allocation path.

## Neutral method question

> A daily research pipeline stores 30-day constant-maturity ATM implied volatility (`openbb_option_iv_daily.atm_iv_30d`) for the Core 7 ETFs (`SPY`, `QQQ`, `IWM`, `DIA`, `GLD`, `SLV`, `USO`), currently holding 9 sessions per underlying, while `market_daily_series` holds multi-year daily close histories of the corresponding Cboe 30-day volatility indices (`VIX` for `SPY`, `VXN` for `QQQ`, `RVX` for `IWM`, `VXD` for `DIA`, plus `GVZ` for `GLD`, `VXSLV` for `SLV`, `OVX` for `USO`). For research-only 1-year (252-session) IV percentile and IV rank reporting (not order authorization):
>
> 1. Is a volatility-index proxy (`VXN` for `QQQ`, `VIX` for `SPY`, `RVX` for `IWM`, `VXD` for `DIA`, and the matching Cboe vol indices for the other Core 7 ETFs) acceptable until own ATM IV history reaches 252 sessions, provided the basis and index name are labelled explicitly and never mixed with own ATM IV?
> 2. Is there a free, license-clean source in the current stack to backfill 252 sessions of own ETF ATM IV history, or should Vertex accumulate own history forward?

## Consultation pathway (standing trading-research rule, owner Discord message (private), 2026-11-14)

1. **`kb-chat` agents at `127.0.0.1:8787` (options, quant, macro)**: Not reachable from this isolated cloud build sandbox (loopback `kb-chat` runs only on the research host). No paid or unapproved external fallback was called.
2. **Trading master rules (`packages/api/src/server/master-rules-sources.generated.ts`, generated from the trading knowledge-base `_master-rules`)**: Read directly in full for IV rank, IV percentile, sample-size reliability, volatility-index gauges, and multi-source cross-checks.

### Cited master-rule evidence

| Rule ID | Verbatim statement | Bearing on the decision |
| --- | --- | --- |
| `inthemoneyadam:entry:3` | "Buy options when IV rank or percentile is below about 50 and sell options when it is above 50." | Both IV rank and IV percentile are core regime gauges for option-structure selection; reporting both (0–100) against a real 1-year window is required so consults can classify IV as high or low. |
| `trading-verrillo-aleks:regime:25` | "Before the session, run the volatility checklist (VIX level, gamma nodes, SPX gamma surface sign, IV rank, IV surface) and set the day's playbook from it." | Confirms IV rank alongside Cboe volatility indices belongs in the pre-session volatility context read. |
| `trading-verrillo-aleks:regime:12` | "Use IV rank to set the day's style: high IV rank (with negative gamma) favors continuation trades; low IV rank favors small base hits without runners." | Reinforces reporting IV rank explicitly alongside IV percentile rather than percentile alone. |
| `bridgingcycles-instagram:entry:1` | "Sell premium only when implied volatility exceeds recent realized volatility (e.g., 30-day IV vs 21-day HV); rank the gap and sell at extreme percentiles." | Highlights that extreme-percentile readings must come from a real multi-regime distribution, never from a 9-session or 20-session window. |
| `trading-verrillo-aleks:wisdom:12` | "Backtest one setup over at least 100 historical data points before trading it live." | Directly rejects small-sample statistical claims; 9 sessions (or the previous 20-session minimum) cannot establish a 1-year percentile. |
| `quantfinancetogo:wisdom:4` | "Distrust the best of many rules tried on the same history; data-mined patterns found even in noise do not repeat on new data." | Argues against ad hoc rescaling, splicing, or tuning across two different volatility definitions; keep formulas standard and keep each basis strictly separate. |
| `jay-medrow:indicator:14` | "Watch sector rotation and ratios such as XSD/SMH, SMH/QQQ, IWM/QQQ and VXN/VIX rather than the index to spot internal rotation before the index breaks." | Confirms Cboe's `VXN` and `VIX` are standard research gauges for Nasdaq-100 / S&P 500 implied volatility regimes. |
| `jay-medrow:indicator:1` | "Read the VIX level as the implied one-year percentage range of the S&P 500, up or down." | Confirms Cboe 30-day volatility index levels express annualized implied volatility in vol points (distinct from decimal `atm_iv_30d`), so the API must keep units and series separate. |
| `damien-wursten:risk:26` | "Cross-check fundamental data across multiple sources; production figures are often delayed or revised and can mislead short-term forecasts." | Supports returning both `own` and `proxy` evaluations side by side (each with its own session count, as-of date, and reason) so researchers can cross-check once own history reaches 252 sessions. |

## Decisions

1. **Require a full 252-session window (`minSessions = 252`, `windowSessions = 252`) for any 1-year IV percentile or IV rank.**
   - Raise `OPENBB_IV_PERCENTILE_MIN_SESSIONS` from `20` to `252`.
   - Below 252 valid sessions, that basis returns `ivPercentile: null`, `ivRank: null`, and an explicit human-readable `reason` naming the required count and stored count (never a percentile from 9 or 20 sessions).
   - Sources: `trading-verrillo-aleks:wisdom:12`, `bridgingcycles-instagram:entry:1`, `quantfinancetogo:wisdom:4`.
2. **Accept the Cboe volatility-index proxy (`VIX` for `SPY`, `VXN` for `QQQ`, `RVX` for `IWM`, `VXD` for `DIA`, plus `GVZ`/`VXSLV`/`OVX` for `GLD`/`SLV`/`USO`) as the labelled 1-year fallback until own ATM IV reaches 252 sessions.**
   - This reuses the exact ETF-to-volatility-index mapping already codified in `STRATEGY_IV_INDEX` (`packages/api/src/strategy-dsl.ts`) and stored in `market_daily_series`.
   - Never compare an ETF's `atm_iv_30d` against a volatility index's closes (never splice or mix series). Compute `own` strictly over `openbb_option_iv_daily.atm_iv_30d` (decimal) and `proxy` strictly over `market_daily_series.close` (vol points).
   - Always label the selected `basis` (`"own_atm_iv"` vs `"vol_index_proxy"` vs `null`), `proxyIndex`, `unit`, `windowSessions`, `sessions`, `asOf`, and expose both `own` and `proxy` sub-objects for transparency and cross-checking.
   - Caveat documented for readers: Cboe volatility indices (`VIX`, `VXN`, `RVX`, `VXD`) are model-free 30-day variance-strip indices on cash indices (`SPX`, `NDX`, `RUT`, `DJX`), not single-strike ETF ATM IV; wing skew and index-vs-ETF differences can shift levels slightly. Once `own` reaches 252 valid sessions, selection automatically switches to `own_atm_iv` while keeping `proxy` visible for cross-check.
   - Sources: `inthemoneyadam:entry:3`, `trading-verrillo-aleks:regime:25`, `trading-verrillo-aleks:regime:12`, `jay-medrow:indicator:14`, `damien-wursten:risk:26`.
3. **Do not backfill own ATM IV history; accumulate forward.**
   - Free chain sources in the current stack (Cboe delayed quotes, Yahoo `yfinance`) serve only current-day option chains, not historical daily chain snapshots.
   - IBKR `OPTION_IMPLIED_VOLATILITY` historical bars are a vendor-computed model series (not Cboe/Yahoo chain ATM IV), would introduce an unmeasured vendor seam, and would add unnecessary IBKR gateway load; expired option chains are not available via IBKR after expiry.
   - Paid historical option-chain vendors (Cboe DataShop, ORATS, OptionMetrics, ThetaData, Databento) introduce recurring cost (an owner decision) and belong to historical chain storage (`vertex-option-chain-store`), which is explicitly out of scope here.
   - Accumulating `openbb_option_iv_daily` daily via `cboe-option-iv` gives an honest, seam-free own series over time while the labelled Cboe vol-index proxy answers 1-year high/low questions immediately today.
4. **No trading authorization.** Research input only; nothing here arms trading, changes risk caps, or places orders.

## Pathway to proving the change

- **Gate checks verified at design/build time**:
  - Hand-computed 252-session fixture tests prove exact `ivPercentile` and `ivRank` math.
  - Below-minimum-session tests prove any basis with `< 252` valid sessions (including 9 and 251 sessions) returns `null` with an explicit `reason`.
  - Basis-selection tests prove automatic switch from `vol_index_proxy` to `own_atm_iv` at 252 sessions and `basis: null` with combined reason when neither qualifies.
  - 100% line, branch, function, and statement coverage on all new/changed source files; `bun run verify:prepush` and GitHub PR CI green.
- **Evidence pending outside this cloud sandbox**:
  - Live QuantVPS web deploy (outside 08:30–16:00 ET via `infra/quantvps/restart-when-idle.sh`) and live agent-read-key verification of `openbb.volContext` returning 1-year IV percentile and rank for `QQQ`, `SPY`, `IWM`, and `DIA`.
  - Optional post-merge confirmation with live `kb-chat` agents on the research host if desired (the neutral question above is ready to replay verbatim).
