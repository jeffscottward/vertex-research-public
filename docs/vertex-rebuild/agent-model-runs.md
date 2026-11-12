# Agent model runs

Updated: 2026-11-01. Research only. Agent ratings never place orders.

## Purpose

An agent runs a multi-agent trading framework (for example TradingAgents, AI Hedge Fund or Vibe-Trading) on one ticker and one decision date, and records the run here: framework, provider and model, the model the provider served, the research rating, entry/stop/target levels, horizon, status, usage and cost. The operator compares runs on the **Model runs** section of `/agents` with facet filters, a group-by breakdown and a CSV export.

A rating (buy, overweight, hold, underweight, sell) and the levels are research labels. They never authorize, create or size an order. No order, intent or position code reads this table.

The idea comes from the run database of Glassbench (Apache-2.0, commit 255414b). No Glassbench code is copied.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `agentModelRuns.record`, `.update`, `.list`, `.breakdown`, `.exportCsv`, `.get`, `.appendEvents`, `.events`, `.search`, `.benchmark` | `packages/api/src/contracts/agent-model-runs.ts` |
| Benchmark (pure), page `/agents/benchmark` | `packages/api/src/agent-model-benchmark.ts`, `apps/web/src/components/portal/agent-model-benchmark-workspace.tsx`; see [agent-benchmark.md](../agent-benchmark.md) |
| Procedures | `packages/api/src/server/agent-model-runs.ts` |
| CSV export (pure) | `packages/api/src/agent-model-runs-csv.ts` |
| Table `agent_model_runs` | `packages/db/src/schema/index.ts`, migration `0037_agent_model_runs`, rollback `packages/db/rollback/0037_agent_model_runs.down.sql` |
| Table `agent_model_run_events` (with a generated full-text vector) | `packages/db/src/schema/index.ts`, migration `0038_agent_model_run_events`, rollback `packages/db/rollback/0038_agent_model_run_events.down.sql` |
| Repository, facets, horizon buckets | `packages/db/src/server/agent-model-runs.ts` |
| Section on `/agents`, detail page `/agents/runs/<id>` | `apps/web/src/components/portal/agent-model-runs-workspace.tsx`, `agent-model-run-detail.tsx`, `agent-model-runs-client.ts` |
| Live view and replay state (reducer, agent cards) | `apps/web/src/components/portal/agent-model-run-view.ts` |
| MCP tools | `model_runs_list`, `model_runs_get`, `model_runs_search`, `model_runs_benchmark`, `model_runs_record`, `model_runs_update`, `model_runs_append_events` in `packages/api/src/server/mcp.ts` |

## Access

All procedures use `requireOperator`, like `agentOps.*`: an operator session, or an agent API key whose owner is in `VERTEX_OPERATOR_EMAILS`. A read key may call `list`, `get`, `breakdown`, `exportCsv`, `events`, `search`, `benchmark` and `frameworks`. `record`, `update` and `appendEvents` need a write key.

## Record a run

`record` is idempotent by `runKey`. The agent picks the key (for example `ta-AAPL-2026-09-01-gpt4omini-1`). A second `record` with the same key returns the first run unchanged, so a retry after a timeout never adds a duplicate.

```sh
curl -sS "$VERTEX_APP_URL/api/orpc/agentModelRuns/record" \
  -H "x-api-key: $VERTEX_AGENT_API_KEY" \
  -H "origin: $VERTEX_APP_URL" \
  -H "content-type: application/json" \
  -d '{"json":{"runKey":"ta-AAPL-2026-09-01-1","framework":"tradingagents","frameworkVersion":"0.2.0","provider":"openai","model":"gpt-4o-mini","ticker":"AAPL","decisionDate":"2026-09-01","analysts":["market","news"],"status":"running","flags":["point_in_time"]}}'
```

Then report the result with `update` (the id comes from the `record` response):

```sh
curl -sS "$VERTEX_APP_URL/api/orpc/agentModelRuns/update" \
  -H "x-api-key: $VERTEX_AGENT_API_KEY" \
  -H "origin: $VERTEX_APP_URL" \
  -H "content-type: application/json" \
  -d '{"json":{"id":"<id>","status":"succeeded","rating":"overweight","ratingSource":"stated","entryPrice":190.5,"stopPrice":181,"targetPrice":212,"horizon":"2-4 weeks","inputTokens":48210,"outputTokens":9120,"llmCalls":14,"toolCalls":22,"costUsd":0.0412,"modelsServed":[{"requested":"gpt-4o-mini","served":"gpt-4o-mini-2024-07-18"}]}}'
```

MCP agents call the tools `model_runs_record` and `model_runs_update` on `/api/mcp` with the same fields.

The usage counters and cost are totals that the agent reports. The server never adds them up.

## Fields

| Field | Meaning |
| --- | --- |
| `runKey` | Client idempotency key, 1-128 letters, digits, `.`, `_`, `:` or `-`. Unique. |
| `taskId` | Optional agent task (`agentOps.tasks`). Deleting the task keeps the run and clears the link. |
| `framework`, `frameworkVersion` | Lowercase slug (for example `tradingagents`, `ai_hedge_fund`, `vibe_trading`) and its version. A version with `+` (for example `0.2.0+abc123`) is a locally adjusted build; the page tags it "adjusted". |
| `provider`, `model` | The provider and the model the agent requested. |
| `modelsServed` | Up to 16 `{ requested, served }` pairs: the model the provider actually served, read from the response metadata. |
| `ticker`, `decisionDate` | Uppercase ticker and the date the decision is for (YYYY-MM-DD). |
| `analysts` | Up to 16 analyst or desk names that took part. |
| `rating`, `ratingSource` | Research rating on the five-tier scale, or null. `ratingSource` is `stated` (the model said it), `mapped` (read from other wording) or `missing`. A run without a rating is always `missing` and is never counted as hold. |
| `entryPrice`, `stopPrice`, `targetPrice`, `horizon` | Research levels (positive numbers) and the horizon text. |
| `status`, `error` | `queued`, `running`, `succeeded`, `failed` or `cancelled`, and an error text up to 2000 characters. |
| `inputTokens`, `outputTokens`, `llmCalls`, `toolCalls`, `costUsd`, `durationMs` | Usage totals. |
| `flags` | Up to 16 slugs, for example `memory_off`, `point_in_time`, `rerun`, `parse_failed`. |
| `batch` | Groups the runs of one grid or benchmark. |
| `purpose` | `live` (default), `backtest`, `benchmark` or `imported`. |
| `variant` | Name of a runtime variant that changes one thing (for example `no-memory`). |
| `memory`, `dataSource` | Whether the framework's memory was on, and the market data source. |
| `startedAt`, `finishedAt` | ISO timestamps. Moving to `running` sets `startedAt`, and a terminal status sets `finishedAt`, when the agent does not send them. |

## Status rules

The status moves forward only: `queued` to `running` to a terminal status (`succeeded`, `failed`, `cancelled`). A terminal status is final. An update that tries to change it returns 409 CONFLICT. On a finished run only `rating`, `ratingSource` and `flags` can still change; any other field returns 409 CONFLICT, so report usage totals before or with the terminal status. A terminal status always has a finish time (the one sent, the stored one or the server time), and a later update cannot clear it. `startedAt` and `finishedAt` may not be more than 60 seconds in the future (422).

## Secrets

Never send API keys or other secrets. The server replaces anything that the shared log redaction detectors (`packages/observability/src/redaction.ts`) find in `error` with `[REDACTED]` before it stores the text.

## List, facets, breakdown and export

`list` returns runs newest decision date first (then newest record), at most 200 per page, with `nextCursor` for the next page. Facet counts are computed on the first page only; a cursor page returns empty facet lists unless `includeFacets: true` is sent. Filters: `framework`, `provider`, `model`, `servedModel`, `ticker`, `rating` (use `unrated` for runs without a rating), `status`, `flags`, `purpose`, `variant`, `horizonBucket`, `batch`, `decisionFrom` and `decisionTo`. Values in one filter are alternatives (any of); different filters must all match.

`facets` gives up to 50 values with run counts for each of framework, provider, model, served model, ticker, rating, status, flags, purpose, variant, horizon and batch. Each facet counts the runs that match every other active filter, so the counts show what selecting a value would return. `batch` is a single-value filter: the Model runs section leaves it out of its checkboxes, and the benchmark page picks it from a list.

The horizon bucket is derived from the horizon text by the largest time unit it names: `quarters_plus` (quarter, year, long term, `1y`), `months` (month, medium term, `3m`), `weeks` (week, `2w`), `days` (day, intraday, short term, `5d`), else `unknown`.

`breakdown` groups the filtered runs by framework, model, served model, provider, ticker, variant or purpose (at most 100 groups) and returns runs, rated runs, hold share (hold ratings among rated runs), failed runs and average and total cost.

`exportCsv` returns up to 5000 filtered runs as CSV text with a fixed column order (RFC 4180 quoting, CRLF rows) and `truncated: true` when more runs matched. A cell that starts with `=`, `+`, `-`, `@`, tab or carriage return (also after leading white space), or with a fullwidth `＝`, `＋`, `－` or `＠`, gets a leading `'` so a spreadsheet does not read it as a formula. The page downloads it as a file.

## Events

While a run works, the agent appends what its desks do with `appendEvents` (MCP `model_runs_append_events`): up to 200 events per call and at most 5000 per run.

```sh
curl -sS "$VERTEX_APP_URL/api/orpc/agentModelRuns/appendEvents" \
  -H "x-api-key: $VERTEX_AGENT_API_KEY" \
  -H "origin: $VERTEX_APP_URL" \
  -H "content-type: application/json" \
  -d '{"json":{"runId":"<id>","events":[{"seq":0,"agent":"Market Analyst","kind":"tool_call","title":"get_stock_data","toolName":"get_stock_data"},{"seq":1,"agent":"Market Analyst","kind":"reasoning","title":"Reads the chart","body":"RSI is oversold near support."}]}}'
```

| Field | Meaning |
| --- | --- |
| `seq` | Order of the event in the run, from 0. Unique per run. |
| `at` | ISO timestamp; the server time when absent. |
| `agent` | Desk or agent name, for example "Market Analyst" (max 100). |
| `kind` | `llm_call`, `tool_call`, `tool_result`, `reasoning`, `message`, `decision`, `status` or `flag`. |
| `title`, `body` | Short title (max 300) and optional plain text (max 16000). For a `flag` event the title is the flag slug. |
| `model`, `toolName` | The model of an LLM call and the tool of a tool call or result. |
| `inputTokens`, `outputTokens`, `costUsd`, `durationMs` | Usage of this one event. |

Rules:

- Seqs increase per run. An event whose `seq` already exists is skipped (never duplicated or overwritten), so an exact retry is safe. A new seq at or below the highest stored one returns 409 `SEQ_CONFLICT`, so a reader that polls after its last seq never misses an event. The response gives `appended` (new events), `lastSeq` and `redactedSeqs`.
- A `flag` event also adds its slug to the run's `flags` in the same transaction, once (the run keeps at most 16 flags).
- The usage totals on the run are not summed from events. The agent reports them with `update`, so each field has one writer.
- A finished run takes late events for 10 minutes after it finished; after that `appendEvents` returns 409 `RUN_CLOSED`. More than 5000 events returns 409 `EVENT_LIMIT` and stores nothing from that call.
- Event text is model output. It is stored and shown as plain text only (no HTML or Markdown). Before storage the server replaces anything the shared redaction detectors find (for example `api_key=…`, `input_tokens: …`, e-mail addresses) in the title, body, agent, model and tool name with `[REDACTED]`, adds the `redacted` flag to the run and lists those seqs in `redactedSeqs`. Only a clear credential (a PEM private key, a Bearer or Basic credential, a URL with user:password) refuses the batch with 422, naming the `seq`.

`events` (runId, `afterSeq` default -1, `limit` up to 500) returns the events after `afterSeq` in seq order, the run (status, rating and usage), `nextSeq` (the `afterSeq` for the next call) and `done` (the run is finished, no event is left and its 10-minute late-event window has closed). `get` returns the run with its first 500 events in the same shape.

## Live view and replay

`/agents/runs/<id>` shows the run fields, one card per agent and the timeline.

- Agent cards: LLM calls, tool calls, tokens and cost of that agent, and its phase at the current position: "Reading data" (a tool call without a result yet), "Writing" (the latest event is an LLM call or a message), "Thinking" (reasoning), "Done" (a decision, or the end of a finished run). The card line is the end of the latest reasoning while the agent works, and its conclusion (latest decision or message) when it is done.
- Timeline: every event up to the position with a kind icon, time, agent and title. "Show text" opens the body as wrapped plain text.
- Live: while the run is queued or running, the page asks for new events every 2 seconds from the last seq, adds them and follows the newest one. Scrolling up or "Pause" stops following; "Follow" resumes it. A finished run is polled every 10 seconds until the server says done. A failed poll is tried again after 4 and 8 seconds; after 3 failures polling stops ("Resume" restarts it). Polling also stops when the page closes. Following does not animate the scroll.
- Replay: for a finished run, "Play" steps through the events from the first one (1x, 2x or 4x: one event per second, half second or quarter second). "Pause", "Step back", "Step forward" and the position slider move through the run; the cards and the timeline follow the position. All controls are buttons or a range input, so they work from the keyboard.

## Search

`search` (MCP `model_runs_search`) runs a Postgres full-text search (English configuration, `websearch_to_tsquery`) over event titles and bodies. A generated `tsvector` column with a GIN index backs it. It returns up to 50 runs, best match first, each with up to 3 snippets made by `ts_headline`, split into plain text segments with `match: true` on the matched words. Snippets keep text that looks like markup (`<b>`, `price<100`, `&amp;`) exactly as stored: `ts_headline` would drop HTML tags, so the query escapes `&` and `<` before it and unescapes the result. The list filters apply. Only the 5000 newest matching events are ranked, and the query stops after 2 seconds (503 `SEARCH_TIMEOUT`; narrow the filters or the query). The **Search event text** box on the Model runs section shows the results above the run table, with the matched words marked.

## Benchmark

`benchmark` (MCP `model_runs_benchmark`, page `/agents/benchmark`) groups up to 5000 filtered runs into arms (`armBy`: `model`, `servedModel`, `provider_model`, `framework` or `variant`) and compares them on shared (ticker, decision date) cells: coverage, rating mix, rerun agreement, agreement with `baselineArm`, a pairwise agreement matrix of the 12 largest arms and, with `pair: { control, treatment }`, directional hits on the 5-day forward return with an exact sign test. [agent-benchmark.md](../agent-benchmark.md) defines each measure and describes the bench command that records the runs.

`frameworks` returns the static reference sheets of the frameworks Vertex benchmarks (TradingAgents desks, AI Hedge Fund event study, Vibe-Trading, LangAlpha trade pitch structure): status, version, stages, data with point-in-time notes, allowed and excluded tools, guards, code paths, licence and links. The page shows them in its Frameworks section.

## In The Money Adam desk

Research only. `services/research/agents/inthemoneyadam_desk.py` is a deterministic, extractive stock-picking desk built on the local "In The Money Adam" knowledge base (`~/Github/knowledge-bases/trading/inthemoneyadam`). For one ticker it returns a typed `DeskOutput`: `verdict` (`favorable`, `neutral`, `unfavorable` or `insufficient_evidence`), ticker findings, risks, criteria checked and citations (`video_id`, `title`, `url`, `timestamp`, `quote`). It calls no model.

- Every quote is checked against the raw transcript; an unverified quote is dropped.
- Only findings whose own text or quote names the ticker carry a stance and set the verdict. Generic rules carry no stance. Without a ticker-naming directional finding the verdict is `insufficient_evidence`.
- `research_only` is always `true`, `can_authorize_trade` is always `false`, and the output has no size, side, order or level field.

`agents/inthemoneyadam_record.py` records one desk run with framework `inthemoneyadam_desk`, analyst `inthemoneyadam`, flag `research_only` and no rating. It calls only `agentModelRuns.record`, `.appendEvents` and `.update` and needs a write key:

```sh
cd services/research
python -m agents.inthemoneyadam_record --kb ~/Github/knowledge-bases/trading/inthemoneyadam \
  --kb-commit "$(git -C ~/Github/knowledge-bases/trading/inthemoneyadam rev-parse HEAD)" \
  --ticker AMD --origin "$VERTEX_APP_URL" --key-file <write-key-file>
```

The run shows on `/agents/runs/<id>` with a `decision` event and one `kb_citation` event per citation. Tests: `services/research/tests/test_inthemoneyadam_desk.py`.

## TradingAgents desks over OMP Claude

Research only. `services/research/agents/tradingagents_cli.py` runs the TradingAgents desks of `TradingAgentsResearchAdapter` (`agents/external_research.py`) for one ticker on demand: the bull/bear brief desk, then the setup debate desk (with `--themes`, the theme discovery desk first). The model is Claude through the OMP subscription only (`agents/omp_claude.py`, `OmpClaudeGenerator`): one lean `omp -p --mode json` process per desk, with no tools, extensions, skills, rules, context files, LSP, title or session file, the advisor off in a temporary config overlay, the prompt on stdin, an environment without per-token provider keys (every `*_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, provider base URLs), a timeout and a model allow-list (default `anthropic/claude-opus-5-5`). The answer is the JSON in the last assistant message of the `agent_end` event (a fenced `json` block is accepted). No OpenAI, Codex, OpenRouter or per-token API key is used.

```sh
cd services/research
python -m agents.tradingagents_cli --ticker NVDA --as-of 2026-11-04 --thinking low \
  [--context ctx.json] [--themes] [--out <path>]
```

- Context: the ticker, the date and a note that no data was fetched, plus an optional caller JSON object (`--context`). A context key that looks like account, position, balance, credential or order data (for example `price`, `limit_price`) is refused before any model call.
- Output: without `--out`, the dossier goes to `private/research/tradingagents/<TICKER>-<date>.json` at the repository root (git-ignored). It holds the typed desk outputs, the prompt names, the requested and served models, timings, token usage and source references. Next to it, `<TICKER>-<date>.record.json` holds an `agentModelRuns.record` body (framework `tradingagents`, flag `research_only`, variant `thinking-<level>`, no rating and no levels) and the `appendEvents` events (one `llm_call` and one `message` or `decision` per desk). The command sends nothing. To store the run, post `.record` to `agentModelRuns/record` with a write key as shown above, then post `.appendEvents` with the returned `id` as `runId`. `costUsd` is the list-price cost that OMP reports; the subscription has no per-token bill.
- Guards: every desk output is validated against its typed contract, and output with an order-like key at any depth (for example `strike`, `orderType`, `price`) fails the run. A failed run writes no dossier, only a `failed` record payload with the error and the events of every model call made so far, and exits 1. Bad input exits 2.

Tests: `services/research/tests/test_omp_claude.py` and `services/research/tests/test_tradingagents_cli.py` (fake `omp`, no network or model).

## AI Hedge Fund persona committee over OMP Claude

Research only. `services/research/agents/hedgefund_committee_cli.py` runs the AI Hedge Fund investor personas (Buffett, Munger, Graham, Lynch, Druckenmiller; `agents/hedgefund_committee.py`) for one ticker on demand. All selected personas run in **one** model call: one prompt with a block per persona and one JSON answer with a section per persona. Every `omp -p` call carries a large fixed OMP prompt, so one call per persona would multiply the cost. The transport is the same `OmpClaudeGenerator` as the TradingAgents desks (Claude through the OMP subscription only).

```sh
cd services/research
python -m agents.hedgefund_committee_cli --ticker AAPL --as-of 2026-11-05 --thinking low \
  --context aapl-company-facts.json --context aapl-financial-metrics.json \
  [--personas buffett,munger,graham,lynch,druckenmiller] [--out <path>]
```

- Provenance: only the persona instructions (checklist, signal rules, confidence guide) are adapted from AI Hedge Fund (MIT, `backtesting/AI_HEDGE_FUND_LICENSE.txt`); the module docstring names the upstream commit and the SHA-256 of each persona file. Position, short and sizing wording became research signals; AI Hedge Fund's data clients, LLM clients, portfolio manager, brokers and graph are not used. The personas are stylized approximations, not the actual individuals and not endorsements. The `frameworks` sheet still describes only the event-study adaptation.
- Context: each `--context` file (at most 8) is a caller-supplied research JSON object, for example Financial Datasets CLI output, placed under its file stem. Nothing is fetched. Account, position, balance, credential and order-like keys are refused before the model call, as for TradingAgents.
- Output: the dossier (default `private/research/hedgefund/<TICKER>-<date>.json`, git-ignored) holds per persona `signal` (`bullish`, `neutral`, `bearish`), `confidence` (0-1), `reasoning`, `key_metrics` (cited context keys and values), `risks`, `missing_evidence` and a `citation_check` (cited metrics, and how many are key names in the context); plus the committee summary computed locally: votes, majority signal (or `split`), agreement, mean confidence and `net_score` = mean of signal (+1, 0, -1) times confidence. The net score maps to the five-tier rating: buy at 0.5 or more, overweight at 0.2 or more, hold between -0.2 and 0.2, underweight at -0.2 or less, sell at -0.5 or less, so one confident dissenter among five neutral personas stays hold. `<TICKER>-<date>.record.json` holds the `agentModelRuns.record` body (framework `ai_hedge_fund`, version `personas+<upstream commit>`, the persona names as analysts, `rating` with `ratingSource` `mapped`, flags `research_only` and `single_call`, no levels) and the `appendEvents` events (one `llm_call`, one `message` per persona, one `decision` for the committee). The command sends nothing; post it as for TradingAgents.
- Guards: the answer must name the requested ticker and each requested persona exactly once and match the typed contract; an order-like key at any depth fails the run. A failed run writes no dossier, only a `failed` record payload (no rating) with the model call events, and exits 1. Bad input exits 2.

Tests: `services/research/tests/test_hedgefund_committee.py` (fake `omp`, no network or model).
