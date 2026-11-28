import { REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import { BRIDGE_TIMEOUT_MS } from "./server/vertex-orders-gateway.ts";

describe("request database slot maximum age", () => {
  it("stays above an order placement, so a placing request never loses its slot", () => {
    // vertex-orders.ts#PLACEMENT_LEASE_MS: two bridge calls (account, then place) plus 30 s.
    const placement = 2 * BRIDGE_TIMEOUT_MS + 30_000;
    // At least one more minute: the request also writes before and after the bridge calls.
    return expect(
      REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS
    ).toBeGreaterThanOrEqual(placement + 60_000);
  });
});
