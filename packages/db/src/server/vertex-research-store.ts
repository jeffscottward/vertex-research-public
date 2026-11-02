import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  array,
  collectionId,
  collectionKey,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  rows,
  scopeWhere,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexArtifactReference,
  VertexImmutableInput,
  VertexPrincipal,
  VertexPublicationInput,
  VertexPublicationResult,
  VertexRecord,
  VertexRecordResult,
  VertexRightsRecord,
  VertexScope,
  VertexStore,
} from "./vertex-ports.ts";

const immutableIdentity = (
  name: VertexImmutableInput["contractName"],
  record: VertexRecord,
  artifactSha256: string
): Readonly<{ id: string; version: string }> => {
  const keys = {
    StrategySpec: "strategyId",
    BacktestRun: "runId",
    AgentRun: "runId",
    ModuleManifest: "moduleId",
    DatasetManifest: "datasetId",
    ResearchEvidence: "evidenceId",
    TradeIntent: "intentId",
  } as const;
  // Run status snapshots are append-only digest revisions, not updates of the
  // schema-version row. Relationships always pin the sealed artifact identity.
  const version =
    name === "BacktestRun" || name === "AgentRun"
      ? artifactSha256
      : string(record["version"] ?? record["schemaVersion"]);
  return { id: identifier(record[keys[name]]), version };
};

// Private worker-only injection, never a public argument or generic fallback.
// The worker resolves exact selected v3 dataset ID/hash/scope plus current
// source review/rights before returning a committed global manifest parent.
export type WorkerLineageParentResolver = (
  collection: string | null,
  id: string,
  use: "read" | "derive",
  at: string
) => Promise<import("./vertex-ports.ts").VertexArtifactMetadata | null>;

export const createResearchOperations = (
  ctx: PersistenceContext,
  workerParent?: WorkerLineageParentResolver
) => {
  const relation = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    artifactId: string,
    target: string,
    kind: string,
    at: string
  ): Promise<void> => {
    const found = await one(
      tx,
      "vertex_records",
      scope,
      sql`artifact_id = ${target}`
    );
    if (!found) fail("integrity");
    const targetCollection = collectionId(
      requirePresent(found, "found")["collection_key"]
    );
    if (targetCollection !== null && targetCollection !== collection)
      fail("denied");
    if (
      !(await ctx.artifact(
        tx,
        principal,
        scope,
        targetCollection,
        target,
        "derive",
        at
      ))
    )
      fail("integrity");
    await insert(tx, "vertex_record_relationships", scope, {
      artifact_id: artifactId,
      related_artifact_id: target,
      relationship: kind,
    });
  };
  const resolveRecord = async (
    tx: Transaction,
    scope: VertexScope,
    collection: string | null,
    name: string,
    id: string
  ): Promise<string> => {
    const found = await one(
      tx,
      "vertex_records",
      scope,
      sql`contract_name = ${name} and record_id = ${id} and collection_key = ${collectionKey(collection)}`
    );
    if (!found) return fail("integrity");
    return string(found["artifact_id"]);
  };
  const record = async (
    tx: Transaction,
    input: VertexImmutableInput,
    value: VertexRecord,
    at: string,
    privateOutputId: string | null = null
  ): Promise<VertexRecordResult> => {
    const {
      principal,
      scope,
      collectionId: collection,
      artifact: reference,
      contractName,
    } = input;
    identifier(input.idempotencyKey);
    ctx.scoped(value, scope);
    if (
      contractName === "ResearchEvidence" &&
      value["collectionId"] !== collection
    )
      fail("denied");
    // Source/import acceptance flags cannot manufacture authenticated review
    // authority. Effective acceptance is a current immutable review overlay.
    if (
      contractName === "ResearchEvidence" &&
      value["acceptanceStatus"] === "accepted"
    )
      fail("denied");
    const metadata = await ctx.sealed(
      tx,
      principal,
      scope,
      collection,
      reference,
      contractName,
      value,
      at
    );
    const identity = immutableIdentity(
      contractName,
      value,
      metadata.artifactSha256
    );
    const requestHash = await ctx.hash({
      scope,
      collectionId: collection,
      contractName,
      record: value,
      artifact: reference,
    });
    const previousRequest = await one(
      tx,
      "vertex_record_idempotency",
      scope,
      sql`collection_key = ${collectionKey(collection)} and idempotency_key = ${input.idempotencyKey}`
    );
    if (previousRequest) {
      if (previousRequest["request_hash"] !== requestHash) fail("conflict");
      return {
        status: "duplicate",
        recordId: identity.id,
        artifactId: reference.artifactId,
      };
    }
    const existing = await one(
      tx,
      "vertex_records",
      scope,
      sql`contract_name = ${contractName} and record_id = ${identity.id} and version = ${identity.version} and collection_key = ${collectionKey(collection)}`
    );
    if (
      existing &&
      (existing["record_hash"] !== metadata.artifactSha256 ||
        existing["artifact_id"] !== reference.artifactId)
    )
      fail("conflict");
    if (!existing) {
      await insert(tx, "vertex_records", scope, {
        collection_key: collectionKey(collection),
        contract_name: contractName,
        record_id: identity.id,
        version: identity.version,
        artifact_id: reference.artifactId,
        artifact_sha256: reference.artifactSha256,
        record_hash: metadata.artifactSha256,
        recorded_at: at,
        payload: value,
      });
      if (contractName === "StrategySpec") {
        const limits = object(value["riskLimits"]);
        const schedule = object(value["signalSchedule"]);
        await insert(tx, "vertex_strategy_versions", scope, {
          artifact_id: reference.artifactId,
          strategy_id: identity.id,
          version: value["version"],
          sleeve: value["sleeve"],
          code_digest: value["codeDigest"],
          maximum_loss: limits["maximumLoss"],
          maximum_notional: limits["maximumNotional"],
          maximum_positions: String(limits["maximumPositions"]),
          signal_calendar: schedule["calendar"],
          signal_interval: schedule["interval"],
        });
      }
      if (contractName === "BacktestRun") {
        const training = object(value["trainingWindow"]);
        const test = object(value["testWindow"]);
        await insert(tx, "vertex_backtest_versions", scope, {
          artifact_id: reference.artifactId,
          run_id: identity.id,
          strategy_artifact_id: value["strategyVersion"],
          seed: String(value["seed"]),
          engine_version: value["engineVersion"],
          results_ref: value["resultsRef"],
          review_status: value["reviewStatus"],
          validation_mode: value["validationMode"],
          forward_sample_count: String(value["forwardSampleCount"]),
          training_start: training["startAtInclusive"],
          training_end: training["endAtExclusive"],
          test_start: test["startAtInclusive"],
          test_end: test["endAtExclusive"],
          benchmark: value["benchmark"],
        });
      }
      if (contractName === "AgentRun") {
        await insert(tx, "vertex_agent_versions", scope, {
          artifact_id: reference.artifactId,
          run_id: identity.id,
          agent_role: value["agentRole"],
          task_contract: value["taskContract"],
          model_version: value["modelVersion"],
          token_budget: String(value["tokenBudget"]),
          cost_budget_usd: value["costBudgetUsd"],
          status: value["status"],
        });
      }
      if (contractName === "ModuleManifest") {
        await insert(tx, "vertex_module_versions", scope, {
          artifact_id: reference.artifactId,
          module_id: identity.id,
          version: value["version"],
          input_schema_version: value["inputSchemaVersion"],
          output_schema_version: value["outputSchemaVersion"],
          risk_policy_version: value["riskPolicyVersion"],
          artifact_digest: value["artifactDigest"],
          lifecycle_state: value["lifecycleState"],
          runtime: value["runtime"],
        });
        for (const capability of new Set(array(value["capabilities"], 6))) {
          await insert(tx, "vertex_module_capabilities", scope, {
            artifact_id: reference.artifactId,
            capability,
          });
        }
      }
      const instruments =
        contractName === "StrategySpec"
          ? array(value["universe"])
          : contractName === "DatasetManifest"
            ? array(value["instrumentUniverse"])
            : contractName === "TradeIntent"
              ? [value["instrumentId"]]
              : [];
      for (const instrumentId of instruments) {
        identifier(instrumentId);
        await tx.execute(
          sql`insert into vertex_instruments (account_alias,environment,instrument_id,observed_at) values (${scope.accountAlias},${scope.environment},${instrumentId},${at}) on conflict (account_alias,environment,instrument_id) do nothing`
        );
        await insert(tx, "vertex_record_instruments", scope, {
          artifact_id: reference.artifactId,
          instrument_id: instrumentId,
          relationship:
            contractName === "TradeIntent" ? "proposed-instrument" : "universe",
        });
      }
      if (contractName === "DatasetManifest") {
        await insert(tx, "vertex_datasets", scope, {
          collection_key: collectionKey(collection),
          dataset_id: identity.id,
          artifact_id: reference.artifactId,
          provider: value["provider"],
          content_hash: value["contentHash"],
          capture_time: value["captureTime"],
          as_of_at: value["asOfAt"],
          storage_ref: value["storageRef"],
          entitlement_policy_id: value["entitlementPolicyId"],
          retention_policy: value["retentionPolicy"],
          data_vintage_id: value["dataVintageId"],
          data_vintage_status: value["dataVintageStatus"],
          start_at_inclusive: value["startAtInclusive"],
          end_at_exclusive: value["endAtExclusive"],
          adjustment_method: value["adjustmentMethod"],
          calendar: value["calendar"],
        });
        for (const [ordinal, source] of array(value["sources"]).entries()) {
          const sourceValue = object(source);
          await insert(tx, "vertex_dataset_sources", scope, {
            dataset_id: identity.id,
            source_ordinal: ordinal,
            source_id: sourceValue["sourceId"],
            source_snapshot_id: sourceValue["snapshotId"],
            provider: sourceValue["provider"],
            content_hash: sourceValue["contentHash"],
          });
        }
      }
      if (contractName === "ResearchEvidence") {
        await insert(tx, "vertex_evidence", scope, {
          collection_id: collection,
          snapshot_id: value["snapshotId"],
          evidence_id: identity.id,
          artifact_id: reference.artifactId,
          source_id: object(value["sourceIdentity"])["sourceId"],
          content_hash: value["contentHash"],
          claim: value["claim"],
          method: value["method"],
          acceptance_status: value["acceptanceStatus"],
        });
      }
      if (contractName === "BacktestRun" || contractName === "TradeIntent") {
        const strategy = await one(
          tx,
          "vertex_records",
          scope,
          sql`contract_name = 'StrategySpec' and artifact_id = ${identifier(value["strategyVersion"])}`
        );
        if (!strategy) fail("integrity");
        await relation(
          tx,
          principal,
          scope,
          collection,
          reference.artifactId,
          string(requirePresent(strategy, "strategy")["artifact_id"]),
          "strategy-version",
          at
        );
      }
      if (contractName === "TradeIntent") {
        for (const evidenceId of array(value["reasonEvidenceIds"])) {
          await relation(
            tx,
            principal,
            scope,
            collection,
            reference.artifactId,
            await resolveRecord(
              tx,
              scope,
              collection,
              "ResearchEvidence",
              identifier(evidenceId)
            ),
            "intent-evidence",
            at
          );
        }
      }
      if (contractName === "BacktestRun") {
        for (const dataset of array(value["datasetManifestIds"])) {
          const target = await one(
            tx,
            "vertex_datasets",
            scope,
            sql`dataset_id = ${identifier(dataset)}`
          );
          if (!target) fail("integrity");
          await relation(
            tx,
            principal,
            scope,
            collection,
            reference.artifactId,
            string(requirePresent(target, "target")["artifact_id"]),
            "dataset",
            at
          );
        }
        for (const check of array(value["leakageChecks"], 5)) {
          const evidenceId = object(check)["evidenceId"];
          if (evidenceId !== null) {
            await relation(
              tx,
              principal,
              scope,
              collection,
              reference.artifactId,
              await resolveRecord(
                tx,
                scope,
                collection,
                "ResearchEvidence",
                identifier(evidenceId)
              ),
              `leakage-${string(object(check)["kind"])}`,
              at
            );
          }
        }
      }
      if (contractName === "AgentRun") {
        for (const evidenceId of array(value["inputEvidenceIds"])) {
          await relation(
            tx,
            principal,
            scope,
            collection,
            reference.artifactId,
            await resolveRecord(
              tx,
              scope,
              collection,
              "ResearchEvidence",
              identifier(evidenceId)
            ),
            "input-evidence",
            at
          );
        }
        for (const artifactId of array(value["outputArtifactIds"])) {
          if (artifactId !== privateOutputId) {
            await relation(
              tx,
              principal,
              scope,
              collection,
              reference.artifactId,
              identifier(artifactId),
              "output-artifact",
              at
            );
          }
        }
      }
    }
    await insert(tx, "vertex_record_idempotency", scope, {
      collection_key: collectionKey(collection),
      idempotency_key: input.idempotencyKey,
      request_hash: requestHash,
      record_id: identity.id,
      artifact_id: reference.artifactId,
    });
    return {
      status: existing ? "duplicate" : "recorded",
      recordId: identity.id,
      artifactId: reference.artifactId,
    };
  };

  // Server-only capability: the resolver must commit the SAME staged private
  // profile and its terminal-run link in this transaction. Ordinary immutable
  // publication never receives this capability and still requires public refs.
  const recordPrivateAgent = async (
    input: VertexImmutableInput,
    privateArtifactId: string,
    commitProfile: (
      tx: Transaction,
      at: string,
      run: VertexRecord
    ) => Promise<void>
  ): Promise<VertexRecordResult> => {
    if (input.contractName !== "AgentRun") fail("invalid");
    identifier(privateArtifactId);
    const value = await ctx.validate("AgentRun", input.record);
    const outputs = array(value["outputArtifactIds"]);
    if (
      !["completed", "blocked", "failed", "cancelled"].includes(
        string(value["status"])
      )
    )
      fail("invalid");
    if (
      value["status"] === "completed"
        ? outputs.length !== 1 || outputs[0] !== privateArtifactId
        : outputs.length !== 0
    )
      fail("integrity");
    return ctx.run(
      input.principal,
      input.scope,
      input.collectionId,
      identifier(input.artifact.artifactId),
      "publish",
      async (tx, at) => {
        await commitProfile(tx, at, value);
        return record(tx, input, value, at, privateArtifactId);
      }
    );
  };

  const putRights: VertexStore["putRights"] = async (
    principal,
    scope,
    collection,
    input
  ) => {
    const value = structuredClone(input);
    return await ctx.run(
      principal,
      scope,
      collection,
      identifier(value.policyId),
      "manage-rights",
      async (tx, at) => {
        ctx.rightsShape(value, at);
        const hash = await ctx.hash(value);
        const prior = await one(
          tx,
          "vertex_rights_versions",
          scope,
          sql`collection_key = ${collectionKey(collection)} and policy_id = ${value.policyId} and version = ${value.version}`
        );
        if (prior) {
          if (prior["record_hash"] !== hash) fail("conflict");
          return;
        }
        const latest = await ctx.latestRights(
          tx,
          scope,
          collection,
          value.policyId
        );
        if (latest) {
          if (time(value.checkedAt) < BigInt(string(latest["checked_at_ns"])))
            fail("conflict");
          const oldParts = string(latest["version"]).split(".").map(BigInt);
          const newParts = value.version.split(".").map(BigInt);
          let increasing = false;
          for (let i = 0; i < 3; i++) {
            if (
              requirePresent(newParts[i], "newParts[i]") <
              requirePresent(oldParts[i], "oldParts[i]")
            )
              fail("conflict");
            if (
              requirePresent(newParts[i], "newParts[i]") >
              requirePresent(oldParts[i], "oldParts[i]")
            ) {
              increasing = true;
              break;
            }
          }
          if (!increasing) fail("conflict");
        }
        await ctx.ensureAccount(tx, scope, at);
        return await insert(tx, "vertex_rights_versions", scope, {
          collection_key: collectionKey(collection),
          policy_id: value.policyId,
          version: value.version,
          revision: latest
            ? (BigInt(string(latest["revision"])) + 1n).toString()
            : "1",
          status: value.status,
          checked_at_ns: time(value.checkedAt).toString(),
          expires_at_ns:
            value.expiresAt === null ? null : time(value.expiresAt).toString(),
          retention_until_ns:
            value.retentionUntil === null
              ? null
              : time(value.retentionUntil).toString(),
          record_hash: hash,
          payload: value,
        });
      }
    );
  };
  const getRights: VertexStore["getRights"] = async (
    principal,
    scope,
    collection,
    policyId
  ) => {
    return await ctx.run(
      principal,
      scope,
      collection,
      identifier(policyId),
      "read",
      async (tx) => {
        const found = await ctx.latestRights(tx, scope, collection, policyId);
        if (!found) return null;
        if ((await ctx.hash(found["payload"])) !== found["record_hash"])
          return fail("integrity");
        return structuredClone(
          object(found["payload"])
        ) as unknown as VertexRightsRecord;
      }
    );
  };
  const registerArtifact: VertexStore["registerArtifact"] = async (
    principal,
    input
  ) => {
    const metadata = structuredClone(input);
    return await ctx.run(
      principal,
      metadata.scope,
      metadata.collectionId,
      identifier(metadata.artifactId),
      "publish",
      async (tx, at) => {
        const { scope, collectionId: collection } = metadata;
        digestString(metadata.artifactSha256);
        if (metadata.sourceContentSha256 !== null)
          digestString(metadata.sourceContentSha256);
        if (
          metadata.schemaVersion !== "1.0.0" ||
          ![
            "TradeIntent",
            "DatasetManifest",
            "ResearchEvidence",
            "KnowledgeImport",
            "StrategySpec",
            "BacktestRun",
            "AgentRun",
            "ModuleManifest",
            "ModuleManifestList",
            "EventEnvelope",
            "PortfolioSnapshot",
            "AcceptedReview",
            "PaperSimulationAdmission",
            "ExecutionProjection",
          ].includes(metadata.contractName)
        )
          fail("invalid");
        if (
          !Number.isSafeInteger(metadata.byteLength) ||
          metadata.byteLength < 0 ||
          typeof metadata.objectKey !== "string" ||
          metadata.objectKey.length === 0 ||
          metadata.objectKey.length > 2048 ||
          /[\u0000-\u001f\u007f]/.test(metadata.objectKey) ||
          typeof metadata.contentType !== "string" ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
            metadata.contentType
          )
        )
          fail("invalid");
        if (time(metadata.createdAt) > time(at)) fail("invalid");
        const lineage = array(metadata.lineageArtifactIds);
        if (
          new Set(lineage).size !== lineage.length ||
          lineage.includes(metadata.artifactId)
        )
          fail("invalid");
        await ctx.rights(tx, scope, collection, metadata.rights, "store", at);
        const policy = await one(
          tx,
          "vertex_rights_versions",
          scope,
          sql`collection_key = ${collectionKey(collection)} and policy_id = ${metadata.rights.policyId} and version = ${metadata.rights.version}`
        );
        if (
          !policy ||
          policy["record_hash"] !== (await ctx.hash(metadata.rights))
        )
          fail("integrity");
        const hash = await ctx.hash(metadata);
        const prior = await one(
          tx,
          "vertex_artifacts",
          scope,
          sql`artifact_id = ${metadata.artifactId}`
        );
        if (prior) {
          if (prior["metadata_hash"] !== hash) fail("conflict");
          return "duplicate" as const;
        }
        for (const parentId of lineage) {
          const parent = workerParent
            ? await workerParent(collection, identifier(parentId), "derive", at)
            : await ctx.artifact(
                tx,
                principal,
                scope,
                collection,
                identifier(parentId),
                "derive",
                at
              );
          if (!parent) fail("integrity");
        }
        await ctx.ensureAccount(tx, scope, at);
        await insert(tx, "vertex_artifacts", scope, {
          collection_key: collectionKey(collection),
          artifact_id: metadata.artifactId,
          object_key: metadata.objectKey,
          artifact_sha256: metadata.artifactSha256,
          source_content_sha256: metadata.sourceContentSha256,
          byte_length: String(metadata.byteLength),
          content_type: metadata.contentType,
          contract_name: metadata.contractName,
          schema_version: metadata.schemaVersion,
          rights_policy_id: metadata.rights.policyId,
          rights_version: metadata.rights.version,
          created_at: metadata.createdAt,
          created_at_ns: time(metadata.createdAt).toString(),
          metadata_hash: hash,
          payload: metadata,
        });
        for (const parentId of lineage) {
          await insert(tx, "vertex_artifact_lineage", scope, {
            artifact_id: metadata.artifactId,
            parent_artifact_id: parentId,
          });
        }
        return "recorded" as const;
      }
    );
  };
  const findArtifact: VertexStore["findArtifact"] = async (
    principal,
    scope,
    collection,
    artifactId
  ) => {
    return await ctx.run(
      principal,
      scope,
      collection,
      identifier(artifactId),
      "read",
      (tx, at) =>
        ctx.artifact(tx, principal, scope, collection, artifactId, "read", at)
    );
  };
  const recordImmutable: VertexStore["recordImmutable"] = async (input) => {
    const value = await ctx.validate(input.contractName, input.record);
    return ctx.run(
      input.principal,
      input.scope,
      input.collectionId,
      identifier(input.artifact.artifactId),
      "publish",
      (tx, at) => record(tx, input, value, at)
    );
  };
  const findDataset: VertexStore["findDataset"] = async (
    principal,
    scope,
    datasetId,
    collection = null
  ) => {
    return await ctx.run(
      principal,
      scope,
      collection,
      identifier(datasetId),
      "read",
      async (tx, at) => {
        const found = await one(
          tx,
          "vertex_datasets",
          scope,
          sql`dataset_id = ${datasetId} and collection_key = ${collectionKey(collection)}`
        );
        if (!found) return null;
        return ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          string(found["artifact_id"]),
          "read",
          at
        );
      }
    );
  };
  const findEvidence: VertexStore["findEvidence"] = async (
    principal,
    scope,
    collection,
    evidenceId
  ) => {
    return await ctx.run(
      principal,
      scope,
      collection,
      identifier(evidenceId),
      "read",
      async (tx, at) => {
        const found = await one(
          tx,
          "vertex_evidence",
          scope,
          sql`collection_id = ${collection} and evidence_id = ${evidenceId}`
        );
        if (!found) return null;
        return ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          string(found["artifact_id"]),
          "read",
          at
        );
      }
    );
  };
  const findModuleCatalog: VertexStore["findModuleCatalog"] = async (
    principal,
    scope
  ) => {
    return await ctx.run(
      principal,
      scope,
      null,
      "module-catalog",
      "read",
      async (tx, at) => {
        const found = await one(
          tx,
          "vertex_artifacts",
          scope,
          sql`collection_key = '' and contract_name = 'ModuleManifestList'`,
          sql`order by created_at_ns desc, artifact_id desc`
        );
        if (!found) return null;
        return ctx.artifact(
          tx,
          principal,
          scope,
          null,
          string(found["artifact_id"]),
          "read",
          at
        );
      }
    );
  };
  const getActiveCollectionSnapshot: VertexStore["getActiveCollectionSnapshot"] =
    async (principal, scope, collection) => {
      return await ctx.run(
        principal,
        scope,
        collection,
        collection,
        "read",
        async (tx, at) => {
          const active = await one(
            tx,
            "vertex_collections",
            scope,
            sql`collection_id = ${collection}`
          );
          if (!active || active["active_snapshot_id"] === null) return null;
          const generation = await one(
            tx,
            "vertex_collection_generations",
            scope,
            sql`collection_id = ${collection} and snapshot_id = ${active["active_snapshot_id"]}`
          );
          if (!generation) return fail("integrity");
          const shards = await rows(
            tx,
            sql`select * from vertex_collection_shards where ${scopeWhere(scope)} and collection_id = ${collection} and snapshot_id = ${active["active_snapshot_id"]} order by shard_ordinal limit 64`
          );
          if (shards.length !== generation["shard_count"]) fail("integrity");
          const references: VertexArtifactReference[] = [];
          for (const shard of shards) {
            const artifact = await ctx.artifact(
              tx,
              principal,
              scope,
              collection,
              string(shard["import_artifact_id"]),
              "read",
              at
            );
            if (
              !artifact ||
              artifact.artifactSha256 !== shard["import_artifact_sha256"]
            )
              fail("integrity");
            references.push({
              artifactId: requirePresent(artifact, "artifact").artifactId,
              artifactSha256: requirePresent(artifact, "artifact")
                .artifactSha256,
            });
          }
          if (
            (await ctx.hash(generation["payload"])) !==
            generation["request_hash"]
          )
            fail("integrity");
          return {
            snapshotId: string(active["active_snapshot_id"]),
            importArtifacts: references,
          };
        }
      );
    };

  const publication = async (
    input: VertexPublicationInput,
    enqueue: (
      tx: Transaction,
      principal: VertexPrincipal,
      scope: VertexScope,
      collection: string | null,
      event: VertexRecord,
      at: string
    ) => Promise<"recorded" | "duplicate">
  ): Promise<VertexPublicationResult> => {
    array(input.imports, 64);
    if (input.imports.length === 0) fail("invalid");
    array(input.evidence, 32_768);
    array(input.datasets, 32_768);
    identifier(input.idempotencyKey);
    const imports: {
      value: VertexRecord;
      artifact: VertexArtifactReference;
    }[] = [];
    for (const item of input.imports)
      imports.push({
        value: await ctx.validate("KnowledgeImport", item.record),
        artifact: structuredClone(item.artifact),
      });
    if (
      new Set(imports.map((item) => item.artifact.artifactId)).size !==
      imports.length
    )
      fail("invalid");
    const knowledge = requirePresent(imports[0], "imports[0]").value;
    if (knowledge["collectionId"] !== input.collectionId) fail("denied");
    for (const shard of imports) {
      for (const key of [
        "collectionId",
        "snapshotId",
        "rightsPolicyId",
        "contentClass",
        "transcriptQuality",
        "retrievalScope",
        "replacementScope",
        "untrustedContent",
      ]) {
        if (shard.value[key] !== knowledge[key]) fail("integrity");
      }
    }
    const sources = imports.flatMap((item) =>
      array(item.value["sourceIdentities"]).map(object)
    );
    const unavailable = imports.flatMap((item) =>
      array(item.value["unavailableSources"]).map(object)
    );
    const mappings = imports.flatMap((item) =>
      array(item.value["duplicateMappings"]).map(object)
    );
    const sourceMap = new Map(
      sources.map((source) => [source["sourceId"], source])
    );
    if (
      sourceMap.size !== sources.length ||
      new Set(unavailable.map((source) => source["sourceId"])).size !==
        unavailable.length ||
      unavailable.some((source) => sourceMap.has(source["sourceId"]))
    )
      fail("integrity");
    const evidence: {
      value: VertexRecord;
      artifact: VertexArtifactReference;
    }[] = [];
    const datasets: {
      value: VertexRecord;
      artifact: VertexArtifactReference;
    }[] = [];
    for (const item of input.evidence)
      evidence.push({
        value: await ctx.validate("ResearchEvidence", item.record),
        artifact: structuredClone(item.artifact),
      });
    if (evidence.some((item) => item.value["acceptanceStatus"] === "accepted"))
      fail("denied");
    for (const item of input.datasets)
      datasets.push({
        value: await ctx.validate("DatasetManifest", item.record),
        artifact: structuredClone(item.artifact),
      });
    if (
      new Set(evidence.map((item) => item.value["evidenceId"])).size !==
        evidence.length ||
      new Set(datasets.map((item) => item.value["datasetId"])).size !==
        datasets.length
    )
      fail("invalid");
    const descriptor = {
      scope: input.scope,
      collectionId: input.collectionId,
      expectedActiveSnapshotId: input.expectedActiveSnapshotId,
      snapshotId: knowledge["snapshotId"],
      importArtifacts: imports.map((item) => item.artifact),
      evidenceArtifacts: evidence.map((item) => item.artifact),
      datasetArtifacts: datasets.map((item) => item.artifact),
    };
    const requestHash = await ctx.hash(descriptor);
    return ctx.run(
      input.principal,
      input.scope,
      input.collectionId,
      input.collectionId,
      "publish",
      async (tx, at) => {
        const { principal, scope, collectionId: collection } = input;
        for (const shard of imports) {
          await ctx.sealed(
            tx,
            principal,
            scope,
            collection,
            shard.artifact,
            "KnowledgeImport",
            shard.value,
            at
          );
        }
        for (const item of [...evidence, ...datasets]) {
          const name =
            item.value["evidenceId"] === undefined
              ? "DatasetManifest"
              : "ResearchEvidence";
          await ctx.sealed(
            tx,
            principal,
            scope,
            collection,
            item.artifact,
            name,
            item.value,
            at
          );
        }
        const prior = await one(
          tx,
          "vertex_collection_generations",
          scope,
          sql`collection_id = ${collection} and (idempotency_key = ${input.idempotencyKey} or snapshot_id = ${knowledge["snapshotId"]})`
        );
        if (prior) {
          if (
            prior["request_hash"] !== requestHash ||
            prior["idempotency_key"] !== input.idempotencyKey
          )
            fail("conflict");
          return {
            status: "duplicate",
            snapshotId: string(prior["snapshot_id"]),
            previousSnapshotId:
              prior["previous_snapshot_id"] === null
                ? null
                : string(prior["previous_snapshot_id"]),
          };
        }
        const current = await one(
          tx,
          "vertex_collections",
          scope,
          sql`collection_id = ${collection}`
        );
        if (
          (current?.["active_snapshot_id"] ?? null) !==
          input.expectedActiveSnapshotId
        )
          fail("conflict");
        for (const item of evidence) {
          if (
            item.value["collectionId"] !== collection ||
            item.value["snapshotId"] !== knowledge["snapshotId"]
          )
            fail("integrity");
          const source = object(item.value["sourceIdentity"]);
          const preserved = sourceMap.get(source["sourceId"]);
          if (
            !preserved ||
            (await ctx.hash(preserved)) !== (await ctx.hash(source))
          )
            fail("integrity");
        }
        for (const item of datasets) {
          for (const source of array(item.value["sources"]).map(object)) {
            const preserved = sourceMap.get(source["sourceId"]);
            if (
              !preserved ||
              (await ctx.hash(preserved)) !== (await ctx.hash(source))
            )
              fail("integrity");
          }
        }
        await ctx.ensureAccount(tx, scope, at);
        if (!current)
          await insert(tx, "vertex_collections", scope, {
            collection_id: collection,
            active_snapshot_id: null,
            updated_at: at,
          });
        await insert(tx, "vertex_collection_generations", scope, {
          collection_id: collection,
          snapshot_id: knowledge["snapshotId"],
          previous_snapshot_id: input.expectedActiveSnapshotId,
          request_hash: requestHash,
          idempotency_key: input.idempotencyKey,
          shard_count: imports.length,
          published_at: at,
          payload: descriptor,
        });
        for (const [ordinal, shard] of imports.entries()) {
          await insert(tx, "vertex_collection_shards", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            shard_ordinal: ordinal,
            import_artifact_id: shard.artifact.artifactId,
            import_artifact_sha256: shard.artifact.artifactSha256,
          });
        }
        for (const source of sources) {
          await insert(tx, "vertex_source_identities", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            source_id: source["sourceId"],
            source_snapshot_id: source["snapshotId"],
            provider: source["provider"],
            content_hash: source["contentHash"],
            payload: source,
          });
        }
        for (const source of unavailable) {
          await insert(tx, "vertex_unavailable_sources", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            source_id: source["sourceId"],
            reason: source["reason"],
          });
        }
        for (const mapping of mappings) {
          await insert(tx, "vertex_duplicate_mappings", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            source_id: mapping["sourceId"],
            canonical_source_id: mapping["canonicalSourceId"],
            content_hash: mapping["contentHash"],
          });
        }
        for (const item of evidence) {
          await record(
            tx,
            {
              principal,
              scope,
              collectionId: collection,
              contractName: "ResearchEvidence",
              record: item.value,
              artifact: item.artifact,
              idempotencyKey: `publication-evidence-${await ctx.hash(item)}`,
            },
            item.value,
            at
          );
          await insert(tx, "vertex_claim_evidence", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            evidence_id: item.value["evidenceId"],
            source_id: object(item.value["sourceIdentity"])["sourceId"],
            artifact_id: item.artifact.artifactId,
          });
        }
        for (const item of datasets) {
          await record(
            tx,
            {
              principal,
              scope,
              collectionId: collection,
              contractName: "DatasetManifest",
              record: item.value,
              artifact: item.artifact,
              idempotencyKey: `publication-dataset-${await ctx.hash(item)}`,
            },
            item.value,
            at
          );
          await insert(tx, "vertex_collection_datasets", scope, {
            collection_id: collection,
            snapshot_id: knowledge["snapshotId"],
            dataset_id: item.value["datasetId"],
          });
        }
        const changed = await rows(
          tx,
          sql`update vertex_collections set active_snapshot_id = ${knowledge["snapshotId"]}, updated_at = ${at} where ${scopeWhere(scope)} and collection_id = ${collection} and active_snapshot_id is not distinct from ${input.expectedActiveSnapshotId} returning active_snapshot_id`
        );
        if (changed.length !== 1) fail("conflict");
        for (const [ordinal, shard] of imports.entries()) {
          const eventIdentity = {
            schemaVersion: "1.0.0",
            eventType: "knowledge.imported",
            occurredAt: at,
            effectiveAt: at,
            correlationId: `publication-${requestHash}`,
            causationId: null,
            actorId: principal.actorId,
            moduleId: "vertex-persistence",
            moduleVersion: "1.0.0",
            environment: scope.environment,
            idempotencyKey: `publication-${requestHash}-${ordinal}`,
            payload: shard.value,
          };
          const event = await ctx.validate("EventEnvelope", {
            ...eventIdentity,
            eventId: `event-${await ctx.hash(eventIdentity)}`,
            receivedAt: at,
          });
          await enqueue(tx, principal, scope, collection, event, at);
        }
        return {
          status: "published",
          snapshotId: identifier(knowledge["snapshotId"]),
          previousSnapshotId: input.expectedActiveSnapshotId,
        };
      }
    );
  };
  return {
    putRights,
    getRights,
    registerArtifact,
    findArtifact,
    recordImmutable,
    recordPrivateAgent,
    findDataset,
    findEvidence,
    findModuleCatalog,
    getActiveCollectionSnapshot,
    publication,
  };
};
