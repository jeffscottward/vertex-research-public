import { oc } from "@orpc/contract";
import { z } from "zod";

import { OpenbbSourceStatusSchema } from "./openbb.ts";

// oRPC contracts for per-source OpenBB and Smart Money overdue alerting
// (docs/vertex-rebuild/designs/smart-money/plan-pr6.md). Mounted under openbb.* in
// packages/api/src/contract.ts. Research data alerting only: no orders.

const count = z.number().int().nonnegative();

export const OPENBB_OVERDUE_ACTIONS = [
  "noop",
  "in-flight",
  "prune-active",
  "clear-pending",
  "alert",
  "recovery",
] as const;

const OpenbbOverduePlannedAlertSchema = z.strictObject({
  body: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

const OpenbbOverduePendingChatSchema = z.strictObject({
  body: z.string(),
  eventId: z.string(),
  kind: z.enum(["alert", "recovery"]),
  title: z.string(),
});

export const OpenbbCheckSourceOverdueInputSchema = z.strictObject({
  dryRun: z.boolean().optional(),
});

export const OpenbbCheckSourceOverdueOutputSchema = z.strictObject({
  action: z.enum(OPENBB_OVERDUE_ACTIONS),
  activeAlertKeys: z.array(z.string()),
  checkedAt: z.date(),
  delivery: z.enum(["sent", "not-configured", "failed", "dry-run"]).nullable(),
  dryRun: z.boolean(),
  monitoredCount: count,
  newlyOverdue: z.array(OpenbbSourceStatusSchema),
  ntfyConfigured: z.boolean(),
  overdue: z.array(OpenbbSourceStatusSchema),
  pendingChat: OpenbbOverduePendingChatSchema.nullable(),
  plannedAlert: OpenbbOverduePlannedAlertSchema.nullable(),
});

export const OpenbbRecordSourceOverdueChatInputSchema = z.strictObject({
  delivery: z.enum(["sent", "failed"]),
  eventId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine(
      (value) => !/[\r\n\0]/u.test(value),
      "must not contain line breaks or NUL bytes"
    ),
});

export const OpenbbRecordSourceOverdueChatOutputSchema = z.strictObject({
  committed: z.boolean(),
  delivery: z.enum(["sent", "failed"]),
  eventId: z.string(),
});

export type OpenbbCheckSourceOverdueOutput = z.infer<
  typeof OpenbbCheckSourceOverdueOutputSchema
>;
export type OpenbbRecordSourceOverdueChatOutput = z.infer<
  typeof OpenbbRecordSourceOverdueChatOutputSchema
>;

const OPENBB_OVERDUE_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message:
      "OpenBB storage: database request failed; request not confirmed; reload to check, then retry",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const openbb = oc.errors(OPENBB_OVERDUE_API_ERRORS);
const tags = ["OpenBB"];

export const openbbOverdueContract = {
  checkSourceOverdue: openbb
    .route({
      method: "POST",
      operationId: "openbb.checkSourceOverdue",
      path: "/openbb/source-overdue/check",
      summary:
        "Scheduler: evaluate per-source OpenBB and Smart Money overdue state and send one alert per incident",
      tags,
    })
    .input(OpenbbCheckSourceOverdueInputSchema)
    .output(OpenbbCheckSourceOverdueOutputSchema),
  recordSourceOverdueChat: openbb
    .route({
      method: "POST",
      operationId: "openbb.recordSourceOverdueChat",
      path: "/openbb/source-overdue/chat-delivery",
      summary:
        "Scheduler: acknowledge #omp-alerts chat fallback delivery for a pending source-overdue alert",
      tags,
    })
    .input(OpenbbRecordSourceOverdueChatInputSchema)
    .output(OpenbbRecordSourceOverdueChatOutputSchema),
};
