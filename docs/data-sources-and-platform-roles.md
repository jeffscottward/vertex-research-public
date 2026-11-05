# Data sources and platform roles

**As of 2026-09-23 (Gamma Forge wording updated 2026-11-03).** This is a dashboard map, not an activation checklist or proof of subscriptions. **IBKR is the primary venue and first-choice source for data it can actually supply under verified permissions.** Other providers fill demonstrated gaps. The trading-domain code that came from Gamma Forge, the earlier version of Vertex, is native Vertex code (ADR-V02 amendment).

## The distinction at a glance

- **IBKR — broker and market-data source:** where authorized orders ultimately go and where broker observations originate; also the first place to obtain available quotes and history.
- **Quant Data — market-data and analytics provider:** primarily live market/options-flow decision support in Vertex; it also advertises historical data.
- **QuantPad AI — research/backtesting platform and historical-data candidate:** useful for developing and testing ideas, but external-use rights and account API entitlement remain unresolved. The intended product is [quantpad.ai](https://quantpad.ai/), not similarly named products.
- **NautilusTrader — event-driven backtest/execution engine:** consumes data and produces simulation or execution events; **not a dataset vendor**.
- **FinancialDatasets.ai — financial-data API:** fundamentals, filings and related company research, with documented stock-price uses as well. It is not limited to fundamentals.

**QuantPad and Quant Data are complementary candidates, not interchangeable names.** Historical strategy research does not replace current-session flow analytics, and neither replaces reconciled broker state.

## Provider/platform map

Dashboard areas below describe intended uses, not a claim that every panel is implemented or connected. **Source present** means adapter/boundary code exists; it does not mean enabled, entitled, captured, qualified or deployed.

| Source/platform | Category and data/outputs | Intended dashboard area and primary purpose | Overlap / fallback priority | Present integration / rights status |
| --- | --- | --- | --- | --- |
| **IBKR** | Brokerage; live/delayed quotes as entitled; supported historical bars and bid/ask ticks; contract metadata; account, cash, position, order and fill observations | **Portfolio / execution review:** reconcile actual holdings and orders. **Markets / Quant Lab:** primary available prices/history | First choice for supported, permitted data. A research vendor cannot override broker observations or invent buying power | Historical adapter and offline/native-build evidence exist; **no real IBKR capture or current account/feed qualification established here**. Session, exchange subscriptions, API acknowledgment and permitted uses remain separate prerequisites. [1][L1] |
| **Quant Data** | Live and historical market data; options flow, dark-pool prints, gamma analytics and alerts advertised publicly. Local source also models equity bars, option analytics and related request shapes | **Markets / Today / options research:** current market context, unusual activity and decision support | Complement IBKR where flow/analytics are required. Historical/price overlap is possible; compare exact fields, semantics, coverage and rights, not brand labels | Gamma-derived request/shape adapter exists. Current API access, subscription, exchange entitlements and Vertex retention/use rights are unverified. Provider-reported analytics are **not fabricated executable quotes**. [2][L2] |
| **QuantPad AI** | AI research workspace, strategy-building/backtesting tools; documented historical universe, coverage, symbology, bars and ticks API | **Quant Lab / strategy research:** candidate historical inputs and externally developed research artifacts | Optional historical gap-filler after IBKR. Its documented exclusion of the in-progress session does not establish live Quant Data equivalence | Local integration is a **supplied-artifact, rights-gated boundary, not a QuantPad API client**. Public API/export marketing does not resolve license restrictions. Written external-use/retention/model/derived-output permission and actual endpoint/plan entitlement are unresolved. [3][L3] |
| **NautilusTrader** | Event-driven engine; historical replay, modeled fills, performance outputs and execution-adapter events | **Quant Lab:** run reproducible simulations. **Execution infrastructure:** engine component behind separately authorized native services | Uses IBKR/vendor data; does not supply an independent market history or account truth. Reuse its IBKR historical integration rather than assume a second collector is needed | Source, offline tests and native compilation/identity evidence are not broker/runtime qualification. Current v3 historical results remain limited-retrospective/inconclusive; no promotion or execution authority. [4][L4] |
| **FinancialDatasets.ai** | Financial statements, metrics, SEC filings/items, earnings, insider/institutional information; documented historical stock OHLCV and other research data | **Company dossiers / screening / research chat:** financial and filing evidence. **Quant Lab / charts:** eligible price inputs for supported research | Candidate for fundamental/filing gaps and documented price-history fallback—not an automatic replacement for IBKR quotes or Quant Data flow | Gamma-derived request/shape adapter exists; account access and permitted storage/redistribution/model use are unverified. Current historical-price docs describe **daily/weekly/monthly/yearly EOD data**; local acceptance of second/minute interval arguments is not proof the vendor supports them. [5][L5] |

## Other planned data and evidence categories

| Category | Source / outputs | Dashboard purpose | Priority, overlap and current limitations |
| --- | --- | --- | --- |
| **Historical bars and quotes** | IBKR first; rights-cleared vendor snapshots only for gaps. Preserve original captures and separate interpretation manifests | Quant Lab replay, chart history and cost/slippage studies | Bars are not quote ticks, market depth or trade-side flow. IBKR `TRADES` is split-adjusted, not dividend-adjusted; `ADJUSTED_LAST` adjusts both. Freeze the selected convention. IBKR does not provide a universal expired-options archive. [1][L4] |
| **Calendars, contracts and corporate actions** | Qualified instrument identity, dated exchange sessions, timezone/DST/early closes, splits/dividends and applicable expiry/exercise/assignment/settlement facts | Session cutoffs, event warnings, correct replay and portfolio accounting | Use available IBKR metadata first; fill demonstrated gaps with qualified references. A timezone label is not a dated calendar; adjusted prices are not a complete corporate-action cash ledger. A complete calendar/action source is **not yet established**. [L1][L4][L6] |
| **Fundamentals, filings, earnings and news** | FinancialDatasets and other explicitly rights-cleared primary-source material; publication/as-of timestamps and source citations | Company dossiers, event context, screening and cited research chat | Preserve when information became knowable. Today's revised data cannot stand in for historical point-in-time facts. Earnings coverage does not prove complete exchange calendars or corporate-action coverage. [5][L6] |
| **Macro/regime context** | Planned macro observations and source vintages | Macro research, regime hypotheses and scheduled-event context | Source links/vintages remain unresolved in the plan. Do not invent a connected feed or use revised series as historical knowledge. [L6] |
| **Papers and strategy research** | SSRN/other lawfully acquired papers, strategy specifications from the research package, hypotheses, experiment and review artifacts | Quant Lab: paper → hypothesis → explicit strategy → reproducible study | The research package supplies the domain baseline, not fresh market data. Paper claims and model summaries are research inputs, not validated strategies or permission to trade. Retrieval/full-text rights and reproducibility remain evidence-specific. [L6] |
| **Trader corpora** | Separately attributed trader collections, transcripts, summaries and citations; earlier DeltaTrend, Verrillo/Aleks, Crown and DefineYourRisk requirements plus the user-referenced 12-specialist role table | Research library / Agno group chat: compare cited reasoning and hypotheses across macro, risk/process, order flow, auction/liquidity and systematic research roles | **Incomplete research knowledge only.** User reports roughly **10% of transcripts** ingested in another session; this is not independently measured. The role table has been recovered as planning input, not verified corpus readiness or the real traders' current opinions. Rights, provenance and completeness are not established; coordinate with existing ingestion rather than duplicate it. Never treat this as live data or a ready/licensed corpus. [L6] |
| **Portfolio and execution records** | Broker observations reconciled by the single native execution owner; durable submissions, fills, reservations and receipts; asynchronous dashboard projections | Portfolio, order review, risk/readiness and audit trail | Reconciled broker state governs actual positions and execution outcomes. Dashboard copies may lag; unknown/stale is not zero. Research notional, simulated fills and research P&L never enter actual NAV or create buying power. Operational qualification remains separate. [L6] |

## Architecture flow

```text
IBKR first + approved gap-fill vendors
    → rights / coverage / instrument / freshness checks
    → immutable captures + lineage + explicit data semantics
        ├─ historical inputs → Nautilus simulation → Quant Lab evidence
        └─ current observations/analytics → Markets / Today / research context

Papers + incomplete trader corpora + research-package strategy knowledge
    → provenance-scoped retrieval → cited hypotheses / drafts / research review

IBKR broker observations → single execution owner + reconciliation
    → timestamped, read-only portfolio/execution projections → dashboard
```

These are separate evidence paths. Research outputs do **not** grant trading permission. Any future paper/live command path requires its own exact-version human authorization and deterministic execution/risk admission; it is not an arrow from chat or a backtest to the broker.

## Options analytics on /charts (QuantData)

The `/charts` page shows an options panel for stock symbols (`secType` STK). The panel calls `optionsAnalytics.snapshot` (operator-only, read-only). The server-side client in `packages/api/src/server/quantdata-client.ts` calls three QuantData endpoints: `term-structure`, `open-interest-by-strike` and `order-flow/consolidated`. It starts at most one request per second and at most 30 requests in any 60 s window. These limits hold per server instance (the one `vite preview` process on QuantVPS); do not add the key to other deployments. It stops for the `Retry-After` time after HTTP 429 (60 s when absent). It caches chain and open-interest data for 5 minutes per symbol, and flow for 1 minute per symbol and flow window. QuantData allows 240 requests per 60 s per user, shared by every key on the account. When a response reports fewer than 120 requests left (`X-RateLimit-Remaining`), the client waits until `X-RateLimit-Reset` (1-60 s; 60 s when absent), so other users of the account keep headroom. A low count counts only when it fell since the previous response (or on HTTP 429): on 2026-11-03 QuantData sent a constant `remaining 19, reset 55` on every response, and that constant must not stop every call. The key comes from `QUANTDATA_API_KEY` (optional `QUANTDATA_API_BASE_URL`, https only). On QuantVPS the key is the same key that the market-watch-bot GEX, wheel and re-entry jobs use (owner decision 2026-11-02); a key rotation must update both `.env` files and vertex-web's `.prod.vars`. Without a key the procedure returns `NOT_CONFIGURED`. `MARKET_DATA_RUNTIME_STATE` has no enabled value yet, so it cannot gate this panel; the `market_data` entry in `capabilities.yaml` stays `disabled` because the governed ingestion capability (captures, lineage) is still off. This panel is a read-only display only. The Python adapter [L2] stays the research capture path (immutable captures, lineage); it is not deployed or reachable from the Worker, so this read-only display client does not replace it. Both use the same QuantData account limits; run only one high-volume path at a time.

The calculations in `packages/api/src/server/options-analytics-engine.ts` implement the volatility, exposure and flow views first written in Gamma Forge (the earlier version of Vertex): ATM IV term structure, IV at fixed deltas (skew), an out-of-the-money IV surface by moneyness, aggregate open interest, max pain and option flow with hourly premium buckets. GEX is an estimate: aggregate open interest multiplied by Black-Scholes gamma from the front-expiry IV, in dollars per 1 % move, with dealers assumed long calls and short puts. The panel shows these limits under "Data limits". The panel does not place, change or cancel orders.

## JEV verdict on /charts (display only)

The `/charts` page shows a JEV verdict panel for US stock symbols (`secType` STK, currency USD). Loading the panel calls `jevVerdict.get`, which reads the cached verdict and never calls JEV. The **Ask JEV** button calls `jevVerdict.refresh` (both operator-only). A refresh loads one year of daily bars from the history service, derives public price fields (last close, changes, moving averages, 52-week range, volume ratio and the last 21 closes) and sends only those fields to the TypeSafe JEV decisions model on OpenRouter (`OPENROUTER_API_KEY`, model `~typesafe/jev-latest`). The allow-list in `packages/api/src/server/jev-verdict-engine.ts` copies only listed fields, so account ids, positions, NLV, balances and order data never reach JEV; a unit test asserts the exact field set.

JEV returns BULLISH, NEUTRAL or BEARISH with probabilities and three supporting questions. The panel shows BULLISH or BEARISH only when JEV gives that choice with at least 0.6 probability; otherwise it shows NEUTRAL. The server allows one JEV call per symbol every 30 minutes and at most 12 calls per rolling hour in total, to limit OpenRouter spend. The verdict, reason, model and time are cached per symbol in the web server process (a restart clears the cache); a verdict older than 60 minutes is marked stale. The verdict is display only: it does not place, change or cancel orders. The final JEV order gate (merge plan P6) is a separate service.

## FinancialDatasets research CLI (fundamentals and daily history)

`services/research/providers/financialdatasets_cli.py` is a read-only research entry point. It uses the FinancialDatasets adapter [L5]. It gives company facts, financial metrics, financial statements and daily price history for one ticker. These data sit next to IBKR; they do not replace IBKR. The CLI has no order, broker or account path. Run it from `services/research`:

```bash
python -m providers.financialdatasets_cli company-facts --ticker AAPL
python -m providers.financialdatasets_cli financial-metrics --ticker AAPL --out ../../private/fd/aapl-metrics.json
python -m providers.financialdatasets_cli financial-statements --ticker AAPL --period annual --limit 4
python -m providers.financialdatasets_cli prices --ticker AAPL --days 7   # or --start-date/--end-date
```

- **Key:** the CLI reads the key only from `FINANCIAL_DATASETS_API_KEY`, or else from `FINANCIALDATASETS_API_KEY`. The key goes only in the `X-API-KEY` header. The CLI never prints or writes it, and it blocks any output that contains the key. Without a key, the CLI stops before it makes a request. `FINANCIAL_DATASETS_API_BASE_URL` can replace the default `https://api.financialdatasets.ai`. It must be a bare HTTPS origin.
- **Output:** JSON with `source`, `endpoint`, `ticker`, `http_status`, `fetched_at`, `age_seconds`, `raw_sha256`, `rights`, `limitations`, `record_count` and the normalized `payload`. Numbers are exact decimal strings. Without `--out`, the JSON goes to stdout. With `--out`, the file must be inside the git-ignored `private/` folder at the repository root (`../../private/` from `services/research`). Other folders named `private` are refused. The file has mode 0600. Stdout then gets only a summary. The CLI stores nothing else.
- **Calls:** one run makes at most one request. The CLI never retries, follows redirects or follows pages. After HTTP 429 it exits with code 3 and reports `retry_after_seconds`; wait before the next run. HTTP 401/403 shows as `provider-access-denied`. HTTP 402 and other errors show as `provider-unavailable`. A response that needs another page shows as `unsupported-pagination`, so data are never cut short without notice. Statements accept `--limit` 1-10, which is one documented page.
- **Limits:** the only rights mode is `research-only`. Vendor storage, redistribution and model-use rights are **unverified**. Prices are **end-of-day daily bars only**. They are not quotes, intraday or real-time data, and they are not point-in-time history. Account entitlement and history depth are unverified until a live run shows them. Tests use a fake transport only (`providers/tests/test_financialdatasets_cli.py`).

## Current limitations and decision rules

1. **Historical simulation, live decision support and reconciled account state must stay separate.** Show source, as-of/received time, environment and stale/unknown/coverage status beside relevant values. Do not silently blend providers or substitute a simulation for a broker record.
2. **A successful response is not complete backtest evidence.** Captures need immutable lineage, supported symbol/contract coverage, dated calendars, price/volume units, adjustment semantics, survivorship treatment and point-in-time availability. Quotes, fees, slippage and corporate-action economics require explicit evidence or visibly bounded assumptions.
3. **Current v3 historical outputs are deliberately limited.** The source class is `limited-retrospective-adjusted-bar-simulation-nonpromotion`; accepted outputs remain `inconclusive`, with point-in-time enforcement and data completeness false. An explicit dated interpretation calendar does not retroactively make the raw provider capture complete or point-in-time. `promotionEligible` and `executionAuthorized` remain false. [L4]
4. **Provider marketing is not account entitlement.** Resolve QuantPad's written-use conflict; verify each vendor's exact endpoints, instruments, lookback, quotas, delay, exchange rights, retention, derived-output/model use and cost. Public FinancialDatasets coverage descriptions are not this account's history allowance. Quant Data replacement requires the existing comparison gates and separate retirement approval. [3][5][L6]
5. **Nothing here activates integrations.** Actual broker/data/account/session calls, model/runtime activation, grants, migrations and deployment remain paused. Source adapters, synthetic tests and compiler receipts demonstrate bounded engineering progress—not enabled production operation, complete research evidence or permission to trade.

## Evidence and references

Public documentation was reviewed alongside existing project evaluations; no account login or provider data call was performed for this document. Rolling vendor docs are capability descriptions, not exact-version runtime qualification.

- **[1] IBKR:** [historical bars](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-bars/requesting-historical-bars), [TRADES adjustment](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-bar-what-to-show/trades), [ADJUSTED_LAST](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-bar-what-to-show/adjusted-last), [bid/ask tick fields](https://www.interactivebrokers.com/docs/tws-api/ref/historical-tick-bid-ask), [history limitations](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-historical/historical-data-limitations/unavailable-historical-data), [market-data requirements](https://www.interactivebrokers.com/docs/general/market-data-subscriptions/market-data-requirements).
- **[2] Quant Data:** [official product and capabilities](https://quantdata.us/).
- **[3] QuantPad AI:** [product and historical-only positioning](https://quantpad.ai/), [External Data API](https://api.quantpad.ai/external/openapi.json), [published license restrictions](https://quantpad.ai/license). Technical API availability does not settle the license conflict.
- **[4] NautilusTrader:** [engine documentation](https://nautilustrader.io/docs/latest/), [IBKR integration and historical data](https://nautilustrader.io/docs/latest/integrations/interactive_brokers/#historical-data).
- **[5] FinancialDatasets.ai:** [introduction](https://docs.financialdatasets.ai/introduction), [documented dataset/API index](https://docs.financialdatasets.ai/llms.txt), [historical price contract](https://docs.financialdatasets.ai/api/prices/historical.md).
- **[L1]** [IBKR historical source boundary](../services/research/providers/ibkr_history.py).
- **[L2]** [Quant Data adapter](../services/research/providers/quantdata.py).
- **[L3]** [QuantPad supplied-input boundary](../services/research/providers/quantpad.py).
- **[L4]** [Historical simulation semantics and result restrictions](../services/research/backtesting/historical.py).
- **[L5]** [FinancialDatasets adapter](../services/research/providers/financialdatasets.py).
- **[L6]** [Implementation plan](vertex-rebuild/implementation-plan.md), [architecture decisions](vertex-rebuild/architecture-decisions.md), [repository architecture](../ARCHITECTURE.md). These establish intended roles and safety boundaries; older plan status is not a substitute for later scoped evidence.

[L1]: ../services/research/providers/ibkr_history.py
[L2]: ../services/research/providers/quantdata.py
[L3]: ../services/research/providers/quantpad.py
[L4]: ../services/research/backtesting/historical.py
[L5]: ../services/research/providers/financialdatasets.py
[L6]: vertex-rebuild/implementation-plan.md
