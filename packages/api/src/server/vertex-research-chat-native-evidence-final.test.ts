import { describe, expect, it } from "vitest";
import {
  TIMEOUT,
  requireNativeSdk,
  noPublishedNativeAnswer,
  consumeNativeEvidence,
  nativeProtocolFixture,
  nativeTables,
} from "./native-evidence.test-support.ts";

// The native-evidence suite is split by test group into four files so CI runs
// them in parallel Vitest workers (named coverage shards native-evidence-1 and
// native-evidence-2, card orochi-impl). The tests run on the single JavaScript
// main thread of their worker, so in-file concurrency does not help.
describe("FirstMate bounded native evidence real-owner composition", () => {
  it.for(["undelivered-citation", "further-call"] as const)(
    "rejects final %s after phase-two HTTP while retaining all four charges",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(2);
      expect(f.table(nativeTables.charges)).toHaveLength(4);
      return await noPublishedNativeAnswer(f);
    }
  );
});
