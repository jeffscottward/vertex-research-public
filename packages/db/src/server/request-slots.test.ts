import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireRequestSlot,
  REQUEST_DATABASE_POOL_MAX_CONNECTIONS,
  REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS,
  type RequestSlotLease,
  releaseRequestSlot,
  resetRequestSlotsForTesting,
} from "./request-slots.ts";

const acquire = (route: string, onReclaim = vi.fn()) =>
  acquireRequestSlot({ onReclaim, route });

describe("request slots", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    resetRequestSlotsForTesting();
  });

  afterEach(() => {
    resetRequestSlotsForTesting();
    vi.useRealTimers();
  });

  it("reclaims slots that their owners did not end (their request contexts ended)", async () => {
    const leases = await Promise.all(
      Array.from(
        { length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS },
        (_, index) => acquire(`/route-${index}`)
      )
    );
    await vi.advanceTimersByTimeAsync(
      REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS
    );
    const onReclaim = vi.fn();
    const lease = await acquire("/fresh", onReclaim);
    expect(lease).toMatchObject({ released: false, route: "/fresh" });
    expect(onReclaim).toHaveBeenCalledTimes(
      REQUEST_DATABASE_POOL_MAX_CONNECTIONS
    );
    expect(leases.every((stale) => stale?.released === true)).toBe(true);
    return expect(onReclaim).toHaveBeenCalledWith({
      ageSeconds: REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS / 1000,
      route: "/route-0",
    });
  });

  it("releases a slot once, and the reset seam forgets every slot", async () => {
    const leases = (await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        acquire("/held")
      )
    )) as RequestSlotLease[];
    const first = leases[0] as RequestSlotLease;
    releaseRequestSlot(first);
    releaseRequestSlot(first);
    // One release frees one slot: the next request gets it, the one after that waits.
    await expect(acquire("/next")).resolves.toMatchObject({ route: "/next" });
    const waiting = acquire("/waits");
    // The seam also forgets the waiter: its own timer still ends its wait with null.
    resetRequestSlotsForTesting();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(waiting).resolves.toBeNull();
    return expect(acquire("/after-reset")).resolves.toMatchObject({
      route: "/after-reset",
    });
  });
});
