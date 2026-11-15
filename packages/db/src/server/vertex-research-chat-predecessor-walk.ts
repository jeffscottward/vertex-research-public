import type { Transaction } from "./client.ts";

// One published-predecessor walk per transaction region. A debate turn checks
// every earlier turn, and each earlier turn's own currency check walks its own
// predecessors again (debate sources -> published predecessor read ->
// conversation eligibility -> current original -> debate sources). Without
// reuse the SQL work grows by about 10x per ordinal. Inside one walk a
// predecessor is read once and later checks of the same exact pin reuse it, so
// the work grows linearly with the number of predecessors.
//
// Boundary: the region is one predecessor check (debate source checks, one
// published predecessor read, and the source-input read/recheck loops). It
// opens on the outermost call and ends with it, so the next region and the
// next transaction read again. Only completed reads are kept: a failed read is
// never reused. Any persistence-core `insert` in the transaction (for example
// closing an authority domain after a loss) drops every kept read, and a read
// that was running during that insert is not kept. The one raw write a region
// can reach, settling a debate step from reserved to spent, changes no kept
// value. Each reuse runs the owner's recheck (clock bounds and the checks that
// are valid only at one moment). Reads are kept per reader function (the
// `owner` argument), so one reader never reuses another reader's result.
const walks = new WeakMap<object, WeakMap<object, Map<string, unknown>>>();

export const withPredecessorWalk = async <T>(
  tx: Transaction,
  operation: () => Promise<T>
): Promise<T> => {
  // A nested call joins the outer walk of the same transaction.
  if (walks.has(tx)) return operation();
  walks.set(tx, new WeakMap());
  try {
    return await operation();
  } finally {
    walks.delete(tx);
  }
};

// Outside a walk this always reads. Inside a walk it returns the owner's kept
// read for the key after `recheck` passes, or reads and keeps the result. The
// owner and key together fix the value type T. Callers share a kept value, so
// they must never change it.
export const reusePredecessorRead = async <T>(
  tx: Transaction,
  owner: object,
  key: string,
  read: () => Promise<T>,
  recheck: (kept: T) => Promise<void> | void
): Promise<T> => {
  const walk = walks.get(tx);
  if (!walk) return read();
  let reads = walk.get(owner);
  if (!reads) {
    reads = new Map();
    walk.set(owner, reads);
  }
  if (reads.has(key)) {
    const kept = reads.get(key) as T;
    await recheck(kept);
    return kept;
  }
  const value = await read();
  // After an insert during the read this is the dropped map: nothing is kept.
  reads.set(key, value);
  return value;
};

// A write in this transaction ends reuse of every read made before it.
export const forgetPredecessorWalkReads = (tx: Transaction): void => {
  if (walks.has(tx)) walks.set(tx, new WeakMap());
};
