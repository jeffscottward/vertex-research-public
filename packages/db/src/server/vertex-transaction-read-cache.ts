import type { Transaction } from "./client.ts";

type Row = Record<string, unknown>;

// Transaction-scoped reuse of append-only catalog reads (artifact catalog rows
// and rights revisions). Boundary: a cached row lives only as long as its
// Transaction object, so a rights or grant change committed by another
// transaction is enforced no later than the next transaction (the next step).
// Inside one transaction PostgreSQL READ COMMITTED could show such a commit at
// a later statement; this cache deliberately defers it to the next transaction.
// Every caller still re-validates hashes, status and time bounds on each use.
// Caching is active only inside a callback wrapped by withTransactionReadScope;
// entries are dropped when it ends, even if the executor object is reused.
// Only non-empty results are kept, so a row inserted later is still found, and
// a write to a cached table through `insert` drops that table's entries.
const caches = new WeakMap<object, Map<string, Map<string, readonly Row[]>>>();

export const cachedTransactionRows = async (
  tx: Transaction,
  table: string,
  key: string,
  load: () => Promise<Row[]>
): Promise<Row[]> => {
  const tables = caches.get(tx);
  if (!tables) return load();
  const cached = tables.get(table)?.get(key);
  if (cached) return [...cached];
  const found = await load();
  if (found.length === 0) return found;
  let entries = tables.get(table);
  if (!entries) {
    entries = new Map();
    tables.set(table, entries);
  }
  entries.set(key, Object.freeze([...found]));
  return found;
};

export const invalidateTransactionRows = (
  tx: Transaction,
  table: string
): void => {
  caches.get(tx)?.delete(table);
};

// Wrap an owned `db.transaction` callback: entries exist only while it runs, so
// neither a later transaction nor an unscoped reuse of the executor sees them.
export const withTransactionReadScope =
  <A extends unknown[], T>(
    operation: (tx: Transaction, ...rest: A) => Promise<T>
  ) =>
  async (tx: Transaction, ...rest: A): Promise<T> => {
    // A borrowed transaction re-entering an owner keeps the outer scope.
    if (caches.has(tx)) return operation(tx, ...rest);
    caches.set(tx, new Map());
    try {
      return await operation(tx, ...rest);
    } finally {
      caches.delete(tx);
    }
  };
