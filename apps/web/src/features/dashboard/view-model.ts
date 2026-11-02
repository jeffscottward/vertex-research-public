// Dashboard page state: what the /dashboard loader resolved for `dashboard.summary`.
// Used by: apps/web/src/app/(portal)/dashboard/page.tsx and the Mission control views.
import type { ApiClient } from "@darkfactory/api";

/** Raw output of the `dashboard.summary` contract, as the typed client returns it. */
export type DashboardSummary = Awaited<
  ReturnType<ApiClient["dashboard"]["summary"]>
>;

/** What the page loader resolved for this request. */
export type DashboardSummaryState =
  | Readonly<{ type: "ready"; summary: DashboardSummary }>
  | Readonly<{ type: "unauthorized" }>
  | Readonly<{ type: "error" }>;
