# AI strategy builder tools and assistant confirm cards

Updated: 2026-11-02. Research and backtest use only. No tool in this flow reaches an order, broker or deployment path.

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

## Streaming turns

`assistant.send` streams one turn as oRPC events (`text/event-stream`), added 2026-11-02:

| Event | Content |
| --- | --- |
| `started` | The thread and the stored user message. Always first. |
| `text` | A piece of reply text as the model writes it. `modelCall` changes when a new model call starts after tool calls. |
| `step` | The tools one model step asked for, before they run. |
| `tool` | One finished tool call (the same trace entry the reply stores). |
| `done` | The stored reply, trace, stop reason, budget use and confirm cards. Always last on success. |

- The checks before a turn (model key, thread owner, daily budget) still return a normal error response. A failure during the turn ends the stream with the same typed error (`UPSTREAM_ERROR`, `BUDGET_EXCEEDED`, `STORAGE_ERROR`).
- The OpenRouter call uses `stream: true`. A provider answer with one JSON body still works; its text arrives as one piece.
- The turn runs as a tracked request-scope task, so the database connection stays open until the reply is stored, also when the browser leaves.
- **Stop** closes the stream. The server aborts a running OpenRouter call at once (the upstream request and the stream read), keeps the reply text and token counts received so far (when the provider sent no counts, about 4 characters per token are recorded against the budget), runs none of the tools that call asked for and makes no further model call (also no step-cap summary). A tool already running finishes; the other tool calls of that step do not run. The stored reply is the partial text followed by "Stopped by the operator after N tool steps", and the stop reason is `stopped`.
- Confirm cards and budget rules do not change: cards are stored with the reply and show only after `done`.

## Side panel and page context

Every portal page except `/assistant` has an assistant side panel, added 2026-11-03. It is a right column from 1024px and a bottom sheet below that. It uses the same chat as `/assistant` (the `panel` layout of `AssistantWorkspace`), with the same tools, modes, confirm cards and Stop.

- `assistant.send` takes an optional `page` (`path` and `title`; the path allows only `/`, letters, digits, `_`, `.` and `-`, at most 200 characters). The panel sends the page the operator is on. The server adds one line to the system prompt naming that page, with control characters and double quotes removed from the title. The page name is context, never an instruction. It adds no tool and changes no filter.
- The panel is offered only to sessions that can open `/assistant`. The open state is saved in the `vx.assistantPanel` cookie (`open` or `closed`, one year), which the portal layout reads so the server renders the saved state. Without a saved choice the panel is closed on every screen size; only the operator's click opens it and writes the cookie, so nothing moves after the page is painted.
- Below 1024px the open panel is a modal bottom sheet (`role="dialog"`, named "Assistant panel"): focus moves to its close button, Tab stays inside, and Escape, the backdrop and the close button close it and return focus to the control that opened it. From 1024px it is a complementary column.
- The chat mounts on the first open and then stays mounted while the panel is closed and across client navigation, so a streaming reply and the open thread are kept.

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
| Side panel (dock, open state, page context) | `apps/web/src/components/portal/assistant-panel.tsx` |

## Tests

- Contract and service: `packages/api/src/strategy-definitions.test.ts`.
- Registry, sweep limit and import guard: `packages/api/src/server/research-tools.test.ts`.
- Proposals, approve and reject flow, owner scope, history lines: `packages/api/src/assistant.test.ts`.
- Repositories and migration: `packages/db/src/server/strategy-definitions.test.ts`, `packages/db/src/server/assistant-actions.test.ts`, `tests/integration/database/ai-builder.test.ts`.
- Confirm card UI: `apps/web/src/components/portal/assistant-workspace.test.tsx`.
- Side panel: `apps/web/src/components/portal/assistant-panel.test.tsx` (dock) and the panel layout tests in `assistant-workspace.test.tsx`; page context in the prompt: `packages/api/src/assistant.test.ts`.
- Headless dark browser flow (approve one card, reject one card, reload): `tests/e2e/assistant-confirm-cards.spec.ts`.
- Chat layout and Stop at 375x812 and 1440x900 (Stop and the composer stay in the viewport during a long streamed reply; Stop ends it): `tests/e2e/assistant-stop-layout.spec.ts`. Written for the browser lane; not run locally.

## Limits

- An action left in `running` (for example after a server restart during the call) stays `running`; it is not retried.
- The existing record-keeping write tools (tasks, papers, strategies, presets) still run inside a turn in Act mode, as before.
- The strategy builder page does not save revisions yet; saving goes through the assistant, MCP or the API.
