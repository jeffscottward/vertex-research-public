import { and, asc, eq, gte, lt, lte, or, sql } from "drizzle-orm";

import { uiClickEvents, users } from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import {
  DatabasePersistenceError,
  databaseErrorDetails,
} from "./repository-errors.ts";

// UI click log (card vertex-click-log). The API redacts every event before it calls record; this
// repository only stores, prunes and reads. Each record call also deletes rows received more than
// retentionDays ago, so the table never holds more than the retention window without a timer.

const DAY_MS = 86_400_000;
export const CLICK_LOG_RETENTION_DAYS = 14;

export type ClickLogRow = typeof uiClickEvents.$inferSelect;
export type ClickLogRowWithUser = ClickLogRow & { userEmail: string | null };

export type ClickLogInsert = Readonly<{
  userId: string;
  tabId: string;
  occurredAt: Date;
  kind: "click" | "submit";
  role: string;
  label: string;
  testId: string | null;
  route: string;
  targetRoute: string | null;
  important: boolean;
  requestIds: readonly string[];
  recordRequestId: string;
  buildSha: string;
}>;

export type ClickLogQuery = Readonly<{
  from: Date;
  to: Date;
  limit: number;
  /** A user id or an email address (case-insensitive). Omit it to read every user. */
  user?: string;
}>;

export type ClickLogQueryResult = Readonly<{
  events: readonly ClickLogRowWithUser[];
  truncated: boolean;
}>;

export interface ClickLogRepository {
  /** Inserts the events, then deletes rows older than the retention window. Returns the insert count. */
  record: (events: readonly ClickLogInsert[]) => Promise<number>;
  /** Events with occurredAt in [from, to], oldest first, at most `limit`. */
  query: (input: ClickLogQuery) => Promise<ClickLogQueryResult>;
}

export type ClickLogRepositoryOptions = Readonly<{
  now: () => Date;
  generateId: () => string;
  retentionDays: number;
}>;

const persistence = async <T>(operation: string, work: Promise<T>) => {
  try {
    return await work;
  } catch (error) {
    if (typeof databaseErrorDetails(error).code === "string") {
      throw new DatabasePersistenceError(operation);
    }
    throw error;
  }
};

export const createClickLogRepository = (
  database: DatabaseExecutor,
  options: ClickLogRepositoryOptions
): ClickLogRepository => {
  const { generateId, now, retentionDays } = options;
  const cutoff = () => new Date(now().getTime() - retentionDays * DAY_MS);
  return {
    query: async ({ from, limit, to, user }) => {
      // Rows past retention stay hidden even when no record call has pruned them yet.
      const range = and(
        gte(uiClickEvents.occurredAt, from),
        lte(uiClickEvents.occurredAt, to),
        gte(uiClickEvents.receivedAt, cutoff())
      );
      const rows = await persistence(
        "click log read",
        database
          .select({
            buildSha: uiClickEvents.buildSha,
            id: uiClickEvents.id,
            important: uiClickEvents.important,
            kind: uiClickEvents.kind,
            label: uiClickEvents.label,
            occurredAt: uiClickEvents.occurredAt,
            receivedAt: uiClickEvents.receivedAt,
            recordRequestId: uiClickEvents.recordRequestId,
            requestIds: uiClickEvents.requestIds,
            role: uiClickEvents.role,
            route: uiClickEvents.route,
            tabId: uiClickEvents.tabId,
            targetRoute: uiClickEvents.targetRoute,
            testId: uiClickEvents.testId,
            userEmail: users.email,
            userId: uiClickEvents.userId,
          })
          .from(uiClickEvents)
          .leftJoin(users, eq(users.id, uiClickEvents.userId))
          .where(
            user === undefined
              ? range
              : and(
                  range,
                  or(
                    eq(uiClickEvents.userId, user),
                    sql`lower(${users.email}) = lower(${user})`
                  )
                )
          )
          .orderBy(asc(uiClickEvents.occurredAt), asc(uiClickEvents.id))
          .limit(limit + 1)
      );
      return { events: rows.slice(0, limit), truncated: rows.length > limit };
    },
    record: async (events) => {
      if (events.length === 0) return 0;
      const inserted = await persistence(
        "click log insert",
        database
          .insert(uiClickEvents)
          .values(
            events.map((event) => ({
              ...event,
              id: generateId(),
              requestIds: [...event.requestIds],
            }))
          )
          .returning({ id: uiClickEvents.id })
      );
      await persistence(
        "click log retention",
        database
          .delete(uiClickEvents)
          .where(lt(uiClickEvents.receivedAt, cutoff()))
      );
      return inserted.length;
    },
  };
};
