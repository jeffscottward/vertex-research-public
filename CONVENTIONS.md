# Conventions

Code rules. Workflow is in [AGENTS.md](AGENTS.md), boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). Biome (`ultracite/core`, configured in `biome.jsonc`) and `tsconfig.base.json` enforce most of this; run `bun run check`.

## Modules

- ESM only. `verbatimModuleSyntax` is on, so import types with `import type`.
- Use named exports. Default exports are only for framework entry files (`page.tsx`, `layout.tsx`, configs).
- Import other packages only through their `exports` map (`@darkfactory/email/server`), never `src/` paths.
- Put server-only code behind `./server` or a `./server/<name>` subpath. Its `browser` condition points to an `unsupported` stub that throws.
- Route handlers, CLI entry files and adapters hold no business rules: they parse input, call a service and map the result.

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride` and `verbatimModuleSyntax` are on. Do not relax them per file.
- No `any`, no `@ts-ignore`. Narrow `unknown` with Zod or type guards.
- Prefer `Readonly<{ … }>` object types and `as const` tuples. Derive unions from the tuple: `type EmailAdapterId = (typeof EMAIL_ADAPTERS)[number]`.
- Validate every external input with Zod: env, requests, provider responses and YAML.

## Naming

| Thing | Style | Example |
| --- | --- | --- |
| Files and folders | kebab-case | `contact-throttle-repository.ts` |
| Types, classes, components | PascalCase | `ContactServiceError`, `StatCard` |
| Functions, variables | camelCase, verb first | `createResendEmailPort`, `parseServerEnv` |
| Constants | SCREAMING_SNAKE | `REQUEST_DATABASE_POOL_MAX_CONNECTIONS` |
| Error codes | SCREAMING_SNAKE, stable | `TOO_MANY_REQUESTS`, `EMAIL_PROVIDER_UNAVAILABLE` |
| Event names | `entity.past-tense-action`, kebab-case | `contact.submitted`, `feature-item.archived` |

## Errors

- Model expected failures as data or as a typed error with a stable `code`, never as a bare message:

  ```ts
  export type ContactServiceErrorCode = "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE";

  export class ContactServiceError extends Error {
    readonly code: ContactServiceErrorCode;
    constructor(code: ContactServiceErrorCode) {
      super(CONTACT_SERVICE_ERROR_MESSAGES[code]);
      this.name = "ContactServiceError";
      this.code = code;
    }
  }
  ```

- Adapters return result unions instead of throwing provider errors upward: `{ status: "failed"; code; retryable }` for email, `{ status: "failed"; category; retryable }` for AI.
- Map errors to HTTP once, at the contract. Each contract declares its codes and statuses (for example `CONTACT_ERRORS` in `packages/api/src/contracts/contact.ts`).
- Codes are public API: never rename one; add a new code instead.
- Never return stack traces, SQL or provider payloads to a client. Never swallow an error without logging it as an event.

## Logging and events

- Emit semantic events through a `StructuredEventSink` (evlog in the app). Do not use `console.*` in application code.
- An event has `eventId`, `name`, `occurredAt` and `correlation` (request id), and optionally `action`, `entityId`, `entityType`, `outcome`, `source`, `errorCategory`, `durationMs` and `attributes`. See `SemanticEvent` in `packages/observability/src/port.ts`.
- Pass attributes through `redact` (`packages/observability/src/redaction.ts`). Never log secrets, tokens, cookies, emails or message bodies.
- Traces and metrics go through `TelemetryPort`, product analytics through `AnalyticsPort`.

## Testing

- Put Vitest tests next to the code: `*.test.ts`, and `*.contract.test.ts` for contracts. Integration tests live in `tests/integration/`, Playwright specs in `tests/e2e/` (`*.a11y.spec.ts` for axe). Layers: [docs/testing.md](docs/testing.md).
- Use the fakes from each brick's `./test` export (`createRecordingAiPort`, `createRecordingAnalyticsPort`, `createRecordingEventSink`, `createRecordingTelemetry`). Do not mock vendor SDKs in feature tests.
- Coverage must stay at 100% for lines, branches, functions and statements, except the legacy files in `scripts/ci/coverage-baseline.json`: each keeps its recorded minimums, which may only rise, and the list may only shrink (ADR-016). Do not add coverage exclusions: `scripts/ci/test-invariants.test.ts` pins the exclusion list and fails if a tracked source file is not measured. Do not add coverage-ignore comments either (reviewed, not machine-checked).
- One behavior per test, named after the behavior.

## Feature slice layout

`bun run generate:feature <name>` creates this layout. Hand-written features follow it too.

```text
packages/db/src/generated/<name>/schema.ts        Drizzle table
packages/db/src/generated/<name>/repository.ts    owner-scoped repository
packages/db/migrations/<tag>.sql                  migration
packages/api/src/generated/<name>/contract.ts     oRPC contract + Zod schemas + errors
packages/api/src/generated/<name>/service.ts      service (depends on the repository port)
apps/web/src/features/<name>/index.ts             the feature's public surface
apps/web/src/features/<name>/names.ts             route, table and API identifiers
apps/web/src/features/<name>/feature.test.ts      tests
apps/web/src/features/<name>/graphify.json        navigation metadata
apps/web/src/app/(portal)/<plural>/page.tsx       portal page (presentation)
docs/features/<name>.md                           feature doc
```

The generator also updates `.darkfactory/features.json`, `apps/web/src/features/generated-navigation.ts`, `packages/db/migrations/meta/_journal.json` and the `*-registry.ts` files under `packages/api/src/generated/` and `packages/db/src/generated/`; never edit those by hand. Paths under `generated/` and `generated-navigation.ts` are excluded from coverage, so keep hand-written logic out of them.

Put view-model mapping (contract output → plain, pre-formatted props) in the feature folder as pure functions with their own unit test, not in the page or in `packages/ui`; the component takes only the model. Reference: `apps/web/src/components/portal/portfolio-monitor-model.ts`.

## Migration numbers

A migration takes the next free number on the branch where it is written (`NNNN_<snake_case>.sql`, its journal entry, `meta/NNNN_snapshot.json` and `packages/db/rollback/<tag>.down.sql`). When another branch with a migration merges first, both took the same number and `git merge` of the base stops on `meta/_journal.json` (and on `meta/NNNN_snapshot.json` when both have one). Then run:

```sh
git merge origin/vertex/rebuild-darkfactory-20260921   # stops on the journal conflict
pnpm db:renumber                                        # resolves it and stages the result
git commit --no-edit
```

`db:renumber` keeps the base's migrations as they are and moves this branch's new ones behind them: next free numbers, `when` newer than the base's last entry (Drizzle skips an entry whose `when` is not newer than the last applied one), renamed SQL, snapshot and rollback files, every reference to the old tag in tracked text files rewritten, and each snapshot's `prevId` pointing at the snapshot before it. It prints the lines that still name the old number (`check the old number: ...`; some hits are other numbers): fix the real ones by hand, and re-run a generator whose output embeds the number. A second run with the same base changes nothing.

The base is `MERGE_HEAD` during the merge, else origin/HEAD; pass `--base <ref>` for another one. It writes nothing and stops when a migration it would move is already on `MERGE_HEAD`, on origin/HEAD or on its local branch (the base you passed is older than the one you merged, or you are on the base branch itself: run it on the feature branch; a clone without origin/HEAD gets only the `MERGE_HEAD` check), when two of the branch's migrations share a number and a snapshot file, or when a snapshot still has conflict markers. It also stops during a rebase, where Git swaps the two sides of a conflict: run `git rebase --abort`, then update the branch with `git merge <base>` instead. A branch that contains the base through a merge commit still merges with `--ff-only`.

A database that already applied the branch's migration under its old number (a local or preview database) would apply it again under the new number and fail: reset that database after a renumber.

A migration's own test checks its SQL and rollback, not its place in the journal: `packages/db/src/server/migration-journal.test.ts` checks the order, so do not pin the previous or next journal entry, or a list of later tags, in a feature test.
