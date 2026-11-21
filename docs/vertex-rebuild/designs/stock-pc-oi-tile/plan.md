# `/stock` Put/call OI KPI: keep the value short

![Dark before/after infographic. The after panel is a proposed mock, not a live screenshot.](before-after.svg)

**Date:** 2026-11-21  
**Status:** Plan and acceptance checks, before code changes  
**Scope:** UI display only. Keep options-chain data and risk behavior unchanged.

## Problem and goal

The Put/call OI tile puts a long “No put/call ratio…” explanation in the `StatCard` value slot. `StatCard` renders the value as `text-2xl`; its description is muted `text-sm`. The tile should show a formatted ratio when one is valid, or a short `—` otherwise. Put the reason and coverage counts in the muted description.

“Selected expiry” means the expiry selected in the options-chain control. OI counts describe the contracts in the chain response currently shown.

Quant Data derives OI from order-flow prints, reads only the first provider page, and sets OI to `null` when no print reports it. The merge preserves that null when Yahoo has no value. Merged PR #372 labels null chain cells “no OI” with the title “Open interest not sent by the source”. Keep that table behavior.

## Goals and non-goals

### Goals

- Keep the large tile value short: show the numeric ratio only when all listed calls and puts report OI and total call OI is above zero; show `—` otherwise.
- Show a concise reason and OI coverage counts in the muted description.
- Keep no contracts, no reported OI, reported zero OI, incomplete coverage, loading, no answer, and error states distinct.

### Non-goals

- Do not change the API contract, OI null semantics, provider requests, pagination, options-chain merge, orders, or risk settings.
- Do not claim the returned chain contains every contract for the selected expiry.

## Proposed display

| Chain state | Large value | Muted detail |
| --- | --- | --- |
| All listed call and put contracts report OI; call OI is positive and put OI is positive | Formatted put/call OI ratio | OI for the selected expiry |
| All listed call and put contracts report OI; call OI is positive and put OI total is zero | `0.00` | OI for the selected expiry |
| No call or put contracts are listed | `—` | No contracts for the selected expiry |
| Contracts on both sides, no OI values reported | `—` | Calls OI reported for 0 of N contracts; puts OI reported for 0 of M contracts in this returned chain |
| Some OI values are reported, but one or more listed contracts lack OI | `—` | Calls OI reported for C of N contracts; puts OI reported for P of M contracts in this returned chain |
| No call contracts; put contracts are listed | `—` | No call contracts; put OI reported for P of M contracts in this returned chain |
| No put contracts; call contracts are listed | `—` | No put contracts; call OI reported for C of N contracts in this returned chain |
| Both sides are complete and both OI totals are zero | `—` | Reported call and put OI totals are zero |
| Both sides are complete, call OI is zero, and put OI is above zero | `—` | Call OI is zero; the ratio is unavailable |
| Loading | `—` | Loading… |
| No answer after the configured timeout | `—` | Not loaded: no answer after N s, where N is `CHAIN_REQUEST_TIMEOUT_MS / 1000` |
| Request error | `—` | Not loaded: the existing user-facing failure message |

`C/N` means calls with OI reported / call contracts in the returned chain. `P/M` means puts with OI reported / put contracts in the returned chain. Coverage counts use only contracts in the current chain response; they do not show full-expiry provider coverage.

## Alternatives considered

- **Keep the full explanation in the value.** Reject this because the large `text-2xl` slot wraps long sentences and makes the metric hard to scan.
- **Put a short status word in the value.** Reject this because “partial” or “unavailable” alone hides the reason and call/put coverage counts.
- **Show `—` in the value and move the state-specific explanation into the existing muted description.** Choose this because it keeps the metric compact, preserves distinctions, and reuses the existing `StatCard` slots without changing chain data or adding a component.

## Risks and limits

- **Coverage interpretation:** Quant Data reads only its first provider page. Counts describe the returned chain response, not the full expiry. State this in the detail and do not imply complete expiry coverage. Provider pagination is deliberately deferred.
- **State confusion:** A dash alone cannot distinguish missing data from reported zero or a failed request. Use the state mapping above and test each row.
- **Security and scalability:** This UI-only change adds no data access, persistence, provider request, or request volume. It introduces no new security or scalability risk.
- **Page-level overflow:** The post-merge browser run at 1024 px measured `document.scrollWidth` 1179 px against `innerWidth` 1024 px; the overflowing element was the existing options-chain table (`min-w-[60rem]`). The table remains outside this KPI task and is read-only. This task checks that the OI detail stays inside its tile and does not claim to fix page-level overflow.
- **Rollback:** Revert the focused UI commit to restore the current value formatting.

## Acceptance checks

1. A complete chain with positive call OI shows the formatted numeric ratio in the value slot. This includes zero reported put OI, which shows `0.00`. The detail identifies OI for the selected expiry.
2. No contracts, only one side of contracts, no reported OI, incomplete coverage, both sides reported as zero, and complete zero-call OI produce the value and distinct detail shown in the table above. Coverage counts use the returned chain only.
3. Loading, timeout/no-answer, and request-error states show `—` as the Put/call OI value and retain their distinct status in muted detail.
4. Component tests assert both the value and muted detail for every state in the table and verify their existing `StatCard` slots. The Playwright regression in `tests/e2e/stock-detail.spec.ts` mocks null OI on `/stock/NVDA?tab=options`, checks the exact `—` value and returned-chain coverage string, and confirms the table still shows “no OI”.
5. At 375, 768, 1024, and 1440 px, the Playwright check confirms the detail stays inside the tile. At 375 px, it also confirms that the detail wraps. Page-level overflow from the existing options-chain table is recorded as a separate limitation, not a KPI acceptance check.
6. The UI-only change does not alter API output, OI null semantics, provider requests, pagination, orders, or risk behavior.

## Implementation plan

### Phase 1 — Separate the KPI value and detail

**Modify:** `apps/web/src/features/stock-detail/stock-detail-workspace.tsx`  
**Modify:** `apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx`
**Modify:** `apps/web/src/status-language-allowlist.ts` (add the two new UI strings with specific reasons)

1. Extend `ChainKpis` with separate `putCallOiValue` and `putCallOiDetail` fields. Render them in the Put/call OI `StatCard` value and muted-description slots. Keep the price, expiry, strike, and IV fields unchanged.
2. For every non-ready chain, set the value to `—` and set the detail to the existing `chainNotReadyText(state)`. This keeps the existing loading, configured-timeout, and request-failure messages.
3. For a ready chain, apply these rules in order:
   - If `summary.putCallOi !== null`, show `summary.putCallOi.toFixed(2)` and `OI for the selected expiry`. This includes complete calls with positive OI and a reported put total of zero; the value is `0.00`.
   - If both `calls.contracts` and `puts.contracts` are zero, show `—` and `No contracts for the selected expiry`.
   - If `calls.contracts` is zero, show `—` and `No call contracts; put OI reported for P of M contracts in this returned chain`, where P=`puts.reported` and M=`puts.contracts`. If `puts.contracts` is zero, show `—` and `No put contracts; call OI reported for C of N contracts in this returned chain`, where C=`calls.reported` and N=`calls.contracts`.
   - If both sides have contracts and both `reported` counts are zero, show `—` and `Calls OI reported for 0 of N contracts; puts OI reported for 0 of M contracts in this returned chain`, using the returned-chain contract totals.
   - If either side has unreported contracts, show `—` and `Calls OI reported for C of N contracts; puts OI reported for P of M contracts in this returned chain`, using each side's `reported/contracts` counts.
   - If both sides are complete and both totals are zero, show `—` and `Reported call and put OI totals are zero`.
   - If both sides are complete, call OI is zero, and put OI is positive, show `—` and `Call OI is zero; the ratio is unavailable`.
4. Add component assertions for the value and detail of every row in the proposed display table, including complete calls with zero put OI (expect `0.00`), loading, timeout, and request error. First add an assertion that fails against the current long-value behavior. Run `pnpm exec vitest run apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx` to confirm the failure, implement the change, then run the same command and require a pass. A green focused run is the Phase 1 checkpoint.
5. Add the new compact placeholder and zero-call explanation to `apps/web/src/status-language-allowlist.ts` with specific reasons. Run `pnpm exec vitest run apps/web/src/status-language.test.ts` and require a pass; do not change unrelated allowlist entries.

### Phase 2 — Keep a browser regression for null OI

**Modify:** `tests/e2e/stock-detail.spec.ts`  
The temporary reproduction test was removed after its regression moved to the permanent suite.

1. Extend `mockMarketData(page)` with an opt-in partial-OI fixture. The fake gateway returns 41 strikes with one call and one put per strike. For row indexes 0 through 40, set call `openInterest` to `null` when `index % 3 === 0` and put `openInterest` to `null` when `index % 4 === 0`; leave other contracts unchanged. This gives 27/41 reported calls and 30/41 reported puts. Keep the default fixture unchanged for all existing tests.
2. Add the Playwright test named `stock detail keeps partial put/call OI details within the tile at target widths` for `/stock/NVDA?tab=options`. Assert the value is `—`, the muted detail is exactly `Calls OI reported for 27 of 41 contracts; puts OI reported for 30 of 41 contracts in this returned chain`, and a null-OI cell still reads `no OI` with title `Open interest not sent by the source`.
3. Use the card locator `page.locator("[data-stock-kpis] dl").filter({ has: page.getByText("Put/call OI", { exact: true }) })` and its second `dd` as the detail. At each width 375, 768, 1024, and 1440 px, set viewport height to 1100 px; compare the detail's `getBoundingClientRect().left/right` with the containing `dl` rectangle and require it to stay within those bounds. At 375 px, require the detail rectangle height to exceed 1.5 times its computed CSS line height, proving that the detail wraps to multiple lines.
4. Remove the temporary reproduction file after its assertions are in the permanent test. Run `bun run build`, then `bun run test:e2e --grep "stock detail keeps partial put/call OI details within the tile at target widths"`. The build must pass before the E2E run because the test server reads `.wrangler/deploy/config.json`. Both passing commands are the Phase 2 checkpoint.

### Phase 3 — Review, commit, and open the PR

1. Run `bun run verify:prepush`. Create the focused Conventional Commit with the `commit` namespace and subject `fix: keep stock put-call OI KPI value compact`.
2. Before the first push, run `git fetch origin` and `git rebase origin/vertex/rebuild-darkfactory-20260921` in this worktree. After a conflict or rebase, rerun the Phase 1 and Phase 2 focused checks and `bun run verify:prepush`. If the branch has already been pushed, merge `origin/vertex/rebuild-darkfactory-20260921` into it instead of rebasing pushed commits.
3. At the post-rebase commit, record the full SHA with `git rev-parse HEAD` and have a fresh-context reviewer inspect the complete diff at that SHA. Resolve every finding before the PR is opened; if resolution changes code, repeat the focused checks and review the new full SHA. The PR body must include `Agent review: <40-character reviewed SHA>` and `Owner decision: not needed (this UI-only change does not alter risk, orders, arming, or permissions)`.
4. Push under the repository pre-push lock with `flock /tmp/vertex-research-public-prepush.lock git -C /home/jeffscottward/Github/trading/vertex-research-public-wt-put-call-oi-tile-shows-a push -u origin ws/put-call-oi-tile-shows-a`. Run `gh pr view ws/put-call-oi-tile-shows-a`; if it has no open PR, run `gh pr create --draft --fill --base vertex/rebuild-darkfactory-20260921 --head ws/put-call-oi-tile-shows-a`, otherwise keep using its open PR.
5. Immediately after opening the PR, run `pr-visual <PR_URL> --before-url <base-preview>/stock/NVDA?tab=options --after-url <head-preview>/stock/NVDA?tab=options --mock`. Use only deterministic mock data and no secrets, accounts, positions, or NLV. Verify the generated dark before/after graphic is at the top of the PR description. Re-run it if the change moves. Then update the PR body with `gh pr edit <PR> --body-file <temporary-file>`; keep the graphic Markdown as the first line and include `Agent review: <40-character reviewed SHA>`, `Owner decision: not needed (this UI-only change does not alter risk, orders, arming, or permissions)`, test results, risk, and revert instructions. Read back `gh pr view <PR> --json body` and verify the image is still first and both evidence lines are present. When implementation and review are complete, run `gh pr ready <PR>`.
6. Record `SHA=$(git rev-parse HEAD)`. Read `gh pr view <PR> --json headRefOid,url,isDraft,state` and require `headRefOid` to equal the full `SHA`. Run `timeout 3600 gh pr checks <PR> --watch`; require all eight checks to pass: `Verification (core)`, `Verification (coverage)`, `Verification (integration)`, `Verification (browser)`, `Analyze (actions)`, `Analyze (javascript-typescript)`, `CodeQL`, and `Dependency Review`. Re-read the PR head SHA and require it still equals `SHA`. Then run `scripts/merge-pr <PR> --card vertex-stock-pc-tile-oi-dashes --head "$SHA"` (add `--wait <minutes>` if the base claim is held). Verify the merge result from `gh pr view <PR> --json state,mergedAt,mergeCommit` and the script's tree check. Do not substitute plain `gh pr merge`.
7. The task is complete only when the exact reviewed PR head has passing required checks, the PR merge is verified, and the resulting tree contains the UI change. Do not change provider pagination, API output, OI null semantics, orders, or risk behavior.

## Files and evidence

### Modify

- `apps/web/src/features/stock-detail/stock-detail-workspace.tsx`
- `apps/web/src/features/stock-detail/stock-detail-workspace.test.tsx`
- `tests/e2e/stock-detail.spec.ts`
- `apps/web/src/status-language-allowlist.ts` (only the new placeholder and zero-call unavailable reason)

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
