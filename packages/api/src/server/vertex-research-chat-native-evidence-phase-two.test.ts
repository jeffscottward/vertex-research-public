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
  it.for([
    "phase-drift",
    "input-drift",
    "missing-authority",
    "reused-authority",
    "revocation",
    "expiry",
  ] as const)(
    "blocks phase-two %s without a second completion or published answer",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(1);
      expect(done.tokenizers).toBeLessThanOrEqual(2);
      expect(done.prepared).toHaveLength(1);
      expect(f.table(nativeTables.phases)).toHaveLength(2);
      // The privacy owner rejoins every reviewer grant when the worker
      // submits a candidate, so absent phase-two authority denies the phase-two
      // prepare itself; later losses deny the worker's review poll instead.
      expect(done.denied).toMatchObject({
        method:
          scenario === "input-drift" || scenario === "missing-authority"
            ? "prepareModelPrivacyReview"
            : "readModelPrivacyReview",
        status: expect.any(Number),
      });
      expect(f.table(nativeTables.charges)).toHaveLength(2);
      expect(
        done.reviewed.filter(
          (entry: any) => entry.review.nativePhase.phaseOrdinal === 2
        )
      ).toHaveLength(0);
      return await noPublishedNativeAnswer(f, scenario === "expiry");
    }
  );
});
