import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  optionChainSnapshotQuotes,
  optionChainSnapshots,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createOptionChainSnapshotsRepository,
  OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS,
  OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS,
  OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH,
  type OptionChainSnapshotQuoteInput,
  optionChainSnapshotId,
} from "./option-chain-snapshots.ts";

const NOW = new Date("2026-11-22T15:30:00.000Z");
const SNAPSHOT_AT = new Date("2026-11-19T20:30:00.000Z");

interface Operation {
  conflict?: Record<string, unknown>;
  kind: "delete" | "insert" | "select";
  limit?: number;
  orderBy?: unknown[];
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: (limit: number) => {
        operation.limit = limit;
        return chain;
      },
      onConflictDoUpdate: (config: Record<string, unknown>) => {
        operation.conflict = config;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        operation.orderBy = order;
        return chain;
      },
      returning: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: (condition: SQL) => {
        operation.where = condition;
        return chain;
      },
    };
    return chain;
  };
  interface MockClient {
    delete: (table: unknown) => Record<string, unknown>;
    insert: (table: unknown) => Record<string, unknown>;
    select: () => Record<string, unknown>;
    transaction: <T>(fn: (tx: MockClient) => Promise<T>) => Promise<T>;
  }
  const client: MockClient = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: async <T>(fn: (tx: MockClient) => Promise<T>) => fn(client),
  };

  return { db: client as unknown as Database, operations };
};

const quote = (
  strike: number,
  right: "call" | "put" = "call",
  overrides: Partial<OptionChainSnapshotQuoteInput> = {}
): OptionChainSnapshotQuoteInput => ({
  ask: 5.2,
  bid: 5.0,
  iv: 0.21,
  last: 5.1,
  openInterest: 1200,
  right,
  source: "ibkr",
  strike,
  volume: 350,
  ...overrides,
});

const headerRow = (
  overrides: Partial<{
    expiry: string;
    id: string;
    quoteCount: number;
    snapshotAt: Date;
    source: string;
    spot: number | null;
    tradingDay: string;
    underlying: string;
  }> = {}
) => {
  const snapshotAt = overrides.snapshotAt ?? SNAPSHOT_AT;
  const underlying = overrides.underlying ?? "QQQ";
  const expiry = overrides.expiry ?? "2027-01-15";
  return {
    createdAt: NOW,
    expiry,
    id: overrides.id ?? optionChainSnapshotId(snapshotAt, underlying, expiry),
    quoteCount: overrides.quoteCount ?? 2,
    snapshotAt,
    source: overrides.source ?? "ibkr",
    spot: overrides.spot === undefined ? 500.25 : overrides.spot,
    tradingDay: overrides.tradingDay ?? "2026-11-19",
    underlying,
    updatedAt: NOW,
  };
};

describe("optionChainSnapshots repository", () => {
  it("builds a deterministic snapshot id", () => {
    expect(optionChainSnapshotId(SNAPSHOT_AT, "QQQ", "2027-01-15")).toBe(
      "2026-11-19T20:30:00.000Z|QQQ|2027-01-15"
    );
  });

  it("upserts a new snapshot header atomically, replaces quotes in batches and reports created=true", async () => {
    const quotes = Array.from(
      { length: OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH + 2 },
      (_, index) => quote(400 + index, index % 2 === 0 ? "call" : "put")
    );
    const { db, operations } = createDouble([[], [], [], []]);
    const repository = createOptionChainSnapshotsRepository(db, () => NOW);

    const result = await repository.ingestSnapshot({
      expiry: "2027-01-15",
      quotes,
      snapshotAt: SNAPSHOT_AT,
      source: "ibkr",
      spot: 500.25,
      tradingDay: "2026-11-19",
      underlying: "QQQ",
    });

    expect(result).toEqual({
      created: true,
      expiry: "2027-01-15",
      quoteCount: OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH + 2,
      snapshotAt: SNAPSHOT_AT,
      snapshotId: "2026-11-19T20:30:00.000Z|QQQ|2027-01-15",
      tradingDay: "2026-11-19",
      underlying: "QQQ",
    });
    expect(operations.map((op) => op.kind)).toEqual([
      "insert",
      "delete",
      "insert",
      "insert",
    ]);
    expect(operations[0]?.table).toBe(optionChainSnapshots);
    expect(operations[1]?.table).toBe(optionChainSnapshotQuotes);
    expect(operations[2]?.values as unknown[]).toHaveLength(
      OPTION_CHAIN_SNAPSHOT_QUOTE_BATCH
    );
    expect(operations[3]?.values as unknown[]).toHaveLength(2);
  });

  it("upserts an existing snapshot atomically with default clock and reports created=false from xmax", async () => {
    const { db, operations } = createDouble([
      [{ created: false, id: "2026-11-19T20:30:00.000Z|QQQ|2027-01-15" }],
      [],
      [],
    ]);
    const repository = createOptionChainSnapshotsRepository(db);

    const result = await repository.ingestSnapshot({
      expiry: "2027-01-15",
      quotes: [quote(500, "call")],
      snapshotAt: SNAPSHOT_AT,
      source: "yahoo",
      spot: null,
      tradingDay: "2026-11-19",
      underlying: "QQQ",
    });

    expect(result.created).toBe(false);
    expect(result.snapshotId).toBe("2026-11-19T20:30:00.000Z|QQQ|2027-01-15");
    expect(operations[0]?.conflict).toBeDefined();
  });

  it("reads the newest snapshot across multiple expiries and summarizes available days and runs", async () => {
    const olderAt = new Date("2026-11-18T20:30:00.000Z");
    const hDec = headerRow({
      expiry: "2026-12-18",
      quoteCount: 2,
      source: "ibkr",
      spot: null,
    });
    const hJan = headerRow({
      expiry: "2027-01-15",
      quoteCount: 1,
      source: "yahoo",
      spot: 500.25,
    });
    const hOlder = headerRow({
      expiry: "2027-01-15",
      quoteCount: 3,
      snapshotAt: olderAt,
      source: "yahoo",
      spot: 498.5,
      tradingDay: "2026-11-18",
    });

    const { db } = createDouble([
      [hDec, hJan, hOlder],
      [
        { ...quote(500, "call"), snapshotId: hDec.id },
        { ...quote(500, "put"), snapshotId: hDec.id },
      ],
    ]);
    const repository = createOptionChainSnapshotsRepository(db, () => NOW);

    const result = await repository.readSnapshot({ underlying: "QQQ" });

    expect(result.underlying).toBe("QQQ");
    expect(result.snapshotAt).toEqual(SNAPSHOT_AT);
    expect(result.tradingDay).toBe("2026-11-19");
    expect(result.availableDays).toEqual(["2026-11-19", "2026-11-18"]);
    expect(result.availableSnapshots).toEqual([
      {
        expiries: ["2026-12-18", "2027-01-15"],
        quoteCount: 3,
        snapshotAt: SNAPSHOT_AT,
        source: "ibkr+yahoo",
        spot: 500.25,
        tradingDay: "2026-11-19",
      },
      {
        expiries: ["2027-01-15"],
        quoteCount: 3,
        snapshotAt: olderAt,
        source: "yahoo",
        spot: 498.5,
        tradingDay: "2026-11-18",
      },
    ]);
    expect(result.expiries).toHaveLength(2);
    expect(result.expiries[0]?.quotes).toHaveLength(2);
    expect(result.expiries[1]?.quotes).toEqual([]);
  });

  it("returns an empty truthful response when no snapshot exists", async () => {
    const { db } = createDouble([[]]);
    const repository = createOptionChainSnapshotsRepository(db, () => NOW);

    const result = await repository.readSnapshot({ underlying: "QQQ" });

    expect(result).toEqual({
      availableDays: [],
      availableSnapshots: [],
      expiries: [],
      snapshotAt: null,
      tradingDay: null,
      underlying: "QQQ",
    });
  });

  it("queries the database when expiry alone is requested and returns the newest matching snapshot or empty", async () => {
    const olderAt = new Date("2026-11-18T20:30:00.000Z");
    const hLatestOther = headerRow({ expiry: "2026-12-18" });
    const hOlderMatch = headerRow({
      expiry: "2028-01-21",
      snapshotAt: olderAt,
      tradingDay: "2026-11-18",
    });
    const found = createDouble([
      [hLatestOther, hOlderMatch],
      [hOlderMatch],
      [{ ...quote(500, "call"), snapshotId: hOlderMatch.id }],
    ]);
    const matched = await createOptionChainSnapshotsRepository(
      found.db,
      () => NOW
    ).readSnapshot({ expiry: "2028-01-21", underlying: "QQQ" });
    expect(matched.snapshotAt).toEqual(olderAt);
    expect(matched.expiries).toHaveLength(1);
    expect(matched.expiries[0]?.expiry).toBe("2028-01-21");

    const missing = createDouble([[hLatestOther], []]);
    const empty = await createOptionChainSnapshotsRepository(
      missing.db,
      () => NOW
    ).readSnapshot({ expiry: "2029-01-19", underlying: "QQQ" });
    expect(empty.snapshotAt).toBeNull();
    expect(empty.expiries).toEqual([]);
    expect(empty.availableDays).toEqual(["2026-11-19"]);
  });

  it("queries the database directly when tradingDay, snapshotAt, or expiry filters are supplied", async () => {
    const hJan = headerRow({ expiry: "2027-01-15", tradingDay: "2026-11-11" });
    const { db, operations } = createDouble([
      [hJan],
      [hJan],
      [{ ...quote(495, "put", { source: "yahoo" }), snapshotId: hJan.id }],
    ]);
    const repository = createOptionChainSnapshotsRepository(db, () => NOW);

    const result = await repository.readSnapshot({
      expiry: "2027-01-15",
      snapshotAt: SNAPSHOT_AT,
      tradingDay: "2026-11-11",
      underlying: "QQQ",
    });

    expect(operations).toHaveLength(3);
    expect(result.tradingDay).toBe("2026-11-11");
    expect(result.expiries).toHaveLength(1);
    expect(result.expiries[0]?.quotes[0]?.strike).toBe(495);
  });

  it("caps availableSnapshots and availableDays at their configured limits", async () => {
    const headers = Array.from(
      { length: OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS + 5 },
      (_, index) => {
        const ts = new Date(SNAPSHOT_AT.getTime() - index * 86_400_000);
        return headerRow({
          snapshotAt: ts,
          tradingDay: ts.toISOString().slice(0, 10),
        });
      }
    );
    const { db } = createDouble([headers, []]);
    const repository = createOptionChainSnapshotsRepository(db, () => NOW);

    const result = await repository.readSnapshot({ underlying: "QQQ" });

    expect(result.availableDays).toHaveLength(
      OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_DAYS
    );
    expect(result.availableSnapshots).toHaveLength(
      OPTION_CHAIN_SNAPSHOT_MAX_AVAILABLE_RUNS
    );
  });

  it("handles tradingDay-only and snapshotAt-only queries without expiry filter", async () => {
    const hJan = headerRow({ expiry: "2027-01-15", tradingDay: "2026-11-11" });
    const byDay = createDouble([[hJan], [hJan], []]);
    const dayResult = await createOptionChainSnapshotsRepository(
      byDay.db,
      () => NOW
    ).readSnapshot({
      tradingDay: "2026-11-11",
      underlying: "QQQ",
    });
    expect(dayResult.tradingDay).toBe("2026-11-11");

    const byAt = createDouble([[hJan], [hJan], []]);
    const atResult = await createOptionChainSnapshotsRepository(
      byAt.db,
      () => NOW
    ).readSnapshot({
      snapshotAt: SNAPSHOT_AT,
      underlying: "QQQ",
    });
    expect(atResult.snapshotAt).toEqual(SNAPSHOT_AT);
  });
});
