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

### Pure-move split of a listed file

A file in `scripts/ci/coverage-baseline.json` may be split into new files without raising its coverage first (owner decision 2026-11-11, ADR-017). The split must only move code. Commit it, then prove it with `bun run coverage:split-proof`:

```sh
bun run coverage:split-proof --from <listed file> --to <new file> [--to <new file>...] \
  --coverage-before <coverage-summary.json at the base> --coverage-after <coverage-summary.json at HEAD> [--base <commit>]
```

The base is the merge base of HEAD and the target branch (`git merge-base HEAD origin/vertex/rebuild-darkfactory-20260921`). `--base` names another commit, which must be an ancestor of HEAD; the command prints the base it used and, beside `--base`, the merge base. It reads the files after the split from HEAD, not from the working tree. `bun run verify:coverage` writes `coverage/coverage-summary.json`; run it once on the base and once on HEAD. The command finds each file in a summary by its exact repo-relative path or by the one key that ends with `/<path>`, stops when more than one key matches, and stops when a percentage does not match its covered and total counts. It prints `Result: PROVED` only when all of these hold:

1. Diff: `git diff --name-only <base>..HEAD` lists only the original file, the new files and the baseline. The new files are in the folder of the original file and are plain `.ts` or `.tsx` files: no test (`.test.`, `.spec.`), declaration (`.d.ts`) or Next.js route or metadata file name (`page`, `layout`, `route` and the like). No file or folder at the base has a new file's name, even without its extension. So only the original file imports the new files.
2. Statements: every top-level statement of the original file is in exactly one file after the split, token for token, with the same syntax tree and in its original order. Comments and layout are not compared. An `export` may be added to a declaration; imports and the original file's re-exports of the new files are checked by rules 4 and 5.
3. What moves: only code that runs nothing at load time. That is function declarations, interfaces and type aliases; classes without decorators, static blocks, computed member names or static initializers that run code, whose `extends` is a name not imported from another file of the split; and `const` declarations of one name each (no destructuring) whose initializers are literals, functions, or arrays and objects of those (`as const` and `satisfies` allowed). Everything else stays in the original file: `let` and `var` (they may be reassigned), ambient `declare` declarations, enums, namespaces, expressions and other statements. All declarations of one name stay in one file. Moved code may not name its own file (`import.meta` other than `import.meta.dirname`, `__filename`); the same folder keeps `__dirname` and relative `require` and `import()` correct. The directives (such as `"use client"`) stay the first statements of the original file. A `"use server"` module, a file with a JSX pragma or a triple-slash reference, and code that calls `eval` do not split, and a new file may not contain `@ts-nocheck`.
4. Names and imports: every identifier that named an import or a top-level declaration of the original file names the same one after the split, never a global. A type-only import is not used as a value or exported without `type`, and no code assigns to an import; `@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` do not hide these errors from the command. Each imported name is imported under the same name, from the same module (relative specifiers resolve from each file's folder) and not as a value or deferred import where the original imported it otherwise. Or it is a declaration that the file of the split it comes from declares and exports, imported under its name, with `type` when it is a type. Aliases (`as`) and default and namespace imports of a file of the split are refused. The other modules load in the same order as before, and deferred ones stay deferred: a module may not stop loading, start loading or move. The import of the automatic JSX runtime (`react/jsx-runtime`) is not counted.
5. Exports: the original file exports the same names, each resolves to the same declaration, import or re-export, and each name is exported once (merged declarations of one name, such as `type X` and `const X`, aside). Re-exports of the new files do not rename, carry `type` exactly for names without a value (interfaces, type aliases, `declare`), and use `export *` only when the original file re-exports no other module with `export *`. `export *` does not re-export a `default`.
6. Coverage: the covered and total lines, branches, functions and statements of the original file equal the sums over the files after the split.
7. Baseline: the entries of the files after the split are the values the command prints (a file at 100% has no entry), and everything else in the baseline is unchanged.

So the original file's minimums may fall only to the values the command prints, new files are listed only with those values, and nothing else in the baseline list changes. Commit the baseline entries the command prints, then run it again.

In the PR, put the command and its output in the description and keep the count under the limit in `scripts/ci/test-invariants.test.ts`. The coverage summaries are supplied by the author, so the reviewer reruns the command on the PR head with summaries from their own `bun run verify:coverage` runs on the base and on HEAD. Comments are not compared, so the reviewer also checks moved comments that tools read (bundler hints such as `@vite-ignore`), and that no code finds a new file by a name built at run time (a computed `import()`, a folder read).

Any other change to the moved code (a rename, a new parameter, a fix) goes in its own PR under the normal rule.

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
- **Evidence screenshots:** E2E screenshots show mock data. Take them with `captureMockEvidence` (`tests/e2e/helpers/evidence.ts`): dark mode, scrolled to the top first (a full-page shot of a scrolled page draws the fixed sidebar and the sticky tab bar in the middle of the image), and a "MOCK DATA" banner. Evidence for the owner of a live page comes from the live app (headless Chrome on the rig), not from E2E. `findLayoutProblems` in the same file lists elements cut off on the right.

Local runs need Postgres and a production build: `bun run verify:browser` builds first. Use `bun scripts/with-test-env.ts pnpm exec playwright test --ui` for an interactive loop with the trace viewer.

## Integration tests

Integration tests use `@darkfactory/testkit/postgres` to create an isolated database per file on the maintenance server in `DATABASE_URL`. The testkit refuses a non-local or non-test maintenance database. Start Postgres with `bun run setup` or `bun run db:test:up`, then run `bun run test:integration`. Like the browser lane, it runs through `scripts/with-test-env.ts`, which sets `APP_ENV=test` and points `DATABASE_URL` at `TEST_DATABASE_URL`, or at the compose test role when that is empty, so the app database in `.env` is never used.

The browser lane (`bun run verify:browser`) needs the same two variables.

## CI lanes

| Lane | Script | What it proves |
| --- | --- | --- |
| core | `verify:core` | format, lint, generated artifacts (OpenAPI, auth schema, docs), typecheck; in CI also the Python research, execution and native service suites (`scripts/ci/research-python.sh`) and the Rust native service suites (`scripts/ci/native-rust.sh`) |
| coverage | `verify:coverage` | unit, contract, operations and E2E-helper tests at 100% coverage |
| integration | `verify:integration` | repositories, migrations, auth and API against real Postgres |
| browser | `verify:browser` | production build, Playwright `e2e` and `a11y` |

In CI the coverage lane does not run the tests itself. A 2-vCPU runner cannot finish them within the 30-minute job limit, so thirteen `Coverage shard` jobs run them first: twelve Vitest shards of the unit, contract, operations and E2E-helper projects, and one job for the acceptance project. The acceptance job has a 50-minute limit, because its fresh-clone test reruns the whole unit suite. Each shard uploads a Vitest blob report as a run artifact (`coverage-blob-<n>`) and checks no threshold. Only the coverage lane (its own job, `verification-coverage`) waits for the shards; the core, integration and browser lanes start at once and run beside them. The coverage lane then merges the reports (`COVERAGE_MERGE_DIR`) and enforces the 100% thresholds on the combined coverage. `scripts/coverage-lane.ts` selects the mode from `COVERAGE_SHARD` or `COVERAGE_MERGE_DIR`; with neither set it runs the whole lane in one process. Blob reports hold absolute paths, and the rig runners check out into different directories. So each shard replaces its checkout root with `<coverage-lane-root>` in its report, and the merge replaces that token with its own checkout root.

Coverage ratchet: every measured file must reach 100% lines, branches, functions and statements, except the files listed in `scripts/ci/coverage-baseline.json`. Those files were below 100% when Vertex moved to TypeScript (2026-10-11). Each has its own recorded minimums, which may only rise. Raise a file's numbers when its tests improve, and remove the file when it reaches 100%. `scripts/ci/test-invariants.test.ts` fails if the list has more entries than its limit (`COVERAGE_RATCHET_LIMIT`), if a listed file is already at 100%, or if the Vitest thresholds stop matching the list. The one exception is a [proved pure-move split](#pure-move-split-of-a-listed-file).

`bun run verify` runs all four locally. `bun run verify:prepush` runs the fast subset on every push: everything except the tests that need Postgres, a build, or a fresh install (integration, browser, acceptance). When the browser lane fails, CI uploads the Playwright report and traces as the run artifact `playwright-failure-<run>-<attempt>`. In CI the browser lane runs through `scripts/ci/browser-lane.sh`: it runs `verify:browser` and its own PostgreSQL in a private network namespace with only loopback. Chromium fails in-flight requests with `net::ERR_NETWORK_CHANGED` when a host network interface changes (a Wi-Fi drop, or a Docker network of another job on the shared rig), so the namespace keeps those changes away from the browser. Where unprivileged user namespaces are not available (GitHub-hosted Ubuntu), the script warns and uses the host network.

On pull requests the browser lane can run fewer specs. The CI step `Choose browser specs` runs `scripts/browser-specs.ts` on the change of the merge commit against the base branch tip. When every changed path is outside the web build, the app and the browser suite (`.agents/`, `.claude/`, `.vscode/`, `docs/`, `infra/`, `research/`, `services/`, `tests/generator/`, `tests/integration/`, root Markdown files and `LICENSE`), the lane runs `tests/e2e/smoke.spec.ts` and every changed spec file. Any other changed path, a git error, and every push or manual run use the full suite. Add a folder to `NO_BROWSER_INPUT` in `scripts/lib/browser-specs.ts` only when no import or file read of the app, the build or the suite reaches it.

The core lane also runs `scripts/ci/research-python.sh`. It makes a temporary virtual environment with CPython 3.12 from the hash-pinned lock `services/research/requirements-linux-py312.lock` and runs pytest on the suites in `services/research/tests/ci-suites.txt`. That file lists every `test_*.py` file in a `tests` folder under `services/research` and in `services/execution/tests`. The script stops when a test file is not listed, so add every new test file to it. Local run: `VERTEX_RESEARCH_PYTHON="$(uv python find 3.12)" bash scripts/ci/research-python.sh`.

Three more runs in the same script use their own temporary virtual environments. The numeric run installs `services/research/requirements-numeric-linux-py312.lock` (the base pins plus `numpy==2.4.6` and `scipy==1.18.1`) and runs the suites in `services/research/tests/ci-suites-numeric.txt` with `VERTEX_REQUIRE_NUMERIC=1`. The Nautilus run installs `services/research/requirements-nautilus-linux-py312.lock` (the base pins plus `nautilus-trader==1.227.0` and pandas; glibc 2.35 or later) and runs the suites in `services/research/tests/ci-suites-nautilus.txt` with `VERTEX_REQUIRE_NAUTILUS=1`. The gs-quant run installs `services/research/requirements-gsquant-linux-py312.lock` (the base pins plus `gs-quant==2.2.4`, pandas 3.1.1, SciPy and statsmodels) and runs the suites in `services/research/tests/ci-suites-gsquant.txt` with `VERTEX_REQUIRE_GSQUANT=1`; those tests block network sockets and use no Goldman Sachs Marquee session (see [gs-quant](vertex-rebuild/gs-quant.md)). In these runs a missing numeric backend or engine fails instead of skipping. The pandas suites use `importorskip`; pandas is pinned in the Nautilus lock. In the base run the tests that need numpy, scipy, pandas or nautilus-trader skip.

A fifth run installs `services/research/requirements-services-linux-py312.lock` (the base pins plus `ada-url==4.0.0` and `cryptography==46.0.3`) and runs the native service suites in `services/research/tests/ci-suites-services.txt`: every `test_*.py` file in `services/contracts/python`, `control-client`, `gateway`, `host`, `kernel-bridge`, `market-data` and `vibe-trading`. The script stops when one of those files is not listed.

The core lane also runs `scripts/ci/native-rust.sh`. It runs `cargo test --locked` from `services/kernel-bridge` (the only `Cargo.lock`) for `vertex-contracts`, `vertex-execution-kernel` and `vertex-kernel-bridge`. The kernel-bridge build script needs a reviewed build identity, so the script computes the kernel source digest with the algorithm of `build.rs`, uses the build ID `ci-unreviewed-test`, and generates the contract bundle for the parity test with `scripts/vertex-contracts.ts generate`. The test binary is never a release artifact. `services/ibkr-history` has no `Cargo.lock` and is not tested.

TS-side Python tests: every `packages/api` test that starts a Python child uses one interpreter, `VERTEX_TEST_PYTHON` (`packages/api/src/server/research-python.test-support.ts`). Each coverage shard makes it with `scripts/ci/test-python.sh` from `services/research/requirements-sdk-linux-py312.lock` (the services lock plus the research SDK stack: `agno==1.7.12`, `openai==1.93.0`, `httpx==0.28.1` and their closure). In GitHub Actions (`GITHUB_ACTIONS=true`) the interpreter-only suites (`vertex-runtime-composite`, `-hmm` and `-jump`) fail when the variable is missing; locally they skip. `turbo.json` passes `VERTEX_TEST_PYTHON` through to `test:unit`. Local run: `export VERTEX_TEST_PYTHON="$(bash scripts/ci/test-python.sh /tmp/vertex-test-python | tail -1)"`.

## Writing good tests

- Use fakes from each brick's `./test` export instead of mocking SDKs.
- Assert on stable error codes, not message text.
- Keep one behavior per test and name the test after it.
- Do not add sleeps in E2E. Wait on locators and responses.
- Never add `.only` or `.skip` to get green. `forbidOnly` fails CI.
