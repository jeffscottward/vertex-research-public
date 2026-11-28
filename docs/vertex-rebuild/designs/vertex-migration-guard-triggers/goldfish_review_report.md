# Goldfish Annotated Review Report

**Status:** resolved

**Target:** `docs/vertex-rebuild/designs/vertex-migration-guard-triggers/plan.md` (`full file`)
**Review mode:** Consolidated report with all review rubrics (`egm-zoom-out`, `egm-comprehension`, `egm-design-critic` + `egm-structural`, `egm-implementation-readiness` + `egm-codebase-details`)
**Resolution mode:** Auto accept (standing owner rule 2026-11-13: apply all `PROPOSE FIX` items; keep `CONTEST` and `DECLINE` recorded; `0` `ESCALATE` items)

**Counts:** 16 `PROPOSE FIX` applied · 1 `CONTEST` · 2 `DECLINE` · 0 `ESCALATE`

## Prioritized Findings & AI Suggestions

### [Issue 1] [`egm-design-critic`] - Severity: Blocker

* **Affected Scope:** Full document (`plan.md`)
* **Discrepancy Description:** Missing `## Alternatives Considered` section evaluating competing approaches (`feature-spec-standard.md` Alternatives Rule).
* **Rationale:** Specifications must document viable alternatives and concrete reasons for rejecting them.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Adding `## Alternatives Considered` comparing (a) external PostgreSQL SQL parser dependency, (b) writing `drizzle.__drizzle_migrations` rows during manual QuantVPS `psql` runs, and (c) hashing `pg_proc.prosrc` / `pg_get_triggerdef(tg.oid)` makes the design rationale explicit.
* ***Proposed Edit:***
  * Location: After `## Root cause`
  * Change: Add `## Goals` and `## Alternatives Considered` sections.

### [Issue 2] [`egm-design-critic`] - Severity: Blocker

* **Affected Scope:** `plan.md` lines 24, 38, 47, 55 (`Scope`)
* **Discrepancy Description:** `INSTEAD OF` triggers are only legal on views, while `snapshot.tables` reads `pg_catalog.pg_tables` (excluding views). Parsing `INSTEAD OF` while skipping `!snapshot.tables.has(table)` silently skips every `INSTEAD OF` trigger.
* **Rationale:** A parsed construct that is always silently skipped is a self-contradiction.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** No migration in this repository creates views or `INSTEAD OF` triggers. Restrict trigger timing to `BEFORE|AFTER` and place view / `INSTEAD OF` triggers in `## Out of scope`.
* ***Proposed Edit:***
  * Location: `Scope` (SQL expectation extractor, tests) and `Out of scope`
  * Change: Restrict `CREATE TRIGGER` timing to `BEFORE|AFTER` and list `INSTEAD OF` / view / foreign-table triggers in `## Out of scope`.

### [Issue 3] [`egm-zoom-out`] - Severity: Major

* **Affected Scope:** `plan.md` lines 36–40, 55 (`Scope`)
* **Discrepancy Description:** Speculative DDL parsing for `ALTER FUNCTION ... RENAME TO`, `ALTER TRIGGER ... RENAME TO`, `CONSTRAINT TRIGGER`, and unused rename mechanics adds branches under the 100% branch-coverage gate despite zero occurrences across all 104 migrations and `0104`.
* **Rationale:** YAGNI and Golden Rule 12 ("No speculative infrastructure"); `check-applied.ts` does not parse `ALTER TABLE ... RENAME TO` or `ALTER INDEX ... RENAME TO` either.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Keep the symmetric `CREATE [OR REPLACE]` and `DROP [IF EXISTS]` lifecycle for functions and triggers (plus `DROP FUNCTION ... CASCADE` for 0-arg trigger functions and `DROP TABLE` cascade onto triggers), and move `ALTER FUNCTION ... RENAME TO`, `ALTER TRIGGER ... RENAME TO`, and `CONSTRAINT TRIGGER` to `## Out of scope`. This also cleanly eliminates `egm-design-critic` Issue 7 and `egm-implementation-readiness` Issue 4.
* ***Proposed Edit:***
  * Location: `Scope` (SQL expectation extractor, tests) and `Out of scope`
  * Change: Remove `ALTER FUNCTION ... RENAME TO`, `ALTER TRIGGER ... RENAME TO`, and `CONSTRAINT TRIGGER` from scope and document them in `## Out of scope`.

### [Issue 4] [`egm-design-critic`] - Severity: Major

* **Affected Scope:** `plan.md` lines 28, 33, 41, 47 (`Scope`)
* **Discrepancy Description:** Keying `snapshot.triggers` and `expectations.triggers` by `${table}.${trigger}` and using ``deleteByPrefix(state.triggers, `${table}.`)`` breaks when a double-quoted table or trigger identifier contains a dot (`.`).
* **Rationale:** PostgreSQL allows `.` in quoted identifiers but forbids NUL (`\0`).
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Store `table` and `trigger` explicitly on `TriggerRule` (matching `IndexRule`), key trigger maps by `${table}\0${trigger}` via a `makeTriggerKey(table, trigger)` helper, delete by `rule.table === table` in `recordDropTable`, and format `${rule.table}.${rule.trigger}` in human-readable reason messages.
* ***Proposed Edit:***
  * Location: `Scope` sections 1–3
  * Change: Specify `makeTriggerKey(table, trigger)` (`\0` separator), `TriggerRule` fields `{ fn, table, tag, trigger }`, and `rule.table === table` cleanup in `recordDropTable`.

### [Issue 5] [`egm-design-critic`] - Severity: Major

* **Affected Scope:** `plan.md` lines 34–38 (`Scope`) and `scripts/migrations/check-applied.ts` (lines 286–324)
* **Discrepancy Description:** `stripSqlComments` does not skip dollar-quoted blocks (`$$...$$` / `$tag$...$tag$`), so an odd apostrophe inside a nested dollar-quoted literal in a PL/pgSQL function body causes `stripSqlComments` to treat the rest of the file as a single-quoted string and leave subsequent `--> statement-breakpoint` comments unstripped before `CREATE TRIGGER`. Also `scanDollarQuoted` accepts tags starting with a digit.
* **Rationale:** Trigger-and-function migrations always contain `AS $$ ... $$` bodies directly followed by `--> statement-breakpoint` and `CREATE TRIGGER`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Skip dollar-quoted blocks in `stripSqlComments` using `scanDollarQuoted` and restrict `scanDollarQuoted` tags to `^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$` (matching PostgreSQL's lexical rule). Add a unit test verifying a function body with `$msg$it's immutable$msg$` followed by `--> statement-breakpoint` and `CREATE TRIGGER`.
* ***Proposed Edit:***
  * Location: `Scope` section 2 and section 4 (unit tests)
  * Change: Add the `stripSqlComments` and `scanDollarQuoted` fix and unit test.

### [Issue 6] [`egm-design-critic`] - Severity: Major

* **Affected Scope:** `plan.md` lines 23, 35–37, 70, 77 (`Scope`, `Risks`, `Out of scope`)
* **Discrepancy Description:** `DROP FUNCTION foo(int) CASCADE` should not remove triggers calling 0-arg `foo()`, and `CREATE OR REPLACE TRIGGER` modifying timing/events/`WHEN` with the same function name is an undocumented false-negative limitation.
* **Rationale:** PostgreSQL trigger functions have zero declared parameters; partial overload drops must not cascade to triggers.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** On `DROP FUNCTION ... CASCADE`, only cascade-remove triggers when the dropped signature has omitted or empty `()` parameters, and document both overload additions and same-function `CREATE OR REPLACE TRIGGER` event edits in `## Risks and rollback` / `## Out of scope`.
* ***Proposed Edit:***
  * Location: `Scope` section 2, `Risks and rollback`, `Out of scope`
  * Change: Add the 0-arg guard for `DROP FUNCTION ... CASCADE` and document the limitations.

### [Issue 7] [`egm-design-critic` + `egm-implementation-readiness`] - Severity: Major

* **Affected Scope:** `plan.md` lines 24, 48–50 (`Scope`)
* **Discrepancy Description:** (1) `tgenabled = 'R'` (replica-only) does not fire on primary writes yet was treated as enabled; (2) `TR` emits `fn.proname` without `fn.pronamespace`, so a trigger redirected to `other_schema.<same_name>()` falsely matches `public.<same_name>`.
* **Rationale:** Both are real catalog drift states on primary QuantVPS Postgres.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Join `pg_catalog.pg_namespace fn_ns ON fn_ns.oid = fn.pronamespace` in the `TR` branch and emit `CASE WHEN fn_ns.nspname = 'public' THEN fn.proname ELSE fn_ns.nspname || '.' || fn.proname END`. Flag `actual.enabled === "D"` as `disabled` and `actual.enabled === "R"` as `replica-only (not active on origin)`.
* ***Proposed Edit:***
  * Location: `Scope` sections 1 and 3
  * Change: Update `TR` SQL projection and `checkFunctionsAndTriggers` enabled-state checks.

### [Issue 8] [`egm-design-critic` + `egm-implementation-readiness`] - Severity: Major

* **Affected Scope:** `plan.md` lines 35–40 (`Scope`)
* **Discrepancy Description:** `CREATE TRIGGER` parsing with naive regexes can be fooled by `ON` inside quoted column lists (`UPDATE OF "on bar"`) or `EXECUTE FUNCTION` inside `WHEN (...)` string literals; schema matching `/^(?:"public"|public)\./iu` case-insensitively treats quoted `"PUBLIC".` as `public`; `"[^"]+"` rejects escaped `""` inside quoted identifiers.
* **Rationale:** Scanning `ON` and `EXECUTE` at paren depth 0 outside quotes (reusing `scanQuoted`) and checking explicit two-part `(schema, name)` with exact `"public"` / case-insensitive unquoted `public` eliminates all three parsing traps cleanly.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Use a small depth-0 quote-aware keyword scanner for `CREATE TRIGGER` (`ON` and `EXECUTE {FUNCTION|PROCEDURE}`), update quoted identifier matching to `"(?:[^"]|"")+"`, and add `parsePublicQualifiedIdent(schema, name)` accepting only omitted schema, exact `"public"`, or unquoted `public` (case-insensitive).
* ***Proposed Edit:***
  * Location: `Scope` section 2
  * Change: Specify the depth-0 quote-aware `CREATE TRIGGER` parser and `parsePublicQualifiedIdent` rule.

### [Issue 9] [`egm-design-critic` + `egm-implementation-readiness` + `egm-comprehension`] - Severity: Major

* **Affected Scope:** `plan.md` lines 24, 29, 34, 57 (`Scope`)
* **Discrepancy Description:** (1) `processStatement` only enters `processDoBlock` on `/^DO\s+\$/iu`, missing `DO LANGUAGE plpgsql $$ ... $$`; (2) `applySnapshotRecord` did not define splitting `TR` column `c` on the first `:` or fail-closed handling for malformed `TR` rows; (3) `parsePostgresSnapshot` calls `line.trimEnd()`, stripping trailing spaces from quoted identifiers at the end of `F` / `TR` rows.
* **Rationale:** Unspecified error paths violate both fail-closed parsing and 100% branch coverage.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Accept `DO [LANGUAGE <lang>] $tag$...$tag$` in `processStatement`; split `TR` column `c` at index 1 (`c.length > 2 && c[1] === ":"` and valid `tgenabled` char `O|D|R|A`, else return a parse error string); and filter blank lines in `parsePostgresSnapshot` without stripping trailing spaces from non-empty TSV lines.
* ***Proposed Edit:***
  * Location: `Scope` sections 1 and 2
  * Change: Specify `DO LANGUAGE`, strict `TR` record parsing, and non-destructive blank-line filtering.

### [Issue 10] [`egm-comprehension`] - Severity: Major

* **Affected Scope:** `plan.md` lines 45–50, 57, 84
* **Discrepancy Description:** `structuralTags`, `structuralCount`, and how structural verification interacts with `drizzle.__drizzle_migrations` are referenced without definition.
* **Rationale:** Fresh readers need to understand why zero structural expectations previously caused a false pass.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Define `tag`, `structuralTags`, `structuralCount`, and the pass/fail rule explicitly in `## Problem` / `## Scope`.
* ***Proposed Edit:***
  * Location: `Problem` and `Scope` section 3
  * Change: Define migration `tag`, `structuralTags`, `structuralCount`, and how missing reasons determine pass/fail independently of Drizzle ledger rows.

### [Issue 11] [`egm-implementation-readiness`] - Severity: Major

* **Affected Scope:** `plan.md` lines 18–66 (`Scope`)
* **Discrepancy Description:** Missing explicit `## Target Scope & File Boundary` (`Create`/`Modify`/`Delete`) and incremental `## Phasing & Checkpoints`.
* **Rationale:** Required by `implementation-readiness-standard.md` so each phase leaves the repo compiling and passing tests.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Add `## Target Scope & File Boundary` and `## Phasing & Checkpoints` tables.
* ***Proposed Edit:***
  * Location: After `## Alternatives Considered`
  * Change: Add explicit file allowlist table and incremental phases.

### [Issue 12] [`egm-implementation-readiness`] - Severity: Major

* **Affected Scope:** `plan.md` lines 26–33, 54–58 (`Scope`)
* **Discrepancy Description:** Omitted `export interface SnapshotTrigger`, `MutableSnapshot`, `parsePostgresSnapshot`/`extractMigrationExpectations` initializers, and `check-applied.test.ts` shared helpers `emptySnapshot()` / `buildSnapshot()`.
* **Rationale:** Updating `DatabaseSnapshot` requires updating these exact types and test helpers to compile cleanly.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Specify all affected internal types, initializers, and test helper signatures explicitly.
* ***Proposed Edit:***
  * Location: `Scope` sections 1, 2, and 4
  * Change: Add explicit type/initializer and test helper updates.

### [Issue 13] [`egm-implementation-readiness`] - Severity: Major

* **Affected Scope:** `plan.md` lines 45–50 (`Scope`)
* **Discrepancy Description:** Unspecified precedence when a trigger is both disabled/replica-only AND bound to the wrong function, and unspecified call order in `checkAppliedMigrations`.
* **Rationale:** Unit tests assert exact `reasons` arrays and `MAX_REASONS_PER_MIGRATION = 4`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Invoke `checkFunctionsAndTriggers` right after `checkAppGrants` in `checkAppliedMigrations`, and check enabled state and target function independently (so a trigger that is both disabled and bound to the wrong function reports both reasons in deterministic order: enabled state first, then wrong function).
* ***Proposed Edit:***
  * Location: `Scope` section 3
  * Change: Specify call order and independent enabled-state + wrong-function checks.

### [Issue 14] [`egm-implementation-readiness`] - Severity: Nit

* **Affected Scope:** `plan.md` lines 23–24, 33, 56, 59–63
* **Discrepancy Description:** `readonly` modifiers on `MigrationExpectations`, explicit SQL join predicates/`::text` casts, exact real-migration inventory (`0005`, `0008`, `0012`, `0013`), and appending steps 5–7 to the existing sequential `it(...)` block in `migration-guard.test.ts` (using `expect.arrayContaining` for `DROP FUNCTION ... CASCADE`).
* **Rationale:** Ensures exact conformance to existing file conventions and avoids brittle integration assertions.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Add these exact details to `plan.md`.
* ***Proposed Edit:***
  * Location: `Scope` sections 1, 2, and 4
  * Change: Add `readonly` modifiers, SQL join predicates, real-migration inventory, and integration test structure.

### [Issue 15] [`egm-comprehension`] - Severity: Nit

* **Affected Scope:** `plan.md` lines 33, 58, 72, 87–89
* **Discrepancy Description:** Undefined local terms ("the rig", `tag`, `scripts/ci/coverage-baseline.json`, `verify:prepush`, `public-names.ts`, `ci-gate`).
* **Rationale:** Brief inline definitions make the document self-contained for readers outside the immediate team.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Define each term briefly on first use.
* ***Proposed Edit:***
  * Location: `Problem`, `Scope`, `Risks`, `Acceptance criteria`
  * Change: Add concise inline definitions and remove release-workflow merge step from technical Acceptance criteria.

### [Issue 16] [`egm-design-critic`] - Severity: Nit

* **Affected Scope:** `plan.md` lines 41, 67–79, 89
* **Discrepancy Description:** `DROP_TABLE_RE` only captures the first table in multi-table `DROP TABLE t1, t2`; `ALTER FUNCTION ... SET SCHEMA` and `DISABLE TRIGGER` false-positive risk are unmentioned; merge step in acceptance criteria.
* **Rationale:** Clarifying boundaries prevents surprises.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** List multi-table `DROP TABLE` and `ALTER FUNCTION ... SET SCHEMA` in `## Out of scope`, note the `DISABLE TRIGGER` false-positive risk in `## Risks and rollback`, and separate merge workflow from technical acceptance criteria.
* ***Proposed Edit:***
  * Location: `Risks and rollback`, `Out of scope`, `Acceptance criteria`
  * Change: Document these boundaries explicitly.

### [Issue 17] [`egm-zoom-out`] - Severity: Nit

* **Affected Scope:** `plan.md` lines 22–50 (`Scope`)
* **Discrepancy Description:** Plan mixes architecture overview with implementation-level details (`ord` numbers, regex mechanics, exact error messages).
* **Rationale:** Zoom-Out standard prefers separating high-level contract from implementation details.
* ***AI Suggestion:*** CONTEST
* ***Justification:*** Per `AGENTS.md` (owner answer 2026-11-13) and `docs/vertex-rebuild/designs/vertex-public-main-node-modules-dangling/plan.md`, a bug-fix plan doc is a single concise document that serves as both the design spec and the implementation-readiness spec (reviewed by `egm-implementation-readiness` under `implementation-readiness-standard.md`, which requires exact types, error strings, and parser contracts). Removing those details would cause `egm-implementation-readiness` Blockers/Majors.

### [Issue 18] [`egm-zoom-out`] - Severity: Nit

* **Affected Scope:** `plan.md` lines 24, 57
* **Discrepancy Description:** Packing `tgenabled || ':' || fn_name` into column `c` introduces a colon-splitting edge case.
* **Rationale:** Minor complexity; `tgenabled` is always 1 byte.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** Keeping the 4-column (`kind, a, b, c`) snapshot table schema unchanged preserves full backward compatibility with `MIGRATIONS_SNAPSHOT_SQL` and `parsePostgresSnapshot`, and checking `c[1] === ":"` with `c.slice(2)` handles quoted function names with colons in two lines without escaping overhead.

### [Issue 19] [`egm-design-critic`] - Severity: Major (partial sub-item: `E'...'` escapes and nested `/* /* */ */` comments in `stripSqlComments`)

* **Affected Scope:** `scripts/migrations/check-applied.ts` (lines 270–324)
* **Discrepancy Description:** `scanQuoted` does not handle backslash escapes in `E'...'` strings, and `stripSqlComments` does not track nested `/* /* */ */` block comments.
* **Rationale:** Could mis-strip if a migration uses `E'can\'t'` or nested block comments.
* ***AI Suggestion:*** DECLINE
* ***Justification:*** The dollar-quoted body fix (`scanDollarQuoted` inside `stripSqlComments`, Issue 5 above) addresses the real trigger/function failure mode (PL/pgSQL bodies using `$$` or `$tag$` containing apostrophes or `--`). None of the 104 repository migrations use `E'...'` backslash-escaped quotes or nested `/* /* */ */` block comments; adding speculative lexer states for unused syntax would add untested branches under the 100% coverage requirement. Both are documented as known scanner boundaries in `## Out of scope`.
