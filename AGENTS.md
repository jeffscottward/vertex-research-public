# AGENTS.md

The index for every agent and contributor. `CLAUDE.md` is a symlink to this file. It takes precedence over every other Markdown file; [ARCHITECTURE.md](ARCHITECTURE.md) (boundaries) and [CONVENTIONS.md](CONVENTIONS.md) (code rules) add detail.<!-- init:start --> `docs/archive/` is history, not instructions.<!-- init:end -->

## Mission

Keep DarkFactory a small, truthful, swappable product template. Build features as bricks behind contracts, prove them with tests, and leave the docs matching the code.

## Repo map

| Path | What lives there |
| --- | --- |
| `apps/web` | Product app: pages, route handlers, request scope (`src/server/request-scope.ts`) |
| `apps/operator` | Opt-in agent-SDLC app ([docs/operator.md](docs/operator.md)) |
| `packages/api` | oRPC contracts (`src/contracts/`), services (`src/server/`), `openapi.json` |
| `packages/db` | Drizzle schema, migrations, repositories, seeds, request database scope |
| `packages/auth` | Better Auth server and client, generated auth schema |
| `packages/config` | Zod env schema (`src/server.ts`), database profiles, `capabilities.yaml` loader |
| `packages/observability` | Event and telemetry ports, evlog and OTel adapters, redaction |
| `packages/ui`, `packages/state` | Presentational components; XState machines and Zustand stores |
| `packages/email`, `analytics`, `ai` | Capability bricks: a port, adapters, an adapter registry (`./adapters`) and `./test` fakes |
| `packages/jobs`, `packages/operator` | Agent-SDLC workflow runtime, schema and API |
| `packages/testkit` | Isolated Postgres test databases |
| `scripts/` | Bun scripts behind every root `bun run` command |
| `tests/` | Integration, generator and Playwright E2E suites |
| `.agents/skills/<role>/SKILL.md` | Role playbooks (see below); `.claude/skills` links here |
| `capabilities.yaml` | What is enabled, and which adapter provides it |
| [`docs/generated/package-graph.md`](docs/generated/package-graph.md) | Live package graph, generated from each `package.json` `brick` role |

## Golden rules

1. **Contracts first.** Change the oRPC contract or Zod schema and its failing test before the implementation.
2. **Ports and adapters.** Vendor SDKs are imported only in adapter files. Features and services depend on ports.
3. **TypeScript strict.** No `any`, no `@ts-ignore`, no non-null assertions on untrusted data. Validate input with Zod at boundaries.
4. **Tests and the 100% gate.** Every source file is measured. Cover new code with tests, not with coverage exclusions. Coverage ratchet (owner decision, 2026-10-11, reconfirmed 2026-10-16; ADR-016): files listed in `scripts/ci/coverage-baseline.json` were below 100% after the TypeScript port and keep recorded per-file minimums that may only rise; every other file must reach 100%. The list may only shrink. Never add a file to it or lower a minimum.
5. **No secrets.** Never commit, log or print secrets, `.env` values, tokens or personal data. Seeded accounts are dev-only.
6. **Drizzle only.** All Postgres access goes through `packages/db` repositories and generated migrations.
7. **oRPC only.** No ad hoc REST routes, server actions or direct database calls from pages.
8. **Small, focused commits.** One change per commit, with its tests, generated artifacts and docs. Use Conventional Commits.
9. **Never weaken a gate.** Do not lower thresholds, skip tests, add `.only`, widen allowlists or disable hooks to go green.
10. **Keep docs live.** If you change a command, contract, port or boundary, update the doc that describes it in the same commit. A new package needs a `brick` role; run `bun run docs:generate`.
11. **Keep the manifest truthful.** `capabilities.yaml` lists only what is installed and wired.
12. **No speculative infrastructure.** Postgres first. Add a service, dependency or abstraction only for a current requirement.

## Workflow

```text
plan → contract → failing test → implement → bun run verify:prepush → PR (8 required checks green = done)
```

- **Plan:** state the goal, the bricks touched and the acceptance test. The `pm` and `architect` skills own this.
- **Contract:** oRPC contract, Zod schema, port interface or migration.
- **Failing test:** at the lowest level that proves the behavior (unit, contract, integration or E2E).
- **Implement:** the smallest complete vertical change. Iterate with `bun run check` and focused `pnpm exec vitest run <file>` runs.
- **Pre-push:** `bun run verify:prepush` runs automatically on `git push`. Fix the cause instead of bypassing the hook.
- **PR:** done when the eight required checks pass: the four CI lanes `Verification (core)`, `Verification (coverage)`, `Verification (integration)` and `Verification (browser)`, plus `Analyze (actions)`, `Analyze (javascript-typescript)`, `CodeQL` and `Dependency Review` ([docs/deploy.md](docs/deploy.md#branch-protection)).
- **Exact-SHA evidence** is required only for a release or deploy. Dispatch `ci.yml` on the exact commit and confirm the run's `head_sha` before deploying ([docs/deploy.md](docs/deploy.md#release-checklist)).

Graphify is optional: `bun run graph:build` builds a local graph for navigation. It is never committed or required.

## Agent roles

Each role is a harness-agnostic Agent Skill in `.agents/skills/` (Claude Code finds the same files through `.claude/skills`). Load the one that matches the task.

| Role | Use it for | Skill |
| --- | --- | --- |
| PM | Turn a request into a scoped plan with acceptance tests | [pm](.agents/skills/pm/SKILL.md) |
| Architect | Brick boundaries, contracts, ports, ADRs | [architect](.agents/skills/architect/SKILL.md) |
| Backend | Services, repositories, migrations, adapters | [backend](.agents/skills/backend/SKILL.md) |
| Frontend | Pages, components, view-models, accessibility | [frontend](.agents/skills/frontend/SKILL.md) |
| Janitor | Structure-only cleanup pass: names, file names, module layout | [janitor](.agents/skills/janitor/SKILL.md) |
| QA | Test design, E2E and a11y, flake triage, gates | [qa](.agents/skills/qa/SKILL.md) |
| Security | Threat review, secrets, auth, dependency alerts | [security](.agents/skills/security/SKILL.md) |
| Scalability | Database load, request scope, Worker limits | [scalability](.agents/skills/scalability/SKILL.md) |
| Release | Versioning, changelog, exact-SHA CI, deploy | [release](.agents/skills/release/SKILL.md) |

The hand-offs between roles are drawn in [ARCHITECTURE.md](ARCHITECTURE.md#sdlc-agent-graph).

## Vertex Research project

> 2026-10-04: migrated from Civet to strict TypeScript to match DarkFactory d449f29 at the user's request.

This repository is Vertex Research, a downstream of [DarkFactory](https://github.com/jeffscottward/darkfactory) (remote `darkfactory-upstream`). Upstream changes arrive by a real `git merge` of `darkfactory-upstream/main`; Vertex migrations `0000`-`0022` are applied locally and stay byte-identical, so upstream migrations are appended after the Vertex head. Project-only subsystems: the governed `vertex_*` schema and app migrations, Vertex oRPC contracts and services (research chat, agent operations, backtests, strategies, optimizations, deployment requests, assistant, MCP), the portal pages, `packages/shared`, `packages/storage`, `packages/notifications`, `scripts/vertex-*`, `infra/quant-vps` and the native Python/Rust services under `services/` (exempt from the TypeScript rule). The sections below are the Vertex constitution; they add to the template rules above. Where they name Civet-era mechanisms that upstream has since replaced (five CI lanes including graph, the security preflight, `.env.schema`), the upstream sections above describe the current mechanism and the policy intent still applies.

Development repository (owner 2026-11-04): open PRs on the public repository `jeffscottward/vertex-research-public` and read CI there; every job runs on GitHub-hosted runners, never on self-hosted or rig runners. The private `jeffscottward/vertex-research` is a read-only backup with unrelated history. Sanitize and scan every change before it reaches the public repository ([ci-cutover.md](docs/vertex-rebuild/ci-cutover.md)).

### Vertex Research specialization — 2026-09-21

This isolated project specializes the inherited DarkFactory foundation for Vertex Research. The current authority is the implementation plan and traceability ledger under `docs/vertex-rebuild/`; the original consolidation report remains evidence, not permission to reinstate its superseded Next.js stack or copy another application shell. Keep this file and `CLAUDE.md` byte-identical.

- Preserve the inherited contract-first, test-first, modularity, security, exact coverage, CI, review, generated-artifact and deployment rules below. Domain-neutral restrictions apply to reusable foundation packages; Vertex feature verticals may implement the explicitly requested trading domain and five decision-oriented destinations. Branding is the existing gray/gold/white Vertex identity; preserve accessibility and light/dark/system support.
- First-party web and control-plane source is strict TypeScript (see "TypeScript strict" above): Vite/Vinext, official `@vinext/cloudflare`, oRPC, Better Auth, Drizzle and PostgreSQL. Do not reuse Gamma's frontend or the legacy BFF.
- The sole native-language exception is separately deployable Python domain/research/data and engine-adapter services, including the Agno model bridge, plus a Rust latency-sensitive kernel on the Quant VPS. These are product services, not the local DarkFactory operator. Native service-local tests and necessary packaging are included in the exception. This does not authorize Python/Rust web routes, a second control API, or arbitrary TypeScript/Go rewrites. Use versioned public contracts, generated interoperability artifacts and compatibility fixtures; never import package internals across the boundary.
- Cloudflare owns web/control; one Quant VPS authority owns execution, risk, local durable submission/reservation state and reconciliation. No synchronous Cloudflare, model, or PlanetScale operation belongs in the tick/callback loop. PlanetScale PostgreSQL stores control/research records and explicit asynchronous execution projections; it must not become a second order writer or independently spend the same collateral. Native persistence ownership and the scoped latency exception are defined in `ARCHITECTURE.md`.
- Default to research/read-only. A model, document, confidence score or completed backtest cannot authorize a trade. Paper and live identities remain isolated. Unknown broker acceptance blocks retry until reconciliation; an unready position feed is unknown, not zero. Pause-new-risk, cancel and liquidation are distinct permissions.
- Preserve the explicit human IBKR recovery trigger. Never auto-login, clear a challenge, unlock a vault, approve a provider safety check, or restart trading because a watcher reports a problem. JEV must never observe financial-services pages, account data or secrets. The identity of the existing JEV watcher remains unverified.
- Restart the QuantVPS web app (`vertex-web.service`) only through `infra/quantvps/restart-when-idle.sh` ([infra/quantvps/README.md](infra/quantvps/README.md)). It waits until the app is idle, restarts only `vertex-web`, checks health and rolls back a failed build. Never restart Nautilus, the IB gateway, the exec node, the recovery bridge or a trading container as part of a web deploy.
- Retain originals, worktrees, private journals and corpus provenance. Fincept source is no-copy pending exact-revision license clearance. A software project or brand is not legal fund establishment, regulated status, or a returns claim.
- During the parallel rebuild foundation phase, only the integration owner runs builds, tests, formatters, dependency installation, Graphify and repository gates after siblings settle. This scoped scheduling restriction does not waive any gate; results remain pending, and inherited checkpoints/graphs do not verify this branch.

### Adapter precedence

Tool adapters such as `Makefile` and the devcontainer are entry points, not competing policy. When repository guidance differs, follow `AGENTS.md` for executable policy, then `ARCHITECTURE.md` for boundaries and decisions, then `CONVENTIONS.md` for implementation rules. An adapter may add only tool-specific bootstrap or evidence mechanics and must not weaken the canonical documents or higher-priority task instructions.

### Requirement language

Classify every requirement before implementing it:

- **Core** — present in every DarkFactory project.
- **Capability** — optional, explicitly enabled, and removable through its manifest and adapter boundary.
- **Convention** — a rule contributors and agents must follow.
- **Implementation** — the current replaceable mechanism; never mistake it for an architectural invariant.

Do not promote an Implementation to Core or add a Capability implicitly.

### Work sequence

1. Read the relevant contracts, feature boundary, tests, and architecture docs.
2. Before broad exploration, use the repository Graphify wrapper: `bun run graph:check`, then `bun run graph:verify` when `graphify-out/graph.json` exists. Do not invoke Graphify directly; the wrapper enforces the repository's workspace-alias, environment-isolation, metadata, and verification policy.
3. If the graph is missing, run `bun run graph:build`; do not reconstruct the repository from repeated broad searches.
4. Define or update the observable contract and its failing test before implementation. Documentation-only and non-behavioral changes do not need artificial tests.
5. Implement the smallest complete vertical change. Reuse existing code; never create a second convention beside an existing one.
6. Run the narrowest relevant check while iterating, then the repository lifecycle gates required for the change.
7. Run `bun run graph:update`, `bun run graph:check`, and `bun run graph:verify` after adding a feature, moving public symbols, changing contracts or database relationships, or materially changing architecture. When an explicitly scoped documentation task defers Graphify, record the deferral and make no freshness or query claim.
8. Update architecture, capability truth, generated OpenAPI, enabled internal documentation, and operator guides when their source contracts change. Keep evidence records pending until the referenced command, browser flow, graph query, CI run, or deployment is actually observed at the exact revision.
9. Commit only the focused change. Follow every eligible PR/manual CI run and separately triggered security workflow to a terminal state; investigate and fix repository-owned failures before asking the user. Every eligible PR revision requires all five CI lanes. Ordinary pushes, including merges to `main`, do not trigger heavy CI; do not manufacture a second run merely for merge closeout or call its intentional absence a green, missing, or skipped check. Required checks must succeed, or an exact external blocker must be documented with its owner, evidence, rerun trigger, and stop condition.

For long-running work, create or update the root `.omp-status.md` after meaningful edits or verification and before handoff, pause, or context reset. Keep it concise: timestamp, thread, goal, branch, changed files, completed work, last verification, next action, and stop condition.

### Source and module rules

- Author application, feature, UI, service, schema, adapter, script, and test source in **strict TypeScript** (`.ts`, and `.tsx` only for real JSX), following the upstream "TypeScript strict" golden rule: no `any`, no `@ts-ignore`/`@ts-expect-error`, no non-null assertions on untrusted data, Zod at boundaries, Biome clean.
- Never manually edit generated TypeScript.
- Build tiny, independently composable functions and components. Group very small related units in a local `index.ts`; split files only when reuse, independent testing, a meaningful boundary, or growth makes the split clearer.
- Keep business behavior out of route handlers, CLI handlers, framework entrypoints, and adapters.
- Organize application work as feature-vertical slices. A feature owns its UI, state, contract use, orchestration, feature-local server code, and tests. Move code to a shared package only after it is genuinely cross-feature.
- Use named exports and explicit local public surfaces. Do not deep-import another feature's internals or create broad barrels that conceal dependencies.
- Use an existing feature generator when present. A generated feature must update names, contracts, route registration, database objects, tests, and Graphify without leaving the generic stub's identity behind.

### Contracts, data, and providers

- Define the oRPC contract, input/output schemas, authorization expectations, and typed errors before implementing a handler.
- All application API access crosses oRPC. Do not create a parallel ad hoc REST, server-action, or direct database path. OpenAPI is generated from the same contracts when enabled.
- Access PostgreSQL through Drizzle stores/repositories and migrations. Do not bypass Drizzle with feature-local SQL unless a measured need is documented and the database package owns the exception.
- Use this decision order for data-related needs: PostgreSQL core feature → proven PostgreSQL extension/pattern → external infrastructure only with a compelling measured reason.
- Do not add Redis, RabbitMQ, or another data system as a default or speculative fallback. New infrastructure must justify another source of truth, failure mode, credential, deployment, monitoring surface, and agent context.
- Define small ports at external boundaries; keep provider names in adapters. Domain and application code must not import Cloudflare, PlanetScale, PostHog, Groq, Resend, R2/S3, Celery, or another vendor SDK.
- Keep framework dependencies pointing inward: framework → application → domain; adapters implement application ports.
- Use Effect only for infrastructure/service boundaries with meaningful resource, concurrency, retry, timeout, cancellation, configuration, or typed-failure complexity. Use XState for explicit lifecycles and persist durable transitions in PostgreSQL. Use Zustand only for ephemeral local UI state, never server data, URL state, or durable preferences.
- Treat `.env.schema` as the public environment contract, keep real values in ignored/managed secret stores, and expose client variables only through an explicit reviewed allowlist. Production must reject development secrets, seeds, local origins, and preview-only assumptions.
- Keep `capabilities.yaml`, installed dependencies, configuration, runtime availability, and documentation truthful. Disabled, unknown, and incompatible are distinct states; none may be presented as available.
- Deploy the vinext web application only through official `@vinext/cloudflare`. Alchemy may own only a real explicitly enabled ancillary Cloudflare resource; while none is enabled, do not add an empty `alchemy.run.ts` or run empty reconciliation.

### Events, observability, and errors

- Emit stable, meaningful application events through evlog. Do not scatter provider calls or unstructured console output through features.
- Send product analytics through the analytics port and PostHog adapter. Use OpenTelemetry for traces, metrics, and technical logs. Core code imports neither provider directly.
- Preserve causal and request context, but never log secrets, credentials, session tokens, raw sensitive profile fields, or full provider payloads.
- Model expected failures as typed domain/application errors and map them once at contract boundaries. Never swallow errors or expose internal stack details to clients.

### Lifecycle gates

The canonical lifecycle is:

`develop → focused verification and artifact updates → focused commit → deterministic pre-push → five-lane PR CI → exact-head technical review and merge/tree verification → explicit exact-SHA full CI before authorized deployment`

Root `bun run` scripts and Turborepo tasks are the source of truth. `verify:static` owns static checks, lint, typecheck, builds, docs, and generated-artifact freshness. Local pre-push runs only `verify:core`: static plus unit, contract, and operations tests. Full `verify` and its `ci` alias instead compose `verify:core:ci` (static plus scoped `test:e2e-helpers`) with coverage, integration, graph, and browser lanes; unit/contract/operations run once under coverage, with all four 100% thresholds unchanged (except the per-file ratchet minimums in `scripts/ci/coverage-baseline.json`). In CI the coverage lane merges sharded blob reports and checks the thresholds once. GitHub Actions runs all five required lanes concurrently and builds fresh Graphify output before graph verification. Do not turn pre-push into five sequential local lanes. Pre-commit stays staged and focused. Every source push must bind Git's actual destination and every non-deletion ref to clean, unchanged current HEAD, require both executing and PATH-resolved Bun to match `.bun-version`, then pass destination-scoped security preflight before core. Failures or source mutation block the push. Environment-heavy verification remains explicit in full verification and mandatory hosted CI, not a per-push hook prerequisite. Never bypass a failing gate, disable a test, or skip hooks to make a change pass. A badge, prior run, generated file, or agent self-report is not evidence for the current revision; pending, skipped, cancelled, timed-out, blocked, or unobserved work is not green.

Heavy `ci.yml` runs only on `pull_request` and explicit `workflow_dispatch`, never automatically on push. Required PR checks remain strict and unchanged. CodeQL, Scorecard, and Dependency Review retain their independent events, guards, and uploads, including applicable default-branch security scans. Merge acceptance records successful latest reviewed PR checks and exact identity between that PR head's Git tree and the merged tree; this is not evidence that CI ran on the merge SHA. Unexpected direct-main changes require explicit full manual validation at their exact SHA, not automatic acceptance.

Before actual deployment, explicitly dispatch full CI on a branch or tag resolving to the intended deployment SHA, verify the observed run's `head_sha` equals that SHA, and require all five lanes to succeed. A same-tree PR receipt does not replace this deployment evidence. This is an operator acceptance policy, not an automated gate in the current deploy CLI; preserve authorization, environment approval, least privilege, runtime probes, and rollback evidence.

Private licensed security capabilities require explicit operator activation and positive capability evidence; an unconfigured scan must report **not configured / not run**, never “analysis passed.” Public security analysis remains enabled. A configured but unavailable capability is a blocking error, not a successful skip. Do not change billing or repository visibility to make CI pass. Local checks cannot guarantee hosted service availability or token permissions, so follow every triggered workflow to a terminal result after pushing. See [security preflight](docs/security-preflight.txt).

Before merging, inspect effective repository and organization rules and require successful current required checks, preserving every required check name/app identity, strict up-to-date checks, and other protections. Independent GitHub approval is mandatory only when those effective rules require it; documented exact-head technical review and real verification remain mandatory in every case. The approved solo-maintainer policy permits `required_approving_review_count: 0` and `require_last_push_approval: false`, but documentation is not evidence that live protection has changed. Unknown or incompatible rules block acceptance. Never invent approval, use an admin bypass, grant access, or change settings merely to obtain a merge.

Record the final head, full reviewed scope, findings and resolutions, actual verification results, and remaining limitations. Security-bootstrap review covers the entire helper/generator/generated-artifact trust boundary and hosted consumers, not only the corrective diff. Successor publication remains held until the public follow-up is accepted; local integration of trusted-base consumers is not verified publication. A successful merge or generated bootstrap bytes prove neither analyzer execution nor SARIF ingestion. When effective rules require independent approval, it must qualify for the final head; owner/admin exemptions, local agent review, earlier-head approval, or a successful merge response cannot substitute for it. Invitations and access changes require a separate deliberate owner decision and are not approval.

Use Bun as the primary script and TypeScript runtime, and use `bunx --bun --no-install` only for compatible local CLIs. Do not force Bun onto child-launching tools such as Turborepo when `BUN_BE_BUN` would leak into package-manager children; use `bunx --no-install turbo` for the task graph. Use pnpm for packages, workspaces, explicit package-local Vitest execution under Node, and the sole lockfile; never use Bun as a second package manager.

Do not use `pnpm run` for lifecycle commands or bare `pnpm ci` as a gate; pnpm is reserved for frozen installation, package/workspace resolution, explicit package-local execution, and the sole lockfile.

### UI constitution

- Maintain two domain-neutral surfaces: a refined public site and a practical authenticated portal. References are continual pattern libraries, not a fixed information architecture. Derive navigation and page structure from current product requirements; do not invent a business-specific sitemap, entities, metrics, or workflow.
- Treat `design-system/darkfactory/MASTER.md` as the authoritative UI specification and `.impeccable.md` as persistent design context. Read both before designing or implementing an interface; page-specific design files may narrow but not silently replace the Master.
- Use <https://www.squarespace.com/> as continual public-side inspiration for editorial restraint, hierarchy, spacing, imagery, and polished responsive composition. It inspires patterns; do not copy layouts, copy, branding, assets, or trade dress.
- Use <https://ui.shadcn.com/blocks> as a continual authenticated-portal reference for proven shells, navigation, forms, tables, settings, account, and administration patterns. It inspires composition; do not copy a block wholesale or let examples define the product domain or information architecture.
- All typography is sans serif. The default direction is Manrope for display/headings and Public Sans for body/UI; never introduce serif typography, Inter, Roboto, Arial, or Open Sans.
- Build with Tailwind and shadcn tokens. Support light, dark, and system modes plus the ten defined color palettes; reject dark-only design and generic purple/cyan glowing “AI” aesthetics.
- Preserve visible keyboard focus, semantic structure, labels, contrast, and minimum 44×44 px interactive targets. Verify responsive behavior at 375, 768, 1024, and 1440 px.
- Keep loading and interaction states stable: reserve dimensions and never use jump, bounce, scale, or hover translation that shifts layout.
- Use meaningful icons from one coherent outline family. Do not use emoji or decorative icons as structural interface controls.
- Do not expose a reduced-motion preference in the user profile. Still honor CSS `prefers-reduced-motion` and avoid motion that blocks comprehension.
- Placeholder and fake content must remain visibly non-production. Generic multi-page placeholders may use <https://placehold.co/>, fictional avatars, a fake favicon, neutral fictional identities, and `.test` email addresses. Never use a real person's data, realistic credentials, production-like personal data, or content that implies a business vertical.

### Security and repository hygiene

- Never commit or print secrets, default production passwords, private certificate keys, tokens, `.env` values, provider payloads, or personal data.
- Seeded identities and credentials are development-only. Production must reject development seeds and defaults.
- Keep generated local HTTPS private keys ignored; commit only safe setup instructions and public examples.
- Live security exploitation is post-build work requiring explicit written authorization, an isolated non-production source and target, scoped test credentials and rules of engagement, human stop authority, remediation, and a scoped rerun. Shannon is white-box source-guided testing only; never use it for black-box scanning or against production.
- Do not add dependencies, infrastructure, flags, abstractions, aliases, compatibility shims, or “future-proofing” without an active requirement.
- Do not duplicate code, suppress failures, edit unrelated files, or bundle cleanup into a functional commit.
- Focused commits contain one coherent change and its contract, tests, generated artifacts, Graphify update, and directly affected documentation.

## Deeper docs

- [ARCHITECTURE.md](ARCHITECTURE.md): brick map, request flow, SDLC graph, CI lanes, decisions log
- [CONVENTIONS.md](CONVENTIONS.md): modules, naming, errors, logging, tests, feature slices
- [docs/getting-started.md](docs/getting-started.md), [docs/testing.md](docs/testing.md), [docs/capabilities.md](docs/capabilities.md), [docs/deploy.md](docs/deploy.md), [docs/debugging.md](docs/debugging.md), [docs/operator.md](docs/operator.md), [docs/security.md](docs/security.md)
- [design-system/darkfactory/MASTER.md](design-system/darkfactory/MASTER.md): UI specification
- [SECURITY.md](SECURITY.md): reporting vulnerabilities
