# Concepts Brief: `thetrading.tools` Full Parity Plan for Vertex Research

- **Card:** `vertex-thetrading-tools-parity`
- **Date:** 2026-11-24 (revised after EGM Consolidated Review)
- **Stage:** EGM Brainstorm (`concepts_brief.md`)
- **Scope:** Research-only, options-only parity plan for recreating every tool, signal, indicator, screener, dashboard panel, and data feed of `https://www.thetrading.tools/` inside `vertex-research-public`. No live orders, no arming, no broker mutations, no copying of third-party assets or proprietary code.

## 1. Problem Framing

`thetrading.tools` exposes **366 live canonical pages** (verified 2026-11-24: **361** in `sitemap.xml` plus **5** live HTTP 200 `/tools`-only pages: `/stocks-at-52-week-lows`, `/volatility-outlook`, `/credit-stress`, `/etf-short-interest`, and `/gold-bottom-or-bounce`):

- **1** front-door Market Monitor & four-clock Decision Desk (`/`): separates **Tape** (today–5 sessions), **Swing** (1 week–3 months), **Cycle** (3–12 months), and **Valuation** (3–10 years) without averaging incompatible horizons.
- **145** additional analytical non-economic tools, signals, sector/options dashboards, interactive maps, dynamic `/chart`, and plain-English market-question pages (**146** total analytical tools across **12** domains).
- **154** economic indicator pages covering macro rates, inflation, labor, housing, credit, energy/grid, ad economy, global 10Y yields, and OECD/IMF series.
- **21** operational/editorial/trust pages (including `/status` freshness monitor and `/datasets` catalog) and **45** subpages (`17` indicator manuals, `8` concept explainers, `19` curated options-bet writeups, `1` CPI calendar deep dive).

Vertex Research (`vertex-research-public`) already possesses a strong, contract-first foundation—`88` non-test oRPC contract files (`55` explicit top-level `appContract` keys + generated spread), `34` Drizzle Postgres schema files (`0000`–`0094` migrations), `79` `page.tsx` routes (`62` portal + `2` lab), `23` `services/openbb` ingestion jobs (Cboe 14 vol indices, VX curve, option IV/GEX, CFTC COT for 10 futures, CME ES/NQ OI, Fed rates/regime/events, Treasury TGA + auctions, OECD CLI, keyless FRED CSV, FINRA OTC/short interest/Reg SHO, SEC 13F/FTD/Form 4, Fama-French, Congress PTRs, Shiller `EY_TNX_RATIO`), paid QuantData options flow/OI/term-structure/net-drift, read-only IBKR/Nautilus history and ES/NQ streamed tape, TradingView + WSJ NYSE breadth (`breadth-90`), 11-sector rotation (`sector-rotation`), leveraged ETF universe, and smart-money rankings.

However, Vertex's market-context capabilities are fragmented across `/markets`, `/flow`, `/sector-rotation`, `/smart-money`, `/stock/[symbol]`, and `/deep-value`, with key gaps in:

1. Multi-horizon market synthesis (the 4-clock Decision Desk, Day-1 survivorship-free Market State Atlas, and historical SPY trigger base-rate studies).
2. Breadth internals (McClellan, Zweig Breadth Thrust, Hindenburg Omen, Titanic Syndrome, New Highs/Lows, `% Above MAs`, BPI, Market Repair Flow, Hidden Bear Index, Dispersion/Churn).
3. Exchange-cleared OCC put/call volume, unified 14-ticker options dashboards, and structured macro/credit/global context.
4. Broad equity heatmaps/screeners and a browsable 154-series economic catalog.

## 2. Architectural Approaches Considered

| Option | Architecture | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| **A. Third-party widget / external JSON proxy** | Fetch `thetrading.tools` JSON/CSV payloads or embed external widgets | Fast prototype | Violates self-sovereign verification, no-JSON-data-file rule (`AGENTS.md` Rule 13), brittle third-party dependency, IP risk | **Rejected** |
| **B. Full paid data-vendor parity from Day 1** | Purchase Polygon/Massive Stocks + Options, Databento 25y CME 1m/5m, IQFeed TICK/ADD, ETF flow vendor, ICE MOVE (~`$450–$900/mo`) before building UI | Exact 5,610-stock & 25-year intraday match immediately | Blocks delivery on paid approvals; wastes money where free official APIs and existing QuantData/IBKR/TradingView feeds already cover 82.2% exact parity | **Rejected as default; kept as owner-gated upgrade playbook** |
| **C. Options-First Sovereign Engine (Postgres + oRPC + Free/Existing Feeds, Drizzle Tables as Upgrade Seam)** | Deliver **Core Options-First Parity (Waves 1–4, 12 vertical PRs, `$0/mo`)** before **Tier-2 Full Encyclopedia Expansion (Wave 5, 4 vertical PRs, owner-opt-in)**; use Drizzle Postgres tables stamped with `source_provider` and `universe_scope` as the sole decoupling seam (no speculative disabled paid adapters per `AGENTS.md` Rule 12); consolidate engines into 4 pure composable primitives and 2 new routes (`/monitor`, `/macro`) | 100% compliant with `AGENTS.md` (Postgres-only, oRPC-only, strict TS, 100% test coverage on new files, zero dead code, research-only); delivers **82.2% exact parity (`120/146`)** and **100% (`146/146`) with `$0` proxies** plus **`151/154` (`98.1%`) exact official economic series**; Day-1 20-year Market State Atlas via Dual-Mode `Tape-EOD` | Proxy universes and rolling intraday overlays must carry explicit `ProxyMetadata` badges (universe scope, source, history start date); Tier-2 encyclopedia items wait behind Core Waves 1–4 | **Selected** |

## 3. Core Design Invariants (Non-Negotiable)

1. **Options-only, research-only boundary:** Every table, oRPC procedure, composite clock, base-rate table, and portal page describes historical/current market state. Zero order submission, arming, sizing, or broker-mutation imports. UI copy uses descriptive regime language, never buy/sell directives.
2. **Postgres first, zero JSON data files (`AGENTS.md` Rules 6 & 13):** All series, indicator snapshots, breadth counts, ETF share counts, CDS spreads, Academy manuals, and base-rate outputs live in Drizzle-managed Postgres tables and are served strictly through oRPC.
3. **Dual-Mode Tape & survivorship-free replays:** Separate `Tape-EOD` (1995+/2007+ survivorship-free daily inputs powering Day-1 Market State Atlas and score-band base rates at `$0`) from `Tape-Live` (rolling intraday IBKR/TV overlay). Historical Swing/Cycle replays use strictly survivorship-free exchange-wide and ETF series; constituent-derived breadth replays only over forward-accumulated snapshots.
4. **Tier A vs Tier B freshness isolation:** Reuse existing `openbb_ingest_runs`, `price_freshness_state`, and `breadth90_status` from Wave 1. Official structured APIs (Tier A) gate composite freshness fail-closed; best-effort web CSV/WS scrapers (Tier B) degrade gracefully as non-gating overlays so a single broken marketing CSV never stalls `/monitor`.
5. **Minimal new surface area:** Consolidate ~20 indicator calculators into **4 composable pure primitives** and introduce only **2 new top-level portal routes (`/monitor`, `/macro`)** and **2 new oRPC contracts (`marketMonitor.*`, `macroCatalog.*`)**, extending existing Vertex pages (`/markets`, `/flow`, `/sector-rotation`, `/stock/[symbol]`, `/smart-money`, `/research/screen`, `/calendar`, `/connections`, `/academy`) for everything else.
6. **Zero third-party IP copying:** No HTML, CSS, copy, SVG, or proprietary strategy code from `thetrading.tools` is copied. All 17 Manuals and 8 Concepts are authored independently as database-backed TypeScript Academy courses (`scripts/academy/`).
