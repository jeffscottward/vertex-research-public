# `/stock` Put/call OI KPI: keep the value short

![Dark before/after infographic. The after panel is an implemented UI mock; counts are illustrative, not live data.](before-after.svg)

**Date:** 2026-11-21  
**Status:** Implementation complete on branch `ws/put-call-oi-tile-shows-a-2` (2026-11-25 revision: the value reads `No ratio` in place of a bare dash, the detail texts are shorter, and no allow-list entry is added). The results are in "Verification record" below; the document check is in [the drift report of 2026-11-25](2026-11-25_DRIFT_REPORT.md).
**Scope:** UI display only. Keep options-chain data and risk behavior unchanged.

## Problem and goal

The Put/call OI tile puts a long “No put/call ratio…” explanation in the `StatCard` value slot. `StatCard` renders the value as `text-2xl`; its description is muted `text-sm`. The tile should show a formatted ratio when one is valid, or the two words `No ratio` otherwise. Put the reason and coverage counts in the muted description.

The chain on the page belongs to the expiry selected in the options-chain control. Every detail text speaks for "the returned chain": the contracts in the chain response currently shown, which can be fewer than the expiry lists.

Quant Data derives OI from order-flow prints, reads only the first provider page, and sets OI to `null` when no print reports it. The merge preserves that null when Yahoo has no value. Merged PR #372 labels null chain cells “no OI” with the title “Open interest not sent by the source”. Keep that table behavior.

## Goals and non-goals

### Goals

- Keep the large tile value short: show the numeric ratio only when all listed calls and puts report OI and total call OI is above zero; show `No ratio` otherwise. The value is words, because the status language rule (owner rule 2026-11-11, [testing guide](../../../testing.md#status-language-guards)) does not accept a bare dash or the word "unavailable" as a status.
- Show a concise reason and OI coverage counts in the muted description.
- Keep no contracts, no reported OI, reported zero OI, incomplete coverage, loading, no answer, and error states distinct.

### Non-goals

- Do not change the API contract, OI null semantics, provider requests, pagination, options-chain merge, orders, or risk settings.
- Do not claim the returned chain contains every contract for the selected expiry.

## Proposed display

| Chain state | Large value | Muted detail |
| --- | --- | --- |
| All listed call and put contracts report OI; call OI is positive and put OI is positive | Formatted put/call OI ratio | OI reported for N of N calls and M of M puts in the returned chain |
| All listed call and put contracts report OI; call OI is positive and put OI total is zero | `0.00` | OI reported for N of N calls and M of M puts in the returned chain |
| No call or put contracts are listed | `No ratio` | No contracts in the returned chain |
| Contracts on both sides, no OI values reported | `No ratio` | OI reported for 0 of N calls and 0 of M puts in the returned chain |
| Some OI values are reported, but one or more listed contracts lack OI | `No ratio` | OI reported for C of N calls and P of M puts in the returned chain |
| No call contracts; put contracts are listed | `No ratio` | No call contracts; OI reported for P of M puts in the returned chain |
| No put contracts; call contracts are listed | `No ratio` | No put contracts; OI reported for C of N calls in the returned chain |
| Both sides are complete and both OI totals are zero | `No ratio` | Reported call and put OI totals are 0 |
| Both sides are complete, call OI is zero, and put OI is above zero | `No ratio` | Call OI is 0; a ratio needs call OI above 0 |
| Loading | `No ratio` | Loading… |
| No answer after the configured timeout | `No ratio` | Not loaded: no answer after N s, where N is `CHAIN_REQUEST_TIMEOUT_MS / 1000` |
| Request error | `No ratio` | Not loaded: the existing user-facing failure message |

`C/N` means calls with OI reported / call contracts in the returned chain. `P/M` means puts with OI reported / put contracts in the returned chain. Coverage counts use only contracts in the current chain response; they do not show full-expiry provider coverage.

## Alternatives considered

- **Keep the full explanation in the value.** Reject this because the large `text-2xl` slot wraps long sentences and makes the metric hard to scan.
- **Put one status word in the value with no detail.** Reject this because "partial" alone hides the reason and the call and put coverage counts.
- **Show a bare dash in the value and the explanation in the muted description.** The first version of this plan chose this. Reject it (revision of 2026-11-25): the status language guard counts a bare dash as a vague placeholder, so the change needed two new entries in `apps/web/src/status-language-allowlist.ts`. New code follows the rule instead of extending the allow list.
- **Show `No ratio` in the value and the state-specific reason in the existing muted description.** Choose this because the value stays short and definite, the states stay distinct, and the existing `StatCard` slots are reused without a change to chain data or a new component.

## Risks and limits

- **Coverage interpretation:** Quant Data reads only its first provider page. Counts describe the returned chain response, not the full expiry. State this in the detail and do not imply complete expiry coverage. Provider pagination is deliberately deferred.
- **The ratio is rare on large live chains:** the ratio shows only when every listed contract reports OI. In the live trace below, 1 of 213 SPY calls had no OI, so the tile reads `No ratio` with the counts. This plan keeps that rule; a ratio from the reported contracts is a behavior change for its own PR (card vertex-stock-pc-ratio-partial-oi).
- **State confusion:** `No ratio` alone does not distinguish missing data from a reported zero or a failed request. The muted detail gives the reason; use the state mapping above and test each row.
- **Security and scalability:** This UI-only change adds no data access, persistence, provider request, or request volume. It introduces no new security or scalability risk.
- **Page-level overflow:** The post-merge browser run at 1024 px measured `document.scrollWidth` 1179 px against `innerWidth` 1024 px; the overflowing element was the existing options-chain table (`min-w-[60rem]`). The table remains outside this KPI task and is read-only. This task checks that the OI detail stays inside its tile and does not claim to fix page-level overflow.
- **Rollback:** Revert the focused UI commit to restore the current value formatting.

## Acceptance checks

1. A complete chain with positive call OI shows the formatted numeric ratio in the value slot. This includes zero reported put OI, which shows `0.00`. The detail gives the number of calls and puts behind the ratio.
2. No contracts, only one side of contracts, no reported OI, incomplete coverage, both sides reported as zero, and complete zero-call OI produce the value and distinct detail shown in the table above. Coverage counts use the returned chain only.
3. Loading, timeout/no-answer, and request-error states show `No ratio` as the Put/call OI value and retain their distinct status in muted detail.
4. Component tests assert both the value and muted detail that `chainKpis` returns for every state in the table, and check the rendered `StatCard` slots (first and second `dd`) for the loading and no-answer states. The tests of the other three tiles stay: every field of the not-ready states, the price, strike and IV values of a full chain, the texts for a chain without price and strikes, and the text for a strike without IV. The Playwright regression in `tests/e2e/stock-detail.spec.ts` mocks null OI on `/stock/NVDA?tab=options`, checks the exact `No ratio` value and returned-chain coverage string, and confirms the table still shows “no OI”.
5. At 375, 768, 1024, and 1440 px, the Playwright check confirms the detail stays inside the tile. At 375 px, it also confirms that the detail wraps. Page-level overflow from the existing options-chain table is recorded as a separate limitation, not a KPI acceptance check.
6. The UI-only change does not alter API output, OI null semantics, provider requests, pagination, orders, or risk behavior.

## Implementation plan

### Phase 1 — Separate the KPI value and detail

**Modify:** `apps/web/src/features/stock-detail/stock-detail-workspace.tsx`  
**Modify:** `apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx`
**Not modified:** `apps/web/src/status-language-allowlist.ts` (the new texts pass the status language guard as written)

1. Extend `ChainKpis` with separate `putCallOiValue` and `putCallOiDetail` fields. Render them in the Put/call OI `StatCard` value and muted-description slots. Keep the price, expiry, strike, and IV fields unchanged.
2. For every non-ready chain, set the value to `No ratio` and set the detail to the existing `chainNotReadyText(state)`. This keeps the existing loading, configured-timeout, and request-failure messages.
3. For a ready chain, apply these rules (each state matches one rule, so the order does not change the result):
   - If `summary.putCallOi !== null`, show `summary.putCallOi.toFixed(2)` and `OI reported for N of N calls and M of M puts in the returned chain`. This includes complete calls with positive OI and a reported put total of zero; the value is `0.00`.
   - If both `calls.contracts` and `puts.contracts` are zero, show `No ratio` and `No contracts in the returned chain`.
   - If `calls.contracts` is zero, show `No ratio` and `No call contracts; OI reported for P of M puts in the returned chain`, where P=`puts.reported` and M=`puts.contracts`. If `puts.contracts` is zero, show `No ratio` and `No put contracts; OI reported for C of N calls in the returned chain`, where C=`calls.reported` and N=`calls.contracts`.
   - If both sides have contracts and one or both sides have a contract with no reported OI (this includes 0 reported on both sides), show `No ratio` and `OI reported for C of N calls and P of M puts in the returned chain`, using each side's `reported/contracts` counts. One code branch covers these states.
   - If both sides are complete and both totals are zero, show `No ratio` and `Reported call and put OI totals are 0`.
   - If both sides are complete, call OI is zero, and put OI is positive, show `No ratio` and `Call OI is 0; a ratio needs call OI above 0`.
4. Add component assertions for the value and detail of every row in the proposed display table, including complete calls with zero put OI (expect `0.00`), loading, timeout, and request error. First add an assertion that fails against the current long-value behavior. Run `pnpm exec vitest run apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx` to confirm the failure, implement the change, then run the same command and require a pass. A green focused run is the Phase 1 checkpoint.
5. Do not add an entry to `apps/web/src/status-language-allowlist.ts`. Run `pnpm exec vitest run --config vitest.config.ts --project unit apps/web/src/status-language.test.ts` and require a pass with the allow list unchanged.

### Phase 2 — Keep a browser regression for null OI

**Modify:** `tests/e2e/stock-detail.spec.ts`  
The temporary reproduction test was removed after its regression moved to the permanent suite.

1. Extend `mockMarketData(page)` with an opt-in partial-OI fixture. The fake gateway returns 41 strikes with one call and one put per strike. For row indexes 0 through 40, set call `openInterest` to `null` when `index % 3 === 0` and put `openInterest` to `null` when `index % 4 === 0`; leave other contracts unchanged. This gives 27/41 reported calls and 30/41 reported puts. Keep the default fixture unchanged for all existing tests.
2. Add the Playwright test named `stock detail keeps partial put/call OI details within the tile at target widths` for `/stock/NVDA?tab=options`. Assert the value is `No ratio`, the muted detail is exactly `OI reported for 27 of 41 calls and 30 of 41 puts in the returned chain`, and, with `All strikes` selected, exactly 25 cells of the split table (14 + 11, the count of call and put contracts the fixture sets to null) carry the title `Open interest not sent by the source`, and the first of them reads `no OI`. This ties the table to the tile counts: the table shows `no OI` only where the chain response has a null.
3. Use the card locator `page.locator("[data-stock-kpis] dl").filter({ has: page.getByText("Put/call OI", { exact: true }) })` and its second `dd` as the detail. At each width 375, 768, 1024, and 1440 px, set viewport height to 1100 px; compare the detail's `getBoundingClientRect().left/right` with the containing `dl` rectangle and require it to stay within those bounds. Also require `scrollWidth <= clientWidth` on the detail, because a block keeps its box when its text overflows. At 375 px, require the detail rectangle height to exceed 1.5 times its computed CSS line height, proving that the detail wraps to multiple lines. At every width, require the value rectangle height to stay under 1.5 times its line height: the value is one line.
4. Remove the temporary reproduction file after its assertions are in the permanent test. Run `bun run build`, then `bun run test:e2e --grep "stock detail keeps partial put/call OI details within the tile at target widths"`. The build must pass before the E2E run because the test server reads `.wrangler/deploy/config.json`. Both passing commands are the Phase 2 checkpoint.

### Phase 3 — Review, commit, and open the PR

1. Run `bun run verify:prepush`. Commit with the `commit` namespace; `git log` of the branch lists the commits.
2. Before the first push, run `git fetch origin` and `git rebase origin/vertex/rebuild-darkfactory-20260921` in this worktree. After a conflict or rebase, rerun the Phase 1 and Phase 2 focused checks and `bun run verify:prepush`. If the branch has already been pushed, merge `origin/vertex/rebuild-darkfactory-20260921` into it instead of rebasing pushed commits.
3. At the post-rebase commit, record the full SHA with `git rev-parse HEAD` and have a fresh-context reviewer inspect the complete diff at that SHA. Resolve every finding before the PR is opened; if resolution changes code, repeat the focused checks and review the new full SHA. The PR body must include `Agent review: <40-character reviewed SHA>` and `Owner decision: not needed (this UI-only change does not alter risk, orders, arming, or permissions)`.
4. Push under the repository pre-push lock with `flock /tmp/vertex-research-public-prepush.lock git -C <worktree> push -u origin ws/put-call-oi-tile-shows-a-2`. Run `gh pr view ws/put-call-oi-tile-shows-a-2`; if it has no open PR, run `gh pr create --draft --fill --base vertex/rebuild-darkfactory-20260921 --head ws/put-call-oi-tile-shows-a-2`, otherwise keep using its open PR.
5. Immediately after opening the PR, run `pr-visual <PR_URL> --before-url <base-preview>/stock/NVDA?tab=options --after-url <head-preview>/stock/NVDA?tab=options --mock`. Use only deterministic mock data and no secrets, accounts, positions, or NLV. Verify the generated dark before/after graphic is at the top of the PR description. Re-run it if the change moves. Then update the PR body with `gh pr edit <PR> --body-file <temporary-file>`; keep the graphic Markdown as the first line and include `Agent review: <40-character reviewed SHA>`, `Owner decision: not needed (this UI-only change does not alter risk, orders, arming, or permissions)`, test results, risk, and revert instructions. Read back `gh pr view <PR> --json body` and verify the image is still first and both evidence lines are present. When implementation and review are complete, run `gh pr ready <PR>`.
6. Record `SHA=$(git rev-parse HEAD)`. Read `gh pr view <PR> --json headRefOid,url,isDraft,state` and require `headRefOid` to equal the full `SHA`. Run `timeout 3600 gh pr checks <PR> --watch`; require every check that branch protection requires for the base to pass on that head (`ci-gate` when this plan was revised; `scripts/merge-pr` reads the live rules). Re-read the PR head SHA and require it still equals `SHA`. Then run `scripts/merge-pr <PR> --card vertex-stock-pc-tile-oi-dashes --head "$SHA"` (add `--wait <minutes>` if the base claim is held). Verify the merge result from `gh pr view <PR> --json state,mergedAt,mergeCommit` and the script's tree check. Do not substitute plain `gh pr merge`.
7. The task is complete only when the exact reviewed PR head has passing required checks, the PR merge is verified, and the resulting tree contains the UI change. Do not change provider pagination, API output, OI null semantics, orders, or risk behavior.

## Chain OI cells: display or data (live trace, 2026-11-26 03:05 UTC)

The card also reported that chain OI cells showed a dash near the money while the tile counted OI for most contracts. A read-only trace of the live page (headless Chrome, read-only viewer account, market data only) compared every OI cell of the table with the chain response of the same page load:

| Symbol, expiry | Strike rows | Calls with OI | Puts with OI | Cells that differ from the response |
| --- | --- | --- | --- | --- |
| SPY, 2026-11-27 | 219 | 212 of 213 | 190 of 192 | 0 |
| NVDA, 2026-11-27 | 122 | 121 of 122 | 108 of 108 | 0 |

- **Display:** the table renders the response value for every contract and `no OI` only for a null (`formatCell` in `options-chain-table.tsx`; merged PR #372 replaced the dash with `no OI`). There is no display bug. The tile and the table read the same `openInterest` field; the tile counts all returned strikes and the table shows the selected strike window (20 by default).
- **Data:** the nulls are contracts for which no source sent OI. The same trace found a separate data fault that this UI plan does not change: where Quant Data is the OI source, it sent `0` for round strikes next to the money (SPY 700, 705, 710 and 715 puts and the 720 call; NVDA 140 and 150 calls and the 150 put) while neighbor strikes carry thousands of contracts. The merge takes Quant Data before Yahoo for OI, so that `0` replaces the Yahoo value. This needs provider evidence and an API change in its own PR (card vertex-chain-oi-quantdata-zero).

## Verification record (2026-11-25, branch `ws/put-call-oi-tile-shows-a-2`)

| Check | Result |
| --- | --- |
| `pnpm exec vitest run --config vitest.config.ts --project unit apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx apps/web/src/status-language.test.ts` | Passed: 2 files, 27 tests (after the review fixes). The allow list is the same as on the base. |
| `bun run build` | Passed (exit 0). |
| `pnpm run test:e2e -- tests/e2e/stock-detail.spec.ts` (this form ran the whole browser suite) | Passed: 139 tests, 2 skipped. The 4 stock-detail tests passed, and passed again after the review fixes (`pnpm exec playwright test tests/e2e/stock-detail.spec.ts --project=e2e` under `scripts/with-test-env.ts`, after a new build). |
| `bun run verify:prepush`, steps format, lint, auth schema, OpenAPI, typecheck and docs check | Passed. |
| `bun run verify:prepush`, steps `test:gateway`, `test:unit` (the jobs package) and `test:operations` | Not passed in the sandbox of this job. The job ran in a user namespace that shows root-owned directories with another owner, and three trust checks refuse that: `services/gateway/test_infrastructure_probe.py` (10 of 29 tests), `packages/jobs` (98 tests in 1 file, "OMP git executable is unavailable") and `scripts/graph/system.test.ts` with `scripts/vertex-config/reviewed-apply.test.ts` ("temporary base is unsafe"). No failing file is in this change. The gate must pass on a host without that sandbox before the push; the hosted checks then decide. |
| `bun run test:contract` | Passed: 57 files, 654 tests. |
| `pnpm exec vitest run --config vitest.config.ts --project operations scripts/init/leftovers.test.ts` | Passed: 5 tests, after a home path was removed from this plan. |
| Live trace of the table against the chain response | 0 differing cells (section "Chain OI cells: display or data"). |

### Code review, round 1 (fresh-context reviewer, 2026-11-25)

The reviewer read the full diff of the branch before these fixes. Verdict: 2 major and 2 minor findings, all fixed in the next commit.

- Major: the first version of the test rewrite had removed the tests of the other three tiles (price, strike and IV of a full chain; a chain without price and strikes; a strike without IV), and the not-ready tests checked only the Put/call OI fields. Fixed: the tests are back and assert every field.
- Minor: `OI for the selected expiry` and `No contracts for the selected expiry` spoke for the whole expiry. Fixed: `OI reported for N of N calls and M of M puts in the returned chain` and `No contracts in the returned chain`.
- Minor: no test had one side without contracts and the other side partly reported. Fixed: two cases added.

### Code review, round 2 (fresh-context reviewer, 2026-11-25, after the rebase)

Verdict: pass, with 3 minor findings and 2 notes. All fixed in the next commit.

- Minor: the rendered KPI row had lost the base assertion that it holds no bare dash while loading. Fixed: the assertion is back.
- Minor: the browser test compared boxes, which a block keeps even when its text overflows. Fixed: it also requires `scrollWidth <= clientWidth` on the detail.
- Minor: this plan listed the commits of the branch and missed later ones. Fixed: the plan points to `git log`.
- Note: the rules of step 3 were "in order" in another order than the code. Fixed: the plan says that the order does not change the result.
- Note: "all 1 calls and 1 puts" for a one-contract chain. Changed: with a ratio the detail uses the same sentence as for a side that lacks OI (`OI reported for N of N calls and M of M puts in the returned chain`).
- Not changed (design notes): the value reads `No ratio` while the chain loads, with `Loading…` as the detail; the one-line check of the value in the browser test stays as a layout guard.

## Files and evidence

### Modify

- `apps/web/src/features/stock-detail/stock-detail-workspace.tsx`
- `apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx`
- `tests/e2e/stock-detail.spec.ts`
- `docs/vertex-rebuild/designs/stock-pc-oi-tile/before-after.svg` (dark UI mock; counts are illustrative)

### Removed before task completion

- The temporary pre-fix reproduction was deleted after its null-OI assertions moved to the permanent stock-detail suite.

### Read only

- `apps/web/src/features/stock-detail/options-chain-table.tsx`
- `apps/web/src/features/stock-detail/options-chain-table.test.tsx`
- `packages/api/src/options-chain-merge.ts`
- `packages/api/src/server/options-chain-quantdata.ts`
- `packages/api/src/contracts/options-chain.ts`

The pre-fix Playwright reproduction confirmed that a null-OI route shows `no OI` in the table while the large KPI value contains the long explanation.

## Reading list for review

- [Stock detail workspace](../../../../apps/web/src/features/stock-detail/stock-detail-workspace.tsx)
- [Stock detail tests](../../../../apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx)
- [Stock detail E2E tests](../../../../tests/e2e/stock-detail.spec.ts)
- [Options-chain table](../../../../apps/web/src/features/stock-detail/options-chain-table.tsx)
- [Options-chain merge](../../../../packages/api/src/options-chain-merge.ts)
- [Quant Data chain adapter](../../../../packages/api/src/server/options-chain-quantdata.ts)
- [Options-chain contract](../../../../packages/api/src/contracts/options-chain.ts)
- [StatCard](../../../../packages/ui/src/stat-card.tsx)
- [Authoritative UI specification](../../../../design-system/darkfactory/MASTER.md)
- [Project UI context](../../../../.impeccable.md)
