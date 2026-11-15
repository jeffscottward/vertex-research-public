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
  it.for(["invalid-call", "multiple-calls", "forged-proof"] as const)(
    "rejects %s before any local result or phase-two dispatch",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(1);
      expect(done.prepared).toHaveLength(0);
      if (scenario === "forged-proof")
        expect(done.denied).toMatchObject({
          method: "prepareNativeEvidencePhaseTwo",
          status: expect.any(Number),
        });
      expect(f.table(nativeTables.phases)).toHaveLength(1);
      expect(f.table(nativeTables.charges)).toHaveLength(2);
      return await noPublishedNativeAnswer(f);
    }
  );
  it.for(["forged-final-proof", "missing-phase-one-audit"] as const)(
    "denies final provenance %s after both completions without publishing or releasing charges",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.finalFaults).toEqual([scenario]);
      expect(done.completions).toBe(2);
      expect(done.reviewed).toHaveLength(4);
      expect(done.prepared).toHaveLength(1);
      expect(done.denied).toMatchObject({
        method: "stageArtifact",
        status: expect.any(Number),
      });
      expect(done.outcome.status).not.toBe("completed");
      expect(f.table(nativeTables.charges)).toHaveLength(4);
      expect(f.table("vertex_research_chat_advisory_origins")).toHaveLength(0);
      return await noPublishedNativeAnswer(f);
    }
  );
});
