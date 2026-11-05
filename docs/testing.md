# Testing

## Layers

| Layer | Where | Runs with | Needs |
| --- | --- | --- | --- |
| Unit | `**/*.test.ts(x)` next to the code, `tests/generator/` | Vitest project `unit` | nothing |
| Contract | `**/*contract.test.ts` | Vitest project `contract` | nothing |
| Operations | `scripts/**/*.test.ts` | Vitest project `operations` | nothing |
| Acceptance | `scripts/**/*.acceptance.test.ts` (clone, init, install) | Vitest project `acceptance`, CI coverage lane only | a pnpm store or network |
| E2E helpers | `tests/e2e/helpers/*.test.ts` | Vitest project `e2e-helpers` | nothing |
| Integration | `tests/integration/**/*.test.ts` | Vitest project `integration` | Postgres |
| E2E | `tests/e2e/*.spec.ts` | Playwright project `e2e` | Postgres, build |
| Accessibility | `tests/e2e/*.a11y.spec.ts` | Playwright project `a11y` (axe) | Postgres, build |
| Portal input guard | `tests/e2e/portal-inputs.spec.ts` | Playwright project `inputs`, runs after `e2e` and `a11y` | Postgres, build |

Pick the lowest layer that proves the behavior. A rule in a service is a unit test. A contract's input, output and error codes are a contract test. SQL and migrations are an integration test. Only full user journeys (sign-in, cookies, navigation) need E2E.

## Commands

```sh
bun run test                 # every layer
bun run test:unit
bun run test:contract
bun run test:acceptance      # clone + init + install; CI runs it in the coverage lane
bun run test:integration     # needs the local test Postgres (below)
bun run test:e2e             # playwright test --project e2e
bun run test:a11y            # playwright test --project a11y
bun run verify:coverage      # unit + contract + operations + E2E helpers + acceptance, 100% gate
pnpm exec vitest run packages/api/src/contact.contract.test.ts
bun scripts/with-test-env.ts pnpm exec playwright test --ui
```

## The coverage gate

`vitest.config.ts` measures `apps/*/src`, `packages/*/src` and `scripts/` and fails below 100% on lines, branches, functions or statements. Tests, `.d.ts` files, `generated/` paths and `apps/web/src/features/generated-navigation.ts` are excluded.

Thresholds alone can be bypassed by excluding a file. `scripts/ci/test-invariants.test.ts` prevents that: it pins the coverage `include` and `exclude` lists, fails when a tracked non-test source file falls outside them, and checks that every test file runs in exactly one Vitest project. There are no committed coverage totals to update.

If coverage drops, write the missing test. Do not add ignore pragmas or exclusions.

Vitest always runs under Node through `pnpm exec`, even when Bun orchestrates the script: Bun does not implement the `node:inspector` coverage APIs that `@vitest/coverage-v8` needs. The raw report goes to the ignored `coverage/` directory.

## Generated artifacts

Generated files are checked against their sources in `verify:prepush` and the core lane. Regenerate instead of editing them:

| Source changed | Regenerate | Check |
| --- | --- | --- |
| oRPC contract | `bun run openapi:generate` | `bun run openapi:check` |
| Better Auth config | `pnpm --filter @darkfactory/auth exec bun run auth:schema:generate` | `bun run auth:schema:check` |
| Drizzle schema | `bun run db:generate` | `bun run db:check` |
| A workspace `package.json` | `bun run docs:generate` | `bun run docs:check` |
| The instant backtest engine, the chart indicator math, or the golden fixtures | `bun run vertex:golden-battery -- write` (see [golden-battery/README.md](golden-battery/README.md)) | the operations test `scripts/golden-battery/battery.test.ts` |
| The Python indicator library or the pandas reference | nothing to regenerate; to change the reference, run `services/research/tests/golden/make_golden_reference.py` | local only: `python -m pytest tests/test_golden_battery.py tests/test_golden_pandas_reference.py` in `services/research` (CI does not run the Python research suite) |

## How E2E runs

One `playwright test` run covers both projects. Everything uses Playwright built-ins:

- **Environment:** `playwright.config.ts` generates a run id, secrets, ports and a per-run database URL once. Workers inherit them. Remote provider credentials are blanked and `APP_ENV=test`.
- **webServer:** Playwright starts two servers and stops them afterwards. The first is a private portless HTTPS proxy with its own state directory and port. The second is the production build of the web app behind that proxy.
- **globalSetup:** creates the run database, migrates, resets and seeds it (exactly three identities), and starts the email preview capture server. Its teardown drops the database and removes the previews.
- **Per-file isolation:** each database-backed spec calls `resetDatabase` in `test.beforeAll`.
- **TLS:** there is no `ignoreHTTPSErrors`. Chromium trusts only the portless CA, through an SPKI pin (`--ignore-certificate-errors-spki-list`), and Node-side requests trust it through `NODE_EXTRA_CA_CERTS`.
- **CI policy:** `forbidOnly`, `retries: 1` and `failOnFlakyTests`. A test that passes only on retry fails the run. Traces are recorded on the first retry.

Local runs need Postgres and a production build: `bun run verify:browser` builds first. Use `bun scripts/with-test-env.ts pnpm exec playwright test --ui` for an interactive loop with the trace viewer.

## Integration tests

Integration tests use `@darkfactory/testkit/postgres` to create an isolated database per file on the maintenance server in `DATABASE_URL`. The testkit refuses a non-local or non-test maintenance database. Start Postgres with `bun run setup` or `bun run db:test:up`, then run `bun run test:integration`. Like the browser lane, it runs through `scripts/with-test-env.ts`, which sets `APP_ENV=test` and points `DATABASE_URL` at `TEST_DATABASE_URL`, or at the compose test role when that is empty, so the app database in `.env` is never used.

The browser lane (`bun run verify:browser`) needs the same two variables.

## CI lanes

| Lane | Script | What it proves |
| --- | --- | --- |
| core | `verify:core` | format, lint, generated artifacts (OpenAPI, auth schema, docs), typecheck |
| coverage | `verify:coverage` | unit, contract, operations and E2E-helper tests at 100% coverage |
| integration | `verify:integration` | repositories, migrations, auth and API against real Postgres |
| browser | `verify:browser` | production build, Playwright `e2e` and `a11y` |

In CI the coverage lane does not run the tests itself. A 2-vCPU runner cannot finish them within the 30-minute job limit, so thirteen `Coverage shard` jobs run them first: twelve Vitest shards of the unit, contract, operations and E2E-helper projects, and one job for the acceptance project. The acceptance job has a 50-minute limit, because its fresh-clone test reruns the whole unit suite. Each shard uploads a Vitest blob report as a run artifact (`coverage-blob-<n>`) and checks no threshold. Only the coverage lane (its own job, `verification-coverage`) waits for the shards; the core, integration and browser lanes start at once and run beside them. The coverage lane then merges the reports (`COVERAGE_MERGE_DIR`) and enforces the 100% thresholds on the combined coverage. `scripts/coverage-lane.ts` selects the mode from `COVERAGE_SHARD` or `COVERAGE_MERGE_DIR`; with neither set it runs the whole lane in one process. Blob reports hold absolute paths, and the rig runners check out into different directories. So each shard replaces its checkout root with `<coverage-lane-root>` in its report, and the merge replaces that token with its own checkout root.

Coverage ratchet: every measured file must reach 100% lines, branches, functions and statements, except the files listed in `scripts/ci/coverage-baseline.json`. Those files were below 100% when Vertex moved to TypeScript (2026-10-11). Each has its own recorded minimums, which may only rise. Raise a file's numbers when its tests improve, and remove the file when it reaches 100%. `scripts/ci/test-invariants.test.ts` fails if the list grows, if a listed file is already at 100%, or if the Vitest thresholds stop matching the list.

`bun run verify` runs all four locally. `bun run verify:prepush` runs the fast subset on every push: everything except the tests that need Postgres, a build, or a fresh install (integration, browser, acceptance). When the browser lane fails, CI uploads the Playwright report and traces as the run artifact `playwright-failure-<run>-<attempt>`. In CI the browser lane runs through `scripts/ci/browser-lane.sh`: it runs `verify:browser` and its own PostgreSQL in a private network namespace with only loopback. Chromium fails in-flight requests with `net::ERR_NETWORK_CHANGED` when a host network interface changes (a Wi-Fi drop, or a Docker network of another job on the shared rig), so the namespace keeps those changes away from the browser. Where unprivileged user namespaces are not available (GitHub-hosted Ubuntu), the script warns and uses the host network.

On pull requests the browser lane can run fewer specs. The CI step `Choose browser specs` runs `scripts/browser-specs.ts` on the change of the merge commit against the base branch tip. When every changed path is outside the web build, the app and the browser suite (`.agents/`, `.claude/`, `.vscode/`, `docs/`, `infra/`, `research/`, `services/`, `tests/generator/`, `tests/integration/`, root Markdown files and `LICENSE`), the lane runs `tests/e2e/smoke.spec.ts` and every changed spec file. Any other changed path, a git error, and every push or manual run use the full suite. Add a folder to `NO_BROWSER_INPUT` in `scripts/lib/browser-specs.ts` only when no import or file read of the app, the build or the suite reaches it.

## Writing good tests

- Use fakes from each brick's `./test` export instead of mocking SDKs.
- Assert on stable error codes, not message text.
- Keep one behavior per test and name the test after it.
- Do not add sleeps in E2E. Wait on locators and responses.
- Never add `.only` or `.skip` to get green. `forbidOnly` fails CI.
