import { and, count, eq, gte } from "drizzle-orm";

import { type AuditMetadata, auditRecords } from "../schema/index.ts";
import { hasForbiddenKey } from "./academy-audit.ts";
import type { DatabaseExecutor } from "./client.ts";

// Audit rows for the Nautilus node arm switch (file name avoids "nautilus": repositories.ts import paths are
// scanned for network-client names) (owner decision 2026-10-30). Arm writes a password step-up
// attempt (resolved to verified, failed or error), an intent row before the bridge call and a result row
// after it. Disarm writes an intent row and a result row. Rows go to the generic audit_records table
// (no migration), entity type "nautilus_node". Metadata never contains the password.

export const NAUTILUS_ARM_AUDIT_ACTIONS = [
  "nautilus.arm.password-attempt",
  "nautilus.arm.password-verified",
  "nautilus.arm.password-error",
  "nautilus.arm.password-failed",
  "nautilus.arm.intent",
  "nautilus.arm.result",
  "nautilus.disarm.intent",
  "nautilus.disarm.result",
] as const;
export type NautilusArmAuditAction =
  (typeof NAUTILUS_ARM_AUDIT_ACTIONS)[number];

export type NautilusArmAuditInput = Readonly<{
  action: NautilusArmAuditAction;
  actorUserId: string;
  // The bridge request id, or "none" for a step-up row.
  armRequestId: string;
  requestId: string;
  metadata: AuditMetadata;
}>;

export type NautilusArmAuditRepository = Readonly<{
  record: (input: NautilusArmAuditInput) => Promise<Readonly<{ id: string }>>;
  /** Rows of one action by one actor since a time (password step-up lockout). */
  countSince: (
    input: Readonly<{
      actorUserId: string;
      action: NautilusArmAuditAction;
      since: Date;
    }>
  ) => Promise<number>;
}>;

export const createNautilusArmAuditRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): NautilusArmAuditRepository => ({
  countSince: async (input) => {
    const [row] = await database
      .select({ value: count() })
      .from(auditRecords)
      .where(
        and(
          eq(auditRecords.actorUserId, input.actorUserId),
          eq(auditRecords.action, input.action),
          gte(auditRecords.createdAt, input.since)
        )
      );
    return Number(row?.value ?? 0);
  },
  record: async (input) => {
    if (!NAUTILUS_ARM_AUDIT_ACTIONS.includes(input.action))
      throw new Error(`unknown audit action ${input.action}`);
    if (input.requestId.trim() === "") throw new Error("requestId is required");
    if (hasForbiddenKey(input.metadata))
      throw new Error("audit metadata must not contain credential fields");
    const id = dependencies.generateId();
    await database.insert(auditRecords).values({
      action: input.action,
      actorUserId: input.actorUserId,
      createdAt: dependencies.now(),
      entityId: input.armRequestId,
      entityType: "nautilus_node",
      id,
      metadata: { ...input.metadata },
      requestId: input.requestId,
    });
    return { id };
  },
});
