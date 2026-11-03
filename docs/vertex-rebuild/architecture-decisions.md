# Vertex architecture decisions and domain vocabulary

**Date:** 2026-09-21. These decisions define intended architecture; they do not certify implementation, legal rights, installed dependencies, operational access or live permission. See the [plan](implementation-plan.md), [ledger](deliverables.json), [source baseline](provenance-baseline.json) and [verification DAG](verification-dag.json).

## ADR-V01 — Specialize the current DarkFactory, preserve the engineering constitution

**Decision:** build the isolated Vertex root from DarkFactory `c7f3c36f69fff40444a556ef2b478328744f55ea` using Civet/Vinext/Vite, official Cloudflare adapter, oRPC, Better Auth, Drizzle and PostgreSQL. Keep inherited tiny composable feature boundaries, public exports, provider isolation, test/contract-first work, exact four-way 100% coverage, five CI lanes, trusted security bootstrap, review, generated artifacts and exact-SHA deployment rules. AGENTS and CLAUDE remain byte-identical.

**Trade-off:** the old report asked for real Next.js and a Civet-versus-TypeScript spike; current user instructions explicitly choose the current foundation. Restoring Next.js or copying old UI/BFF would add unnecessary migration and weaken that decision. Domain-neutral foundation rules still apply to generic packages; explicit Vertex feature verticals may own the requested trading domain. Domain specialization is not a waiver of security, coverage or accessibility.

**Consequence/gate:** WP1 now proves the existing toolchain with a real fixture slice, loading/error/RSC/server-only and browser boundaries. It does not decide a new authoring language. Parent gates G-baseline/G-contracts/G-ui; original DarkFactory remains unchanged. Old checkpoint/graph receipts are historical, not evidence for this branch.

## ADR-V02 — Gamma domain authority, selective improvements, no whole-app merge

**Decision:** preserve Gamma Python domain/research modules as the authoritative trading source, while replacing its top-level frontend/legacy BFF and unsafe execution/state authority. Other applications are characterized improvement sources, not alternative product stacks. Exact source root, revision, file/hash, license, observed behavior and intentional changes accompany every extracted unit.

**Trade-off:** Gamma contains valuable SourceRef/hash, provider ABC, feature/setup/options/portfolio research, provenance/replay and readiness logic, but does not implement every requested strategy. Empty engines, supplied-outcome replay, dry-run Nautilus fills, missing wheel/rotation lifecycles, model-accessible external mutation tools and broker-send-before-insert cannot be rebranded complete. Trail execution/recovery/kill invariants can improve the single edge without making the trail app another authority.

**Consequence/gate:** characterize before changing semantics; migrate affected consumers, not only files. Never deep-import another package's internals. Preserve original Gamma canonical digest separately from new representation hashes; preserve base/trail lineage and old accepted records. G-characterization/G-migration/F01–F14.

**Amendment 2026-11-03 (owner decision, supersedes the "Gamma" framing above):** Gamma Forge was the owner's earlier version of Vertex Research, not a maintained or community upstream like TradingAgents or Nautilus Trader. Its code in `services/research` is first-party Vertex code: the features, setups, options, portfolio and replay modules are native Vertex building blocks. Vertex no longer tracks Gamma Forge as foreign code: the Gamma Forge port records (`source-files.json`, `released-source.json`, `port.json`) and the release-freeze byte pins of the research package (`native-files.json`) are removed; git history keeps them. The Python import package `gamma`, the distribution `vertex-gamma-research`, the recipe profile IDs `vertex-gamma-research-v1` and `vertex-gamma-recipe-v1`, the `gammaProvenance` contract field and the `GAMMA_RESEARCH_API_URL`/`GAMMA_RESEARCH_API_TOKEN` environment variables keep their names for stability. Agno with vLLM stays a separate optional third-party upstream (capability `agno-vllm`). The other parts of this ADR stay valid: no whole-app merge, no reuse of the old frontend or legacy BFF, and characterize before changing semantics.

## ADR-V03 — Native domain services are a narrow required exception

**Decision:** separately deploy Python Gamma/Agno domain/research/data and engine-adapter services and a Rust latency-sensitive kernel; include their necessary local tests/packaging. All first-party web/control source, schema ownership and control authorization remain Civet. Services communicate through named public contracts and generated runtime-validated interoperability artifacts.

**Alternatives rejected:** forcing numerical/native SDK code into Civet; trying to deploy native PyO3 wheels as ordinary Cloudflare Python Workers; using a language exception to create a second REST/BFF or general Go/TypeScript implementation. Existing Go safety helper source is evidence, not an approved new runtime.

**Consequence/gate:** independent reproducible native manifests/ABI/toolchain pins and generated valid/rejected fixtures must join the verification DAG and coverage inventory before activation. Shared control tables/migrations remain Drizzle-owned. Native research indexes and execution journal/cache adapters require explicit ownership; they cannot bypass control authorization or independently alter shared tables. Missing native gates remain blocked, never exempt.

## ADR-V04 — One colocated execution/risk owner, asynchronous cloud control

**Decision:** Cloudflare hosts web/control. One fenced Quant VPS owner colocated with Gateway owns execution risk, cash/share reservations, submission durability, mutation, replay/reconciliation and kill switch. Cloudflare/model/PlanetScale calls, disk I/O, ingestion and backtests stay off synchronous market callbacks.

**Trade-off:** making cloud SQL the tick-loop coordinator adds remote latency and outage dependence. Merely caching a cloud balance permits stale double-spending. Therefore local crash-safe journal/checkpoint and atomic command/reservation admission are an explicit latency/offline-safety exception, with asynchronous durable acknowledgments before broker send. This is one execution authority, not competing local/cloud ledgers.

**Protocol:** account/environment-qualified key plus payload hash; fenced owner epoch; append reservation/transition/outbound record atomically; acknowledge durability; submit; dedup broker events; unknown acceptance locks retry; reconcile before reopening risk; publish ordered facts asynchronously. PlanetScale projections include sequence/high-water mark and freshness. Only the edge spends/releases execution cash. Bounded versioned control grants cannot silently create buying power; stale grants/state or broken continuity inhibits affected new risk.

**Consequences:** fail-safe overload/backpressure and disconnected behavior are contractual. Distinguish callback latency, durable command-admission latency, quote age and broker latency. No arbitrary universal performance threshold; choose measured strategy-specific budgets before promotion. Local journal implementation, corruption/restore guarantees and benchmark are pending. G-edge/G-latency/F01–F10/F13/G-rollback.

## ADR-V05 — PostgreSQL control/research truth, scoped artifact storage

**Decision:** PlanetScale **PostgreSQL** is the SQL target, retaining Drizzle and request-scoped client lifecycle through the appropriate PostgreSQL/Hyperdrive adapter. SQL owns identity/permissions/configuration, corpus/claim/run metadata, accepted review versions, control jobs/outbox and explicit nonauthoritative execution projections. Immutable rights-scoped large datasets/transcripts/reports belong in content-addressed object storage, with owner/digest/version/retention/lineage in SQL.

**Trade-off:** PlanetScale also offers Vitess/MySQL and preview Neki; the brand does not select a dialect. `@planetscale/database` is the MySQL/Vitess HTTP driver, not PostgreSQL. No preview Neki or default Redis/RabbitMQ is needed to satisfy this boundary. Agno contents metadata, embeddings and search are different responsibilities; pgvector availability is not proof the actual schema/filters/indexes/pool/dimensions work.

**Freshness:** Hyperdrive query caching may serve stale matching reads after writes. Disable caching for authentication, permission, approval, configuration and risk-sensitive/read-after-write controls; pooling is independent of caching. Execution facts in cloud remain projections even when fresh.

**Consequence/gate:** prove exact engine/region/extension rights, migration/count/reference parity, transaction/outbox recovery, backup/restore, request cleanup/admission and Agno compatibility. Existing JSON/SQLite source records stay immutable migration inputs. G-storage/G-auth/G-knowledge.

## ADR-V06 — Pin Nautilus by release line, not “latest”

**Observed evidence:** [1.231.0 release](https://github.com/nautechsystems/nautilus_trader/releases/tag/v1.231.0) is the non-prerelease distribution (upstream Beta/legacy-Cython line); [2.0.0rc5](https://github.com/nautechsystems/nautilus_trader/releases/tag/v2.0.0rc5) is prerelease Rust/PyO3. [Versioned migration](https://github.com/nautechsystems/nautilus_trader/blob/v2.0.0rc5/MIGRATION_V2.md) documents API and behavior gaps. Mutable latest docs are not the 1.x package contract.

**Decision:** evaluate rc5 in isolated research/paper with explicit prerelease acceptance, while preserving a separately pinned 1.231.0 comparison/rollback baseline if selected. Both import as `nautilus_trader`; never mix environments. Pin package/wheel hashes, source tag, Python interpreter/ABI, Rust toolchain/Cargo lock, target platform, broker configs/client identities and Gateway image digest. The rc5 tag requires Python `>=3.12,<3.15` and pins Rust `1.98.1`; verify actual wheel/host ABI rather than infer it from rolling docs.

**Critical compatibility work:** in-tree rc5 IBKR Rust/Python integration exists; “IBKR is Python-only” is stale. However, v1 out-of-tree Python data/execution factories lack an equivalent v2 registration surface. Gateway container lifecycle is separate from client construction. PostgreSQL cache does not restore actor/strategy state/cache heartbeat or synthetics. Older `OrderReleased`/`OrderFillVoided` rows lack new restoration fields. Do not delete authoritative history to satisfy upgrade advice.

**Consequence/gate:** characterize constructors/callbacks/serialization/adapters and ordered events, fill/cash/position/P&L behavior; validate copied-data migrations including corrected/voided fills; restart/reconcile, broker pacing, intended option/multi-leg behavior, latency and rollback. A total-return match alone fails. G-nautilus/G-edge/G-rollback; no live promotion from release metadata.

## ADR-V07 — Independent financial renderer, exact Alpha pin

**Observed evidence:** [TanStack Charts 0.18.0 stability policy](https://github.com/TanStack/charts/blob/v0.18.0/docs/stability.md) explicitly calls the project Alpha even though npm uses ordinary `0.x` latest releases. Minor releases may break APIs; the public packages move as a fixed group. The user confirmed Charan's intended renderer is **KLineCharts 9.8.12**; its actual source/API/license/runtime acceptance still needs characterization.

**Decision:** normalize quote/candle/trade-flow/volume-profile/indicator/annotation inputs separately from rendering. Exact-pin 0.18.0 for evaluated TanStack renderer integration; retain a replaceable port and evaluate the known KLineCharts renderer for advanced finance. Query/Table/Virtual, optional client collections and authoritative PostgreSQL are separate layers. Do not assume or substitute Lightweight Charts because another app uses it. No speculative React Three Fiber/3D.

**Consequence/gate:** browser-only rendering, ordered sequence/snapshot/reconnect/gap/backpressure contracts, as-of/rights/stale/empty status, session/units and bounded performance. Volume-profile/orderflow must originate in actual appropriate licensed data; candles do not prove trade-side flow. Compare renderer coverage/performance/accessibility before replacement; upgrades require fixture proof. G-charts/G-data.

## ADR-V08 — Collection-scoped evidence and reproducible research, not personas as policy

**Decision:** required DeltaTrend, Verrillo/Aleks, Crown and DefineYourRisk corpora remain independently attributed, rights-aware and versioned. Import atomic collection generations; preserve duplicate source mappings and missing-source records; never call the old global KB replacement. Raw transcript, editorial summary, embedding, market fact, hypothesis and approved strategy are different types of evidence.

**Trade-off:** flattening creators into a persona prompt loses attribution, rights and retrieval isolation and can turn educational prose into spurious trade authority. Remembered creator identities and DefineYourRisk canonical location are unresolved. A copied transcript location is not corroboration. Personal/nontrading collections remain out of default trading retrieval.

**Consequence/gate:** provenance locators/quality/rights, bounded retrieval, cross-collection transaction rollback, prompt injection denial and permitted model disclosures. SSRN workflows preregister and freeze data/spec/engine/cost/holdout before results; failure and inconclusive replication remain visible. Sandbox code cannot access broker credentials or arbitrary instruction-derived shell. G-knowledge/G-agent/G-research/G-backtest.

## ADR-V09 — Human authority, local safety and recovery are different things

**Decision:** research approval, paper authority, live authority, Gateway recovery, pause, cancel, liquidation and kill reset are separate scopes. No model can grant any trading permission. Material draft edit invalidates review. Broker source observations govern execution reconciliation; UI labels do not.

**Recovery:** the human explicitly triggers authenticated, account/environment-bound, fresh and expiring recovery. MFA/unlock/provider safety approval is human-only. Provider-console fingerprint is pending; neither the rig nor verified Mac default known-hosts file trusts this VPS. Verify trusted console fingerprint before any authorized SSH metadata check; do not bootstrap trust or bypass host checks. A connected SSH/socket is not logged-in or reconciled trading readiness, and successful login does not rearm trading.

**JEV:** actual watcher identity is uncertain. Gamma `live_options` model-unavailable messaging does not prove JEV browser integration. JEV never observes financial-services pages, account data or secrets; use authorized native/direct read-only inspection where appropriate. No UI or model instruction expands authority.

**Consequence/gate:** independent durable local kill survives cloud/model/UI loss; reset needs explicit authority and reconciled state. The historical breakout worksheet remains private, unconfirmed and without quantities; it cannot seed an intent. G-gateway/F11–F13/G-live-approval.

## ADR-V10 — Rights and legal establishment precede claims, not software progress

**Decision:** Fincept is no-copy pending exact-revision license clarification; use capability concepts only. Conflicting root commercial restrictions and a newer withdrawal document cannot be resolved by guesswork or the presence of an AGPL label. Preserve transitive notices and IBAPI restrictions. A service boundary is not an automatic copyleft exemption; Enterprise purchase cannot be assumed to license public-source embedding.

QuantPad's historical API/export marketing does not grant contractual external-use/retention/model/derived-output/post-cancel rights. Require written clarification and all six comparison gates before claiming replacement of QuantData; its lack of current-session data prevents required live equivalence. No billing/cancellation action follows automatically.

Vertex Research software/brand does not establish a legal investment fund, regulated status, custody permission or return expectation. Any such business/legal activity needs its own qualified assessment and explicit scope. No benchmark, paper result or “confidence” label proves future profit.

**Consequence/gate:** G-rights/G-fincept-rights/V01–V06/G-legal. Source/license/identity unknowns are blockers, not passes or categorical legal opinions.

## ADR-V11 — Complete scope, evidence-based sequencing, independent approvals

**Decision:** deliver the entire requested platform scope while sequencing independently testable verticals. A first equity paper strategy may precede wheel/options readiness without deleting later scope. Preserve every WP0–WP8 obligation and all 14 failure/eight 0DTE gates. Model progress through planned/blocked/implemented-unverified/verified receipts, never top-picks-only or MVP relabeling.

**Promotion:** source exists → characterized/rights-cleared → implemented contracts/callers → deterministic fixture proof → reproducible OOS/walk-forward/cost evidence → authorized forward-paper → separately authorized bounded live. Deployment also needs exact artifact/environment approval and observed full CI at its exact SHA. Original retirement independently requires source/history/data/deployment/dependency parity, rollback and explicit permission.

**Consequence/gate:** all work remains research/read-only unless a verified narrowly scoped later receipt says otherwise. Never rewrite old evidence, reset/clean original repos, restart legacy writers against unresolved state, or cancel subscriptions to make consolidation appear complete. Parent owns gates/checkpoint/final verification; sibling no-gate scheduling is not a waiver.

## Canonical vocabulary

| Term | Meaning |
| --- | --- |
| Application row / root | Report inventory units; base/trail and containers do not imply independent production runtimes |
| Sleeve | Attributed investment policy/obligation within one portfolio, never a second copy of cash |
| Quant Lab | Noncapital research workspace; simulated notional cannot enter actual NAV |
| Strategy spec | Versioned deterministic entry/exit/risk/data/cost rules, not an editable chat prompt |
| Research evidence | Attributed assertion with source/locator/time/method/quality/rights/limitations; not automatically market fact |
| Dataset vintage / as-of | Specific release/revision and information-availability cutoff, distinct from capture time |
| Replay | Re-execution of specified inputs/events; not necessarily a market-economic simulator |
| Backtest | Versioned simulation with declared data/execution/cost assumptions and leakage controls; not proof of profit |
| Paper forward sample | Timestamped prospective non-live-capital observations under declared policy and source lineage; not retrofitted backtest outcomes |
| Trade intent | Typed proposal; the foundational draft is explicitly non-executable |
| Approval | Exact actor/account/environment/version/scope/expiry authorization; research approval is not order permission |
| Reservation | Locally authoritative cash/share obligation held by the one edge, including unresolved acceptance exposure |
| Execution receipt | Broker-observation/reconciliation state; `unknown` is neither failed nor permission to retry |
| Execution projection | Asynchronous timestamped/sequence-marked read model; cannot authorize or independently spend cash |
| Kill switch | Durable independent safety control with distinct pause/cancel/liquidate/reset authority |
| Recovery | Explicit-human restoration of connectivity/authentication plus reconciliation; never automatic live rearm |
| Hot swap | Compatibility, shadow, drain, pin obligations, atomic activation and reversible rollback; not in-place ownership change |
| Fund | A legal/business arrangement requiring separate review; not a synonym for repository or software brand |
