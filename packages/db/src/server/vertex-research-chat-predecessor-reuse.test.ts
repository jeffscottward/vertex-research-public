import { describe, expect, it, vi } from "vitest";
import {
  AT,
  owner,
  scope,
} from "../../../api/src/server/vertex-research-chat-execution-runtime.test-support.ts";
import { lifecycleFixture } from "./vertex-research-chat-copy-lifecycle.test-support.ts";
import { withPredecessorWalk } from "./vertex-research-chat-predecessor-walk.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

vi.setConfig({ testTimeout: scaledTimeout(120_000) });
const plans = "vertex_research_chat_execution_plans";

// Review r1 finding 9 (card vertex-debate-predecessor-query-blowup): the
// current-original reuse inside one predecessor walk, over the real owners.
describe("current original reuse inside a predecessor walk", () => {
  it("reads once, reuses with fresh checks, and refuses a stale reuse", async () => {
    const f = await lifecycleFixture(),
      approved = await f.approve();
    await f.runtime.writeApprovedInputs(owner, approved.input);
    const copies = f.runtime.worker.copies;
    const planReads = (from: number) =>
      f.calls.slice(from).filter((q) => q.sql.includes(plans)).length;
    await f.db.transaction(async (tx) => {
      const read = (at: string) =>
        copies.readCurrentOriginalForTransaction(
          tx,
          scope,
          f.responseRequestId,
          at
        );
      const outside = f.calls.length;
      expect(await read(AT)).not.toBeNull();
      const fresh = planReads(outside);
      expect(fresh).toBeGreaterThan(0);
      await withPredecessorWalk(tx, async () => {
        const first = f.calls.length;
        const kept = await read(AT);
        expect(kept).not.toBeNull();
        expect(planReads(first)).toBe(fresh);
        const second = f.calls.length;
        expect(await read(AT)).toEqual(kept);
        // The kept execution original is not read again (the copy owner still reads its own row).
        expect(planReads(second)).toBeLessThan(fresh);
        // A reuse before the approval time is stale, like a fresh read.
        await expect(read("2000-01-01T00:00:00.000Z")).rejects.toMatchObject({
          code: "stale",
        });
      });
      // Outside the walk every call reads again.
      const after = f.calls.length;
      expect(await read(AT)).not.toBeNull();
      expect(planReads(after)).toBe(fresh);
    });
  });
});
