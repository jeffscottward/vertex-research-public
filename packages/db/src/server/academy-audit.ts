import { and, count, eq, gte } from "drizzle-orm";

import { type AuditMetadata, auditRecords } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";

// Audit rows for Academy deployment requests. Every Academy request writes one
// "academy.deploy.request" row; a request that overrides a rule gate writes an
// "academy.deploy.override" row with the broken rules and the owner's explanation. Rows go to the
// generic audit_records table (no migration). Metadata never contains the password.

export const ACADEMY_AUDIT_ACTIONS = [
  "academy.deploy.request",
  "academy.deploy.override",
  "academy.deploy.password-failed",
  // Step-up lockout: an attempt is recorded before the check and resolves to failed, verified or error.
  "academy.deploy.password-attempt",
  "academy.deploy.password-verified",
  "academy.deploy.password-error",
] as const;
export type AcademyAuditAction = (typeof ACADEMY_AUDIT_ACTIONS)[number];

export type AcademyAuditInput = Readonly<{
  action: AcademyAuditAction;
  actorUserId: string;
  deploymentRequestId: string;
  requestId: string;
  metadata: AuditMetadata;
}>;

export type AcademyAuditRepository = Readonly<{
  record: (input: AcademyAuditInput) => Promise<Readonly<{ id: string }>>;
  /** Rows of one action by one actor since a time (failed password attempts for the lockout). */
  countSince: (
    input: Readonly<{
      actorUserId: string;
      action: AcademyAuditAction;
      since: Date;
    }>
  ) => Promise<number>;
}>;

// Shared with the Nautilus arm audit: metadata keys that look like credentials are refused.
const FORBIDDEN_KEYS = /pass(word)?|secret|token/iu;

export const hasForbiddenKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => FORBIDDEN_KEYS.test(key) || hasForbiddenKey(entry)
  );
};

export const createAcademyAuditRepository = (
  database: DatabaseExecutor,
  dependencies: Readonly<{ now: () => Date; generateId: () => string }>
): AcademyAuditRepository => ({
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
    if (!ACADEMY_AUDIT_ACTIONS.includes(input.action))
      throw new Error(`unknown audit action ${input.action}`);
    if (input.requestId.trim() === "") throw new Error("requestId is required");
    if (hasForbiddenKey(input.metadata))
      throw new Error("audit metadata must not contain credential fields");
    const id = dependencies.generateId();
    await database.insert(auditRecords).values({
      action: input.action,
      actorUserId: input.actorUserId,
      createdAt: dependencies.now(),
      entityId: input.deploymentRequestId,
      entityType: "deployment_request",
      id,
      metadata: { ...input.metadata },
      requestId: input.requestId,
    });
    return { id };
  },
});
