# Portal input audit (2026-10-30)

## Rule

Owner rule (2026-10-30, FIRSTMATE msg 1565822690831499264): no portal page may require the owner to type an ID or scope to see its content. Record pages list what exists. Inputs stay only where a person really sets something: backtest and optimization parameters, strategy configuration, a stock ticker, order or deployment forms, and settings.

Owner decisions (FIRSTMATE msg 1565826397111328873): remove the exact-ID research lookups now, drop the Data & evidence page with a redirect, and delete code and endpoints that become unused.

## Method

- Tool: `tests/e2e/portal-inputs.spec.ts` (Playwright, headless Chromium). It signs in as the seeded operator (`admin@domain.test`), opens every route in `ADMIN_PORTAL_ROUTE_PATHS` at 1440 x 900 and 375 x 812, and records every `input`, `textarea` and `select` inside `main`.
- With `E2E_INPUT_AUDIT_DIR` set, the spec also saves a full-page screenshot per route and a JSON inventory per width.
- Before: commit `3cf89122` (base of `ws/no-id-inputs`), test database without Vertex grants.
- After: branch `ws/no-id-inputs`, test database with two fictional account-scope read grants (`e2e-research-scope` / research, `e2e-paper-scope` / paper) seeded by the spec.
- Fields that render only after a scope is chosen (Research lookups, research chat tools) were also checked in code, because the before database had no scope to choose.

## Results by route

Decision key: KEEP = a person sets a real value. REPLACE = lookup replaced by a list. DROP = removed (no list exists or the page has no content).

|Route|Text fields before|Purpose|Decision|After|
|---|---|---|---|---|
|`/today`|Account alias, Environment|Scope form before the decision inbox|REPLACE|Granted scopes listed; first scope selected; inbox shows by default|
|`/strategies`|Account alias, Environment|Scope form before the strategy catalog|REPLACE|Same scope chooser; catalog shows by default|
|`/audit`|Account alias, Environment|Scope form before the execution audit|REPLACE|Same scope chooser; audit shows by default|
|`/modules`|Account alias, Environment|Scope form before the module catalog|REPLACE|Same scope chooser; catalog shows by default|
|`/portfolio` (Observations tab)|Portfolio account scope|Scope form before portfolio observations|REPLACE|Same scope chooser|
|`/research`|Account alias (x3), Dataset collection ID|Scope forms for chat, sources and charts|REPLACE (chat scope), DROP (rest)|Chat opens on the first granted research scope; Sources and Source charts sections removed|
|`/research` (after a scope)|Authorized collection ID, Exact evidence IDs|Research-job form|DROP|Form removed; the chat is the research entry point|
|`/research` (after a scope)|Dataset ID; Collection ID + Evidence ID|Dataset and evidence lookups|DROP|Removed; Vertex has no dataset or evidence list|
|`/research` (after a scope)|Dataset ID, Collection ID, Instrument ID, Source ID|Dataset chart snapshot lookup|DROP|Removed with the unused chart studio code|
|`/research` chat (First Mate threads)|Collection ID + Evidence ID; Backtest collection ID|Private evidence lookup; chat backtest|DROP|Both panels removed|
|`/data`|Dataset collection ID, Account alias; after a scope Dataset ID, Collection ID, Evidence ID|Dataset and evidence lookups|DROP page|Removed from the sidebar; `/data` redirects to `/research`|
|`/connections`|Gateway identity, Environment|Exact gateway status lookup|REPLACE|Table of observable gateways (`vertex.experience.gateways`); first gateway status read by default; row button reads another|
|`/papers`|arXiv ID or URL; Paper title, Paper URL|Add a paper to the library|KEEP|Unchanged; papers list below the form|
|`/agents`|New task agent, title, summary; API key name|Create a task; name a new API key|KEEP|Unchanged; runs and keys are listed|
|`/library`|Strategy name, description, section; Search strategies|Add a library entry; filter the list|KEEP|Unchanged|
|`/assistant`|Message|Chat message|KEEP|Unchanged|
|`/academy`|Search|Filter lessons|KEEP|Unchanged|
|`/backtest-runs`, `/backtest-sweeps`, `/strategy-builder`|Averages, stops, costs, capital, dates, dimensions, strategy name, definition|Backtest and strategy parameters|KEEP|Unchanged|
|`/portfolio-combos`|Shared deposit|Simulation parameter|KEEP|Unchanged|
|`/deep-value`|Score any ticker|Stock ticker|KEEP|Unchanged|
|`/risk-allocator`|Symbol, premium, NLV, dates, open premium|Position sizing inputs|KEEP|Unchanged|
|`/charts`|Symbol, Exchange, Currency|Stock ticker and market|KEEP|Unchanged|
|`/watchlist`|Symbols to add|Stock tickers|KEEP|Unchanged|
|`/todos`|Title, Note, Due date, Tags, Source URL|Create a todo|KEEP|Unchanged|
|`/settings/*`|Profile, password and appearance fields; Search users|Settings|KEEP|Unchanged|

Routes with no text field before or after: `/dashboard`, `/backtests`, `/instant-backtest`, `/forward-drift`, `/rotation-matrix`, `/optimizations`, `/deployments`, `/settings/account/address`, `/settings/workspace`.

The research chat still has the "Exact literal retrieval query" field and the transcript range numbers for debate steps. A person writes these values; they are not record lookups, so they stay (KEEP).

## Dropped page

`/data` (Data & evidence) had only the dataset and evidence ID lookups. After their removal the page had no content, so it was dropped (owner decision). The route now redirects to `/research`, so old links do not end at a 404.

## Code and endpoint removal

Removed because nothing else used them after the lookups were gone:

- oRPC procedures: `vertex.experience.acceptedEvidence`, `prepareBacktest`, `backtestStatus`, `backtestResult`; `vertex.datasets.get`, `vertex.evidence.get`; `vertex.scoped.dataset`, `vertex.scoped.evidence`, `vertex.scoped.snapshot`.
- Web: the scope form (`ScopePicker`), the dataset, evidence and chart lookups, the research-job form, the chat evidence and backtest panels, and the unmounted dataset chart studio (`features/charts` workspace, panels, TanStack adapter, fallback plots, annotations, display, stream model).

Kept: `vertex.scoped.modules` and `vertex.modules.list` (Modules page), the worker `acceptedEvidence` procedures (Python control client), and `vertex.experience.proposeResearch` as an API for agents and clients (no page calls it after the research-job form was removed).

Added: `vertex.experience.gateways` (list of observable broker gateways). The existing `vertex.experience.scopes` read now feeds the scope chooser.

## Guard

`tests/e2e/portal-inputs.spec.ts` fails when any portal route renders a text field whose label, name or placeholder asks for an ID, identifier, UUID, alias or scope, unless the route and label are in its `KEEP` list. The only `KEEP` entry is `/papers` "arXiv ID or URL" (adds a paper). It runs in the browser lane of CI.

## Screenshots

Full-page screenshots (WebP) are in [`ui-input-audit-20261030/`](ui-input-audit-20261030/), named `<route>-<width>-before.webp` and `<route>-<width>-after.webp`, for `today`, `strategies`, `audit`, `modules`, `research` and `connections` at 1440 and 375 px. `data` has only "before" screenshots, because `/data` now redirects to `/research`.

In the "after" screenshots the scoped pages select `e2e-paper-scope` and show "Access not granted": the seeded grants cover only the account scope, not the records behind it. The scope is chosen without typing, which is what this change proves. Research selects the research scope and opens the chat room.
