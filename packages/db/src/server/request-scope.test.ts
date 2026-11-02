import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRequestDatabase: vi.fn(),
  close: vi.fn<() => Promise<void>>(),
  db: { kind: "request-db" },
}));

vi.mock("./client.ts", () => ({
  createRequestDatabase: mocks.createRequestDatabase,
}));

import {
  openRequestScope,
  REQUEST_DATABASE_RETRY_AFTER_SECONDS,
  requestDatabaseCapacityResponse,
} from "./request-scope.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Records whether a promise has settled, so a test can assert it is still pending. */
const watchSettlement = (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  return (): boolean => settled;
};

/** The connection-lifetime promise: always the first task the scope hands to the host. */
const hostLifetime = (
  schedule: Mock<(task: Promise<unknown>) => void>
): Promise<unknown> => {
  const lifetime = schedule.mock.calls[0]?.[0];
  if (lifetime === undefined) throw new Error("no host lifetime scheduled");
  return lifetime;
};

beforeEach(() => {
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.createRequestDatabase
    .mockReset()
    .mockResolvedValue({ db: mocks.db, close: mocks.close });
});

describe("openRequestScope", () => {
  it("opens the request database with every option except the scheduler", async () => {
    const diagnosticSink = vi.fn();
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      connectionTimeoutMillis: 5,
      diagnosticSink,
      schedule: vi.fn(),
    });

    expect(scope.db).toBe(mocks.db);
    expect(mocks.createRequestDatabase).toHaveBeenCalledWith({
      connectionString: "postgresql://scope",
      connectionTimeoutMillis: 5,
      diagnosticSink,
    });
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("schedules the host lifetime before opening and ends it when the open fails", async () => {
    const failure = new Error("capacity");
    const open = deferred();
    mocks.createRequestDatabase.mockReturnValueOnce(
      open.promise.then(() => Promise.reject(failure))
    );
    const schedule = vi.fn<(task: Promise<unknown>) => void>();

    const opening = openRequestScope({
      connectionString: "postgresql://scope",
      schedule,
    });
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRequestDatabase.mock.invocationCallOrder[0] ?? 0
    );
    const lifetimeSettled = watchSettlement(hostLifetime(schedule));
    await Promise.resolve();
    expect(lifetimeSettled()).toBe(false);

    open.resolve();
    await expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(lifetimeSettled()).toBe(true));
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("still opens and closes when the host scheduler throws", async () => {
    // A host without an execution context throws from waitUntil; the caller
    // then awaits finalize itself (apps/web/src/server/request-scope.ts).
    const schedule = vi.fn(() => {
      throw new Error("no execution context");
    });
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule,
    });

    expect(scope.db).toBe(mocks.db);
    await expect(scope.finalize()).resolves.toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps the host lifetime pending from before the connect until the close settles", async () => {
    // Workers drop a client-canceled request that has no pending waitUntil
    // work; a connect or close still in flight then never settles and its
    // admission slot leaks. The lifetime promise is what keeps it running.
    const open = deferred();
    const close = deferred();
    mocks.close.mockReturnValueOnce(close.promise);
    mocks.createRequestDatabase.mockReturnValueOnce(
      open.promise.then(() => ({ db: mocks.db, close: mocks.close }))
    );
    const schedule = vi.fn<(task: Promise<unknown>) => void>();

    const opening = openRequestScope({
      connectionString: "postgresql://scope",
      schedule,
    });
    expect(schedule).toHaveBeenCalledOnce();
    const lifetimeSettled = watchSettlement(hostLifetime(schedule));

    open.resolve();
    const scope = await opening;
    expect(lifetimeSettled()).toBe(false);

    const finalization = scope.finalize();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(lifetimeSettled()).toBe(false);

    close.resolve();
    await finalization;
    await vi.waitFor(() => expect(lifetimeSettled()).toBe(true));
  });

  it("closes once, immediately, when no task was scheduled", async () => {
    const scheduleExternal = vi.fn();
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule: scheduleExternal,
    });

    const finalization = scope.finalize();
    expect(scope.finalize()).toBe(finalization);
    await finalization;
    expect(scope.finalize()).toBe(finalization);
    expect(mocks.close).toHaveBeenCalledOnce();
    // The only external task is the connection lifetime.
    expect(scheduleExternal).toHaveBeenCalledOnce();
  });

  it("drains scheduled tasks, including nested ones, before closing", async () => {
    const first = deferred();
    const second = deferred();
    const scheduleExternal = vi.fn((task: Promise<unknown>) => {
      task.catch(() => undefined);
    });
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule: scheduleExternal,
    });
    scope.schedule(first.promise.then(() => scope.schedule(second.promise)));

    let finalized = false;
    const finalization = scope.finalize().then(() => {
      finalized = true;
    });
    first.resolve();
    // The connection lifetime plus the two tracked tasks.
    await vi.waitFor(() => expect(scheduleExternal).toHaveBeenCalledTimes(3));
    expect(mocks.close).not.toHaveBeenCalled();
    expect(finalized).toBe(false);

    second.resolve();
    await finalization;
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("settles rejected tasks before closing", async () => {
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule: (task) => {
        task.catch(() => undefined);
      },
    });
    scope.schedule(Promise.reject(new Error("background task failed")));

    await expect(scope.finalize()).resolves.toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("swallows a close failure so finalization never rejects", async () => {
    mocks.close.mockRejectedValueOnce(new Error("end failed"));
    const schedule = vi.fn<(task: Promise<unknown>) => void>();
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule,
    });
    const lifetimeSettled = watchSettlement(hostLifetime(schedule));

    await expect(scope.finalize()).resolves.toBeUndefined();
    await expect(scope.finalize()).resolves.toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(lifetimeSettled()).toBe(true));
  });

  it("rejects tasks once closing has started", async () => {
    const close = deferred();
    mocks.close.mockReturnValueOnce(close.promise);
    const scheduleExternal = vi.fn();
    const scope = await openRequestScope({
      connectionString: "postgresql://scope",
      schedule: scheduleExternal,
    });

    const finalization = scope.finalize();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(() => scope.schedule(Promise.resolve())).toThrow(
      "Request background task lifecycle is closing"
    );
    close.resolve();
    await finalization;
    expect(() => scope.schedule(Promise.resolve())).toThrow(
      "Request background task lifecycle is closing"
    );
    // Only the connection lifetime: tasks refused during closing never reach the host.
    expect(scheduleExternal).toHaveBeenCalledOnce();
  });
});

describe("requestDatabaseCapacityResponse", () => {
  it("is an exact 503 with a one-second retry-after and a coded body", async () => {
    const response = requestDatabaseCapacityResponse();

    expect(response.status).toBe(503);
    expect(REQUEST_DATABASE_RETRY_AFTER_SECONDS).toBe(1);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Service temporarily at capacity",
      code: "DATABASE_CAPACITY",
    });
  });
});
