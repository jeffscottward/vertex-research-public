import {
  createNodeDatabase,
  createResearchReportsRepository,
  type Database,
  ResearchReportsInputError,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadResearchCatalog } from "../../../scripts/research-reports/load.ts";
import {
  FIXTURE_ROOT,
  researchFixture,
} from "../../../scripts/research-reports/test-fixtures.ts";

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

describe("research reports repository (Postgres)", () => {
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
      if (testDatabase !== undefined) {
        await dropPostgresTestDatabase(testDatabase);
      }
    }
  });

  it("imports the fixture, stays idempotent and keeps exact bytes", async () => {
    const fixture = researchFixture();
    const input = await loadResearchCatalog(FIXTURE_ROOT, fixture.fs);
    const repository = createResearchReportsRepository(database());

    const first = await repository.replaceCatalog(input);
    expect(first).toMatchObject({
      companyResearchAdded: 3,
      datasetsAdded: 21,
      reportsRemoved: 0,
      revisionsAdded: 3,
    });
    expect(first.counts).toEqual({
      acceptedCompanyResearch: 2,
      categories: 1,
      companyResearch: 3,
      datasets: 21,
      privateDatasets: 3,
      reports: 2,
      revisions: 3,
    });

    const second = await repository.replaceCatalog(input);
    expect(second).toMatchObject({
      companyResearchAdded: 0,
      datasetsAdded: 0,
      revisionsAdded: 0,
    });
    expect(second.counts).toEqual(first.counts);

    // Stored text hashes back to the stored digest (the importer's byte-exact rule).
    const mismatches = await postgres().query(
      "select count(*)::int as n from research_report_datasets where body is not null and encode(sha256(convert_to(body, 'UTF8')), 'hex') <> sha256"
    );
    expect(mismatches[0]).toEqual({ n: 0 });

    const catalog = await repository.listCatalog();
    expect(catalog.reports.map((report) => report.id)).toEqual(["FLAT", "TWO"]);
    expect(catalog.categories[0]?.reportIds).toEqual(["FLAT", "TWO"]);
    expect(await repository.listRevisions("TWO")).toEqual(
      [fixture.tokens.older, fixture.tokens.current].sort()
    );
    expect(await repository.getReport("TWO")).toMatchObject({
      companyResearchRevision: fixture.research.two,
      dataRevision: fixture.tokens.current,
    });
    expect(await repository.getReport("NONE")).toBeNull();
    const market = await repository.getDataset(
      "TWO",
      fixture.tokens.current,
      "market"
    );
    expect(market?.body).toBe(
      new TextDecoder().decode(
        fixture.files.get(
          `${FIXTURE_ROOT}/reports/TWO/revisions/${fixture.tokens.current}/market.json`
        )
      )
    );
    const portfolio = await repository.getDataset(
      "TWO",
      fixture.tokens.current,
      "portfolio"
    );
    expect(portfolio?.body).toBeNull();
    expect(
      await repository.getDataset("TWO", "0".repeat(64), "market")
    ).toBeNull();
    expect(
      await repository.getCompanyResearch(fixture.research.flat)
    ).toMatchObject({ reportId: "FLAT" });
    expect(await repository.getCompanyResearch("0".repeat(64))).toBeNull();
  });

  it("removes reports that left the catalog and refuses an inconsistent import", async () => {
    const fixture = researchFixture();
    const input = await loadResearchCatalog(FIXTURE_ROOT, fixture.fs);
    const repository = createResearchReportsRepository(database());
    const changed = input.revisions.map((revision) =>
      revision.reportId === "TWO"
        ? {
            ...revision,
            datasets: revision.datasets.map((entry) =>
              entry.dataset === "news" ? { ...entry, byteLength: 1 } : entry
            ),
          }
        : revision
    );
    await expect(
      repository.replaceCatalog({ ...input, revisions: changed })
    ).rejects.toThrow(/stored revision differs/u);
    const onlyTwo = {
      categories: [],
      companyResearch: input.companyResearch,
      reports: input.reports.filter((report) => report.id === "TWO"),
      revisions: input.revisions.filter(
        (revision) => revision.reportId === "TWO"
      ),
    };
    await expect(repository.replaceCatalog(onlyTwo)).rejects.toThrow(
      /not in the catalog/u
    );
    expect((await repository.counts()).reports).toBe(2);
    const result = await repository.replaceCatalog(onlyTwo, {
      allowRemoval: true,
    });
    expect(result.reportsRemoved).toBe(1);
    expect(result.counts).toMatchObject({
      categories: 0,
      datasets: 14,
      reports: 1,
      revisions: 2,
    });
    await expect(
      repository.replaceCatalog({ ...input, reports: [] })
    ).rejects.toBeInstanceOf(ResearchReportsInputError);
  });

  it("refuses a stored portfolio body at the database", async () => {
    await expect(
      postgres().query(
        "update research_report_datasets set body = '{}' where dataset = 'portfolio'"
      )
    ).rejects.toThrow();
  });
});
