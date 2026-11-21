import { VertexStoreError } from "@darkfactory/db/server/vertex";
import { describe, expect, it } from "vitest";
import {
  preparationReason,
  projectionReadReason,
} from "./vertex-research-chat-conversation-runtime.ts";

// Hard store errors (invalid, integrity, conflict) are thrown before these mappings.
// Store code `unavailable` is also what the persistence layer makes of a policy or configuration
// artifact that is not readable (for example expired), so it never proves a server failure.
describe("reasons of a research chat call that ended with a non-hard error", () => {
  it("keeps a denied preparation and a passed deadline distinct and the rest neutral", () => {
    expect(preparationReason(new VertexStoreError("denied"))).toBe(
      "model-input-denied"
    );
    expect(preparationReason(new VertexStoreError("stale"))).toBe("deadline");
    expect(preparationReason(new VertexStoreError("unavailable"))).toBe(
      "model-input-preparation-unavailable"
    );
    return expect(preparationReason(new Error("backend"))).toBe(
      "model-input-preparation-unavailable"
    );
  });

  it("keeps a denied read, a passed deadline and a read that did not complete distinct", () => {
    expect(projectionReadReason(new VertexStoreError("denied"))).toBe(
      "projection-read-denied"
    );
    expect(projectionReadReason(new VertexStoreError("stale"))).toBe(
      "deadline"
    );
    expect(projectionReadReason(new VertexStoreError("unavailable"))).toBe(
      "projection-read-failed"
    );
    return expect(projectionReadReason(new Error("backend"))).toBe(
      "projection-read-failed"
    );
  });
});
