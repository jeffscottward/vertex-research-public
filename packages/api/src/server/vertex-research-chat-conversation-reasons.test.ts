import { VertexStoreError } from "@darkfactory/db/server/vertex";
import { describe, expect, it } from "vitest";
import { preparationReason } from "./vertex-research-chat-conversation-runtime.ts";

// A preparation that ends without a preview names its cause. Hard store errors
// (invalid, integrity, conflict) are thrown before this mapping and never reach it.
describe("model input preparation reason", () => {
  it("keeps denied, a passed deadline and a failed call distinct", () => {
    expect(preparationReason(new VertexStoreError("denied"))).toBe(
      "model-input-denied"
    );
    expect(preparationReason(new VertexStoreError("stale"))).toBe("deadline");
    expect(preparationReason(new VertexStoreError("unavailable"))).toBe(
      "model-input-preparation-failed"
    );
    return expect(preparationReason(new Error("backend"))).toBe(
      "model-input-preparation-failed"
    );
  });
});
