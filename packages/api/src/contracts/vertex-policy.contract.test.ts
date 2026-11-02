import { describe, expect, it } from "vitest";
import {
  RuntimePolicySelectionSchema,
  parseRuntimePolicySelection,
} from "./vertex-policy.ts";
import {
  buildVertexResearchBinding,
  buildVertexReviewPolicy,
  buildVertexSimulationBinding,
  evaluateRuntimeModules,
} from "../../../config/src/vertex/capability.ts";
import {
  assessPolicyComponents,
  leastPrivilegeReferences,
} from "../../../config/src/vertex/policy.ts";
import type {
  PolicyScope,
  PolicyStore,
  PolicyTransaction,
} from "../../../config/src/vertex/ports.ts";
import { createRuntimePolicyRegistry } from "../../../config/src/vertex/registry.ts";
import {
  VERTEX_CONFIGURATION_GROUPS,
  VERTEX_TRAIL_ONLY_CANDIDATES,
  resolveConfiguredReference,
} from "../../../config/src/vertex/configuration.ts";
import {
  fixtureAt,
  fixtureExpires,
  fixtureHarness,
  fixtureLookup,
  fixturePrincipal,
  fixtureScope,
  fixtureSelection,
} from "./vertex-policy.test-support.ts";

// The registry hashes each request before it asks the store for the scope
// lock, so the lock order follows hash completion, not call order. This
// wrapper holds the first two concurrent transactions until both arrive, then
// starts them in arrival or reverse order, so every run covers both lock
// orders. Later transactions pass through. Both calls must reach the store:
// if one fails before it, the held call never settles and the test times out.
const contendedStore = (
  inner: PolicyStore,
  grant: "arrival" | "reverse"
): PolicyStore => {
  let held: (() => void)[] | null = [];
  return {
    transaction: <T>(
      scope: PolicyScope,
      operation: (tx: PolicyTransaction) => Promise<T>
    ): Promise<T> => {
      const waiting = held;
      if (waiting === null) return inner.transaction(scope, operation);
      // Executor form: the ES2023 lib has no Promise.withResolvers.
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          inner.transaction(scope, operation).then(resolve, reject);
        });
        if (waiting.length < 2) return;
        held = null;
        const order = grant === "reverse" ? [...waiting].reverse() : waiting;
        for (const start of order) start();
      });
    },
  };
};

// AUTHORED ONLY. User explicitly defers all execution until full buildout.
describe("immutable runtime policy authority", () => {
  it("binds every nonsecret pin and nanosecond without treating selection as permission", async () => {
    const value = await fixtureSelection("9007199254740993");
    expect(await parseRuntimePolicySelection(value)).toEqual(value);
    expect(value.revision).toBe("9007199254740993");
    expect(value.issuedAt).toBe(fixtureAt);
    expect(Object.isFrozen(value.modules[0])).toBe(true);
    await expect(
      parseRuntimePolicySelection({
        ...value,
        issuedAt: "2026-09-22T12:00:00.000000002Z",
      })
    ).rejects.toThrow("digest mismatch");
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        brokerPassword: "synthetic-forbidden-field",
      }).success
    ).toBe(false);
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        nativeRearmAllowed: true,
      }).success
    ).toBe(false);
    return expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        cloudCapitalAuthority: true,
      }).success
    ).toBe(false);
  });

  it("requires all seven distinct groups and keeps licensing version separate from risk", async () => {
    const value = await fixtureSelection();
    expect(VERTEX_CONFIGURATION_GROUPS).toHaveLength(7);
    expect(VERTEX_TRAIL_ONLY_CANDIDATES).toHaveLength(25);
    expect(new Set(VERTEX_TRAIL_ONLY_CANDIDATES).size).toBe(25);
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        configuration: value.configuration.slice(1),
      }).success
    ).toBe(false);
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        configuration: value.configuration.map(() => value.configuration[0]),
      }).success
    ).toBe(false);
    expect(value.policies.find((pin) => pin.role === "risk")?.version).toBe(
      "1.0.0"
    );
    expect(
      value.policies.find((pin) => pin.role === "licensing-rights")?.version
    ).toBe("2.0.0");
    return expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        providerCapabilities: value.providerCapabilities.map((fact) => ({
          ...fact,
          rightsPolicyVersion: "1.0.0",
        })),
      }).success
    ).toBe(false);
  });

  it("rejects cross-account references, missing model pins, invalid expiry and broker-live scope", async () => {
    const value = await fixtureSelection();
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        references: value.references.map((entry) => ({
          ...entry,
          accountAlias: "other-synthetic-account",
        })),
      }).success
    ).toBe(false);
    expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        providerCapabilities: [],
      }).success
    ).toBe(false);
    expect(
      RuntimePolicySelectionSchema.safeParse({ ...value, expiresAt: fixtureAt })
        .success
    ).toBe(false);
    expect(
      RuntimePolicySelectionSchema.safeParse({ ...value, environment: "live" })
        .success
    ).toBe(false);
    return expect(
      RuntimePolicySelectionSchema.safeParse({
        ...value,
        references: value.references.map((entry) => ({
          ...entry,
          secretValue: "not-permitted",
        })),
      }).success
    ).toBe(false);
  });

  it("resolves only explicit service-scoped references and never promotes trail flags", async () => {
    const value = await fixtureSelection();
    const fixture = fixtureHarness();
    expect(
      resolveConfiguredReference(
        value,
        "models.fixture.endpoint",
        "synthetic-host"
      ).status
    ).toBe("selected");
    expect(
      resolveConfiguredReference(
        value,
        "models.fixture.endpoint",
        "unrelated-host"
      ).status
    ).toBe("unknown");
    expect(
      resolveConfiguredReference(
        value,
        "models.fixture.endpoint",
        "synthetic-host",
        "TRADING_ENABLED"
      )
    ).toEqual({ status: "incompatible", reason: "trail-candidate-only" });
    expect(
      leastPrivilegeReferences(fixture.ports, value, "unrelated-host", [
        "research",
      ])
    ).toEqual([]);
    expect(
      leastPrivilegeReferences(fixture.ports, value, "synthetic-host", [
        "broker-order",
      ])
    ).toEqual([]);
    return expect(
      leastPrivilegeReferences(fixture.ports, value, "synthetic-host", [
        "research",
      ])
    ).toHaveLength(1);
  });

  it("does not activate on stage, grants, configured references or module labels", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    const staged = await fixture.registry.stage({
      ...fixture.command(value, "stage-1"),
      selection: value,
    });
    expect(staged.head.state).toBe("disabled");
    expect(staged.head.selectionId).toBe(null);
    expect(fixture.state.observationCount).toBe(0);
    await expect(
      fixture.registry.materialize(
        fixturePrincipal,
        fixtureLookup(value),
        "synthetic-host"
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    fixture.state.observedState = "unknown";
    await expect(
      fixture.registry.activate(fixture.command(value, "activate-1"))
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(fixture.state.head?.revision).toBe("1");
  });

  it("requires both ordinary current scope grants and independent privileged authorization", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    fixture.state.privileged = false;
    await expect(
      fixture.registry.stage({
        ...fixture.command(value, "stage-1"),
        selection: value,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(fixture.state.selections.size).toBe(0);
    fixture.state.privileged = true;
    fixture.state.scopeRead = false;
    await expect(
      fixture.registry.stage({
        ...fixture.command(value, "stage-1"),
        selection: value,
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(fixture.state.history.size).toBe(0);
  });

  it("rechecks privilege after asynchronous work and rolls every record back on denial", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    let calls = 0;
    const registry = createRuntimePolicyRegistry({
      ...fixture.ports,
      privilegedAuthorization: { authorize: async () => ++calls === 1 },
    });
    await expect(
      registry.stage({ ...fixture.command(value, "stage-1"), selection: value })
    ).rejects.toMatchObject({ code: "denied" });
    expect(fixture.state.head).toBe(null);
    return expect(fixture.state.selections.size).toBe(0);
  });

  it.each(["arrival", "reverse"] as const)(
    "fences concurrent CAS mutations and idempotent redelivery without reactivation (%s lock grant)",
    async (grant) => {
      const fixture = fixtureHarness();
      const registry = createRuntimePolicyRegistry({
        ...fixture.ports,
        store: contendedStore(fixture.ports.store, grant),
      });
      const value = await fixtureSelection();
      const stage = { ...fixture.command(value, "stage-1"), selection: value };
      const commands = [stage, { ...stage, commandId: "other-stage" }];
      const outcomes = await Promise.allSettled(
        commands.map((command) => registry.stage(command))
      );
      // CAS fixes exactly one winner but never which one. Find it by outcome.
      const won = outcomes.findIndex((result) => result.status === "fulfilled");
      const winner = commands[won];
      const loser = commands[1 - won];
      const rejection = outcomes[1 - won];
      if (!(winner && loser && rejection?.status === "rejected"))
        throw new Error("expected one committed and one rejected stage");
      expect(rejection.reason).toMatchObject({ code: "conflict" });
      expect([...fixture.state.history.keys()]).toEqual([winner.commandId]);
      // Redelivery returns the committed result. The losing command never
      // committed, so it still fails the revision check and changes nothing.
      expect((await registry.stage(winner)).status).toBe("duplicate");
      await expect(registry.stage(loser)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(fixture.state.head?.revision).toBe("1");
      fixture.state.privileged = false;
      return await expect(registry.stage(winner)).rejects.toMatchObject({
        code: "denied",
      });
    }
  );

  it("pins old job/position ownership across atomic drain cutover and rollback", async () => {
    const fixture = fixtureHarness();
    const first = await fixtureSelection();
    const second = await fixtureSelection("2");
    await fixture.registry.stage({
      ...fixture.command(first, "stage-first"),
      selection: first,
    });
    await fixture.registry.activate(fixture.command(first, "activate-first"));
    await fixture.registry.pin({
      ...fixture.command(first, "pin-job"),
      holderId: "synthetic-job",
      holderKind: "job",
      ownerServiceId: "synthetic-host",
      ownerEpoch: "1",
      moduleId: "synthetic-module",
    });
    await fixture.registry.pin({
      ...fixture.command(first, "pin-position"),
      holderId: "synthetic-position",
      holderKind: "open-position",
      ownerServiceId: "synthetic-host",
      ownerEpoch: "1",
      moduleId: "synthetic-module",
    });
    await fixture.registry.stage({
      ...fixture.command(second, "stage-second"),
      selection: second,
    });
    await expect(
      fixture.registry.activate(fixture.command(second, "premature-activate"))
    ).rejects.toMatchObject({ code: "conflict" });
    await fixture.registry.drain(fixture.command(first, "drain-first"));
    await expect(
      fixture.registry.pin({
        ...fixture.command(first, "new-after-drain"),
        holderId: "synthetic-new-job",
        holderKind: "job",
        ownerServiceId: "synthetic-host",
        ownerEpoch: "1",
        moduleId: "synthetic-module",
      })
    ).rejects.toMatchObject({ code: "stale" });
    await fixture.registry.activate(fixture.command(second, "activate-second"));
    expect(fixture.state.pins.get("synthetic-position")?.selectionSha256).toBe(
      first.selectionSha256
    );
    const historical = {
      ports: fixture.ports,
      registry: fixture.registry,
      principal: fixturePrincipal,
      lookup: fixtureLookup(first),
      consumerServiceId: "synthetic-host",
    };
    expect((await evaluateRuntimeModules(historical))[0]?.state).toBe(
      "draining"
    );
    expect(
      await fixture.registry.materialize(
        fixturePrincipal,
        fixtureLookup(first),
        "synthetic-host",
        "synthetic-job"
      )
    ).toEqual(first);
    await expect(
      fixture.registry.materialize(
        fixturePrincipal,
        fixtureLookup(first),
        "synthetic-host"
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    await fixture.registry.drain(fixture.command(second, "drain-second"));
    await fixture.registry.rollback(fixture.command(first, "rollback-first"));
    expect(fixture.state.head?.selectionId).toBe(first.selectionId);
    expect(fixture.state.pins.get("synthetic-position")?.ownerEpoch).toBe("1");
    expect(fixture.state.selections.size).toBe(2);
    expect(
      (
        await fixture.registry.readSelection(
          fixturePrincipal,
          fixtureLookup(second)
        )
      ).selectionId
    ).toBe(second.selectionId);
    return expect(
      (
        await evaluateRuntimeModules({
          ...historical,
          lookup: fixtureLookup(second),
        })
      )[0]?.state
    ).toBe("retired");
  });

  it("cannot fabricate position ownership, rebind an existing pin or reuse a released holder", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    await fixture.registry.stage({
      ...fixture.command(value, "stage"),
      selection: value,
    });
    await fixture.registry.activate(fixture.command(value, "activate"));
    fixture.state.owns = false;
    const pin = {
      ...fixture.command(value, "pin"),
      holderId: "position",
      holderKind: "open-position" as const,
      ownerServiceId: "synthetic-host",
      ownerEpoch: "1",
      moduleId: "synthetic-module",
    };
    await expect(fixture.registry.pin(pin)).rejects.toMatchObject({
      code: "denied",
    });
    fixture.state.owns = true;
    await fixture.registry.pin(pin);
    await expect(
      fixture.registry.pin({
        ...pin,
        ...fixture.command(value, "pin-other-owner"),
        ownerEpoch: "2",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    await fixture.registry.release({
      ...fixture.command(value, "release"),
      holderId: "position",
    });
    return await expect(
      fixture.registry.pin({ ...pin, ...fixture.command(value, "reuse") })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("revokes new materialization without mutating selections, owners or audit history", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    await fixture.registry.stage({
      ...fixture.command(value, "stage"),
      selection: value,
    });
    await fixture.registry.activate(fixture.command(value, "activate"));
    await fixture.registry.revoke(fixture.command(value, "revoke"));
    expect(fixture.state.head?.state).toBe("disabled");
    expect(
      await fixture.registry.readSelection(
        fixturePrincipal,
        fixtureLookup(value)
      )
    ).toEqual(value);
    await expect(
      fixture.registry.materialize(
        fixturePrincipal,
        fixtureLookup(value),
        "synthetic-host"
      )
    ).rejects.toMatchObject({ code: "stale" });
    return await expect(
      fixture.registry.activate(fixture.command(value, "rearm-from-config"))
    ).rejects.toMatchObject({ code: "stale" });
  });

  it("uses exact expiry nanoseconds and never falls back to a previous selection", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    await fixture.registry.stage({
      ...fixture.command(value, "stage"),
      selection: value,
    });
    await fixture.registry.activate(fixture.command(value, "activate"));
    fixture.state.now = fixtureExpires;
    await expect(
      fixture.registry.materialize(
        fixturePrincipal,
        fixtureLookup(value),
        "synthetic-host"
      )
    ).rejects.toMatchObject({ code: "stale" });
    return await expect(
      fixture.registry.readSelection(fixturePrincipal, {
        ...fixtureLookup(value),
        selectionSha256: "b".repeat(64),
      })
    ).rejects.toMatchObject({ code: "integrity" });
  });

  it("builds request-scoped review and continuously rechecked research/simulation bindings", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    await fixture.registry.stage({
      ...fixture.command(value, "stage"),
      selection: value,
    });
    await fixture.registry.activate(fixture.command(value, "activate"));
    const context = {
      ports: fixture.ports,
      registry: fixture.registry,
      principal: fixturePrincipal,
      lookup: fixtureLookup(value),
      consumerServiceId: "synthetic-host",
    };
    const review = await buildVertexReviewPolicy(context);
    const research = await buildVertexResearchBinding(context);
    const simulation = await buildVertexSimulationBinding(context);
    expect(review.binding?.version).toBe("1.0.0");
    expect(research.binding?.tokenBudget).toBe(1);
    expect(simulation.binding?.maximumNotional).toBe("1");
    expect(await research.binding?.available(fixtureScope)).toBe(true);
    expect(
      await simulation.binding?.available({
        ...fixtureScope,
        environment: "live",
      })
    ).toBe(false);
    fixture.state.currentAuthority = false;
    expect(await research.binding?.available(fixtureScope)).toBe(false);
    expect(await simulation.binding?.available(fixtureScope)).toBe(false);
    return expect((await buildVertexReviewPolicy(context)).state).toBe(
      "unavailable"
    );
  });

  it("distinguishes missing, disabled, incompatible and unavailable component evidence", async () => {
    const fixture = fixtureHarness();
    const value = await fixtureSelection();
    for (const state of [
      "unknown",
      "disabled",
      "incompatible",
      "unavailable",
    ] as const) {
      fixture.state.observedState = state;
      expect(
        (
          await assessPolicyComponents(
            fixture.ports,
            value,
            ["synthetic-host"],
            value.modules[0]
          )
        ).state
      ).toBe(state);
    }
    fixture.state.observedState = "ready";
    fixture.state.observedCode = "b".repeat(64);
    expect(
      (
        await assessPolicyComponents(
          fixture.ports,
          value,
          ["synthetic-host"],
          value.modules[0]
        )
      ).state
    ).toBe("incompatible");
    const absent = {
      ...fixture.ports,
      readiness: { ...fixture.ports.readiness, observe: async () => [] },
    };
    return expect(
      (
        await assessPolicyComponents(
          absent,
          value,
          ["synthetic-host"],
          value.modules[0]
        )
      ).state
    ).toBe("unknown");
  });
});
