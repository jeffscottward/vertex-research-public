import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  OptionChainSnapshotExpiryRead,
  OptionChainSnapshotIngestRecord,
  OptionChainSnapshotQuoteInput,
  OptionChainSnapshotReadQuery,
  OptionChainSnapshotsRepository,
  Repositories,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { OptionsChainSnapshotIngestInput } from "./contracts/options-chain.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const NOW = new Date("2026-11-22T15:30:00.000Z");
const WRITE_KEY = "dfk_option_chain_write_key";
const READ_KEY = "dfk_option_chain_read_key";

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const session = (email: string, userId = "op-1"): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-23T15:30:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

const createMemoryRepository = (): OptionChainSnapshotsRepository => {
  const snapshots = new Map<
    string,
    {
      expiry: string;
      id: string;
      quotes: readonly OptionChainSnapshotQuoteInput[];
      snapshotAt: Date;
      source: string;
      spot: number | null;
      tradingDay: string;
      underlying: string;
    }
  >();

  return {
    ingestSnapshot: vi.fn(async (record: OptionChainSnapshotIngestRecord) => {
      const id = `${record.snapshotAt.toISOString()}|${record.underlying}|${record.expiry}`;
      const existed = snapshots.has(id);
      snapshots.set(id, {
        expiry: record.expiry,
        id,
        quotes: [...record.quotes],
        snapshotAt: record.snapshotAt,
        source: record.source,
        spot: record.spot,
        tradingDay: record.tradingDay,
        underlying: record.underlying,
      });
      return {
        created: !existed,
        expiry: record.expiry,
        quoteCount: record.quotes.length,
        snapshotAt: record.snapshotAt,
        snapshotId: id,
        tradingDay: record.tradingDay,
        underlying: record.underlying,
      };
    }),

    readSnapshot: vi.fn(async (query: OptionChainSnapshotReadQuery) => {
      const allForSymbol = [...snapshots.values()]
        .filter((row) => row.underlying === query.underlying)
        .sort(
          (a, b) =>
            b.snapshotAt.getTime() - a.snapshotAt.getTime() ||
            a.expiry.localeCompare(b.expiry)
        );
      const availableDays = [
        ...new Set(allForSymbol.map((row) => row.tradingDay)),
      ];
      const byRun = new Map<string, typeof allForSymbol>();
      for (const row of allForSymbol) {
        const key = row.snapshotAt.toISOString();
        const bucket = byRun.get(key) ?? [];
        bucket.push(row);
        byRun.set(key, bucket);
      }
      const availableSnapshots = [...byRun.values()].map((rows) => ({
        expiries: rows.map((row) => row.expiry),
        quoteCount: rows.reduce((sum, row) => sum + row.quotes.length, 0),
        snapshotAt: rows[0]!.snapshotAt,
        source: [...new Set(rows.map((row) => row.source))].sort().join("+"),
        spot: rows.find((row) => row.spot !== null)?.spot ?? null,
        tradingDay: rows[0]!.tradingDay,
      }));

      const matched = allForSymbol.filter(
        (row) =>
          (query.snapshotAt === undefined ||
            row.snapshotAt.getTime() === query.snapshotAt.getTime()) &&
          (query.tradingDay === undefined ||
            row.tradingDay === query.tradingDay) &&
          (query.expiry === undefined || row.expiry === query.expiry)
      );
      const newest = matched[0];
      if (newest === undefined) {
        return {
          availableDays,
          availableSnapshots,
          expiries: [],
          snapshotAt: null,
          tradingDay: null,
          underlying: query.underlying,
        };
      }
      const expiries: OptionChainSnapshotExpiryRead[] = matched
        .filter(
          (row) => row.snapshotAt.getTime() === newest.snapshotAt.getTime()
        )
        .map((row) => ({
          expiry: row.expiry,
          quoteCount: row.quotes.length,
          quotes: [...row.quotes].sort(
            (a, b) => a.strike - b.strike || a.right.localeCompare(b.right)
          ),
          source: row.source,
          spot: row.spot,
        }));
      return {
        availableDays,
        availableSnapshots,
        expiries,
        snapshotAt: newest.snapshotAt,
        tradingDay: newest.tradingDay,
        underlying: query.underlying,
      };
    }),
  };
};

const clientFor = (options: {
  apiKey?: string;
  repository?: OptionChainSnapshotsRepository;
  sessionEmail?: string;
}) => {
  const opSession =
    options.sessionEmail === undefined
      ? undefined
      : session(options.sessionEmail);
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.repository === undefined
      ? {}
      : { optionChainSnapshots: options.repository }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      const key = headers.get("x-api-key");
      if (key === WRITE_KEY) {
        return {
          access: "write" as const,
          apiKeyId: "key-write",
          email: "operator@domain.test",
          emailVerified: true,
          role: "member" as const,
          status: "active" as const,
          userId: "op-1",
        };
      }
      if (key === READ_KEY) {
        return {
          access: "read" as const,
          apiKeyId: "key-read",
          email: "operator@domain.test",
          emailVerified: true,
          role: "member" as const,
          status: "active" as const,
          userId: "op-1",
        };
      }
      throw denied();
    }),
  };

  return createApiClient({
    baseUrl: "https://vertex.test",
    fetch: async (request) => {
      if (options.apiKey !== undefined)
        request.headers.set("x-api-key", options.apiKey);
      const context = createApiContext(request, {
        agentApiKeys: agentApiKeys as never,
        agentViewerEmails: ["viewer@domain.test"],
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: ["operator@domain.test"],
        repositories,
        requestId: "request-option-chain-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (opSession === undefined) throw denied();
          return opSession;
        },
      });
      return handleApiRequest(request, context);
    },
  });
};
const sampleIngest = (
  overrides: Partial<OptionsChainSnapshotIngestInput> = {}
): OptionsChainSnapshotIngestInput => ({
  expiry: "2027-01-15",
  quotes: [
    {
      ask: 8.4,
      bid: 8.2,
      iv: 0.215,
      last: 8.3,
      openInterest: 1500,
      right: "call",
      source: "ibkr",
      strike: 500,
      volume: 420,
    },
    {
      ask: 7.9,
      bid: 7.7,
      iv: 0.228,
      last: 7.8,
      openInterest: 1100,
      right: "put",
      source: "yahoo",
      strike: 500,
      volume: 310,
    },
  ],
  snapshotAt: "2026-11-19T20:30:00.000Z",
  source: "ibkr+yahoo",
  spot: 500.5,
  tradingDay: "2026-11-19",
  underlying: "qqq",
  ...overrides,
});

describe("optionsChain snapshot procedures", () => {
  it("ingests multiple expiries with a write key and returns the newest QQQ snapshot to a read key", async () => {
    const repository = createMemoryRepository();
    const writer = clientFor({ apiKey: WRITE_KEY, repository });
    const reader = clientFor({ apiKey: READ_KEY, repository });

    const first = await writer.optionsChain.ingestSnapshot(
      sampleIngest({ expiry: "2026-12-18" })
    );
    expect(first).toEqual({
      created: true,
      expiry: "2026-12-18",
      quoteCount: 2,
      snapshotAt: "2026-11-19T20:30:00.000Z",
      snapshotId: "2026-11-19T20:30:00.000Z|QQQ|2026-12-18",
      tradingDay: "2026-11-19",
      underlying: "QQQ",
    });

    const second = await writer.optionsChain.ingestSnapshot(
      sampleIngest({ expiry: "2027-01-15" })
    );
    expect(second.created).toBe(true);

    // Idempotent re-ingest of the same (snapshotAt, underlying, expiry) updates in place.
    const repeated = await writer.optionsChain.ingestSnapshot(
      sampleIngest({ expiry: "2027-01-15", spot: 501.0 })
    );
    expect(repeated.created).toBe(false);

    const read = await reader.optionsChain.snapshot({ underlying: "QQQ" });
    expect(read.underlying).toBe("QQQ");
    expect(read.snapshotAt).toBe("2026-11-19T20:30:00.000Z");
    expect(read.tradingDay).toBe("2026-11-19");
    expect(read.availableDays).toEqual(["2026-11-19"]);
    expect(read.availableSnapshots).toHaveLength(1);
    expect(read.expiries.map((e) => e.expiry)).toEqual([
      "2026-12-18",
      "2027-01-15",
    ]);
    expect(read.expiries[0]?.quotes[0]).toMatchObject({
      ask: 8.4,
      bid: 8.2,
      iv: 0.215,
      right: "call",
      source: "ibkr",
      strike: 500,
    });
  });

  it("supports filtering by snapshotAt, tradingDay and expiry and returns an empty state when missing", async () => {
    const repository = createMemoryRepository();
    const writer = clientFor({ apiKey: WRITE_KEY, repository });
    const operator = clientFor({
      repository,
      sessionEmail: "operator@domain.test",
    });

    const empty = await operator.optionsChain.snapshot({ underlying: "QQQ" });
    expect(empty).toEqual({
      availableDays: [],
      availableSnapshots: [],
      expiries: [],
      snapshotAt: null,
      tradingDay: null,
      underlying: "QQQ",
    });

    await writer.optionsChain.ingestSnapshot(
      sampleIngest({
        expiry: "2027-01-15",
        snapshotAt: "2026-11-11T20:30:00.000Z",
        tradingDay: "2026-11-11",
      })
    );
    await writer.optionsChain.ingestSnapshot(
      sampleIngest({
        expiry: "2027-01-15",
        snapshotAt: "2026-11-19T20:30:00.000Z",
        tradingDay: "2026-11-19",
      })
    );

    const filtered = await operator.optionsChain.snapshot({
      expiry: "2027-01-15",
      snapshotAt: "2026-11-11T20:30:00.000Z",
      tradingDay: "2026-11-11",
      underlying: "QQQ",
    });
    expect(filtered.snapshotAt).toBe("2026-11-11T20:30:00.000Z");
    expect(filtered.expiries).toHaveLength(1);
  });

  it("refuses read keys and browser sessions on ingestSnapshot, and lets agent viewers read snapshots", async () => {
    const repository = createMemoryRepository();
    const reader = clientFor({ apiKey: READ_KEY, repository });
    const browserOperator = clientFor({
      repository,
      sessionEmail: "operator@domain.test",
    });
    const viewer = clientFor({
      repository,
      sessionEmail: "viewer@domain.test",
    });

    await expect(
      reader.optionsChain.ingestSnapshot(sampleIngest())
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    await expect(
      browserOperator.optionsChain.ingestSnapshot(sampleIngest())
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "optionsChain.ingestSnapshot needs an agent API key",
      status: 403,
    });

    await expect(
      viewer.optionsChain.ingestSnapshot(sampleIngest())
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const viewerRead = await viewer.optionsChain.snapshot({
      underlying: "QQQ",
    });
    expect(viewerRead.underlying).toBe("QQQ");
  });

  it("returns STORAGE_ERROR when the optionChainSnapshots repository is not wired", async () => {
    const writer = clientFor({ apiKey: WRITE_KEY });
    const reader = clientFor({ apiKey: READ_KEY });

    await expect(
      writer.optionsChain.ingestSnapshot(sampleIngest())
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      writer.optionsChain.ingestSnapshot(sampleIngest())
    ).rejects.toMatchObject({ code: "STORAGE_ERROR", status: 503 });
    await expect(
      reader.optionsChain.snapshot({ underlying: "QQQ" })
    ).rejects.toMatchObject({ code: "STORAGE_ERROR", status: 503 });
  });
});
