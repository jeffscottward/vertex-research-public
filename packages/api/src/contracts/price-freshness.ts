import { oc } from "@orpc/contract";
import { z } from "zod";

// oRPC contracts for stored daily price series and 1d bar series freshness alerting
// (docs/vertex-rebuild/designs/price-freshness-alert/plan.md). Mounted under openbb.* in
// packages/api/src/contracts/openbb.ts. Research data alerting only: no orders.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD date");
const count = z.number().int().nonnegative();
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/[\r\n\0]/u.test(value),
      "must not contain line breaks or NUL bytes"
    );

const OPENBB_FRESHNESS_TABLES = ["daily_series", "daily_bars"] as const;
const OPENBB_FRESHNESS_ACTIONS = [
  "noop",
  "in-flight",
  "prune-active",
  "clear-pending",
  "alert",
  "recovery",
] as const;

const OpenbbStaleSeriesSchema = z.strictObject({
  id: z.string(),
  lastDate: isoDate.nullable(),
  maxSessionsBehind: count,
  sessionsBehind: count.nullable(),
  table: z.enum(OPENBB_FRESHNESS_TABLES),
});

const OpenbbPlannedAlertSchema = z.strictObject({
  body: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

const OpenbbPendingChatAlertSchema = z.strictObject({
  body: z.string(),
  eventId: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

export const OpenbbPriceFreshnessInputSchema = z.strictObject({});

export const OpenbbPriceFreshnessOutputSchema = z.strictObject({
  activeAlertKeys: z.array(z.string()),
  checkedAt: z.date(),
  dailyBarsCount: count,
  dailySeriesCount: count,
  expectedSession: isoDate,
  ntfyConfigured: z.boolean(),
  pendingDelivery: z.enum(["pending", "not-configured", "failed"]).nullable(),
  pendingKind: z.enum(["alert", "recovery"]).nullable(),
  stale: z.array(OpenbbStaleSeriesSchema),
});

export const OpenbbCheckPriceFreshnessInputSchema = z.strictObject({
  dryRun: z.boolean().optional(),
});

export const OpenbbCheckPriceFreshnessOutputSchema = z.strictObject({
  action: z.enum(OPENBB_FRESHNESS_ACTIONS),
  activeAlertKeys: z.array(z.string()),
  checkedAt: z.date(),
  dailyBarsCount: count,
  dailySeriesCount: count,
  delivery: z.enum(["sent", "not-configured", "failed", "dry-run"]).nullable(),
  dryRun: z.boolean(),
  expectedSession: isoDate,
  newlyStale: z.array(OpenbbStaleSeriesSchema),
  ntfyConfigured: z.boolean(),
  pendingChat: OpenbbPendingChatAlertSchema.nullable(),
  plannedAlert: OpenbbPlannedAlertSchema.nullable(),
  stale: z.array(OpenbbStaleSeriesSchema),
});

export const OpenbbRecordPriceFreshnessChatInputSchema = z.strictObject({
  delivery: z.enum(["sent", "failed"]),
  eventId: label(80),
});

export const OpenbbRecordPriceFreshnessChatOutputSchema = z.object({
  committed: z.boolean(),
  delivery: z.enum(["sent", "failed"]),
  eventId: z.string(),
});

export type OpenbbPriceFreshnessOutput = z.infer<
  typeof OpenbbPriceFreshnessOutputSchema
>;
export type OpenbbCheckPriceFreshnessOutput = z.infer<
  typeof OpenbbCheckPriceFreshnessOutputSchema
>;

const OPENBB_FRESHNESS_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "OpenBB storage: database request failed; request not confirmed; reload to check, then retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const openbb = oc.errors(OPENBB_FRESHNESS_API_ERRORS);
const tags = ["OpenBB"];

export const openbbPriceFreshnessContract = {
  checkPriceFreshness: openbb
    .route({
      method: "POST",
      operationId: "openbb.checkPriceFreshness",
      path: "/openbb/price-freshness/check",
      summary:
        "Scheduler: evaluate stored daily price and 1d bar freshness and send alerts",
      tags,
    })
    .input(OpenbbCheckPriceFreshnessInputSchema)
    .output(OpenbbCheckPriceFreshnessOutputSchema),
  priceFreshness: openbb
    .route({
      method: "GET",
      operationId: "openbb.priceFreshness",
      path: "/openbb/price-freshness",
      summary:
        "Stored daily series and 1d bar freshness against the 06:00 ET NYSE SLA",
      tags,
    })
    .input(OpenbbPriceFreshnessInputSchema)
    .output(OpenbbPriceFreshnessOutputSchema),
  recordPriceFreshnessChat: openbb
    .route({
      method: "POST",
      operationId: "openbb.recordPriceFreshnessChat",
      path: "/openbb/price-freshness/chat-delivery",
      summary:
        "Scheduler: acknowledge #omp-alerts chat fallback delivery for a pending freshness alert",
      tags,
    })
    .input(OpenbbRecordPriceFreshnessChatInputSchema)
    .output(OpenbbRecordPriceFreshnessChatOutputSchema),
};
