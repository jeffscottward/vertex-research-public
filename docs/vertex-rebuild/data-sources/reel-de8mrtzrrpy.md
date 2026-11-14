# Source review: reel De8MRTzRrPy (Screener.in, Yahoo Finance, Zerodha Varsity)

Updated: 2026-11-09. Card `vertex-sources-chase-enloe`. Status: **reviewed; no new integration**.

An Instagram reel (`instagram.com/reel/De8MRTzRrPy`) named three research sites. The reel itself sits behind the Instagram login wall and was not read again; the site list comes from the card. Part 2 of the reel was not out on 2026-11-09. This page records what each site offers, what its terms say and what Vertex does with it. Vendor names stay in documentation only.

## Verdict

| Site | What it is | Fit for Vertex (US book) | Decision |
| --- | --- | --- | --- |
| Screener.in | Fundamentals screener for Indian listed companies (NSE/BSE) | Low. No US coverage; no API; terms allow personal viewing only | Do not integrate. Revisit only if the book adds Indian equities. |
| Yahoo Finance | Quotes, daily/intraday bars, options chains, news headlines | Already in use (call sites listed below) | Nothing new to add. The existing use carries a terms-of-service risk; see [Yahoo Finance](#yahoo-finance). |
| Zerodha Varsity | Free trading and investing course (text, video) from an Indian broker | Learning content, not a data feed | Link from research notes when useful. Do not copy its text into the repository, the knowledge base or Academy lessons. |

## Screener.in

Read on 2026-11-09:

- Coverage: company pages carry NSE and BSE codes. `RELIANCE` shows annual results Mar 2015 to Mar 2026 plus TTM, and a Concalls list with transcript, AI summary and slides links per quarter. `https://www.screener.in/company/AAPL/` returns HTTP 404: no US companies.
- API: the support article ["Exporting Screen results in Screener"](https://support.screener.in/article/28-export-screen-results) says "Though we don't provide APIs on Screener, you can use the "Export" option to download the results in a CSV". Export is "available only in the premium".
- Terms (`https://www.screener.in/guides/terms/`, "Last updated Aug 01, 2018"): "Permission is granted to use the materials (information or software) on Site for personal, non-commercial transitory viewing only", and the licensee may not "modify or copy the materials" or "use the materials for any commercial purpose".
- `robots.txt` allows company pages and disallows query, sort, paging and `/company/source/quarter/*` URLs.

Conclusion: India-only coverage makes it irrelevant to the current US universe, and the license grant covers personal, non-commercial viewing only. The fundamentals and filings gap for US names is already assigned to FinancialDatasets ([data sources](../../data-sources-and-platform-roles.md)).

What would change this: the owner adds Indian equities to the book. Then the route is the owner's premium CSV export, imported by hand, never a scraper.

## Yahoo Finance

Vertex already reads Yahoo Finance through public, undocumented endpoints (JSON chart and options data from `query1`/`query2.finance.yahoo.com` with a session cookie from `fc.yahoo.com`; the XML headline RSS feed) and, in offline research fetchers, through the `yfinance` Python package. There is no official Yahoo Finance API and no account in use.

### Files that name a Yahoo endpoint or client

Snapshot of `origin/vertex/rebuild-darkfactory-20260921` at `033a7608` (2026-11-09). Other branches can differ. Rebuild the list with:

```sh
git grep --no-color -lE 'finance\.yahoo\.com|fc\.yahoo\.com|yahoo-finance2|^[[:space:]]*(import|from)[[:space:]]+([[:alnum:]_.]+[[:space:]]*,[[:space:]]*)*(yfinance|yahooquery)([^[:alnum:]_]|$)' \
  -- '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.ipynb' '*.sh' \
  ':!*.test.*' ':!*.spec.*' ':!*/test_*.py' ':!*_test.py' ':!*/conftest.py'
```

A row is a file that names a Yahoo endpoint host or imports a Yahoo client package (`yfinance`, `yahooquery`, `yahoo-finance2`); the HTTP request may run in a sibling module (named in the Use column). The list covers direct use only. Yahoo data also arrives indirectly through the market-context panel, which shows public data from the ibkr-monitor service (Cboe, Yahoo; `apps/web/src/components/portal/market-context-workspace.tsx`), and through the Vibe-Trading agent framework, whose tools default to free sources including Yahoo (`packages/api/src/agent-frameworks.ts`).

| File | Use |
| --- | --- |
| `packages/api/src/price-alerts.ts` | Price alerts: builds the 1-day 5-minute chart URL; `packages/api/src/server/price-alerts.ts` fetches it |
| `packages/api/src/signal-alerts.ts` | Signal alerts: builds the chart URL per timeframe; `packages/api/src/server/signal-alerts.ts` fetches it |
| `packages/api/src/server/market-news.ts` | Market news: per-symbol headline RSS feed |
| `packages/api/src/server/options-chain-yahoo.ts` | `/stock/<SYMBOL>` options chain (cookie + crumb, then the options endpoint) |
| `packages/api/src/server/pick-lists.ts` | Pick-list screen: daily bars per member |
| `packages/api/src/server/research-lenses.ts` | Research lenses: 1-year daily bars |
| `packages/api/src/server/sector-rotation.ts` | Sector rotation: daily bars for sector ETFs |
| `services/research/quantlab/data.py` | Quant Lab: frozen daily-bar snapshots, pinned by SHA-256 under the git-ignored `private/` tree |
| `scripts/sector-rotation-backtest/freeze.ts` | Sector-rotation backtest: frozen input bars |
| `research/backtests/calendar-spread/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/carousel/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/core7/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/freestockalerts/fetch_yahoo.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/qc-ports/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/quantjourney/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `research/backtests/sma30-timing/fetch_data.py` | Offline backtest fetcher (`yfinance`) |
| `services/research/tests/golden/fetch_yahoo.py` | Golden backtest battery: rebuilds the frozen daily-bar fixture (chart endpoint) |

### Terms of use

Read on 2026-11-09 from `https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html` ("Last updated: 1 November 2026"):

| Clause | Text (quoted) |
| --- | --- |
| Automated access | "access or collect data, or attempt to access or collect data, from our Services using any automated means, devices, programs, algorithms or methodologies, including but not limited to robots, spiders, scrapers, data mining tools, or data gathering or extraction tools, for any purpose without our express, prior permission" |
| Derived databases | "use any material or content from, including without limitation any data, (a) to create any database, archive, mobile application, data feed, widget or any other aggregated data source that competes with or constitutes a material substitute for the Services" |

Vertex has no agreement with Yahoo. How these clauses apply to the reads above is an owner decision.

Stored copies: the repository tracks Yahoo-derived daily bars as frozen test and backtest inputs: `tests/fixtures/golden/SPY-1d.csv` and `tests/fixtures/golden/QQQ-1d.csv` (from the golden fetcher) and `research/backtests/sector-rotation/closes.json` (from `freeze.ts`). The app database holds a copy too: `scripts/market-series/import.ts` (`bun run vertex:series:import`) loads the `qc-ports` fetcher output, Yahoo files included, into the `market_daily_series` table. Unit tests also use small Yahoo response samples (`packages/api/src/fixtures/day-trader-skill/trader-news/yahoo-*.xml`, `trader-alerts/yahoo-*.json`, `packages/api/src/server/options-chain-yahoo.fixture.json`). The other research fetchers write outside the repository (`~/Documents/reports/...`), and Quant Lab snapshots go to the git-ignored `private/` tree.

The `yfinance` README says the package "is **not** affiliated, endorsed, or vetted by Yahoo, Inc." and "the Yahoo! finance API is intended for personal use only".

Operational risk: there is no published contract. The endpoints can change, rate-limit or require a new cookie/crumb at any time without notice. This review changes no call site and no stored copy. Whether to keep the live paths (the `packages/api` server reads: price and signal alerts, market news, options chain, pick-list screen, research lenses, sector rotation; and Quant Lab snapshots) the tracked copies and the `market_daily_series` rows, or move them to IBKR history, a licensed vendor or synthetic fixtures, was an owner decision for a separate card.

Owner decision (2026-11-10; options chain 2026-11-13): merge, do not replace. Every Yahoo fetcher stays. The live paths read IBKR first and Yahoo for the gaps; the options chain reads Quant Data first (IV, delta, open interest, flow, spot), then IBKR live bid/ask, then Yahoo; the committed backtests computed on Yahoo data stay and are rerun on demand only. The order per data type is in [Data sources and platform roles](../../data-sources-and-platform-roles.md#source-order-per-data-type-merged-sources). The file list above stays the 2026-11-09 snapshot.

## Zerodha Varsity

Read on 2026-11-09 from `https://zerodha.com/varsity/modules/`:

- Modules include Technical Analysis, Fundamental Analysis, Futures Trading, Options Theory for Professional Trading, Option Strategies, Risk Management and Trading Psychology, Trading Systems and Integrated Financial Modelling. Examples, taxes and contract specifications follow Indian markets (NSE, INR, SEBI rules).
- Footer: "© 2015 – 2026. All rights reserved. Reproduction of the Varsity materials, text and images, is not permitted."
- `zerodha.com/robots.txt` allows `/varsity/` except comment pages.

Conclusion: useful background reading for the options-theory and risk-management concepts Vertex already models, but it is a course, not data. Cite it by link; do not ingest, copy or summarise it at length into the repository, the Academy or a model knowledge base.

## Part 2 of the reel

Not published on 2026-11-09. When it appears, review any new site with the same table: coverage of US names, official API or export, terms on automated access and storage, and overlap with the sources in [data sources](../../data-sources-and-platform-roles.md).
