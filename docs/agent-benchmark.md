# Agent model benchmark

Updated: 2026-11-01. Research only. Agent ratings never place orders.

## Purpose

Run several models or agent frameworks on the same tickers and decision dates, record every run in Vertex, and compare them on `/agents/benchmark`: coverage, rating mix, how often reruns agree, agreement with a baseline model, cost, and a paired comparison of directional hits.

A rating (buy, overweight, hold, underweight, sell) is a research label. A benchmark never authorizes, creates or sizes an order.

The agreement formulas and the sign test come from Glassbench (Apache-2.0, commit 255414b); see [NOTICE](../NOTICE).

## Parts

| Part | File |
| --- | --- |
| Framework port `AgentFrameworkPort`, `RunEventSink`, `RunRecorder` | `services/research/agents/ports.py` |
| Framework types (request, result, usage, events) | `services/research/agents/framework_types.py` |
| Bench command `python -m agents.framework_bench` | `services/research/agents/framework_bench.py` |
| Run recorder over HTTP (`agentModelRuns.record`, `.update`, `.appendEvents`, `.list`) | `services/research/adapters/vertex_run_recorder.py` |
| Hosted model prices | `services/research/adapters/model_pricing.py` |
| oRPC `agentModelRuns.benchmark`, MCP `model_runs_benchmark` | `packages/api/src/contracts/agent-model-runs.ts`, `packages/api/src/server/agent-model-runs.ts` |
| Benchmark computation (pure) | `packages/api/src/agent-model-benchmark.ts` |
| Page `/agents/benchmark` | `apps/web/src/components/portal/agent-model-benchmark-workspace.tsx` |
| Framework reference sheets (oRPC `agentModelRuns.frameworks`, Frameworks section of the page) | `packages/api/src/agent-frameworks.ts`, `apps/web/src/components/portal/agent-frameworks-section.tsx` |
| Vibe-Trading adapter, driver and setup script | `services/research/adapters/vibe_trading_framework.py`, `services/vibe-trading/`, `scripts/vibe-trading-setup.sh` |

## Run a benchmark

The bench runs from `services/research` with a Python that has the research dependencies (`pydantic`). It records each run in Vertex with an operator's agent API key that can write (see [agent-model-runs.md](vertex-rebuild/agent-model-runs.md#access)).

```sh
cd services/research
export VERTEX_API_URL=https://vertex.example.com   # http only for a loopback host
export VERTEX_AGENT_API_KEY=...                     # write key; never printed or logged
python -m agents.framework_bench \
  --batch bench-2026-11 \
  --tickers AAPL,MSFT,NVDA \
  --weekly 2026-09-01..2026-09-30 \
  --arm <framework>:openai:gpt-4o-mini \
  --arm <framework>:llamacpp:qwen3-30b:http://127.0.0.1:8080/v1 \
  --reruns 2 --budget-usd 5 --dry-run
```

Options:

| Option | Meaning |
| --- | --- |
| `--batch` | Groups the runs (1-64 letters, digits, `.`, `_`, `:` or `-`). Choose it on the page. |
| `--tickers` | Comma separated tickers. |
| `--dates` or `--weekly FROM..TO` | Explicit decision dates, or the last trading day of each ISO week. `--calendar FILE` gives the trading days (one `YYYY-MM-DD` per line); without it, Monday to Friday count. |
| `--arm framework:provider:model[:base_url[#KEY_ENV]]` | One arm per option. The model may contain `:` (for example `qwen3:30b`). A `base_url` points at an OpenAI-compatible server and gets no key; an https base URL may name the variable that holds its key after `#` (for example `:https://models.example.com/v1#MODELS_API_KEY`). A framework may support only some hosted providers; the bench refuses other providers without a base URL before it starts. |
| `--reruns` | Runs per cell and arm (1-10). Reruns show how stable a model is. |
| `--budget-usd` | Hard cost cap. |
| `--variant`, `--analysts`, `--data-source` | Recorded with each run. |
| `--parallel` | Runs at the same time (1-4, default 1). |
| `--est-input-tokens`, `--est-output-tokens` | Tokens per run for the cost estimate (default 300000 and 30000). Set them from a pilot run. |
| `--price provider:model=IN/OUT` | USD per 1M tokens; adds to or overrides the price table. |
| `--unknown-cost-usd` | Estimate per run for a hosted model without a price. Without it, such an arm is refused. |
| `--dry-run` | Prints the plan and the estimated cost. Calls no model and nothing in Vertex. |

Rules:

- **Budget.** A run starts only when the spent cost plus the estimates of the runs in progress plus its own estimate stay within `--budget-usd`. The rest of the plan is skipped and counted. A run whose model has no price is charged its estimate.
- **Cost.** The framework's own cost wins. Otherwise the bench prices the tokens with `adapters/model_pricing.py` (list prices as of 2026-11-01; check the provider before a large run). A model on a local or private base URL costs 0 and gets the flag `local_model`; the page labels its arm "local". An unknown hosted model records no cost and the flag `cost_unknown`.
- **Reuse.** Before a cell runs, the bench asks Vertex (`agentModelRuns.list`) for finished runs with the same batch, ticker, date, framework, provider, model, variant (also when it has none) and base URL, and runs only the missing reruns. A run with a base URL carries the flag `base_url_<8 hex digits of the URL's SHA-256>`, and the arm name ends in `:u<same digits>`, so two servers that serve the same model are two arms. Run keys are fixed (`batch:framework:provider:model:…:ticker:date:rN`), so a repeated command reuses a finished run and leaves a run that another bench is running alone.
- **Failures.** A failed run is retried once under its own key (flag `retry`), if the budget allows. A failed run has no rating and is never counted as hold.
- **Recorder errors.** A run that Vertex cannot record, or whose status or result cannot be stored after 2 more tries (5xx or transport errors only), counts as failed; its budget estimate is always released, and the bench goes on. The recorder refuses HTTP redirects, because they would carry the API key to another address: set `VERTEX_API_URL` to the final URL. If Vertex cannot be reached for the reuse check, the command stops with exit code 2 and the error, before any run starts.
- **Memory.** Framework memory is off in a benchmark (flag `memory_off`).
- **Events.** Framework events stream to `agentModelRuns.appendEvents` in batches of at most 200 (at most 5000 per run), in seq order even when several agents emit at once. A batch that meets a 5xx or transport error is sent again up to 2 times; a 4xx is not retried. A batch lost after that adds the flag `events_dropped`; it never stops a run.
- **Stop.** Ctrl-C asks the running framework to stop; that run is recorded as cancelled and no new run starts.

The command prints one line per run and a JSON summary (`planned`, `reused`, `succeeded`, `failed`, `retried`, `busy`, `skippedBudget`, `cancelled`, `spentUsd`).

### Frameworks

A framework is an adapter that implements `AgentFrameworkPort` (`describe()` and `run(request, sink, cancellation)`) and is registered in `FRAMEWORK_FACTORIES` in `framework_bench.py`. This checkout registers `vibe_trading`. An arm whose framework is not registered is refused at run time; `--dry-run` still prints the plan and marks it "framework not available here". An adapter starts its framework with read-only tools only, passes only the key that the endpoint names (`api_key_env`), honours the timeout and cancellation, and maps a missing rating to `rating_source: missing`.

The Frameworks section of `/agents/benchmark` (oRPC `agentModelRuns.frameworks`, read keys allowed) shows a reference sheet for each framework: TradingAgents as the re-implemented Vertex research desks, the AI Hedge Fund event-study statistics, Vibe-Trading and the LangAlpha trade pitch structure, with their stages, data and point-in-time notes, tools and links. The LangAlpha sheet has no bench name: only the structure of its trade-pitch skills is adapted, in the paper agent desk's pitch agent (`scripts/agent-desk/pitch.ts`, see [vertex-rebuild/agent-desk.md](vertex-rebuild/agent-desk.md)). LangAlpha is not a benchmark framework here, because it needs PostgreSQL, Redis and a container sandbox, has no one-ticker rated run, and its Claude subscription route presents itself as the Claude Code client.

### Vibe-Trading

[Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) (MIT) v0.1.18 runs unmodified in its own clone and virtual environment, outside this repository. Set it up once:

```sh
scripts/vibe-trading-setup.sh                      # clones v0.1.18 into ~/Github/tools/vibe-trading
export VERTEX_VT_DIR=~/Github/tools/vibe-trading
```

The script checks that the tag is commit `66eb57634f16344b326d85fd1fe10029c7f348bb`, refuses a clone with local changes or untracked files, installs upstream's hash-locked requirements (`--require-hashes`) into `$VERTEX_VT_DIR/.venv`, installs the package itself without build isolation using a hash-pinned setuptools as its build backend (so nothing unpinned is downloaded), rebuilds the venv when the pinned commit changes, and prints the version. Then use arms such as `vibe_trading:deepseek:deepseek-chat` (key `DEEPSEEK_API_KEY`) or `vibe_trading:llamacpp:qwen3-30b:http://127.0.0.1:8080/v1`. Hosted providers are `openai`, `deepseek`, `openrouter` and `anthropic` (the bench refuses others before it starts); any OpenAI-compatible base URL also works, and an https one may name its key variable (`:https://host/v1#KEY_ENV`).

| Setting | Meaning |
| --- | --- |
| `VERTEX_VT_DIR` | The clone. Without it, a `vibe_trading` arm is refused. |
| `VERTEX_VT_MODE` | `committee` (default): Vibe-Trading's investment committee preset (bull and bear researchers in parallel, a chief risk officer, then a portfolio manager). `single`: one research agent on a fixed prompt. |
| `VERTEX_VT_DRIVER` | Another driver file (tests only). |

How a run is held to research:

- **Read-only tools.** Every agent gets only read-only data tools plus `quantlib_call` and `options_payoff` (pure computation). Shell, file, backtest, factor analysis, memory, swarm, scheduler, `trading_*` and `etoro_*` tools never reach a registry, and each tool call is checked again. The driver reports its raw tool registry (`--describe`) and each agent's granted tools; the adapter applies its own copy of the list, refuses a driver whose allowlist leaves it, and stops a run whose grant leaves it (flag `tool_policy`). **No shell**: Vibe-Trading's preset prompts ask for bash; the driver tells each agent to compute with `quantlib_call` instead.
- **Keys.** The driver gets only basic variables (PATH, locale, proxy and certificate settings) and the key the endpoint names. It removes tracing settings (LangSmith), keeps only the chosen provider's key and runs with `HOME` and `VIBE_TRADING_HOME` in a temporary folder. A clone with `agent/.env` is refused.
- **Point in time.** Vibe-Trading has no date input: its tools return current data. A run whose decision date is before today gets the flag `not_point_in_time`; treat such runs as a check of the method, not as a historical test.
- **Rating.** The portfolio manager (or the single agent) ends with a JSON block. The adapter reads the last one: a rating outside the five tiers maps the action (long to overweight, short to underweight, wait or hedge to hold, `ratingSource: mapped`); with neither the run has no rating (flag `no_rating`). Figures that Vibe-Trading's grounding check withheld as `(omitted※)` read as null and set `numbers_withheld`. A run past its timeout is stopped with the flag `worker_timeout`.
- **Version.** Runs record `vibe-trading-ai <package version>+<short commit>`.

The bench passes `--timeout-s` to the driver. A committee on a local server is slow (one agent at a time, replies capped at 4096 tokens, at most 10 steps per agent); allow an hour or more per run.

### Local models on the rig GPU

Any server with an OpenAI-compatible `/v1` endpoint works: llama.cpp `llama-server`, Ollama, LM Studio or vLLM. For example:

```sh
llama-server -m <model>.gguf --alias qwen3-30b -c 49152 -np 1 --jinja --port 8080
# arm: <framework>:llamacpp:qwen3-30b:http://127.0.0.1:8080/v1
ollama serve   # arm: <framework>:ollama:qwen3:30b:http://127.0.0.1:11434/v1
```

The rig GPU (RTX 3080 Ti, 12 GB) is shared with the transcription service. Start a local model only when `nvidia-smi` shows enough free memory beyond the transcription headroom, and stop it after the benchmark. Never lower the transcription headroom gate to fit a model. Neither llama.cpp nor Ollama is installed by this repository.

## Read the results

`/agents/benchmark` (operators only, under Agents & Automation) and `agentModelRuns.benchmark` read up to 5000 runs that match the filters (batch, decision dates, framework, provider, model, served model, ticker, purpose, variant, flags) and group them into arms by model, served model, provider and model, framework or variant. A cell is one (ticker, decision date).

| Measure | Definition |
| --- | --- |
| Runs, finished, failed, rated, unrated | Finished means `succeeded`. Rated: finished with a rating. Unrated: finished without one (`ratingSource: missing`). |
| Cells (rated) | Cells with any run of the arm, and cells with a rated run. |
| Modal rating | The most frequent rating of the arm's finished runs in a cell. A tie goes to the rating nearest hold, then to the more bullish one. |
| Reruns agree | Among cells with 2 or more rated runs: the share where all runs agree. The tooltip gives the mean share of the modal rating. |
| Buy or sell | Share of rated runs at the extremes (buy or sell). |
| Rating mix | Count of each rating among rated runs. |
| Match rate (baseline) | Share of shared cells where the arm's modal rating is one of the baseline arm's ratings for that cell. |
| Mean closest distance | Mean over shared cells of the smallest step between the arm's modal rating and a baseline rating on the scale buy=0 to sell=4. |
| Agreement matrix | For each pair of the 12 largest arms: the share of shared cells where the modal ratings are equal, with the cell count. |
| Cost, tokens, calls, median time | Totals and medians that the runs reported. |

**Paired comparison.** Choose a control and a treatment arm. On cells where both finished, the page counts how many cells changed the modal rating. For a directional hit it reads the imported daily bars (`vertex:bars:import`): the return from the close of the last bar on or before the decision date to the close 5 bars later. Buy and overweight call up, underweight and sell call down; the call hits when the sign of the return matches. Cells where an arm holds or has no rating, and cells without bars or without 5 later bars, are left out and counted. Bars load for at most 50 tickers, the first 50 in alphabetical order; the page names the tickers past that cap apart from the tickers without bars. A win is a cell where only the treatment hit; a loss, only the control. The exact two-sided sign test gives p = min(1, 2 · Σ_{i≤k} C(m, i) / 2^m) with m = wins + losses and k = min(wins, losses). A directional hit is a research measure, not a trading result.

To test one model's ratings against shuffled ratings, record them as a rating series on a backtest and open its Placebo tab on `/backtests` ([backtest-statistics.md](backtest-statistics.md)).

## Tests

```sh
cd services/research
python -m pytest tests/test_framework_bench.py tests/test_vertex_run_recorder.py tests/test_vibe_trading_framework.py
cd ../vibe-trading
python -m pytest
```

The tests use a fake framework, a fake recorder and a fake Vibe-Trading driver; they need no network, no model and no Vibe-Trading install. The two smoke tests that run the real driver (`--describe` only, no model call) are skipped unless `VERTEX_VT_DIR` is set. CI does not run the Python suites. The TypeScript side is covered by `packages/api/src/agent-model-benchmark.test.ts`, `agent-frameworks.test.ts`, `agent-model-runs.test.ts` and the page tests.
