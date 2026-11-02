# AI strategy builder tools and assistant confirm cards

Updated: 2026-10-23. Research and backtest use only. No tool in this flow reaches an order, broker or deployment path.

## Purpose

The research assistant on `/assistant` and MCP agents can build and test strategies with these tools:

1. Create or edit a strategy definition (see [strategy-definitions.md](strategy-definitions.md)): validate it and save it as a revision.
2. Run a backtest run of a rule or a definition (see [backtest-runs.md](backtest-runs.md)).
3. Run a parameter sweep with a bounded grid (see [backtest-sweeps.md](backtest-sweeps.md)).
4. Read the forward drift status (see [forward-drift.md](forward-drift.md)).

In the assistant, a tool that saves data or starts compute never runs inside a turn. The assistant proposes it, and the portal shows a confirm card. The tool runs only after the operator selects **Approve and run** on that card. Read tools run at once.

## Tools

| Tool | Procedure | Kind | In the assistant |
| --- | --- | --- | --- |
| `strategy_definition_validate` | `backtestRuns.definitions.validate` | Read | Plan and Act, runs at once |
| `strategy_definitions_list` | `backtestRuns.definitions.list` | Read | Plan and Act, runs at once |
| `strategy_definitions_get` | `backtestRuns.definitions.get` | Read | Plan and Act, runs at once |
| `strategy_definition_save` | `backtestRuns.definitions.save` | Write | Act only, confirm card (not on the MCP endpoint) |
| `backtest_runs_submit` | `backtestRuns.submit` | Write | Act only, confirm card |
| `backtest_runs_sweep` | `backtestRuns.sweep` | Compute | Act only, confirm card, at most 100 cells |
| `drift_status` | `backtestRuns.drift.list` | Read | Plan and Act, runs at once |
| `drift_monitor_get` | `backtestRuns.drift.get` | Read | Plan and Act, runs at once (series omitted) |

MCP agents get the read tools from `/api/mcp`. `strategy_definition_save` is assistant-only (`ASSISTANT_ONLY_TOOLS`): the MCP endpoint does not list it and refuses a call to it, so a definition revision is never saved without an operator approval. `backtest_runs_submit` and `backtest_runs_sweep` were MCP tools before this work and stay available to write keys (sweep: read keys too); the API key decides that access. The oRPC procedure `backtestRuns.definitions.save` needs an operator session and refuses every agent API key, so an agent can save a definition only through a confirm card the operator approves.

## Saved definitions (revisions)

`backtestRuns.definitions.save` stores append-only revisions in the table `strategy_definition_revisions` (migration `0029_ai_builder`, guarded rollback).

- Without `id`, it starts a new definition at revision 1.
- With `id`, it stores the next revision. When the definition is equal to the latest revision (same SHA-256 of the canonical JSON, defaults applied), it stores nothing and returns `created: false`.
- The SHA-256 is the same content hash a definition backtest run uses for its snapshot id (`dsl:<first 16 hex characters>`).
- Saving needs an operator session; agent API keys are refused.
- Two saves of the same definition at the same time: one gets the revision, the other gets `CONFLICT` and saves again.

## Confirm cards

| Step | What happens |
| --- | --- |
| Turn | The model calls a confirm tool. The runtime checks the arguments against the tool's input schema and the assistant limits. A valid call becomes a proposal; an invalid one returns an error to the model. Nothing runs. |
| Store | After the reply is stored, each proposal is stored in `assistant_actions` with status `pending`, linked to the reply, the thread and the owner. A failed turn stores its proposals on the "No reply" message. |
| Show | The reply shows one card per proposal: a title, a one-line summary, the arguments, and **Approve and run** and **Reject** buttons. |
| Approve | `assistant.actions.decide` with `approve` moves the card from `pending` to `running` (a conditional update for the owner only), checks the arguments again, calls the tool with the operator's session, and stores `executed` with the result text or `failed` with the error. |
| Reject | `decide` with `reject` moves the card to `rejected`. The tool never runs. |
| Later turns | The model sees each earlier card as one line after its reply: the status and, after a run, the start of the result marked as untrusted data. |

A card is decided at most once. A second decision, or a decision by another user, returns `CONFLICT`. Agent API keys cannot call `assistant.*`.

Limits per turn: at most 4 confirm cards. A sweep proposed by the assistant may have at most 100 cells (`ASSISTANT_SWEEP_MAX_CELLS`); the API itself allows 1,000.

## Safety

- The registry `packages/api/src/server/research-tools.ts` imports only contract schemas, the strategy format and the sweep grid helpers. The guard test `research-tools.test.ts` walks its runtime import graph and fails on any module whose path names an order, broker, IBKR, deployment, worker, execution, gateway, QuantVPS, portfolio monitor or paper forward module. It also checks that every registry and confirm tool reaches only a `backtestRuns/*` procedure and never a drift write.
- Confirm tools are allowed by exact name. A narrower pattern still refuses any procedure that names an order, broker, IBKR, deployment, approval, API key, worker or assistant path.
- Results and arguments are research data. A backtest, sweep or model output never authorizes trading.
- Logs carry metadata only: tool name, status and duration.

## Parts

| Part | File |
| --- | --- |
| Definition contract and service | `packages/api/src/contracts/strategy-definitions.ts`, `packages/api/src/server/strategy-definitions.ts` |
| Research tool registry and confirm policy | `packages/api/src/server/research-tools.ts` |
| Assistant runtime (proposals, `runConfirmedAction`) | `packages/api/src/server/assistant-runtime.ts` |
| Assistant procedures (`assistant.actions.decide`) | `packages/api/src/contracts/assistant.ts`, `packages/api/src/server/assistant.ts` |
| Tables and repositories | `packages/db/src/schema/index.ts`, `packages/db/src/server/strategy-definitions.ts`, `packages/db/src/server/assistant-actions.ts` |
| Confirm card UI | `apps/web/src/components/portal/assistant-workspace.tsx` |

## Tests

- Contract and service: `packages/api/src/strategy-definitions.test.ts`.
- Registry, sweep limit and import guard: `packages/api/src/server/research-tools.test.ts`.
- Proposals, approve and reject flow, owner scope, history lines: `packages/api/src/assistant.test.ts`.
- Repositories and migration: `packages/db/src/server/strategy-definitions.test.ts`, `packages/db/src/server/assistant-actions.test.ts`, `tests/integration/database/ai-builder.test.ts`.
- Confirm card UI: `apps/web/src/components/portal/assistant-workspace.test.tsx`.
- Headless dark browser flow (approve one card, reject one card, reload): `tests/e2e/assistant-confirm-cards.spec.ts`.

## Limits

- An action left in `running` (for example after a server restart during the call) stays `running`; it is not retried.
- The existing record-keeping write tools (tasks, papers, strategies, presets) still run inside a turn in Act mode, as before.
- The strategy builder page does not save revisions yet; saving goes through the assistant, MCP or the API.
