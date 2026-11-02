import {
  AgentApiKeyRateLimitedError,
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Todo } from "@darkfactory/db/schema";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type Repositories,
  type TodoInput,
  type TodoRepository,
  type UpdateTodoInput,
} from "@darkfactory/db/server";
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.ts";
import {
  TodoCreateInputSchema,
  TodoUpdateInputSchema,
} from "./contracts/todos.ts";
import { createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";

const at = new Date("2026-10-23T10:00:00.000Z");
const PLAINTEXT = "vrk_todo_test_key";

const memoryRepository = (): TodoRepository & { rows: Todo[] } => {
  const rows: Todo[] = [];
  let next = 0;
  return {
    create: vi.fn(async (userId: string, input: TodoInput) => {
      next += 1;
      const row: Todo = {
        createdAt: at,
        dueDate: input.dueDate ?? null,
        id: `todo-${next}`,
        note: input.note ?? null,
        sourceUrl: input.sourceUrl ?? null,
        status: "open",
        tags: [...(input.tags ?? [])],
        title: input.title,
        updatedAt: at,
        userId,
      };
      rows.push(row);
      return row;
    }),
    listByUser: vi.fn(async (userId: string, tag?: string) =>
      rows.filter(
        (row) =>
          row.userId === userId && (tag === undefined || row.tags.includes(tag))
      )
    ),
    remove: vi.fn(async (id: string, userId: string) => {
      const index = rows.findIndex(
        (row) => row.id === id && row.userId === userId
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    rows,
    update: vi.fn(async (input: UpdateTodoInput) => {
      const index = rows.findIndex(
        (row) => row.id === input.id && row.userId === input.userId
      );
      if (index < 0) return null;
      const { id: _id, userId: _userId, tags, ...rest } = input;
      const updated: Todo = {
        ...rows[index]!,
        ...rest,
        ...(tags === undefined ? {} : { tags: [...tags] }),
      };
      rows[index] = updated;
      return updated;
    }),
  };
};

const session = (userId: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-10-24T10:00:00.000Z"),
    id: `session-${userId}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId,
  },
  user: {
    createdAt: at,
    email: `${userId}@domain.test`,
    emailVerified: true,
    id: userId,
    image: null,
    name: userId,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const denied = () =>
  new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401);

const clientFor = (
  options: Readonly<{
    session?: SafeAuthSession | null;
    todos?: TodoRepository;
    apiKey?: string;
    keyAccess?: "read" | "write";
    operators?: string[];
    sessionError?: Error;
    keyError?: Error;
  }>
) => {
  const repositories: Repositories = {
    addresses: {} as Repositories["addresses"],
    adminUsers: {} as Repositories["adminUsers"],
    dashboard: {} as Repositories["dashboard"],
    featureItems: {} as Repositories["featureItems"],
    profiles: {} as Repositories["profiles"],
    userPreferences: {} as Repositories["userPreferences"],
    ...(options.todos === undefined ? {} : { todos: options.todos }),
  };
  const agentApiKeys = {
    authenticate: vi.fn(async (headers: Headers) => {
      if (options.keyError !== undefined) throw options.keyError;
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
        capabilities: {
          ai: false,
          analytics: false,
          emailDelivery: false,
          telemetryExport: false,
        },
        operatorEmails: options.operators ?? ["owner@domain.test"],
        repositories,
        requestId: "request-1",
        requireRole: async () => {
          throw denied();
        },
        requireSession: async () => {
          if (options.sessionError !== undefined) throw options.sessionError;
          const current = options.session ?? null;
          if (current === null) throw denied();
          return current;
        },
      });
      return handleApiRequest(request, context);
    },
  });
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

describe("todos contract", () => {
  it("normalizes tags, blank fields and rejects bad dates and URLs", () => {
    expect(
      TodoCreateInputSchema.parse({
        dueDate: "",
        note: "  ",
        sourceUrl: "",
        tags: ["Research", "research", "api-keys"],
        title: "  Get keys ",
      })
    ).toEqual({
      dueDate: null,
      note: null,
      sourceUrl: null,
      tags: ["research", "api-keys"],
      title: "Get keys",
    });
    expect(
      TodoCreateInputSchema.safeParse({ dueDate: "30/10/2026", title: "x" })
        .success
    ).toBe(false);
    expect(
      TodoCreateInputSchema.safeParse({ sourceUrl: "ftp://a", title: "x" })
        .success
    ).toBe(false);
    expect(TodoCreateInputSchema.safeParse({ title: " " }).success).toBe(false);
    return expect(TodoUpdateInputSchema.safeParse({ id: "a" }).success).toBe(
      false
    );
  });
});

describe("todos router", () => {
  it("rejects unauthenticated requests", async () => {
    const todos = memoryRepository();
    await expectCode(
      clientFor({ session: null, todos }).todos.list({}),
      "UNAUTHORIZED",
      401
    );
    return expect(todos.listByUser).not.toHaveBeenCalled();
  });

  it("creates, edits, completes, filters and deletes only the session user's rows", async () => {
    const todos = memoryRepository();
    const a = clientFor({ session: session("user-a"), todos });
    const b = clientFor({ session: session("user-b"), todos });
    const created = await a.todos.create({
      dueDate: "2026-10-30",
      sourceUrl: "https://example.test/item",
      tags: ["research"],
      title: "Paper-search API keys",
    });
    expect(created).toMatchObject({ status: "open", tags: ["research"] });
    await a.todos.create({ tags: ["broker"], title: "Other" });
    expect((await a.todos.list({ tag: "research" })).items).toHaveLength(1);
    expect((await b.todos.list({})).items).toHaveLength(0);
    await expectCode(
      b.todos.update({ id: created.id, status: "done" }),
      "NOT_FOUND",
      404
    );
    await expectCode(b.todos.remove({ id: created.id }), "NOT_FOUND", 404);
    const done = await a.todos.update({ id: created.id, status: "done" });
    expect(done.status).toBe("done");
    const edited = await a.todos.update({ id: created.id, title: "Renamed" });
    expect(edited.title).toBe("Renamed");
    expect(await a.todos.remove({ id: created.id })).toEqual({
      id: created.id,
      removed: true,
    });
    return expect((await a.todos.list({})).items).toHaveLength(1);
  });

  it("lets an operator write key add a to-do for the key owner", async () => {
    const todos = memoryRepository();
    const keyed = clientFor({ apiKey: PLAINTEXT, todos });
    const created = await keyed.todos.create({ title: "From FIRSTMATE" });
    expect(todos.rows[0]?.userId).toBe("owner");
    return expect(created.title).toBe("From FIRSTMATE");
  });

  it("limits a read key to list and refuses non-operator key owners", async () => {
    const todos = memoryRepository();
    const reader = clientFor({ apiKey: PLAINTEXT, keyAccess: "read", todos });
    expect((await reader.todos.list({})).items).toHaveLength(0);
    await expectCode(reader.todos.create({ title: "x" }), "FORBIDDEN", 403);
    const outsider = clientFor({ apiKey: PLAINTEXT, operators: [], todos });
    await expectCode(outsider.todos.list({}), "FORBIDDEN", 403);
    await expectCode(
      clientFor({ apiKey: "vrk_wrong", todos }).todos.list({}),
      "UNAUTHORIZED",
      401
    );
    return expect(todos.create).not.toHaveBeenCalled();
  });

  it("maps auth failures: suspended session, rate-limited key, unexpected error", async () => {
    const todos = memoryRepository();
    await expectCode(
      clientFor({
        todos,
        sessionError: new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.ACCOUNT_SUSPENDED,
          403
        ),
      }).todos.list({}),
      "FORBIDDEN",
      403
    );
    await expectCode(
      clientFor({
        todos,
        apiKey: PLAINTEXT,
        keyError: new AgentApiKeyRateLimitedError(),
      }).todos.list({}),
      "TOO_MANY_REQUESTS",
      429
    );
    return expectCode(
      clientFor({ todos, sessionError: new Error("boom") }).todos.list({}),
      "INTERNAL_SERVER_ERROR",
      500
    );
  });

  it("passes every editable field and maps repository errors", async () => {
    const todos = memoryRepository();
    const a = clientFor({ session: session("user-a"), todos });
    const created = await a.todos.create({ title: "x", note: null });
    const updated = await a.todos.update({
      id: created.id,
      title: "y",
      note: "n",
      status: "done",
      dueDate: "2026-10-30",
      tags: ["a"],
      sourceUrl: "https://example.test",
    });
    expect(updated).toMatchObject({
      title: "y",
      note: "n",
      status: "done",
      dueDate: "2026-10-30",
      tags: ["a"],
      sourceUrl: "https://example.test",
    });
    const invalid = new InvalidRepositoryInputError("bad tag");
    const storage = new DatabasePersistenceError("to-do mutation");
    vi.mocked(todos.listByUser).mockRejectedValueOnce(invalid);
    await expectCode(a.todos.list({}), "VALIDATION_ERROR", 422);
    vi.mocked(todos.create).mockRejectedValueOnce(storage);
    await expectCode(a.todos.create({ title: "z" }), "STORAGE_ERROR", 503);
    vi.mocked(todos.update).mockRejectedValueOnce(new Error("boom"));
    await expectCode(
      a.todos.update({ id: created.id, status: "open" }),
      "INTERNAL_SERVER_ERROR",
      500
    );
    vi.mocked(todos.remove).mockRejectedValueOnce(storage);
    return expectCode(a.todos.remove({ id: created.id }), "STORAGE_ERROR", 503);
  });

  it("reports STORAGE_ERROR when the repository is not wired", () =>
    expectCode(
      clientFor({ session: session("user-a") }).todos.list({}),
      "STORAGE_ERROR",
      503
    ));
});
