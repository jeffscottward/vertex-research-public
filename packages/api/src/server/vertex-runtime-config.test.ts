import { describe, expect, it, vi } from "vitest";
import type { SafeAuthSession } from "@darkfactory/auth/types";
import type { Database, Transaction } from "@darkfactory/db/server";
import { hashArtifact } from "@darkfactory/shared/vertex";
import {
  createVertexRuntimeConfiguredOptions,
  type VertexRuntimeConfiguredGroups,
} from "./vertex-runtime-config.ts";
import {
  parseVertexRuntimeConfiguration,
  VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES,
  type VertexRuntimeConfiguration,
} from "./vertex-runtime-config-schema.ts";

// Source-only regressions. Do not execute until the user permits verification.
// All identities/keys/commitments below are synthetic; no DB, env or network.
const at = "2026-09-22T12:00:00.000Z";
const before = "2026-09-22T11:00:00.000Z";
const after = "2026-09-22T13:00:00.000Z";
const sha = "a".repeat(64);
const otherSha = "b".repeat(64);
const scope = {
  accountAlias: "synthetic-account",
  environment: "paper" as const,
};
type PolicyRequest = Parameters<
  NonNullable<
    NonNullable<
      VertexRuntimeConfiguredGroups["policy"]
    >["privilegedAuthorization"]
  >["authorize"]
>[0];
type ModelRequest = Parameters<
  NonNullable<
    VertexRuntimeConfiguredGroups["modelUse"]
  >["privilegedAuthorization"]["authorize"]
>[0];
type WorkerAdministration = NonNullable<
  VertexRuntimeConfiguredGroups["worker"]
>["authorizeGrantAdministration"];
const fixture = (): VertexRuntimeConfiguration => ({
  format: "vertex-runtime-configuration-v1",
  policy: {
    consumerServiceId: "synthetic-control",
    components: [],
    jobModules: [],
    administration: [],
  },
  worker: { routes: [], emitterBindings: [], administration: [] },
  modelUse: { requestEvidence: [], administration: [] },
  gateway: [],
});
const session = (
  actor = "synthetic-administrator",
  role: "admin" | "member" = "member"
): SafeAuthSession => ({
  principal: { userId: actor, role, status: "active" },
  user: {
    id: actor,
    name: "Synthetic",
    email: "synthetic@example.invalid",
    emailVerified: true,
    image: null,
    createdAt: new Date(before),
    updatedAt: new Date(before),
    role,
    status: "active",
  },
  session: {
    id: "synthetic-session",
    userId: actor,
    expiresAt: new Date(after),
    createdAt: new Date(before),
    updatedAt: new Date(before),
    ipAddress: null,
    userAgent: null,
  },
});
const harness = (configuration: unknown) => {
  const dbAccess = vi.fn(() => {
    throw new Error("Composition must not touch DB");
  });
  const db = new Proxy({} as Database, { get: dbAccess });
  const state: { session: SafeAuthSession | null; now: string } = {
    session: session(),
    now: at,
  };
  const requireSession = vi.fn(async (_headers: Headers) => {
    if (!state.session) throw new Error("Synthetic unauthenticated request");
    return state.session;
  });
  const headers = new Headers({ "x-synthetic-provenance": "original" });
  const now = vi.fn(() => state.now);
  const controller = new AbortController();
  const result = createVertexRuntimeConfiguredOptions({
    configuration,
    bindings: {},
    db,
    requireSession,
    requestHeaders: headers,
    clock: { now },
    signal: controller.signal,
  });
  return { result, dbAccess, state, requireSession, headers, now, controller };
};
const policyRequest = (): PolicyRequest => ({
  principal: { actorId: "synthetic-administrator" },
  scope,
  operation: "activate",
  selectionId: "synthetic-selection",
  selectionSha256: sha,
  expectedRevision: "1",
  commandId: "synthetic-command",
  requestSha256: sha,
  now: at,
});
const withPolicyPlan = (): VertexRuntimeConfiguration => {
  const value = fixture();
  const request = policyRequest();
  value.policy!.administration.push({
    ...scope,
    actorId: request.principal.actorId,
    operation: request.operation,
    selectionId: request.selectionId,
    selectionSha256: request.selectionSha256,
    expectedRevision: request.expectedRevision,
    commandId: request.commandId,
    requestSha256: request.requestSha256,
    validFrom: before,
    expiresAt: after,
  });
  return value;
};

describe("strict bounded runtime configuration", () => {
  it.each([
    undefined,
    null,
    true,
    1,
    {},
    [],
    "",
    "null",
    "[]",
    "{}",
    "{",
    '{"format":"unrecognized"}',
  ])("returns neutral disabled state for invalid input %j", (input) => {
    const f = harness(input);
    expect(f.result).toEqual({ status: "disabled", options: {} });
    expect(f.requireSession).not.toHaveBeenCalled();
    expect(f.dbAccess).not.toHaveBeenCalled();
    return expect(f.now).not.toHaveBeenCalled();
  });
  it("does not coerce objects, access getters, or echo parse diagnostics", () => {
    const read = vi.fn(() => {
      throw new Error("not configuration text");
    });
    expect(
      parseVertexRuntimeConfiguration({
        get format() {
          return read();
        },
        toString: read,
      })
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    return expect(
      harness('{"privateKey":"synthetic-secret-marker"}').result
    ).toEqual({ status: "disabled", options: {} });
  });
  it("enforces the exact UTF-8 allocation limit before parsing", () => {
    const source = JSON.stringify(fixture());
    expect(
      parseVertexRuntimeConfiguration(
        source.padEnd(VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES)
      )
    ).not.toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        source.padEnd(VERTEX_RUNTIME_CONFIGURATION_MAX_BYTES + 1)
      )
    ).toBeNull();
    return expect(
      parseVertexRuntimeConfiguration(`"${"é".repeat(65_536)}"`)
    ).toBeNull();
  });
  it("rejects duplicate, escaped-alias, prototype and excessively nested keys", () => {
    const source = JSON.stringify(fixture());
    expect(
      parseVertexRuntimeConfiguration(
        source.replace(
          '"format":',
          '"format":"vertex-runtime-configuration-v1","format":'
        )
      )
    ).toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        source.replace(
          '"format":',
          '"for\\u006dat":"vertex-runtime-configuration-v1","format":'
        )
      )
    ).toBeNull();
    expect(
      parseVertexRuntimeConfiguration(source.replace("{", '{"__proto__":{},'))
    ).toBeNull();
    return expect(
      parseVertexRuntimeConfiguration(`${"[".repeat(17)}0${"]".repeat(17)}`)
    ).toBeNull();
  });
  it("rejects unknown nested fields, missing selections and contradictory duplicate routes", () => {
    const value = fixture();
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({ ...value, policy: { ...value.policy, ready: true } })
      )
    ).toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({ ...value, policy: undefined })
      )
    ).toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({
          ...value,
          worker: {
            ...value.worker,
            routes: [
              {
                taskContract: "one",
                kind: "research-run",
                bindingId: "a",
                ttlMilliseconds: 1,
              },
              {
                taskContract: "one",
                kind: "research-run",
                bindingId: "b",
                ttlMilliseconds: 1,
              },
            ],
          },
        })
      )
    ).toBeNull();
    return expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({
          ...value,
          modelUse: {
            ...value.modelUse,
            requestEvidence: [
              {
                ...scope,
                jobId: "job",
                requestSha256: sha,
                inputArtifactId: "input",
                inputCollectionId: null,
                privacyIssuerActorId: "issuer",
                privacyDecision: {
                  artifactId: "privacy",
                  artifactSha256: sha,
                  contractName: "Privacy",
                  schemaVersion: "1.0.0",
                  ready: true,
                },
              },
            ],
          },
        })
      )
    ).toBeNull();
  });
  it("composes real groups inertly and snapshots configuration data deeply", () => {
    const value = fixture();
    value.worker!.routes.push({
      taskContract: "synthetic-task",
      kind: "research-run",
      bindingId: "synthetic-binding",
      ttlMilliseconds: 1000,
    });
    const f = harness(JSON.stringify(value));
    expect(f.result.status).toBe("enabled");
    expect(Object.keys(f.result.options).sort()).toEqual([
      "gateway",
      "modelUse",
      "policy",
      "worker",
    ]);
    expect(f.dbAccess).not.toHaveBeenCalled();
    expect(f.requireSession).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
    value.worker!.routes[0]!.bindingId = "mutated-after-composition";
    expect(f.result.options.worker!.routes[0]!.bindingId).toBe(
      "synthetic-binding"
    );
    expect(Object.isFrozen(f.result.options.worker!.routes)).toBe(true);
    return expect(Object.isFrozen(f.result.options.worker!.routes[0])).toBe(
      true
    );
  });
  it("requires policy for every dependent group even when worker is absent", () => {
    const { format, policy, modelUse, gateway } = fixture();
    expect(
      parseVertexRuntimeConfiguration(JSON.stringify({ format, policy }))
    ).not.toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({ format, policy, gateway })
      )
    ).not.toBeNull();
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({ format, policy, modelUse })
      )
    ).not.toBeNull();
    expect(
      parseVertexRuntimeConfiguration(JSON.stringify({ format, modelUse }))
    ).toBeNull();
    return expect(
      parseVertexRuntimeConfiguration(JSON.stringify({ format, gateway }))
    ).toBeNull();
  });
  return it("accepts only explicit bounded enrolled public-key evidence, never private keys", () => {
    const value = fixture();
    value.nativeEpoch = {
      authority: {
        configuredAtNs: "1",
        validUntilNs: "2",
        policy: {
          policyId: "synthetic-policy",
          policySha256: sha,
          policyVersion: "1.0.0",
          ...scope,
          simulatorId: "synthetic-simulator",
          currency: "USD",
          maximumApprovalTtlNs: "1",
          maximumStatusAgeNs: "1",
        },
        keys: [
          {
            keyId: "synthetic-status",
            actorId: "status-actor",
            publicKeyBase64: `${"A".repeat(43)}=`,
            roles: ["status"],
            notBeforeNs: "0",
            expiresNs: "3",
          },
          {
            keyId: "synthetic-approval",
            actorId: "approval-actor",
            publicKeyBase64: `${"B".repeat(42)}A=`,
            roles: ["approval"],
            notBeforeNs: "0",
            expiresNs: "3",
          },
        ],
        statusKeyId: "synthetic-status",
        currentStatusBase64: "e30=",
        currentStatusSha256: sha,
        minimumStatusRevision: "1",
        grants: [],
      },
    };
    // Schema admission is NOT signed-status verification or an authority grant.
    expect(harness(JSON.stringify(value)).result.options.nativeEpoch).toEqual(
      value.nativeEpoch
    );
    expect(
      parseVertexRuntimeConfiguration(
        JSON.stringify({
          ...value,
          nativeEpoch: {
            authority: {
              ...value.nativeEpoch.authority,
              privateKey: "not-allowed",
            },
          },
        })
      )
    ).toBeNull();
    value.nativeEpoch.authority.keys[0]!.publicKeyBase64 =
      "-----BEGIN PRIVATE KEY-----";
    return expect(
      parseVertexRuntimeConfiguration(JSON.stringify(value))
    ).toBeNull();
  });
});

describe("request-bound independent administrative authority", () => {
  it("never infers an administrative grant from the admin role", async () => {
    const f = harness(JSON.stringify(fixture()));
    f.state.session = session("synthetic-administrator", "admin");
    return expect(
      await f.result.options.policy!.privilegedAuthorization!.authorize(
        policyRequest()
      )
    ).toBe(false);
  });
  it("authenticates exact server session and checks every explicit policy CAS field", async () => {
    const f = harness(JSON.stringify(withPolicyPlan()));
    const authorize =
      f.result.options.policy!.privilegedAuthorization!.authorize;
    const request = policyRequest();
    expect(await authorize(request)).toBe(true);
    const mutations: PolicyRequest[] = [
      { ...request, principal: { actorId: "rpc-spoofed-actor" } },
      { ...request, scope: { ...scope, accountAlias: "other" } },
      { ...request, operation: "rollback" },
      { ...request, selectionId: "other" },
      { ...request, selectionSha256: otherSha },
      { ...request, expectedRevision: "2" },
      { ...request, commandId: "other" },
      { ...request, requestSha256: otherSha },
    ];
    for (const mutation of mutations)
      expect(await authorize(mutation)).toBe(false);
    f.state.session = session("other", "admin");
    expect(await authorize(request)).toBe(false);
    f.state.session = null;
    return expect(await authorize(request)).toBe(false);
  });
  it("reauthenticates every decision and snapshots request headers rather than callback context", async () => {
    const f = harness(JSON.stringify(withPolicyPlan()));
    f.headers.set("x-synthetic-provenance", "changed");
    const resolve = f.result.options.worker!.serverPrincipal;
    expect(await resolve({ userId: "rpc-spoofed", role: "admin" })).toEqual(
      session().principal
    );
    expect(
      f.requireSession.mock.calls[0]![0].get("x-synthetic-provenance")
    ).toBe("original");
    f.state.session = session("different-server-actor");
    expect(await resolve({ userId: "synthetic-administrator" })).toEqual(
      session("different-server-actor").principal
    );
    return expect(f.requireSession).toHaveBeenCalledTimes(2);
  });
  it("fails closed on suspended or mismatched sessions, expiry and cancellation", async () => {
    const f = harness(JSON.stringify(withPolicyPlan()));
    const authorize =
      f.result.options.policy!.privilegedAuthorization!.authorize;
    f.state.session = {
      ...session(),
      principal: { ...session().principal, status: "suspended" },
    };
    expect(await authorize(policyRequest())).toBe(false);
    f.state.session = {
      ...session(),
      session: { ...session().session, userId: "mismatch" },
    };
    expect(await authorize(policyRequest())).toBe(false);
    f.state.session = session();
    f.state.now = after;
    expect(await authorize(policyRequest())).toBe(false);
    f.state.now = at;
    f.controller.abort();
    const beforeCalls = f.requireSession.mock.calls.length;
    expect(await authorize(policyRequest())).toBe(false);
    return expect(f.requireSession.mock.calls.length).toBe(beforeCalls);
  });
  it("pins worker grant record, previous CAS and combined credential commitment", async () => {
    const value = fixture();
    value.worker!.administration.push({
      ...scope,
      actorId: "synthetic-administrator",
      action: "issue",
      grantId: "synthetic-grant",
      recordSha256: sha,
      previousRecordSha256: null,
      authorizationSha256: otherSha,
      validFrom: before,
      expiresAt: after,
    });
    const f = harness(JSON.stringify(value));
    const authorize = f.result.options.worker!.authorizeGrantAdministration;
    const details: Parameters<WorkerAdministration>[4] = {
      grant: { grantId: "synthetic-grant" },
      credentialDigest: "c".repeat(64),
      recordSha256: sha,
      previousRecordSha256: null,
      authorizationSha256: otherSha,
      tx: {} as Transaction,
    };
    expect(
      await authorize(
        { actorId: "rpc-spoofed" },
        "issue",
        scope,
        "synthetic-grant",
        details
      )
    ).toBe(true);
    expect(
      await authorize({}, "revoke", scope, "synthetic-grant", details)
    ).toBe(false);
    expect(
      await authorize({}, "issue", scope, "synthetic-grant", {
        ...details,
        recordSha256: otherSha,
      })
    ).toBe(false);
    expect(
      await authorize({}, "issue", scope, "synthetic-grant", {
        ...details,
        previousRecordSha256: sha,
      })
    ).toBe(false);
    expect(
      await authorize({}, "issue", scope, "synthetic-grant", {
        ...details,
        authorizationSha256: sha,
      })
    ).toBe(false);
    f.state.session = session("other", "admin");
    return expect(
      await authorize(
        { actorId: "synthetic-administrator" },
        "issue",
        scope,
        "synthetic-grant",
        details
      )
    ).toBe(false);
  });
  return it("pins model grant bytes and CAS independently of consumer/read privileges", async () => {
    const grant: ModelRequest["grant"] = {
      ...scope,
      schemaVersion: "1.0.0",
      researchPrincipalId: "researcher",
      consumerServiceId: "consumer",
      selectionId: "selection",
      selectionSha256: sha,
      providerId: "provider",
      modelVersion: "model-v1",
      tokenizerArtifactId: "tokenizer",
      tokenizerSha256: sha,
      endpointReferenceId: "endpoint",
      endpointSha256: sha,
      modelUsePolicyVersion: "1.0.0",
      grantId: "model-grant",
      grantVersion: "1.0.0",
      revision: "1",
      operations: ["model-completion"],
      purposes: ["research"],
      allowedTools: [],
      evidence: [],
      maximumInputBytes: 1,
      maximumInputTokens: 1,
      maximumOutputTokens: 1,
      maximumCostUsd: "1",
      privacyPolicyId: "privacy",
      privacyPolicyVersion: "1.0.0",
      validFrom: before,
      expiresAt: after,
      status: "granted",
      issuedByActorId: "synthetic-administrator",
      issuedAt: before,
      modelProcessingOnly: true,
      executionAuthorized: false,
    };
    const value = fixture();
    value.modelUse!.administration.push({
      ...scope,
      actorId: "synthetic-administrator",
      operation: "issue-model-use",
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      grantSha256: await hashArtifact(grant),
      expectedRevision: null,
      commandId: "model-command",
      requestSha256: sha,
      validFrom: before,
      expiresAt: after,
    });
    const f = harness(JSON.stringify(value));
    const authorize =
      f.result.options.modelUse!.privilegedAuthorization.authorize;
    const request: ModelRequest = {
      principal: { actorId: "synthetic-administrator" },
      operation: "issue-model-use",
      grant,
      expectedRevision: null,
      commandId: "model-command",
      requestSha256: sha,
      now: at,
    };
    expect(await authorize(request)).toBe(true);
    expect(
      await authorize({ ...request, grant: { ...grant, maximumCostUsd: "2" } })
    ).toBe(false);
    expect(await authorize({ ...request, expectedRevision: "1" })).toBe(false);
    expect(await authorize({ ...request, operation: "revoke-model-use" })).toBe(
      false
    );
    expect(await authorize({ ...request, commandId: "other" })).toBe(false);
    return expect(
      await authorize({ ...request, requestSha256: otherSha })
    ).toBe(false);
  });
});
