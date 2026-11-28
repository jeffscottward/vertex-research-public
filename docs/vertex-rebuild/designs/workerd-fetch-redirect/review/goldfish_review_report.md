# Goldfish review resolution: `workerd-fetch-redirect/plan.md`

Review mode: "Consolidated report with all review rubrics" (standing owner choice, 2026-11-15 and 2026-11-18). Resolution gate: "Auto accept" (standing owner rule, 2026-11-13): every PROPOSE FIX is applied to the plan; CONTEST and DECLINE findings stay recorded here.

Sources: `zoom_out_report.md` (ZO, IC), `comprehension_report.md` (CF), `critic_report.md` (DF = egm-design, SF = egm-structural, ST = egm-style), `implementation_readiness_report.md` (IR = egm-implementation-readiness, CD = egm-codebase-details, IS = egm-style), `intermediate_zoom_out_report.md` (Stage 8, after the fixes).

## Counts

- Raw findings: 91 (CF 11, ZO 8, IC 9, DF 10, SF 10, ST 14, IR 8, CD 10, IS 11), grouped into 28 themes below.
- PROPOSE FIX (applied): 24 themes in stages 5-7 and 9, plus 5 from stage 8 (29 total).
- CONTEST: 2.
- DECLINE: 2.
- ESCALATE: 0.

## Resolutions

| # | Theme | Raw findings | Resolution | What changed |
| --- | --- | --- | --- | --- |
| 1 | Goal claims every `fetch` works and refuses 3xx | CF F1, ZO-2, IC-7, SF F2, DF F2, ST S1, CD F3 | PROPOSE FIX | Goal narrowed to the files that passed `redirect: "error"`; new "Non-goals" list. |
| 2 | Bridge-token fetches use default `"follow"` | SF F2, DF F2, CD F3, IC-7 | PROPOSE FIX | Named in Non-goals; follow-up card `vertex-bridge-token-fetch-follows-redirect` (order and go-live paths need their own PR). |
| 3 | No alternatives section | SF F1, DF F1, IC-2 | PROPOSE FIX | New "Alternatives considered" table (6 options). |
| 4 | Nasdaq 3xx gives `UPSTREAM_ERROR` and skips the pause | CF F3, IC-4, SF F3, DF F3, ST S7, CD F1 | PROPOSE FIX | Code: 3xx maps to `UNAVAILABLE` and counts toward the pause; new test "pauses after repeated 3xx answers…"; Design and Risks updated. |
| 5 | Steps 1-2 do not match the code after fix 4; other plan not listed | CD F2, IR F7, ZO-4 | PROPOSE FIX | Steps 1, 2 and 10 rewritten; `vertex-chain-oi-yahoo-false-zero/plan.md` error matrix corrected with a "Superseded" note. |
| 6 | Guard lane named as CI core lane | ST S6, CD F4 | PROPOSE FIX | Design says `verify:prepush` and the CI coverage shards; docs-only light lane skips it. |
| 7 | Guard scope, test-file rule and limits not stated | CF F9, ZO-7, IC-8, SF F5, DF F7, ST S8, IR F2, CD F9 | PROPOSE FIX | Step 8 gives the file list, both regexes, sample lines and sanity check; Design states browser and comment matching; Risks lists the gaps. |
| 8 | Root cause (Node tests vs workerd) left open | ZO-1, IC-1, DF F4 | PROPOSE FIX | Non-goal plus follow-up card `vertex-workerd-adapter-runtime-test`; alternatives table explains the deferral. |
| 9 | No live proof for four adapters | CF F4, IC-5, SF F6, DF F4 | PROPOSE FIX | Evidence item 4 now records the workerd POST test with every option the adapters send; Risks says the other four rely on unit tests and that evidence. |
| 10 | Email and ntfy start to send | CF F4, DF F6, ST S9, CD F7 | PROPOSE FIX | Risks row names Resend (enabled on QuantVPS) and the ntfy alert callers, states no backlog flush, and the receipt tells the owner. |
| 11 | Acceptance check 4 ignores `off` and blips | CF F8, DF F5 | PROPOSE FIX | Check 4 also rejects `off`, notes that a restart clears the pause, and allows one rerun on a network blip. |
| 12 | Live check pass rule not stated | DF F5 | PROPOSE FIX | Terms entry for live check A states its four pass conditions. |
| 13 | Rollback not executable and too reassuring | CF F11, ZO-3, IC-9, IS S1, IS S2, IR F1, CD F5, DF F10 | PROPOSE FIX | Rollback prefers fix forward, names sender settings, gives revert-commit deploy steps, the exit-9 version guard and what stays sent. |
| 14 | Dates and card relation unclear | CF F5, ZO-8, SF F9, ST S2, DF F9 | PROPOSE FIX | Header lists the card relation, found time (UTC and New York) and rule date separately. |
| 15 | False zero and PR #491 wording | CF F6, ST S12 | PROPOSE FIX | Terms define false zero; evidence 1 separates the Yahoo part from the Nasdaq part. |
| 16 | Undefined terms and host names | CF F7, ST S11, CD F10 | PROPOSE FIX | Terms add QuantVPS host, acceptance, order-flow print, off-hours deploy; full `run-preview.mjs` path. |
| 17 | Evidence wording overstates | ST S3, ST S4, ST S13 | PROPOSE FIX | Evidence 3 names the tool and time; evidence 5 says "consecutive" and bounds the time; evidence 6 cites the files. |
| 18 | Email/ntfy failure rule stated wrongly | ST S5 | PROPOSE FIX | Design lists the reject statuses and says a 3xx gives `unknown`. |
| 19 | Yahoo chart listed as if affected | CF F2, ST S10, IS S9 | PROPOSE FIX | Table note says `readChart` already sent `"manual"`; step 4 says the Swinglytics 302 case covers the shared reader. |
| 20 | No security row | SF F4 | PROPOSE FIX | Design states that no adapter reads `Location`, so no credential reaches a second host; alternatives table explains why `"follow"` is rejected. |
| 21 | Verification commands not exact; negative guard check missing | IS S3, IS S4, IR F3, IR F4, CD F8 | PROPOSE FIX | Step 12 lists exact commands, the negative guard run, and acceptance check 3. |
| 22 | Paths, phases, Create/Modify labels, comment rule | IR F5, IR F6, IR F8, CD F6, IS S6, IS S7, IS S8, IS S10, IS S5, IS S11, CF F10 | PROPOSE FIX | Implementation Plan split into phases A-D with checkpoints, full paths, Create/Modify labels, one comment rule, test names. |
| 23 | Missing image; heading names | SF F7, DF F8, SF F8 | PROPOSE FIX | `before-after.png` added; headings renamed to "Goals and non-goals" and "Risks and mitigations". |
| 24 | Design uses helper names | ZO-6 | PROPOSE FIX | Design describes results per adapter; helper names stay in the steps. |
| 25 | Shared server fetch helper or type | IC-2 | CONTEST | Recorded as a deferred alternative. It adds cross-package dependencies and touches about 20 adapters that already work; the guard covers the literal form now. |
| 26 | New `MISCONFIGURED` error code for a `TypeError` from `fetch` | ZO-5, IC-3 | CONTEST | Recorded as a non-goal. Telling a programming `TypeError` from a network `TypeError` by message text is fragile in workerd; the follow-up workerd test card covers the detection need. |
| 27 | Log the 3xx status and `Location` origin | IC-6 | DECLINE | Out of scope for a redirect-mode fix; the failure result already carries the status code where the adapter exposes one (PostHog `statusCode`, Nasdaq message "HTTP 3xx"). |
| 28 | Quote rig-only evidence in the repo | SF F10 | DECLINE | The plan already quotes the numbers (7 of 64, 21 chains, 3 `failed`, 18 `off`); the raw file holds market data and stays on the rig. |

## Stage 8 findings (after the fixes above)

| # | Finding | Resolution | What changed |
| --- | --- | --- | --- |
| 29 | N1: acceptance check 4 rejects every `off`, but "Not asked:" is a normal `off` | PROPOSE FIX | Check 4 rejects only `failed` "could not be reached" and `off` "temporarily paused"; "Not asked:" is normal. |
| 30 | N2: deferred items have no card IDs | PROPOSE FIX | Non-goals name `vertex-bridge-token-fetch-follows-redirect` and `vertex-workerd-adapter-runtime-test`; the error-code item is dropped with a reason. |
| 31 | N3: review files missing | PROPOSE FIX | `goldfish_review_report.md` and `consolidated_review_report.md` written. |
| 32 | N4: shared-helper dependency reason inaccurate | PROPOSE FIX | Row says only `analytics` and `email` gain a dependency. |
| 33 | N5: 6-minute wait reason weak | PROPOSE FIX | Check 4 says the restart clears both in-memory caches; the wait is a safety margin. |

Updated counts: PROPOSE FIX 29 themes, CONTEST 2, DECLINE 2, ESCALATE 0.
