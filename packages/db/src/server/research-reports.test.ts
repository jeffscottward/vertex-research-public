import { describe, expect, it } from "vitest";

import {
  RESEARCH_REPORT_DATASETS,
  researchCompanyResearch,
  researchReportCategories,
  researchReportDatasets,
  researchReportRevisions,
  researchReports,
} from "../schema/index.ts";
import type { DatabaseExecutor } from "./client.ts";
import { DatabasePersistenceError } from "./repository-errors.ts";
import {
  createResearchReportsRepository,
  type ResearchCatalogImport,
  ResearchReportsInputError,
  type ResearchRevisionInput,
  validateResearchCatalogImport,
} from "./research-reports.ts";

interface Operation {
  conflict?: "nothing" | "update";
  kind: "select" | "insert" | "delete";
  table?: unknown;
  values?: unknown;
}

/** Query double: every awaited query takes the next queued result (default: no rows). */
const createDouble = (outcomes: (unknown[] | Error)[] = []) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    operations.push(operation);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        operation.table = table;
        return chain;
      },
      limit: () => chain,
      onConflictDoNothing: () => {
        operation.conflict = "nothing";
        return chain;
      },
      onConflictDoUpdate: () => {
        operation.conflict = "update";
        return chain;
      },
      orderBy: () => chain,
      returning: () => chain,
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (error: unknown) => unknown
      ) => {
        const next = outcomes.shift() ?? [];
        return (
          next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
        ).then(resolve, reject);
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  const database = {
    delete: (table: unknown) => builder({ kind: "delete", table }),
    insert: (table: unknown) => builder({ kind: "insert", table }),
    select: () => builder({ kind: "select" }),
    transaction: (work: (transaction: unknown) => Promise<unknown>) =>
      work(database),
  };
  return { database: database as unknown as DatabaseExecutor, operations };
};

const hex = (digit: string) => digit.repeat(64);

const revision = (
  reportId: string,
  dataRevision: string,
  edit: (datasets: ResearchRevisionInput["datasets"][number][]) => void = () =>
    undefined
): ResearchRevisionInput => {
  const datasets = RESEARCH_REPORT_DATASETS.map((dataset) => ({
    body: dataset === "portfolio" ? null : "{}\n",
    byteLength: 3,
    dataset,
    sha256: hex("c"),
  }));
  edit(datasets);
  return { dataRevision, datasets, reportId, source: "revision" };
};

const validImport = (): ResearchCatalogImport => ({
  categories: [
    {
      description: "d",
      id: "group",
      label: "Group",
      reportIds: ["AAA"],
      sourceIds: ["s"],
    },
  ],
  companyResearch: [{ body: "{}", reportId: "AAA", revision: hex("e") }],
  reports: [
    {
      assetType: "equity",
      companyResearch: {
        acceptedAt: new Date("2026-01-02T00:00:00Z"),
        reportRevision: hex("a"),
        revision: hex("e"),
      },
      dataRevision: hex("a"),
      id: "AAA",
      identityStatus: "verified",
      metadata: { id: "AAA" },
      name: "Fixture A",
      providerSymbol: "AAA",
      sourceUpdatedAt: null,
      status: "ready",
      symbol: "AAA",
    },
    {
      assetType: null,
      companyResearch: null,
      dataRevision: hex("b"),
      id: "BBB",
      identityStatus: "verified",
      metadata: {},
      name: "Fixture B",
      providerSymbol: "BBB",
      sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      status: "ready",
      symbol: "BBB",
    },
  ],
  revisions: [revision("AAA", hex("a")), revision("BBB", hex("b"))],
});

const invalid = (
  edit: (input: ResearchCatalogImport) => ResearchCatalogImport,
  message: RegExp
) => {
  expect(() => validateResearchCatalogImport(edit(validImport()))).toThrow(
    message
  );
  expect(() => validateResearchCatalogImport(edit(validImport()))).toThrow(
    ResearchReportsInputError
  );
};

describe("validateResearchCatalogImport", () => {
  it("accepts a consistent import", () => {
    expect(() => validateResearchCatalogImport(validImport())).not.toThrow();
  });

  it("checks reports", () => {
    invalid((input) => ({ ...input, reports: [] }), /no reports/u);
    invalid(
      (input) => ({
        ...input,
        reports: input.reports.map((report) => ({ ...report, id: "lower" })),
      }),
      /must match/u
    );
    invalid(
      (input) => ({
        ...input,
        reports: [...input.reports, ...input.reports],
      }),
      /duplicate report AAA/u
    );
    invalid(
      (input) => ({
        ...input,
        reports: input.reports.map((report) => ({
          ...report,
          dataRevision: "x",
        })),
      }),
      /dataRevision must be 64 hex/u
    );
  });

  it("checks revisions and their seven datasets", () => {
    invalid(
      (input) => ({ ...input, revisions: [revision("ZZZ", hex("a"))] }),
      /revision for unknown report ZZZ/u
    );
    invalid(
      (input) => ({ ...input, revisions: [revision("AAA", "short")] }),
      /revision token must be 64 hex/u
    );
    invalid(
      (input) => ({
        ...input,
        revisions: [...input.revisions, revision("AAA", hex("a"))],
      }),
      /duplicate revision AAA/u
    );
    invalid(
      (input) => ({
        ...input,
        revisions: [revision("AAA", hex("a"), (sets) => sets.pop())],
      }),
      /seven datasets/u
    );
    invalid(
      (input) => ({
        ...input,
        revisions: [
          revision("AAA", hex("a"), (sets) => {
            const first = sets[0];
            if (first !== undefined) sets[1] = { ...first };
          }),
        ],
      }),
      /seven datasets/u
    );
    for (const change of [
      { sha256: "bad" },
      { byteLength: -1 },
      { byteLength: 1.5 },
    ]) {
      invalid(
        (input) => ({
          ...input,
          revisions: [
            revision("AAA", hex("a"), (sets) => {
              const first = sets[0];
              if (first !== undefined) sets[0] = { ...first, ...change };
            }),
          ],
        }),
        /invalid digest, length or body/u
      );
    }
    invalid(
      (input) => ({
        ...input,
        revisions: [
          revision("AAA", hex("a"), (sets) => {
            const index = sets.findIndex((set) => set.dataset === "portfolio");
            const portfolio = sets[index];
            if (portfolio !== undefined)
              sets[index] = { ...portfolio, body: "{}" };
          }),
        ],
      }),
      /portfolio bodies are never stored/u
    );
    invalid(
      (input) => ({
        ...input,
        revisions: [
          revision("AAA", hex("a"), (sets) => {
            const first = sets[0];
            if (first !== undefined) sets[0] = { ...first, body: null };
          }),
        ],
      }),
      /invalid digest, length or body/u
    );
  });

  it("checks company research entries and ownership", () => {
    invalid(
      (input) => ({
        ...input,
        companyResearch: [{ body: "{}", reportId: "aaa", revision: hex("e") }],
      }),
      /company research aaa\/e{64} is invalid/u
    );
    invalid(
      (input) => ({
        ...input,
        companyResearch: [...input.companyResearch, ...input.companyResearch],
      }),
      /duplicate company research/u
    );
    invalid(
      (input) => ({
        ...input,
        companyResearch: [{ body: "{}", reportId: "BBB", revision: hex("e") }],
      }),
      /AAA: accepted company research body is missing/u
    );
  });

  it("checks references between reports, research and categories", () => {
    invalid(
      (input) => ({
        ...input,
        companyResearch: [{ body: "{}", reportId: "AAA", revision: "x" }],
      }),
      /company research AAA\/x is invalid/u
    );
    invalid(
      (input) => ({ ...input, revisions: [revision("AAA", hex("a"))] }),
      /BBB: current revision b{64} is missing/u
    );
    invalid(
      (input) => ({ ...input, companyResearch: [] }),
      /AAA: accepted company research body is missing/u
    );
    invalid(
      (input) => ({
        ...input,
        categories: [
          {
            description: "",
            id: "group",
            label: "G",
            reportIds: ["ZZZ"],
            sourceIds: [],
          },
        ],
      }),
      /category group: unknown ZZZ/u
    );
  });
});

describe("createResearchReportsRepository", () => {
  it("replaces the catalog and adds only new revisions in one transaction", async () => {
    const { database, operations } = createDouble([
      [{ id: "OLD" }], // delete reports not in the catalog
      [], // upsert AAA
      [], // upsert BBB
      [], // delete categories
      [], // insert categories
      [{ dataRevision: hex("a") }], // revision AAA is new
      [], // AAA datasets
      [], // revision BBB already stored ...
      [{ source: "revision" }], // ... with the same source
      RESEARCH_REPORT_DATASETS.map((dataset) => ({
        byteLength: 3,
        dataset,
        sha256: hex("c"),
      })), // ... and the same datasets
      [{ revision: hex("e") }], // company research
      [{ reportId: "AAA", revision: hex("e") }], // accepted head owner
      [{ n: 2 }], // counts: datasets aggregate is read first
      [{ n: 1 }],
      [{ n: 1 }],
      [{ n: 1 }],
      [{ n: 2 }],
      [{ n: 2 }],
    ]);
    const at = new Date("2026-02-01T00:00:00Z");
    const repository = createResearchReportsRepository(database, () => at);
    const result = await repository.replaceCatalog(validImport(), {
      allowRemoval: true,
    });
    expect(result).toMatchObject({
      companyResearchAdded: 1,
      datasetsAdded: 7,
      reportsRemoved: 1,
      revisionsAdded: 1,
    });
    const upserts = operations.filter(
      (operation) =>
        operation.table === researchReports && operation.kind === "insert"
    );
    expect(upserts.map((operation) => operation.conflict)).toEqual([
      "update",
      "update",
    ]);
    expect(upserts[0]?.values).toMatchObject({
      companyResearchReportRevision: hex("a"),
      importedAt: at,
      position: 0,
    });
    expect(upserts[1]?.values).toMatchObject({
      companyResearchAcceptedAt: null,
      companyResearchRevision: null,
      position: 1,
    });
    const datasets = operations.find(
      (operation) => operation.table === researchReportDatasets
    );
    expect(datasets?.values).toHaveLength(7);
    expect(
      operations.filter(
        (operation) =>
          operation.table === researchReportRevisions &&
          operation.kind === "insert"
      )
    ).toHaveLength(2);
    expect(
      operations.find(
        (operation) =>
          operation.table === researchReportCategories &&
          operation.kind === "insert"
      )?.values
    ).toEqual([
      {
        description: "d",
        id: "group",
        label: "Group",
        position: 0,
        reportIds: ["AAA"],
        sourceIds: ["s"],
      },
    ]);
    expect(
      operations.find(
        (operation) => operation.table === researchCompanyResearch
      )?.conflict
    ).toBe("nothing");
  });

  it("skips the category insert when there are none and refuses invalid input", async () => {
    // catalog writes, then both revisions are new (each followed by its dataset insert).
    const { database, operations } = createDouble([
      [],
      [],
      [],
      [],
      [{ dataRevision: hex("a") }],
      [],
      [{ dataRevision: hex("b") }],
    ]);
    const repository = createResearchReportsRepository(database);
    const result = await repository.replaceCatalog({
      ...validImport(),
      categories: [],
      companyResearch: [],
      reports: validImport().reports.map((report) => ({
        ...report,
        companyResearch: null,
      })),
    });
    expect(result.counts).toEqual({
      acceptedCompanyResearch: 0,
      categories: 0,
      companyResearch: 0,
      datasets: 0,
      privateDatasets: 0,
      reports: 0,
      revisions: 0,
    });
    expect(
      operations.some(
        (operation) =>
          operation.table === researchReportCategories &&
          operation.kind === "insert"
      )
    ).toBe(false);
    await expect(
      repository.replaceCatalog({ ...validImport(), reports: [] })
    ).rejects.toBeInstanceOf(ResearchReportsInputError);
  });

  it("refuses removals without allowRemoval and a stored revision that differs", async () => {
    await expect(
      createResearchReportsRepository(
        createDouble([[{ id: "OLD" }]]).database
      ).replaceCatalog(validImport())
    ).rejects.toThrow(/1 stored report\(s\) are not in the catalog/u);
    const conflict = (stored: unknown[][]) =>
      createResearchReportsRepository(
        createDouble([[], [], [], [], [], [], ...stored]).database
      ).replaceCatalog(validImport());
    await expect(conflict([[{ source: "flat" }], []])).rejects.toThrow(
      /AAA\/a{64}: stored revision differs/u
    );
    await expect(conflict([[], []])).rejects.toBeInstanceOf(
      ResearchReportsInputError
    );
    await expect(
      conflict([
        [{ source: "revision" }],
        [{ byteLength: 4, dataset: "market", sha256: hex("c") }],
      ])
    ).rejects.toThrow(/stored revision differs/u);
  });

  it("refuses an accepted head stored for another report", async () => {
    const heads = (stored: unknown[]) =>
      createResearchReportsRepository(
        createDouble([
          [],
          [],
          [],
          [],
          [],
          [{ dataRevision: hex("a") }],
          [],
          [{ dataRevision: hex("b") }],
          [],
          [],
          stored,
        ]).database
      ).replaceCatalog(validImport());
    await expect(
      heads([{ reportId: "BBB", revision: hex("e") }])
    ).rejects.toThrow(
      /AAA: accepted company research e{64} is stored for another report/u
    );
    await expect(heads([])).rejects.toBeInstanceOf(ResearchReportsInputError);
  });

  it("maps Postgres read failures to DatabasePersistenceError", async () => {
    const pgError = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const reads = createResearchReportsRepository(
      createDouble([pgError, new Error("bug")]).database
    );
    await expect(reads.listCatalog()).rejects.toBeInstanceOf(
      DatabasePersistenceError
    );
    await expect(reads.getReport("AAA")).rejects.toThrow("bug");
  });

  it("reads reports, revisions, datasets and company research", async () => {
    const report = { id: "AAA" };
    const dataset = { body: "{}", dataset: "market" };
    const research = { body: "{}", reportId: "AAA", revision: hex("e") };
    const { database } = createDouble([
      [{ id: "group" }],
      [report],
      [report],
      [],
      [{ dataRevision: hex("a") }, { dataRevision: hex("b") }],
      [dataset],
      [],
      [research],
      [],
      [{ all: 14, hidden: 2 }],
      [{ n: 3 }],
      [{ n: 1 }],
      [{ n: 4 }],
      [{ n: 2 }],
      [{ n: 5 }],
    ]);
    const repository = createResearchReportsRepository(database);
    expect(await repository.listCatalog()).toEqual({
      categories: [{ id: "group" }],
      reports: [report],
    });
    expect(await repository.getReport("AAA")).toEqual(report);
    expect(await repository.getReport("ZZZ")).toBeNull();
    expect(await repository.listRevisions("AAA")).toEqual([hex("a"), hex("b")]);
    expect(await repository.getDataset("AAA", hex("a"), "market")).toEqual(
      dataset
    );
    expect(await repository.getDataset("AAA", hex("b"), "market")).toBeNull();
    expect(await repository.getCompanyResearch(hex("e"))).toEqual(research);
    expect(await repository.getCompanyResearch(hex("f"))).toBeNull();
    expect(await repository.counts()).toEqual({
      acceptedCompanyResearch: 3,
      categories: 1,
      companyResearch: 4,
      datasets: 14,
      privateDatasets: 2,
      reports: 2,
      revisions: 5,
    });
  });
});
