// biome-ignore-all lint/suspicious/noTemplateCurlyInString: entries quote source text, including template placeholders.
// Allow list of the status language guard (status-language.test.ts). Data only.
// An entry with `open: true` is a known ambiguous text from the audit of 2026-11-13: it leaves this
// list when its replacement merges. An entry without `open` was checked and is kept for its reason.
// Regenerate: UPDATE_STATUS_LANGUAGE=1 on the test, then `biome format --write` this file.

export type StatusLanguageEntry = Readonly<{
  file: string;
  text: string;
  count: number;
  reason: string;
  open?: boolean;
}>;

export const STATUS_LANGUAGE_ALLOWLIST: readonly StatusLanguageEntry[] = [
  {
    count: 1,
    file: "app/(portal)/academy/[slug]/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Academy unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/academy/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Academy unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/autopilot/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Autopilot unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/backtest-runs/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Backtest runs unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/backtest-sweeps/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Parameter sweeps unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/backtests/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Backtests unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/dashboard/page.tsx",
    reason:
      'Not displayed: Log-only classification field, never rendered. Optional rename to "unclassified" for log clarity.',
    text: "unknown",
  },
  {
    count: 1,
    file: "app/(portal)/instant-backtest/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Instant backtest unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/optimizations/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Optimizations unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/plays/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Plays unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(portal)/strategy-builder/error.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Title uses the vague word and hides the real cause (API read failed, session expired, render bug). Rename to "<Page> failed to render at HH:MM UTC" and show error.digest as a reference; the boundary already receives the error prop (not destructured in most files), so no API change.',
    text: "Strategy builder unavailable",
    open: true,
  },
  {
    count: 1,
    file: "app/(public)/_components/legal-page.tsx",
    reason:
      "Kept: Static legal template guidance text, not a state. Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
    text: "Identify configured providers, external terms, integration boundaries, and what happens when an optional capability becomes unavailable.",
  },
  {
    count: 1,
    file: "app/(public)/about/page.tsx",
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
    text: "Unknown availability, missing context, and incomplete integration are not design problems to conceal. They are information the researcher needs.",
  },
  {
    count: 1,
    file: "app/(public)/features/page.tsx",
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
    text: "Unavailable sources remain unavailable. Missing records stay missing. Failed validation prevents an artifact from being displayed.",
  },
  {
    count: 1,
    file: "app/(public)/not-found.tsx",
    reason:
      "Kept: Specific 404 title with cause in the description and a Return home action.",
    text: "That page is not available.",
  },
  {
    count: 1,
    file: "app/(public)/not-found.tsx",
    reason:
      "Kept: Specific: names the cause (route does not exist, eyebrow 404) and the next step (field guide or home link).",
    text: "The requested public route is not available. Browse the field guide or return to the Vertex Research overview.",
  },
  {
    count: 1,
    file: "app/(public)/page.tsx",
    reason:
      "Kept: Static prose that states the product rule on unavailable services. Not a runtime status.",
    text: "Availability comes from the connected source. When a service is unavailable, the workspace says so. No simulated market feed. No invented research results.",
  },
  {
    count: 1,
    file: "app/(public)/page.tsx",
    reason:
      "Kept: Static marketing prose; 'unknown' is used as a concept, not a state.",
    text: "Good research is not another signal. It is knowing what supports a claim, what limits it, and what remains unknown.",
  },
  {
    count: 1,
    file: "app/(public)/resources/page.tsx",
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource. It explicitly lists the distinct states.",
    text: "An empty catalog, denied access, a missing identity, an unavailable service, and a malformed response are different states. The workspace keeps them distinct and avoids substituting sample data.",
  },
  {
    count: 1,
    file: "app/(public)/resources/page.tsx",
    reason:
      "Kept: page meta description (search snippets and link previews); prose about the documentation, not a status.",
    text: "How to read identities, provenance, review status, and unavailable states in Vertex Research.",
  },
  {
    count: 1,
    file: "app/(public)/resources/page.tsx",
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
    text: "Unavailable is a useful answer",
  },
  {
    count: 1,
    file: "app/api/orpc/[...rest]/contact-runtime.ts",
    reason:
      "Not displayed: Internal rate-limit/source bucket key for the contact endpoint; never rendered to the user.",
    text: "unknown",
  },
  {
    count: 3,
    file: "app/api/orpc/[...rest]/runtime.ts",
    reason:
      "Not displayed: Internal telemetry consent enum passed to the oRPC analytics context; treated as no consent, never rendered. Note: three causes (malformed, conflict, absent) share one value; only matters for logs.",
    text: "unknown",
  },
  {
    count: 1,
    file: "components/account/address-page-client.tsx",
    reason:
      "Kept: A real unknown outcome, named precisely with its resolution path (reload the list before creating another).",
    text: "The address creation outcome is unknown. Reload the address list before creating another.",
  },
  {
    count: 1,
    file: "components/admin/admin-users-client.ts",
    reason:
      "Kept: Names the cause (directory storage, temporary) and the next step (try again).",
    text: "The user directory is temporarily unavailable. Try again.",
  },
  {
    count: 1,
    file: "components/contact/contact-client.ts",
    reason:
      "Kept: Names the cause (email delivery), the outcome (message not sent) and the next step (try again later).",
    text: "Email delivery is temporarily unavailable. Your message was not sent. Try again later.",
  },
  {
    count: 1,
    file: "components/portal/academy/academy-gallery.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Says "could not be loaded right now" but not why or what to do. The flag merges "storage missing" and "storage failing". Split into "Course store not provisioned" and "Lesson read failed at HH:MM UTC · reload to retry"; the server listing must carry a reason and time instead of the boolean.',
    text: "Course unavailable: its lessons could not be loaded right now. The other courses are not affected.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/academy/academy-gallery.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "Lessons failed to load · reload to retry" (S), or the split cause from the listing reason field once added (same change as the gallery notice).',
    text: "Lessons unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/academy/academy-gallery.tsx",
    reason:
      "Not displayed: Internal state discriminator used as a data attribute; the visible text is the next hit.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "components/portal/academy/lesson-backtest.tsx",
    reason: "Kept: Minus sign of a real negative number, not a placeholder.",
    text: "-",
  },
  {
    count: 3,
    file: "components/portal/academy/lesson-backtest.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Null means not computable from the run. Name it per stat: "not computable: no closed trades" or "not computable: period too short"; result.stats.trades and the date range are in scope.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/academy/lesson-deploy.tsx",
    reason:
      'Kept: The cause follows immediately in parentheses from gate.nlvDetail (API-supplied reason for the missing NLV). Could read "NLV not received" but the cause is present.',
    text: "unavailable",
  },
  {
    count: 1,
    file: "components/portal/account-glance.tsx",
    reason:
      "Kept: names the missing server setting, which is the cause and the fix.",
    text: "IBKR_MONITOR_URL is not set on this server",
  },
  {
    count: 1,
    file: "components/portal/agent-model-runs-client.ts",
    reason:
      "Kept: Names the cause (model run storage, 503) and the next step (retry).",
    text: "Model run storage unavailable (503). Retry.",
  },
  {
    count: 1,
    file: "components/portal/agent-model-runs-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: name the missing field of the grouped row, for example "no model recorded" or "no agent recorded" from the active group-by column.',
    text: "(not set)",
    open: true,
  },
  {
    count: 2,
    file: "components/portal/autopilot-model.ts",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Null merges "gate not run yet" and "not computable". Callers pass gate?.x ?? null: show "validation gate not run" when gate is undefined, "not computable" otherwise; gate is in scope.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/autopilot-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "validation gate not run" (gate undefined) or "deflated Sharpe not computed" (gate present, field missing); both are in scope.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/backtest-analytics-panels.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Three causes merged (not computed, missing in an old report, division by zero). At minimum replace with "not computable"; better, let each Stat pass its reason (e.g. "no benchmark", "no losing trades").',
    text: "—",
    open: true,
  },
  {
    count: 5,
    file: "components/portal/backtest-report-depth.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "no winning trades" / "no losing trades" per row; analysis.wins and analysis.losses are in scope.',
    text: "—",
    open: true,
  },
  {
    count: 4,
    file: "components/portal/backtest-runs-model.ts",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "not computable" plus the reason per row where known (e.g. "no losing trades" for average loss); metrics.totalTrades style counts are in the same object.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/backtest-sweeps-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "not reported by this sweep run" (older sweeps did not store trade counts) so it is not read as zero.',
    text: "n/a",
    open: true,
  },
  {
    count: 6,
    file: "components/portal/backtests-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "not reported" (the agent did not report this metric).',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/basket-chart.tsx",
    reason: "Kept: En dash separates two real values (min and max).",
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/basket-chart.tsx",
    reason:
      "Kept: Legend glyph for the solid line of the basket symbol; not a placeholder.",
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/basket-chart.tsx",
    reason:
      "Kept: Names the cause: no date has a close for every member. The per-symbol causes are listed next to it by baskets-workspace.tsx:160-172 (stale symbols, unavailable symbols with reason).",
    text: "No index history yet. Daily closes are not available for every member.",
  },
  {
    count: 1,
    file: "components/portal/baskets-workspace.tsx",
    reason:
      "Kept: The following expression `entry.symbol (entry.reason)` carries the cause per symbol; reason is the non-null API field of each unavailable entry.",
    text: "History unavailable:",
  },
  {
    count: 1,
    file: "components/portal/breadth-90-card.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "not received" for a missing breadth reading; if the API can tell disabled vs not yet computed, it must add a reason field.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/breadth-90-card.tsx",
    reason:
      "Kept: state.message is errorMessage(error): the server's error message (fallback 'Request failed.' only when the error has no message). 'Retry now' follows.",
    text: "Breadth-90 signal unavailable.",
  },
  {
    count: 1,
    file: "components/portal/breadth-90-chart.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no advancers data" with the cause; the API must say why advPct is absent for that day (source gap vs not computed).',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/calendar-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: state.message comes from describeMarketNewsFailure, which maps every code except UNAUTHORIZED/FORBIDDEN/STORAGE_ERROR to 'Request failed. Retry.' and drops the server code and message. Pass code and message through in the default case (as describePortfolioMonitorFailure does).",
    text: "Earnings filings unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/calendar-workspace.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Economic releases unavailable.",
  },
  {
    count: 1,
    file: "components/portal/calendar-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Only the symbols are listed; the cause is dropped. ticker.error is in scope: map gaps to `${symbol} (${error})`, as baskets-workspace.tsx:170 does.",
    text: "SEC filings unavailable for",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/charts-analysis-panels.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace the dash with "too few bars" (count is in scope) so a missing statistic is not read as zero.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/charts-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "as-of time not reported by source"; fetchedAt is shown next to it and can be named as the fallback.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/congress-trades-workspace.tsx",
    reason:
      'Kept: the en dash is the range in the pager text "Showing 1–50 of N", not a missing value.',
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/congress-trades-workspace.tsx",
    reason:
      "Kept: NOT_REPORTED, one constant for a table cell the filing leaves empty (holder, ticker, trade date, delay, reason). The page footer and plan-pr1.md section 4 define it; a word in each narrow column would push the table wider.",
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/dashboard-widgets-model.ts",
    reason:
      "Kept: separator of an ISO date key (year-month-day), not a placeholder.",
    text: "-",
  },
  {
    count: 1,
    file: "components/portal/dashboard-widgets.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Keep code and message but lead with the definite state: "Snapshot not loaded (<code>): <message> · retrying / reload"; add last successful snapshot time when the widget holds one.',
    text: "Unavailable (${}): ${}",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/deployment-requests-model.ts",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "no parameters (strategy defaults)".',
    text: "—",
    open: true,
  },
  {
    count: 3,
    file: "components/portal/deployment-requests-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "Select a strategy to see its parameters".',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/deployment-requests-workspace.tsx",
    reason:
      "Kept: Names the cause (storage, 503) and the next step (apply migration 0021).",
    text: "Deployment request storage unavailable (503). Apply migration 0021 if the table is missing.",
  },
  {
    count: 6,
    file: "components/portal/deployments-snapshot.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Split by caller: "not started", "not reported by VPS"; block.available/reason in scope gives the cause where the block is down.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/deployments-snapshot.tsx",
    reason:
      "Kept: The following `reason` carries the cause: block.reason from the API, or data.snapshotError, or 'tailnet snapshot not configured (VERTEX_DEPLOY_STATUS_V2_URL)'.",
    text: "Unavailable:",
  },
  {
    count: 1,
    file: "components/portal/engine-comparison.tsx",
    reason: 'Kept: Gives the cause in brackets (wallNote or "not measured").',
    text: "· engine time n/a (${})",
  },
  {
    count: 3,
    file: "components/portal/engine-comparison.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Callers must give the cause ("not measured", "from cache"); line 121 already does this with wallNote. Apply to remaining callers.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/engines-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "never run" for lastRunAt and "not scheduled (timer off)" for nextRunAt; engine.timerActive is in scope.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/engines-workspace.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Engine status unavailable.",
  },
  {
    count: 1,
    file: "components/portal/filter-studies-section.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows. A timeout gives 'No answer in N s'.",
    text: "Filter studies unavailable.",
  },
  {
    count: 1,
    file: "components/portal/final-gate-panel.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "max loss not computed: <cause>"; the gate verdict/reasons in scope or the API must supply why (no account value, no quote).',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/flow-workspace.tsx",
    reason: "Kept: En dash separates two real times.",
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/flow-workspace.tsx",
    reason: 'Kept: Empty flag list means none; could read "none".',
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/flow-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Say "Flow snapshot not loaded: <message> · retrying every N s"; refreshMs and failure are in scope. The sibling branch (with last snapshot time) is already ok.',
    text: "Flow snapshot unavailable. ${}",
    open: true,
  },
  {
    count: 2,
    file: "components/portal/forward-drift-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no forward trades yet" / "no baseline" per column; the check status in scope names which.',
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      'Kept: Names the state and the reason from unavailableReason; fallback "no reason reported" should be removed by making the API always send a reason.',
    text: "Account value not available: ${}",
  },
  {
    count: 2,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: Real unknown, named precisely: the server message follows in brackets and the next step is 'Check open orders at IBKR before doing anything else.'",
    text: "Approved; the send outcome is unknown",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason: "Kept: Gives the cause (sizing reason text).",
    text: "not available: ${}",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason: "Kept: Specific: cause, what was done, next step.",
    text: "Not found at IBKR: the outcome was unknown and a later check did not find the order. Not sent again here; check the IBKR order history.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: names the cause (the page version is older than the state the server sent) and prints the value.",
    text: "not known to this page version (${})",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: real uncertainty with its cause (the order records could not be read) and the next step (reload; sending stays off).",
    text: "Not known: the order records could not be read. Reload the queue; the send button needs a known state.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: Real unknown outcome with resolution path (next preview checks it); add since-when if the API has the send time.",
    text: "Outcome unknown: the order may still reach IBKR. Check open orders at IBKR; the next order preview checks it.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: real uncertainty with its cause: the request did not return, so the record is not confirmed; the sentence before it names the request.",
    text: "so it is not known whether it was recorded.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: real uncertainty with its cause and since-when (the generator has not reported for the stated time).",
    text: "The generator has not reported for ${}, so entry signals are not known.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: real uncertainty with its cause and since-when (the generator has not reported for the stated time).",
    text: "The generator has not reported for ${}, so it is not known whether the model holds a position the account does not.",
  },
  {
    count: 2,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      "Kept: Real unknown, named precisely with the server message and the next step (check open orders at IBKR).",
    text: "The send outcome is unknown",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      'Kept: "not set up" names a server configuration state as the cause of the refusal; it is not a placeholder.',
    text: "The server answered that it is not set up for this ${}, ${}",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue-model.ts",
    reason:
      'Kept: "not set up" names a server configuration state as the cause of the refusal; it is not a placeholder.',
    text: "The server is not set up to answer this request.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue.tsx",
    reason:
      "Kept: state.message is loadErrorText(error): cause words per failure class plus the server detail and the note that a load records nothing. Reload button follows.",
    text: "Order drafts unavailable.",
  },
  {
    count: 1,
    file: "components/portal/golive-draft-queue.tsx",
    reason:
      "Not displayed: Discriminator value; text comes from sendOutcomeText.",
    text: "unknown",
  },
  {
    count: 2,
    file: "components/portal/instant-backtest-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no trades" or "not computable" per metric; trade count is in the result.',
    text: "n/a",
    open: true,
  },
  {
    count: 2,
    file: "components/portal/market-context-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no reading"; series status/stale in scope where the row has them.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-context-workspace.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Market context unavailable.",
  },
  {
    count: 1,
    file: "components/portal/market-context-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split into 'S&P 500 quote not received from <source> (last quote HH:MM)' vs 'quote source failed: <error>'. The component has no reason field for spx; the API must add a reason/as-of for the null quote.",
    text: "S&amp;P 500 quote unknown.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-context-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace with "Not received" plus the source and cause; the API must send a reason and last reading time per series.',
    text: "Unknown",
    open: true,
  },
  {
    count: 7,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no value"; row regime/status in scope gives the cause where present.',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace '?' with 'expiry not reported'. If zeroDte has no expiry the whole 0DTE summary should say 'no 0DTE expiry in the GEX snapshot'.",
    text: "?",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: disabled / not yet received / failed, with the reason and last update; the API must add a per-section status and reason.",
    text: "GEX not available.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "GEX, macro and news unavailable.",
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: No cause. The page banner (lines 469-472) only names the missing section. Split into 'Macro not collected yet (next run <time>)' vs 'Macro source failed: <error>'; the API must add a per-section reason next to data.missing.",
    text: "Macro data not available.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Same split as GEX: reason and last update from a per-section status the API must add.",
    text: "News not available.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-feeds-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "time not reported by source"; never a bare unknown.',
    text: "unknown",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-news-client.ts",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Say what failed and what next: "Watchlist not saved/loaded: storage error (503). Retry; the list on screen is the last loaded one."',
    text: "Watchlist storage unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-news-workspace.tsx",
    reason:
      "Kept: The following `failures.filings` is the server's failure detail for the filings source of this ticker (splitSourceErrors strips the prefix).",
    text: "8-K filings unavailable:",
  },
  {
    count: 1,
    file: "components/portal/market-news-workspace.tsx",
    reason:
      'Kept: Followed by ": <failures.headlines>" which names the failing sources.',
    text: "Headlines unavailable",
  },
  {
    count: 1,
    file: "components/portal/market-news-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: state.message comes from describeMarketNewsFailure: the default case returns 'Request failed. Retry.' and drops the server code and message. Pass code + message through in the default case.",
    text: "News unavailable:",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-news-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Append the cause: "SEC filings not loaded: <row.error>"; row.error is in scope.',
    text: "SEC filings unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-news-workspace.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Badge "Load failed" with the error cause from state; add last successful load time.',
    text: "Unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/market-source-status.ts",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Label "All sources failed" and expose which and why; per-source status is in scope, cause needs passing in.',
    text: "Unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/mission-control.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: summaryState carries only `type`. dashboard/page.tsx already classifies the failure (timeout / abort / other) for the log; pass it as a field and show 'Session summary timed out after N s' vs 'Session summary request failed (<code>)', with a reload link.",
    text: "Workspace session summary unavailable; agent data below loads separately.",
    open: true,
  },
  {
    count: 9,
    file: "components/portal/optimizations-detail.tsx",
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "no parameters recorded".',
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/optimizations-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'Not scored (trial failed/pruned)' vs 'Pending' vs 'Non-finite score'. The trial state field in scope can pick the text; pass it to the formatter.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/options-analytics-panel.tsx",
    reason:
      "Kept: the minus sign of a number or of a subtraction in an expression; it is a real value, not a placeholder.",
    text: "-",
  },
  {
    count: 1,
    file: "components/portal/options-analytics-panel.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split per cause: 'Not received from QuantData' (with receivedAt) vs 'Not computed: too few strikes/OI'. Section already has receivedAt; cause per field needs an API reason field.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/order-flow-views.tsx",
    reason: "Kept: En dash separates two real values.",
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/owner-market-notes-card.tsx",
    reason:
      "Kept: state.message is errorMessage(error): the server's error message (fallback 'Request failed.' only when the error has no message). Retry follows.",
    text: "Owner market notes unavailable.",
  },
  {
    count: 1,
    file: "components/portal/papers-workspace.tsx",
    reason: "Kept: En dash separates two real numbers.",
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/pick-list-import.ts",
    reason:
      "Kept: hyphen that replaces other characters in a slug, not a placeholder.",
    text: "-",
  },
  {
    count: 1,
    file: "components/portal/plays-workspace.tsx",
    reason: "Kept: Optional link absent; not a status. Could read 'No link'.",
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/plays-workspace.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Plays list unavailable.",
  },
  {
    count: 1,
    file: "components/portal/portfolio-monitor-client.ts",
    reason: "Not displayed: TypeScript discriminant, never rendered.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "components/portal/portfolio-monitor.tsx",
    reason:
      "Kept: names the missing server setting, which is the cause and the fix.",
    text: "VERTEX_PORTFOLIO_URL is not set on this server",
  },
  {
    count: 3,
    file: "components/portal/quant-lab-panel.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'Not in study output' vs 'Not computed'. The metrics object is in scope: key absent vs null can be told apart.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/quant-lab-panel.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Quant Lab unavailable.",
  },
  {
    count: 1,
    file: "components/portal/risk-allocator-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: list.message comes from describeWatchlistFailure: specific for auth, not-found, validation and storage, but the default case returns 'Request failed. Retry.' without the server code or message. Pass them through in the default case. The next step (enter a symbol) is already given.",
    text: "Watchlist unavailable:",
    open: true,
  },
  {
    count: 5,
    file: "components/portal/rotation-matrix-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'No names in cell' (stats.n === 0) vs 'Too few bars for <period>'. stats.n is in scope; bars coverage needs an API field.",
    text: "–",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/rotation-matrix-workspace.tsx",
    reason:
      "Kept: state.message comes from describeResearchLensFailure: the server's own error message, or 'Operator access required.' (fallback 'Request failed.' only when the error has no message). A retry button follows.",
    text: "Rotation matrix unavailable:",
  },
  {
    count: 1,
    file: "components/portal/rotation-matrix-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Body alert already prints 'Rotation matrix unavailable: <message>'. Badge: 'Load failed HH:MM'; rename the body text to the concrete cause. state.message in scope.",
    text: "Unavailable",
    open: true,
  },
  {
    count: 3,
    file: "components/portal/rotation-matrix-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'No as-of date in matrix · generated <generatedAt>' (generatedAt is in scope) and mark as possibly stale.",
    text: "unknown",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/sector-rotation-workspace.tsx",
    reason:
      "Kept: Symbol is shown in the row header; missing descriptive name is not a state.",
    text: "–",
  },
  {
    count: 1,
    file: "components/portal/sector-rotation-workspace.tsx",
    reason:
      "Kept: state.message comes from describeSectorRotationFailure: operator notice, 'not yet collected, the nightly job fills it after the US close' for NOT_FOUND, or the server's message (fallback 'Request failed.'). 'Try again' follows.",
    text: "Sector rotation unavailable:",
  },
  {
    count: 1,
    file: "components/portal/sector-rotation-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Badge 'Load failed HH:MM'; body alert already shows state.message. Add failure time to the state.",
    text: "Unavailable",
    open: true,
  },
  {
    count: 4,
    file: "components/portal/setup-replay-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'No occurrences' (summary count 0) vs 'Monte Carlo not run: fewer than N outcomes'. Counts are in scope; pass the cause.",
    text: "n/a",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/signal-alerts-section.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: List them: '2 series failed: ES (no bars since ...), NQ (...)'. result.seriesErrors is in scope with per-series detail.",
    text: "${} series unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/signal-alerts-section.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'Backfill not computed: market data request failed at HH:MM · the watch still starts from now'. API must send the backfill failure reason.",
    text: "Backfill unavailable (market data).",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/strategy-backtest-study-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'No full month in run' vs 'No trades'. run.trades is in scope for the second case.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/strategy-backtest-study.tsx",
    reason:
      "Kept: Ellipsis marks a truncated hash, not a loading or unknown state.",
    text: "…",
  },
  {
    count: 1,
    file: "components/portal/strategy-backtest-study.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows. The kind mismatch gives 'Study <slug> is not a <kind> study.'",
    text: "Backtest study unavailable.",
  },
  {
    count: 1,
    file: "components/portal/strategy-builder-model.ts",
    reason:
      "Kept: the minus sign of a number or of a subtraction in an expression; it is a real value, not a placeholder.",
    text: "-",
  },
  {
    count: 1,
    file: "components/portal/strategy-builder-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'The backtest failed; the engine stored no error text (run <id>, finished <time>)'. Run id and times are on the run object.",
    text: "unknown error",
    open: true,
  },
  {
    count: 3,
    file: "components/portal/strategy-library-detail.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'No linked backtest yet' vs 'Latest backtest has no equity report'. Needs a reason/flag from the API; minimal text 'No linked backtest'.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/strategy-library-detail.tsx",
    reason: "Kept: Names the cause and the fallback (text shown below).",
    text: "Clipboard unavailable; preset ${} text is shown below.",
  },
  {
    count: 4,
    file: "components/portal/strategy-library-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'Not computed: <cause>' (no trades, zero variance, run not finished). Needs a reason from the server-derived metrics.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/strategy-library-workspace.tsx",
    reason: "Kept: Empty optional user field.",
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/strategy-library-workspace.tsx",
    reason:
      "Kept: names the cause (missing tables or columns, or an invalid stored value) and the fix (apply migrations 0019, 0065).",
    text: "Strategy library storage unavailable (503): its tables or columns are missing, or a stored value is invalid. Apply the pending strategy-library migrations (0019, 0065).",
  },
  {
    count: 1,
    file: "components/portal/todos-client.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'To-do database did not answer at HH:MM (503). Change not saved. Retry.' Text plus client time.",
    text: "To-do storage unavailable (503).",
    open: true,
  },
  {
    count: 1,
    file: "components/portal/vertex-orders.tsx",
    reason:
      "Kept: Static prose that states the limits of the ticket (which order types exist). Not a runtime state.",
    text: "Calls or puts, limit order, day order. Share orders and naked short options are not available.",
  },
  {
    count: 1,
    file: "components/portal/watchlist-exposure.tsx",
    reason:
      "Kept: Binary column; dash means 'Not on watchlist'. Better to write it out.",
    text: "—",
  },
  {
    count: 2,
    file: "components/portal/watchlist-exposure.tsx",
    reason:
      "Kept: Ellipsis separates two real bounds. Line 378 'Loading positions…' is a separate loading text.",
    text: "…",
  },
  {
    count: 1,
    file: "components/portal/watchlist-exposure.tsx",
    reason:
      "Kept: Shows failure code and message and has a retry button. Could add the time.",
    text: "Positions unavailable (${}): ${}",
  },
  {
    count: 1,
    file: "components/portal/watchlist-relationships.tsx",
    reason:
      "Kept: Cell title states the cause and the threshold (overlap vs MIN_CORRELATION_OVERLAP). Hover only: consider visible legend.",
    text: "—",
  },
  {
    count: 1,
    file: "components/portal/watchlist-research.tsx",
    reason:
      'Kept: the buy zone is an optional value that the user enters; "Not set" states that the user has not entered one.',
    text: "Not set",
  },
  {
    count: 4,
    file: "components/portal/watchlist-workspace.tsx",
    reason:
      "Kept: Optional user-entered field. Note line 100 prints a one-sided zone as '— – X'; better 'up to X' / 'from X'.",
    text: "—",
  },
  {
    count: 1,
    file: "components/research/read-resource.ts",
    reason:
      "Not displayed: Internal error kind; the displayed copy is in vertex-client.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "components/research/vertex-client.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'No response within Ns (timed out at HH:MM)' vs 'Read service disconnected'. read-resource knows which path fired; pass it into the failure.",
    text: "Source unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/research/vertex-client.ts",
    reason: "Not displayed: TypeScript discriminant.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "components/theme-menu.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'Appearance settings load after sign-in status is known' and, if it persists, the reason. Add a timeout state in useThemeAuthority.",
    text: "Appearance settings are unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "components/theme-menu.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: 'Appearance settings: waiting for session'. Same fix as the status message.",
    text: "Appearance settings unavailable",
    open: true,
  },
  {
    count: 1,
    file: "components/user-menu.tsx",
    reason: "Kept: Avatar fallback glyph, not a status.",
    text: "?",
  },
  {
    count: 1,
    file: "features/charts/chart-workstation.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'Chart is still loading; try again when bars are drawn' vs 'This renderer cannot export images'. renderer/snapshot presence is in scope.",
    text: "Screenshot is not available yet.",
    open: true,
  },
  {
    count: 1,
    file: "features/charts/indicators.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split by freshness.status: 'Candle freshness not reported by <sourceId>' (missing) vs 'Candle freshness could not be evaluated' (unknown); add candle time. Status and source are in scope.",
    text: "Candle freshness is unknown or missing.",
    open: true,
  },
  {
    count: 1,
    file: "features/charts/indicators.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split into: 'Display rights not granted for <provider/sourceId>', 'Display rights expired at <expiresAt>', 'Rights check is newer than evaluation time'. rights.status, expiresAt, checkedAt are in scope.",
    text: "Current display rights are unavailable for a candle.",
    open: true,
  },
  {
    count: 2,
    file: "features/charts/indicators.ts",
    reason: "Not displayed: Identifier, not a text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "features/charts/kline-adapter.ts",
    reason:
      'Not displayed: Programming guard; "Unknown" means unrecognised identifier, not a status.',
    text: "Unknown built-in study",
  },
  {
    count: 1,
    file: "features/charts/kline-adapter.ts",
    reason:
      'Not displayed: Programming guard; "Unknown" means unrecognised identifier, not a status.',
    text: "Unknown Vertex study",
  },
  {
    count: 1,
    file: "features/charts/market-chart.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'Chart renderer failed to load · exact values are in the table below · reload the page to retry'. To name the cause the host must pass the load error (one extra prop).",
    text: "Chart renderer unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "features/charts/renderer-host.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Names the fallback but not the cause or next step. Use 'Chart renderer failed to load (<error name>) · exact data is in the table · reload to retry'; needs the caught error passed to the caption.",
    text: "Chart renderer unavailable. Exact data remains in the table.",
    open: true,
  },
  {
    count: 1,
    file: "features/charts/script-sandbox.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with String(error) so the thrown value is shown: 'Script engine failed: <thrown value>'.",
    text: "unknown error",
    open: true,
  },
  {
    count: 2,
    file: "features/charts/workstation.ts",
    reason:
      "Kept: hyphen in an export file name (symbol slug and time stamp), not a placeholder.",
    text: "-",
  },
  {
    count: 1,
    file: "features/click-log/install.ts",
    reason: "Not displayed: Telemetry field only; not rendered in the UI.",
    text: "unknown",
  },
  {
    count: 1,
    file: "features/experience/agents.tsx",
    reason:
      "Kept: Names the cause (artifact records no model). Static artifact field, not a live status.",
    text: "Unavailable — no model supplied",
  },
  {
    count: 6,
    file: "features/experience/browser-provider.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: The notice says disconnected/timeout, which is the wrong cause. Add kind 'unsupported-origin' with text 'This page was not opened over http(s); reads are disabled'. Proof: window.location.protocol.",
    text: "unavailable",
    open: true,
  },
  {
    count: 3,
    file: "features/experience/guards.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Add a distinct failure kind 'not-configured' to VertexFailureKind (web-only) with text '<Service> not configured in this deployment · nothing was sent · ask the operator to enable it'. Proof: the port is null. Keep 'unavailable' for disconnect/timeout only.",
    text: "unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/portfolio.tsx",
    reason:
      "Kept: Static prose that states a limit: the cash figure is the source value and nothing is derived. 'not available' here means 'not the available-funds figure'.",
    text: "Cash is not available or spendable cash. No amount is derived by subtracting reservations, adding positions or aggregating currencies.",
  },
  {
    count: 1,
    file: "features/experience/portfolio.tsx",
    reason:
      "Kept: Prose that states the rule (empty and unknown are not zero). Its notice title names the state and time: 'Portfolio source reported no portfolio data for <env> at <time>'.",
    text: "No balances or holdings have been supplied. Empty collections and unknown values are not zero.",
  },
  {
    count: 1,
    file: "features/experience/portfolio.tsx",
    reason:
      'Kept: static description of the view; "unknown" names one of the budget states it lists, it is not a status.',
    text: "Nonauthoritative native-owner projections. Reserved, spent, released and unknown states do not grant spending permission. This view cannot reserve, release, reconcile or submit.",
  },
  {
    count: 1,
    file: "features/experience/portfolio.tsx",
    reason:
      "Kept: protocol key of the read-reason map; the page prints the mapped title 'Portfolio source not responding for <env>', never this key.",
    text: "source-unavailable",
  },
  {
    count: 1,
    file: "features/experience/portfolio.tsx",
    reason:
      "Kept: Names the cause (source did not supply the value) and avoids showing zero.",
    text: "Unknown — not supplied",
  },
  {
    count: 1,
    file: "features/experience/research-chat-client.ts",
    reason:
      'Kept: base64url encoding replaces "+" with a hyphen; it is not a displayed text.',
    text: "-",
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Show the server reason: 'Debate metadata not available: <reasonCodes>' as the preview path does. If the response has no reason codes the API must add them.",
    text: "Debate metadata unavailable. No next-step readiness or permission is assumed; inspect the original operation if its outcome is unknown.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Use 'Debate metadata read failed at HH:MM (<failure title>) · no request or review was issued · retry'. Failure kind is available via classifyVertexFailure.",
    text: "Debate metadata unavailable. No request or independent review was issued.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Keep the real unknown outcome and the next step, add the cause and time: 'Inspect failed at HH:MM (<failure title>) · original request outcome not confirmed · inspect the same key again'. classifyVertexFailure(error) is available in the handler.",
    text: "Original request status unavailable. Outcome may be unknown. Inspect this same key again; do not create a replacement request.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Kept: Real unknown, named precisely: the following `value.reasonCodes.join(', ')` carries the cause and the text gives the path (inspect only this original request key).",
    text: "Outcome unknown",
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Kept: Shows the server reason codes and states that no approval was submitted.",
    text: "Preview unavailable: ${}. No approval submitted.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Use 'Preview request failed at HH:MM (<failure title>) · no approval submitted · prepare again'. Failure kind is available via classifyVertexFailure.",
    text: "Preview unavailable. No approval was submitted; no response receipt has been upgraded.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Kept: Body names the cause (service not configured) and that nothing was sent.",
    text: "Research chat unavailable",
  },
  {
    count: 6,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Add a distinct failure kind 'not-configured' to VertexFailureKind (web-only) with text '<Service> not configured in this deployment · nothing was sent · ask the operator to enable it'. Proof: the port is null. Keep 'unavailable' for disconnect/timeout only.",
    text: "unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-room.tsx",
    reason:
      "Kept: Real unknown outcome with failure detail, retained draft and recovery actions.",
    text: "Write not acknowledged — outcome may be unknown",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: The cause is in scope as the string `error` (shown only in the composer at line 1457). Show it here: 'Conversation not loaded: <error>', keep the refresh and do-not-resend advice.",
    text: "Conversation unavailable. Refresh reads before continuing; do not blindly resend a message with an unknown outcome.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Append the cause: 'No agent response was queued: <responseReasonCodes>'. The responseReasonCodes prop is in scope.",
    text: "No agent response was queued. Agent response unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Explanatory prose on what a preview request does and does not grant. Rule text, not a state.",
    text: "Ordinary expert selection requests a governed preview only, not availability or execution permission. Unavailable or incomplete corpus status remains unchanged. The server must check the current configuration, corpus and exact request; it may return unavailable. Preparation creates no governed copies, submits no approval and dispatches no model work.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'Access to this private answer is not granted now', 'Private read failed at HH:MM · select Show again', 'Hidden while the thread reloads'. Needs a reason on ResearchPrivateView (set at room.tsx 231/255 and view.tsx 1234).",
    text: "Private answer unavailable. Its immutable reference and provenance remain in history.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Explanatory prose on what the reference metadata means. Rule text.",
    text: "Reference metadata remains when private content is unavailable. It is not current read permission or execution authority.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Explanatory prose: membership does not trigger or activate an agent. Each participant's own availability label is shown above it.",
    text: "Room membership does not request a response or activate an unavailable agent.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Four causes in one sentence. The three checks are separate at lines 1218-1221: show the one that failed and name the participant ('<name> is not available', '<name> is not in this room', 'selected twice', '9 selected, limit is 8').",
    text: "Selected responders are unavailable, outside this room, duplicated or over the eight-participant limit. Deselect them before sending.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Explanatory prose on the scope of a debate preview. Rule text.",
    text: "Selecting a first speaker requests a governed debate preview only; unavailable or incomplete corpus status is unchanged. The server checks the exact configured pair and may refuse the selected first speaker. Preparation may record plan/run metadata and read previously authorized predecessor inputs, but creates no new governed copies or model dispatch. Review and separately approve only the returned preview for this turn.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Explanatory prose on the limits of the debate workflow. Rule text.",
    text: "Source-implemented workflow, not a claim of live availability. Only one shared reviewed corpus and identical review pins are supported. The server resolves the configured participants, selected synthesizer and budgets; incompatible selections remain unavailable. No automatic turns or client-issued reviews.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Not displayed: status value of the private content state; the displayed text is built from it elsewhere in the file.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Show the actual availability value and reason codes: '<availability>: <reasonCodes>'. participant.availability and participant.reasonCodes are in scope (codes are shown only in one of three places).",
    text: "Unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'Digest being computed' vs 'Digest could not be computed in this browser · do not approve · reload'. Needs a digest state (pending/failed) passed with recordDigests.",
    text: "Unavailable — do not approve",
    open: true,
  },
  {
    count: 3,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'Not supplied by roster (corpus <corpus.status>)'. corpus.status is in scope and already tells why the pin is absent.",
    text: "Unknown",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: Rule text for a real unknown outcome: names the resolution path (inspect the original key, no retry).",
    text: "Unknown outcomes are inspect-only for the original key. Inspection never retries a model request. Eligibility is not publication or a completed answer.",
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Show 'Participant <participantId> (not in current roster)'. record.author.participantId is in scope.",
    text: "Unknown participant",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/research-chat-view.tsx",
    reason:
      "Kept: The following `{id}` names which id; the cause (not a participant of this room) follows from the filter, and the next step 'deselect to continue' is given. Could read 'Not a participant of this room: <id>'.",
    text: "Unknown participant:",
  },
  {
    count: 1,
    file: "features/experience/shared.tsx",
    reason: "Kept: Em dash separates two real values.",
    text: "—",
  },
  {
    count: 1,
    file: "features/experience/shared.tsx",
    reason:
      "Kept: Explanatory prose for a real unknown outcome: says when it happens and where to check before a retry. The cause is in state.failure.title/detail above it.",
    text: "The request outcome may be unknown after a timeout or disconnect. Inspect Agents & runs or Audit before retrying. A stopped browser request does not cancel a server job.",
  },
  {
    count: 1,
    file: "features/experience/shared.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Shown as 'Source unavailable: disconnected or did not respond', which is the wrong cause. Use a 'not-configured' kind: 'Experience services are not connected on this page'.",
    text: "unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/strategies.tsx",
    reason:
      "Kept: Body names the cause (job service not configured) and the consequence.",
    text: "Paper simulation queue unavailable",
  },
  {
    count: 1,
    file: "features/experience/strategies.tsx",
    reason:
      "Kept: Specific: names the id and that the dossier does not include the record.",
    text: "Referenced evidence unavailable in this dossier",
  },
  {
    count: 1,
    file: "features/experience/strategies.tsx",
    reason:
      "Kept: Specific: names the id and that the dossier does not include the record.",
    text: "Referenced manifest unavailable in this dossier",
  },
  {
    count: 1,
    file: "features/experience/strategies.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Body does not name the cause. Use title 'Review service not configured' and add 'reviews cannot be recorded in this deployment', as the job notice at line 1214 does.",
    text: "Review service unavailable",
    open: true,
  },
  {
    count: 2,
    file: "features/experience/strategies.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'No vintage id recorded in this manifest'.",
    text: "Unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/strategies.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'Publication time not supplied by source' (capturedAt is shown next to it).",
    text: "Unknown",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/today.tsx",
    reason:
      "Kept: Detail prints read.reason and links to the portfolio continuity section.",
    text: "Continuity unavailable",
  },
  {
    count: 1,
    file: "features/experience/today.tsx",
    reason: "Not displayed: React key / identifier.",
    text: "continuity:unavailable",
  },
  {
    count: 1,
    file: "features/experience/today.tsx",
    reason: "Kept: Names the cause (no digest supplied for this item).",
    text: "Unknown — not supplied",
  },
  {
    count: 3,
    file: "features/experience/transport.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Add a distinct failure kind 'not-configured' to VertexFailureKind (web-only) with text '<Service> not configured in this deployment · nothing was sent · ask the operator to enable it'. Proof: the port is null. Keep 'unavailable' for disconnect/timeout only.",
    text: "unavailable",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Definite state (no match) with the next step; 'unknown-outcome' is the name of a counter.",
    text: "Change or clear the search to inspect this returned scope. Sequence warnings and unknown-outcome counts above have not been filtered out.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Instruction prose; 'unknown host key' is a security term, not a state.",
    text: "Compare the exact host fingerprint through the provider console you already trust. Do not accept an unknown host key or paste credentials into this workspace.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Instruction prose that gives the resolution path for unknown outcomes.",
    text: "Have the authorized owner inspect existing orders, fills and balances in the trusted broker system and reconcile unknown outcomes. An empty list, timeout or connected socket is not proof of reconciliation.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Definite state (nothing returned for this account and environment) and what it does not prove. Rule text.",
    text: "No receipts or native facts were returned for this account and environment. This is not proof that no orders exist, that an unknown outcome resolved, or that the broker reconciled.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason: "Kept: Names the cause (epoch A to B) and what it does not prove.",
    text: "Owner epoch changed from ${} to ${}. Cross-epoch continuity is unknown; this is not reconciliation success.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: The following `index.reportedUnknownCount` is a real count; the text says what it is and what it is not.",
    text: "Reported unknown counts across returned reconciliation facts:",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Names the cause (history starts at sequence N in this response).",
    text: "Sequence coverage gap: returned history begins at ${}, not 1. Earlier observations are unavailable in this response.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason: "Kept: Definite state with its limit stated.",
    text: "Source reports reconciled with zero unknown; not an independent reconciliation certificate.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Static prose on what the page does not do and which failure states it shows.",
    text: "This page does not clear browser-wide data, store passwords or copy account preferences. Read failures show permission, unavailable or malformed-source states. They do not show sample data.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Three different causes in one sentence (no binding / no read grant / grant check unavailable). The list response has no reason; the API must return which one applies. Then: 'No gateway is bound on the server', 'You have no read grant for <scope>', 'Grant check failed at HH:MM: <error>'.",
    text: "This page lists each broker gateway you may observe. None is visible to this account right now: the server has no gateway binding, you hold no read grant for its account scope, or the grant check is unavailable. Gateways appear here without any typing once a binding and a grant exist.",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Names exactly which four facts this read does not supply; the resolution path is the 'Required human actions' list on the same page.",
    text: "This status does not include heartbeat freshness, account reconciliation evidence, a host fingerprint or a recovery challenge. These values remain unknown.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Real undetermined state, name it without 'Unknown': 'Readiness conflict — source sent both ready and not-ready codes · treated as not ready'. Add the status observation time if BrokerRecoveryStatus has one.",
    text: "Unknown — conflicting source readiness reason codes",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Use 'Readiness not reported — source sent no read-only readiness code · treated as not ready', plus observation time if the status has one.",
    text: "Unknown — no explicit read-only readiness reason code",
    open: true,
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason: "Kept: Field label for a count, marked as source-reported.",
    text: "Unknown count (source)",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Rule text for a real unknown outcome: what it does not mean and who resolves it (owner reconciles in the broker system).",
    text: "Unknown does not mean not submitted, rejected or cancelled. Do not repeat an order to find out. The authorized human owner must reconcile through the trusted broker system. This count includes rows hidden by search and pagination.",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Real unknown outcome; body gives the count, what it does not mean and the resolution path (owner reconciles at the broker).",
    text: "Unknown execution outcomes",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Real unknown, kept on purpose: the following `index.unknownCount` is the count and the paragraph below gives the resolution path.",
    text: "Unknown execution outcomes:",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason:
      "Kept: Real unknown outcome named with its resolution path; error class is shown below.",
    text: "UNKNOWN OUTCOME — reconciliation required",
  },
  {
    count: 1,
    file: "features/experience/utilities.tsx",
    reason: "Kept: Real unknown kept, with count and source attribution.",
    text: "UNRESOLVED RECONCILIATION — ${} unknown (source)",
  },
  {
    count: 1,
    file: "features/flow/format.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace per use: 'never' for lastOk, 'no window yet' for coverage, 'no book data in window' for pressure. Each call site knows which field is null.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "features/flow/view-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Give cause and time: 'The <symbol> − <ticker> basis was not computed for the <gex.at> snapshot (no simultaneous prices)'. gex.at is in scope; the precise cause needs an API field.",
    text: "Levels come from ${} options. The ${} − ${} basis is unknown, so they are shown in ${} price only.",
    open: true,
  },
  {
    count: 3,
    file: "features/flow/view-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'Side not classified (no quote at print time)'. If other causes exist the API must add a reason.",
    text: "Unknown",
    open: true,
  },
  {
    count: 1,
    file: "features/openbb/openbb-panels.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: No timeout or deadline exists in this component or its client file (grep timeout/deadline/AbortSignal.timeout: none), so the text can stay forever. Add a started-at time and a deadline: '<what> requested at HH:MM · no answer after N s' with Retry, as filter-studies-section.tsx:56 does.",
    text: "…",
    open: true,
  },
  {
    count: 1,
    file: "features/openbb/openbb-panels.tsx",
    reason:
      "Kept: The following state.message is `${failure.code}: ${failure.message}` (or 'Operator access required') from describePortfolioMonitorFailure.",
    text: "unavailable.",
  },
  {
    count: 1,
    file: "features/openbb/view-model.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: NOT_COLLECTED already covers the never-collected state. For null fields use 'Not reported by source' instead of a bare dash.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "features/stock-detail/fake-gateways.ts",
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
    text: "IBKR history service unavailable (dummy)",
  },
  {
    count: 1,
    file: "features/stock-detail/fake-gateways.ts",
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
    text: "Options data source unavailable (dummy)",
  },
  {
    count: 2,
    file: "features/stock-detail/fake-gateways.ts",
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "features/stock-detail/options-chain-table.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: empty cell title 'No contract listed at this strike' vs 'No quote' / 'IV not computed'. contract === null and the null field are distinguishable in fixed/cell helpers.",
    text: "—",
    open: true,
  },
  {
    count: 5,
    file: "features/stock-detail/stock-detail-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'No price in this chain snapshot'; call sites know which value is missing.",
    text: "—",
    open: true,
  },
  {
    count: 1,
    file: "features/stock-detail/stock-detail-workspace.tsx",
    reason: "Not displayed: URL token.",
    text: "?",
  },
  {
    count: 1,
    file: "features/stock-detail/stock-detail-workspace.tsx",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: No timeout or deadline exists in this component or its client file (grep timeout/deadline/AbortSignal.timeout: none), so the text can stay forever. Add a started-at time and a deadline: '<what> requested at HH:MM · no answer after N s' with Retry, as filter-studies-section.tsx:56 does.",
    text: "…",
    open: true,
  },
  {
    count: 1,
    file: "lib/academy-lessons.ts",
    reason:
      "Not displayed: Log line only; the UI text is in academy-gallery.tsx.",
    text: "academy course ${} unavailable: ${}",
  },
  {
    count: 1,
    file: "lib/server-session.ts",
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Message of a thrown error; if a caller renders it, use 'Session check failed: session service at capacity (503) after retries · you are not signed out · reload in a minute'.",
    text: "Portal session check is temporarily unavailable",
    open: true,
  },
  {
    count: 1,
    file: "lib/server-session.ts",
    reason:
      "Not displayed: fallback error name of the session deny check; it is compared and logged, never rendered.",
    text: "unknown",
  },
];
