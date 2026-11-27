import { readFileSync } from "node:fs";

import { createNodeDatabase, type Database } from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Data migration 0103 (three learning links from reel DfDt0GDR8Oa) and its guarded rollback.
const migrationSql = readFileSync(
  new URL(
    "../../../packages/db/migrations/0103_research_papers_reel_links.sql",
    import.meta.url
  ),
  "utf8"
);
const rollbackSql = readFileSync(
  new URL(
    "../../../packages/db/rollback/0103_research_papers_reel_links.down.sql",
    import.meta.url
  ),
  "utf8"
);

const REEL_IDS = [
  "article-jpmorgan-python-training",
  "article-quantopian-research-public",
  "article-firmai-financial-ml",
] as const;

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const postgres = (): PostgresTestDatabase => {
  if (testDatabase === undefined) throw new Error("Database not started");
  return testDatabase;
};

interface PaperRow {
  authors: string | null;
  blockers: string | null;
  id: string;
  identifier: string | null;
  kind: string;
  notes: string | null;
  source_url: string | null;
  stage: string;
  title: string;
  unedited: boolean;
  verdict: string;
  year: number | null;
}

const reelRows = (): Promise<readonly PaperRow[]> =>
  postgres().query<PaperRow>(
    `select id, title, authors, year, source_url, identifier, kind, stage, verdict, blockers, notes,
            (updated_at = created_at) as unedited
       from research_papers
      where id in ($1, $2, $3)
      order by id`,
    [...REEL_IDS]
  );

const expectRollbackRefused = async (): Promise<void> => {
  try {
    await expect(postgres().query(rollbackSql)).rejects.toThrow(
      /refusing rollback/u
    );
  } finally {
    await postgres().query("ROLLBACK");
  }
};

describe("0103 reel DfDt0GDR8Oa learning links (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    try {
      await resource?.close();
    } finally {
      if (testDatabase !== undefined)
        await dropPostgresTestDatabase(testDatabase);
    }
  }, 60_000);

  it("seeds all three learning links and is idempotent on rerun", async () => {
    const initial = await reelRows();
    expect(initial).toHaveLength(3);
    expect(initial.map((row) => row.id)).toEqual([
      "article-firmai-financial-ml",
      "article-jpmorgan-python-training",
      "article-quantopian-research-public",
    ]);
    expect(initial.map((row) => row.source_url)).toEqual([
      "https://github.com/firmai/financial-machine-learning",
      "https://github.com/jpmorganchase/python-training",
      "https://github.com/quantopian/research_public",
    ]);
    for (const row of initial) {
      expect(row.kind).toBe("article");
      expect(row.stage).toBe("queued");
      expect(row.verdict).toBe("pending");
      expect(row.unedited).toBe(true);
      expect(row.notes).toContain("DfDt0GDR8Oa");
    }

    await postgres().query(migrationSql);
    expect(await reelRows()).toEqual(initial);
  });

  it("rolls back unedited unreferenced rows and leaves earlier seeded papers intact", async () => {
    await postgres().query(rollbackSql);
    expect(await reelRows()).toHaveLength(0);

    const remaining = await postgres().query<{ count: string }>(
      "select count(*)::text as count from research_papers where id in ('paper-orca-2604-17251', 'paper-hmm-rl-2605-27848', 'paper-jump-model-2402-05272', 'article-ruuj-hmm-regimes-20260707')"
    );
    expect(remaining[0]?.count).toBe("4");

    await postgres().query(migrationSql);
    expect(await reelRows()).toHaveLength(3);
  });

  it("skips inserting a link when an operator already added the same source_url or identifier", async () => {
    await postgres().query(rollbackSql);

    // Operator added JPMorgan with a trailing slash & uppercase org via UI (identifier null)
    // and Quantopian via API with the same identifier under a custom id.
    await postgres().query(
      `insert into research_papers (id, title, source_url, identifier, kind, stage, verdict)
       values
         ('operator-jpmorgan-custom', 'Operator JPMorgan Note', 'https://github.com/JPMorganChase/python-training/', null, 'article', 'ingested', 'pending'),
         ('operator-quantopian-custom', 'Operator Quantopian Note', 'https://example.test/quantopian-mirror', 'github:quantopian/research_public', 'article', 'ingested', 'pending')`
    );

    try {
      await postgres().query(migrationSql);

      // Only FirmAI should have been inserted by 0103; the two operator rows stay untouched.
      const seeded = await reelRows();
      expect(seeded.map((row) => row.id)).toEqual([
        "article-firmai-financial-ml",
      ]);

      const operatorRows = await postgres().query<{
        id: string;
        title: string;
      }>(
        `select id, title from research_papers
          where id in ('operator-jpmorgan-custom', 'operator-quantopian-custom')
          order by id`
      );
      expect(operatorRows).toEqual([
        { id: "operator-jpmorgan-custom", title: "Operator JPMorgan Note" },
        { id: "operator-quantopian-custom", title: "Operator Quantopian Note" },
      ]);
    } finally {
      await postgres().query(rollbackSql);
      await postgres().query(
        `delete from research_papers where id in ('operator-jpmorgan-custom', 'operator-quantopian-custom')`
      );
      await postgres().query(migrationSql);
    }
  });

  it("refuses rollback when a row was edited by an operator", async () => {
    await postgres().query(
      `update research_papers
          set notes = 'Operator reviewed', updated_at = created_at + interval '1 minute'
        where id = 'article-jpmorgan-python-training'`
    );
    try {
      await expectRollbackRefused();
      expect(await reelRows()).toHaveLength(3);
    } finally {
      await postgres().query(
        `update research_papers
            set updated_at = created_at
          where id = 'article-jpmorgan-python-training'`
      );
    }
  });

  it("refuses rollback when stage or verdict changed even if updated_at equals created_at", async () => {
    await postgres().query(
      `update research_papers
          set stage = 'ingested'
        where id = 'article-quantopian-research-public'`
    );
    try {
      await expectRollbackRefused();
      expect(await reelRows()).toHaveLength(3);
    } finally {
      await postgres().query(
        `update research_papers
            set stage = 'queued'
          where id = 'article-quantopian-research-public'`
      );
    }
  });

  it("refuses rollback when agent_tasks, backtest_results, paper_captures or strategy_specs references a row", async () => {
    await postgres().query(
      `insert into agent_tasks (id, kind, agent, title, status, paper_id)
       values ('task-reel-ref-check', 'paper', 'researcher', 'Check link', 'queued', 'article-jpmorgan-python-training')`
    );
    try {
      await expectRollbackRefused();
    } finally {
      await postgres().query(
        `delete from agent_tasks where id = 'task-reel-ref-check'`
      );
    }

    await postgres().query(
      `insert into agent_tasks (id, kind, agent, title, status)
       values ('task-reel-bt-owner', 'backtest', 'researcher', 'Backtest link', 'queued')`
    );
    await postgres().query(
      `insert into backtest_results (id, task_id, paper_id, strategy, instruments, period_start, period_end, data_source)
       values ('bt-reel-ref-check', 'task-reel-bt-owner', 'article-quantopian-research-public', 'fixture', 'SPY', '2024-01-01', '2024-02-01', 'fixture')`
    );
    try {
      await expectRollbackRefused();
    } finally {
      await postgres().query(
        `delete from backtest_results where id = 'bt-reel-ref-check'`
      );
      await postgres().query(
        `delete from agent_tasks where id = 'task-reel-bt-owner'`
      );
    }

    await postgres().query(
      `insert into paper_captures (id, paper_id, doi, ssrn_id, version, topic, title, url, metadata_source, pdf_status, captured_at)
       values ('cap-reel-ref-check', 'article-firmai-financial-ml', '10.2139/ssrn.9999999', '9999999', '1', 'ml', 'Sample Capture', 'https://example.test/cap', 'fixture', 'metadata_only:fixture', '2026-11-27T00:00:00Z')`
    );
    try {
      await expectRollbackRefused();
    } finally {
      await postgres().query(
        `delete from paper_captures where id = 'cap-reel-ref-check'`
      );
    }

    await postgres().query(
      `insert into strategy_specs (id, spec_key, spec_sha256, paper_id, name, hypothesis, paper_claims, our_reading, spec)
       values ('spec-reel-ref-check', 'reel-ref-spec', repeat('b', 64), 'article-firmai-financial-ml', 'Sample Spec', 'Test hypothesis', '["claim"]'::jsonb, '{}'::jsonb, '{}'::jsonb)`
    );
    try {
      await expectRollbackRefused();
    } finally {
      await postgres().query(
        `delete from strategy_specs where id = 'spec-reel-ref-check'`
      );
    }

    // After removing all links, rollback succeeds cleanly and forward migration restores all 3.
    await postgres().query(rollbackSql);
    expect(await reelRows()).toHaveLength(0);
    await postgres().query(migrationSql);
    expect(await reelRows()).toHaveLength(3);
  });
});
