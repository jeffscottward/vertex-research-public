import { researchStudies } from "@darkfactory/db/schema";
import {
  createNodeDatabase,
  createResearchStudyRepository,
  type Database,
  InvalidRepositoryInputError,
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

describe("research study repository (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
  }, 60_000);

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("seeds the ADX/RVOL study", async () => {
    const seeded = await createResearchStudyRepository(database()).get(
      "adx-rvol-filters"
    );
    expect(seeded).toMatchObject({
      id: "adx-rvol-filters",
      ranOn: "2026-10-31",
      specRef: "docs/specs/research/adx-filter.md",
      summary: { id: "adx-rvol-filters", ran: "2026-10-31" },
    });
    expect(seeded?.createdAt.getTime()).toBe(seeded?.updatedAt.getTime());
  });

  it("inserts, replaces and reads studies; checks reject a mismatched document", async () => {
    const repository = createResearchStudyRepository(database());
    const summary = {
      id: "demo-study",
      ran: "2026-11-01",
      spec: "docs/specs/demo.md",
      v: 1,
    };
    const first = await repository.upsert({
      id: "demo-study",
      ranOn: "2026-11-01",
      specRef: "docs/specs/demo.md",
      summary,
    });
    expect(first.created).toBe(true);
    const second = await repository.upsert({
      id: "demo-study",
      ranOn: "2026-11-02",
      specRef: "docs/specs/demo.md",
      summary: { ...summary, ran: "2026-11-02", v: 2 },
    });
    expect(second.created).toBe(false);
    expect(await repository.get("demo-study")).toMatchObject({
      ranOn: "2026-11-02",
      summary: { v: 2 },
    });
    await expect(repository.get("missing")).resolves.toBeNull();
    await expect(
      repository.upsert({
        id: "other-study",
        ranOn: "2026-11-01",
        specRef: "docs/specs/demo.md",
        summary,
      })
    ).rejects.toThrow(InvalidRepositoryInputError);
    await expect(
      repository.upsert({
        id: "Bad Id",
        ranOn: "2026-11-01",
        specRef: "docs/specs/demo.md",
        summary: { ...summary, id: "Bad Id" },
      })
    ).rejects.toThrow(/research_studies_fields_check/u);
    const row = {
      id: "gap-study",
      ranOn: "2026-11-01",
      specRef: "docs/specs/demo.md",
    };
    for (const summary of [
      {},
      { id: "gap-study", ran: "2026-11-01" },
      { id: "gap-study", ran: "2026-11-02", spec: "docs/specs/demo.md" },
      { id: "gap-study", spec: "docs/specs/demo.md" },
    ])
      await expect(repository.upsert({ ...row, summary })).rejects.toThrow(
        /research_studies_summary_check/u
      );
    await expect(
      repository.upsert({
        ...row,
        ranOn: "2026-02-30",
        summary: {
          id: "gap-study",
          ran: "2026-02-30",
          spec: "docs/specs/demo.md",
        },
      })
    ).rejects.toThrow("research study has an invalid date");
    await expect(
      repository.upsert({
        ...row,
        summary: {
          id: "gap-study",
          pad: "x".repeat(330_000),
          ran: "2026-11-01",
          spec: "docs/specs/demo.md",
        },
      })
    ).rejects.toThrow(/research_studies_summary_check/u);
    expect(await database().select().from(researchStudies)).toHaveLength(2);
  });

  it("upsertMany stores every study in one transaction, or none when one fails", async () => {
    const repository = createResearchStudyRepository(database());
    const study = (id: string) => ({
      id,
      ranOn: "2026-11-08",
      specRef: `docs/specs/strategies/${id}.md`,
      summary: {
        id,
        kind: "qc-port",
        ran: "2026-11-08",
        spec: `docs/specs/strategies/${id}.md`,
      },
    });
    const before = (await database().select().from(researchStudies)).length;
    await expect(
      repository.upsertMany([
        study("qc-batch-one"),
        { ...study("qc-batch-two"), specRef: "docs/specs/strategies/other.md" },
      ])
    ).rejects.toThrow(/research_studies_summary_check/u);
    await expect(repository.get("qc-batch-one")).resolves.toBeNull();
    const stored = await repository.upsertMany([
      study("qc-batch-one"),
      study("qc-batch-two"),
    ]);
    expect(stored.map((row) => [row.id, row.created])).toEqual([
      ["qc-batch-one", true],
      ["qc-batch-two", true],
    ]);
    const replaced = await repository.upsertMany([study("qc-batch-two")]);
    expect(replaced[0]?.created).toBe(false);
    expect(await database().select().from(researchStudies)).toHaveLength(
      before + 2
    );
  });
});
