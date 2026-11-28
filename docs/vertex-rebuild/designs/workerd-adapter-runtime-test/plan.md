# Workerd outbound adapter RequestInit runtime test

![Before vs after: workerd outbound adapter runtime replay](before-after.png)

## Goal

Run every workerd-reachable outbound HTTP adapter's actual `RequestInit` inside the repository's pinned `workerd` runtime (configured with `compatibility_date` and `compatibility_flags` from `apps/web/wrangler.jsonc`) against a loopback `200`/`302` HTTP server during CI (`verify:prepush` and `verify:coverage`), and fail if a new outbound `fetch` file is added without coverage.

## Background

Card `vertex-workerd-adapter-runtime-test` is the follow-up gap from `docs/vertex-rebuild/designs/workerd-fetch-redirect/plan.md`. Unit tests run under Node, which accepts `RequestInit` values that Cloudflare `workerd` rejects with a `TypeError` before sending any request:

- `redirect: "error"` -> `TypeError: Invalid redirect value, must be one of "follow" or "manual"`
- `cache: "default"`, `"force-cache"`, `"only-if-cached"`, `"reload"` -> `TypeError: Unsupported cache mode`

`scripts/ci/fetch-redirect.test.ts` blocks single-line literal `redirect: "error"` statically, but cannot catch variable/multi-line redirect modes, SDK-built `RequestInit` objects, or non-redirect options such as `cache` modes.

## Design

1. **`scripts/ci/workerd-replay.ts` (100% covered helper):**
   - Reads `compatibility_date` (`2026-07-22`) and `compatibility_flags` (`["nodejs_compat"]`) from `apps/web/wrangler.jsonc` using `jsonc-parser` and Zod.
   - Resolves the pinned `workerd` binary (`workerd@1.20261023.1`) from `apps/web/package.json` through `wrangler` -> `miniflare` -> `workerd` (zero new npm dependencies, zero lockfile changes).
   - Starts a loopback-only `workerd` worker (`globalOutbound = "loopback"` with `network = (allow = ["local"])`) and a Node loopback HTTP server supporting `200` and `302` (`Location: /__workerd-redirect-target`) responses.
   - Serializes every `RequestInit` field from `fetch(url, init)` and `fetch(new Request(...))` (preserving method, headers, body, redirect, credentials, cache, referrerPolicy, mode, integrity, keepalive, AbortSignal presence/abort state, and any additional own properties), replays the call inside `workerd`, and returns the real `Response` or rethrows `workerd`'s `TypeError`/`Error`.
   - Scans tracked non-test source files under `packages/` and `apps/` that call `fetch` / `fetcher` / `fetchImpl` so new adapters cannot slip past the suite.
2. **`scripts/ci/workerd-adapter-fetch.test.ts` (Vitest `operations` project):**
   - Self-checks that the running `workerd` rejects `redirect: "error"` and `cache: "default"` before touching loopback (`serverHits === 0`).
   - Replays all 28 workerd-reachable outbound adapters across 6 packages (`packages/analytics`, `packages/email`, `packages/notifications`, `packages/ai`, `packages/api`, and `apps/web`) against both `200` and `302` loopback responses.
   - Verifies zero `workerd` errors on all 28 adapters, and verifies that all 27 first-party manual-redirect adapters send `redirect: "manual"`, receive `302`, and never hit `/__workerd-redirect-target`.
   - Enforces the inventory invariant against `discoverOutboundFetchFiles()` with an explicit, audited list of 9 non-workerd/browser/internal-dispatch files.
3. **`scripts/ci/workerd-replay.test.ts` (Vitest `operations` project):**
   - Unit and runtime tests covering `workerd-replay.ts` at 100% lines, branches, functions, and statements.

## Acceptance Check

1. `scripts/ci/workerd-replay.test.ts` and `scripts/ci/workerd-adapter-fetch.test.ts` pass in the `operations` project with 100% coverage on `scripts/ci/workerd-replay.ts`.
2. Negative mutation checks confirm that reintroducing `redirect: "error"` in `packages/api/src/server/options-chain-nasdaq.ts` or introducing `cache: "default"` in `packages/analytics/src/server/posthog.ts` fails `workerd-adapter-fetch.test.ts` with `workerd`'s real `TypeError`.
3. `bun run verify:prepush` and hosted PR CI (`ci-gate`) pass cleanly.

## Rollback

Revert the PR commit. No database migrations, runtime code, or production deployments are affected.
