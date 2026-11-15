import {
  createAssistantActionsRepository,
  createNodeDatabase,
  createRepositories,
  createStrategyDefinitionsRepository,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDatabase: PostgresTestDatabase;
let databaseResource: ReturnType<typeof createNodeDatabase>;

let next = 0;
const dependencies = {
  generateId: () => {
    next += 1;
    return `ai-${next}`;
  },
  now: () => new Date(Date.UTC(2026, 9, 23, 12, 0, next)),
};

const SHA = (fill: string) => fill.repeat(64);

describe("assistant actions and strategy definition revisions on real Postgres", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    databaseResource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    return await migrate(databaseResource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      if (databaseResource !== undefined) return await databaseResource.close();
      return;
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("appends revisions, refuses a taken revision and lists only the latest", async () => {
    const definitions = createStrategyDefinitionsRepository(
      databaseResource.db,
      dependencies
    );
    const base = {
      createdBy: "operator",
      definition: { version: 1 },
      note: null,
    };
    await definitions.insert({
      ...base,
      definitionId: "def-a",
      name: "A1",
      revision: 1,
      sha256: SHA("a"),
    });
    await definitions.insert({
      ...base,
      definitionId: "def-b",
      name: "B1",
      revision: 1,
      sha256: SHA("b"),
    });
    await definitions.insert({
      ...base,
      definitionId: "def-a",
      name: "A2",
      revision: 2,
      sha256: SHA("c"),
    });
    await expect(
      definitions.insert({
        ...base,
        definitionId: "def-a",
        name: "A2 again",
        revision: 2,
        sha256: SHA("d"),
      })
    ).resolves.toBeNull();
    expect((await definitions.latest("def-a"))?.name).toBe("A2");
    expect((await definitions.get("def-a", 1))?.name).toBe("A1");
    expect(
      (await definitions.history("def-a", 10)).map((row) => row.revision)
    ).toEqual([2, 1]);
    expect(
      // Migration 0061 seeds the qc-port definitions; this test checks its own rows.
      (await definitions.listLatest(50))
        .filter((row) => row.definitionId.startsWith("def-"))
        .map((row) => [row.definitionId, row.revision])
    ).toEqual([
      ["def-a", 2],
      ["def-b", 1],
    ]);
    await expect(
      definitions.insert({
        ...base,
        definitionId: "def-c",
        name: "Bad hash",
        revision: 1,
        sha256: "not-a-hash",
      })
    ).rejects.toThrow();
  });

  it("decides and finishes an action once, owner-scoped, and cascades with its thread", async () => {
    const database = databaseResource.db;
    await testDatabase.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
      ["user-ai-1", "Fictional Operator", "fictional-ai@domain.test"]
    );
    const repositories = createRepositories(database, dependencies);
    const assistant = repositories.assistant;
    if (assistant === undefined) throw new Error("assistant repository");
    const thread = await assistant.createThread({
      title: "Fictional",
      userId: "user-ai-1",
    });
    const reply = await assistant.appendMessage({
      content: "Card",
      mode: "act",
      role: "assistant",
      threadId: thread.id,
    });
    const actions = createAssistantActionsRepository(database, dependencies);
    const [card, second] = await actions.createMany([
      {
        args: { symbol: "TEST" },
        messageId: reply.id,
        summary: "Run a backtest",
        threadId: thread.id,
        tool: "backtest_runs_submit",
        userId: "user-ai-1",
      },
      {
        args: { definition: {} },
        messageId: reply.id,
        summary: "Save",
        threadId: thread.id,
        tool: "strategy_definition_save",
        userId: "user-ai-1",
      },
    ]);
    if (card === undefined || second === undefined) throw new Error("cards");
    expect(second.createdAt.getTime() - card.createdAt.getTime()).toBe(1);
    await expect(
      actions.listForMessages(thread.id, ["other"])
    ).resolves.toEqual([]);
    expect(card.status).toBe("pending");
    await expect(
      actions.decide({ decision: "approve", id: card.id, userId: "other" })
    ).resolves.toBeNull();
    const running = await actions.decide({
      decision: "approve",
      id: card.id,
      userId: "user-ai-1",
    });
    expect(running?.status).toBe("running");
    await expect(
      actions.decide({ decision: "reject", id: card.id, userId: "user-ai-1" })
    ).resolves.toBeNull();
    const done = await actions.finish(card.id, {
      result: '{"id":"run-1"}',
      status: "executed",
    });
    expect(done?.status).toBe("executed");
    await expect(
      actions.finish(card.id, { error: "again", status: "failed" })
    ).resolves.toBeNull();
    const rejected = await actions.decide({
      decision: "reject",
      id: second.id,
      userId: "user-ai-1",
    });
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.finishedAt).not.toBeNull();
    expect(
      (await actions.listForMessages(thread.id, [reply.id])).map(
        (row) => row.status
      )
    ).toEqual(["executed", "rejected"]);
    await testDatabase.query('DELETE FROM "assistant_threads" WHERE id = $1', [
      thread.id,
    ]);
    expect(await actions.listForMessages(thread.id, [reply.id])).toEqual([]);
  });
});
