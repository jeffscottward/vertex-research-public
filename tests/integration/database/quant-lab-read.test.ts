import {
  createNodeDatabase,
  createQuantLabReadRepository,
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

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

const doi = "10.2139/ssrn.9100001";

// Fixture rows written with plain SQL so this test does not depend on the recorder.
const seed = async () => {
  await postgres().query(
    "INSERT INTO research_papers (id, title, identifier, source_url, stage, verdict) VALUES ($1, $2, $3, $4, 'backtested', 'inconclusive')",
    ["paper-ssrn-9100001", "Read fixture paper", doi, `https://doi.org/${doi}`]
  );
  await postgres().query(
    "INSERT INTO paper_captures (id, paper_id, doi, ssrn_id, version, topic, title, url, metadata_source, pdf_status, captured_at) VALUES ($1, $2, $3, '9100001', 'crossref-deposited:2026-01-01T00:00:00Z', 'fixture topic', 'Read fixture paper', $4, 'crossref', 'metadata_only:no_free_copy', '2026-01-02T00:00:00Z')",
    [
      "capture-read-fixture",
      "paper-ssrn-9100001",
      doi,
      `https://doi.org/${doi}`,
    ]
  );
  for (const id of ["strategy-quantlab-read", "strategy-quantlab-other"])
    await postgres().query(
      "INSERT INTO strategies (id, slug, name, kind, status, section) VALUES ($1, $2, 'Read fixture rule', 'python', 'backtested', 'Quant Lab')",
      [id, id.replace("strategy-", "")]
    );
  await postgres().query(
    "INSERT INTO agent_tasks (id, kind, agent, title, status) VALUES ('task-quantlab-read', 'backtest', 'quant-lab', 'Read fixture backtest', 'succeeded')"
  );
  // Two recorder backtests of the linked spec, one of its sibling spec (same strategy), and an
  // agent backtest on the same strategy that must not appear on either study card.
  const backtests: [string, string, string][] = [
    [
      "bt-quantlab-bbbbbbbbbbbb-000000000001",
      "strategy-quantlab-read",
      "2026-01-01T00:00:00Z",
    ],
    [
      "bt-quantlab-bbbbbbbbbbbb-000000000002",
      "strategy-quantlab-read",
      "2026-02-01T00:00:00Z",
    ],
    [
      "bt-quantlab-dddddddddddd-000000000003",
      "strategy-quantlab-read",
      "2026-01-15T00:00:00Z",
    ],
    ["bt-agent-read", "strategy-quantlab-read", "2026-05-01T00:00:00Z"],
    ["bt-quantlab-other", "strategy-quantlab-other", "2026-04-01T00:00:00Z"],
  ];
  for (const [id, strategyId, createdAt] of backtests)
    await postgres().query(
      `INSERT INTO backtest_results (id, task_id, paper_id, strategy_id, strategy, instruments, period_start, period_end, data_source, metrics, max_drawdown, notes, created_at) VALUES ($1, 'task-quantlab-read', 'paper-ssrn-9100001', $2, 'fixture', 'SPY', '2020-01-01', '2020-12-31', 'fixture', '{"wf_sharpe": 0.5}'::jsonb, -0.2, 'PASS a: b', $3)`,
      [id, strategyId, createdAt]
    );
  await postgres().query(
    `INSERT INTO strategy_specs (id, spec_key, spec_sha256, paper_id, capture_id, strategy_id, name, hypothesis, paper_claims, our_reading, spec, created_at) VALUES ('spec-read-linked', 'read-linked', $1, 'paper-ssrn-9100001', 'capture-read-fixture', 'strategy-quantlab-read', 'Linked spec', 'Fixture hypothesis.', '[{"quote": "fixture", "locator": "abstract"}]'::jsonb, '{"gaps": ["none"]}'::jsonb, '{"id": "read-linked"}'::jsonb, '2026-03-01T00:00:00Z')`,
    ["b".repeat(64)]
  );
  await postgres().query(
    `INSERT INTO strategy_specs (id, spec_key, spec_sha256, name, hypothesis, paper_claims, our_reading, spec, created_at) VALUES ('spec-read-bare', 'read-bare', $1, 'Bare spec', 'Fixture hypothesis.', '[{"quote": "bare", "locator": "title"}]'::jsonb, '{}'::jsonb, '{"id": "read-bare"}'::jsonb, '2026-03-02T00:00:00Z')`,
    ["c".repeat(64)]
  );
  // A second frozen version of the strategy (new hash, same strategy row).
  await postgres().query(
    `INSERT INTO strategy_specs (id, spec_key, spec_sha256, strategy_id, name, hypothesis, paper_claims, our_reading, spec, created_at) VALUES ('spec-read-sibling', 'read-linked', $1, 'strategy-quantlab-read', 'Sibling spec', 'Fixture hypothesis.', '[{"quote": "sibling", "locator": "abstract"}]'::jsonb, '{}'::jsonb, '{"id": "read-linked"}'::jsonb, '2026-03-03T00:00:00Z')`,
    ["d".repeat(64)]
  );
};

describe("Quant Lab read repository on real Postgres", {
  concurrent: false,
}, () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
    return await seed();
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("lists specs newest first, each with the newest backtest of that exact spec", async () => {
    const model = await createQuantLabReadRepository(database()).list();
    const studies = model.studies.filter((study) =>
      study.id.startsWith("spec-read-")
    );
    expect(studies.map((study) => study.id)).toEqual([
      "spec-read-sibling",
      "spec-read-bare",
      "spec-read-linked",
    ]);
    // Same strategy as spec-read-linked, but only its own hash-prefixed backtest; the newer
    // agent backtest (bt-agent-read) on that strategy is ignored.
    expect(studies.shift()).toMatchObject({
      backtest: { id: "bt-quantlab-dddddddddddd-000000000003" },
      paper: null,
      strategy: { id: "strategy-quantlab-read" },
    });
    expect(studies[0]).toMatchObject({
      backtest: null,
      paper: null,
      strategy: null,
    });
    expect(studies[1]).toMatchObject({
      backtest: {
        id: "bt-quantlab-bbbbbbbbbbbb-000000000002",
        maxDrawdown: -0.2,
        metrics: { wf_sharpe: 0.5 },
        notes: "PASS a: b",
        periodEnd: "2020-12-31",
        periodStart: "2020-01-01",
      },
      ourReading: { gaps: ["none"] },
      paper: {
        id: "paper-ssrn-9100001",
        identifier: doi,
        stage: "backtested",
        verdict: "inconclusive",
      },
      paperClaims: [{ locator: "abstract", quote: "fixture" }],
      specKey: "read-linked",
      specSha256: "b".repeat(64),
      strategy: {
        id: "strategy-quantlab-read",
        slug: "quantlab-read",
        status: "backtested",
      },
    });
    expect(studies[1]?.createdAt).toEqual(new Date("2026-03-01T00:00:00Z"));
    expect(studies[1]?.backtest?.createdAt).toEqual(
      new Date("2026-02-01T00:00:00Z")
    );
    const capture = model.captures.find(
      (row) => row.id === "capture-read-fixture"
    );
    return expect(capture).toEqual({
      capturedAt: new Date("2026-01-02T00:00:00Z"),
      doi,
      id: "capture-read-fixture",
      pdfStatus: "metadata_only:no_free_copy",
      ssrnId: "9100001",
      title: "Read fixture paper",
      topic: "fixture topic",
      url: `https://doi.org/${doi}`,
      version: "crossref-deposited:2026-01-01T00:00:00Z",
    });
  });
});
