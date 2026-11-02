import {
  type AutopilotCandidateInput,
  createAutopilotRepository,
  createNodeDatabase,
  createRepositories,
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
    return `ap-${next}`;
  },
  now: () => new Date(Date.UTC(2026, 9, 30, 12, 0, next)),
};

const candidate = (
  campaignId: string,
  id: string,
  key: string,
  fitness: number | null,
  parentIds: string[] = []
): AutopilotCandidateInput => ({
  campaignId,
  definition: { version: 1 },
  firstT: new Date("2015-01-02T00:00:00.000Z"),
  fitness,
  generation: 0,
  genome: { entry: [] },
  genomeKey: key,
  id,
  inSample: { trades: 3 },
  label: key,
  lastT: new Date("2021-01-04T00:00:00.000Z"),
  origin: parentIds.length === 0 ? "random" : "crossover",
  parentIds,
  returnsCount: 1500,
  returnsMean: 0.0004,
  returnsStd: 0.01,
  series: "SPY/1d",
});

describe("autopilot campaigns and candidates on real Postgres", {
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

  it("guards the campaign lifecycle and saves progress only for the version it read", async () => {
    const repository = createAutopilotRepository(
      databaseResource.db,
      dependencies
    );
    expect(createRepositories(databaseResource.db).autopilot).toBeDefined();
    const campaign = await repository.createCampaign({
      config: { populationSize: 10 },
      createdBy: "operator",
      name: "SPY daily",
      symbol: "SPY",
      timeframe: "1d",
    });
    expect(campaign.status).toBe("running");
    expect(campaign.version).toBe(0);
    expect((await repository.dueCampaigns(5)).map((row) => row.id)).toEqual([
      campaign.id,
    ]);

    const inserted = await repository.insertCandidates([
      candidate(campaign.id, "c1", "k1", 1.2),
      candidate(campaign.id, "c2", "k2", 0.4),
      candidate(campaign.id, "c3", "k3", null),
    ]);
    expect(inserted).toEqual(["c1", "c2", "c3"]);
    // Same genome again: skipped, not a second trial.
    expect(
      await repository.insertCandidates([
        candidate(campaign.id, "c4", "k1", 9),
        candidate(campaign.id, "c5", "k5", -0.1, ["c1", "c2"]),
      ])
    ).toEqual(["c5"]);
    expect(await repository.insertCandidates([])).toEqual([]);
    expect((await repository.campaignKeys(campaign.id)).sort()).toEqual([
      "k1",
      "k2",
      "k3",
      "k5",
    ]);
    expect(
      (await repository.population(campaign.id, 10)).map((row) => row.id)
    ).toEqual(["c1", "c2", "c5"]);
    expect(
      (await repository.ungated(campaign.id, 10)).map((row) => row.id)
    ).toEqual(["c1", "c2"]);

    const gated = await repository.recordGate({
      gate: { curve: [{ t: "x", equity: 1 }], passed: true },
      id: "c1",
      oosSharpe: 0.9,
      status: "verified",
    });
    expect(gated?.status).toBe("verified");
    expect(
      await repository.recordGate({
        gate: {},
        id: "c1",
        oosSharpe: null,
        status: "rejected",
      })
    ).toBeNull();
    await repository.recordGate({
      gate: { passed: false },
      id: "c2",
      oosSharpe: -1,
      status: "rejected",
    });

    const progressed = await repository.recordProgress({
      cpuMs: 1234.4,
      generation: 1,
      id: campaign.id,
      note: null,
      status: "running",
      version: 0,
    });
    expect(progressed).toMatchObject({
      bestCandidateId: "c1",
      bestFitness: 1.2,
      candidateCount: 4,
      cpuMs: 1234,
      gatedCount: 2,
      generation: 1,
      verifiedCount: 1,
      version: 1,
    });
    // Stale version: refused.
    expect(
      await repository.recordProgress({
        cpuMs: 1,
        generation: 2,
        id: campaign.id,
        note: null,
        status: "running",
        version: 0,
      })
    ).toBeNull();

    const verifiedRows = await repository.listCandidates({
      campaignId: campaign.id,
      limit: 10,
      order: "fitness",
      status: "verified",
    });
    expect(verifiedRows.map((row) => row.id)).toEqual(["c1"]);
    expect(verifiedRows[0]?.gate).toEqual({ passed: true });
    expect(
      (
        await repository.listCandidates({
          campaignId: campaign.id,
          limit: 10,
          order: "recent",
        })
      ).map((row) => row.id)
    ).toEqual(["c5", "c3", "c2", "c1"]);
    expect((await repository.children("c1", 10)).map((row) => row.id)).toEqual([
      "c5",
    ]);
    expect(
      (await repository.getCandidates(["c1", "c5"])).map((row) => row.id).sort()
    ).toEqual(["c1", "c5"]);
    expect(await repository.getCandidates([])).toEqual([]);
    expect((await repository.getCandidate("c1"))?.gate).toMatchObject({
      curve: [{ t: "x" }],
    });
    expect(await repository.getCandidate("missing")).toBeNull();

    const ledger = await repository.ledger({
      excludeId: "c1",
      sample: 2,
      series: "SPY/1d",
    });
    expect(ledger.total).toBe(4);
    expect(ledger.others.map((row) => row.id)).toEqual(["c5", "c3"]);
    expect(ledger.others[0]).toMatchObject({
      meanReturn: 0.0004,
      returns: 1500,
      stdReturn: 0.01,
    });

    expect(
      await repository.recordHandoff({
        deploymentRequestId: "d1",
        id: "c2",
        strategyId: "s1",
      })
    ).toBeNull();
    expect(
      (
        await repository.recordHandoff({
          deploymentRequestId: "d1",
          id: "c1",
          strategyId: "s1",
        })
      )?.deploymentRequestId
    ).toBe("d1");
    expect(
      await repository.recordHandoff({
        deploymentRequestId: "d2",
        id: "c1",
        strategyId: "s1",
      })
    ).toBeNull();

    const stopped = await repository.transitionCampaign({
      id: campaign.id,
      to: "stopped",
    });
    expect(stopped?.status).toBe("stopped");
    expect(
      await repository.transitionCampaign({ id: campaign.id, to: "completed" })
    ).toBeNull();
    expect(await repository.dueCampaigns(5)).toEqual([]);
    const restarted = await repository.transitionCampaign({
      id: campaign.id,
      note: null,
      to: "running",
    });
    expect(restarted?.status).toBe("running");
    const done = await repository.recordProgress({
      cpuMs: 0,
      generation: 2,
      id: campaign.id,
      note: "Candidate budget used",
      status: "completed",
      version: restarted?.version ?? -1,
    });
    expect(done?.status).toBe("completed");
    expect(done?.finishedAt).not.toBeNull();
    expect(
      await repository.transitionCampaign({ id: campaign.id, to: "running" })
    ).toBeNull();
    expect((await repository.listCampaigns(10)).map((row) => row.id)).toEqual([
      campaign.id,
    ]);
    expect(await repository.getCampaign("missing")).toBeNull();
  });
});
