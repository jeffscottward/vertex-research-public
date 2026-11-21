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
    file: "app/(portal)/dashboard/page.tsx",
    reason:
      'Not displayed: Log-only classification field, never rendered. Optional rename to "unclassified" for log clarity.',
    text: "unknown",
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
    file: "components/portal/academy/lesson-backtest.tsx",
    reason: "Kept: Minus sign of a real negative number, not a placeholder.",
    text: "-",
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
    count: 1,
    file: "components/portal/insider-clusters-workspace.tsx",
    reason:
      "Kept: NOT_REPORTED, one constant for a 10b5-1 cell or newest complete day the source leaves empty. The page footer defines it; a word in the narrow column would push the table wider.",
    text: "—",
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
    count: 1,
    file: "components/portal/quant-lab-panel.tsx",
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
    text: "Quant Lab unavailable.",
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
    file: "components/portal/strategy-library-detail.tsx",
    reason: "Kept: Names the cause and the fallback (text shown below).",
    text: "Clipboard unavailable; preset ${} text is shown below.",
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
    file: "components/research/vertex-client.ts",
    reason: "Not displayed: TypeScript discriminant.",
    text: "unavailable",
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
      "Kept: Real unknown outcome with failure detail, retained draft and recovery actions.",
    text: "Write not acknowledged — outcome may be unknown",
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
      "Kept: Rule text for a real unknown outcome: names the resolution path (inspect the original key, no retry).",
    text: "Unknown outcomes are inspect-only for the original key. Inspection never retries a model request. Eligibility is not publication or a completed answer.",
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
      "Kept: Names exactly which four facts this read does not supply; the resolution path is the 'Required human actions' list on the same page.",
    text: "This status does not include heartbeat freshness, account reconciliation evidence, a host fingerprint or a recovery challenge. These values remain unknown.",
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
      "Kept: 'Loading <what>…' shows for at most OPENBB_REQUEST_TIMEOUT_MS (30 s); then the panel says '<what> requested at HH:MM · no answer after 30 s' with Retry, and a late answer replaces it.",
    text: "…",
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
    count: 1,
    file: "features/stock-detail/stock-detail-workspace.tsx",
    reason: "Not displayed: URL token.",
    text: "?",
  },
  {
    count: 1,
    file: "features/stock-detail/stock-detail-workspace.tsx",
    reason:
      "Kept: 'Loading <symbol>…' shows only before the first effect reads the URL, when no request is open yet; the option-chain read that follows says 'requested at HH:MM · no answer after 30 s' with Retry after CHAIN_REQUEST_TIMEOUT_MS.",
    text: "…",
  },
  {
    count: 1,
    file: "lib/server-session.ts",
    reason:
      "Not displayed: fallback error name of the session deny check; it is compared and logged, never rendered.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/agent-model-runs-csv.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 4,
    file: "packages/api/src/agent-rating-placebo.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/academy.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/agent-model-runs.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/agent-ops.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/congress-trades.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Congress trade storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/flow.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Flow storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/flow.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/flow.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/golive-drafts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/golive-drafts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/ibkr-recovery.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Audit log unavailable; the request was not sent",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/market-context.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Market context unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/market-data.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "IBKR history service unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/market-news.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Watchlist storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/market-notes.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Market notes storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/nautilus-arm.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Audit log unavailable; nothing was changed",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/nautilus-arm.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/options-analytics.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/contracts/options-analytics.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/options-chain.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Options data source unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/research-reports.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/research-screen.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Research screen storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/research-screen.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/sector-rotation.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Market data source unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/sector-rotation.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Sector rotation storage unavailable",
    open: true,
  },
  {
    count: 2,
    file: "packages/api/src/contracts/semantic-terms.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/smart-money.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Smart money storage unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/smart-money.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/contracts/vertex-control.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "source-unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/contracts/vertex-control.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-control.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-experience-status-reads.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "source-unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-experience-status-reads.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-experience.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Vertex capability unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-local-setup.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Local research setup is not available for this account",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-notification-read.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-policy.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-policy.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-read.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Vertex read service unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-conversation.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "outcome-unknown",
  },
  {
    count: 5,
    file: "packages/api/src/contracts/vertex-research-chat-conversation.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-research-chat-conversation.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-debate.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response-rpc.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Approve only this displayed exact debate plan/request after separate source-use and operation privacy review. Unknown ACK requires original-key inspection.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response-rpc.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Deliberately approve the displayed exact plan/request and invoke original admission. Blocked does not prove absence; unknown requires same-key inspection, not retry.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "context-retention-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "context-use-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "corpus-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "model-input-approval-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "model-input-preparation-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "outcome-unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "participant-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "policy-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "projection-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "research-runtime-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "review-unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat-response.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "worker-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "first-mate-configuration-unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/contracts/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-research-chat.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Vertex research chat service unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex-worker-rpc.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Worker service unavailable",
    open: true,
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex-worker.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 4,
    file: "packages/api/src/contracts/vertex-worker.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "filled+remaining=total using exact decimals; unknown requires unknown-outcome and all other statuses forbid that error; not-submitted/rejected require zero filled; other observed known statuses require brokerOrderRef; filled requires zero remaining; partially-filled requires both positive; submitted requires zero filled. Observation only.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "granted requires expiresAt>checkedAt; expired requires nonnull expiresAt<=checkedAt; unknown and denied never prove entitlement.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "missing requires observedAt=null; fresh/stale require observedAt; age=evaluatedAt-observedAt must be nonnegative; fresh iff age<=maxAgeMs; stale iff age>maxAgeMs; unknown never proves freshness.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "model-unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "provider-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Receipt must preserve unknown outcomes and exact fill arithmetic",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "source IDs, content hashes, unavailable IDs and duplicate mapping source IDs are individually unique; unavailable IDs cannot be present sources; declared content hashes exactly cover sources; both sides of each non-self duplicate mapping exist and have its hash; do not merge equal-content source identities.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "sourceTimestamp<=receivedAt; unknown aggressor remains unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "startAtInclusive<endAtExclusive<=captureTime; asOfAt<=captureTime; available vintage requires dataVintageId and unavailable requires null.",
    open: true,
  },
  {
    count: 5,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 12,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/contracts/vertex.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown-outcome",
  },
  {
    count: 3,
    file: "packages/api/src/deep-value-score.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "?",
  },
  {
    count: 1,
    file: "packages/api/src/deep-value-score.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "debt-unknown",
  },
  {
    count: 2,
    file: "packages/api/src/flow-options.ts",
    reason:
      "Stored words for a print without moneyness or side (plan rule 9: the table keeps unknown). The event detail names both (moneyness not reported, side not reported); open until the side enum gets a named value.",
    text: "unknown",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/flow-trade-signing.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/market-news.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/options-engine/book.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/options-engine/book.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown options field: ${}",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/options-engine/libm.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/price-alerts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/quant-multiple-testing.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Other trials exist, but none has usable returns, so the Sharpe variance across trials is unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/research-report-technicals.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "No stored daily bars in this revision: pivots, Weinstein stage, Fibonacci levels and the volume profile are unavailable.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/research-report-technicals.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/research-report-technicals.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Weinstein stage unavailable: the 30-week SMA or its slope is not a finite positive value inside the classified window.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/academy.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/server/academy.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Password step-up is not available on this server; overrides are refused",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/academy.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Portfolio feed unavailable: ${}.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/academy.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The live NLV is unavailable; state your NLV so the paper limits can be sized (recorded in the audit)",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/academy.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 4,
    file: "packages/api/src/server/agent-ops.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant-chart-tools.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Tool not available to the assistant",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant-runtime.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "- Certified terms first: for the owner's account (net liquidation or account value, P&L, positions, open options risk) and for certified research measures (backtest Sharpe and max drawdown, autopilot gate outcomes, paper deployment requests and the owner's approvals of them, drift levels), call terms_query with the matching term from terms_list and name the term and its source in the answer. The owner's account is the live IBKR account in the vertex-portfolio feed; the equity, positions and P&L in deployment_status belong to the paper exec node and never answer an account question. If terms_query says unknown or not_available, or no certified term covers the measure (for example buying power or Crown copy legs), say it is not available and give no number from another source or estimate.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant-runtime.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Not available in Plan mode; ask the operator to switch to Act mode",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant-runtime.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Procedure not available to the assistant",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant-runtime.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Tool not available to the assistant",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Assistant action storage unavailable. Apply migration 0029 if the table is missing.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/assistant.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Assistant storage unavailable. Apply migration 0022 if the tables are missing.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/deploy-status.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Tailnet snapshot unavailable:",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/deployment-requests.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Deployment request storage unavailable. Apply migration 0021 if the table is missing, and 0069 for the options column.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/flow-collect.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "; basis unknown",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/flow-collect.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "IBKR pacing unknown (history health failed)",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/flow-collect.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "market closed; gaps unavailable: ${}",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/flow-collect.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "No GEX estimate (regime unknown)",
    open: true,
  },
  {
    count: 6,
    file: "packages/api/src/server/flow-collect.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/server/flow-market-premium-collect.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/server/flow-snapshot.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "n/a",
  },
  {
    count: 2,
    file: "packages/api/src/server/flow-snapshot.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/gex-context.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 4,
    file: "packages/api/src/server/gex-context.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "n/a",
  },
  {
    count: 1,
    file: "packages/api/src/server/gex-context.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "OI is aggregated across all expiries, so the 0DTE vs monthly split of these levels is unknown. Levels from the front expiry roll off at its close. Flow share in the ${} h window${}: ${} 0DTE, ${} within 7 days.",
    open: true,
  },
  {
    count: 3,
    file: "packages/api/src/server/gex-context.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 3,
    file: "packages/api/src/server/gex-context.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "Unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/golive-drafts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/server/golive-drafts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/golive-send-gate.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "approved, engine unknown (${}; checked ${}); send refused until the node reads running-armed",
    open: true,
  },
  {
    count: 3,
    file: "packages/api/src/server/ibkr-monitor.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/ibkr-recovery.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Audit log unavailable; the request was not sent",
    open: true,
  },
  {
    count: 3,
    file: "packages/api/src/server/ibkr-recovery.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/ibkr-recovery.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 2,
    file: "packages/api/src/server/loopback-status.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/market-data.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "IBKR history service unavailable",
    open: true,
  },
  {
    count: 4,
    file: "packages/api/src/server/market-data.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 4,
    file: "packages/api/src/server/market-news.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/market-notes.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Unknown claim id ${}",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Answer one certified term: { term, params }. Returns status (ok, unknown or not_available), answer, rows, the SQL or feed path that produced them (query), source, unit and asOf. Account terms (net_liquidation, pnl, position, open_risk) read the owner's live IBKR account (vertex-portfolio feed), never the paper exec node. status unknown or not_available means: give no value. A term with several groupings (backtest_sharpe and backtest_max_drawdown: per strategy, and per run spec (symbol, timeframe, rule, stop loss, take profit, cost, date range) for engine runs with no strategy) runs each certified grouping; every row has a grain cell, and groupings says which ran and which wait for certification. Say which grouping each row uses. Their strategy parameter also matches the symbol of a run with no strategy (for example IWM).",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Congress trades are not available: the response was not a congress trade feed.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Insider clusters are not available: the response was not an insider cluster list.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Owner market notes are not available: the response was not a notes list.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Read-only QuantVPS trading-stack status: container services, plus session, positions, orders, fills, equity, risk (kill switch, limits, watchdog) and WARNING/ERROR logs when the tailnet snapshot is configured. Unavailable blocks carry a reason; snapshotError explains a v1 fallback. Its equity, positions and P&L belong to the exec-node account named in session.trading_mode (paper), not to the owner's IBKR account: for net liquidation, account P&L, positions or open risk use terms_query.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The smart money ranking is not available: the response was not a ranking.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Tool ${} needs a confirm card in the Vertex assistant; it is not available on the MCP endpoint",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/mcp.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown tool: ${}",
    open: true,
  },
  {
    count: 3,
    file: "packages/api/src/server/nautilus-arm.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Audit log unavailable; nothing was changed",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/nautilus-arm.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Password step-up is not available on this server; arming is refused",
    open: true,
  },
  {
    count: 5,
    file: "packages/api/src/server/nautilus-arm.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 2,
    file: "packages/api/src/server/nautilus-arm.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/optimizations.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Optimization storage unavailable. Apply migration 0020 if the table is missing.",
    open: true,
  },
  {
    count: 3,
    file: "packages/api/src/server/options-analytics.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/server/options-chain-ibkr.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/options-chain-quantdata.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 4,
    file: "packages/api/src/server/options-chain-yahoo.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 1,
    file: "packages/api/src/server/options-chain.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Options data source unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/pick-lists.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 3,
    file: "packages/api/src/server/portfolio-monitor.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 2,
    file: "packages/api/src/server/research-lenses.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 3,
    file: "packages/api/src/server/research-lenses.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "UNAVAILABLE",
  },
  {
    count: 2,
    file: "packages/api/src/server/research-screen.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/sector-rotation.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "; percent of NLV unknown (no NLV)",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Open risk is unknown: these option legs have no defined maximum loss under the certified definition: ${}.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The feed data is ${} minutes old (as of ${}); live account values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The feed data time ${} is in the future; values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The feed data time ${} is not a valid time; values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The feed has no data time; values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The feed reports a ${} account, not the live account; live account values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The IB gateway is ${}${}; live account values are unknown.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-feed-terms.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "No certified term is named ${}. Call terms_list for the catalog; if no term covers the measure, it is not available.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Not available: no feed reader is built for this term.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Not available. ${}",
    open: true,
  },
  {
    count: 4,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown parameter ${}. This term takes ${}.",
    open: true,
  },
  {
    count: 2,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown: ${}",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown: the vertex-portfolio feed is unavailable (${}). No value is given; the paper exec node is not a substitute.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/semantic-terms.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown${}: ${} No value is given.",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/strategy-library.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Strategy library storage unavailable: its tables or columns are missing, or a stored value is invalid. Apply the pending strategy-library migrations (0019, 0065).",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/strategy-series.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Series data is not available for ${} of ${}",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/strategy-series.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "The daily series store is not available on this server (needed for ${})",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/unsupported.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "@darkfactory/api/server is unavailable in browser bundles",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-chart-service.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 3,
    file: "packages/api/src/server/vertex-dispatch/dispatcher.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "notification-unknown",
  },
  {
    count: 14,
    file: "packages/api/src/server/vertex-dispatch/dispatcher.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 6,
    file: "packages/api/src/server/vertex-dispatch/dispatcher.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-experience-adapter.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-experience-core.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-experience-reads.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 3,
    file: "packages/api/src/server/vertex-experience-reads.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-orders-confirm.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-orders.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "intent store unavailable",
    open: true,
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-orders.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "outcome unknown: ${}",
    open: true,
  },
  {
    count: 4,
    file: "packages/api/src/server/vertex-orders.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-research-chat-conversation-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "model-input-preparation-unavailable",
  },
  {
    count: 5,
    file: "packages/api/src/server/vertex-research-chat-conversation-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "outcome-unknown",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-research-chat-conversation-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "projection-unavailable",
  },
  {
    count: 10,
    file: "packages/api/src/server/vertex-research-chat-conversation-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 5,
    file: "packages/api/src/server/vertex-research-chat-conversation-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-research-chat-execution-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/server/vertex-research-chat-output-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "research-chat-agent-admission-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "research-runtime-unavailable",
  },
  {
    count: 10,
    file: "packages/api/src/server/vertex-research-chat.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-config-notifications.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 12,
    file: "packages/api/src/server/vertex-runtime-epoch-approval.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-epoch-bytes.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-epoch-evidence.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 5,
    file: "packages/api/src/server/vertex-runtime-epoch-execution.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-epoch-execution.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown-outcome",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-runtime-epoch-historical.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-epoch-replay.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 3,
    file: "packages/api/src/server/vertex-runtime-epoch-replay.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-runtime-epoch-snapshot.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unknown",
  },
  {
    count: 5,
    file: "packages/api/src/server/vertex-runtime-epoch.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-gateway.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-runtime-model-evidence.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Current model-use evidence unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-model-evidence.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Current model-use read grant unavailable",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-model-use.ts",
    reason:
      "API text without its cause; replace it with a named state (cause, since when, next step).",
    text: "Current model-use context unavailable",
    open: true,
  },
  {
    count: 2,
    file: "packages/api/src/server/vertex-runtime-model-use.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "current-context-unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-native.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-objects.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime-policy-artifacts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 13,
    file: "packages/api/src/server/vertex-runtime-recipe-build.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 7,
    file: "packages/api/src/server/vertex-runtime-recipes.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 3,
    file: "packages/api/src/server/vertex-runtime-replay.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-runtime.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "unavailable",
  },
  {
    count: 1,
    file: "packages/api/src/server/vertex-worker-auth.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/signal-alerts.ts",
    reason:
      "API machine value (enum member, error code, key part or separator), not reader prose; the web layer decides how it is shown and the web scan checks that text.",
    text: "-",
  },
  {
    count: 1,
    file: "packages/api/src/strategy-dsl.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "frame monthly bars have high = low = close and no volume: atr, adx and rvol are not available",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/strategy-dsl.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "frame monthly bars have high = low = close and no volume: supertrend, chandelierExit and alphaTrend are not available",
    open: true,
  },
  {
    count: 1,
    file: "packages/api/src/strategy-dsl.ts",
    reason:
      "API text marked by rule when the API scan began (2026-11-20), not reviewed one by one; review it, then name the state or write its own reason.",
    text: "Unknown sector. Use a Select Sector SPDR symbol, for example XLK",
    open: true,
  },
];
