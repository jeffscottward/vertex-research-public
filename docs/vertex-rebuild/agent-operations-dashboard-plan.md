# Agent-operated dashboard plan

Date: 2026-09-29. Scope: the authenticated portal. Operating model: AI agents do research, paper-to-strategy work, backtests, forward tests and deployments; the operator directs them through chat and reviews results.

## 1. Audit of the current portal (2026-09-29, local build)

Evidence: `private/basic-app/ui-audit-20260929.json` (signed in as the local test account).

| Page | Tables | Default content | Verdict |
| --- | --- | --- | --- |
| /dashboard | 0 | Three link cards ("Inspect modules", "Inspect data and evidence") | Filler. Replace. |
| /today, /portfolio, /strategies, /data, /audit, /modules | 0 | Disclaimer paragraph + "Account alias / Environment" form; nothing until a scope is typed | Scoped readers of governed records. Useful later as detail views, not as landing pages. |
| /agents | 0 | "Checking the workspace session…" | No agent activity shown. The page that should matter most is empty. |
| /connections | 0 | "Read-only gateway status. Trading disabled." | Stub. |
| /research | — | Page load timed out (>29 s) | Needs a performance check. |
| /features, /feature-items, /settings | 0 | Template/demo content from the Dark Factory starter | Remove from primary navigation. |
| /watchlist | 1 | Real user data | Keep. |

Root cause: every data source in the governed `vertex_*` schema is account/environment-scoped, so each page begins with a scope form. There is no record of what agents are doing.

## 2. What RoboQuant does well (public site and docs, retrieved 2026-09-29)

Sources: <https://roboquant.dev>, /features, /docs/overview, /docs/backtesting, /docs/deployment, /pricing. Signed-in dashboard not yet inspected (see section 5).

- One lifecycle, one artifact: author -> compile -> backtest -> optimize -> deploy -> monitor, with the same compiled strategy at every stage.
- AI strategy coder: plain-English idea -> compiled strategy, with compile errors fixed before backtesting.
- MCP server: external AI (Claude, ChatGPT, Cursor) calls strategies_create, backtests_run, optimizations_run, deployments_list, and can read backtest chart images.
- Backtest view: live progress stream, chart replay, strategy logs, trade list, metrics (Sharpe, max drawdown, win rate), Monte Carlo, IS/OOS, walk-forward.
- Optimizer: grid, Bayesian, genetic and multi-objective (Pareto) searches; trials scored on unseen data.
- Deployment statuses: starting, running, paused, degraded, halted, stopping, stopped, error; live stream of status, orders, positions, trades, equity and logs.
- Connect product: kill switch, per-account daily trade and loss limits, allowed-symbol lists.

## 3. Target model for Vertex

The chat is the command surface. Everything else is monitoring and review of agent work.

```text
Operator (chat) -> agents -> tasks (+ events) -> artifacts (papers, strategies, backtests, deployments)
                                   |
                        Mission control shows: what is running, what needs me, what failed, what finished
```

## 4. Feature plan (priority order)

### P0 — build now

1. **Agent task ledger** (new tables `agent_tasks`, `agent_task_events`; one shared ledger for the fund, readable and writable only by operators). Kind: research, paper, strategy, backtest, forward_test, optimization, deployment, data, ops. Status: queued, running, needs_review, blocked, succeeded, failed, cancelled. Fields: agent name, title, summary, metrics JSON, links, parent paper, timestamps. Events: time, level, message.
   **Access:** `/sign-up` is public, so `agentOps.*`, `papers.*` and `agentApiKeys.*` require an operator: an active, email-verified account listed in `VERTEX_OPERATOR_EMAILS`. An empty list denies everyone.
2. **Machine write access for agents**: API-key authentication (official `@better-auth/api-key`) so agents (OMP, Agno workers, VPS jobs) can create/update tasks and append events without a browser session. Operators create and revoke keys. Keys reach only the ledger and paper library, and the key owner's operator status is re-checked on every request.
3. **Mission control** (replaces /dashboard): counters (running, needs review, blocked, failed in 24 h, papers by stage); "Needs you" table; "Running now" table; "Recent results" table; latest events. No scope form.
4. **Agent runs page** (replaces /agents): filterable table of all tasks; row detail shows the event log, metrics and links.
5. **Whitepaper library** (/papers): every paper with source, stage (queued -> ingested -> spec extracted -> implemented -> backtested -> forward tested -> verdict), verdict (pending, promising, inconclusive, rejected), blockers, reported vs reproduced metrics, linked tasks. Seeded with the four supplied regime papers:
   - ORCA — Online Regime Correlation Analyzer (arXiv 2604.17251v1).
   - Regime-Based Portfolio Allocation Using HMMs and Reinforcement Learning (arXiv 2605.27848v1).
   - Downside Risk Reduction Using Regime-Switching Signals: A Statistical Jump Model Approach (arXiv 2402.05272v3).
   - How To Use The Hidden Markov Model To Detect Market Regimes (Ruuj article; educational, not a paper).
   SSRN papers are added by the operator (URL or uploaded PDF); automated SSRN downloading stays off because SSRN's terms prohibit automated queries.
6. **Navigation**: primary = Mission control, Chat, Agent runs, Papers, Watchlist. Scoped governed readers move to a secondary "Records" group. Starter template pages leave primary navigation.

### P0 implementation status (2026-09-29)

- Built: tables `agent_tasks`, `agent_task_events`, `research_papers` (migration `packages/db/migrations/0015_agent_ops_ledger.sql`, guarded rollback `packages/db/rollback/0015_agent_ops_ledger.down.sql`; the four references are seeded with `ON CONFLICT DO NOTHING`). oRPC: `agentOps.summary`, `agentOps.tasks.{list,get,create,update,appendEvent}`, `papers.{list,add,update}`. Pages: `/dashboard` (Mission control), `/agents` (Agent runs), `/papers`. Navigation: primary group plus a "Records" group; starter template pages are out of the portal navigation but their routes remain.
- Item 2 (agent API keys) is **implemented in source (2026-09-29), pending migration 0016 on the local database and parent verification**. What changed:
  - Dependency: `@better-auth/api-key@1.6.24` (separate package; Better Auth 1.6.24 core has no `apiKey` plugin), added to the pnpm catalog and `@darkfactory/auth`.
  - Plugin: registered in `createAuth` (`packages/auth/src/server.ts`, `createAgentApiKeyPlugin`) with prefix `vrk_`, header `x-api-key`, SHA-256 key hashing (plugin default), per-key rate limit 600 requests per minute, name required (max 64). `enableSessionForAPIKeys` stays **false**, so a key never becomes a Better Auth session and `requireSession` ignores it everywhere.
  - Scope: every key this app issues carries the permission `{ agentLedger: ["write"] }` and verification requires it. The oRPC handler (`packages/api/src/server/handler.ts`) rejects any request that carries `x-api-key` with 403 unless the procedure path starts with `agentOps` or `papers`; this runs before procedure middleware, for both the RPC and OpenAPI handlers. The ledger middleware (`packages/api/src/server/agent-ops.ts`) authenticates a key request by the key alone (cookies ignored) and checks that the key owner is still active. Session users are unchanged.
  - Key management: oRPC `agentApiKeys.{list,create,revoke}` (session only; a key request is refused). The plugin's own `/api/auth/api-key/*` endpoints return 404. The **Agent API keys** section on `/agents` creates a key by name, shows the full key once, lists name, prefix, created and last used, and revokes with a confirm step.
  - Table: `apikey` (Drizzle `apiKeys` in `packages/db/src/schema/index.ts`), migration `packages/db/migrations/0016_agent_api_keys.sql` (IF NOT EXISTS), guarded rollback `packages/db/rollback/0016_agent_api_keys.down.sql` (refuses while keys exist). Generated schema `packages/auth/generated/better-auth-schema.ts` regenerated from `auth.schema.config.ts`.
- Operator allow-list (2026-09-29 security correction): sign-up is public, so an active session is not enough. `agentOps.*`, `papers.*` and `agentApiKeys.*` all use one oRPC middleware, `requireOperator` (`packages/api/src/server/operator-access.ts`, re-exported from `router.ts` next to `requireAdmin`). The caller must be active, email-verified and listed in the server env `VERTEX_OPERATOR_EMAILS` (comma-separated, case-insensitive, at most 50, parsed in `packages/config/src/server.ts`). Absent or empty means nobody is an operator (fail closed); anyone else gets 403 FORBIDDEN "Operator access required". For API keys the key owner's status, verification and list membership are re-read on every request after the plugin verifies the key, so removing an email disables that owner's keys immediately. Mission control, Agent runs and Papers show an "Operator access required" notice on 403; navigation stays visible. No auth tables were changed.
- Portal operator gating (2026-10-21, audit P1-1): the portal session carries `isOperator`, computed by the same `isOperatorIdentity` rule (`packages/config/src/server.ts`) that `requireOperator` uses. Non-operators do not see operator-only pages in the sidebar or command palette (`OPERATOR_PORTAL_ROUTE_PATHS` and `portalRoutePathsFor` in `apps/web/src/lib/navigation.ts`), land on a Mission control view with no IBKR monitor and no operator-only request, and see only the Projection view on `/portfolio`. The API still enforces the rule; a direct URL shows a per-feature "Operator access required" notice, and polling stops after 401/403.
- Agent client: `private/basic-app/agent-ops-20260929/agent-report.mjs` (Node 22, no dependencies). It reads `VERTEX_AGENT_API_KEY`, creates or updates a task and appends an event through the oRPC HTTP endpoint (`POST /api/orpc/agentOps/tasks/create` with body `{"json": {...}}`). POSTs must carry the app origin (`VERTEX_APP_ORIGIN`, default the origin of `VERTEX_APP_URL`); the server's CSRF gate is unchanged.

```sh
export VERTEX_AGENT_API_KEY=...            # from the Agent runs page, via the secret store
export VERTEX_APP_URL=https://localhost:3443
export NODE_EXTRA_CA_CERTS=/path/to/local-dev-ca.pem
node private/basic-app/agent-ops-20260929/agent-report.mjs --kind backtest --agent omp \
  --title "Backtest jump model v1" --status running --event "fold 1/5 complete"
node private/basic-app/agent-ops-20260929/agent-report.mjs --task-id <id> --status needs_review \
  --metric sharpe=0.61 --metric max_dd=-0.21 --event "done; needs review"
```

- Typed client equivalent: `createApiClient({ baseUrl, fetch: (request) => { request.headers.set("x-api-key", key); request.headers.set("origin", appOrigin); return fetch(request) } })`, then `api.agentOps.tasks.create(...)`, `update(...)`, `appendEvent(...)`, `api.papers.update(...)`. Any other procedure returns 403 for a key.

### P1 slice status (2026-09-29): backtest results and arXiv intake

Implemented in source, **pending migration 0017 on the local database (127.0.0.1:5433) and parent verification**.

- Table `backtest_results` (migration `packages/db/migrations/0017_backtest_results.sql`, IF NOT EXISTS; guarded rollback `packages/db/rollback/0017_backtest_results.down.sql` refuses while rows exist; journal idx 17). Columns: task_id (FK agent_tasks, cascade), paper_id (FK research_papers, set null), strategy, instruments, period_start/end (date), data_source, is_split, metrics (flat, 40 keys max), equity (max 5000 points, strictly increasing t, equity > 0), drawdown and max_drawdown (derived by the server from equity; not an input field), trades (max 2000, ordered by entry_t, exit >= entry), trade_count, folds (max 100; train_start < train_end <= test_start < test_end; ordered by test_start), notes, created_at. Validation runs twice: strict Zod in the contract, then `normalizeBacktestResult` (`packages/db/src/server/backtest-results.ts`) in the repository, which also rejects impossible calendar dates.
- oRPC `agentOps.backtests.record` (API-key callable under the existing agentOps.*/papers.* rule), `agentOps.backtests.list` (no series payloads; adds task title), `agentOps.backtests.get` (full row plus task). All use `requireOperator`.
- Page `/backtests` (primary navigation after Papers): table with reported Sharpe and CAGR, derived max drawdown, trades, data source and task link; detail with equity and drawdown charts (TanStack Charts 0.18.0 via `apps/web/src/features/charts/backtest-series.tsx`, lazy-loaded), IS/OOS table, walk-forward fold table and trade table (first 500 rows). Every view states that values are agent-reported.
- Agent client: `agent-report.mjs --task-id <id> --backtest-json result.json` (file format in the script header).
- `papers.addFromArxiv` (operator; API-key callable): accepts `2402.05272`, `2402.05272v3`, `arXiv:…`, `hep-th/9901001` or an arxiv.org abs/pdf URL; fetches `https://export.arxiv.org/api/query?id_list=…` server-side (10 s timeout, 512 KiB cap, redirects refused, content type checked), parses Atom strictly (no DOCTYPE/ENTITY/CDATA, only XML entities, exactly one entry whose id matches the request), stores title, authors, first-submission year, `arXiv:<id>v<n>`, abs URL and the abstract in notes with stage `ingested`. An identifier already stored (same version, or any version for a bare id) returns the existing row with `created: false` and no network call. `/papers` has an "Add from arXiv" input; SSRN and DOI stay on the manual form (SSRN terms do not permit automated retrieval).
- Not done: Monte Carlo band (no reported input shape yet); arXiv rate limiting beyond single operator use.

### Agent model runs (2026-11-01)

Framework runs (ticker, decision date, research rating, levels, usage, served model) with facet filters, a breakdown and CSV export on `/agents`: see [agent-model-runs.md](agent-model-runs.md).

### P1 — next

- **7.** Backtest results table and detail: metrics, equity curve, drawdown, trade list, IS/OOS split, walk-forward folds, Monte Carlo band (TanStack charts).
- **8.** Paper pipeline automation: an agent recipe that takes a paper, writes a spec, implements it in the research sandbox, runs backtest and forward test, and updates the paper row and tasks.
- **9.** Deployment monitor: RoboQuant-style statuses for Nautilus sessions on QuantVPS, with orders, positions, equity and logs, read-only first.
- **10.** Risk controls panel: kill switch state, daily loss/trade limits, allowed symbols (read from the execution host).
- **11.** MCP server exposing the ledger, papers and backtests so external AI can drive Vertex like RoboQuant's MCP.

### P2 — later

- **12.** Optimizer view (grid/Bayesian/Pareto trials) with out-of-sample scoring.
- **13.** Chart vision: agents read rendered backtest charts.
- **14.** Notifications: ntfy/email when a task enters needs_review or failed.

## 5. Open items

- RoboQuant signed-in dashboard: not inspected. The omp browser relay extension is not installed in the operator's Chrome and JEV is disconnected. One step unblocks it: run `omp browser-relay install` and enable the extension (or reconnect JEV).
- /research load time over 29 s: investigate separately.
