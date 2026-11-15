import { describe, expect, it } from "vitest";
import type { Transaction } from "./client.ts";
import {
  forgetPredecessorWalkReads,
  reusePredecessorRead,
  withPredecessorWalk,
} from "./vertex-research-chat-predecessor-walk.ts";

const transaction = () => ({}) as Transaction,
  passes = () => Promise.resolve();

// Counts reads and rechecks of one owner and key.
const reader = (tx: Transaction, owner: object, key = "pin") => {
  const calls = { reads: 0, rechecks: 0 };
  const use = (recheck: () => Promise<void> = passes) =>
    reusePredecessorRead(
      tx,
      owner,
      key,
      async () => {
        calls.reads += 1;
        return { read: calls.reads };
      },
      async () => {
        calls.rechecks += 1;
        await recheck();
      }
    );
  return { calls, use };
};

describe("predecessor walk scope", () => {
  it("always reads outside a walk", async () => {
    const { calls, use } = reader(transaction(), {});
    await use();
    await use();
    expect(calls).toEqual({ reads: 2, rechecks: 0 });
  });

  it("reuses a read with its recheck in nested calls and ends with the outermost call", async () => {
    const tx = transaction(),
      { calls, use } = reader(tx, {});
    await withPredecessorWalk(tx, async () => {
      const first = await use();
      await withPredecessorWalk(tx, async () => {
        expect(await use()).toBe(first);
      });
      expect(await use()).toBe(first);
    });
    expect(calls).toEqual({ reads: 1, rechecks: 2 });
    await withPredecessorWalk(tx, () => use());
    expect(calls).toEqual({ reads: 2, rechecks: 2 });
  });

  it("returns no kept read when its recheck fails", async () => {
    const tx = transaction(),
      { calls, use } = reader(tx, {});
    await withPredecessorWalk(tx, async () => {
      await use();
      await expect(
        use(async () => {
          throw new Error("stale");
        })
      ).rejects.toThrow("stale");
    });
    expect(calls).toEqual({ reads: 1, rechecks: 1 });
  });

  it("never keeps a failed read", async () => {
    const tx = transaction(),
      owner = {};
    let reads = 0;
    const failing = () =>
      reusePredecessorRead(
        tx,
        owner,
        "pin",
        async () => {
          reads += 1;
          throw new Error("denied");
        },
        passes
      );
    await withPredecessorWalk(tx, async () => {
      await expect(failing()).rejects.toThrow("denied");
      await expect(failing()).rejects.toThrow("denied");
    });
    expect(reads).toBe(2);
  });

  it("keeps reads per key, owner and transaction", async () => {
    const first = transaction(),
      second = transaction(),
      owner = {},
      a = reader(first, owner, "a"),
      b = reader(first, owner, "b"),
      other = reader(first, {}, "a"),
      elsewhere = reader(second, owner, "a");
    await withPredecessorWalk(first, async () => {
      await a.use();
      await b.use();
      await other.use();
      await withPredecessorWalk(second, () => elsewhere.use());
    });
    for (const { calls } of [a, b, other, elsewhere])
      expect(calls).toEqual({ reads: 1, rechecks: 0 });
  });

  it("drops kept reads after a write and does not keep a read that spanned it", async () => {
    const tx = transaction(),
      owner = {};
    forgetPredecessorWalkReads(tx);
    const kept = reader(tx, owner, "kept"),
      spanning = reader(tx, owner, "spanning");
    await withPredecessorWalk(tx, async () => {
      await kept.use();
      await reusePredecessorRead(
        tx,
        owner,
        "spanning",
        async () => {
          forgetPredecessorWalkReads(tx);
          return { read: 0 };
        },
        passes
      );
      await kept.use();
      await spanning.use();
    });
    expect(kept.calls).toEqual({ reads: 2, rechecks: 0 });
    expect(spanning.calls).toEqual({ reads: 1, rechecks: 0 });
  });

  it("ends the walk when the operation throws", async () => {
    const tx = transaction(),
      { calls, use } = reader(tx, {});
    await expect(
      withPredecessorWalk(tx, async () => {
        await use();
        throw new Error("stop");
      })
    ).rejects.toThrow("stop");
    await use();
    expect(calls).toEqual({ reads: 2, rechecks: 0 });
  });
});
