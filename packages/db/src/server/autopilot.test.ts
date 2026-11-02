import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_CANDIDATE_LIST_MAX,
  autopilotTransitionSources,
  createAutopilotRepository,
} from "./autopilot.ts";
import type { Database } from "./client.ts";

const NOW = new Date("2026-10-30T12:00:00.000Z");

interface Operation {
  kind: string;
  values?: unknown;
  set?: Record<string, unknown>;
  limit?: number;
  conflict?: unknown;
}

// Query-builder double: records each operation and resolves the next queued outcome.
const createDouble = (outcomes: Array<readonly unknown[]>) => {
  const operations: Operation[] = [];
  const builder = (operation: Operation) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (count: number) => {
        operation.limit = count;
        return chain;
      },
      values: (values: unknown) => {
        operation.values = values;
        return chain;
      },
      set: (values: Record<string, unknown>) => {
        operation.set = values;
        return chain;
      },
      onConflictDoNothing: (config: unknown) => {
        operation.conflict = config;
        return chain;
      },
      returning: () => chain,
      then: (resolve: (rows: unknown) => unknown) =>
        Promise.resolve(outcomes.shift() ?? []).then(resolve),
    };
    operations.push(operation);
    return chain;
  };
  const database = {
    select: () => builder({ kind: "select" }),
    insert: () => builder({ kind: "insert" }),
    update: () => builder({ kind: "update" }),
  } as unknown as Database;
  return { database, operations };
};

const repositoryWith = (outcomes: Array<readonly unknown[]>) => {
  const double = createDouble(outcomes);
  let id = 0;
  const repository = createAutopilotRepository(double.database, {
    generateId: () => {
      id += 1;
      return `id-${id}`;
    },
    now: () => NOW,
  });
  return { ...double, repository };
};

const input = {
  campaignId: "camp",
  definition: {},
  firstT: NOW,
  fitness: 1,
  generation: 0,
  genome: {},
  genomeKey: "k",
  id: "c1",
  inSample: {},
  label: "k",
  lastT: NOW,
  origin: "random" as const,
  parentIds: ["p"],
  returnsCount: 1,
  returnsMean: 0,
  returnsStd: 0,
  series: "SPY/1d",
};

describe("autopilot repository", () => {
  it("lists the allowed transitions", () => {
    expect(autopilotTransitionSources("running")).toEqual(["stopped"]);
    expect(autopilotTransitionSources("stopped")).toEqual(["running"]);
    expect(autopilotTransitionSources("completed")).toEqual(["running"]);
    expect(autopilotTransitionSources("failed")).toEqual(["running"]);
  });

  it("creates a running campaign", async () => {
    const { repository, operations } = repositoryWith([[{ id: "id-1" }]]);
    await repository.createCampaign({
      config: {},
      createdBy: "op",
      name: "A",
      symbol: "SPY",
      timeframe: "1d",
    });
    expect(operations[0]?.values).toMatchObject({
      id: "id-1",
      startedAt: NOW,
      status: "running",
    });
  });

  it("reads campaigns and candidates", async () => {
    const { repository, operations } = repositoryWith([
      [{ id: "a" }],
      [],
      [{ id: "a" }],
      [{ key: "k" }],
      [{ id: "c" }],
      [{ id: "c" }],
      [{ id: "c" }],
      [],
      [{ id: "c" }],
      [{ id: "c" }],
      [{ id: "c" }],
      [{ id: "c" }],
    ]);
    expect(await repository.listCampaigns(1e6)).toEqual([{ id: "a" }]);
    expect(await repository.getCampaign("x")).toBeNull();
    expect(await repository.dueCampaigns(0)).toEqual([{ id: "a" }]);
    expect(await repository.campaignKeys("camp")).toEqual(["k"]);
    expect(await repository.population("camp", 5)).toEqual([{ id: "c" }]);
    expect(await repository.ungated("camp", 5)).toEqual([{ id: "c" }]);
    expect(await repository.getCandidate("c")).toEqual({ id: "c" });
    expect(await repository.getCandidate("missing")).toBeNull();
    expect(await repository.getCandidates([])).toEqual([]);
    expect(await repository.getCandidates(["c"])).toEqual([{ id: "c" }]);
    expect(
      await repository.listCandidates({
        campaignId: "camp",
        limit: 3,
        order: "fitness",
        status: "verified",
      })
    ).toEqual([{ id: "c" }]);
    expect(
      await repository.listCandidates({
        campaignId: "camp",
        limit: 3,
        order: "recent",
      })
    ).toEqual([{ id: "c" }]);
    expect(await repository.children("c", 2)).toEqual([{ id: "c" }]);
    expect(operations[0]?.limit).toBe(100);
    expect(operations[2]?.limit).toBe(1);
  });

  it("inserts candidates and skips known genomes", async () => {
    const { repository, operations } = repositoryWith([[{ id: "c1" }]]);
    expect(await repository.insertCandidates([])).toEqual([]);
    expect(await repository.insertCandidates([input])).toEqual(["c1"]);
    expect(operations[0]?.values).toEqual([
      { ...input, createdAt: NOW, status: "evaluated" },
    ]);
    expect(operations[0]?.conflict).toBeDefined();
  });

  it("reads the trial ledger", async () => {
    const { repository, operations } = repositoryWith([
      [{ total: "7" }],
      [{ id: "c2" }],
    ]);
    expect(
      await repository.ledger({
        excludeId: "c1",
        sample: 1e9,
        series: "SPY/1d",
      })
    ).toEqual({
      others: [{ id: "c2" }],
      total: 7,
    });
    expect(operations[1]?.limit).toBe(2000);
    const empty = repositoryWith([[], []]);
    expect(
      (
        await empty.repository.ledger({
          excludeId: "c1",
          sample: 5,
          series: "S/1d",
        })
      ).total
    ).toBe(0);
  });

  it("records gates, hand-offs, progress and transitions", async () => {
    const { repository, operations } = repositoryWith([
      [{ id: "c" }],
      [],
      [{ id: "c" }],
      [{ id: "camp" }],
      [{ id: "camp" }],
      [{ id: "camp" }],
      [{ id: "camp" }],
      [{ id: "camp" }],
    ]);
    expect(
      await repository.recordGate({
        gate: {},
        id: "c",
        oosSharpe: 1,
        status: "verified",
      })
    ).toEqual({ id: "c" });
    expect(
      await repository.recordHandoff({
        deploymentRequestId: "d",
        id: "c",
        strategyId: "s",
      })
    ).toBeNull();
    expect(
      await repository.recordHandoff({
        deploymentRequestId: "d",
        id: "c",
        strategyId: "s",
      })
    ).toEqual({ id: "c" });
    await repository.recordProgress({
      cpuMs: 5,
      generation: 1,
      id: "camp",
      note: null,
      status: "running",
      version: 0,
    });
    expect(operations[3]?.set).not.toHaveProperty("finishedAt");
    await repository.recordProgress({
      cpuMs: -5,
      generation: 2,
      id: "camp",
      note: "done",
      status: "completed",
      version: 1,
    });
    expect(operations[4]?.set).toMatchObject({
      finishedAt: NOW,
      status: "completed",
    });
    await repository.transitionCampaign({ id: "camp", to: "running" });
    expect(operations[5]?.set).toMatchObject({
      startedAt: NOW,
      status: "running",
    });
    expect(operations[5]?.set).not.toHaveProperty("note");
    await repository.transitionCampaign({
      id: "camp",
      note: "stopped by operator",
      to: "stopped",
    });
    expect(operations[6]?.set).toMatchObject({ note: "stopped by operator" });
    expect(operations[6]?.set).not.toHaveProperty("finishedAt");
    await repository.transitionCampaign({
      id: "camp",
      note: "x",
      to: "failed",
    });
    expect(operations[7]?.set).toMatchObject({
      finishedAt: NOW,
      status: "failed",
    });
    expect(AUTOPILOT_CANDIDATE_LIST_MAX).toBe(500);
  });
});
