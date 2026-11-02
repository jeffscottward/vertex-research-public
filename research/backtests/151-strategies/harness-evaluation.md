# Backtest harness evaluation for the 151-strategy plan

Date: 2026-10-16. Author: OMP agent on dev-rig (Claude Opus 5.5). Scope: planning only. Nothing here runs a real backtest, places an order or changes a live system.

The brief says: do not write our own backtester. Evaluate the NautilusTrader backtest engine first, because Vertex already uses NautilusTrader for order submission. Evaluate roboquant second. QuantPad is out of scope for now.

## Result

- **Primary harness: NautilusTrader.** It covers 161 of the 175 strategy entries: 128 with native instruments and 33 with proxies or modelled prices. The other 14 entries are not market backtests.
- **roboquant.dev is a secondary option for 15 CME-futures strategies only.** It has no options, stocks, spot FX or crypto spot. Strategy code also cannot read external data. Its main value is long history for individual CME futures expiries, plus built-in walk-forward and Monte Carlo tools.
- **The largest gap is data, not the engine.** About 64 entries need historical option quotes: all 58 options strategies in chapter 2, plus 3.5, 6.3, 6.3.1, 7.4, 7.4.1 and 7.5. We have no approved source for these quotes. The owner allows options only for new positions, so this gap blocks the most relevant part of the plan.

Per-strategy mapping: `strategies.json` (fields `harness_primary`, `nautilus_fit`, `roboquant_fit`, `wave`, `data_sources`, `gaps`, `universe_groups`) and the generated `index.md` and `strategies.csv`.

## NautilusTrader

### What was checked

The rig installed `nautilus_trader==1.227.0` in a separate task virtual environment. This is the same version that `vertex-quant/nautilus/requirements.txt` pins for the live container. The checks were:

1. Package introspection: instrument types, data types, fill/fee/margin models, catalog and adapters.
2. Source reading: option and futures expiry handling in `backtest/engine.pyx`.
3. A plumbing run: the bundled `EMACross` example on 1,000 synthetic daily bars for one equity. Result: 26 fills and 13 positions. A CASH account rejected the short orders, which is the expected behaviour. This test proves only that the engine, venue, fill and portfolio code run on the rig. The P&L has no meaning.

### Verified capabilities (1.227.0)

| Area | Verified in 1.227.0 | Relevance to the plan |
| --- | --- | --- |
| Instruments | `Equity`, `OptionContract`, `OptionSpread`, `FuturesContract`, `FuturesSpread`, `CurrencyPair`, `IndexInstrument`, `Cfd`, `Commodity`, `CryptoPerpetual`, `CryptoFuture`, `CryptoOption`, `BinaryOption`, `SyntheticInstrument` | Covers stocks, ETFs (as `Equity`), listed options and multi-leg spreads, futures and calendar spreads, FX spot, crypto |
| Market data | `Bar`, `QuoteTick`, `TradeTick`, `OrderBookDelta(s)`, `OrderBookDepth10`, `InstrumentClose`, `OptionGreeks`, `CustomData` | Daily bars for most strategies; quotes for 6.4 and 3.19; custom data for fundamentals, COT, factor returns and rates |
| Expiry | `check_instrument_expiration` exercises ITM options (cash or physical), lets OTM options expire, and closes futures at a settlement price or at market | Hold-to-expiry options strategies (chapter 2) do not need our own settlement code |
| Greeks | `nautilus_trader.model.greeks.GreeksCalculator`, `PortfolioGreeks` | Delta hedging (7.4.1) and option risk reports |
| Fills and costs | Fill models include `BestPriceFillModel`, `OneTickSlippageFillModel`, `VolumeSensitiveFillModel`, `SizeAwareFillModel`, `ProbabilisticFillModel`; fee models include `PerContractFeeModel`, `MakerTakerFeeModel`, `FixedFeeModel`; margin models; `LatencyModel` | Realistic option and futures costs |
| Batch runs | `ParquetDataCatalog`, `BacktestNode`, `BacktestRunConfig` | Config-driven runs over the universe |
| Data loaders | `DatabentoDataLoader`; Interactive Brokers historical client (needs `ibapi`, which `vertex-quant` already vendors as 10.30.1) | IBKR history first, as the data-source plan requires |

### Advantages

- One engine and one strategy code path from backtest to live. Vertex already runs NautilusTrader on the Quant VPS, so a strategy that passes testing does not need a port.
- It is the only candidate that handles listed options, futures, FX and crypto in one engine.
- Option expiry, greeks, multi-leg spreads and per-contract fees are built in.

### Limits and the work they need

These are components inside NautilusTrader. They do not replace the engine.

1. **Cross-sectional rebalancing.** NautilusTrader has no factor or portfolio-weight layer. Chapters 3 and 4 need a reusable rebalancer strategy: on a timer, it computes target weights from a signal and sends the orders for the difference. Long-short tests need a MARGIN account; a CASH account rejects shorts.
2. **Parameter search and validation.** There is no built-in optimizer or walk-forward split. The RoboQuant build plan (`roboquant-audit:docs/roboquant-audit/04-build-plan.md`, branch `roboquant-audit`) already recommends Optuna for parameter search. Results go to the existing `backtest_results` ledger.
3. **Instruments that do not exist in NautilusTrader.** There are no bond, swap, CDS, CDO, variance-swap, convertible or FX-forward types. The plan uses proxies: Treasury futures and bond ETFs for chapter 5, a rate-differential accrual for FX carry, and a `SyntheticInstrument` or custom-data model price for the rest. These entries are wave 3. Their results depend on the model, so they have lower priority.
4. **Data loaders for free public sources.** FRED (yields, T-bill rate, CPI), the Kenneth French data library (factor returns), CFTC Commitments of Traders, Cboe VIX and VX futures history and the FOMC calendar. Each loader writes into the Parquet catalog with release timestamps.

## roboquant

### Which roboquant

"roboquant" here means **roboquant.dev**, the hosted platform that the Vertex RoboQuant audit and build-out studied (`roboquant-audit:docs/roboquant-audit/`). The facts below come from that audit's public-documentation notes of 2026-09-30. They were not checked again today. An open-source Kotlin library with the same name exists (roboquant.org). It was not evaluated, and it would add a JVM stack.

### Fit

| Property (from the audit notes) | Effect on this plan |
| --- | --- |
| CME futures are the only market data (about 48 markets; bars and ticks since July 2010; individual expiries from 1-minute OHLCV; Databento is the CME data path) | Good for futures term-structure strategies. No options, stocks, ETFs, spot FX or crypto spot |
| Strategies are compiled `.rq` files (Rust-like SDK) with no filesystem or network access | Cannot use COT, fundamentals, rates or any other external signal |
| Single-symbol bar/tick strategies; multi-symbol `on_bars` in backtest only (bar mode) | Calendar spreads and multi-asset trend can be tested; live multi-symbol cannot run |
| Optimizer with IS/OOS, walk-forward and Monte Carlo (plan-tier dependent) | Useful validation that NautilusTrader does not include |
| Live routing to Tradovate only | Vertex executes through IBKR, so live use would need a port to NautilusTrader |

15 entries fit (`roboquant_fit = cme-futures`): 3.11 to 3.15 on index futures, 4.6, 5.13, 8.1, 9.1, 9.3, 9.4, 9.5, 10.2, 10.3 and 10.4. For each one, NautilusTrader is still the primary harness. roboquant.dev is useful as an independent cross-check, or as a source of long expiry history (9.1 and 10.2) if the data rights allow it.

## Data sources by strategy group

| Data | Source | Status | Strategies |
| --- | --- | --- | --- |
| Daily bars: stocks, ETFs, futures, FX | IBKR history (Rust `ibapi` adapter and Python provider) | Built; runtime pending (RoboQuant build plan) | Most wave 1 entries |
| US stock OHLCV, fundamentals, earnings | FinancialDatasets | User decision 2026-10-02; check point-in-time timestamps | 3.2, 3.3, 3.6, 15.3, 15.3.1 |
| Expired futures, longer than about 2 years | Databento CME (direct or through roboquant.dev) | Not approved; rights decision | 9.1, 10.2 |
| Yields, T-bill, CPI, house prices | FRED and US Treasury (public) | Loader to write | 4.5, 5.x, 6.5, 8.2 to 8.4, 19.x |
| Factor returns | Kenneth French data library (public) | Loader to write | 3.7, 4.2, 4.3 |
| Hedging pressure | CFTC COT (public, weekly) | Loader to write | 9.2 |
| VIX index and VX futures | Cboe (public settlement history) | Loader to write | 7.2, 7.3, 7.3.1 |
| **Historical option chains (bid/ask, IV), including expired contracts** | **None approved.** IBKR does not serve history for expired options. Candidates: Cboe DataShop, ORATS, Databento OPRA, ThetaData; check whether Quant Data has historical chains | **Owner decision needed** | All of chapter 2, 3.5, 6.3, 6.3.1, 7.4, 7.4.1, 7.5 |
| Intraday bid/ask quotes, order book | IBKR historical ticks (limited); a tick vendor | Gap | 3.19, 6.4, 8.5 |
| OTC prices (CDS, swaps, tranches, variance swaps, convertibles, inflation swaps) | None | Gap; use proxies or drop | 5.14, 5.15, 7.6, 11.x, 12.x, 14.1, 14.2 |
| M&A deals, tweets | None | Gap | 3.16, 18.3 |

## What is missing, in priority order

1. **Historical option-chain data.** This is an owner decision: vendor, cost and data rights. Without it, none of the 58 options strategies can be tested with real prices. A Black-Scholes model price from realized volatility is a possible fallback for a first look only. It ignores the volatility risk premium and skew, which several of these strategies trade.
2. **Point-in-time stock universe.** Cross-sectional stock tests need historical index membership to avoid survivorship bias. The 20 groups in `universe.json` are a fixed list from today, so the first tests will have that bias. Report it with every result.
3. **Rebalancer and validation components in NautilusTrader**: the cross-sectional rebalancer, an Optuna walk-forward runner, and writes to the `backtest_results` ledger.
4. **Public-data loaders**: FRED, Kenneth French, CFTC COT, Cboe VIX/VX and the FOMC calendar.
5. **Long futures expiry history**: decide between Databento CME and roboquant.dev data access. QuantPad stays out of scope.

## Proposed first wave

These entries are wave 1. They run on NautilusTrader with IBKR daily bars and free public data, and each one tests a different engine path:

| Strategy | Universe groups | Engine path tested |
| --- | --- | --- |
| 4.1, 4.1.1, 4.1.2 Sector momentum rotation | G02 | Cross-sectional rebalancer, monthly |
| 3.12 Two moving averages | G01, G20 | Single-instrument signal |
| 6.5 Index volatility targeting | G01 | Position sizing with a risk-free asset |
| 7.2 VIX futures basis, 7.3 VXX/VIXM carry | G19 | Futures expiry roll and ETN pair |
| 10.4 Futures trend following | G16, G17, G18 | Continuous-futures roll across asset classes |
| 8.2 FX carry | G17 | Custom data (rates) and carry accrual |
| 19.5 Trading on economic announcements | G01, G18 | Event calendar as custom data |

The owner's rule allows options only for new positions. Results for stock, ETF and futures signals are therefore signal research. Before a signal can be used, it must be tested again in its options form. That second test needs the option data from item 1.

## Not in scope

No trading, no order submission, no change to IBKR, the Quant VPS or any live service. No QuantPad work.
