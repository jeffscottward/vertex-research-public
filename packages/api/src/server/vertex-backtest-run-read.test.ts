import { describe, expect, it } from "vitest";
import { hashArtifact } from "@darkfactory/shared/vertex";
import { WorkerReadBacktestRunOutputSchema } from "../contracts/vertex-worker.ts";
import { actor, scope } from "./vertex-backtest-intent.test-support.ts";
import { backtestRunReadFixture } from "./vertex-backtest-run-read.test-support.ts";

type Fixture = Awaited<ReturnType<typeof backtestRunReadFixture>>;
const removeRow = (h: Fixture, table: string, artifactId: string) => {
  const rows = h.table(table);
  rows.splice(
    rows.findIndex((row) => row["artifact_id"] === artifactId),
    1
  );
};
// Reads may create empty fixture tables; only persisted rows are compared.
const persisted = (h: Fixture) =>
  new Map(
    [...h.tables]
      .filter(([, rows]) => rows.length > 0)
      .map(([name, rows]) => [name, structuredClone(rows)])
  );
const consumerRow = (h: Fixture) =>
  h
    .table("vertex_worker_jobs")
    .find((row) => row["job_id"] === h.consumer.job_id)!;
const isolationStage = (h: Fixture) =>
  h
    .table("vertex_worker_stages")
    .find((row) => row["artifact_id"] === h.expected.isolationId)!;

describe("worker readBacktestRun committed producer proof", () => {
  it("returns the exact committed run and its producer job to a running research job without writes", async () => {
    const h = await backtestRunReadFixture();
    const before = persisted(h);
    h.calls.length = 0;
    const output = await h.read();
    expect(WorkerReadBacktestRunOutputSchema.safeParse(output).success).toBe(
      true
    );
    const parsed = WorkerReadBacktestRunOutputSchema.parse(output);
    expect(parsed).toMatchObject({
      artifact: h.expected.completedRun,
      contentSha256: h.expected.completedRun.artifactSha256,
      canonicalSha256: h.expected.completedRun.artifactSha256,
      contentType: "application/json",
      // The producer, never the consuming fence.
      jobId: h.expected.jobId,
      collectionId: "ssrn",
      plannedRun: h.input.plannedRun,
      results: h.input.results,
      recipe: h.input.recipe,
      receipt: { artifactId: h.expected.receiptId },
      isolation: { artifactId: h.expected.isolationId },
    });
    expect(parsed.jobId).not.toBe(h.consumer.job_id);
    expect(JSON.parse(atob(parsed.contentBase64))).toEqual(
      h.expected.completedValue
    );
    expect(persisted(h)).toEqual(before);
    expect(h.calls.every((call) => /^select\b/i.test(call.sql.trim()))).toBe(
      true
    );
    // Selection is checked on entry and again by the final current checks.
    expect(h.policySelection).toHaveBeenCalledTimes(2);
    return expect(h.policySelection).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      {
        ...scope,
        selectionId: h.selection.selectionId,
        selectionSha256: h.selection.selectionSha256,
      },
      h.consumerGrant.servicePrincipalId,
      h.consumer.job_id
    );
  });
  it.each([
    ["consumer lease epoch", "stale"],
    ["consumer lease expiry", "stale"],
    ["consumer kind", "denied"],
    ["consumer state", "denied"],
    ["consumer selection", "unavailable"],
    ["actor authorization", "denied"],
  ] as const)(
    "refuses a changed %s before disclosing the run",
    async (kind, code) => {
      const h = await backtestRunReadFixture();
      if (kind === "consumer lease epoch") h.consumer.lease_epoch = "2";
      if (kind === "consumer lease expiry")
        h.access.at = h.consumer.payload.deadlineAt;
      if (kind === "consumer kind")
        h.consumer.payload = { ...h.consumer.payload, kind: "backtest" };
      if (kind === "consumer state") h.consumer.state = "leased";
      if (kind === "consumer selection")
        h.policySelection.mockRejectedValueOnce(
          new Error("Synthetic revoked selection")
        );
      if (kind === "actor authorization") h.access.allowed = false;
      await expect(h.read()).rejects.toMatchObject({ code });
      return expect(consumerRow(h)["state"]).toBe(
        kind === "consumer state" ? "leased" : "running"
      );
    }
  );
  it.each([
    ["empty producer outputs", "denied"],
    ["running producer", "denied"],
    ["missing producer outcome", "denied"],
    ["missing run record", "denied"],
    ["missing run stage", "denied"],
    ["missing run admission", "denied"],
    ["missing ownership pin", "denied"],
    ["missing selection row", "denied"],
    ["missing producer grant", "denied"],
    ["missing dataset row", "integrity"],
    ["missing backtest version", "integrity"],
    ["changed run lineage", "integrity"],
    ["changed result bytes", "integrity"],
    ["revoked rights", "denied"],
  ] as const)(
    "fails closed on %s instead of returning a partial run",
    async (kind, code) => {
      const h = await backtestRunReadFixture(),
        root = h.expected.completedRun.artifactId;
      if (kind === "empty producer outputs") h.job.output_artifact_ids = [];
      if (kind === "running producer") h.job.state = "running";
      if (kind === "missing producer outcome") h.job.outcome_hash = null;
      if (kind === "missing run record") removeRow(h, "vertex_records", root);
      if (kind === "missing run stage")
        removeRow(h, "vertex_worker_stages", root);
      if (kind === "missing run admission")
        h.table("vertex_worker_run_admissions").length = 0;
      if (kind === "missing ownership pin")
        h.table("vertex_policy_ownership_pins").length = 0;
      if (kind === "missing selection row")
        h.table("vertex_policy_selections").length = 0;
      if (kind === "missing producer grant")
        h.table("vertex_worker_service_grants").splice(0, 1);
      if (kind === "missing dataset row") h.table("vertex_datasets").length = 0;
      if (kind === "missing backtest version")
        h.table("vertex_backtest_versions").length = 0;
      if (kind === "changed run lineage")
        removeRow(h, "vertex_artifact_lineage", root);
      if (kind === "changed result bytes")
        h.objects.get(`stage-${h.input.results.artifactId}`)!.bytes[0] = 0;
      if (kind === "revoked rights")
        h.table("vertex_rights_versions").length = 0;
      h.calls.length = 0;
      await expect(h.read()).rejects.toMatchObject({ code });
      return expect(
        h.calls.every((call) => /^select\b/i.test(call.sql.trim()))
      ).toBe(true);
    }
  );
  it.each([
    ["duplicate reference", "integrity"],
    ["non-content run identity", "integrity"],
    ["other recipe digest", "denied"],
    ["other planned digest", "denied"],
    ["other results", "integrity"],
    ["foreign environment", "denied"],
  ] as const)("rejects a caller %s", async (kind, code) => {
    const h = await backtestRunReadFixture(),
      other = "b".repeat(64);
    const input = {
      "duplicate reference": { ...h.input, results: h.input.plannedRun },
      "non-content run identity": {
        ...h.input,
        artifact: { ...h.input.artifact, artifactId: "backtest-run-other" },
      },
      "other recipe digest": {
        ...h.input,
        recipe: { ...h.input.recipe, artifactSha256: other },
      },
      "other planned digest": {
        ...h.input,
        plannedRun: { ...h.input.plannedRun, artifactSha256: other },
      },
      "other results": {
        ...h.input,
        results: {
          artifactId: `backtest-results-${other}`,
          artifactSha256: other,
        },
      },
      "foreign environment": { ...h.input, environment: "paper" },
    }[kind];
    return await expect(h.read(undefined, input)).rejects.toMatchObject({
      code,
    });
  });
  it("rechecks rights after the last original isolation byte read", async () => {
    const h = await backtestRunReadFixture(),
      source = h.objectCapabilities(),
      isolation = isolationStage(h);
    let revoked = false;
    const worker = h.workerWith(() => ({
      getBounded: async (key: string) => {
        const result = await source.getBounded(key);
        if (key === isolation["object_key"]) {
          h.table("vertex_rights_versions").length = 0;
          revoked = true;
        }
        return result;
      },
    }));
    await expect(h.read(worker)).rejects.toMatchObject({ code: "denied" });
    return expect(revoked).toBe(true);
  });
  it("reports the canonical job that staged a fully rejoined graph, not the original producer", async () => {
    const h = await backtestRunReadFixture(),
      eventId = "unrelated-original-event",
      jobId = `job-${await hashArtifact({ scope, eventId })}`;
    const other = structuredClone(h.job);
    other.job_id = jobId;
    other.event_id = eventId;
    other.payload = { ...other.payload, jobId, eventId };
    const lease = other.payload;
    other.binding_hash = await hashArtifact({
      scope,
      eventId,
      kind: lease.kind,
      researchPrincipalId: lease.researchPrincipalId,
      payloadArtifactId: lease.payloadArtifactId,
      payloadSha256: lease.payloadSha256,
      policySelectionId: lease.policySelectionId,
      policySelectionSha256: lease.policySelectionSha256,
      deadlineAt: lease.deadlineAt,
    });
    h.table("vertex_worker_jobs").push(other);
    for (const row of h.table("vertex_worker_stages")) {
      if (row["job_id"] !== h.job.job_id) continue;
      row["job_id"] = jobId;
      row["payload"] = { ...row["payload"], jobId };
      row["request_hash"] = await hashArtifact(row["payload"]);
    }
    const admitted = structuredClone(
      h.table("vertex_worker_run_admissions")[0]!
    );
    h.table("vertex_worker_run_admissions").push({
      ...admitted,
      job_id: jobId,
      run_id: jobId,
    });
    const ownership = structuredClone(
      h.table("vertex_policy_ownership_pins")[0]!
    );
    ownership["holder_id"] = jobId;
    ownership["payload"].holderId = jobId;
    ownership["record_hash"] = await hashArtifact(ownership["payload"]);
    h.table("vertex_policy_ownership_pins").push(ownership);
    const observed: string[] = [];
    const source = h.objectCapabilities();
    const worker = h.workerWith(() => ({
      getBounded: async (key: string) => {
        observed.push(key);
        return source.getBounded(key);
      },
    }));
    expect(await h.read(worker)).toMatchObject({
      jobId,
      artifact: h.expected.completedRun,
    });
    return expect(observed).toContain(isolationStage(h)["object_key"]);
  });
});

describe("research-run consumer fenced lifecycle operations", () => {
  it("renews only forward within the fixed deadline and persists the renewed lease", async () => {
    const h = await backtestRunReadFixture(),
      renewed = "2026-09-22T12:00:45Z";
    for (const leaseExpiresAt of [
      h.consumer.payload.leaseExpiresAt,
      "2026-09-22T12:00:55Z",
    ])
      await expect(
        h.invoke("renew", { ...h.fence, leaseExpiresAt })
      ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await h.invoke("renew", { ...h.fence, leaseExpiresAt: renewed })
    ).toMatchObject({
      status: "accepted",
      jobId: h.consumer.job_id,
      state: "running",
    });
    const row = consumerRow(h);
    expect(row["lease_expires_at_ns"]).toBe(
      (BigInt(Date.parse(renewed)) * 1_000_000n).toString()
    );
    return expect(row["payload"]).toMatchObject({
      leaseExpiresAt: renewed,
      deadlineAt: h.consumer.payload.deadlineAt,
    });
  });
  it("records readiness once, replays the exact observation and refuses older changed ones", async () => {
    const h = await backtestRunReadFixture();
    const observation = {
      ...h.fence,
      state: "ready" as const,
      capabilityIds: ["capability-one"],
      observedAt: h.access.at,
    };
    expect(await h.invoke("readiness", observation)).toMatchObject({
      status: "accepted",
    });
    expect(h.table("vertex_worker_readiness")).toHaveLength(1);
    expect(await h.invoke("readiness", observation)).toMatchObject({
      status: "duplicate",
    });
    await expect(
      h.invoke("readiness", { ...observation, state: "draining" })
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      h.invoke("readiness", {
        ...observation,
        observedAt: "2026-09-22T12:00:30Z",
      })
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(h.table("vertex_worker_readiness")).toHaveLength(1);
  });
  it("reads committed and staged originals only by exact identity in the requested collection", async () => {
    const h = await backtestRunReadFixture();
    const committed = await h.invoke("readArtifact", {
      ...h.fence,
      collectionId: "ssrn",
      artifactId: h.expected.completedRun.artifactId,
    });
    expect(committed).toMatchObject({
      artifact: h.expected.completedRun,
      contentSha256: h.expected.completedRun.artifactSha256,
      contentType: "application/json",
    });
    expect(
      JSON.parse(atob((committed as { contentBase64: string }).contentBase64))
    ).toEqual(h.expected.completedValue);
    // Another job's uncommitted stage is never readable by this research job.
    await expect(
      h.invoke("readArtifact", {
        ...h.fence,
        collectionId: "ssrn",
        artifactId: h.input.results.artifactId,
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.invoke("readArtifact", {
        ...h.fence,
        collectionId: null,
        artifactId: h.expected.completedRun.artifactId,
      })
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("returns only the leased policy selection", async () => {
    const h = await backtestRunReadFixture();
    const selected = {
      ...h.fence,
      selectionId: h.selection.selectionId,
      selectionSha256: h.selection.selectionSha256,
    };
    expect(await h.invoke("policySelection", selected)).toEqual(h.selection);
    await expect(
      h.invoke("policySelection", {
        ...selected,
        selectionSha256: "b".repeat(64),
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(h.policySelection).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["no active snapshot", null, "unavailable"],
    ["no committed generation", "snapshot", "integrity"],
  ] as const)(
    "reads no collection with %s",
    async (_kind, snapshotId, code) => {
      const h = await backtestRunReadFixture();
      return await expect(
        h.invoke("readCollection", {
          ...h.fence,
          collectionId: "ssrn",
          snapshotId,
        })
      ).rejects.toMatchObject({ code });
    }
  );
});
