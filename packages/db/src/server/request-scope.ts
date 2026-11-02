// What: Opens a per-request database client and maps pool exhaustion to a 503 DATABASE_CAPACITY response.
// Used by: apps/web/src/server/request-scope.ts#withRequestScope, apps/operator/src/server/operator-auth.ts (openRequestScope).
// See: docs/debugging.md#symptom--where-to-look; packages/db/src/server/client.ts#createRequestDatabase.
import {
  createRequestDatabase,
  type Database,
  type DatabaseResource,
  type RequestDatabaseOptions,
} from "./client.ts";

/** A platform `waitUntil`: keeps a promise alive after the response is returned. */
export type BackgroundTaskScheduler = (task: Promise<unknown>) => void;

export type RequestScopeOptions = RequestDatabaseOptions &
  Readonly<{
    /**
     * First receives the connection lifetime: a promise that stays pending
     * from before the connect until the close settles and never rejects. Then
     * receives every tracked task (it may reject). Where the host has no
     * `waitUntil`, pass one that only marks rejections handled and await `finalize`.
     */
    schedule: BackgroundTaskScheduler;
  }>;

export type DatabaseRequestScope = Readonly<{
  db: Database;
  /** Tracks DB-bound work (e.g. Better Auth background tasks) so `finalize` drains it before closing. */
  schedule: BackgroundTaskScheduler;
  /** Drains tracked tasks, then closes the connection once. Never rejects. */
  finalize: () => Promise<void>;
}>;

export const REQUEST_DATABASE_RETRY_AFTER_SECONDS = 1;

/**
 * The one HTTP projection of `client.ts#RequestDatabaseCapacityError`; every
 * handler returns it so clients can apply one bounded retry policy
 * (see apps/web/src/lib/capacity-retry.ts#isCapacityResponse).
 */
export const requestDatabaseCapacityResponse = (): Response =>
  Response.json(
    { error: "Service temporarily at capacity", code: "DATABASE_CAPACITY" },
    {
      status: 503,
      headers: { "retry-after": String(REQUEST_DATABASE_RETRY_AFTER_SECONDS) },
    }
  );

/**
 * Opens one request connection (subject to the isolate cap in `client.ts`) and
 * owns its lifecycle: tasks scheduled through the scope finish before the
 * connection closes, and close runs exactly once.
 *
 * The admission slot is held from before the connect until the close settles,
 * so that whole span is handed to the host scheduler first. On Workers a
 * client-canceled request with no pending `waitUntil` work is dropped and its
 * pending promises (connect, timers, `finally`) never settle; the slot then
 * stayed taken for the isolate's lifetime. `waitUntil` keeps a canceled
 * request running for up to 30 s more (Workers limit); a connection still open
 * after that can still be dropped.
 */
export const openRequestScope = async (
  options: RequestScopeOptions
): Promise<DatabaseRequestScope> => {
  const { schedule: scheduleExternal, ...databaseOptions } = options;
  // Executor form: the ES2023 lib has no Promise.withResolvers.
  let endConnectionLifetime!: () => void;
  const connectionLifetime = new Promise<void>((resolve) => {
    endConnectionLifetime = resolve;
  });
  try {
    scheduleExternal(connectionLifetime);
  } catch {
    // No execution context (waitUntil throws): the caller awaits `finalize` itself.
  }
  let database: DatabaseResource;
  try {
    database = await createRequestDatabase(databaseOptions);
  } catch (error) {
    endConnectionLifetime();
    throw error;
  }
  const pending = new Set<Promise<unknown>>();
  let phase: "open" | "draining" | "closing" = "open";
  let finalization: Promise<void> | undefined;

  const schedule: BackgroundTaskScheduler = (task) => {
    if (phase === "closing") {
      throw new TypeError("Request background task lifecycle is closing");
    }
    const tracked: Promise<unknown> = Promise.resolve(task).finally(() =>
      pending.delete(tracked)
    );
    pending.add(tracked);
    scheduleExternal(tracked);
  };

  const drainAndClose = async (): Promise<void> => {
    phase = "draining";
    // A drained task may schedule another; loop until the set stays empty.
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
    phase = "closing";
    try {
      await database.close();
    } catch {
      // The response is already decided; client.ts reported the close failure to the diagnostic sink.
    } finally {
      endConnectionLifetime();
    }
  };

  return Object.freeze({
    db: database.db,
    schedule,
    finalize: () => {
      finalization ??= drainAndClose();
      return finalization;
    },
  });
};
