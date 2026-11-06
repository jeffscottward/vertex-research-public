import { scope } from "./vertex-research-chat-execution-runtime.test-support.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  canonicalArtifactJson,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { VERTEX_CONTRACT_SCHEMAS } from "../contracts/vertex.ts";
import { VERTEX_CONTROL_CONTRACT_SCHEMAS } from "../contracts/vertex-control.ts";
import { VERTEX_POLICY_CONTRACT_SCHEMAS } from "../contracts/vertex-policy.ts";
import {
  VERTEX_WORKER_CONTRACT_SCHEMAS,
  WorkerCurrentRightsOutputSchema,
  WorkerAcceptedEvidenceOutputSchema,
} from "../contracts/vertex-worker.ts";
import { normalizeIntegerLiteralSchemas } from "../../../../scripts/vertex-native-contracts/portable.ts";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import { VertexResearchChatParticipantConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import { handleApiRequest } from "./handler.ts";
import type { ApiContext } from "./context.ts";
import {
  CONTRACTS_URL_DISTRIBUTIONS,
  pinnedPython,
  testPython,
} from "./research-python.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

// Finite SOURCE-native composition only. No bundle is generated or installed;
// production ContractAuthority's known source-set mismatch is not bypassed.
const TIMEOUT = scaledTimeout(120_000);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fixture = (
  extra: Partial<NonNullable<Parameters<typeof chatWorkerFixture>[0]>> = {}
) =>
  chatWorkerFixture({
    rendezvous: true,
    rightsObservation: true,
    participantId: "first-mate",
    admissionPath: "conversation",
    ...extra,
  });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const methods = [
  "currentRightsObservation",
  "acceptedEvidenceObservation",
] as const;
const sourceSchemas = {
  ...VERTEX_CONTRACT_SCHEMAS,
  ...VERTEX_CONTROL_CONTRACT_SCHEMAS,
  ...VERTEX_POLICY_CONTRACT_SCHEMAS,
  ...VERTEX_WORKER_CONTRACT_SCHEMAS,
};
const names = [
  "WorkerFence",
  "WorkerLease",
  "RuntimePolicySelection",
  "AcceptedReview",
  "WorkerCurrentRightsInput",
  "WorkerCurrentRightsOutput",
  "WorkerAcceptedEvidenceInput",
  "WorkerAcceptedEvidenceOutput",
  "WorkerCurrentRightsObservationInput",
  "WorkerCurrentRightsObservationOutput",
  "WorkerAcceptedEvidenceObservationInput",
  "WorkerAcceptedEvidenceObservationOutput",
] as const;
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const pinFor = (f: Fixture) =>
  VertexResearchChatParticipantConfigurationV1Schema.parse(f.config.value)
    .reviewPins[0]!;
const inputFor = (f: Fixture, method: string) => {
  const pin = pinFor(f);
  return method.startsWith("currentRights")
    ? {
        ...f.fence,
        collectionId: pin.collectionId,
        policyId: pin.rightsPolicyId,
        use: "read",
      }
    : {
        ...f.fence,
        collectionId: pin.collectionId,
        evidenceId: pin.evidenceId,
      };
};
const contextFor = (f: Fixture): ApiContext =>
  ({
    vertexWorker: {
      store: f.worker,
      clock: f.clock,
      claim: async () => {
        throw new Error("No second claim");
      },
    },
    workerRequest: {
      headers: new Headers({ authorization: `Bearer ${f.workerToken}` }),
    },
  }) as unknown as ApiContext;
const responseFor = (
  f: Fixture,
  method: string,
  input: unknown = inputFor(f, method)
) =>
  handleApiRequest(
    new Request(`https://test.invalid/api/orpc/vertexWorker/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    }),
    contextFor(f)
  );
const readRpc = async (f: Fixture, method: string, input?: unknown) => {
  const response = await responseFor(f, method, input);
  expect(response.status).toBe(200);
  return ((await response.json()) as { json: any }).json;
};
const originalRows = (f: Fixture) =>
  canonicalArtifactJson({
    rights: f.table("vertex_rights_versions"),
    artifacts: f.table("vertex_artifacts"),
  });
const advance = (f: Fixture) => {
  const next = timestampToEpochNanoseconds(f.state.at) + 1_000_000n;
  const seconds = next / 1_000_000_000n,
    nanos = next % 1_000_000_000n;
  f.state.at = new Date(Number(seconds) * 1000)
    .toISOString()
    .replace(/\.000Z$/, `.${nanos.toString().padStart(9, "0")}Z`);
  return f.state.at;
};

const sourceNative = async (f: Fixture) => {
  const artifacts: Record<string, string> = {};
  for (const binding of f.selection.artifacts) {
    const object = [...f.objects.values()].find(
      (entry) => entry.id === binding.artifact.artifactId
    );
    if (object) artifacts[binding.artifact.artifactId] = b64(object.body);
  }
  const schemas = Object.fromEntries(
    names.map((name) => [
      name,
      normalizeIntegerLiteralSchemas(
        z.toJSONSchema(sourceSchemas[name], { io: "input" })
      ),
    ])
  );
  const semantics = JSON.parse(
    await readFile(
      resolve(root, "scripts/vertex-native-contracts/invariants-v1.json"),
      "utf8"
    )
  );
  const samples: string[] = [],
    calls: string[] = [];
  f.clock.now = () => {
    const at = advance(f);
    samples.push(at);
    return at;
  };
  const child = spawn(
    testPython,
    [
      resolve(
        root,
        "services/control-client/tests/rights_observation_stdio.py"
      ),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: [
          "research",
          "control-client",
          "market-data",
          "execution",
          "contracts/python/src",
        ]
          .map((name) => resolve(root, "services", name))
          .join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const stop = setTimeout(() => child.kill(), 100_000);
  let stderr = "",
    completed: any = null;
  child.stderr.on("data", (chunk) => {
    return (stderr = (stderr + String(chunk)).slice(-4000));
  });
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once("exit", resolveExit);
    return child.once("error", reject);
  });
  child.stdin.write(
    `${JSON.stringify({
      schemas,
      semantics,
      selection: f.selection,
      artifacts,
      lease: f.lease,
      recipe: f.recipe,
      pin: pinFor(f),
    })}\n`
  );
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.kind === "done") {
        completed = message;
        break;
      }
      let value: unknown;
      if (message.kind === "clock") {
        value = advance(f);
      } else if (message.kind === "worker") {
        expect(["currentRights", "acceptedEvidence", ...methods]).toContain(
          message.method
        );
        calls.push(message.method);
        const before = samples.length;
        const response = await responseFor(f, message.method, message.input);
        const body = await response.text();
        if (response.ok && methods.includes(message.method)) {
          const wrapper = JSON.parse(body).json;
          // finish's ensureCurrent sample precedes grant's completedAt sample
          // and the final original-authority sample. Never stamp either later one.
          expect(samples.length - before).toBeGreaterThanOrEqual(4);
          expect(wrapper.observedAt).toBe(samples.at(-3));
          const rights =
            message.method === "currentRightsObservation"
              ? wrapper.value
              : wrapper.value.rights;
          expect(timestampToEpochNanoseconds(rights.checkedAt)).toBeLessThan(
            timestampToEpochNanoseconds(wrapper.observedAt)
          );
        }
        value = { status: response.status, body, receiptAt: advance(f) };
      } else throw new Error("Unexpected source-native bridge request");
      child.stdin.write(`${JSON.stringify({ ok: true, value })}\n`);
    }
    child.stdin.end();
    expect(await exited, stderr).toBe(0);
    expect(completed?.kind).toBe("done");
    return { completed, calls };
  } finally {
    clearTimeout(stop);
    child.kill();
    child.stdin.destroy();
  }
};

describe("local rights observation source boundary", () => {
  it(
    "advances through pinned v2 loader Job factory both RPC owners and native source validators",
    async ({ skip }) => {
      // Native semantics validate URLs through the pinned WHATWG backend.
      const validator = pinnedPython(CONTRACTS_URL_DISTRIBUTIONS);
      skip(validator.skip, validator.note);
      const f = await fixture(),
        before = originalRows(f);
      const legacyRights = WorkerCurrentRightsOutputSchema.parse(
        await readRpc(f, "currentRights")
      );
      const legacyEvidence = WorkerAcceptedEvidenceOutputSchema.parse(
        await readRpc(f, "acceptedEvidence")
      );
      expect(
        WorkerCurrentRightsOutputSchema.safeParse({
          ...legacyRights,
          observedAt: f.state.at,
        }).success
      ).toBe(false);
      expect(
        WorkerAcceptedEvidenceOutputSchema.safeParse({
          ...legacyEvidence,
          observedAt: f.state.at,
        }).success
      ).toBe(false);
      const result = await sourceNative(f);
      expect(result.completed.boundary).toBe(
        "source-native-core-not-installed-ContractAuthority"
      );
      expect(result.completed.mode).toBe("local-observation-v1");
      expect(result.completed.legacyModes).toEqual([
        "legacy",
        "legacy",
        "legacy",
      ]);
      expect(result.completed.checks).toEqual([
        "older-history-fresh-current",
        "older-history-fresh-evidence",
        "second-model-pin-read",
        "stale-current",
        "future-current",
        "missing-current",
        "wrong-format-current",
        "historical-after-observation-current",
        "expired-current",
        "retention-expired-current",
        "wrong-policy-current",
        "wrong-version-current",
        "per-use-version-change",
        "missing-schema-current",
        "missing-method-current",
        "stale-evidence",
        "future-evidence",
        "missing-evidence",
        "wrong-format-evidence",
        "historical-after-observation-evidence",
        "expired-evidence",
        "retention-expired-evidence",
        "expired-review",
        "wrong-hash-evidence",
        "changed-second-pin",
        "strict-legacy-current",
        "strict-legacy-evidence",
        "legacy-current-selection",
        "legacy-evidence-selection",
        "config-hash-rejection",
        "job-selection-rejection",
        "closed-profile-rejection",
      ]);
      expect(
        result.calls.filter(
          (method) => method === "acceptedEvidenceObservation"
        ).length
      ).toBeGreaterThanOrEqual(4);
      expect(originalRows(f)).toBe(before);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
      return expect(
        f.table("vertex_research_chat_model_privacy_candidates")
      ).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "admits pending prepare and read privacy eligibility for the pinned v2 profile without dispatch",
    async () => {
      const f = await fixture(),
        before = originalRows(f);
      expect(
        await readRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toMatchObject({ status: "not-observed", expiresAt: null });
      const pending = await readRpc(
        f,
        "prepareModelPrivacyReview",
        f.tokenizeRequest
      );
      expect(pending).toMatchObject({
        status: "pending",
        requestId: f.tokenizeRequest.requestId,
        requestSha256: f.tokenizeRequest.requestSha256,
      });
      expect(
        await readRpc(f, "readModelPrivacyReview", f.tokenizeRequest)
      ).toEqual(pending);
      expect(
        f.table("vertex_research_chat_model_privacy_candidates")
      ).toHaveLength(1);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
      return expect(originalRows(f)).toBe(before);
    },
    TIMEOUT
  );
  it.each(["wrong-profile", "extra-field"] as const)(
    "rejects pinned rendezvous config %s at the actual server gate",
    async (mutation) => {
      const f = await fixture({ rendezvousConfigMutation: mutation }),
        before = originalRows(f);
      // Ordinary explicit observation authority remains valid; only the closed
      // rendezvous config discriminator/shape is invalid in these original bytes.
      await readRpc(f, "currentRightsObservation");
      for (const method of [
        "prepareModelPrivacyReview",
        "readModelPrivacyReview",
      ]) {
        expect((await responseFor(f, method, f.tokenizeRequest)).ok).toBe(
          false
        );
      }
      expect(
        f.table("vertex_research_chat_model_privacy_candidates")
      ).toHaveLength(0);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
      return expect(originalRows(f)).toBe(before);
    },
    TIMEOUT
  );
  it.each(methods)(
    "requires an explicit %s grant rather than legacy operation grants",
    async (method) => {
      const f = await fixture({ omitServiceOperation: method }),
        before = originalRows(f);
      const response = await responseFor(f, method);
      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
      expect(originalRows(f)).toBe(before);
      return expect(
        (await responseFor(f, method.replace("Observation", ""))).ok
      ).toBe(true);
    },
    TIMEOUT
  );
  it(
    "denies both observation methods after real service grant revocation",
    async () => {
      const f = await fixture(),
        before = originalRows(f);
      await readRpc(f, "currentRightsObservation");
      expect(
        await f.worker.revokeGrant(f.grantAdmin, scope, f.identity.grantId)
      ).toBe(true);
      for (const method of methods)
        expect((await responseFor(f, method)).ok).toBe(false);
      return expect(originalRows(f)).toBe(before);
    },
    TIMEOUT
  );
  it(
    "denies newer rights refusal without rewriting earlier immutable rights rows",
    async () => {
      const f = await fixture(),
        pin = pinFor(f);
      const granted = await readRpc(f, "currentRightsObservation");
      const originals = f
        .table("vertex_rights_versions")
        .map((row) => canonicalArtifactJson(row));
      advance(f);
      await f.store.putRights(
        { actorId: "fixture-grant-admin" },
        scope,
        pin.collectionId,
        {
          ...granted.value,
          version: "2.0.0",
          status: "denied",
          allowedUses: [],
          checkedAt: f.state.at,
        }
      );
      for (const method of methods)
        expect((await responseFor(f, method)).ok).toBe(false);
      const after = f
        .table("vertex_rights_versions")
        .map((row) => canonicalArtifactJson(row));
      for (const row of originals) expect(after).toContain(row);
      return expect(after).toHaveLength(originals.length + 1);
    },
    TIMEOUT
  );
  it(
    "commits original authority closure and denies observations at storage review expiry",
    async () => {
      const expiry = "2026-09-24T12:00:01.000000001Z";
      const f = await fixture({ storageReviewExpiresAt: expiry }),
        before = originalRows(f);
      await readRpc(f, "acceptedEvidenceObservation");
      // The external object reader advances time only after the original bytes
      // were read, forcing the real final original-authority check to close.
      f.state.afterRead = (id) => {
        const isEvidence = id === pinFor(f).artifactId;
        if (isEvidence) {
          return (f.state.at = expiry);
        }
        return;
      };
      expect((await responseFor(f, "acceptedEvidenceObservation")).ok).toBe(
        false
      );
      expect(f.state.at).toBe(expiry);
      expect((await responseFor(f, "currentRightsObservation")).ok).toBe(false);
      expect(
        f
          .table("vertex_research_chat_copy_domain_closures")
          .some((row) => row["response_request_id"] === f.responseRequestId)
      ).toBe(true);
      return expect(originalRows(f)).toBe(before);
    },
    TIMEOUT
  );
});
