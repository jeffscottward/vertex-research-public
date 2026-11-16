import type { Transaction } from "./client.ts";

// One published-predecessor walk per transaction. A debate turn checks every
// earlier turn, and each earlier turn's own currency check walks its own
// predecessors again (debate sources -> published predecessor read ->
// conversation eligibility -> current original -> debate sources). Without
// reuse the SQL work grows by about 10x per ordinal. Inside one walk a
// predecessor is read once and later checks of the same exact pin reuse it, so
// the work grows linearly with the number of predecessors.
//
// Boundary (owner decision 2026-11-16, card vertex-debate-approval-sql-load):
// an owned transaction (withTransactionReadScope) is one walk, so a
// predecessor read is kept until the transaction ends. A change committed by
// another transaction after the read is therefore found by the next
// transaction, not by a later check in this one. Outside an owned transaction
// a walk opens on the outermost withPredecessorWalk call and ends with it.
// Only completed reads are kept: a failed read is never reused. Every write
// in the transaction drops every kept read: persistence-core `insert` and each
// raw SQL write in packages/db/src/server/vertex-*.ts call
// forgetPredecessorWalkReads first (scripts/ci/predecessor-walk-writes.test.ts
// checks this), and a read that was running during the write is not kept.
// Each reuse runs the owner's recheck (grants, rights, clock bounds and the
// checks that are valid only at one moment). Reads are kept per reader
// function (the `owner` argument), so one reader never reuses another
// reader's result.
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
