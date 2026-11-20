// Dashboard page state: what the /dashboard loader resolved for `dashboard.summary`.
// Used by: apps/web/src/app/(portal)/dashboard/page.tsx and the Mission control views.
import type { ApiClient } from "@darkfactory/api";

/** Raw output of the `dashboard.summary` contract, as the typed client returns it. */
export type DashboardSummary = Awaited<
  ReturnType<ApiClient["dashboard"]["summary"]>
>;

/**
 * Why `dashboard.summary` failed and when. `code` is the server's error code and HTTP status
 * ("STORAGE_ERROR 503"), or null when the request never got an answer.
 */
export type DashboardSummaryFailure = Readonly<{
  kind: "timeout" | "cancelled" | "request-failed";
  code: string | null;
  /** ISO time of the failure. */
  at: string;
  /** The page's own deadline in ms, set only when that deadline stopped the request. */
  timeoutMs?: number;
}>;

/** What the page loader resolved for this request. */
export type DashboardSummaryState =
  | Readonly<{ type: "ready"; summary: DashboardSummary }>
  | Readonly<{ type: "unauthorized" }>
  // `failure` is optional so states built before it existed (fixtures, lab) still type-check.
  | Readonly<{ type: "error"; failure?: DashboardSummaryFailure }>;
