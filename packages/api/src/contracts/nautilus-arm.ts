import { oc } from "@orpc/contract";
import { z } from "zod";

// Nautilus node arm switch (Mission control, operator view). Owner decision 2026-10-30: the QuantVPS
// Nautilus node runs 24/7 and is DISARMED by default. Arming is an explicit owner action: the owner's
// password, a typed reason and this exact statement, with an audit record before and after. Disarm is
// one click, no password. Source: the QuantVPS recovery bridge (VERTEX_IBKR_RECOVERY_URL, same token),
// routes /nautilus/status|arm|disarm. The bridge runs only the vertex-quant arm CLI in the node container.

export const NAUTILUS_ARM_STATEMENT =
  "I arm the Nautilus node; it may submit live orders." as const;
export const NAUTILUS_ARM_REASON_MIN = 10;
export const NAUTILUS_ARM_REASON_MAX = 280;

// Mission control badge: "Running · Disarmed", "Running · Armed", "Down", or unknown (bridge or CLI unreadable).
export const NAUTILUS_NODE_BADGES = [
  "running-disarmed",
  "running-armed",
  "down",
  "unknown",
] as const;
export const NAUTILUS_CONTAINER_STATES = [
  "running",
  "exited",
  "missing",
  "unknown",
] as const;
export const NAUTILUS_ARM_DETAILS = [
  "armed",
  "no_arm_record",
  "invalid_arm_record",
  "image_version_changed",
  "kill_switch_active",
] as const;

const isoTime = z.string().max(40);

export const NautilusArmStateSchema = z
  .object({
    armed: z.boolean(),
    armedAt: isoTime.nullable(),
    armedBy: z.string().max(64).nullable(),
    detail: z.enum(NAUTILUS_ARM_DETAILS),
    imageVersion: z.string().max(64),
    killSwitchActive: z.boolean(),
    reason: z.string().max(NAUTILUS_ARM_REASON_MAX).nullable(),
    state: z.enum(["armed", "disarmed"]),
  })
  .strict();

export const NautilusArmStatusInputSchema = z.object({}).strict();

export const NautilusArmStatusOutputSchema = z
  .object({
    // null when the node is not running or the arm CLI did not answer.
    arm: NautilusArmStateSchema.nullable(),
    armError: z.string().max(40).nullable(),
    badge: z.enum(NAUTILUS_NODE_BADGES),
    checkedAt: isoTime,
    container: z
      .object({
        health: z.enum(["healthy", "unhealthy", "starting"]).nullable(),
        state: z.enum(NAUTILUS_CONTAINER_STATES),
      })
      .strict(),
  })
  .strict();

export const NautilusArmInputSchema = z
  .object({
    // The image version the owner saw in the dialog; the node refuses a different running version.
    imageVersion: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/u, "Invalid image version"),
    password: z.string().min(1).max(256),
    // One line, 10..280 characters; the bridge and the node check the same rules again.
    reason: z
      .string()
      .min(NAUTILUS_ARM_REASON_MIN)
      .max(NAUTILUS_ARM_REASON_MAX)
      .refine(
        (value) => value === value.trim(),
        "No leading or trailing spaces"
      )
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "One line only")
      .refine((value) => !value.startsWith("-"), "Must not start with -"),
    statement: z.literal(NAUTILUS_ARM_STATEMENT),
  })
  .strict();

export const NautilusDisarmInputSchema = z.object({}).strict();

export const NautilusArmChangeOutputSchema = z
  .object({
    action: z.enum(["arm", "disarm"]),
    arm: NautilusArmStateSchema,
    auditId: z.string().max(64).nullable(),
  })
  .strict();

export const NAUTILUS_ARM_ERRORS = {
  AUDIT_UNAVAILABLE: {
    message: "Audit log unavailable; nothing was changed",
    status: 503,
  },
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  CONFLICT: { message: "The node refused the change", status: 409 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_CONFIGURED: {
    message: "Nautilus arm endpoint not configured",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  UNAVAILABLE: { message: "Nautilus arm service unavailable", status: 503 },
  UPSTREAM_ERROR: { message: "Nautilus arm request failed", status: 502 },
} as const;

const nautilusArm = oc.errors(NAUTILUS_ARM_ERRORS);

const status = nautilusArm
  .route({
    method: "GET",
    operationId: "nautilusArm.status",
    path: "/nautilus-arm/status",
    summary: "Nautilus node container state and arm state",
    tags: ["Nautilus arm"],
  })
  .input(NautilusArmStatusInputSchema)
  .output(NautilusArmStatusOutputSchema);

const arm = nautilusArm
  .route({
    method: "POST",
    operationId: "nautilusArm.arm",
    path: "/nautilus-arm/arm",
    summary:
      "Arm the Nautilus node (owner password, typed reason and statement; audited)",
    tags: ["Nautilus arm"],
  })
  .input(NautilusArmInputSchema)
  .output(NautilusArmChangeOutputSchema);

const disarm = nautilusArm
  .route({
    method: "POST",
    operationId: "nautilusArm.disarm",
    path: "/nautilus-arm/disarm",
    summary: "Disarm the Nautilus node (one click; audited)",
    tags: ["Nautilus arm"],
  })
  .input(NautilusDisarmInputSchema)
  .output(NautilusArmChangeOutputSchema);

export const nautilusArmContract = { arm, disarm, status };

export type NautilusNodeBadge = (typeof NAUTILUS_NODE_BADGES)[number];
export type NautilusArmState = z.infer<typeof NautilusArmStateSchema>;
export type NautilusArmStatusOutput = z.infer<
  typeof NautilusArmStatusOutputSchema
>;
export type NautilusArmInput = z.infer<typeof NautilusArmInputSchema>;
export type NautilusArmChangeOutput = z.infer<
  typeof NautilusArmChangeOutputSchema
>;
