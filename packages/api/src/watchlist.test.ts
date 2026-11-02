import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  Repositories,
  UpdateWatchlistItemInput,
  WatchlistRepository,
} from "@darkfactory/db/server";
import type { WatchlistItem } from "@darkfactory/db/schema";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  WatchlistAddInputSchema,
  WatchlistBuyZoneSchema,
  WatchlistUpdateInputSchema,
  partitionWatchlistSymbols,
  splitWatchlistPaste,
} from "./contracts/watchlist.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-01-02T03:04:05.000Z");
const row = (
  userId: string,
  symbol: string,
  overrides: Partial<WatchlistItem> = {}
): WatchlistItem => ({
  id: `${userId}-${symbol}`,
  userId,
  symbol,
  note: null,
  buyZoneLow: null,
  buyZoneHigh: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

// In-memory owner-scoped repository standing in for Postgres.
const memoryRepository = (): WatchlistRepository & {
  rows: WatchlistItem[];
} => {
  const rows: WatchlistItem[] = [];
  return {
    rows,
    listByUser: vi.fn(async (userId: string) => {
      return rows
        .filter((item) => item.userId === userId)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
    }),
    addMany: vi.fn(async (userId: string, symbols: readonly string[]) => {
      const added: WatchlistItem[] = [];
      const existing: string[] = [];
      for (const symbol of symbols) {
        if (
          rows.some((item) => item.userId === userId && item.symbol === symbol)
        ) {
          existing.push(symbol);
        } else {
          const item = row(userId, symbol);
          rows.push(item);
          added.push(item);
        }
      }
      return { added, existing };
    }),
    update: vi.fn(async (input: UpdateWatchlistItemInput) => {
      const index = rows.findIndex(
        (item) => item.id === input.id && item.userId === input.userId
      );
      if (index < 0) return null;
      const next = {
        ...rows[index]!,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.buyZone === undefined
          ? {}
          : { buyZoneLow: input.buyZone.low, buyZoneHigh: input.buyZone.high }),
      };
      rows[index] = next;
      return next;
    }),
    remove: vi.fn(async (id: string, userId: string) => {
      const index = rows.findIndex(
        (item) => item.id === id && item.userId === userId
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
  };
};

const session = (userId: string): SafeAuthSession => ({
  user: {
    id: userId,
    name: userId,
    email: `${userId}@domain.test`,
    emailVerified: true,
    image: null,
    createdAt: at,
    updatedAt: at,
    role: "member",
    status: "active",
  },
  session: {
    id: `session-${userId}`,
    userId,
    expiresAt: new Date("2026-01-03T03:04:05.000Z"),
    createdAt: at,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId, role: "member", status: "active" },
});

const clientFor = (
  requestSession: SafeAuthSession | null,
  watchlist?: WatchlistRepository
) => {
  const repositories: Repositories = {
    profiles: {} as Repositories["profiles"],
    addresses: {} as Repositories["addresses"],
    userPreferences: {} as Repositories["userPreferences"],
    featureItems: {} as Repositories["featureItems"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    ...(watchlist === undefined ? {} : { watchlist }),
  };
  const fetch = async (request: Request): Promise<Response> => {
    const denied = () =>
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);
    const context = createApiContext(request, {
      repositories,
      requestId: "request-1",
      capabilities: {
        ai: false,
        emailDelivery: false,
        analytics: false,
        telemetryExport: false,
      },
      requireSession: async () => {
        if (requestSession === null) throw denied();
        return requestSession;
      },
      requireRole: async () => {
        throw denied();
      },
    });
    return handleApiRequest(request, context);
  };
  return createApiClient({ baseUrl: "https://darkfactory.localhost", fetch });
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status });
  }
};

describe("watchlist contract helpers", () => {
  it("splits pasted text on commas, spaces and newlines", () =>
    expect(splitWatchlistPaste("aaa, bbb.x\nCCC\t ddd;EEE,,")).toEqual([
      "aaa",
      "bbb.x",
      "CCC",
      "ddd",
      "EEE",
    ]));

  it("normalizes, dedupes and reports invalid symbols instead of dropping them", () =>
    expect(
      partitionWatchlistSymbols([
        "aaa",
        "AAA ",
        "bbb.x",
        "1BAD",
        "A$",
        "1BAD",
        "",
      ])
    ).toEqual({
      symbols: ["AAA", "BBB.X"],
      rejected: ["1BAD", "A$"],
    }));

  it("accepts decimal strings or numbers and enforces 0 < low <= high", () => {
    expect(WatchlistBuyZoneSchema.parse({ low: 10.5, high: "12" })).toEqual({
      low: "10.5",
      high: "12",
    });
    expect(WatchlistBuyZoneSchema.parse({ low: "5", high: "5" })).toEqual({
      low: "5",
      high: "5",
    });
    expect(WatchlistBuyZoneSchema.parse({ low: null, high: "7" })).toEqual({
      low: null,
      high: "7",
    });

    for (const zone of [
      { low: "12", high: "10" },
      { low: 0, high: 1 },
      { low: "-1", high: null },
      { low: "1e3", high: null },
    ]) {
      expect(WatchlistBuyZoneSchema.safeParse(zone).success).toBe(false);
    }
  });

  it("rejects owner fields, empty updates and oversized batches", () => {
    expect(
      WatchlistAddInputSchema.safeParse({ symbols: ["AAA"], userId: "x" })
        .success
    ).toBe(false);
    expect(
      WatchlistAddInputSchema.safeParse({ symbols: new Array(201).fill("AAA") })
        .success
    ).toBe(false);
    expect(WatchlistUpdateInputSchema.safeParse({ id: "a" }).success).toBe(
      false
    );
    expect(
      WatchlistUpdateInputSchema.safeParse({ id: "a", note: "n".repeat(501) })
        .success
    ).toBe(false);
    return expect(
      WatchlistUpdateInputSchema.parse({ id: "a", note: "  " })
    ).toEqual({ id: "a", note: null });
  });
});

describe("watchlist RPC", () => {
  it("rejects unauthenticated calls before touching storage", async () => {
    const repository = memoryRepository();
    const client = clientFor(null, repository);
    await expectCode(client.watchlist.list({}), "UNAUTHORIZED", 401);
    await expectCode(
      client.watchlist.add({ symbols: ["AAA"] }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      client.watchlist.update({ id: "x", note: "n" }),
      "UNAUTHORIZED",
      401
    );
    await expectCode(client.watchlist.remove({ id: "x" }), "UNAUTHORIZED", 401);
    expect(repository.listByUser).not.toHaveBeenCalled();
    return expect(repository.addMany).not.toHaveBeenCalled();
  });

  it("adds, dedupes and returns rejected tokens for the session user", async () => {
    const repository = memoryRepository();
    const client = clientFor(session("user-a"), repository);
    const first = await client.watchlist.add({
      symbols: ["aaa", "bbb.x", "AAA", "1BAD"],
    });
    expect(first.added).toEqual(["AAA", "BBB.X"]);
    expect(first.existing).toEqual([]);
    expect(first.rejected).toEqual(["1BAD"]);
    expect(first.items.map((item) => item.symbol)).toEqual(["AAA", "BBB.X"]);
    const second = await client.watchlist.add({ symbols: ["bbb.x", "CCC"] });
    expect(second.added).toEqual(["CCC"]);
    expect(second.existing).toEqual(["BBB.X"]);
    return expect(repository.addMany).toHaveBeenLastCalledWith("user-a", [
      "BBB.X",
      "CCC",
    ]);
  });

  it("does not call storage when every token is invalid", async () => {
    const repository = memoryRepository();
    const result = await clientFor(session("user-a"), repository).watchlist.add(
      { symbols: ["$$", "9"] }
    );
    expect(result).toMatchObject({
      added: [],
      existing: [],
      rejected: ["$$", "9"],
      items: [],
    });
    return expect(repository.addMany).not.toHaveBeenCalled();
  });

  it("isolates users: no cross-user reads, edits or removals", async () => {
    const repository = memoryRepository();
    repository.rows.push(row("user-a", "AAA"), row("user-b", "BBB.X"));
    const clientA = clientFor(session("user-a"), repository);
    expect(
      (await clientA.watchlist.list({})).items.map((item) => item.symbol)
    ).toEqual(["AAA"]);
    await expectCode(
      clientA.watchlist.update({ id: "user-b-BBB.X", note: "x" }),
      "NOT_FOUND",
      404
    );
    await expectCode(
      clientA.watchlist.remove({ id: "user-b-BBB.X" }),
      "NOT_FOUND",
      404
    );
    expect(
      repository.rows.find((item) => item.userId === "user-b")?.note
    ).toBeNull();
    return expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a" })
    );
  });

  it("edits note and buy zone, validates bounds and removes", async () => {
    const repository = memoryRepository();
    repository.rows.push(row("user-a", "AAA"));
    const client = clientFor(session("user-a"), repository);
    const updated = await client.watchlist.update({
      id: "user-a-AAA",
      note: "base",
      buyZone: { low: "10", high: 12.5 },
    });
    expect(updated).toMatchObject({
      symbol: "AAA",
      note: "base",
      buyZoneLow: "10",
      buyZoneHigh: "12.5",
    });
    expect(updated).not.toHaveProperty("userId");
    await expectCode(
      client.watchlist.update({
        id: "user-a-AAA",
        buyZone: { low: "13", high: "12" },
      }),
      "BAD_REQUEST",
      400
    );
    await expect(
      client.watchlist.remove({ id: "user-a-AAA" })
    ).resolves.toEqual({ id: "user-a-AAA", removed: true });
    return expect(repository.rows).toEqual([]);
  });

  it("reports storage unavailable when the repository is not wired", async () =>
    await expectCode(
      clientFor(session("user-a")).watchlist.list({}),
      "STORAGE_ERROR",
      503
    ));
});
