import { describe, expect, it } from "vitest";
import {
  nativeProtocolFixture,
  nativeTables,
} from "./native-evidence.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// The SDK-backed native evidence suite skips without the pinned research SDK
// interpreter. Consent, storage review, approval/admission and the phase-one
// authority checks run in TypeScript only, so they are pinned here too.
describe("FirstMate native evidence setup without the research SDK", {
  timeout: scaledTimeout(180_000),
}, () => {
  it("admits the bounded native protocol and withholds phase-one tool authority before review", async () => {
    const f = await nativeProtocolFixture();
    expect(f.prepared?.status).toBe("prepared");
    expect(f.approvalReceipt?.status).toBe("recorded");
    expect(f.recipe.profile).toBe(
      "vertex-research-chat-native-evidence-job-v1"
    );
    expect(f.table(nativeTables.phases)).toHaveLength(1);
    expect(f.table(nativeTables.charges)).toHaveLength(0);
    const completion = await f.completionRequest(1);
    expect(completion.tools).toEqual(["read_reviewed_evidence"]);
    await expect(
      f.db.transaction((tx) =>
        f.privacy.readForTransaction(tx, completion, f.state.at)
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(f.table(nativeTables.dispatches)).toHaveLength(0);
  });
});
