# Day-trader-skill coverage in Vertex

Updated: 2026-11-01. Card `vertex-daytrader-gaps`. Research and paper use only. Nothing in this work places, routes or simulates broker orders.

## Purpose

The owner asked for the 11 workflows of [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) (MIT, Jake Schincariol, read at commit `3d0f4ef`) as coded Vertex workflows, not as prompt skills. This page records, for each workflow, the Vertex code that already does the job, or the gap. Each row was checked by reading the function body, not by counting search hits.

Owner rules that limit the scope:

- Options only. Vertex does not propose or size share positions. The upstream share-sizing and share bracket-order steps are therefore not ported.
- Premium caps per name: 2% of net liquidation value (NLV) for options under 365 days, 6% for LEAPS. They live in the order rules (`evaluateOrder`) and the risk allocator.
- Day trading is of interest only as quantitative research: every built workflow reads data, computes or replays. None trades.

## Coverage table

Status values: COVERED (Vertex has an equal or stronger path), PARTIAL (a part exists; the gap is named), BUILT (missing before this card; built here), NOT PORTED (missing, and the owner rules exclude it).

|#|Workflow (upstream skill)|Status|Vertex code path (file → function)|Notes|
|---|---|---|---|---|
|1|Chart scanner (`trader-scanner`)|PARTIAL|`services/research/strategies/swing.py` → `momentum()`; `packages/api/src/strategy-dsl.ts` → `rvol` indicator; `packages/api/src/server/research-lenses.ts` → `fetchDeepValue()`, `fetchRotationMatrix()`|`momentum()` computes relative volume, gap-and-hold, 20/50-bar breakouts and ATR for one instrument. The research lenses rank a whole universe, but by value and sector, not by intraday setups. There is no universe-wide intraday gap or opening-range scan. Not built here: it needs an intraday bar source for thousands of symbols.|
|2|News monitor (`trader-news`)|BUILT|`packages/api/src/market-news.ts`, `packages/api/src/server/market-news.ts` → `marketNews.watchlist`; page `/news`|Before this card: no headline or 8-K feed existed (`services/research/adapters/handlers.py` marks QuantData news unavailable). Now: headlines merged from IBKR news (vertex-history `/news`), Reuters (Google News RSS), Seeking Alpha RSS and Yahoo Finance (one copy per story, priority ibkr > reuters > seekingalpha > yahoo, each labelled with its source; owner 2026-11-10 merge direction, card vertex-yahoo-terms-decision) and SEC 8-K filings for each ticker on the operator's watchlist, with tags and 8-K item labels.|
|3|Earnings analyst (`trader-analyst`)|PARTIAL|`packages/api/src/deep-value-facts.ts` → `factsFromCompanyFacts()`; `packages/api/src/server/research-lenses.ts` → `gatherDeepValueFacts()`, `scoreDeepValueSymbol()`; page `/deep-value`|Live SEC EDGAR XBRL companyfacts: revenue and prior-year revenue (growth), cash, equity, debt, operating cash flow, shares. Gap: EPS, net income and margins are not extracted. Not built here (owner priority list did not include it).|
|4|Congress trades (`trader-pelosi`)|BUILT|`packages/api/src/congress-trades.ts`, `packages/api/src/server/congress-trades.ts` → `congressTrades.feed`; page `/congress-trades`|Before this card: nothing read the House Clerk. Now: the House Periodic Transaction Report (PTR) filing feed. Limit: PTR PDFs are encrypted and use CID fonts, so transaction rows are read in the linked PDF; the feed lists member, district, filing date and the PDF.|
|5|Entry timer (`trader-entry`)|COVERED|`services/research/strategies/swing.py` → `SessionWindow`, `session_breakout()`; worker operation `swing-session-breakout` (`services/research/adapters/sleeve_research.py`)|Opening-range breakout on contiguous 1- or 5-minute bars: range high and low from the opening bars, trigger on a close above the range high with enough relative volume. Long only. It runs as a research worker operation; it has no portal page.|
|6|Exit planner (`trader-exit`)|PARTIAL|`services/research/strategies/swing.py` → `protection_levels()`; `packages/api/src/instant-backtest-engine.ts` → `runSignalBacktest()` (`stopLoss`/`takeProfit` of kind `atr` or `pct`)|ATR stop and R-multiple target exist in research and in the backtest engine. Gap: no trailing stop. The setup replay (row 9) uses the ATR stop and R target.|
|7|Budget manager (`trader-budget`)|NOT PORTED|`packages/api/src/instant-backtest-engine.ts` → `spendFor()` inside `runSignalBacktest()`; `packages/api/src/risk-allocator.ts` → `suggestAllocation()`|Risk-percent ÷ stop-distance sizing exists inside backtests. Live advisory sizing (`suggestAllocation`) uses the NLV premium caps. The upstream tool sizes share positions from a maximum loss; the options-only rule excludes share sizing.|
|8|Risk manager (`trader-risk`)|PARTIAL|`packages/api/src/server/vertex-orders-rules.ts` → `evaluateOrder()`, `openPremium()`|Pre-trade checks: options only, limit orders only, calls only, valid expiry, kill switch, `OPTIONS_ONLY` gate, NLV known, per-name premium caps, no naked short, no duplicate resting order. Gap: no daily-loss or open-trade-count check. Deployment requests store `dailyLossLimit` and `maxPosition` as approval data only.|
|9|Time machine (`trader-timemachine`)|BUILT|`packages/api/src/setup-replay.ts`, `packages/api/src/server/setup-replay.ts` → `setupReplay.run`; page `/setup-replay`|Before this card: `packages/api/src/backtest-analytics.ts` → `monteCarlo()` ran only on stored backtest results, and `services/research/backtesting/event_study.py` → `event_study()` needs NumPy/SciPy that are not installed. Now: a setup preset runs through `runSignalBacktest()` on a stored daily series; every past occurrence is listed with its outcome (target, stop, time), and a seeded Monte Carlo resamples those outcomes.|
|10|Price alerts (`trader-alerts`)|BUILT|`packages/api/src/price-alerts.ts`, `packages/api/src/server/price-alerts.ts` → `priceAlerts.*`; page `/price-alerts`; scheduler `scripts/price-alerts/tick.ts`|Before this card: the notifications package could deliver fixed-text alerts, but no rule store or evaluator existed, and watchlist buy zones were never checked. Now: price, stop and target rules per watchlist symbol, checked against Yahoo quotes, delivered through the notifications package ntfy adapter with fixed text.|
|11|Order executor (`trader-broker`)|COVERED (options)|`packages/api/src/server/vertex-orders.ts` → `vertexOrdersRouter` (`preview`, `submit`); `packages/api/src/server/vertex-orders-confirm.ts` → `issueConfirmToken()`, `consumeConfirmToken()`; `packages/api/src/server/vertex-orders-gateway.ts` → `createMockOrderGateway()`|Human approval ticket: owner-only preview, signed confirm token, submit, audit, mock gateway unless two environment gates are on. One limit option leg only. Upstream share bracket tickets are NOT PORTED (options-only rule). This card adds no order path.|

## What was built

All four pages are portal pages with selects only; no page asks for a typed ID. All data reads are bounded HTTPS GETs (time limit, size cap, no redirects) and are parsed with Zod before use.

### Congress trades (`/congress-trades`, operator only)

- Procedure `congressTrades.feed` `{ days: 7 | 30 | 90 }` → filings (member, state/district, filing date, document ID, PDF link) and the member list for the filter.
- Data: the House Clerk index `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<YEAR>FD.zip`. A small ZIP reader (`DecompressionStream("deflate-raw")`) and a strict `<Member>` tokenizer read it; only filing type `P` (Periodic Transaction Report) is kept. The previous year is read too when the window crosses 1 January. Cache: 15 minutes.
- Limit: the PTR PDFs are encrypted and use CID fonts, so the Worker runtime cannot read their transaction rows. The page links each PDF and states that a disclosure can arrive up to 45 days after the trade.
- Parts: `packages/api/src/contracts/congress-trades.ts`, `packages/api/src/congress-trades.ts`, `packages/api/src/server/congress-trades.ts`, `apps/web/src/components/portal/congress-trades-workspace.tsx`. Tests: `packages/api/src/congress-trades.test.ts`, `packages/api/src/congress-trades-feed.test.ts` (upstream `2026FD.zip` fixture).

### News monitor (`/news`, operator only)

- Access: operators only (`VERTEX_OPERATOR_EMAILS`), because sign-up is public, each request reads IBKR, Reuters, Seeking Alpha, Yahoo and SEC for up to 25 tickers, and the SEC requests carry the operator's contact address. Agent API keys and MCP tools cannot call it. Procedure `marketNews.watchlist` `{ hours: 24 | 72 | 168 | 720 }` → for each of the first 25 watchlist symbols: merged headlines (IBKR, Reuters, Seeking Alpha, Yahoo) with tags (earnings, guidance, deal, analyst, legal, offering, executive) and SEC 8-K filings with item labels and an "important" flag (items 1.03, 1.05, 2.02, 2.04, 2.06, 3.01, 4.02, 5.01, 5.02).
- Data: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=<TICKER>` and the EDGAR 8-K Atom feed per CIK (ticker → CIK from the SEC ticker list that the deep-value score already uses). Four tickers at a time; a failing source is reported on its ticker and does not fail the page. Cache: 5 minutes per source.
- Parts: `packages/api/src/contracts/market-news.ts`, `packages/api/src/market-news.ts`, `packages/api/src/server/market-news.ts`, `apps/web/src/components/portal/market-news-workspace.tsx`. Tests: `packages/api/src/market-news.test.ts`, `packages/api/src/market-news-server.test.ts` (upstream Yahoo and SEC fixtures).

### Setup replay (`/setup-replay`, operator only)

- Procedures `setupReplay.presets` and `setupReplay.run` `{ seriesId, setup, stop: ATR multiple, targetR, maxHoldBars, paths }`.
- Presets (data table, long only): gap up and hold; 20-day breakout; RSI(2) below 10 above the 200-day average; close back above a rising 50-day average.
- Engine: each preset compiles to the strategy DSL and runs through `runSignalBacktest()` on a stored daily series (`instantBacktest.series`). Each trade becomes one occurrence with outcome target, stop or time exit, its return and its R multiple. `runSignalBacktest()` gained an optional `maxHoldBars`, and `monteCarlo()` an optional path count; existing callers keep the old behavior.
- Monte Carlo: bootstrap of the occurrence R multiples with a seed derived from the series and the settings, so a rerun returns the same numbers. It reports P(profit) and percentiles of total R and total return.
- Limit: daily bars only. The upstream tool replays 5-minute bars of one session; Vertex stores daily series. The page states that the result is a simulation over past bars, not a prediction. No costs are applied.
- Parts: `packages/api/src/contracts/setup-replay.ts`, `packages/api/src/setup-replay.ts`, `packages/api/src/server/setup-replay.ts`, `apps/web/src/components/portal/setup-replay-workspace.tsx`. Tests: `packages/api/src/setup-replay.test.ts`, `packages/api/src/server/setup-replay.test.ts`.

### Price alerts (`/price-alerts`, operator only)

- Procedures `priceAlerts.list`, `create`, `remove`, `check` (the caller's rules now) and `tick` (scheduler, write API key, up to 200 active rules).
- Rule: watchlist symbol (picked from a select), `above` or `below`, role `price`, `stop` or `target`, level, note. State is a typed union stored in table `price_alert_rules` (migration `0040_price_alert_rules`): `active`, or `triggered` with time, price and delivery result. A rule triggers once; remove and re-create it to arm it again.
- Evaluation: Yahoo 5-minute bars since the last check plus the last price, so a touch between checks counts.
- Delivery: the notifications package ntfy adapter, configured by `VERTEX_PRICE_ALERTS_NTFY_ORIGIN`, `VERTEX_PRICE_ALERTS_NTFY_TOPIC` and optional `VERTEX_PRICE_ALERTS_NTFY_TOKEN`. The message text is fixed (no symbol, no price), as the package requires for third-party channels; the page shows the details. When the settings are absent the rule still triggers and the delivery shows `not-configured`.
- Scheduler: `bun run vertex:alerts:tick` (`scripts/price-alerts/tick.ts`), units in `infra/price-alerts/` (not installed). Operator guide: [price-alerts.md](price-alerts.md).
- Parts: `packages/api/src/contracts/price-alerts.ts`, `packages/api/src/price-alerts.ts`, `packages/api/src/server/price-alerts.ts`, `packages/db/src/server/price-alerts.ts`, `apps/web/src/components/portal/price-alerts-workspace.tsx`.

### No order path

None of the new modules imports the order, gateway, broker or execution modules. Nothing in this card creates, previews or submits an order. The existing options ticket (`vertexOrdersRouter`) is unchanged.

## Source and license

Fixtures copied from day-trader-skill keep the MIT notice in a `NOTICE.md` next to them. Logic was adapted to TypeScript, not copied.
