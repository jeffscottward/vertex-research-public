import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApiClient } from "@darkfactory/api/client";
import type { AgentRun, VertexContinuityRead } from "@darkfactory/api/vertex";
import { hashArtifact } from "@darkfactory/shared/vertex";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import type {
  ImmutableArtifact,
  ResearchProposalCommand,
  ReviewDecisionCommand,
  SimulationProposalCommand,
} from "./ports.ts";
import {
  createExperienceScopeLoader,
  createExperienceServices,
} from "./transport.ts";

const scope = { accountAlias: "account-a", environment: "research" } as const;
const signal = () => new AbortController().signal;
const unavailable = {
  status: "unavailable",
  reason: "source-unavailable",
  executionAuthorized: false,
} as const;
const wireError = (code = "SERVICE_UNAVAILABLE", status = 503) => ({
  defined: true,
  code,
  status,
  message: "private upstream details",
  data: { private: "must not escape" },
});
const fixture = () => {
  const missing = async (): Promise<unknown> => {
    throw wireError();
  };
  const api = {
    scopes: vi.fn(missing),
    portfolio: vi.fn(missing),
    continuity: vi.fn(missing),
    inbox: vi.fn(missing),
    strategies: vi.fn(missing),
    dossier: vi.fn(missing),
    agents: vi.fn(missing),
    agent: vi.fn(missing),
    audit: vi.fn(missing),
    gateway: vi.fn(missing),
    gateways: vi.fn(missing),
    decideReview: vi.fn(missing),
    proposeResearch: vi.fn(missing),
    proposeSimulation: vi.fn(missing),
  };
  const client = { vertex: { experience: api } } as unknown as ApiClient;
  return { api, client, services: createExperienceServices(client) };
};
const run = (): AgentRun => ({
  schemaVersion: "1.0.0",
  runId: "run-a",
  agentRole: "research",
  taskContract: "research-v1",
  allowedTools: ["read-evidence"],
  modelVersion: null,
  inputEvidenceIds: ["evidence-a"],
  outputArtifactIds: [],
  tokenBudget: 100,
  costBudgetUsd: "1",
  status: "queued",
  errors: [],
  approvalRequests: [],
  executionAuthorized: false,
});
const seal = async <T>(
  artifactId: string,
  value: T
): Promise<ImmutableArtifact<T>> => ({
  artifactId,
  sha256: await hashArtifact(value),
  value,
});
const research = (): ResearchProposalCommand => ({
  ...scope,
  question: "What evidence supports this claim?",
  collectionId: "collection-a",
  evidenceIds: ["evidence-a"],
  role: "research",
  idempotencyKey: "request-a",
  proposalOnly: true,
  executionAuthorized: false,
});
const review = (): ReviewDecisionCommand => ({
  ...scope,
  artifactId: "artifact-a",
  artifactSha256: "a".repeat(64),
  strategyVersion: "strategy-a",
  decision: "accepted",
  purpose: "research",
  expectedReviewId: null,
  idempotencyKey: "request-a",
});
const simulation = (): SimulationProposalCommand => ({
  accountAlias: "account-a",
  environment: "paper",
  admissionId: "admission-a",
  reviewId: "review-a",
  reviewVersion: "1.0.0",
  intentId: "intent-a",
  intentSha256: "a".repeat(64),
  strategyVersion: "strategy-a",
  idempotencyKey: "request-a",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
});
const continuity = (
  evaluatedAt = "2026-09-22T12:00:01Z",
  accountAlias: string = scope.accountAlias
): VertexContinuityRead => ({
  status: "available",
  continuity: {
    accountAlias,
    environment: "research",
    streamId: "stream-a",
    ownerEpoch: "1",
    highWaterSequence: "1",
    highWaterEventHash: "a".repeat(64),
    lastOccurredAt: "2026-09-22T12:00:00Z",
    lastReceivedAt: "2026-09-22T12:00:00Z",
    evaluatedAt,
    freshness: {
      status: "fresh",
      observedAt: "2026-09-22T12:00:00Z",
      evaluatedAt,
      maxAgeMs: 10_000,
    },
    state: "continuous",
    expectedNextSequence: "2",
    receivedSequence: null,
    newRiskInhibited: true,
    authoritative: false,
  },
});

// Source-authored only: these tests use synthetic artifacts and an injected client.
// No provider, database, broker, browser, model, or network transport is opened.
describe("authenticated Experience transport (execution deferred)", () => {
  it("dispatches each read to the flat experience route with the same signal", async () => {
    const { api, services } = fixture();
    const abort = signal();
    const artifact = { ...scope, artifactId: "artifact-a" };
    const stream = { ...scope, streamId: "stream-a" };
    const gateway = { gatewayId: "gateway-a", environment: "paper" } as const;
    const calls = [
      ["portfolio", scope, () => services.reads.portfolio(scope, abort)],
      ["continuity", stream, () => services.reads.continuity(stream, abort)],
      [
        "inbox",
        { ...scope, limit: 100, cursor: null },
        () => services.reads.inbox(scope, abort),
      ],
      [
        "strategies",
        { ...scope, limit: 100, cursor: null },
        () => services.reads.strategies(scope, abort),
      ],
      ["dossier", artifact, () => services.reads.dossier(artifact, abort)],
      [
        "agents",
        { ...scope, limit: 100, cursor: null },
        () => services.reads.agents(scope, abort),
      ],
      ["agent", artifact, () => services.reads.agent(artifact, abort)],
      [
        "audit",
        { ...scope, limit: 100, cursor: null },
        () => services.reads.audit(scope, abort),
      ],
      ["gateway", gateway, () => services.reads.gateway(gateway, abort)],
      ["gateways", {}, () => services.reads.gateways(undefined, abort)],
      ["scopes", {}, () => services.reads.scopes(undefined, abort)],
    ] as const;
    for (const [route, input, invoke] of calls) {
      await expect(invoke()).rejects.toMatchObject({ kind: "unavailable" });
      expect(api[route]).toHaveBeenCalledExactlyOnceWith(input, {
        signal: abort,
      });
    }
  });

  it("returns guarded scope and gateway lists from the flat routes", async () => {
    const { api, services } = fixture();
    const abort = signal();
    const binding = {
      gatewayId: "gateway-a",
      environment: "paper",
      accountAlias: scope.accountAlias,
    } as const;
    api.scopes.mockResolvedValue([scope]);
    api.gateways.mockResolvedValue([binding]);
    await expect(services.reads.scopes(undefined, abort)).resolves.toEqual([
      scope,
    ]);
    await expect(services.reads.gateways(undefined, abort)).resolves.toEqual([
      binding,
    ]);
    api.gateways.mockResolvedValue([binding, binding]);
    await expect(
      services.reads.gateways(undefined, abort)
    ).rejects.toMatchObject({ kind: "malformed" });
    api.gateways.mockResolvedValue([{ ...binding, token: "secret" }]);
    return await expect(
      services.reads.gateways(undefined, abort)
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("dispatches commands without adding caller actor/admin or broker authority", async () => {
    const { api, services } = fixture();
    const abort = signal();
    await expect(
      services.reviews!.decide(
        {
          ...review(),
          actorId: "forged",
          isAdmin: true,
        } as ReviewDecisionCommand,
        abort
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      services.jobs!.proposeResearch(
        {
          ...research(),
          actorId: "forged",
          brokerSubmissionAllowed: true,
        } as ResearchProposalCommand,
        abort
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      services.jobs!.proposeSimulation(
        {
          ...simulation(),
          actorId: "forged",
          isAdmin: true,
        } as SimulationProposalCommand,
        abort
      )
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(api.decideReview).toHaveBeenCalledExactlyOnceWith(review(), {
      signal: abort,
    });
    expect(api.proposeResearch).toHaveBeenCalledExactlyOnceWith(research(), {
      signal: abort,
    });
    return expect(api.proposeSimulation).toHaveBeenCalledExactlyOnceWith(
      simulation(),
      { signal: abort }
    );
  });

  it("preserves explicit unavailable data and does not manufacture empty holdings", async () => {
    const { api, services } = fixture();
    api.portfolio.mockResolvedValue(unavailable);
    api.continuity.mockResolvedValue(unavailable);
    await expect(services.reads.portfolio(scope, signal())).resolves.toEqual(
      unavailable
    );
    return await expect(
      services.reads.continuity({ ...scope, streamId: "stream-a" }, signal())
    ).resolves.toEqual(unavailable);
  });

  it("maps only defined matching oRPC code/status pairs to safe failures", async () => {
    const { api, services } = fixture();
    const cases = [
      ["UNAUTHORIZED", 401, "unauthorized"],
      ["FORBIDDEN", 403, "denied"],
      ["NOT_FOUND", 404, "not-found"],
      ["BAD_REQUEST", 400, "invalid"],
      ["INVALID_SOURCE", 502, "malformed"],
      ["SERVICE_UNAVAILABLE", 503, "unavailable"],
      ["CONFLICT", 409, "error"],
      ["FORBIDDEN", 401, "error"],
    ] as const;
    for (const [code, status, kind] of cases) {
      api.portfolio.mockRejectedValue(wireError(code, status));
      await expect(
        services.reads.portfolio(scope, signal())
      ).rejects.toMatchObject({ name: "VertexReadError", kind });
      await expect(
        services.reads.portfolio(scope, signal())
      ).rejects.not.toHaveProperty("data");
      await expect(
        services.reads.portfolio(scope, signal())
      ).rejects.not.toHaveProperty("cause");
      await expect(
        services.reads.portfolio(scope, signal())
      ).rejects.not.toHaveProperty("message", "private upstream details");
    }
    api.portfolio.mockRejectedValue(new VertexReadError("denied"));
    return await expect(
      services.reads.portfolio(scope, signal())
    ).rejects.toMatchObject({ kind: "denied" });
  });

  it("does not trust spoofed or accessor-backed transport errors", async () => {
    const { api, services } = fixture();
    const getter = vi.fn(() => "FORBIDDEN");
    const spoof = Object.defineProperty(
      { defined: true, status: 403 },
      "code",
      { get: getter }
    );
    for (const error of [
      spoof,
      { code: "FORBIDDEN", status: 403 },
      new Error("private upstream details"),
    ]) {
      api.portfolio.mockRejectedValue(error);
      await expect(
        services.reads.portfolio(scope, signal())
      ).rejects.toMatchObject({ kind: "error" });
    }
    return expect(getter).not.toHaveBeenCalled();
  });

  it("rejects a retired scope before any RPC including commands and scope discovery", async () => {
    const { api, client, services } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      services.reads.portfolio(scope, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    await expect(
      services.jobs!.proposeSimulation(simulation(), controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    await expect(
      createExperienceScopeLoader(client)(controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
  });

  it("drops a result arriving after session retirement even if the client ignores abort", async () => {
    const { api, services } = fixture();
    const controller = new AbortController();
    api.portfolio.mockImplementation(async () => {
      controller.abort();
      return unavailable;
    });
    await expect(
      services.reads.portfolio(scope, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    return expect(api.portfolio).toHaveBeenCalledExactlyOnceWith(scope, {
      signal: controller.signal,
    });
  });

  it("checks retirement again after asynchronous digest verification", async () => {
    const { api, services } = fixture();
    const item = await seal("artifact-a", run());
    api.agent.mockResolvedValue(item);
    const controller = new AbortController();
    // Browser code path: a window selects WebCrypto hashing (server runtimes hash synchronously).
    vi.stubGlobal("window", globalThis);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        const result = await digest(algorithm, data);
        controller.abort();
        return result;
      });
    try {
      await expect(
        services.reads.agent(
          { ...scope, artifactId: "artifact-a" },
          controller.signal
        )
      ).rejects.toMatchObject({ kind: "suspended" });
      return expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("cancellation dominates an upstream error without exposing its details", async () => {
    const { api, services } = fixture();
    const controller = new AbortController();
    api.portfolio.mockImplementation(async () => {
      controller.abort();
      throw wireError("FORBIDDEN", 403);
    });
    return await expect(
      services.reads.portfolio(scope, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
  });

  it("loads only server-authorized scopes with empty input and exact signal", async () => {
    const { api, client } = fixture();
    const abort = signal();
    const load = createExperienceScopeLoader(client);
    api.scopes.mockResolvedValue([scope, { ...scope, environment: "paper" }]);
    await expect(load(abort)).resolves.toEqual([
      scope,
      { ...scope, environment: "paper" },
    ]);
    expect(api.scopes).toHaveBeenCalledExactlyOnceWith({}, { signal: abort });
    api.scopes.mockResolvedValue([]);
    await expect(load(abort)).resolves.toEqual([]);
    api.scopes.mockRejectedValue(wireError());
    return await expect(load(abort)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("bounds, validates and rejects duplicate scope identities rather than dropping entries", async () => {
    const { api, client } = fixture();
    const load = createExperienceScopeLoader(client);
    const bad = [
      [scope, scope],
      [{ ...scope, isAdmin: true }],
      [{ ...scope, accountAlias: "bad/account" }],
      Array.from({ length: 513 }, (_, i) => ({
        ...scope,
        accountAlias: `account-${i}`,
      })),
      null,
    ];
    for (const value of bad) {
      api.scopes.mockResolvedValue(value);
      await expect(load(signal())).rejects.toMatchObject({ kind: "malformed" });
    }
    api.scopes.mockResolvedValue(
      Array.from({ length: 512 }, (_, i) => ({
        ...scope,
        accountAlias: `account-${i}`,
      }))
    );
    return await expect(load(signal())).resolves.toHaveLength(512);
  });

  it("checks abort after authorized scope discovery", async () => {
    const { api, client } = fixture();
    const controller = new AbortController();
    api.scopes.mockImplementation(async () => {
      controller.abort();
      return [scope];
    });
    return await expect(
      createExperienceScopeLoader(client)(controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
  });

  it("accumulates immutable agent pages in order and propagates opaque cursors", async () => {
    const { api, services } = fixture();
    const first = await seal("artifact-a", run());
    const second = await seal("artifact-b", run());
    api.agents
      .mockResolvedValueOnce({ items: [first], nextCursor: "opaque_a" })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });
    const abort = signal();
    await expect(services.reads.agents(scope, abort)).resolves.toEqual([
      first,
      second,
    ]);
    expect(api.agents).toHaveBeenNthCalledWith(
      1,
      { ...scope, limit: 100, cursor: null },
      { signal: abort }
    );
    return expect(api.agents).toHaveBeenNthCalledWith(
      2,
      { ...scope, limit: 100, cursor: "opaque_a" },
      { signal: abort }
    );
  });

  it("never returns a partial list when a later page is unavailable", async () => {
    const { api, services } = fixture();
    api.agents
      .mockResolvedValueOnce({
        items: [await seal("artifact-a", run())],
        nextCursor: "page_a",
      })
      .mockRejectedValueOnce(wireError());
    return await expect(
      services.reads.agents(scope, signal())
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("rejects repeated item identities and repeated cursors across pages", async () => {
    for (const duplicateId of [true, false]) {
      const { api, services } = fixture();
      const first = await seal("artifact-a", run());
      const second = await seal(
        duplicateId ? "artifact-a" : "artifact-b",
        run()
      );
      api.agents
        .mockResolvedValueOnce({ items: [first], nextCursor: "page_a" })
        .mockResolvedValueOnce({
          items: [second],
          nextCursor: duplicateId ? null : "page_a",
        });
      await expect(
        services.reads.agents(scope, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
      expect(api.agents).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects malformed pages, oversized pages and empty nonterminal pages", async () => {
    const { api, services } = fixture();
    const item = await seal("artifact-a", run());
    const bad = [
      null,
      { items: [], nextCursor: "page_a" },
      { items: [], nextCursor: undefined },
      { items: [item], nextCursor: "bad cursor" },
      { items: [item], nextCursor: "a".repeat(4097) },
      { items: [], nextCursor: null, actorId: "unexpected" },
      {
        items: Array.from({ length: 101 }, (_, i) => ({
          ...item,
          artifactId: `artifact-${i}`,
        })),
        nextCursor: null,
      },
    ];
    for (const value of bad) {
      api.agents.mockResolvedValue(value);
      await expect(
        services.reads.agents(scope, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });

  it("fails closed at audit 500 and artifact 512 when more pages remain", async () => {
    for (const [route, maximum] of [
      ["audit", 500],
      ["agents", 512],
      ["strategies", 512],
    ] as const) {
      const { api, services } = fixture();
      let offset = 0;
      api[route].mockImplementation(async () => {
        const count = Math.min(100, maximum - offset);
        const items = Array.from({ length: count }, (_, i) => ({
          artifactId: `artifact-${offset + i}`,
          projectionId: `projection-${offset + i}`,
        }));
        offset += count;
        return { items, nextCursor: `page_${offset}` };
      });
      await expect(
        services.reads[route](scope, signal())
      ).rejects.toMatchObject({ kind: "malformed" });
      expect(api[route]).toHaveBeenCalledTimes(Math.ceil(maximum / 100));
    }
  });

  it("does not dispatch the next page after abort", async () => {
    const { api, services } = fixture();
    const controller = new AbortController();
    api.agents.mockImplementation(async () => {
      controller.abort();
      return { items: [await seal("artifact-a", run())], nextCursor: "page_a" };
    });
    await expect(
      services.reads.agents(scope, controller.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    return expect(api.agents).toHaveBeenCalledTimes(1);
  });

  it("merges unique inbox items while retaining the latest validated continuity", async () => {
    const { api, services } = fixture();
    const first = await seal("artifact-a", run());
    const second = await seal("artifact-b", run());
    const latest = continuity("2026-09-22T12:00:02Z");
    api.inbox
      .mockResolvedValueOnce({
        strategies: [],
        agents: [first],
        reviews: [],
        continuity: continuity(),
        nextCursor: "inbox_a",
      })
      .mockResolvedValueOnce({
        strategies: [],
        agents: [second],
        reviews: [],
        continuity: latest,
        nextCursor: null,
      });
    return await expect(services.reads.inbox(scope, signal())).resolves.toEqual(
      {
        strategies: [],
        agents: [first, second],
        reviews: [],
        continuity: latest,
      }
    );
  });

  it("validates every inbox observation, including an earlier wrong-scope observation", async () => {
    const { api, services } = fixture();
    const first = await seal("artifact-a", run());
    api.inbox
      .mockResolvedValueOnce({
        strategies: [],
        agents: [first],
        reviews: [],
        continuity: continuity(
          "2026-09-22T12:00:01Z",
          "other-account" as typeof scope.accountAlias
        ),
        nextCursor: "inbox_a",
      })
      .mockResolvedValueOnce({
        strategies: [],
        agents: [],
        reviews: [],
        continuity: continuity(),
        nextCursor: null,
      });
    await expect(services.reads.inbox(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    return expect(api.inbox).toHaveBeenCalledTimes(1);
  });

  it("rejects inbox duplicate IDs, cursor cycles and nonprogress pages", async () => {
    const item = await seal("artifact-a", run());
    for (const duplicate of [true, false]) {
      const { api, services } = fixture();
      api.inbox
        .mockResolvedValueOnce({
          strategies: [],
          agents: [item],
          reviews: [],
          continuity: unavailable,
          nextCursor: "inbox_a",
        })
        .mockResolvedValueOnce({
          strategies: [],
          agents: duplicate ? [item] : [],
          reviews: [],
          continuity: unavailable,
          nextCursor: "inbox_a",
        });
      await expect(services.reads.inbox(scope, signal())).rejects.toMatchObject(
        { kind: "malformed" }
      );
      expect(api.inbox).toHaveBeenCalledTimes(2);
    }
    const { api, services } = fixture();
    api.inbox.mockResolvedValue({
      strategies: [],
      agents: [],
      reviews: [],
      continuity: unavailable,
      nextCursor: "inbox_a",
    });
    await expect(services.reads.inbox(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    return expect(api.inbox).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid immutable digests instead of trusting transport success", async () => {
    const { api, services } = fixture();
    const item = await seal("artifact-a", run());
    api.agent.mockResolvedValue({ ...item, sha256: "0".repeat(64) });
    await expect(
      services.reads.agent({ ...scope, artifactId: "artifact-a" }, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    api.agents.mockResolvedValue({
      items: [{ ...item, value: { ...item.value, costBudgetUsd: "2" } }],
      nextCursor: null,
    });
    return await expect(
      services.reads.agents(scope, signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("keeps queued acknowledgements non-executable and rejects broker-enabled commands", async () => {
    const { api, services } = fixture();
    const item = await seal("artifact-a", run());
    api.proposeResearch.mockResolvedValue(item);
    await expect(
      services.jobs!.proposeResearch(research(), signal())
    ).resolves.toEqual(item);
    const receipt = {
      jobId: "job-a",
      admissionId: "admission-a",
      status: "queued",
      simulationOnly: true,
      brokerSubmissionAllowed: false,
      liveAuthorization: false,
    } as const;
    api.proposeSimulation.mockResolvedValue(receipt);
    await expect(
      services.jobs!.proposeSimulation(simulation(), signal())
    ).resolves.toEqual(receipt);
    api.proposeSimulation.mockClear();
    for (const unsafe of [
      { ...simulation(), brokerSubmissionAllowed: true },
      { ...simulation(), liveAuthorization: true },
      { ...simulation(), simulationOnly: false },
      { ...simulation(), environment: "live" },
    ]) {
      await expect(
        services.jobs!.proposeSimulation(unsafe as never, signal())
      ).rejects.toMatchObject({ kind: "denied" });
    }
    expect(api.proposeSimulation).not.toHaveBeenCalled();
    api.proposeSimulation.mockResolvedValue({
      ...receipt,
      brokerSubmissionAllowed: true,
    });
    return await expect(
      services.jobs!.proposeSimulation(simulation(), signal())
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("returns every valid artifact at the 512 bound when the final cursor is null", async () => {
    const { api, services } = fixture();
    const item = await seal("artifact-a", run());
    const all = Array.from({ length: 512 }, (_, i) => ({
      ...item,
      artifactId: `artifact-${i}`,
    }));
    let offset = 0;
    api.agents.mockImplementation(async () => {
      const items = all.slice(offset, offset + 100);
      offset += items.length;
      return {
        items,
        nextCursor: offset === all.length ? null : `page_${offset}`,
      };
    });
    await expect(services.reads.agents(scope, signal())).resolves.toEqual(all);
    return expect(api.agents).toHaveBeenCalledTimes(6);
  });

  it("does not truncate an inbox section that exceeds its accumulation bound", async () => {
    const { api, services } = fixture();
    let offset = 0;
    api.inbox.mockImplementation(async () => {
      const count = Math.min(100, 513 - offset);
      const agents = Array.from({ length: count }, (_, i) => ({
        artifactId: `artifact-${offset + i}`,
      }));
      offset += count;
      return {
        strategies: [],
        agents,
        reviews: [],
        continuity: unavailable,
        nextCursor: offset === 513 ? null : `inbox_${offset}`,
      };
    });
    await expect(services.reads.inbox(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    return expect(api.inbox).toHaveBeenCalledTimes(6);
  });

  it("accepts genuinely empty terminal pages without substituting them for failures", async () => {
    const { api, services } = fixture();
    for (const route of ["agents", "strategies", "audit"] as const) {
      api[route].mockResolvedValue({ items: [], nextCursor: null });
      await expect(services.reads[route](scope, signal())).resolves.toEqual([]);
    }
    api.inbox.mockResolvedValue({
      strategies: [],
      agents: [],
      reviews: [],
      continuity: unavailable,
      nextCursor: null,
    });
    return await expect(services.reads.inbox(scope, signal())).resolves.toEqual(
      { strategies: [], agents: [], reviews: [], continuity: unavailable }
    );
  });

  return it("rejects accessor-backed pages before evaluating attacker-supplied accessors", async () => {
    const { api, client, services } = fixture();
    const getter = vi.fn(() => []);
    api.agents.mockResolvedValue(
      Object.defineProperty({ nextCursor: null }, "items", {
        enumerable: true,
        get: getter,
      })
    );
    await expect(services.reads.agents(scope, signal())).rejects.toMatchObject({
      kind: "malformed",
    });
    api.scopes.mockResolvedValue([
      Object.defineProperty({ environment: "research" }, "accountAlias", {
        enumerable: true,
        get: getter,
      }),
    ]);
    await expect(
      createExperienceScopeLoader(client)(signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    return expect(getter).not.toHaveBeenCalled();
  });
});
