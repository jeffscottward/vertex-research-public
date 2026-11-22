# Architecture

DarkFactory is a pnpm + Turborepo workspace of small packages ("bricks"). Apps compose bricks. Bricks expose narrow `exports` maps and never import apps. External services are reached only through ports, and each port has an adapter.

## Brick map

Every workspace `package.json` declares a `brick` role. The live per-package graph, with every workspace dependency and export, is generated from those files: **[docs/generated/package-graph.md](docs/generated/package-graph.md)**. `bun run docs:check` (part of `verify:prepush` and the core CI lane) fails when that graph is stale, a package has no valid role, or a dependency breaks the role rules.

| Role | Packages | Boundary |
| --- | --- | --- |
| `app` | `apps/web`, `apps/desktop` | Composition roots: pages, route handlers, request scope; the Electron shell around the live site ([docs/desktop.md](docs/desktop.md)). No business rules. |
| `product` | `api`, `auth`, `db`, `config`, `observability`, `ui`, `state` | Contracts and services, Better Auth, Drizzle, env and capability manifest, telemetry and events, presentational UI, state machines. |
| `capability` | `email`, `analytics`, `ai` | One port, its adapters and an adapter-id registry (`./adapters`). Depends on no other brick. |
| `agent-sdlc` | `apps/operator`, `packages/operator`, `packages/jobs` | The opt-in operator plane ([docs/operator.md](docs/operator.md)). Nothing in the product depends on it. |
| `tooling` | `testkit` | Isolated Postgres databases for tests. |
| `workspace` | root `package.json` | Scripts and shared dev tooling. |

Role rules, enforced by `ALLOWED_BRICK_DEPENDENCIES` in `scripts/docs/docs.ts`:

- Nothing depends on an app, so an app can be deleted or replaced alone.
- Capability bricks depend only on tooling. `config` imports their adapter-id registries to build its env and manifest enums, so removing a capability also means removing its enum and env keys from `packages/config`.
- Product bricks never depend on the agent plane, so `apps/operator`, `packages/operator` and `packages/jobs` can be deleted together.

Other boundary rules:

- Server-only code sits behind a `./server` or `./server/<name>` export. Its `browser` condition resolves to an `unsupported` stub that throws, so a server module cannot be bundled into client code by accident. In `apps/web/src/components/**`, Biome also fails an import of `@darkfactory/api/server`, `@darkfactory/db/server`, any `@darkfactory/*/server/<name>` subpath or a relative `packages/*/src/server` path (`style/noRestrictedImports` in `biome.jsonc`, tested by `scripts/ci/lint-boundary.test.ts`). UI components reach orders and risk only through API routes.
- Vendor SDKs are imported only in adapter files (`resend` in `packages/email/src/server/`, OpenTelemetry exporters in `packages/observability/src/server/otel.ts`); `pg` only in `packages/db` and `packages/testkit`. PostHog and Groq adapters call their HTTP APIs with an injectable `fetch`.

## Request flow

Each database-backed Worker request (auth, strict sign-out and oRPC routes) opens exactly one request scope. The scope parses the environment, resolves the request id, opens one database client (directly or through Hyperdrive), and builds the email port and the auth instance. When the response is ready it schedules cleanup with `waitUntil`. Server-rendered pages call the auth and oRPC handlers in-process (`apps/web/src/lib/server-internal-dispatch.ts`), so they go through the same scope and contracts as browser calls and share the page's request id.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant R as vinext RSC page or route handler
  participant S as Request scope<br/>apps/web/src/server/request-scope.ts
  participant C as oRPC contract + router<br/>packages/api
  participant V as Service<br/>packages/api/src/server
  participant P as Port<br/>(repository, EmailPort, AnalyticsPort)
  participant A as Adapter<br/>(Drizzle, Resend, PostHog)
  participant X as Postgres / Hyperdrive / providers

  B->>R: HTTPS request
  R->>S: withRequestScope(request, waitUntil, run)
  S->>S: parseServerEnv, request id, evlog sink
  S->>X: open one pg client (capacity-capped)
  S->>C: run handler with scope (db, auth, email)
  C->>C: validate input with Zod contract
  C->>V: call service with typed context
  V->>P: call port
  P->>A: adapter implementation
  A->>X: SQL or provider API call
  X-->>A: result
  A-->>V: typed result or typed error
  V-->>C: output or error with stable code
  C-->>S: Response
  S-->>R: Response + x-request-id
  S--)X: finalize (close client) via waitUntil
  R-->>B: HTML, JSON or 503 DATABASE_CAPACITY
```

## SDLC agent graph

Each role hands the next one an artifact (the edge labels). Security and scalability review the code beside qa; CI lanes and security scans run side by side as PR gates. Any agent harness can follow this; the opt-in operator plane can run it with approvals. Role playbooks are in [`.agents/skills/`](.agents/skills/) (linked from [AGENTS.md](AGENTS.md#agent-roles)).

```mermaid
flowchart LR
  pm["📋 pm"] -->|"plan + acceptance tests"| arch["🏛️ architect"]
  arch -->|"contract / port / ADR"| be["🧱 backend"] & fe["🖥️ frontend"]
  be & fe -->|"code + tests"| qa["🧪 qa"]
  sec["🛡️ security"] -.->|"threat review"| qa
  scale["📐 scalability"] -.->|"load review"| qa
  qa -->|"verify:prepush"| gates
  subgraph gates["PR gates, in parallel"]
    direction TB
    ci["4 CI lanes"]
    scans["CodeQL + Dependency Review"]
  end
  gates -->|"green gates"| rel["🚀 release"]
  rel -->|"changelog + exact-SHA CI"| deploy["☁️ deploy:web"]

  classDef role fill:#1f6feb,stroke:#0b3d91,color:#ffffff
  classDef reviewer fill:#8250df,stroke:#512a97,color:#ffffff
  classDef gate fill:#bf8700,stroke:#7d4e00,color:#ffffff
  classDef ship fill:#2ea44f,stroke:#1a7f37,color:#ffffff
  class pm,arch,be,fe,qa,rel role
  class sec,scale reviewer
  class ci,scans gate
  class deploy ship
```

## CI lanes

`.github/workflows/ci.yml` runs on pull requests (`opened`, `synchronize`, `reopened`, and `ready_for_review`), pushes to `vertex/rebuild-darkfactory-20260921`, the daily schedule (07:23 UTC), and manual dispatch. `scripts/ci/ci-changes.sh` always selects core. Docs-only changes and pull requests that GitHub confirms are still drafts when lanes are planned can use core-only. Code changes on pushes or non-draft pull requests select the full lane; nightly and manual runs always select full. Failed, unknown, or empty changed-file discovery defaults to code/full verification unless GitHub confirms the pull request remains a draft. If GitHub cannot confirm draft status, the planner treats the run as non-draft.

Full runs select coverage and integration; the browser lane joins when `BROWSER_TESTS` is `on` or manual input `browser_tests` is `on`. Coverage uses baseline shards plus conditional `acceptance` and `debate-five-turn` shards. The four root scripts are `verify:core`, `verify:coverage`, `verify:integration`, and `verify:browser`; only the browser script builds.

Live branch protection on `vertex/rebuild-darkfactory-20260921` requires strict `ci-gate` as its only status check, with no branch rulesets (verified 2026-11-22; see [docs/deploy.md](docs/deploy.md#branch-protection), which keeps the upstream DarkFactory `main` eight-check template separate). Inspect effective rules before each merge.

```mermaid
flowchart TB
  trigger["PR events<br/>push to live branch<br/>nightly 07:23 UTC<br/>manual dispatch"] --> planner
  planner["ci-changes.sh<br/>core always; docs/confirmed-draft PRs can be core-only;<br/>code push/non-draft PR, nightly, manual = full;<br/>unknown/empty paths = full unless draft confirmed"]
  planner --> core
  planner -- "full lane" --> cov
  planner -- "full lane" --> integ
  planner -- "full lane + BROWSER_TESTS=on or manual browser_tests=on" --> browser
  subgraph matrix["ci.yml matrix (fail-fast off)"]
    core["Verification (core)<br/>format, lint, generated artifacts, typecheck, docs"]
    cov["Verification (coverage)<br/>baseline shards + conditional acceptance/debate-five-turn<br/>merged 100% gate (legacy ratchet)"]
    integ["Verification (integration)<br/>Vitest against Postgres"]
    browser["Verification (browser)<br/>Playwright e2e + a11y projects<br/>included only when enabled"]
  end
  pg[("Postgres (Docker Compose)")]
  integ -.-> pg
  browser -.-> pg
  core --> green{"all selected verification lanes pass?"}
  cov --> green
  integ --> green
  browser --> green
  green -- yes --> merge["CI verification passed<br/>merge still requires effective live rules<br/>Vertex ci-gate (checked 2026-11-21)"]
  green -- no --> fix["fix and push"]

  scanTrigger["PR or push to main, schedule"] --> security
  subgraph security["Security workflows (job-level guards)"]
    codeql["CodeQL: public, or DF_CODEQL_ENABLED"]
    depr["Dependency Review (PRs): public, or DF_DEPENDENCY_REVIEW_ENABLED"]
    scorecard["Scorecard: public repos"]
  end

  classDef lane fill:#1f6feb,stroke:#0b3d91,color:#ffffff
  classDef sec fill:#8250df,stroke:#512a97,color:#ffffff
  classDef ok fill:#2ea44f,stroke:#1a7f37,color:#ffffff
  classDef bad fill:#cf222e,stroke:#82071e,color:#ffffff
  class core,cov,integ,browser lane
  class codeql,depr,scorecard sec
  class merge ok
  class fix bad
```

CodeQL runs on PRs and pushes to `main` and `vertex/rebuild-darkfactory-20260921`, plus weekly. Dependency Review runs on PRs to both branches. Scorecard runs on pushes to both branches, weekly, and when branch-protection rules change. None of these workflows run on manual dispatch.

## Why it is wired this way

- **Contracts are the source of truth.** An oRPC contract (`packages/api/src/contracts/*.ts`) defines input, output and error codes once. The router, typed client and `packages/api/openapi.json` all come from it, and `openapi:check` fails when the generated file drifts.
- **Headless data, separate presentation.** Contracts, services and state machines (`packages/state`) are UI-free, and `packages/ui` declares no workspace dependencies, so its components only render props. A page loads data through a contract, a view-model maps the output to plain, pre-formatted props, and a component renders only that model. The IBKR monitor is the reference: `portfolioMonitor.snapshot` is loaded by `apps/web/src/components/portal/portfolio-monitor-client.ts`, `apps/web/src/components/portal/portfolio-monitor-model.ts` turns it into formatted values, tones and a health state (unit-tested without a DOM), and `portfolio-monitor.tsx` renders the result. You can restyle UI without touching data and reuse one contract from pages and external OpenAPI clients.
- **Ports keep vendors replaceable.** Services depend on interfaces such as `EmailPort` and `AnalyticsPort`, and the app chooses the adapter from env. Swapping a provider changes an adapter, a registry entry and its env keys; features do not change ([docs/capabilities.md](docs/capabilities.md)).
- **One request scope.** One factory gives every database-backed handler the same lifecycle, capacity-error mapping and request id, instead of each handler assembling env, database, email and auth itself and drifting.
- **One connection cap, plus Hyperdrive.** A Worker opens one `pg` client per request. `REQUEST_DATABASE_POOL_MAX_CONNECTIONS` in `packages/db/src/server/client.ts` caps concurrent clients per isolate and fails fast with a 503. `openRequestScope` hands each connection's lifetime (connect to close) to the host scheduler (`waitUntil` on Workers), so a client-canceled request keeps running and releases its slot when the connection closes within the 30 s `waitUntil` limit. Hyperdrive, when enabled, pools connections at the edge without changing that code path.
- **Fail closed.** `parseServerEnv` rejects invalid or unsafe production config (local hosts, missing TLS, development secrets, preview email) before a request is served. Unsupported platforms and missing bindings throw instead of degrading silently.
- **The agent plane is optional.** Its schema, repository and runtime live in `packages/jobs` and `packages/operator`. The product builds, tests and deploys without them.
- **Gates prove behavior, not bytes.** The 100% coverage gate (with the ADR-016 legacy ratchet) plus an invariant on the measured file set replaces committed coverage totals. Generated docs are derived from source and checked, not hand-maintained. PR completion requires every effective required check for the target repository and branch. Vertex's protected branch required strict `ci-gate` as checked 2026-11-22 ([docs/deploy.md](docs/deploy.md#branch-protection)). Exact-SHA proof is only required when shipping.

## Decisions

| ID | Decision | Why |
| --- | --- | --- |
| ADR-001 | Deploy the web app only with `@vinext/cloudflare`. Alchemy may own only a real, enabled ancillary resource; there is no empty `alchemy.run.ts`. | An empty Alchemy program can delete persisted resources. Full record: [docs/adr/0001-vinext-alchemy-boundary.md](docs/adr/0001-vinext-alchemy-boundary.md) |
| ADR-002 | Author everything in strict TypeScript, with the toolchain (Node, Bun for scripts, pnpm) pinned in `mise.toml`. | One language that CodeQL, Biome and every agent harness understand; no compile-to-TypeScript step. |
| ADR-003 | All application API access goes through oRPC contracts, with generated OpenAPI. | One typed contract for pages, apps and external clients. |
| ADR-004 | Postgres through Drizzle only. No Redis, queue or second data store by default. | One source of truth; Postgres features before new infrastructure. |
| ADR-005 | Ports and adapters for every external service; SDK imports only in adapters; `unsupported` browser stubs for server exports. | Swappable providers and bundle safety. |
| ADR-006 | One request-scope factory per database-backed Worker request. | One place for capacity errors, request ids and cleanup. |
| ADR-007 | `DATABASE_PROVIDER` is `postgres`, `planetscale` or `hyperdrive`, each with its own validation profile. Hyperdrive is optional, with query caching disabled. | Provider-neutral production database; no stale session reads. |
| ADR-008 | `capabilities.yaml` is validated by one Zod loader (`packages/config/src/server/capabilities-loader.ts`) whose provider enums come from the adapter registries. `doctor` derives its probes from it. | One parser; the manifest cannot name code that does not exist. |
| ADR-009 | The operator plane is an opt-in brick. Workflow schema and repository live in `packages/jobs`; migrations 0005–0007 stay frozen in the product chain; new workflow DDL goes to `packages/jobs/migrations`. | Keeps agent tooling out of the product without destructive migrations. |
| ADR-010 | Packages without consumers are deleted; `ai` is the reference capability brick. | No dead bricks. |
| ADR-011 | CI runs on PR lifecycle events, pushes to the live Vertex branch, a nightly schedule, and manual dispatch. The planner always runs core; docs-only and pull requests confirmed to remain draft can be core-only; code pushes, non-draft code PRs, nightly, and manual runs select full. Failed, unknown, or empty path discovery defaults to code/full unless the PR is confirmed draft; unconfirmed draft status is treated as non-draft. Four verification lanes are core, coverage, integration, and conditional browser; coverage has baseline shards plus conditional acceptance/debate-five-turn shards. Vertex branch protection required strict `ci-gate` as of 2026-11-21; inspect live rules before merge. Exact-SHA evidence is required for release and deploy. | Runs current verification for pushes and scheduled maintenance while keeping lane selection explicit. |
| ADR-012 | Coverage: 100% thresholds plus a measured-file-set invariant; no committed totals. | Guards the denominator without a file that churns on every commit. |
| ADR-013 | E2E uses Playwright built-ins: `webServer` (portless proxy + production app), `globalSetup` (migrate and seed), `e2e` and `a11y` projects, SPKI-pinned CA trust, `retries: 1` with `failOnFlakyTests` in CI. | No custom harness to maintain; no TLS bypass. |
| ADR-014 | `bun run setup` is the only bootstrap, and the Zod env schema is the only env contract. | Fewer prerequisites; one fail-closed contract. |
| ADR-015 | Every workspace package declares a `brick` role; `docs:generate` derives the package graph and `docs:check` enforces role dependency rules. | Lego-brick boundaries are traceable and the architecture diagram cannot go stale. |
| ADR-016 | Coverage ratchet (owner decision 2026-10-11, reconfirmed 2026-10-16), amending ADR-012: files below 100% after the TypeScript port are listed in `scripts/ci/coverage-baseline.json` with per-file minimums that may only rise; all other files stay at 100%; an invariant test pins the thresholds to the list and the list may only shrink. CI shards the coverage run and checks thresholds once on the merged report. | Lets the port merge without lowering the bar for new code. |
| ADR-017 | Pure-move split exception to the coverage ratchet (owner decision 2026-11-11), amending ADR-016: a listed file may be split into new files, and the new files may be listed, when `bun run coverage:split-proof` proves that only side-effect-free declarations moved, token for token, into new files in the same folder; that every name, import and export of the original file resolves to the same declaration and the other modules load in the same order; that the covered and total lines, branches, functions and statements are unchanged in sum; and that the original file's minimums fall only to the values the command prints while everything else in the baseline list is unchanged. | Lets the largest legacy files be split without first raising them to 100%; no uncovered code is added and none is hidden. |
