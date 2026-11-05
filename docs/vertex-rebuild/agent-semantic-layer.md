# Agent semantic layer: decision on NVIDIA Auto Ontology

Updated: 2026-11-05. Card `vertex-agent-semantic-layer`. Research only. Nothing here gives an agent permission to place, approve or change a trade.

## Decision

**Option (b): build the pattern natively in Vertex. Do not adopt NVIDIA Auto Ontology as a service (option a).**

The native layer is a small catalog of certified business terms plus two read-only tools (`list_terms`, `query_term`). Each answer returns the value, the exact SQL or live-feed path, the rows and the certification state. The model chooses a term and its parameters. The model never writes SQL.

Reasons:

1. **The most important terms are not in Postgres.** Net liquidation, P&L and live positions come from the `vertex-portfolio` feed (`packages/api/src/contracts/portfolio-monitor.ts`). Auto Ontology queries databases only, so it cannot answer the questions that carry the most risk.
2. **The current assistant gives wrong account numbers today.** In the prototype, the current tool set answered 23 of 24 account questions (Q1-Q8, three trials each) with numbers from the paper exec node, because `deployment_status` is the only account-like tool it has. The semantic layer answered all 24 correctly.
3. **Free text-to-SQL picks the wrong table.** The text-to-SQL arm (the approach Auto Ontology automates) gave 6 confident wrong answers, all on backtest metrics, where it read agent notebook records instead of engine runs. The semantic layer gave 0 wrong answers.
4. **Auto Ontology does not enforce its certification at query time.** The `certified` flags are UI badges and search filters; the text-to-SQL path does not read them (see the facts below).
5. **Cost and attack surface.** Auto Ontology adds six Compose services, its own Postgres with pgvector, an embedding endpoint and unauthenticated ports. Vertex already has an MCP server, oRPC, Drizzle and a tool loop that can carry two more read-only tools.

Auto Ontology remains a useful reference for the term data model (term, synonyms, certified SQL attribute, join path) and for the MCP answer shape (`answer`, `sql`, `rows`, `row_count`, `truncated`).

## Facts: NVIDIA Auto Ontology

Source: <https://github.com/NVIDIA/auto-ontology>, read at commit `2a24f5d` (2026-11-04), version 1.1.0. Local clone: `~/Github/tools/auto-ontology` on the rig. Paths in the Evidence column start at the clone folder `auto-ontology/`; they are not Vertex paths.

|Question|Finding|Evidence|
|---|---|---|
|License|Apache-2.0. Some dependencies are LGPL-3.0 (psycopg) or GPL-2.0 with the FOSS exception (mysql-connector). No outside contributions are accepted.|`auto-ontology/LICENSE`, `auto-ontology/THIRD_PARTY_NOTICES.md:40-45,76-84`, `auto-ontology/README.md:28`|
|Postgres as source|Supported through a libpq URI and a psycopg pool with `autocommit=True`. No read-only role is created or documented.|`auto-ontology/auto_ontology/connectors/postgres.py:55-64`, `auto-ontology/docs/connections.md:9-16`|
|Read-only guard|A keyword blocklist guards probe and validation SQL only. The final answer SQL runs through `execute_chat_sql` with no read-only check. Adoption would need a SELECT-only database role.|`auto-ontology/auto_ontology/retrieval/text_to_sql/db_probe/executor.py:45-68`, `auto-ontology/auto_ontology/retrieval/text_to_sql/chat_sql.py:59-87`|
|Own state|Postgres 17 with pgvector (catalog, ontology, vectors), Alembic and Prisma migrations, optional Vault. Connection passwords are stored unencrypted without Vault.|`auto-ontology/docker-compose.yml:6-7,103-141`, `auto-ontology/docs/connections.md:30-34`|
|Model endpoints|Four roles (LLM, embedding, reranker, PII). Defaults point to NVIDIA-hosted endpoints. Model names that start with `openai/`, `azure/` or `aws/` use an OpenAI-compatible client; other names use the NVIDIA client. There is no Anthropic client. An embedding endpoint is required, and Claude does not provide embeddings, so adoption needs a second model provider or a self-hosted embedding model.|`auto-ontology/auto_ontology/utils/model_config.py:30-58`, `auto-ontology/auto_ontology/utils/llm_invoke.py:221-255`, `auto-ontology/auto_ontology/utils/embedding.py:116-130`|
|MCP tools|Nine read-only tools over streamable HTTP only (`0.0.0.0:3003/mcp`): `ask_question` (runs the full text-to-SQL agent; returns answer, SQL and rows, max 100 rows), `check_answerable`, `check_readiness`, `search_terms`, `get_term`, `get_term_columns`, `get_term_sql_attributes`, `get_sql_attribute`, `describe_table`. There is no raw table-browsing tool over MCP, but all 87 REST operations stay reachable.|`auto-ontology/docs/mcp.md:126-157,191`, `auto-ontology/mcp/auto_ontology_mcp/chat.py:40-99`|
|Certification|Human-set booleans on terms, columns and SQL attributes. Only the server CRUD and search code reads them (`server/terms`, `server/search`, `server/sql_attributes`); the text-to-SQL code in `auto_ontology/retrieval/` (including `text_to_sql/agents/`) does not. Validation is sqlglot parsing, an LLM logic check, live value probes and a join-path check.|`auto-ontology/auto_ontology/dal/schema.py:121-128,456-471`, `auto-ontology/auto_ontology/retrieval/text_to_sql/agents/sql_parse_validation.py`, `auto-ontology/auto_ontology/retrieval/text_to_sql/agents/join_path_check.py` (found by search, not by a full trace)|
|Runtime|Compose: pgvector Postgres, pgAdmin, FastAPI backend (3001), ingestion service (3002), two migration jobs, Next.js frontend (3000). The MCP server runs separately. No GPU needed. Ports 3001 and 3002 trust a user-id header; Compose publishes ports 3000, 3001 and 3002 on the host.|`auto-ontology/docker-compose.yml:47,76,160`, `auto-ontology/README.md:271-275`, `auto-ontology/DEPLOYMENT.md:15-17`|
|Data leaving the host|Prompts with schemas, descriptions and sampled column values go to the configured model endpoints. KumoRFM uploads tables when its key is set (off by default). No analytics SDK found.|`auto-ontology/README.md:210-212,427-431`|

## Facts: Vertex today

- The operator assistant calls a fixed list of oRPC-backed MCP tools (`packages/api/src/server/assistant-runtime.ts:56-127`, `packages/api/src/server/mcp.ts:204-531`, `packages/api/src/server/research-tools.ts:62-113` for `drift_status`). No tool runs model-written SQL.
- No assistant tool reads the `vertex-portfolio` feed. `deployment_status` returns the QuantVPS exec-node snapshot, which has its own `equity.net_liq`, positions and P&L (`DeployEquityBlockSchema` in `packages/api/src/contracts/agent-ops.ts:1127-1136`). Paper deployment requests are paper-only by a check constraint (`deployment_requests.mode = 'paper'`).
- Backtest metrics live in two places with different meanings and units. Engine runs: `backtest_runs.report.metrics.sharpe` and `maxDrawdownPct`, which holds a positive fraction despite its name (0.2 = 20%; `packages/api/src/backtest-run-report.ts:108-121`). Agent records: `backtest_results.metrics` (free-form keys such as `sharpe_ratio` or `Sharpe`) and `max_drawdown` (negative fraction).
- Gate outcomes: `autopilot_candidates.status` is `evaluated` (not yet judged), `rejected` (failed `autopilot-gate-v1`) or `verified` (passed). `fitness` is in-sample Sharpe; `oos_sharpe` is out-of-sample.
- Crown copy-book legs have no data in Vertex. `crownCopy` is only an input flag of the risk allocator (`packages/api/src/contracts/risk-allocator.ts:36-48`).
- "Open risk" has no table or field. The prototype uses a proposed definition that the owner must certify.

## Prototype

The prototype is throwaway. Its purpose is to settle the decision above.

### Setup

- **Database:** a non-production database on the rig (`darkfactory_test_semantic_layer_proto`, local Postgres 17.6) built from the real migrations `0000`-`0048` and the synthetic [fixture.sql](agent-semantic-layer/fixture.sql). All names and numbers are invented. No production or account data was copied, and no data left the rig except synthetic rows sent to the model.
- **Read-only:** every query ran with `default_transaction_read_only=on` and a 5-second statement timeout. A test `DELETE` failed with "cannot execute DELETE in a read-only transaction".
- **Live feeds:** synthetic `vertex-portfolio` (live account, NLV 248,350.12) and `deployment_status` (paper exec node, `net_liq` 100,412.55) payloads in the shapes of the Vertex contracts.
- **Model:** the same Claude model for all arms through OMP `completion()` (subscription; no new provider), with the rules of the Vertex assistant system prompt, a JSON tool-call loop, 8 steps and 16,000-character tool results.
- **Arms:**
  - **A, current:** emulated current read tools: `strategies_list/get`, `backtests_list/get`, `backtest_runs_list/get`, `drift_status`, `deployment_status`.
  - **B, text-to-SQL:** `list_tables`, `describe_table`, `run_sql` on the database only. This is a proxy for option (a) without Auto Ontology's glossary. Auto Ontology itself was not run, because it needs an embedding endpoint that the Claude-only routing does not have.
  - **C, semantic layer:** arm A tools plus `list_terms` and `query_term` over the 10 terms below.
- **Grading:** a Claude grader with a fixed rubric (correct, wrong, declined), then a manual audit. Two grades were changed in the audit; both are listed in [eval-results.json](agent-semantic-layer/eval-results.json) under `overrides`. "Declined" means the answer said the data was unavailable and gave no wrong value.

### The 10 terms

|Term|Source|Definition|Certified|
|---|---|---|---|
|`net_liquidation`|feed `vertex-portfolio` `summary.netLiquidation`|NLV of the live IBKR account. Exec-node equity is the paper account and is not NLV.|yes|
|`open_risk`|feed positions, computed|Sum of the maximum loss of each open option structure: long option = premium paid; vertical spread = width x 100 x contracts - net credit. Also as % of NLV.|**no, owner must certify**|
|`pnl`|feed `pnl.daily/unrealized/realized`|Live account P&L for one window.|yes|
|`position`|feed positions|Live positions for one symbol, stock and options separately.|yes|
|`crown_copy_leg`|none|Returns "not available"; tells the model not to estimate.|no data|
|`strategy_gate_pass`|SQL `autopilot_candidates` + `autopilot_campaigns`|passed = `verified`, failed = `rejected`, not gated = `evaluated`.|yes|
|`backtest_sharpe`|SQL `backtest_runs`|Sharpe of the latest succeeded engine run per strategy. Notebook records are excluded.|yes|
|`backtest_max_drawdown`|SQL `backtest_runs`|`maxDrawdownPct` (a fraction) of the latest succeeded engine run, reported in percent.|yes|
|`deployment_request`|SQL `deployment_requests` + `strategies`|requested = waiting for the owner; draft = not submitted.|yes|
|`drift_level`|SQL `forward_drift_monitors` + `backtest_runs` + `strategies`|Drift level per paper strategy; default shows warn and alert.|yes|

"Certified" in the prototype is a field in the catalog. In the real build it means: the definition is reviewed in a pull request and the owner has accepted it.

### Results: 20 owner-style questions, 3 trials per arm

Cells show correct trials out of 3, with wrong and declined counts.

|ID|Question|A: current|B: text-to-SQL|C: semantic layer|
|---|---|---|---|---|
|Q1|What's my net liq right now?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q2|How much is 2% of my account? That is my max loss per new trade.|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q3|How much money do I have at risk in open options right now?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q4|Is my open options risk above 6% of NLV?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q5|How did I do today?|0/3 (2 wrong, 1 declined)|0/3 (3 declined)|3/3|
|Q6|What's my unrealized P&L?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q7|How many NVDA shares do I own?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q8|What are my SPY shares worth?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|Q9|How many Crown copy legs are open right now?|3/3|3/3|3/3|
|Q10|What share of my NLV is in the Crown copy book?|3/3|3/3|3/3|
|Q11|Which autopilot candidates passed the gate?|0/3 (3 declined)|3/3|3/3|
|Q12|How many candidates failed the gate in the SPY campaign?|0/3 (3 declined)|3/3|3/3|
|Q13|What's the Sharpe of the latest Opening Range Breakout backtest?|3/3|3/3|3/3|
|Q14|Which strategy has the best backtest Sharpe?|1/3 (2 wrong)|0/3 (3 wrong)|3/3|
|Q15|What was the max drawdown in ORB's latest backtest?|3/3|3/3|3/3|
|Q16|Do any strategies have a backtest drawdown worse than 20%?|2/3 (1 wrong)|0/3 (3 wrong)|3/3|
|Q17|Are any deployment requests waiting for me?|0/3 (3 declined)|3/3|3/3|
|Q18|Which strategy did I last approve for paper trading?|0/3 (3 declined)|3/3|3/3|
|Q19|Is any paper strategy drifting from its backtest?|3/3|3/3|3/3|
|Q20|Which drift monitors are in alert?|3/3|3/3|3/3|

|Arm|Correct (of 60)|Wrong (of 60)|Declined (of 60)|Questions correct in at least 2 of 3 trials|Mean tool calls|
|---|---|---|---|---|---|
|A: current|21|26|13|7 of 20|1.4|
|B: text-to-SQL|30|6|24|10 of 20|4.8|
|C: semantic layer|60|0|0|20 of 20|1.9|

### Held-out check: 5 questions written after the catalog

|ID|Question|A|B|C|
|---|---|---|---|---|
|H1|What's my account worth?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|H2|Is my NVDA option premium under the 2% of NLV cap for short-dated options?|0/3 (2 wrong, 1 declined)|0/3 (3 declined)|3/3|
|H3|What's my realized P&L?|0/3 (3 wrong)|0/3 (3 declined)|3/3|
|H4|What's the win rate of RSI Mean Reversion's latest backtest? (no term)|3/3|3/3|3/3|
|H5|How much buying power do I have? (no term; correct answer is "not available")|0/3 (3 wrong)|3/3|3/3|

H4 and H5 test terms that are not in the catalog. In H4 the semantic arm used the existing `backtest_runs` tool. In H5 it said that no certified term covers buying power and did not use the paper exec-node figure.

### What the numbers show

- **Wrong-account answers are the largest risk today.** Arm A answered account questions with the paper exec node's numbers in 23 of 24 main trials and 8 of 9 held-out trials. Most answers named the paper account in the text, but still gave the paper value as the answer.
- **Text-to-SQL refuses account questions but picks the wrong source for metrics.** Arm B wrote correct SQL for gates, requests and drift, but used notebook records (`backtest_results`) for Q14 and Q16, and so gave 6 wrong answers.
- **The semantic layer removes both errors in this test.** Arm C had 75 of 75 correct trials, including three questions (Q9, Q10, H5) where the right answer is "not available".
- **Units are a trap for agents too.** The first version of this prototype treated `maxDrawdownPct` as a percent because of its name. A fresh-context review found that the engine stores a fraction. The fixture and the term were fixed, and Q13-Q16 were run again for all arms; the tables show the second run. A certified term records the unit once, so each agent does not have to infer it.

### Limits of this evidence

- The same agent wrote the terms, the questions and the reference answers. The held-out set reduces this bias but does not remove it. The test shows that the tool shape prevents the observed errors; it does not show that 10 terms cover the owner's real questions.
- The data and feeds are synthetic. Real feeds can be stale or unavailable; the real build must return "unknown" in that case.
- Arm A emulates the current tools against the fixture. It is not the deployed assistant (which uses `VERTEX_ASSISTANT_MODEL` through OpenRouter).
- One model family and three trials per cell. The grader is a model, checked by a manual audit.
- The `open_risk` definition is a proposal. Its references assume the owner accepts it.

Artifacts: [fixture.sql](agent-semantic-layer/fixture.sql) and [eval-results.json](agent-semantic-layer/eval-results.json) (questions, references, terms, every answer, tool calls and grade). The harness ran in an OMP eval session and is not part of the product.

## Recommended build (follow-up card)

Follow the feature workflow in `AGENTS.md` (contract first, failing test, 100% coverage).

1. **Contract:** oRPC `semanticTerms.list` and `semanticTerms.query({ term, params })` with Zod parameter schemas per term. Output: `{ term, certified, source: "postgres" | "feed", query, rows, asOf, answer, status: "ok" | "unknown" | "not_available" }`. `query` is the SQL text or the feed path.
2. **Catalog:** a reviewed TypeScript module, one entry per term. SQL terms call Drizzle repository functions in `packages/db`; the returned `query` text comes from the Drizzle query (`toSQL()`), not from a model. Feed terms read the existing portfolio-monitor service. A stale or unavailable feed returns `unknown`, never zero.
3. **Tools:** add `terms_list` and `terms_query` to `MCP_TOOLS` as read-only tools; they are then available in Plan mode. Do not add a raw SQL tool.
4. **System prompt:** tell the model to use a certified term when one exists, and to say "not available" when none exists.
5. **Interim fix in the same card:** change the `deployment_status` tool description to state that its equity, positions and P&L belong to the exec-node account named in `session.trading_mode`, and are not the owner's IBKR account summary.
6. **Owner inputs for the build:** accept or change the `open_risk` definition, and choose a Crown copy-book data source (or keep the term as "not available").
7. **Acceptance:** an automated test runs the 25 questions above against fixtures with a recorded model, and checks that each answer carries the certified source.
