import { describe, vi } from "vitest";
import type * as SharedVertex from "@darkfactory/shared/vertex";
import { rechecksAncestorLoss } from "./vertex-research-chat-debate.test-support.ts";

// These three-turn rechecks make millions of hashArtifact calls. Hash them with
// the output-identical synchronous substitute (proven equal to the real one in
// vertex-sync-hash.test.ts) instead of one WebCrypto thread-pool job per call.
vi.mock("@darkfactory/shared/vertex", async (importOriginal) =>
  (await import("./vertex-sync-hash.test-support.ts")).withSyncHashArtifact(
    await importOriginal<typeof SharedVertex>()
  )
);

// Split from vertex-research-chat-debate.test.ts: one ancestor loss per file so
// the three-turn rechecks run in parallel workers.
describe("stepwise bounded debate source-owner acceptance", () => {
  rechecksAncestorLoss("current-rights");
});
