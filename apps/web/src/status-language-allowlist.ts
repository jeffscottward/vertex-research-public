// biome-ignore-all lint/suspicious/noTemplateCurlyInString: entries quote source text, including template placeholders.
// Allow list of the status language guard (status-language.test.ts). Data only.
// An entry with `open: true` is a known ambiguous text from the audit of 2026-11-13: it leaves this
// list when its replacement merges. An entry without `open` was checked and is kept for its reason.
// Regenerate: UPDATE_STATUS_LANGUAGE=1 on the test, then `biome format --write` this file.

import type { StatusLanguageEntry } from "../../../scripts/lib/status-language.ts";

export const STATUS_LANGUAGE_ALLOWLIST: readonly StatusLanguageEntry[] = [
  {
    file: "app/(portal)/dashboard/page.tsx",
    text: "orpc.undeclared.SERVICE_UNAVAILABLE.503",
    count: 1,
    reason:
      "Not a status text: a failure category that quotes the oRPC error code and the HTTP status. The failure view gets it as `code`, next to the kind of the failure and its time.",
  },
  {
    file: "app/(portal)/dashboard/page.tsx",
    text: "unknown",
    count: 1,
    reason:
      'Not displayed: Log-only classification field, never rendered. Optional rename to "unclassified" for log clarity.',
  },
  {
    file: "app/(public)/_components/legal-page.tsx",
    text: "Identify configured providers, external terms, integration boundaries, and what happens when an optional capability becomes unavailable.",
    count: 1,
    reason:
      "Kept: Static legal template guidance text, not a state. Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
  },
  {
    file: "app/(public)/about/page.tsx",
    text: "Unknown availability, missing context, and incomplete integration are not design problems to conceal. They are information the researcher needs.",
    count: 1,
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
  },
  {
    file: "app/(public)/features/page.tsx",
    text: "Unavailable sources remain unavailable. Missing records stay missing. Failed validation prevents an artifact from being displayed.",
    count: 1,
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
  },
  {
    file: "app/(public)/not-found.tsx",
    text: "That page is not available.",
    count: 1,
    reason:
      "Kept: Specific 404 title with cause in the description and a Return home action.",
  },
  {
    file: "app/(public)/not-found.tsx",
    text: "The requested public route is not available. Browse the field guide or return to the Vertex Research overview.",
    count: 1,
    reason:
      "Kept: Specific: names the cause (route does not exist, eyebrow 404) and the next step (field guide or home link).",
  },
  {
    file: "app/(public)/page.tsx",
    text: "Availability comes from the connected source. When a service is unavailable, the workspace says so. No simulated market feed. No invented research results.",
    count: 1,
    reason:
      "Kept: Static prose that states the product rule on unavailable services. Not a runtime status.",
  },
  {
    file: "app/(public)/page.tsx",
    text: "Good research is not another signal. It is knowing what supports a claim, what limits it, and what remains unknown.",
    count: 1,
    reason:
      "Kept: Static marketing prose; 'unknown' is used as a concept, not a state.",
  },
  {
    file: "app/(public)/resources/page.tsx",
    text: "An empty catalog, denied access, a missing identity, an unavailable service, and a malformed response are different states. The workspace keeps them distinct and avoids substituting sample data.",
    count: 1,
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource. It explicitly lists the distinct states.",
  },
  {
    file: "app/(public)/resources/page.tsx",
    text: "How to read identities, provenance, review status, and unavailable states in Vertex Research.",
    count: 1,
    reason:
      "Kept: page meta description (search snippets and link previews); prose about the documentation, not a status.",
  },
  {
    file: "app/(public)/resources/page.tsx",
    text: "Unavailable is a useful answer",
    count: 1,
    reason:
      "Kept: Static public prose that describes product policy on unavailable states. It is not a runtime status of any resource.",
  },
  {
    file: "app/api/orpc/[...rest]/contact-runtime.ts",
    text: "unknown",
    count: 1,
    reason:
      "Not displayed: Internal rate-limit/source bucket key for the contact endpoint; never rendered to the user.",
  },
  {
    file: "app/api/orpc/[...rest]/route.ts",
    text: "SERVICE_UNAVAILABLE",
    count: 1,
    reason:
      "Error code of the contact response (503), not a sentence. The message next to it names the cause (the limit check failed).",
  },
  {
    file: "app/api/orpc/[...rest]/runtime.ts",
    text: "unknown",
    count: 3,
    reason:
      "Not displayed: Internal telemetry consent enum passed to the oRPC analytics context; treated as no consent, never rendered. Note: three causes (malformed, conflict, absent) share one value; only matters for logs.",
  },
  {
    file: "components/account/address-page-client.tsx",
    text: "The address creation outcome is unknown. Reload the address list before creating another.",
    count: 1,
    reason:
      "Kept: A real unknown outcome, named precisely with its resolution path (reload the list before creating another).",
  },
  {
    file: "components/admin/admin-users-client.ts",
    text: "The user directory is temporarily unavailable. Try again.",
    count: 1,
    reason:
      "Kept: Names the cause (directory storage, temporary) and the next step (try again).",
  },
  {
    file: "components/contact/contact-client.ts",
    text: "Email delivery is temporarily unavailable. Your message was not sent. Try again later.",
    count: 1,
    reason:
      "Kept: Names the cause (email delivery), the outcome (message not sent) and the next step (try again later).",
  },
  {
    file: "components/portal/academy/lesson-backtest.tsx",
    text: "-",
    count: 1,
    reason: "Kept: Minus sign of a real negative number, not a placeholder.",
  },
  {
    file: "components/portal/academy/lesson-deploy.tsx",
    text: "unavailable",
    count: 1,
    reason:
      'Kept: The cause follows immediately in parentheses from gate.nlvDetail (API-supplied reason for the missing NLV). Could read "NLV not received" but the cause is present.',
  },
  {
    file: "components/portal/account-glance.tsx",
    text: "IBKR_MONITOR_URL is not set on this server",
    count: 1,
    reason:
      "Kept: names the missing server setting, which is the cause and the fix.",
  },
  {
    file: "components/portal/agent-model-runs-client.ts",
    text: "Model run storage unavailable (503). Retry.",
    count: 1,
    reason:
      "Kept: Names the cause (model run storage, 503) and the next step (retry).",
  },
  {
    file: "components/portal/agent-model-runs-workspace.tsx",
    text: "(not set)",
    count: 1,
    reason:
      'Audit 2026-11-13: ambiguous. Replace: name the missing field of the grouped row, for example "no model recorded" or "no agent recorded" from the active group-by column.',
    open: true,
  },
  {
    file: "components/portal/basket-chart.tsx",
    text: "–",
    count: 1,
    reason: "Kept: En dash separates two real values (min and max).",
  },
  {
    file: "components/portal/basket-chart.tsx",
    text: "—",
    count: 1,
    reason:
      "Kept: Legend glyph for the solid line of the basket symbol; not a placeholder.",
  },
  {
    file: "components/portal/basket-chart.tsx",
    text: "No index history yet. Daily closes are not available for every member.",
    count: 1,
    reason:
      "Kept: Names the cause: no date has a close for every member. The per-symbol causes are listed next to it by baskets-workspace.tsx:160-172 (stale symbols, unavailable symbols with reason).",
  },
  {
    file: "components/portal/baskets-workspace.tsx",
    text: "History unavailable:",
    count: 1,
    reason:
      "Kept: The following expression `entry.symbol (entry.reason)` carries the cause per symbol; reason is the non-null API field of each unavailable entry.",
  },
  {
    file: "components/portal/breadth-90-card.tsx",
    text: "Breadth-90 signal unavailable.",
    count: 1,
    reason:
      "Kept: state.message is errorMessage(error): the server's error message (fallback 'Request failed.' only when the error has no message). 'Retry now' follows.",
  },
  {
    file: "components/portal/calendar-workspace.tsx",
    text: "Economic releases unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/charts-analysis-panels.tsx",
    text: "—",
    count: 1,
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Replace the dash with "too few bars" (count is in scope) so a missing statistic is not read as zero.',
    open: true,
  },
  {
    file: "components/portal/charts-workspace.tsx",
    text: "—",
    count: 1,
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Show "as-of time not reported by source"; fetchedAt is shown next to it and can be named as the fallback.',
    open: true,
  },
  {
    file: "components/portal/congress-trades-workspace.tsx",
    text: "–",
    count: 1,
    reason:
      'Kept: the en dash is the range in the pager text "Showing 1–50 of N", not a missing value.',
  },
  {
    file: "components/portal/congress-trades-workspace.tsx",
    text: "—",
    count: 1,
    reason:
      "Kept: NOT_REPORTED, one constant for a table cell the filing leaves empty (holder, ticker, trade date, delay, reason). The page footer and plan-pr1.md section 4 define it; a word in each narrow column would push the table wider.",
  },
  {
    file: "components/portal/dashboard-widgets-model.ts",
    text: "-",
    count: 1,
    reason:
      "Kept: separator of an ISO date key (year-month-day), not a placeholder.",
  },
  {
    file: "components/portal/deployment-requests-workspace.tsx",
    text: "Deployment request storage unavailable (503). Apply migration 0021 if the table is missing.",
    count: 1,
    reason:
      "Kept: Names the cause (storage, 503) and the next step (apply migration 0021).",
  },
  {
    file: "components/portal/deployments-snapshot.tsx",
    text: "—",
    count: 6,
    reason:
      'Audit 2026-11-13: ambiguous. Replace: Split by caller: "not started", "not reported by VPS"; block.available/reason in scope gives the cause where the block is down.',
    open: true,
  },
  {
    file: "components/portal/deployments-snapshot.tsx",
    text: "Unavailable:",
    count: 1,
    reason:
      "Kept: The following `reason` carries the cause: block.reason from the API, or data.snapshotError, or 'tailnet snapshot not configured (VERTEX_DEPLOY_STATUS_V2_URL)'.",
  },
  {
    file: "components/portal/engines-workspace.tsx",
    text: "Engine status unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/filter-studies-section.tsx",
    text: "Filter studies unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows. A timeout gives 'No answer in N s'.",
  },
  {
    file: "components/portal/flow-workspace.tsx",
    text: "–",
    count: 1,
    reason: "Kept: En dash separates two real times.",
  },
  {
    file: "components/portal/flow-workspace.tsx",
    text: "—",
    count: 1,
    reason: 'Kept: Empty flag list means none; could read "none".',
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "Account value not available: ${}",
    count: 1,
    reason:
      'Kept: Names the state and the reason from unavailableReason; fallback "no reason reported" should be removed by making the API always send a reason.',
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "Approved; the send outcome is unknown",
    count: 2,
    reason:
      "Kept: Real unknown, named precisely: the server message follows in brackets and the next step is 'Check open orders at IBKR before doing anything else.'",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "not available: ${}",
    count: 1,
    reason: "Kept: Gives the cause (sizing reason text).",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "Not found at IBKR: the outcome was unknown and a later check did not find the order. Not sent again here; check the IBKR order history.",
    count: 1,
    reason: "Kept: Specific: cause, what was done, next step.",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "not known to this page version (${})",
    count: 1,
    reason:
      "Kept: names the cause (the page version is older than the state the server sent) and prints the value.",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "Not known: the order records could not be read. Reload the queue; the send button needs a known state.",
    count: 1,
    reason:
      "Kept: real uncertainty with its cause (the order records could not be read) and the next step (reload; sending stays off).",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "Outcome unknown: the order may still reach IBKR. Check open orders at IBKR; the next order preview checks it.",
    count: 1,
    reason:
      "Kept: Real unknown outcome with resolution path (next preview checks it); add since-when if the API has the send time.",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "result_not_known",
    count: 1,
    reason:
      "Not displayed: a value of the field `aftermath` that code compares. The text next to it says whether the decision was recorded or that this is not known, and why.",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "so it is not known whether it was recorded.",
    count: 1,
    reason:
      "Kept: real uncertainty with its cause: the request did not return, so the record is not confirmed; the sentence before it names the request.",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "The generator has not reported for ${}, so entry signals are not known.",
    count: 1,
    reason:
      "Kept: real uncertainty with its cause and since-when (the generator has not reported for the stated time).",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "The generator has not reported for ${}, so it is not known whether the model holds a position the account does not.",
    count: 1,
    reason:
      "Kept: real uncertainty with its cause and since-when (the generator has not reported for the stated time).",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "The send outcome is unknown",
    count: 2,
    reason:
      "Kept: Real unknown, named precisely with the server message and the next step (check open orders at IBKR).",
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "The server answered that it is not set up for this ${}, ${}",
    count: 1,
    reason:
      'Kept: "not set up" names a server configuration state as the cause of the refusal; it is not a placeholder.',
  },
  {
    file: "components/portal/golive-draft-queue-model.ts",
    text: "The server is not set up to answer this request.",
    count: 1,
    reason:
      'Kept: "not set up" names a server configuration state as the cause of the refusal; it is not a placeholder.',
  },
  {
    file: "components/portal/golive-draft-queue.tsx",
    text: "Order drafts unavailable.",
    count: 1,
    reason:
      "Kept: state.message is loadErrorText(error): cause words per failure class plus the server detail and the note that a load records nothing. Reload button follows.",
  },
  {
    file: "components/portal/golive-draft-queue.tsx",
    text: "unknown",
    count: 1,
    reason:
      "Not displayed: Discriminator value; text comes from sendOutcomeText.",
  },
  {
    file: "components/portal/insider-clusters-workspace.tsx",
    text: "—",
    count: 1,
    reason:
      "Kept: NOT_REPORTED, one constant for a 10b5-1 cell or newest complete day the source leaves empty. The page footer defines it; a word in the narrow column would push the table wider.",
  },
  {
    file: "components/portal/market-context-workspace.tsx",
    text: "Market context unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/market-feeds-workspace.tsx",
    text: "GEX, macro and news unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/market-news-workspace.tsx",
    text: "8-K filings unavailable:",
    count: 1,
    reason:
      "Kept: The following `failures.filings` is the server's failure detail for the filings source of this ticker (splitSourceErrors strips the prefix).",
  },
  {
    file: "components/portal/market-news-workspace.tsx",
    text: "Headlines unavailable",
    count: 1,
    reason:
      'Kept: Followed by ": <failures.headlines>" which names the failing sources.',
  },
  {
    file: "components/portal/options-analytics-panel.tsx",
    text: "-",
    count: 1,
    reason:
      "Kept: the minus sign of a number or of a subtraction in an expression; it is a real value, not a placeholder.",
  },
  {
    file: "components/portal/order-flow-views.tsx",
    text: "–",
    count: 1,
    reason: "Kept: En dash separates two real values.",
  },
  {
    file: "components/portal/owner-market-notes-card.tsx",
    text: "Owner market notes unavailable.",
    count: 1,
    reason:
      "Kept: state.message is errorMessage(error): the server's error message (fallback 'Request failed.' only when the error has no message). Retry follows.",
  },
  {
    file: "components/portal/papers-workspace.tsx",
    text: "–",
    count: 1,
    reason: "Kept: En dash separates two real numbers.",
  },
  {
    file: "components/portal/pick-list-import.ts",
    text: "-",
    count: 1,
    reason:
      "Kept: hyphen that replaces other characters in a slug, not a placeholder.",
  },
  {
    file: "components/portal/plays-workspace.tsx",
    text: "—",
    count: 1,
    reason: "Kept: Optional link absent; not a status. Could read 'No link'.",
  },
  {
    file: "components/portal/plays-workspace.tsx",
    text: "Plays list unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/portfolio-monitor-client.ts",
    text: "unavailable",
    count: 1,
    reason: "Not displayed: TypeScript discriminant, never rendered.",
  },
  {
    file: "components/portal/portfolio-monitor.tsx",
    text: "VERTEX_PORTFOLIO_URL is not set on this server",
    count: 1,
    reason:
      "Kept: names the missing server setting, which is the cause and the fix.",
  },
  {
    file: "components/portal/quant-lab-panel.tsx",
    text: "Quant Lab unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows.",
  },
  {
    file: "components/portal/sector-rotation-workspace.tsx",
    text: "–",
    count: 1,
    reason:
      "Kept: Symbol is shown in the row header; missing descriptive name is not a state.",
  },
  {
    file: "components/portal/strategy-backtest-study.tsx",
    text: "…",
    count: 1,
    reason:
      "Kept: Ellipsis marks a truncated hash, not a loading or unknown state.",
  },
  {
    file: "components/portal/strategy-backtest-study.tsx",
    text: "Backtest study unavailable.",
    count: 1,
    reason:
      "Kept: state.message is `${failure.code}: ${failure.message}` from describePortfolioMonitorFailure: the server error code and message (fallback 'ERROR: Request failed' only when the error has neither). A retry button follows. The kind mismatch gives 'Study <slug> is not a <kind> study.'",
  },
  {
    file: "components/portal/strategy-builder-model.ts",
    text: "-",
    count: 1,
    reason:
      "Kept: the minus sign of a number or of a subtraction in an expression; it is a real value, not a placeholder.",
  },
  {
    file: "components/portal/strategy-library-detail.tsx",
    text: "Clipboard unavailable; preset ${} text is shown below.",
    count: 1,
    reason: "Kept: Names the cause and the fallback (text shown below).",
  },
  {
    file: "components/portal/strategy-library-workspace.tsx",
    text: "—",
    count: 1,
    reason: "Kept: Empty optional user field.",
  },
  {
    file: "components/portal/strategy-library-workspace.tsx",
    text: "Strategy library storage unavailable (503): its tables or columns are missing, or a stored value is invalid. Apply the pending strategy-library migrations (0019, 0065).",
    count: 1,
    reason:
      "Kept: names the cause (missing tables or columns, or an invalid stored value) and the fix (apply migrations 0019, 0065).",
  },
  {
    file: "components/portal/vertex-orders.tsx",
    text: "Calls or puts, limit order, day order. Share orders and naked short options are not available.",
    count: 1,
    reason:
      "Kept: Static prose that states the limits of the ticket (which order types exist). Not a runtime state.",
  },
  {
    file: "components/portal/watchlist-exposure.tsx",
    text: "—",
    count: 1,
    reason:
      "Kept: Binary column; dash means 'Not on watchlist'. Better to write it out.",
  },
  {
    file: "components/portal/watchlist-exposure.tsx",
    text: "…",
    count: 2,
    reason:
      "Kept: Ellipsis separates two real bounds. Line 378 'Loading positions…' is a separate loading text.",
  },
  {
    file: "components/portal/watchlist-exposure.tsx",
    text: "Positions unavailable (${}): ${}",
    count: 1,
    reason:
      "Kept: Shows failure code and message and has a retry button. Could add the time.",
  },
  {
    file: "components/portal/watchlist-relationships.tsx",
    text: "—",
    count: 1,
    reason:
      "Kept: Cell title states the cause and the threshold (overlap vs MIN_CORRELATION_OVERLAP). Hover only: consider visible legend.",
  },
  {
    file: "components/portal/watchlist-research.tsx",
    text: "Not set",
    count: 1,
    reason:
      'Kept: the buy zone is an optional value that the user enters; "Not set" states that the user has not entered one.',
  },
  {
    file: "components/portal/watchlist-workspace.tsx",
    text: "—",
    count: 4,
    reason:
      "Kept: Optional user-entered field. Note line 100 prints a one-sided zone as '— – X'; better 'up to X' / 'from X'.",
  },
  {
    file: "components/research/vertex-client.ts",
    text: "unavailable",
    count: 1,
    reason: "Not displayed: TypeScript discriminant.",
  },
  {
    file: "components/user-menu.tsx",
    text: "?",
    count: 1,
    reason: "Kept: Avatar fallback glyph, not a status.",
  },
  {
    file: "features/charts/chart-workstation.tsx",
    text: "Screenshot is not available yet.",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split: 'Chart is still loading; try again when bars are drawn' vs 'This renderer cannot export images'. renderer/snapshot presence is in scope.",
    open: true,
  },
  {
    file: "features/charts/indicators.ts",
    text: "Candle freshness is unknown or missing.",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split by freshness.status: 'Candle freshness not reported by <sourceId>' (missing) vs 'Candle freshness could not be evaluated' (unknown); add candle time. Status and source are in scope.",
    open: true,
  },
  {
    file: "features/charts/indicators.ts",
    text: "Current display rights are unavailable for a candle.",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Split into: 'Display rights not granted for <provider/sourceId>', 'Display rights expired at <expiresAt>', 'Rights check is newer than evaluation time'. rights.status, expiresAt, checkedAt are in scope.",
    open: true,
  },
  {
    file: "features/charts/indicators.ts",
    text: "unavailable",
    count: 2,
    reason: "Not displayed: Identifier, not a text.",
  },
  {
    file: "features/charts/kline-adapter.ts",
    text: "Unknown built-in study",
    count: 1,
    reason:
      'Not displayed: Programming guard; "Unknown" means unrecognised identifier, not a status.',
  },
  {
    file: "features/charts/kline-adapter.ts",
    text: "Unknown Vertex study",
    count: 1,
    reason:
      'Not displayed: Programming guard; "Unknown" means unrecognised identifier, not a status.',
  },
  {
    file: "features/charts/market-chart.tsx",
    text: "Chart renderer unavailable.",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with 'Chart renderer failed to load · exact values are in the table below · reload the page to retry'. To name the cause the host must pass the load error (one extra prop).",
    open: true,
  },
  {
    file: "features/charts/renderer-host.tsx",
    text: "Chart renderer unavailable. Exact data remains in the table.",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Names the fallback but not the cause or next step. Use 'Chart renderer failed to load (<error name>) · exact data is in the table · reload to retry'; needs the caught error passed to the caption.",
    open: true,
  },
  {
    file: "features/charts/script-sandbox.ts",
    text: "unknown error",
    count: 1,
    reason:
      "Audit 2026-11-13: ambiguous. Replace: Replace with String(error) so the thrown value is shown: 'Script engine failed: <thrown value>'.",
    open: true,
  },
  {
    file: "features/charts/workstation.ts",
    text: "-",
    count: 2,
    reason:
      "Kept: hyphen in an export file name (symbol slug and time stamp), not a placeholder.",
  },
  {
    file: "features/click-log/install.ts",
    text: "unknown",
    count: 1,
    reason: "Not displayed: Telemetry field only; not rendered in the UI.",
  },
  {
    file: "features/experience/agents.tsx",
    text: "Unavailable — no model supplied",
    count: 1,
    reason:
      "Kept: Names the cause (artifact records no model). Static artifact field, not a live status.",
  },
  {
    file: "features/experience/portfolio.tsx",
    text: "Cash is not available or spendable cash. No amount is derived by subtracting reservations, adding positions or aggregating currencies.",
    count: 1,
    reason:
      "Kept: Static prose that states a limit: the cash figure is the source value and nothing is derived. 'not available' here means 'not the available-funds figure'.",
  },
  {
    file: "features/experience/portfolio.tsx",
    text: "No balances or holdings have been supplied. Empty collections and unknown values are not zero.",
    count: 1,
    reason:
      "Kept: Prose that states the rule (empty and unknown are not zero). Its notice title names the state and time: 'Portfolio source reported no portfolio data for <env> at <time>'.",
  },
  {
    file: "features/experience/portfolio.tsx",
    text: "Nonauthoritative native-owner projections. Reserved, spent, released and unknown states do not grant spending permission. This view cannot reserve, release, reconcile or submit.",
    count: 1,
    reason:
      'Kept: static description of the view; "unknown" names one of the budget states it lists, it is not a status.',
  },
  {
    file: "features/experience/portfolio.tsx",
    text: "source-unavailable",
    count: 1,
    reason:
      "Kept: protocol key of the read-reason map; the page prints the mapped title 'Portfolio source not responding for <env>', never this key.",
  },
  {
    file: "features/experience/portfolio.tsx",
    text: "Unknown — not supplied",
    count: 1,
    reason:
      "Kept: Names the cause (source did not supply the value) and avoids showing zero.",
  },
  {
    file: "features/experience/research-chat-client.ts",
    text: "-",
    count: 1,
    reason:
      'Kept: base64url encoding replaces "+" with a hyphen; it is not a displayed text.',
  },
  {
    file: "features/experience/research-chat-room.tsx",
    text: "Write not acknowledged — outcome may be unknown",
    count: 1,
    reason:
      "Kept: Real unknown outcome with failure detail, retained draft and recovery actions.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Ordinary expert selection requests a governed preview only, not availability or execution permission. Unavailable or incomplete corpus status remains unchanged. The server must check the current configuration, corpus and exact request; it may return unavailable. Preparation creates no governed copies, submits no approval and dispatches no model work.",
    count: 1,
    reason:
      "Kept: Explanatory prose on what a preview request does and does not grant. Rule text, not a state.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Reference metadata remains when private content is unavailable. It is not current read permission or execution authority.",
    count: 1,
    reason:
      "Kept: Explanatory prose on what the reference metadata means. Rule text.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Room membership does not request a response or activate an unavailable agent.",
    count: 1,
    reason:
      "Kept: Explanatory prose: membership does not trigger or activate an agent. Each participant's own availability label is shown above it.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Selecting a first speaker requests a governed debate preview only; unavailable or incomplete corpus status is unchanged. The server checks the exact configured pair and may refuse the selected first speaker. Preparation may record plan/run metadata and read previously authorized predecessor inputs, but creates no new governed copies or model dispatch. Review and separately approve only the returned preview for this turn.",
    count: 1,
    reason:
      "Kept: Explanatory prose on the scope of a debate preview. Rule text.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Source-implemented workflow, not a claim of live availability. Only one shared reviewed corpus and identical review pins are supported. The server resolves the configured participants, selected synthesizer and budgets; incompatible selections remain unavailable. No automatic turns or client-issued reviews.",
    count: 1,
    reason:
      "Kept: Explanatory prose on the limits of the debate workflow. Rule text.",
  },
  {
    file: "features/experience/research-chat-view.tsx",
    text: "Unknown outcomes are inspect-only for the original key. Inspection never retries a model request. Eligibility is not publication or a completed answer.",
    count: 1,
    reason:
      "Kept: Rule text for a real unknown outcome: names the resolution path (inspect the original key, no retry).",
  },
  {
    file: "features/experience/shared.tsx",
    text: "—",
    count: 1,
    reason: "Kept: Em dash separates two real values.",
  },
  {
    file: "features/experience/shared.tsx",
    text: "The request outcome may be unknown after a timeout or disconnect. Inspect Agents & runs or Audit before retrying. A stopped browser request does not cancel a server job.",
    count: 1,
    reason:
      "Kept: Explanatory prose for a real unknown outcome: says when it happens and where to check before a retry. The cause is in state.failure.title/detail above it.",
  },
  {
    file: "features/experience/strategies.tsx",
    text: "Referenced evidence unavailable in this dossier",
    count: 1,
    reason:
      "Kept: Specific: names the id and that the dossier does not include the record.",
  },
  {
    file: "features/experience/strategies.tsx",
    text: "Referenced manifest unavailable in this dossier",
    count: 1,
    reason:
      "Kept: Specific: names the id and that the dossier does not include the record.",
  },
  {
    file: "features/experience/today.tsx",
    text: "continuity:unavailable",
    count: 1,
    reason: "Not displayed: React key / identifier.",
  },
  {
    file: "features/experience/today.tsx",
    text: "Unknown — not supplied",
    count: 1,
    reason: "Kept: Names the cause (no digest supplied for this item).",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Change or clear the search to inspect this returned scope. Sequence warnings and unknown-outcome counts above have not been filtered out.",
    count: 1,
    reason:
      "Kept: Definite state (no match) with the next step; 'unknown-outcome' is the name of a counter.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Compare the exact host fingerprint through the provider console you already trust. Do not accept an unknown host key or paste credentials into this workspace.",
    count: 1,
    reason:
      "Kept: Instruction prose; 'unknown host key' is a security term, not a state.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Have the authorized owner inspect existing orders, fills and balances in the trusted broker system and reconcile unknown outcomes. An empty list, timeout or connected socket is not proof of reconciliation.",
    count: 1,
    reason:
      "Kept: Instruction prose that gives the resolution path for unknown outcomes.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "No receipts or native facts were returned for this account and environment. This is not proof that no orders exist, that an unknown outcome resolved, or that the broker reconciled.",
    count: 1,
    reason:
      "Kept: Definite state (nothing returned for this account and environment) and what it does not prove. Rule text.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Owner epoch changed from ${} to ${}. Cross-epoch continuity is unknown; this is not reconciliation success.",
    count: 1,
    reason: "Kept: Names the cause (epoch A to B) and what it does not prove.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Reported unknown counts across returned reconciliation facts:",
    count: 1,
    reason:
      "Kept: The following `index.reportedUnknownCount` is a real count; the text says what it is and what it is not.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Sequence coverage gap: returned history begins at ${}, not 1. Earlier observations are unavailable in this response.",
    count: 1,
    reason:
      "Kept: Names the cause (history starts at sequence N in this response).",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Source reports reconciled with zero unknown; not an independent reconciliation certificate.",
    count: 1,
    reason: "Kept: Definite state with its limit stated.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "This page does not clear browser-wide data, store passwords or copy account preferences. Read failures show permission, unavailable or malformed-source states. They do not show sample data.",
    count: 1,
    reason:
      "Kept: Static prose on what the page does not do and which failure states it shows.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "This status does not include heartbeat freshness, account reconciliation evidence, a host fingerprint or a recovery challenge. These values remain unknown.",
    count: 1,
    reason:
      "Kept: Names exactly which four facts this read does not supply; the resolution path is the 'Required human actions' list on the same page.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Unknown count (source)",
    count: 1,
    reason: "Kept: Field label for a count, marked as source-reported.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Unknown does not mean not submitted, rejected or cancelled. Do not repeat an order to find out. The authorized human owner must reconcile through the trusted broker system. This count includes rows hidden by search and pagination.",
    count: 1,
    reason:
      "Kept: Rule text for a real unknown outcome: what it does not mean and who resolves it (owner reconciles in the broker system).",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Unknown execution outcomes",
    count: 1,
    reason:
      "Kept: Real unknown outcome; body gives the count, what it does not mean and the resolution path (owner reconciles at the broker).",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "Unknown execution outcomes:",
    count: 1,
    reason:
      "Kept: Real unknown, kept on purpose: the following `index.unknownCount` is the count and the paragraph below gives the resolution path.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "UNKNOWN OUTCOME — reconciliation required",
    count: 1,
    reason:
      "Kept: Real unknown outcome named with its resolution path; error class is shown below.",
  },
  {
    file: "features/experience/utilities.tsx",
    text: "UNRESOLVED RECONCILIATION — ${} unknown (source)",
    count: 1,
    reason: "Kept: Real unknown kept, with count and source attribution.",
  },
  {
    file: "features/openbb/openbb-panels.tsx",
    text: "…",
    count: 1,
    reason:
      "Kept: 'Loading <what>…' shows for at most OPENBB_REQUEST_TIMEOUT_MS (30 s); then the panel says '<what> requested at HH:MM · no answer after 30 s' with Retry, and a late answer replaces it.",
  },
  {
    file: "features/openbb/openbb-panels.tsx",
    text: "unavailable.",
    count: 1,
    reason:
      "Kept: The following state.message is `${failure.code}: ${failure.message}` (or 'Operator access required') from describePortfolioMonitorFailure.",
  },
  {
    file: "features/stock-detail/fake-gateways.ts",
    text: "IBKR history service unavailable (dummy)",
    count: 1,
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
  },
  {
    file: "features/stock-detail/fake-gateways.ts",
    text: "Options data source unavailable (dummy)",
    count: 1,
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
  },
  {
    file: "features/stock-detail/fake-gateways.ts",
    text: "UNAVAILABLE",
    count: 2,
    reason:
      "Not displayed: Dummy fixture marked (dummy); not a production text.",
  },
  {
    file: "features/stock-detail/stock-detail-workspace.tsx",
    text: "?",
    count: 1,
    reason: "Not displayed: URL token.",
  },
  {
    file: "features/stock-detail/stock-detail-workspace.tsx",
    text: "…",
    count: 1,
    reason:
      "Kept: 'Loading <symbol>…' shows only before the first effect reads the URL, when no request is open yet; the option-chain read that follows says 'requested at HH:MM · no answer after 30 s' with Retry after CHAIN_REQUEST_TIMEOUT_MS.",
  },
  {
    file: "lib/server-session.ts",
    text: "unknown",
    count: 1,
    reason:
      "Not displayed: fallback error name of the session deny check; it is compared and logged, never rendered.",
  },
];
