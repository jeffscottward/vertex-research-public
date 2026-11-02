import {
  AgentModelRunClosedError,
  AgentModelRunEventLimitError,
  AgentModelRunInputError,
  AgentModelRunSeqError,
  type AgentModelRunRecordInput,
  type AgentModelRunsRepository,
  AgentModelRunStateError,
  createAgentModelRunsRepository,
  createAgentOpsRepository,
  createNodeDatabase,
  type Database,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

let clock = Date.parse("2026-10-01T00:00:00.000Z");
let ids = 0;
const repository = (): AgentModelRunsRepository =>
  createAgentModelRunsRepository(database(), {
    generateId: () => {
      ids += 1;
      return `run-${String(ids).padStart(3, "0")}`;
    },
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
  });

const base = (
  runKey: string,
  overrides: Partial<AgentModelRunRecordInput> = {}
): AgentModelRunRecordInput => ({
  decisionDate: "2026-09-01",
  framework: "tradingagents",
  model: "gpt-4o-mini",
  provider: "openai",
  runKey,
  ticker: "AAPL",
  ...overrides,
});

describe("agent model runs in Postgres", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 2,
    });
    return await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("records idempotently by run key and links an agent task", async () => {
    const task = await createAgentOpsRepository(database()).createTask({
      agent: "test",
      kind: "research",
      title: "Model run grid",
    });
    const first = await repository().record(
      base("key-1", {
        analysts: ["market", "news", "market"],
        flags: ["memory_off", "memory_off"],
        modelsServed: [
          { requested: "gpt-4o-mini", served: "gpt-4o-mini-2024-07-18" },
        ],
        rating: "buy",
        taskId: task.id,
      })
    );
    expect(first.created).toBe(true);
    expect(first.run).toMatchObject({
      analysts: ["market", "news"],
      flags: ["memory_off"],
      purpose: "live",
      ratingSource: "stated",
      status: "queued",
      taskId: task.id,
    });
    const again = await repository().record(
      base("key-1", { model: "other", rating: "sell" })
    );
    expect(again).toEqual({ created: false, run: first.run });
    await expect(
      repository().record(base("key-2", { taskId: "missing-task" }))
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });

  it("enforces the column checks in Postgres", async () => {
    const insert = (column: string, value: string) =>
      database().execute(
        `insert into agent_model_runs (id, run_key, framework, provider, model, ticker, decision_date, ${column}) values ('bad-${column}', 'bad-${column}', 'tradingagents', 'openai', 'm', 'AAPL', '2026-09-01', ${value})`
      );
    await expect(insert("rating", "'buy'")).rejects.toThrow();
    await expect(insert("status", "'paused'")).rejects.toThrow();
    await expect(insert("flags", `'[1]'::jsonb`)).rejects.toThrow();
    await expect(insert("entry_price", "-1")).rejects.toThrow();
    await expect(
      repository().record(base("key-bad", { framework: "Bad Name" }))
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });

  it("moves forward only and keeps a terminal status final", async () => {
    const { run } = await repository().record(base("key-3"));
    const running = await repository().update({
      id: run.id,
      status: "running",
    });
    expect(running?.startedAt).toBeInstanceOf(Date);
    const done = await repository().update({
      costUsd: 0.25,
      id: run.id,
      inputTokens: 1200,
      rating: "hold",
      ratingSource: "mapped",
      status: "succeeded",
    });
    expect(done).toMatchObject({
      costUsd: 0.25,
      inputTokens: 1200,
      rating: "hold",
      ratingSource: "mapped",
      startedAt: running?.startedAt,
      status: "succeeded",
    });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    await expect(
      repository().update({ id: run.id, status: "running" })
    ).rejects.toBeInstanceOf(AgentModelRunStateError);
    await expect(
      repository().update({ id: run.id, outputTokens: 5, status: "succeeded" })
    ).rejects.toThrow("only rating, ratingSource and flags can change");
    await expect(
      repository().update({ flags: ["rerun"], id: run.id, rating: "buy" })
    ).resolves.toMatchObject({ flags: ["rerun"], rating: "buy" });
    await expect(
      repository().update({ finishedAt: null, id: run.id, status: "succeeded" })
    ).resolves.toMatchObject({ finishedAt: done?.finishedAt });
    await expect(
      repository().update({ id: "missing", status: "running" })
    ).resolves.toBeNull();
    await expect(
      repository().update({ id: run.id, ratingSource: "missing" })
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });

  it("filters, pages and counts facets over the other active filters", async () => {
    await database().execute("delete from agent_model_runs");
    const rows: AgentModelRunRecordInput[] = [
      base("f-1", {
        decisionDate: "2026-09-01",
        horizon: "2-4 weeks",
        rating: "buy",
        flags: ["rerun"],
      }),
      base("f-2", {
        decisionDate: "2026-09-02",
        horizon: "6 months",
        rating: "hold",
        model: "claude",
        provider: "anthropic",
      }),
      base("f-3", {
        decisionDate: "2026-09-03",
        ticker: "MSFT",
        framework: "ai_hedge_fund",
        status: "failed",
        flags: ["parse_failed", "rerun"],
      }),
      base("f-4", {
        decisionDate: "2026-09-04",
        ticker: "MSFT",
        horizon: "1 year",
        rating: "sell",
        variant: "no-memory",
        modelsServed: [
          { requested: "gpt-4o-mini", served: "gpt-4o-mini-2024-07-18" },
        ],
        costUsd: 2,
      }),
      base("f-5", {
        decisionDate: "2026-09-05",
        rating: "hold",
        costUsd: 1,
        purpose: "benchmark",
        batch: "grid-1",
      }),
    ];
    for (const row of rows) await repository().record(row);

    const page1 = await repository().list({ filters: {}, limit: 2 });
    expect(page1.runs.map((run) => run.runKey)).toEqual(["f-5", "f-4"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await repository().list({
      cursor: page1.nextCursor ?? "",
      filters: {},
      limit: 2,
    });
    expect(page2.runs.map((run) => run.runKey)).toEqual(["f-3", "f-2"]);
    const page3 = await repository().list({
      cursor: page2.nextCursor ?? "",
      filters: {},
      limit: 2,
    });
    expect(page3).toEqual({ nextCursor: null, runs: [page3.runs[0]] });

    const unrated = await repository().list({
      filters: { rating: ["unrated", "sell"] },
      limit: 50,
    });
    expect(unrated.runs.map((run) => run.runKey)).toEqual(["f-4", "f-3"]);
    const filtered = await repository().list({
      filters: {
        decisionFrom: "2026-09-02",
        decisionTo: "2026-09-04",
        flags: ["rerun"],
        horizonBucket: ["unknown"],
        servedModel: [],
      },
      limit: 50,
    });
    expect(filtered.runs.map((run) => run.runKey)).toEqual(["f-3"]);
    expect(
      (
        await repository().list({
          filters: { batch: "grid-1", purpose: ["benchmark"] },
          limit: 50,
        })
      ).runs.map((run) => run.runKey)
    ).toEqual(["f-5"]);
    expect(
      (
        await repository().list({
          filters: {
            servedModel: ["gpt-4o-mini-2024-07-18"],
            variant: ["no-memory"],
          },
          limit: 50,
        })
      ).runs.map((run) => run.runKey)
    ).toEqual(["f-4"]);

    const facets = await repository().facets({ ticker: ["MSFT"] });
    // The ticker facet ignores its own filter; every other facet is narrowed to MSFT.
    expect(facets.ticker).toEqual([
      { count: 3, value: "AAPL" },
      { count: 2, value: "MSFT" },
    ]);
    expect(facets.framework).toEqual([
      { count: 1, value: "ai_hedge_fund" },
      { count: 1, value: "tradingagents" },
    ]);
    expect(facets.rating).toEqual([
      { count: 1, value: "sell" },
      { count: 1, value: "unrated" },
    ]);
    expect(facets.flags).toEqual([
      { count: 1, value: "parse_failed" },
      { count: 1, value: "rerun" },
    ]);
    expect(facets.servedModel).toEqual([
      { count: 1, value: "gpt-4o-mini-2024-07-18" },
    ]);
    expect(facets.variant).toEqual([{ count: 1, value: "no-memory" }]);
    expect(facets.horizonBucket).toEqual([
      { count: 1, value: "quarters_plus" },
      { count: 1, value: "unknown" },
    ]);
    expect(facets.status).toEqual([
      { count: 1, value: "failed" },
      { count: 1, value: "queued" },
    ]);
    const all = await repository().facets({});
    expect(all.horizonBucket).toEqual([
      { count: 2, value: "unknown" },
      { count: 1, value: "months" },
      { count: 1, value: "quarters_plus" },
      { count: 1, value: "weeks" },
    ]);
    expect(all.purpose).toEqual([
      { count: 4, value: "live" },
      { count: 1, value: "benchmark" },
    ]);
    // The batch facet ignores its own filter and leaves out runs without a batch.
    expect(all.batch).toEqual([{ count: 1, value: "grid-1" }]);
    expect((await repository().facets({ batch: "other" })).batch).toEqual([
      { count: 1, value: "grid-1" },
    ]);

    const byModel = await repository().breakdown({}, "model");
    expect(byModel).toEqual([
      {
        avgCostUsd: 0.75,
        failed: 1,
        holdShare: 1 / 3,
        key: "gpt-4o-mini",
        rated: 3,
        runs: 4,
        totalCostUsd: 3,
      },
      {
        avgCostUsd: 0,
        failed: 0,
        holdShare: 1,
        key: "claude",
        rated: 1,
        runs: 1,
        totalCostUsd: 0,
      },
    ]);
    const byVariant = await repository().breakdown(
      { ticker: ["MSFT"] },
      "variant"
    );
    expect(byVariant.map((row) => [row.key, row.runs, row.holdShare])).toEqual([
      ["no-memory", 1, 0],
      [null, 1, null],
    ]);
    const byServed = await repository().breakdown({}, "servedModel");
    expect(byServed).toEqual([
      expect.objectContaining({ key: "gpt-4o-mini-2024-07-18", runs: 1 }),
    ]);
  });

  it("appends events idempotently, adds flag slugs once and pages after a seq", async () => {
    const { run } = await repository().record(
      base("events-1", { flags: ["rerun"] })
    );
    const first = await repository().appendEvents(run.id, [
      {
        agent: "Market Analyst",
        kind: "tool_call",
        seq: 0,
        title: "get_stock_data",
        toolName: "get_stock_data",
      },
      {
        agent: "Market Analyst",
        body: "RSI is oversold near support.",
        kind: "reasoning",
        seq: 1,
        title: "Reads the chart",
      },
      { agent: "Risk Manager", kind: "flag", seq: 2, title: "parse_failed" },
      { agent: "Risk Manager", kind: "flag", seq: 3, title: "rerun" },
    ]);
    expect(first).toEqual({ appended: 4, lastSeq: 3 });
    const again = await repository().appendEvents(run.id, [
      { agent: "Changed", kind: "message", seq: 1, title: "overwrite attempt" },
      {
        agent: "Trader",
        body: "Final call: overweight AAPL with a stop below support.",
        kind: "decision",
        seq: 4,
        title: "Decision",
      },
    ]);
    expect(again).toEqual({ appended: 1, lastSeq: 4 });
    const stored = await repository().events(run.id, -1, 500);
    expect(stored.map((event) => [event.seq, event.agent])).toEqual([
      [0, "Market Analyst"],
      [1, "Market Analyst"],
      [2, "Risk Manager"],
      [3, "Risk Manager"],
      [4, "Trader"],
    ]);
    expect(stored[0]).not.toHaveProperty("search");
    expect(
      (await repository().events(run.id, 2, 1)).map((event) => event.seq)
    ).toEqual([3]);
    expect((await repository().get(run.id))?.flags).toEqual([
      "rerun",
      "parse_failed",
    ]);
    await expect(
      repository().appendEvents("missing", [
        { agent: "a", kind: "status", seq: 0, title: "x" },
      ])
    ).resolves.toBeNull();
    await expect(
      repository().appendEvents(run.id, [
        { agent: "a", kind: "flag", seq: 9, title: "Not A Slug" },
      ])
    ).rejects.toBeInstanceOf(AgentModelRunInputError);
  });

  it("closes a finished run to new events after 10 minutes and caps events per run", async () => {
    const { run } = await repository().record(base("events-2"));
    await repository().update({ id: run.id, status: "succeeded" });
    await expect(
      repository().appendEvents(run.id, [
        { agent: "a", kind: "status", seq: 0, title: "late but in time" },
      ])
    ).resolves.toEqual({ appended: 1, lastSeq: 0 });
    clock += 11 * 60 * 1000;
    await expect(
      repository().appendEvents(run.id, [
        { agent: "a", kind: "status", seq: 1, title: "too late" },
      ])
    ).rejects.toBeInstanceOf(AgentModelRunClosedError);

    const { run: busy } = await repository().record(base("events-3"));
    for (let start = 0; start < 5000; start += 200)
      await repository().appendEvents(
        busy.id,
        Array.from({ length: 200 }, (_, index) => ({
          agent: "a",
          kind: "status" as const,
          seq: start + index,
          title: "tick",
        }))
      );
    await expect(
      repository().appendEvents(busy.id, [
        { agent: "a", kind: "status", seq: 5000, title: "one more" },
      ])
    ).rejects.toBeInstanceOf(AgentModelRunEventLimitError);
    await expect(
      repository().appendEvents(busy.id, [
        { agent: "a", kind: "status", seq: 4999, title: "retry" },
      ])
    ).resolves.toEqual({ appended: 0, lastSeq: 4999 });
  });

  it("finds runs by event text with highlighted snippets and the facet filters", async () => {
    const { run: other } = await repository().record(
      base("search-2", { ticker: "MSFT" })
    );
    await repository().appendEvents(other.id, [
      {
        agent: "News Analyst",
        body: "Support held after the earnings call.",
        kind: "reasoning",
        seq: 0,
        title: "Earnings",
      },
    ]);
    const hits = await repository().search("support", {});
    expect(hits.map((hit) => hit.run.runKey)).toEqual(
      expect.arrayContaining(["events-1", "search-2"])
    );
    const first = hits.find((hit) => hit.run.runKey === "events-1");
    expect(first?.snippets.length).toBeGreaterThan(0);
    expect(first?.snippets.length).toBeLessThanOrEqual(3);
    expect(first?.snippets[0]?.text).toContain("\uE000");
    expect(first?.rank).toBeGreaterThan(0);
    const filtered = await repository().search("support", { ticker: ["MSFT"] });
    expect(filtered.map((hit) => hit.run.runKey)).toEqual(["search-2"]);
    expect(filtered[0]?.snippets).toEqual([
      expect.objectContaining({
        agent: "News Analyst",
        kind: "reasoning",
        seq: 0,
      }),
    ]);
    await expect(
      repository().search("nothing-matches-this", {})
    ).resolves.toEqual([]);
  });

  it("keeps text that looks like markup or entities in search snippets", async () => {
    const { run } = await repository().record(base("search-markup"));
    const body =
      "Buy if price<100 & volume>2M; the <b>quokka</b> &amp; <br/> holds";
    await repository().appendEvents(run.id, [
      { agent: "Trader", body, kind: "reasoning", seq: 0, title: "Plan" },
    ]);
    const [hit] = await repository().search("quokka", {});
    const snippet = hit?.snippets[0]?.text ?? "";
    expect(snippet).toContain("\uE000quokka\uE001");
    // ts_headline parses its input as HTML and drops tags; the snippet must match the stored text.
    const plain = snippet.replaceAll(/[\uE000\uE001]/gu, "");
    expect(`Plan ${body}`).toContain(plain);
    expect(plain).toContain(
      "price<100 & volume>2M; the <b>quokka</b> &amp; <br/> holds"
    );
  });

  it("keeps seqs increasing, accepts exact retries and serializes concurrent appends", async () => {
    const { run } = await repository().record(base("events-order"));
    const event = (seq: number) => ({
      agent: "a",
      kind: "status" as const,
      seq,
      title: `tick ${seq}`,
    });
    await repository().appendEvents(run.id, [event(0), event(5), event(7)]);
    await expect(
      repository().appendEvents(run.id, [event(6)])
    ).rejects.toBeInstanceOf(AgentModelRunSeqError);
    await expect(
      repository().appendEvents(run.id, [event(5), event(7), event(8)])
    ).resolves.toEqual({ appended: 1, lastSeq: 8 });
    const results = await Promise.allSettled([
      repository().appendEvents(run.id, [event(9), event(10)]),
      repository().appendEvents(run.id, [event(10), event(11)]),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      (await repository().events(run.id, -1, 500)).map((stored) => stored.seq)
    ).toEqual([0, 5, 7, 8, 9, 10, 11]);
    await repository().appendEvents(run.id, [{ ...event(12), redacted: true }]);
    expect((await repository().get(run.id))?.flags).toEqual(["redacted"]);
  });
});
