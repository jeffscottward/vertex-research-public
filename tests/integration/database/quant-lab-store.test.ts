import {
  createNodeDatabase,
  type Database,
  normalizeBacktestResult,
  type QuantLabStore,
  recordQuantLab,
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

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const doi = "10.2139/ssrn.9000001";
const specSha = "a".repeat(64);

// Writes one paper, capture, strategy, spec, task and backtest, as scripts/quant-lab/record.ts does.
const recordOnce = async (store: QuantLabStore) => {
  const paperId = await store.ensurePaper({
    id: "paper-ssrn-9000001",
    identifier: doi,
    sourceUrl: `https://doi.org/${doi}`,
    stage: "ingested",
    title: "Fixture paper",
  });
  const captureId = await store.ensureCapture({
    authors: ["A. Author"],
    capturedAt: new Date("2026-01-02T00:00:00Z"),
    doi,
    id: "capture-fixture",
    metadataSource: "crossref",
    paperId,
    pdfStatus: "metadata_only:no_free_copy",
    ssrnId: "9000001",
    title: "Fixture paper",
    topic: "fixture topic",
    url: `https://doi.org/${doi}`,
    version: "crossref-deposited:2026-01-01T00:00:00Z",
  });
  const strategyId = await store.upsertStrategy({
    id: "strategy-quantlab-fixture",
    kind: "python",
    name: "Fixture rule",
    section: "Quant Lab",
    slug: "quantlab-fixture",
    status: "backtested",
  });
  await store.ensureSpec({
    captureId,
    hypothesis: "Fixture hypothesis.",
    id: "spec-fixture",
    name: "Fixture rule",
    ourReading: { gaps: [] },
    paperClaims: [{ locator: "abstract", quote: "fixture" }],
    paperId,
    spec: { id: "fixture" },
    specKey: "fixture",
    specSha256: specSha,
    strategyId,
  });
  await store.advancePaperStage(paperId, "spec_extracted", [
    "queued",
    "ingested",
  ]);
  await store.ensureTask({
    agent: "quant-lab",
    id: "task-quantlab-fixture",
    kind: "backtest",
    paperId,
    status: "succeeded",
    title: "Fixture backtest",
  });
  await store.ensureBacktest({
    id: "bt-quantlab-fixture",
    ...normalizeBacktestResult({
      dataSource: "fixture",
      instruments: "SPY",
      metrics: { wf_sharpe: 0.5 },
      paperId,
      periodEnd: "2020-12-31",
      periodStart: "2020-01-01",
      strategy: "fixture",
      strategyId,
      taskId: "task-quantlab-fixture",
    }),
  });
  await store.setPaperOutcome(paperId, {
    reproducedMetrics: { wf_sharpe: 0.5 },
    stage: "backtested",
    verdict: "inconclusive",
  });
  return { captureId, paperId, strategyId };
};

const counts = () =>
  postgres().query<{ name: string; count: string }>(
    "SELECT 'papers' AS name, count(*)::text AS count FROM research_papers UNION ALL SELECT 'captures', count(*)::text FROM paper_captures UNION ALL SELECT 'strategies', count(*)::text FROM strategies UNION ALL SELECT 'specs', count(*)::text FROM strategy_specs UNION ALL SELECT 'tasks', count(*)::text FROM agent_tasks UNION ALL SELECT 'backtests', count(*)::text FROM backtest_results ORDER BY name"
  );

describe("Quant Lab store on real Postgres", { concurrent: false }, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
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

  it("records every artifact once and a rerun writes no new rows", async () => {
    const baseline = await counts();
    const first = await recordQuantLab(database(), recordOnce);
    const before = await counts();
    const second = await recordQuantLab(database(), recordOnce);
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
    expect(
      before.map(
        (row, index) => Number(row.count) - Number(baseline[index]?.count)
      )
    ).toEqual([1, 1, 1, 1, 1, 1]);
    const [paper] = await postgres().query<{
      stage: string;
      verdict: string;
      reproduced_metrics: unknown;
    }>(
      "SELECT stage, verdict, reproduced_metrics FROM research_papers WHERE id = 'paper-ssrn-9000001'"
    );
    expect(paper).toEqual({
      reproduced_metrics: { wf_sharpe: 0.5 },
      stage: "backtested",
      verdict: "inconclusive",
    });
  });

  it("keeps a later paper stage and an existing paper with the same DOI", async () => {
    await recordQuantLab(database(), async (store) => {
      expect(
        await store.ensurePaper({
          id: "paper-other-id",
          identifier: doi,
          title: "Other title",
        })
      ).toBe("paper-ssrn-9000001");
      await store.advancePaperStage("paper-ssrn-9000001", "spec_extracted", [
        "queued",
        "ingested",
      ]);
    });
    const [paper] = await postgres().query<{ title: string; stage: string }>(
      "SELECT title, stage FROM research_papers WHERE identifier = '10.2139/ssrn.9000001'"
    );
    expect(paper).toEqual({ stage: "backtested", title: "Fixture paper" });
  });

  it("keeps an operator's later stage, verdict and strategy status on a rerun", async () => {
    await postgres().query(
      "UPDATE research_papers SET stage = 'verdict', verdict = 'rejected' WHERE id = 'paper-ssrn-9000001'"
    );
    await postgres().query(
      "UPDATE strategies SET status = 'paper' WHERE slug = 'quantlab-fixture'"
    );
    await recordQuantLab(database(), async (store) => {
      await store.upsertStrategy({
        description: "Refreshed description",
        id: "strategy-quantlab-fixture",
        kind: "python",
        name: "Fixture rule",
        section: "Quant Lab",
        slug: "quantlab-fixture",
        status: "researching",
      });
      await store.setPaperOutcome("paper-ssrn-9000001", {
        reproducedMetrics: { wf_sharpe: 0.7 },
        stage: "backtested",
        verdict: "promising",
      });
    });
    const [paper] = await postgres().query<{
      stage: string;
      verdict: string;
      reproduced_metrics: unknown;
    }>(
      "SELECT stage, verdict, reproduced_metrics FROM research_papers WHERE id = 'paper-ssrn-9000001'"
    );
    expect(paper).toEqual({
      reproduced_metrics: { wf_sharpe: 0.7 },
      stage: "verdict",
      verdict: "rejected",
    });
    const [strategy] = await postgres().query<{
      status: string;
      description: string | null;
    }>(
      "SELECT status, description FROM strategies WHERE slug = 'quantlab-fixture'"
    );
    expect(strategy).toEqual({
      description: "Refreshed description",
      status: "paper",
    });
  });

  it("sets the outcome of a paper at an earlier stage even when a verdict exists", async () => {
    await postgres().query(
      "UPDATE research_papers SET stage = 'implemented', verdict = 'rejected' WHERE id = 'paper-ssrn-9000001'"
    );
    await recordQuantLab(database(), (store) =>
      store.setPaperOutcome("paper-ssrn-9000001", {
        reproducedMetrics: { wf_sharpe: 0.8 },
        stage: "backtested",
        verdict: "promising",
      })
    );
    const [paper] = await postgres().query<{ stage: string; verdict: string }>(
      "SELECT stage, verdict FROM research_papers WHERE id = 'paper-ssrn-9000001'"
    );
    expect(paper).toEqual({ stage: "backtested", verdict: "promising" });
  });

  it("rolls back every write of a recording when one write fails", async () => {
    const before = await counts();
    const failing = recordQuantLab(database(), async (store) => {
      await store.ensurePaper({
        id: "paper-ssrn-9000002",
        identifier: "10.2139/ssrn.9000002",
        title: "Second paper",
      });
      await store.ensureSpec({
        hypothesis: "Bad.",
        id: "spec-bad",
        name: "Bad",
        ourReading: {},
        paperClaims: [{ quote: "x" }],
        spec: {},
        specKey: "bad",
        specSha256: "not-a-hash",
      });
    });
    await expect(failing).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });
});
