# Agent semantic layer: decision on NVIDIA Auto Ontology

Updated: 2026-11-09 (Q13 and H4 recorded again; build 2026-11-08). Cards `vertex-agent-semantic-layer` (decision) and `vertex-semantic-layer-build` (build). Research only. Nothing here gives an agent permission to place, approve or change a trade.

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
- "Open risk" has no table or field. Owner decision (2026-11-05): the certified term `open_risk` is the sum of the defined maximum loss of each open option structure (debit paid for long options and debit spreads; width minus credit for defined-width credit spreads). This is a research definition only. It changes no trade or risk setting.

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
|`open_risk`|feed positions, computed|Sum of the maximum loss of each open option structure: long option or debit spread = debit paid; defined-width credit spread = width x 100 x contracts - net credit. Also as % of NLV.|yes (owner, 2026-11-05)|
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
- The owner certified `open_risk` on 2026-11-05, after these trials ran. `eval-results.json` records it as `certified: false` because it is a record of that run.

Artifacts: [fixture.sql](agent-semantic-layer/fixture.sql) and [eval-results.json](agent-semantic-layer/eval-results.json) (questions, references, terms, every answer, tool calls and grade). The harness ran in an OMP eval session and is not part of the product.

## Recommended build (follow-up card)

Follow the feature workflow in `AGENTS.md` (contract first, failing test, 100% coverage).

1. **Contract:** oRPC `semanticTerms.list` and `semanticTerms.query({ term, params })` with Zod parameter schemas per term. Output: `{ term, certified, source: "postgres" | "feed", query, rows, asOf, answer, status: "ok" | "unknown" | "not_available" }`. `query` is the SQL text or the feed path.
2. **Catalog:** a reviewed TypeScript module, one entry per term. SQL terms call Drizzle repository functions in `packages/db`; the returned `query` text comes from the Drizzle query (`toSQL()`), not from a model. Feed terms read the existing portfolio-monitor service. A stale or unavailable feed returns `unknown`, never zero.
3. **Tools:** add `terms_list` and `terms_query` to `MCP_TOOLS` as read-only tools; they are then available in Plan mode. Do not add a raw SQL tool.
4. **System prompt:** tell the model to use a certified term when one exists, and to say "not available" when none exists.
5. **Interim fix in the same card:** change the `deployment_status` tool description to state that its equity, positions and P&L belong to the exec-node account named in `session.trading_mode`, and are not the owner's IBKR account summary.
6. **Owner inputs for the build:** choose a Crown copy-book data source (or keep the term as "not available"). The `open_risk` definition is certified (2026-11-05).
7. **Acceptance:** an automated test runs the 25 questions above against fixtures with a recorded model, and checks that each answer carries the certified source.

## Built (2026-11-08, card `vertex-semantic-layer-build`)

The build follows the recommendation above, with two changes the build task asked for: the catalog lives in Postgres (not in a TypeScript module), and certified SQL runs with read-only enforced by the database.

|Part|What|Where|
|---|---|---|
|Catalog|Tables `semantic_terms` (name, definition, synonyms, mapped columns, unit, parameters, source, feed path), `semantic_sql_attributes` (one reviewed SQL text per Postgres term) and `semantic_relationships` (join paths). Each row has `certified`, `certified_at`, `certified_by`, `certification_note`, `updated_by`. Seeded with the 10 terms above and 6 joins (`certified_by` = `migration 0056`). Any edit removes the certification of the edited row, and a certification names the row version (`updatedAt`) the operator reviewed: a row edited after that is refused with a conflict.|`packages/db/src/schema/semantic-layer.ts`, migration `0056_semantic_layer`, rollback `packages/db/rollback/0056_semantic_layer.down.sql`|
|Read-only SQL|The SQL attributes of one term query run on one reader connection (`SEMANTIC_DATABASE_URL`), opened for that query and never shared with the app, that logs in as `vertex_semantic_reader`: a role with CONNECT, USAGE on schema `public` and SELECT on six tables only (`strategies`, `backtest_runs`, `autopilot_campaigns`, `autopilot_candidates`, `deployment_requests`, `forward_drift_monitors`), no write privilege and no membership in the app role. Before each attribute the reader checks that the connection is the plain reader role; each attribute then runs in its own `READ ONLY` transaction, which is rolled back before the next one; before the next attribute, `DISCARD ALL` resets the session (it releases session advisory locks, which a rollback keeps), and a failed attribute or reset ends the query. The stored text is wrapped as one subquery with bound parameters (one statement, extended protocol), with a 5 s statement timeout and a 100-row cap. There is no keyword filter. A Postgres test shows that a function that deletes rows, `SELECT ... FOR UPDATE`, a read of `"user"`, `query_to_xml` over `"user"`, `set_config('role', <app role>)`, a second statement and a long query all fail at the database, and that a missing reader login or the app login answers "unknown" instead of falling back to the app connection.|`packages/db/src/server/semantic-layer.ts`, `tests/integration/database/semantic-layer.test.ts`|
|API|`semanticTerms.list`, `semanticTerms.query` (operator; read keys allowed), `semanticTerms.catalog`, `semanticTerms.update`, `semanticTerms.certify` (operator session only; API keys refused). Query output: `term`, `certified`, `source`, `query` (SQL or feed path), `rows`, `asOf`, `answer`, `status` (`ok`, `unknown`, `not_available`). An uncertified term or attribute answers `not_available`.|`packages/api/src/contracts/semantic-terms.ts`, `packages/api/src/server/semantic-terms.ts`|
|Account terms|`net_liquidation`, `pnl`, `position` and `open_risk` read only the `vertex-portfolio` feed. A disconnected gateway, a snapshot older than 5 minutes or a missing value answers `unknown`, never 0. `open_risk` pairs option legs per underlying, expiry and right; a short leg without a long leg has no defined maximum loss, so the total is `unknown`. `crown_copy_leg` and measures without a term (for example buying power) answer `not_available`.|`packages/api/src/server/semantic-feed-terms.ts`|
|Assistant|MCP tools `terms_list` and `terms_query` (read-only, so also in Plan mode). The system prompt tells the model to answer account and certified research questions from terms and to say "not available" otherwise. The `deployment_status` description now says its equity, positions and P&L belong to the paper exec node.|`packages/api/src/server/mcp.ts`, `packages/api/src/server/assistant-runtime.ts`|
|Operator page|`/semantic-terms` (operator only): view terms, SQL and joins; edit; certify or remove a certification with a note.|`apps/web/src/app/(portal)/semantic-terms/`, `apps/web/src/components/portal/semantic-terms-workspace.tsx`|

### Eval of the built layer

Method: the 25 questions above (Q1-Q20 main, H1-H5 held out), 3 trials each, through the real Plan-mode assistant turn (`runAssistantTurn`, all Plan-mode tools), the real oRPC handler, a Postgres database with all migrations plus [fixture.sql](agent-semantic-layer/fixture.sql), and synthetic feeds (`tests/integration/semantic-layer/fixtures.ts`: live account NLV 248,350.12; paper exec node net_liq 100,412.55). The model is the OMP `completion()` default model (Claude subscription, no new provider), bridged by `tests/integration/semantic-layer/record.ts`. Grading is a fixed rubric (`tests/integration/semantic-layer/questions.ts`): required values must appear and paper exec-node values must not appear anywhere in the answer. An independent grader (OMP `judge_batch`, TypeSafe `jev-1.14` model, one call per answer with the question and the reference; synthetic data only) graded all 75 answers and agreed with the rubric on every trial. Its verdicts are stored in the recording with the grader name, the instructions and the date; they are an attestation from the recording run, not recomputed in CI.

|Set|Correct|Wrong|Declined|
|---|---|---|---|
|Main (Q1-Q20), 60 trials|60|0|0|
|Held out (H1-H5), 15 trials|15|0|0|
|Account questions (Q1-Q8, H1-H3), 33 trials|33|0|0|

Every account trial called `terms_query`; no trial called `deployment_status`. Mean tool calls per trial: about 1.9.

What CI proves and what it does not: the 75 answers above are a one-time result of the recording. CI does not call a model. `tests/integration/semantic-layer/eval-replay.test.ts` replays the recording (`eval-recording.fixture.json`) against the built layer in the integration lane. It checks that everything the model was given (tool definitions, system prompt, question and every tool result) is unchanged (else the recording is stale and must be recorded again), regrades every answer with the rubric, and fails below 58/60 (rubric and recorded independent grade both "correct") or on any wrong account answer (by either grade). Re-record: `bun run eval:semantic:record -- 3 8` with a stdio model bridge (protocol in the script header).

Rubric and harness changes made while recording (all before the final recording, listed for review):

- A pilot found the fixture's `backtest_runs` rows did not match the API contract (spec and report fields), so `backtest_runs_list` failed. The fixture now fills those fields; the metrics are unchanged.
- The `not available` pattern also accepts "none of the certified terms" and "can't give"; Q16 accepts "22.50%".
- Strategy filters also match initials ("ORB"), and the prompt names approvals of paper deployment requests. In the first full recording, Q15 trial 1 was graded wrong because it quoted the notebook figure (-11%) while rejecting it, and Q18 trials 2-3 did not use the term; that recording scored 57/60.
- Fixture timestamps that defaulted to the run time (drift monitors' `updated_at`, migration-seeded strategies) are now fixed, so the replay is deterministic.

Deploy steps for the reader (QuantVPS, as a superuser in `vertex-postgres`): apply `0056_semantic_layer.sql` alone with `psql -v ON_ERROR_STOP=1 --single-transaction` (it creates the NOLOGIN role and its grants), then `ALTER ROLE vertex_semantic_reader LOGIN PASSWORD '<generated>'` and put `SEMANTIC_DATABASE_URL` (same host, port and database as `DATABASE_URL`, user `vertex_semantic_reader`) in the server-side `.prod.vars`. The password is never committed.

### Deployed (2026-11-08)

- PR #113, deployed commit `92580c26` (full CI on that exact commit: run 42513726013). Migration `0056_semantic_layer` was applied alone in `vertex-postgres`; `vertex_semantic_reader` has a login (owner approval in the job channel) and `SEMANTIC_DATABASE_URL` is in the server-side `.prod.vars`. `log_statement` is `none`, so the password is not in the server log.
- Live check through the API as the agent viewer (no model): all 10 terms are listed as certified. `net_liquidation`, `open_risk` and `position` answer from `vertex-portfolio` (status ok); `pnl` with window `unrealized` answers `unknown` because the feed has no value for it; the backtest terms run as the reader login (status ok).
- Feed terms now also require `account.mode = live` in the snapshot; a feed logged in to a paper or unknown account answers `unknown` (follow-up PR).
- Live data gap: all succeeded `backtest_runs` in production have no `strategy_id`, so `backtest_sharpe` and `backtest_max_drawdown` (latest run per strategy) return no rows. The owner chose a run-level answer; see "Engine runs with no strategy" below.
- The live assistant check (3 account + 2 backtest questions) waits on the model provider: OpenRouter answers 402 "credits exhausted" for every message.
- Operator page checked in headless Chrome as the agent viewer (dark theme, 1440 px and 375 px, no horizontal overflow): 10 terms, all certified, read-only note, no Edit or Certify buttons.

### Engine runs with no strategy (2026-11-08, card `vertex-semantic-unlinked-runs`)

The owner chose to include engine runs that have no strategy ("1️⃣ New card: include unlinked engine runs"). In production all 26 succeeded `backtest_runs` have `strategy_id` null: 20 engine-comparison sweep runs and 6 DSL runs whose strategy row is gone. They form 25 run specs.

|Part|What|Where|
|---|---|---|
|Grain|`semantic_sql_attributes.grain` says what one row stands for: `strategy`, `run_spec`, `candidate`, `request` or `monitor`. A term has at most one SQL attribute per grain (unique index on term and grain; before, one attribute per term). Migration 0058 fills the grain of the five 0056 attributes and changes nothing else in them: SQL, certification, `updated_at` and `updated_by` stay.|`packages/db/src/schema/semantic-layer.ts`, migration `0058_semantic_unlinked_runs`, rollback `packages/db/rollback/0058_semantic_unlinked_runs.down.sql`|
|Run-spec SQL|`backtest_sharpe_run_spec` and `backtest_max_drawdown_run_spec`: the latest succeeded engine run per run spec over runs with `strategy_id` null. The run spec is symbol, timeframe, the exact `spec.rule`, stop loss, take profit, cost and date range: runs that differ in any of these are different backtests (for example sweep cells), so each gets its own row instead of the newest hiding the others. Only `report.metrics` is read, not the whole report. Each row has a readable rule (`smaCross fast 10 slow 30`, `breakout entry 20 exit 10 trend SMA 200`, `dsl <definition name>`), stop loss, take profit, cost, date range, the strategy name stored on the run if any, `succeeded_runs_in_spec` and `newer_runs_not_succeeded`. Drawdown is `maxDrawdownPct` (a fraction) x 100, in percent, like the per-strategy SQL. They bind the terms' existing parameters: `strategy` matches the strategy name stored on the run, the DSL definition name or the symbol; `min_percent` filters drawdowns. Same reader role and tables; no new grant. The per-strategy SQL of 0056 is unchanged.|migration `0058_semantic_unlinked_runs`|
|Certification|Both run-spec attributes are seeded **not certified** (`certification_note` "Needs owner certification ..."). The agent did not certify them. Until the owner certifies them on `/semantic-terms`, the API runs only the certified per-strategy SQL and the answer says the run-spec SQL waits for certification. The page shows each attribute's grouping and "Needs owner certification" on an uncertified one.|`apps/web/src/components/portal/semantic-terms-workspace.tsx`|
|Answer|A term answers when the term and at least one of its SQL attributes are certified; each certified attribute runs. With several attributes every row starts with a `grain` cell, `groupings` lists each attribute with `status` `ok`, `unknown`, `not_certified` or `not_run` and the number of its rows shown, and the answer names each grouping and its row count. An answer with a grouping that waits for certification starts "Partial, not a complete answer", names that grouping as NOT checked (rows may exist) and tells the model not to report that there are none; this is the production answer until the owner certifies the run-spec SQL. When the 100-row cap is used up, a grouping says "not shown (row cap reached)", never "no rows match". One failed attribute makes the whole answer `unknown` with no rows and no counts. `terms_list` shows each term's groupings and their certification. Unknown measures still answer "not available".|`packages/api/src/server/semantic-terms.ts`, `packages/api/src/contracts/semantic-terms.ts`|
|Assistant|`terms_query` and the system prompt tell the model to say which grouping each row uses and that a grouping waiting for certification gives no value.|`packages/api/src/server/mcp.ts`, `packages/api/src/server/assistant-runtime.ts`|

Eval: the fixture gains six dummy engine runs with no strategy (IWM sma 10/30 twice, DIA breakout plus a newer failed run, GLD sma 5/20 with and without a 2% stop loss) and certifies the two run-spec attributes as an operator would (`certified_by` "eval fixture (stands in for the owner)"; synthetic database only). Five questions U1-U5 ask for them. All 30 questions were recorded again, 3 trials each (90 answers, OMP `completion()` default model), because the tool list and tool results changed. The independent grade (OMP `judge_batch`, TypeSafe `jev-1.14.0`) now reads each reference from `tests/integration/semantic-layer/questions.ts`. Q16's reference changed: "worse than 20%" now also has two run specs, so an answer that lists them as run specs next to Sector Momentum is correct. With the old reference the grader marked 2 of those 3 answers wrong. The eval covers the certified state only: the pre-certification answer ("Partial, not a complete answer ... NOT checked ...") is pinned by unit tests, not by a model run.

|Set|Correct|Wrong|Declined|
|---|---|---|---|
|Main (Q1-Q20), 60 trials|60|0|0|
|Held out (H1-H5), 15 trials|15|0|0|
|No strategy (U1-U5), 15 trials|15|0|0|
|Account questions (Q1-Q8, H1-H3), 33 trials|33|0|0|

The replay test (`eval-replay.test.ts`) also requires U1-U5 >= 13/15 correct by both grades and none wrong. In a pilot recording one U1 call tried a `symbol` parameter the terms do not have; the `terms_query` description now says `strategy` also matches a symbol, and no U trial in the final recording has a failed call. No trial called `deployment_status`.

Re-recording 2026-11-09 (migration 0065): `strategies_list` rows gained `priority` and `externalValidation`, so the tool results of the two questions that call it changed and their recorded trials were stale. Q13 and H4 were recorded again (`bun run eval:semantic:record -- 3 1 Q13 H4`, OMP completion model, 3 trials each) and graded the same way (OMP judge_batch, then a manual audit). All six answers give the reference value (0.82; 61%), as before. The other 84 trials are unchanged.

The certified term descriptions of 0056 still say "per strategy"; the migration does not edit certified rows, and the answer text names each grouping instead. The owner can edit them on `/semantic-terms` (an edit removes the term's certification until it is certified again).

Deploy: apply `0058_semantic_unlinked_runs.sql` alone in `vertex-postgres` with `psql -v ON_ERROR_STOP=1 --single-transaction`, then deploy the web build. No new role, grant or secret.

Limits: same as the prototype (one model family, synthetic data, the same agent wrote terms, questions and references). The deployed assistant uses `VERTEX_ASSISTANT_MODEL` through OpenRouter; the live check after deploy covers that path.
