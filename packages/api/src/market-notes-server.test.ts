import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  MarketNoteCheckRecord,
  MarketNoteDetailRecord,
  MarketNoteNewRecord,
  MarketNoteReviewAction,
  MarketNotesRepository,
  Repositories,
} from "@darkfactory/db/server";
import type {
  SemanticEvent,
  SemanticEventPort,
} from "@darkfactory/observability/port";
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import type { MarketNotesAddInput } from "./contracts/market-notes.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { marketNotesToday } from "./server/market-notes.ts";

const NOW = new Date("2026-11-11T14:00:00.000Z");
const TODAY = "2026-11-11";
const PLAINTEXT = "dfk_market_notes_test_key";

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: NOW,
    expiresAt: new Date("2026-11-12T14:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: NOW,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: NOW,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: NOW,
  },
});

/** In-memory repository with the same insert-once, check and review rules as the Postgres one. */
const createMemoryRepository = () => {
  const rows = new Map<string, MarketNoteDetailRecord>();
  const summary = ({ rawText: _rawText, ...note }: MarketNoteDetailRecord) =>
    note;
  const newestFirst = () =>
    [...rows.values()].sort(
      (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()
    );
  const repository = {
    findBySourceKey: vi.fn(async (sourceKey: string) => {
      const row = [...rows.values()].find(
        (note) => note.sourceKey === sourceKey
      );
      return row === undefined ? null : summary(row);
    }),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    insert: vi.fn(async (note: MarketNoteNewRecord) => {
      const existing = [...rows.values()].find(
        (row) => row.sourceKey === note.sourceKey
      );
      if (existing !== undefined)
        return { created: false, note: summary(existing) };
      const row: MarketNoteDetailRecord = {
        ...note,
        createdAt: new Date(),
        id: `note-${rows.size + 1}`,
        status: "active",
        updatedAt: new Date(),
      };
      rows.set(row.id, row);
      return { created: true, note: summary(row) };
    }),
    list: vi.fn(async (_today: string) => ({
      notes: newestFirst().map(summary),
      truncated: false,
    })),
    listActive: vi.fn(async (today: string) => ({
      notes: newestFirst()
        .filter((row) => row.status === "active" && row.reviewBy >= today)
        .map(summary),
      truncated: false,
    })),
    recordChecks: vi.fn(
      async (id: string, checks: readonly MarketNoteCheckRecord[]) => {
        const row = rows.get(id);
        if (row === undefined) return { kind: "not-found" as const };
        if (row.status === "retired") return { kind: "retired" as const };
        const now = new Date();
        const unknown = checks.find(
          (check) => !row.claims.some((claim) => claim.id === check.claimId)
        );
        if (unknown !== undefined)
          return { claimId: unknown.claimId, kind: "unknown-claim" as const };
        const next = {
          ...row,
          claims: row.claims.map((claim) => {
            const check = checks.find((entry) => entry.claimId === claim.id);
            return check === undefined
              ? claim
              : {
                  ...claim,
                  checkedAt: now.toISOString(),
                  evidence: check.evidence,
                  status: check.status,
                };
          }),
          updatedAt: now,
        };
        rows.set(id, next);
        return { kind: "ok" as const, note: summary(next) };
      }
    ),
    review: vi.fn(async (id: string, action: MarketNoteReviewAction) => {
      const row = rows.get(id);
      if (row === undefined) return { kind: "not-found" as const };
      if (action.kind === "retire" && row.status === "retired")
        return { kind: "ok" as const, note: summary(row) };
      if (row.status === "retired") return { kind: "retired" as const };
      if (action.kind === "renew") {
        if (action.reviewBy < marketNotesToday(new Date()))
          return { kind: "review-date-past" as const };
        if (action.reviewBy < row.asOf)
          return { kind: "review-date-before-as-of" as const };
      }
      const next: MarketNoteDetailRecord =
        action.kind === "retire"
          ? { ...row, status: "retired", updatedAt: new Date() }
          : { ...row, reviewBy: action.reviewBy, updatedAt: new Date() };
      rows.set(id, next);
      return { kind: "ok" as const, note: summary(next) };
    }),
  } satisfies MarketNotesRepository;
  return { repository, rows };
};

const clientFor = (
  options: Readonly<{
    repository?: MarketNotesRepository;
    apiKey?: string;
    keyAccess?: "read" | "write";
    sessionUser?: string | null;
    /** Receives the structured events of the request. */
    semanticEvents?: SemanticEventPort;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.repository === undefined
      ? {}
      : { marketNotes: options.repository }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (headers.get("x-api-key") !== PLAINTEXT) throw denied();
      return {
        access: options.keyAccess ?? "write",
        apiKeyId: "key-1",
        email: "owner@domain.test",
        emailVerified: true,
        role: "member" as const,
        status: "active" as const,
        userId: "owner",
      };
    }),
  };
  return createApiClient({
    baseUrl: "https://darkfactory.localhost",
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
        operatorEmails: ["owner@domain.test"],
        repositories,
        requestId: "request-1",
        ...(options.semanticEvents === undefined
          ? {}
          : { semanticEvents: options.semanticEvents }),
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (options.sessionUser === null) throw denied();
          return session(options.sessionUser ?? "owner");
        },
      });
      return handleApiRequest(request, context);
    },
  });
};

/** The rig: the operator's agent write key. */
const rigFor = (
  repository?: MarketNotesRepository,
  semanticEvents?: SemanticEventPort
) =>
  clientFor({
    apiKey: PLAINTEXT,
    ...(repository === undefined ? {} : { repository }),
    ...(semanticEvents === undefined ? {} : { semanticEvents }),
  });

/** A structured event sink that keeps the market-notes events. */
const eventSink = () => {
  const events: SemanticEvent[] = [];
  const port: SemanticEventPort = {
    emit: async (event) => {
      if (event.name.startsWith("vertex.marketNotes.")) events.push(event);
      return {
        analytics: "skipped",
        span: "skipped",
        structuredEvent: "emitted",
      };
    },
  };
  return { events, port };
};

const expectCode = async (
  promise: Promise<unknown>,
  code: string,
  status: number,
  message?: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected the oRPC call to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code,
      status,
      ...(message === undefined ? {} : { message }),
    });
  }
};

const reel = (
  overrides: Partial<MarketNotesAddInput> = {}
): MarketNotesAddInput => ({
  affected: { sectors: ["Semiconductors"], strategies: [], tickers: ["NVDA"] },
  asOf: "2026-11-10",
  claims: ["Breadth is narrowing", "Semis lead the tape"],
  ownerMessageUrl: "https://chat.example.com/m/1",
  rawText: "Transcript of the reel.",
  reviewBy: "2026-11-24",
  source: {
    author: "Example Analyst",
    kind: "reel",
    url: "https://www.Instagram.com/reel/abc/?igsh=one#t",
  },
  stance: { confidence: "medium", direction: "risk-off" },
  theme: "Narrow breadth under a rising index",
  ...overrides,
});

const ownerText = (rawText: string): MarketNotesAddInput =>
  reel({
    rawText,
    source: { author: null, kind: "owner-text", url: null },
    theme: "Owner view",
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("marketNotes access", () => {
  it("lets an operator session, an agent viewer and a read key read notes", async () => {
    const { repository } = createMemoryRepository();
    const { note } = await rigFor(repository).marketNotes.add(reel());
    for (const reader of [
      clientFor({ repository }),
      clientFor({ repository, sessionUser: "viewer" }),
      clientFor({ apiKey: PLAINTEXT, keyAccess: "read", repository }),
    ]) {
      await expect(reader.marketNotes.list({})).resolves.toMatchObject({
        notes: [{ id: note.id }],
      });
      await expect(
        reader.marketNotes.get({ id: note.id })
      ).resolves.toMatchObject({
        note: { rawText: "Transcript of the reel." },
      });
    }
  });

  it("refuses a read without a session and from a signed-in non-operator", async () => {
    const { repository } = createMemoryRepository();
    await expectCode(
      clientFor({ repository, sessionUser: null }).marketNotes.list({}),
      "UNAUTHORIZED",
      401
    );
    await expectCode(
      clientFor({ repository, sessionUser: "outsider" }).marketNotes.get({
        id: "note-1",
      }),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({ apiKey: "dfk_wrong", repository }).marketNotes.list({}),
      "UNAUTHORIZED",
      401
    );
    expect(repository.list).not.toHaveBeenCalled();
  });

  it("allows the three writes with an agent write key only", async () => {
    const { repository, rows } = createMemoryRepository();
    const writes = (client: ReturnType<typeof clientFor>) => [
      ["marketNotes.add", client.marketNotes.add(reel())] as const,
      [
        "marketNotes.recordChecks",
        client.marketNotes.recordChecks({
          checks: [{ claimId: "c1", evidence: "x", status: "supported" }],
          id: "note-1",
        }),
      ] as const,
      [
        "marketNotes.review",
        client.marketNotes.review({ action: { kind: "retire" }, id: "note-1" }),
      ] as const,
    ];
    // An operator session is not the rig.
    for (const [name, attempt] of writes(clientFor({ repository })))
      await expectCode(
        attempt,
        "FORBIDDEN",
        403,
        `${name} needs an agent API key`
      );
    for (const [, attempt] of writes(
      clientFor({ apiKey: PLAINTEXT, keyAccess: "read", repository })
    ))
      await expectCode(attempt, "FORBIDDEN", 403, "This API key is read-only");
    for (const [, attempt] of writes(
      clientFor({ repository, sessionUser: "viewer" })
    ))
      await expectCode(attempt, "FORBIDDEN", 403);
    expect(rows.size).toBe(0);
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.recordChecks).not.toHaveBeenCalled();
    expect(repository.review).not.toHaveBeenCalled();
  });
});

describe("marketNotes.add", () => {
  it("stores a note with claim ids c1..cN, all unverified, and the normalized source key", async () => {
    const { repository, rows } = createMemoryRepository();
    const result = await rigFor(repository).marketNotes.add(reel());
    expect(result).toEqual({
      created: true,
      note: {
        affected: {
          sectors: ["Semiconductors"],
          strategies: [],
          tickers: ["NVDA"],
        },
        asOf: "2026-11-10",
        claims: [
          {
            checkedAt: null,
            evidence: null,
            id: "c1",
            status: "unverified",
            text: "Breadth is narrowing",
          },
          {
            checkedAt: null,
            evidence: null,
            id: "c2",
            status: "unverified",
            text: "Semis lead the tape",
          },
        ],
        id: "note-1",
        ownerMessageUrl: "https://chat.example.com/m/1",
        receivedAt: NOW.toISOString(),
        reviewBy: "2026-11-24",
        source: {
          author: "Example Analyst",
          kind: "reel",
          // Stored in the parsed, serialized form (lower-case host).
          url: "https://www.instagram.com/reel/abc/?igsh=one#t",
        },
        stance: { confidence: "medium", direction: "risk-off" },
        status: "active",
        theme: "Narrow breadth under a rising index",
        updatedAt: NOW.toISOString(),
        verification: {
          cannotCheck: 0,
          checked: false,
          contradicted: 0,
          supported: 0,
          unverified: 2,
        },
      },
    });
    expect(rows.get("note-1")).toMatchObject({
      rawText: "Transcript of the reel.",
      receivedAt: NOW,
      sourceKey: "https://instagram.com/reel/abc",
      sourceKind: "reel",
      stance: "risk-off",
      stanceConfidence: "medium",
    });
  });

  it("returns the stored note unchanged on a second add of the same source", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const first = await rig.marketNotes.add(reel());
    const second = await rig.marketNotes.add(
      reel({
        claims: ["A different claim"],
        source: {
          author: null,
          kind: "reel",
          url: "https://www.instagram.com/reel/abc?utm_source=share",
        },
        theme: "A different theme",
      })
    );
    expect(second).toEqual({ created: false, note: first.note });
    expect(rows.size).toBe(1);
  });

  it("keys owner text by its trimmed text and uses a given receive time", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const first = await rig.marketNotes.add({
      ...ownerText("Rates matter more than earnings this week."),
      receivedAt: "2026-11-10T08:00:00-05:00",
    });
    expect(first.created).toBe(true);
    expect(first.note.receivedAt).toBe("2026-11-10T13:00:00.000Z");
    expect(first.note.source).toEqual({
      author: null,
      kind: "owner-text",
      url: null,
    });
    expect(rows.get(first.note.id)?.sourceKey).toMatch(/^text:[0-9a-f]{64}$/u);
    const again = await rig.marketNotes.add(
      ownerText("  Rates matter more than earnings this week.\n")
    );
    expect(again).toEqual({ created: false, note: first.note });
    const other = await rig.marketNotes.add(ownerText("A second view."));
    expect(other.created).toBe(true);
    expect(rows.size).toBe(2);
  });

  it("rejects a source URL that is too long once normalized", async () => {
    const { repository } = createMemoryRepository();
    await expectCode(
      rigFor(repository).marketNotes.add(
        reel({
          source: {
            author: null,
            kind: "article",
            // 400 two-byte characters become 2,400 percent-encoded characters.
            url: `https://example.com/${"é".repeat(400)}`,
          },
        })
      ),
      "BAD_REQUEST",
      400,
      "A URL is too long"
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it("stores the owner message link in its serialized form and refuses one that grows too long", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(
      reel({ ownerMessageUrl: "HTTPS://Chat.Example.com/m/é?x=1" })
    );
    expect(note.ownerMessageUrl).toBe("https://chat.example.com/m/%C3%A9?x=1");
    expect(rows.get(note.id)?.ownerMessageUrl).toBe(
      "https://chat.example.com/m/%C3%A9?x=1"
    );
    await expectCode(
      rig.marketNotes.add({
        ...ownerText("Another view."),
        ownerMessageUrl: `https://chat.example.com/${"é".repeat(400)}`,
      }),
      "BAD_REQUEST",
      400,
      "A URL is too long"
    );
    expect(rows.size).toBe(1);
  });

  it("refuses a receive time more than five minutes after the server time", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    await expectCode(
      rig.marketNotes.add({
        ...reel(),
        receivedAt: "2026-11-11T14:05:00.001Z",
      }),
      "BAD_REQUEST",
      400,
      "receivedAt must not be later than the server time"
    );
    await expectCode(
      rig.marketNotes.add({ ...reel(), receivedAt: "9999-12-31T23:59:59Z" }),
      "BAD_REQUEST",
      400
    );
    expect(rows.size).toBe(0);
    // A sender clock that is five minutes ahead is still accepted.
    await expect(
      rig.marketNotes.add({ ...reel(), receivedAt: "2026-11-11T14:05:00.000Z" })
    ).resolves.toMatchObject({ created: true });
  });

  it("refuses a market date after tomorrow and a review date more than 366 days away", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    await expectCode(
      rig.marketNotes.add(reel({ asOf: "2026-11-13", reviewBy: "2026-11-24" })),
      "BAD_REQUEST",
      400,
      "asOf must not be later than tomorrow (UTC)"
    );
    await expectCode(
      rig.marketNotes.add(reel({ reviewBy: "2027-11-13" })),
      "BAD_REQUEST",
      400,
      "reviewBy must be within 366 days of today (UTC)"
    );
    expect(rows.size).toBe(0);
    // Tomorrow (a note about the next session) and day 366 are the last valid dates.
    await expect(
      rig.marketNotes.add(reel({ asOf: "2026-11-12", reviewBy: "2027-11-12" }))
    ).resolves.toMatchObject({
      created: true,
      note: { asOf: "2026-11-12", reviewBy: "2027-11-12" },
    });
  });

  it("answers BAD_REQUEST, with nothing stored, for text and dates that Postgres cannot hold", async () => {
    const { repository } = createMemoryRepository();
    const rig = rigFor(repository);
    for (const overrides of [
      { rawText: "Text\u0000more" },
      { claims: ["A lone surrogate \ud83d here"] },
      { asOf: "0000-01-01" },
      { theme: "Hidden\u202etext" },
      {
        source: {
          author: null,
          kind: "article" as const,
          url: "https://user:secret@example.com/a",
        },
      },
    ])
      await expectCode(
        rig.marketNotes.add(reel(overrides)),
        "BAD_REQUEST",
        400
      );
    await expectCode(
      rig.marketNotes.recordChecks({
        checks: [
          { claimId: "c1", evidence: "Zero\u0000byte", status: "supported" },
        ],
        id: "note-1",
      }),
      "BAD_REQUEST",
      400
    );
    await expectCode(
      rig.marketNotes.get({ id: "note\u00001" }),
      "BAD_REQUEST",
      400
    );
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.recordChecks).not.toHaveBeenCalled();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it("rejects an add the contract refuses", async () => {
    const { repository } = createMemoryRepository();
    await expectCode(
      rigFor(repository).marketNotes.add(reel({ reviewBy: "2026-11-09" })),
      "BAD_REQUEST",
      400
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });
});

describe("marketNotes.list", () => {
  const seeded = async () => {
    const memory = createMemoryRepository();
    const rig = rigFor(memory.repository);
    const active = await rig.marketNotes.add({
      ...reel(),
      receivedAt: "2026-11-11T10:00:00.000Z",
    });
    const expired = await rig.marketNotes.add({
      ...ownerText("An older view."),
      asOf: "2026-10-20",
      receivedAt: "2026-10-20T10:00:00.000Z",
      reviewBy: "2026-11-10",
    });
    const retired = await rig.marketNotes.add({
      ...ownerText("A view the owner withdrew."),
      receivedAt: "2026-11-05T10:00:00.000Z",
    });
    await rig.marketNotes.review({
      action: { kind: "retire" },
      id: retired.note.id,
    });
    return {
      ...memory,
      ids: {
        active: active.note.id,
        expired: expired.note.id,
        retired: retired.note.id,
      },
    };
  };

  it("returns every note newest first with the status derived for today (UTC)", async () => {
    const { repository, ids } = await seeded();
    const output = await clientFor({ repository }).marketNotes.list({});
    expect(output.asOf).toBe(NOW.toISOString());
    expect(output.today).toBe(TODAY);
    expect(output.truncated).toBe(false);
    // The store guarantees the notes that are active today, so it needs the date.
    expect(repository.list).toHaveBeenLastCalledWith(TODAY);
    expect(output.notes.map((note) => [note.id, note.status])).toEqual([
      [ids.active, "active"],
      [ids.retired, "retired"],
      [ids.expired, "expired"],
    ]);
    expect(output.notes[0]).not.toHaveProperty("rawText");
  });

  it("leaves out expired and retired notes in scope active", async () => {
    const { repository, ids } = await seeded();
    repository.list.mockClear();
    const output = await clientFor({ repository }).marketNotes.list({
      scope: "active",
    });
    expect(output.notes.map((note) => note.id)).toEqual([ids.active]);
    // The store filters before its row limit: newer expired or retired notes cannot push an
    // active note out of the answer.
    expect(repository.listActive).toHaveBeenLastCalledWith(TODAY);
    expect(repository.list).not.toHaveBeenCalled();
    // The review date itself is still active; the next UTC day is not.
    vi.setSystemTime(new Date("2026-11-24T23:59:59.000Z"));
    await expect(
      clientFor({ repository }).marketNotes.list({ scope: "active" })
    ).resolves.toMatchObject({ notes: [{ id: ids.active }] });
    vi.setSystemTime(new Date("2026-11-25T00:00:00.000Z"));
    await expect(
      clientFor({ repository }).marketNotes.list({ scope: "active" })
    ).resolves.toMatchObject({ notes: [], today: "2026-11-25" });
  });

  it("says when the store holds older notes that the answer does not hold", async () => {
    const { repository, ids } = await seeded();
    const client = clientFor({ repository });
    const stored = await repository.list(TODAY);
    repository.list.mockResolvedValueOnce({ ...stored, truncated: true });
    await expect(client.marketNotes.list({})).resolves.toMatchObject({
      notes: [{ id: ids.active }, { id: ids.retired }, { id: ids.expired }],
      truncated: true,
    });
    const active = await repository.listActive(TODAY);
    repository.listActive.mockResolvedValueOnce({ ...active, truncated: true });
    await expect(
      client.marketNotes.list({ scope: "active" })
    ).resolves.toMatchObject({ notes: [{ id: ids.active }], truncated: true });
    // One note by its source: nothing is left out.
    await expect(
      client.marketNotes.list({
        sourceUrl: "https://www.instagram.com/reel/abc",
      })
    ).resolves.toMatchObject({ notes: [{ id: ids.active }], truncated: false });
  });

  it("finds the one note of a source URL through the server's normalization", async () => {
    const { repository, ids } = await seeded();
    const client = clientFor({ repository });
    const found = await client.marketNotes.list({
      sourceUrl:
        "https://www.instagram.com/reel/abc/?igshid=other&utm_medium=x",
    });
    expect(found.notes.map((note) => note.id)).toEqual([ids.active]);
    expect(repository.findBySourceKey).toHaveBeenLastCalledWith(
      "https://instagram.com/reel/abc"
    );
    await expect(
      client.marketNotes.list({ sourceUrl: "https://example.com/unknown" })
    ).resolves.toMatchObject({ notes: [] });
    // The scope applies to the one note too.
    await client.marketNotes.list({});
    vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
    await expect(
      client.marketNotes.list({
        scope: "active",
        sourceUrl: "https://www.instagram.com/reel/abc",
      })
    ).resolves.toMatchObject({ notes: [] });
    await expect(
      client.marketNotes.list({
        sourceUrl: "https://www.instagram.com/reel/abc",
      })
    ).resolves.toMatchObject({
      notes: [{ id: ids.active, status: "expired" }],
    });
  });
});

describe("marketNotes.get", () => {
  it("returns one note with its raw text, or NOT_FOUND", async () => {
    const { repository } = createMemoryRepository();
    const { note } = await rigFor(repository).marketNotes.add(reel());
    const client = clientFor({ repository });
    await expect(client.marketNotes.get({ id: note.id })).resolves.toEqual({
      note: { ...note, rawText: "Transcript of the reel." },
    });
    await expectCode(
      client.marketNotes.get({ id: "missing" }),
      "NOT_FOUND",
      404
    );
  });
});

describe("marketNotes.recordChecks", () => {
  it("sets the status, the evidence and the check time on the named claims", async () => {
    const { repository } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(reel());
    vi.setSystemTime(new Date("2026-11-11T15:30:00.000Z"));
    const checked = await rig.marketNotes.recordChecks({
      checks: [
        {
          claimId: "c2",
          evidence: "SOXX +2.1% vs SPY +0.3%",
          status: "supported",
        },
      ],
      id: note.id,
    });
    expect(checked.note.claims).toEqual([
      note.claims[0],
      {
        checkedAt: "2026-11-11T15:30:00.000Z",
        evidence: "SOXX +2.1% vs SPY +0.3%",
        id: "c2",
        status: "supported",
        text: "Semis lead the tape",
      },
    ]);
    expect(checked.note.verification).toEqual({
      cannotCheck: 0,
      checked: false,
      contradicted: 0,
      supported: 1,
      unverified: 1,
    });
    expect(checked.note.updatedAt).toBe("2026-11-11T15:30:00.000Z");
    const all = await rig.marketNotes.recordChecks({
      checks: [
        {
          claimId: "c1",
          evidence: "A/D line made a new high",
          status: "contradicted",
        },
        {
          claimId: "c2",
          evidence: "No intraday source",
          status: "cannot-check",
        },
      ],
      id: note.id,
    });
    expect(all.note.verification).toEqual({
      cannotCheck: 1,
      checked: true,
      contradicted: 1,
      supported: 0,
      unverified: 0,
    });
  });

  it("rejects an unknown claim id and a missing note, writing nothing", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(reel());
    const before = rows.get(note.id);
    await expectCode(
      rig.marketNotes.recordChecks({
        checks: [
          { claimId: "c1", evidence: "x", status: "supported" },
          { claimId: "c3", evidence: "y", status: "supported" },
        ],
        id: note.id,
      }),
      "BAD_REQUEST",
      400,
      "Unknown claim id c3"
    );
    expect(rows.get(note.id)).toBe(before);
    await expectCode(
      rig.marketNotes.recordChecks({
        checks: [{ claimId: "c1", evidence: "x", status: "supported" }],
        id: "missing",
      }),
      "NOT_FOUND",
      404
    );
  });
});

describe("marketNotes.recordChecks on notes that are not active", () => {
  const check = {
    claimId: "c1",
    evidence: "A/D line made a new high",
    status: "contradicted",
  } as const;

  it("takes no checks on a retired note", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(reel());
    await rig.marketNotes.review({ action: { kind: "retire" }, id: note.id });
    const stored = rows.get(note.id);
    await expectCode(
      rig.marketNotes.recordChecks({ checks: [check], id: note.id }),
      "BAD_REQUEST",
      400,
      "A retired note takes no checks"
    );
    expect(rows.get(note.id)).toBe(stored);
  });

  it("still takes checks on an expired note", async () => {
    const { repository } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(
      reel({ asOf: "2026-10-20", reviewBy: "2026-11-01" })
    );
    await expect(
      rig.marketNotes.recordChecks({ checks: [check], id: note.id })
    ).resolves.toMatchObject({
      note: { claims: [{ status: "contradicted" }, {}], status: "expired" },
    });
  });
});

describe("marketNotes.review", () => {
  it("refuses a renew more than 366 days away or before the market date of the note", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    // A note about tomorrow's session.
    const { note } = await rig.marketNotes.add(
      reel({ asOf: "2026-11-12", reviewBy: "2026-11-24" })
    );
    const renew = (reviewBy: string) =>
      rig.marketNotes.review({
        action: { kind: "renew", reviewBy },
        id: note.id,
      });
    await expectCode(
      renew("2027-11-13"),
      "BAD_REQUEST",
      400,
      "reviewBy must be within 366 days of today (UTC)"
    );
    expect(repository.review).not.toHaveBeenCalled();
    await expectCode(
      renew(TODAY),
      "BAD_REQUEST",
      400,
      "reviewBy must not be before the asOf of the note"
    );
    expect(rows.get(note.id)?.reviewBy).toBe("2026-11-24");
    await expect(renew("2027-11-12")).resolves.toMatchObject({
      note: { reviewBy: "2027-11-12", status: "active" },
    });
  });

  it("renews an expired note from today on and refuses an earlier date", async () => {
    const { repository } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(
      reel({ asOf: "2026-10-20", reviewBy: "2026-11-01" })
    );
    expect(note.status).toBe("expired");
    await expectCode(
      rig.marketNotes.review({
        action: { kind: "renew", reviewBy: "2026-11-10" },
        id: note.id,
      }),
      "BAD_REQUEST",
      400,
      "reviewBy must be today or later (UTC)"
    );
    const renewed = await rig.marketNotes.review({
      action: { kind: "renew", reviewBy: TODAY },
      id: note.id,
    });
    expect(renewed.note).toMatchObject({ reviewBy: TODAY, status: "active" });
    expect(repository.review).toHaveBeenLastCalledWith(note.id, {
      kind: "renew",
      reviewBy: TODAY,
    });
  });

  it("retires a note for good: a second retire changes nothing and a renew is refused", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(reel());
    const retired = await rig.marketNotes.review({
      action: { kind: "retire" },
      id: note.id,
    });
    expect(retired.note.status).toBe("retired");
    const stored = rows.get(note.id);
    await expect(
      rig.marketNotes.review({ action: { kind: "retire" }, id: note.id })
    ).resolves.toEqual(retired);
    expect(rows.get(note.id)).toBe(stored);
    await expectCode(
      rig.marketNotes.review({
        action: { kind: "renew", reviewBy: "2026-12-31" },
        id: note.id,
      }),
      "BAD_REQUEST",
      400,
      "A retired note cannot be renewed"
    );
    expect(rows.get(note.id)?.status).toBe("retired");
  });

  it("answers NOT_FOUND for a missing note", async () => {
    const { repository } = createMemoryRepository();
    await expectCode(
      rigFor(repository).marketNotes.review({
        action: { kind: "retire" },
        id: "missing",
      }),
      "NOT_FOUND",
      404
    );
  });
});

describe("marketNotes storage failures", () => {
  const calls = (client: ReturnType<typeof clientFor>) => [
    client.marketNotes.list({}),
    client.marketNotes.list({ scope: "active" }),
    client.marketNotes.list({ sourceUrl: "https://example.com/a" }),
    client.marketNotes.get({ id: "note-1" }),
    client.marketNotes.add(reel()),
    client.marketNotes.recordChecks({
      checks: [{ claimId: "c1", evidence: "x", status: "supported" }],
      id: "note-1",
    }),
    client.marketNotes.review({ action: { kind: "retire" }, id: "note-1" }),
  ];

  it("answers STORAGE_ERROR when the repository is not configured", async () => {
    for (const attempt of calls(rigFor()))
      await expectCode(attempt, "STORAGE_ERROR", 503);
  });

  it("answers STORAGE_ERROR when the repository fails", async () => {
    const failing = async () => {
      throw new Error("connection refused");
    };
    const repository: MarketNotesRepository = {
      findBySourceKey: failing,
      get: failing,
      insert: failing,
      list: failing,
      listActive: failing,
      recordChecks: failing,
      review: failing,
    };
    for (const attempt of calls(rigFor(repository)))
      await expectCode(attempt, "STORAGE_ERROR", 503);
  });

  const BROKEN_ROWS = [
    { claims: "not an array" },
    { claims: [{ id: "c1", text: "No status" }] },
    { affected: { tickers: ["NVDA"] } },
    // A reel without its URL.
    { sourceUrl: null },
  ];

  it("answers STORAGE_ERROR for an add when the stored row that comes back does not match the contract", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    // An older writer stored this source with a claim the contract does not know.
    const first = await rig.marketNotes.add(reel());
    rows.set(first.note.id, {
      ...(rows.get(first.note.id) as MarketNoteDetailRecord),
      claims: [{ id: "c1", status: "proven", text: "An old status" }] as never,
    });
    await expectCode(rig.marketNotes.add(reel()), "STORAGE_ERROR", 503);
    expect(rows.size).toBe(1);
    // The same answer when the new row itself comes back wrong.
    repository.insert.mockResolvedValueOnce({
      created: true,
      note: { ...first.note, claims: [] } as never,
    });
    await expectCode(
      rig.marketNotes.add(ownerText("A new view.")),
      "STORAGE_ERROR",
      503
    );
  });

  it("answers STORAGE_ERROR for one note whose stored row does not match the contract", async () => {
    const { repository, rows } = createMemoryRepository();
    const rig = rigFor(repository);
    const { note } = await rig.marketNotes.add(reel());
    const row = rows.get(note.id) as MarketNoteDetailRecord;
    for (const broken of BROKEN_ROWS) {
      rows.set(note.id, { ...row, ...broken } as never);
      await expectCode(
        rig.marketNotes.get({ id: note.id }),
        "STORAGE_ERROR",
        503
      );
      await expectCode(
        rig.marketNotes.review({ action: { kind: "retire" }, id: note.id }),
        "STORAGE_ERROR",
        503
      );
    }
    rows.set(note.id, { ...row, sourceUrl: null } as never);
    await expectCode(
      rig.marketNotes.recordChecks({
        checks: [{ claimId: "c1", evidence: "x", status: "supported" }],
        id: note.id,
      }),
      "STORAGE_ERROR",
      503
    );
  });

  it("drops a bad stored row from a list, keeps the other notes and reports the row", async () => {
    const { repository, rows } = createMemoryRepository();
    const sink = eventSink();
    const rig = rigFor(repository, sink.port);
    const bad = await rig.marketNotes.add({
      ...reel(),
      receivedAt: "2026-11-11T12:00:00.000Z",
    });
    const good = await rig.marketNotes.add({
      ...ownerText("A view that is stored well."),
      receivedAt: "2026-11-11T11:00:00.000Z",
    });
    const row = rows.get(bad.note.id) as MarketNoteDetailRecord;
    for (const broken of BROKEN_ROWS) {
      rows.set(bad.note.id, { ...row, ...broken } as never);
      for (const input of [
        {},
        { scope: "active" as const },
        { sourceUrl: "https://www.instagram.com/reel/abc" },
      ]) {
        sink.events.length = 0;
        const output = await rig.marketNotes.list(input);
        expect(output.notes.map((note) => note.id)).toEqual(
          "sourceUrl" in input ? [] : [good.note.id]
        );
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]).toMatchObject({
          action: "list",
          attributes: { count: 1, noteIds: bad.note.id },
          correlation: {
            procedure: "marketNotes.list",
            requestId: "request-1",
          },
          entityType: "market-note",
          errorCategory: "invalid-stored-row",
          name: "vertex.marketNotes.list",
          occurredAt: NOW.toISOString(),
          outcome: "failure",
          source: "api",
        });
        // Ids and counts only: no note text leaves through an event.
        expect(JSON.stringify(sink.events[0])).not.toContain("Narrow breadth");
      }
    }
    // A clean list reports nothing.
    rows.set(bad.note.id, row);
    sink.events.length = 0;
    await rig.marketNotes.list({});
    expect(sink.events).toEqual([]);
  });

  it("names at most ten bad rows in one event", async () => {
    const { repository, rows } = createMemoryRepository();
    const sink = eventSink();
    const rig = rigFor(repository, sink.port);
    for (let index = 0; index < 12; index += 1) {
      const { note } = await rig.marketNotes.add(ownerText(`View ${index}`));
      rows.set(note.id, {
        ...(rows.get(note.id) as MarketNoteDetailRecord),
        claims: [],
      });
    }
    await expect(rig.marketNotes.list({})).resolves.toMatchObject({
      notes: [],
    });
    expect(sink.events).toHaveLength(1);
    const attributes = sink.events[0]?.attributes as {
      count: number;
      noteIds: string;
    };
    expect(attributes.count).toBe(12);
    expect(attributes.noteIds.split(",")).toHaveLength(10);
  });

  it("still answers a list when there is no event sink or the sink fails", async () => {
    const { repository, rows } = createMemoryRepository();
    const { note } = await rigFor(repository).marketNotes.add(reel());
    rows.set(note.id, {
      ...(rows.get(note.id) as MarketNoteDetailRecord),
      claims: [],
    });
    await expect(
      rigFor(repository).marketNotes.list({})
    ).resolves.toMatchObject({ notes: [] });
    const emit = vi.fn(async () => {
      throw new Error("sink down");
    });
    await expect(
      rigFor(repository, { emit }).marketNotes.list({})
    ).resolves.toMatchObject({ notes: [] });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
