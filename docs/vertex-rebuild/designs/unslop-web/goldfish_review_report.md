# EGM Goldfish Review Resolution Report: `unslop-web`

- **Target Document:** `docs/vertex-rebuild/designs/unslop-web/plan.md`
- **Resolution Mode:** Auto accept (standing owner rule of 2026-11-13)
- **Findings:** the 23 consolidated findings F1 to F23 of `consolidated_review_report.md`, plus the stage 8 findings at the end
- **Summary Counts:** 35 findings (23 consolidated, 12 from stage 8). 30 `PROPOSE FIX` applied in full; 4 `PROPOSE FIX` applied with one part `CONTEST` (F18, F19, F23, S8-4); 1 `CONTEST` (S8-12); 0 `DECLINE`; 0 `ESCALATE`.

## Resolutions

### F1 (Blocker): `PROPOSE FIX` (applied)

Checked in the code first: the reviewer is right. `account-glance.tsx` renders the trading node switch and the broker recovery request on Mission control; `portfolio-tabs.tsx` loads the order screen and the draft queue; Order drafts and Deployments load the draft queue and the approval workspace. The plan now scopes the shell notice by route (D1, goal 4, Alternatives 3 and 4). The code has the rule in `apps/web/src/lib/research-notice.ts`, and a test that reads the imports of every portal route file. The wording of the notice did not change, so no owner decision on wording was needed. The route scope was posted in the job channel.

### F2 (Blocker): `PROPOSE FIX` (applied)

The plain look removes the shape only. Warning and destructive keep their text colour (D4, Alternative 8, Risk 3).

### F3 (Blocker): `PROPOSE FIX` (applied)

The cause was read from the server code and is now in "The Problem": the gateway read answers HTTP 503 with the cause "not configured" when the runtime configuration has no gateway list, before any permission check. D8 names the failure kind that selects the plain line and states that every other kind keeps Retry. The sentence changed to "Connections are not configured on this server.", because the first wording matched the status-language check of the repository.

### F4 (Blocker): `PROPOSE FIX` (applied)

"Target Files to Modify" now lists the files with a behavior or text change for each part, with the change in each, including the files the reviewers found (`reset-password-entry.tsx`, the smoke fixtures, the contact form, the Flow panel files, `panel.test.ts` through the Test Plan). The list of every touched test file is the pull request diff.

### F5 (Blocker): `PROPOSE FIX` (applied)

The table "New public copy" lists every changed heading and line with its route, including reset password, verify email, not-found and error.

### F6 (Major): `PROPOSE FIX` (applied)

One definition in `packages/ui/src/status-badge.tsx` with two triggers: the `plain` option and an ancestor variant on the status slot (D4, Alternative 9). `PageHeader` has no override classes.

### F7 (Major): `PROPOSE FIX` (applied)

The report block is deleted and the link branch is gone (D7, Alternative 11). The fix moved to the trust boundary as two reviewers asked: the shared server read returns `reportPath: null`, so the path does not reach the browser. The contract and the stored record do not change.

### F8 (Major): `PROPOSE FIX` (applied)

D5 reuses `enumLabel` and `labelFor` and extends the existing maps. Known metric keys have labels; the fallback prints words with an upper-case first letter.

### F9 (Major): `PROPOSE FIX` (applied)

D3 is replaced by the table "Subtitles" with the removed text and the result for each of the 9 pages.

### F10 (Major): `PROPOSE FIX` (applied)

One rule for both variants: no page title has negative letter-spacing (D10, Alternative 10). The eyebrow option is rejected by the type for both variants (D11). The file list states each `MASTER.md` edit.

### F11 (Major): `PROPOSE FIX` (applied)

Goals 3, 6, 8, 9 and 11 are new. Non-Goal 7 covers the portal headings that print stored data. Verification step 7 has one check for each goal.

### F12 (Major): `PROPOSE FIX` (applied)

The Overview says where the audit script is kept and how it works. Terms defines surface level, execution control, shell notice, in-panel notice, design specification and the read-only agent viewer.

### F13 (Major): `PROPOSE FIX` (applied)

Each risk has a `Risk:` and a `Mitigation:` part; items without a mitigation are marked `Limit:`.

### F14 (Major): `PROPOSE FIX` (applied)

Part 4 of the file list names, for each component, which wrapper lost its border and what the Strategy library and Semantic terms rows print.

### F15 (Major): `PROPOSE FIX` (applied)

D12: the primitive no longer forces upper case, source labels were already sentence case, ticker inputs keep their class. Non-Goal 8 states that pills on pages that the plan does not name stay.

### F16 (Major): `PROPOSE FIX` (applied)

The overflowing elements were measured on the live site at 375 px and are named in "The Problem" and D13.

### F17 (Major): `PROPOSE FIX` (applied)

New section "Test Plan" with named cases. Verification step 7 defines each selector and text check, the deploy window with its time zone, and how digits are masked.

### F18 (Major): `PROPOSE FIX` (commit order, partial rollback), `CONTEST` (more than one pull request)

Applied: the commit order with part 5 first, the dependency of part 4 on part 2, and a revert of one part in Rollback. Contested: two or three pull requests. Each push costs one pre-push gate of about 25 minutes and one serialized merge of the base; Alternatives 1 and 2 record the reason.

### F19 (Major): `PROPOSE FIX` (definition, insertion point), `CONTEST` (pinned line)

Applied: D2 names the element, its place (last element of the page content column, inside the main region) and what "visible" means. Contested: a line pinned to the window edge (Alternative 6) and a line in the top bar (Alternative 7).

### F20 (Major): `PROPOSE FIX` (applied)

D9 and Alternative 12 say which page serves an unknown URL and which serves `notFound()` calls.

### F21 (Nit): `PROPOSE FIX` (applied)

D11.

### F22 (Nit): `PROPOSE FIX` (applied)

D6 gives the count (3 of 11 dropped) and the rule; the implementer's table of all 11 call sites is in the pull request description.

### F23 (Nit): `PROPOSE FIX` (applied), `CONTEST` (section order, heading names)

Applied: title without slang, counts in place of "most" and "small", digits throughout, list styles, the source of the gate time, the card id in Non-Goal 6. Contested: "Alternatives Considered" stays before "Technical Plan", and the heading names stay, to match the other plans in `docs/vertex-rebuild/designs`.

## Stage 8

The stage 8 reviewer read the plan after the resolutions above. Each of its 12 findings is listed with its resolution in `consolidated_review_report.md`, section "Stage 8". Summary:

- **S8-1, S8-2, S8-3, S8-5 (Major): `PROPOSE FIX` (applied).** S8-2 and S8-5 also changed the code: the fallback of `enumLabel` is restored, the metric labels are in `formatMetrics`, and the shared failure panel offers no Retry for the not-configured kind.
- **S8-4 (Major): `PROPOSE FIX` (applied), `CONTEST` (reuse of the navigation manifest).** Evidence for the contest: the test found the 4 routes from the route folders alone and passes; a page outside the manifest would be invisible to a manifest-based test.
- **S8-6 to S8-11 (Nit): `PROPOSE FIX` (applied).**
- **S8-12 (Nit): `CONTEST`.** The decisions keep the mechanism that stages 7 and 9 asked for.
