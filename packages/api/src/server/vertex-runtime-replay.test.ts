import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "@darkfactory/db/server";
import type { PersistenceContext } from "@darkfactory/db/server/vertex-epoch";
import {
  createVertexRuntimeNativeOutboxReplay,
  verifyVertexRuntimeNativeOutboxReplay,
} from "./vertex-runtime-replay.ts";
import type { VertexRuntimeReplayOptions } from "./vertex-runtime-replay.ts";

// Source-only regressions: intentionally not executed during implementation.
const setup = (signal?: AbortSignal) => {
  const unavailableEffect = vi.fn(() => {
    throw new Error("No runtime effect is permitted");
  });
  const ctx = {
    capture: unavailableEffect,
    authorize: unavailableEffect,
    now: unavailableEffect,
    run: unavailableEffect,
  } as unknown as PersistenceContext;
  const options: VertexRuntimeReplayOptions = {
    objectCapabilities: unavailableEffect,
    ...(signal ? { signal } : {}),
  };
  const tx = { execute: unavailableEffect } as unknown as Transaction;
  return { ctx, options, tx, unavailableEffect };
};
const principal = { actorId: "configured-native-emitter" };
const scope = { accountAlias: "paper-account", environment: "paper" as const };
const at = "2026-09-22T12:00:00.000000000Z";

describe("native outbox replay runtime composition", () => {
  it("constructs an inert callback without authority enrollment, reads or transactions", () => {
    const fixture = setup();
    const callback = createVertexRuntimeNativeOutboxReplay(
      fixture.ctx,
      fixture.options
    );
    expect(typeof callback).toBe("function");
    return expect(fixture.unavailableEffect).not.toHaveBeenCalled();
  });

  it("missing independent enrollment fails only when replay is invoked", async () => {
    const fixture = setup();
    const callback = createVertexRuntimeNativeOutboxReplay(
      fixture.ctx,
      fixture.options
    );
    await expect(
      callback(fixture.tx, principal, scope, {}, at)
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(fixture.unavailableEffect).not.toHaveBeenCalled();
  });

  it("worker-asserted approval and success booleans cannot replace enrolled authority", async () => {
    const fixture = setup();
    await expect(
      verifyVertexRuntimeNativeOutboxReplay(
        fixture.ctx,
        fixture.options,
        fixture.tx,
        principal,
        scope,
        {
          verified: true,
          workerAuthenticated: true,
          grant: { serviceActorId: principal.actorId },
          rows: [],
        },
        at
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(fixture.unavailableEffect).not.toHaveBeenCalled();
  });

  return it("an aborted request cannot read evidence or call the transaction replay operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = setup(controller.signal);
    const callback = createVertexRuntimeNativeOutboxReplay(
      fixture.ctx,
      fixture.options
    );
    await expect(
      callback(fixture.tx, principal, scope, {}, at)
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(fixture.unavailableEffect).not.toHaveBeenCalled();
  });
});
