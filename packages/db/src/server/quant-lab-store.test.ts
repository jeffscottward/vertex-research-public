import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  agentTasks,
  backtestResults,
  paperCaptures,
  researchPapers,
  strategies,
  strategySpecs,
} from "../schema/index.ts";
import type { Database } from "./client.ts";
import {
  createQuantLabStore,
  QuantLabStoreError,
  recordQuantLab,
} from "./quant-lab-store.ts";

const dialect = new PgDialect();

interface Operation {
  conflict?: { kind: "nothing" | "update"; config: unknown };
  kind: "select" | "insert" | "update";
  set?: Record<string, unknown>;
  table?: unknown;
  values?: unknown;
  where?: SQL;
}

const createDouble = (outcomes: Array<readonly Record<string, unknown>[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: () => chain,
      onConflictDoNothing: (config: unknown) => {
        operation.conflict = { config, kind: "nothing" };
        return chain;
      },
      onConflictDoUpdate: (config: unknown) => {
        operation.conflict = { config, kind: "update" };
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
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
    operations.push(operation);
    return chain;
  };
  let transactions = 0;
  const database = {
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: (work: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      return work(database);
    },
    update: (table: unknown) => builder({ kind: "update", table }),
  } as unknown as Database;
  return {
    database,
    operations,
    transactions: () => transactions,
  };
};

const whereSql = (operation: Operation | undefined) => {
  const where = operation?.where;
  if (where === undefined) throw new Error("operation has no where clause");
  return dialect.sqlToQuery(where);
};

const doi = "10.2139/ssrn.2242795";
const version = "crossref-deposited:2026-08-12T16:24:43Z";

describe("Quant Lab store", () => {
  it("inserts a paper idempotently by DOI and returns the stored id", async () => {
    const double = createDouble([[], [{ id: "paper-existing" }]]);
    const store = createQuantLabStore(double.database);
    await expect(
      store.ensurePaper({ id: "paper-ssrn-1", identifier: doi, title: "T" })
    ).resolves.toBe("paper-existing");
    const [insert, select] = double.operations;
    expect(insert).toMatchObject({ kind: "insert", table: researchPapers });
    expect(insert?.conflict).toEqual({
      config: { target: researchPapers.identifier },
      kind: "nothing",
    });
    expect(select?.table).toBe(researchPapers);
    expect(whereSql(select).params).toEqual([doi]);
  });

  it("fails when a written row cannot be read back", async () => {
    const store = createQuantLabStore(createDouble([[], []]).database);
    await expect(
      store.ensurePaper({ id: "p", identifier: doi, title: "T" })
    ).rejects.toThrow(
      new QuantLabStoreError("research paper was not found after insert")
    );
    const error = new QuantLabStoreError("x");
    expect(error.name).toBe("QuantLabStoreError");
    expect(error).toBeInstanceOf(Error);
  });

  it("finds paper and capture ids or returns null", async () => {
    const double = createDouble([
      [{ id: "paper-1" }],
      [],
      [{ id: "capture-1" }],
      [],
    ]);
    const store = createQuantLabStore(double.database);
    await expect(store.findPaperId(doi)).resolves.toBe("paper-1");
    await expect(store.findPaperId(doi)).resolves.toBeNull();
    await expect(store.findCaptureId(doi, version)).resolves.toBe("capture-1");
    await expect(store.findCaptureId(doi, version)).resolves.toBeNull();
    expect(whereSql(double.operations[2]).params).toEqual([doi, version]);
    expect(double.operations[2]?.table).toBe(paperCaptures);
  });

  it("inserts a capture idempotently by DOI and version", async () => {
    const double = createDouble([[], [{ id: "capture-1" }]]);
    const store = createQuantLabStore(double.database);
    const row = {
      capturedAt: new Date("2026-10-18T17:49:32Z"),
      doi,
      id: "capture-1",
      metadataSource: "crossref",
      paperId: "paper-1",
      pdfStatus: "metadata_only:no_free_copy",
      ssrnId: "2242795",
      title: "T",
      topic: "timing",
      url: "https://doi.org/x",
      version,
    };
    await expect(store.ensureCapture(row)).resolves.toBe("capture-1");
    const [insert, select] = double.operations;
    expect(insert).toMatchObject({ table: paperCaptures, values: row });
    expect(insert?.conflict).toEqual({
      config: { target: [paperCaptures.doi, paperCaptures.version] },
      kind: "nothing",
    });
    expect(whereSql(select).params).toEqual([doi, version]);
  });

  it("upserts a strategy by slug and refreshes status, description and params", async () => {
    const double = createDouble([[], [{ id: "strategy-1" }]]);
    const store = createQuantLabStore(double.database);
    await expect(
      store.upsertStrategy({
        id: "strategy-1",
        kind: "python",
        name: "N",
        slug: "quantlab-x",
      })
    ).resolves.toBe("strategy-1");
    const [insert, select] = double.operations;
    expect(insert?.table).toBe(strategies);
    expect(insert?.conflict?.kind).toBe("update");
    const config = insert?.conflict?.config as {
      target: unknown;
      set: Record<string, SQL>;
    };
    expect(config.target).toBe(strategies.slug);
    expect(
      Object.fromEntries(
        Object.entries(config.set).map(([key, value]) => [
          key,
          dialect.sqlToQuery(value).sql,
        ])
      )
    ).toEqual({
      description: "excluded.description",
      params: "excluded.params",
      status:
        'case when "strategies"."status" in (\'idea\', \'researching\') then excluded.status else "strategies"."status" end',
      updatedAt: "now()",
    });
    expect(whereSql(select).params).toEqual(["quantlab-x"]);
  });

  it("inserts spec, task and backtest rows without overwriting", async () => {
    const double = createDouble([]);
    const store = createQuantLabStore(double.database);
    await store.ensureSpec({
      hypothesis: "H",
      id: "spec-1",
      name: "N",
      ourReading: {},
      paperClaims: [],
      spec: {},
      specKey: "k",
      specSha256: "a".repeat(64),
    });
    await store.ensureTask({
      agent: "quant-lab",
      id: "task-1",
      kind: "backtest",
      title: "T",
    });
    await store.ensureBacktest({
      dataSource: "frozen",
      id: "bt-1",
      instruments: "SPY",
      periodEnd: "2020-12-31",
      periodStart: "2020-01-01",
      strategy: "S",
      taskId: "task-1",
    });
    expect(
      double.operations.map((operation) => [
        operation.table,
        operation.conflict,
      ])
    ).toEqual([
      [
        strategySpecs,
        { config: { target: strategySpecs.specSha256 }, kind: "nothing" },
      ],
      [agentTasks, { config: { target: agentTasks.id }, kind: "nothing" }],
      [
        backtestResults,
        { config: { target: backtestResults.id }, kind: "nothing" },
      ],
    ]);
  });

  it("advances the paper stage only from earlier stages", async () => {
    const double = createDouble([]);
    const store = createQuantLabStore(double.database);
    await store.advancePaperStage("paper-1", "spec_extracted", [
      "queued",
      "ingested",
    ]);
    const [update] = double.operations;
    expect(update).toMatchObject({ kind: "update", table: researchPapers });
    expect(update?.set?.["stage"]).toBe("spec_extracted");
    expect(whereSql(update).params).toEqual(["paper-1", "queued", "ingested"]);
  });

  it("sets the paper outcome without moving a later stage or verdict back", async () => {
    const double = createDouble([]);
    const store = createQuantLabStore(double.database);
    await store.setPaperOutcome("paper-1", {
      reproducedMetrics: { wf_sharpe: 0.6 },
      stage: "backtested",
      verdict: "inconclusive",
    });
    const [update] = double.operations;
    expect(update?.set?.["reproducedMetrics"]).toEqual({ wf_sharpe: 0.6 });
    const earlier = '"research_papers"."stage" in ($1, $2, $3, $4)';
    const stage = dialect.sqlToQuery(update?.set?.["stage"] as SQL);
    expect(stage).toMatchObject({
      params: [
        "queued",
        "ingested",
        "spec_extracted",
        "implemented",
        "backtested",
      ],
      sql: `case when ${earlier} then $5 else "research_papers"."stage" end`,
    });
    const verdict = dialect.sqlToQuery(update?.set?.["verdict"] as SQL);
    expect(verdict).toMatchObject({
      params: [
        "queued",
        "ingested",
        "spec_extracted",
        "implemented",
        "inconclusive",
      ],
      sql: `case when "research_papers"."verdict" = 'pending' or ${earlier} then $5 else "research_papers"."verdict" end`,
    });
    expect(whereSql(update).params).toEqual(["paper-1"]);
  });

  it("runs a recording in one transaction", async () => {
    const double = createDouble([[{ id: "paper-1" }]]);
    await expect(
      recordQuantLab(double.database, (store) => store.findPaperId(doi))
    ).resolves.toBe("paper-1");
    expect(double.transactions()).toBe(1);
  });
});
