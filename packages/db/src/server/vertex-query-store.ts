import { type SQL, sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  collectionId,
  collectionKey,
  fail,
  identifier,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexArtifactListInput,
  VertexArtifactMetadata,
  VertexImmutableInput,
  VertexPage,
  VertexPageOptions,
  VertexPrincipal,
  VertexRecord,
  VertexRecordLookup,
  VertexScope,
  VertexScopedRecordListInput,
  VertexStore,
} from "./vertex-ports.ts";
import { VertexStoreError } from "./vertex-ports.ts";

const SCAN_LIMIT = 1000;
const contracts: readonly VertexImmutableInput["contractName"][] = [
  "StrategySpec",
  "BacktestRun",
  "AgentRun",
  "ModuleManifest",
  "DatasetManifest",
  "ResearchEvidence",
  "TradeIntent",
];
const name = (value: unknown): VertexImmutableInput["contractName"] => {
  if (
    typeof value !== "string" ||
    !contracts.includes(value as VertexImmutableInput["contractName"])
  )
    return fail("invalid");
  return value as VertexImmutableInput["contractName"];
};
const exact = (value: unknown, allowed: readonly string[]): VertexRecord => {
  const input = object(value);
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("invalid");
  return input;
};
const pageOptions = (input: VertexPageOptions): VertexPageOptions => {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor !== null &&
      (typeof input.cursor !== "string" || input.cursor.length > 4096))
  )
    fail("invalid");
  return { limit: input.limit, cursor: input.cursor };
};
const denied = (error: unknown): boolean =>
  error instanceof VertexStoreError && error.code === "denied";

// Cursors are opaque pagination positions, NOT authority tokens. Only previously
// returned authorized IDs enter them. Every subsequent row is reauthorized;
// changing cursor position cannot grant visibility. Binding prevents cross-actor,
// account, collection, filter or operation reuse. No database/provider secret.
const decodeCursor = (value: string | null, binding: string): string | null => {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096)
      return fail("invalid");
    const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded: unknown = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))
    );
    const cursor = exact(decoded, ["version", "binding", "after"]);
    if (
      Object.keys(cursor).length !== 3 ||
      cursor["version"] !== 1 ||
      cursor["binding"] !== binding
    )
      return fail("invalid");
    return identifier(cursor["after"]);
  } catch {
    return fail("invalid");
  }
};
const encodeCursor = (binding: string, after: string): string =>
  btoa(JSON.stringify({ version: 1, binding, after }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/g, "");

export const createQueryOperations = (ctx: PersistenceContext) => {
  const binding = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    operation: string,
    filters: unknown
  ): Promise<string> =>
    ctx.hash({ actorId: principal.actorId, scope, operation, filters });
  const publishedRecord = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    record: Row,
    at: string
  ): Promise<VertexArtifactMetadata | null> => {
    const artifactId = identifier(record["artifact_id"]);
    const collection = collectionId(record["collection_key"]);
    const contractName = name(record["contract_name"]);
    const metadata = await ctx.artifact(
      tx,
      principal,
      scope,
      collection,
      artifactId,
      "read",
      at
    );
    if (!metadata) fail("integrity");
    if (
      requirePresent(metadata, "metadata").contractName !== contractName ||
      requirePresent(metadata, "metadata").artifactSha256 !==
        record["artifact_sha256"] ||
      record["record_hash"] !==
        requirePresent(metadata, "metadata").artifactSha256 ||
      (await ctx.hash(record["payload"])) !== record["record_hash"]
    )
      fail("integrity");
    const value = await ctx.validate(contractName, record["payload"]);
    if (
      (await ctx.hash(value)) !==
      requirePresent(metadata, "metadata").artifactSha256
    )
      fail("integrity");
    if (contractName === "ResearchEvidence") {
      if (value["collectionId"] !== collection) fail("integrity");
      const membership = await one(
        tx,
        "vertex_claim_evidence",
        scope,
        sql`artifact_id = ${artifactId} and collection_id = ${collection} and snapshot_id = ${value["snapshotId"]} and evidence_id = ${value["evidenceId"]}`
      );
      // A source acceptance flag is never a control review. Published original
      // evidence belongs to an immutable generation; effective acceptance is a
      // separate current-review lookup below, never a rewritten artifact.
      if (!membership) return null;
      const generation = await one(
        tx,
        "vertex_collection_generations",
        scope,
        sql`collection_id = ${collection} and snapshot_id = ${value["snapshotId"]}`
      );
      if (!generation) fail("integrity");
    }
    return metadata;
  };

  const page = async <T>(
    candidates: Row[],
    limit: number,
    cursorBinding: string,
    idOf: (row: Row) => string,
    materialize: (row: Row) => Promise<T | null>
  ): Promise<VertexPage<T>> => {
    const visible: Readonly<{ id: string; value: T }>[] = [];
    for (const candidate of candidates) {
      try {
        const value = await materialize(candidate);
        if (value !== null) visible.push({ id: idOf(candidate), value });
        if (visible.length > limit) break;
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    if (visible.length <= limit && candidates.length === SCAN_LIMIT) {
      // Returning a denied candidate ID would leak an unauthorized identifier.
      // A bounded scan that cannot prove completion fails honestly instead.
      fail("unavailable");
    }
    const items = visible.slice(0, limit);
    return {
      items: items.map((item) => item.value),
      nextCursor:
        visible.length > limit
          ? encodeCursor(
              cursorBinding,
              requirePresent(items.at(-1), "items[items.length - 1]").id
            )
          : null,
    };
  };

  const listArtifacts: VertexStore["listArtifacts"] = async (
    principal,
    scope,
    raw
  ) => {
    const input = exact(raw, [
      "contractName",
      "collectionId",
      "strategyVersion",
      "limit",
      "cursor",
    ]) as VertexArtifactListInput;
    const options = pageOptions(input);
    const contractName = name(input.contractName);
    const collection =
      input.collectionId === undefined
        ? undefined
        : input.collectionId === null
          ? null
          : identifier(input.collectionId);
    const strategyVersion =
      input.strategyVersion === undefined
        ? null
        : identifier(input.strategyVersion);
    const cursorBinding = await binding(principal, scope, "artifacts", {
      contractName,
      collectionId: collection === undefined ? { omitted: true } : collection,
      strategyVersion,
    });
    const after = decodeCursor(options.cursor, cursorBinding);
    return ctx.run(
      principal,
      scope,
      collection ?? null,
      "artifacts",
      "read",
      async (tx, at) => {
        const filters: SQL[] = [
          sql`r.account_alias = ${scope.accountAlias}`,
          sql`r.environment = ${scope.environment}`,
          sql`r.contract_name = ${contractName}`,
        ];
        if (collection !== undefined)
          filters.push(sql`r.collection_key = ${collectionKey(collection)}`);
        if (after !== null) filters.push(sql`r.artifact_id > ${after}`);
        if (strategyVersion !== null)
          filters.push(
            sql`(r.artifact_id = ${strategyVersion} and r.contract_name = 'StrategySpec') or exists (select 1 from vertex_record_relationships rel where rel.account_alias = r.account_alias and rel.environment = r.environment and rel.artifact_id = r.artifact_id and rel.related_artifact_id = ${strategyVersion} and rel.relationship = 'strategy-version')`
          );
        const candidates = await rows(
          tx,
          sql`select r.* from vertex_records r inner join vertex_artifacts a on a.account_alias = r.account_alias and a.environment = r.environment and a.artifact_id = r.artifact_id and a.collection_key = r.collection_key where ${sql.join(
            filters.map((filter) => sql`(${filter})`),
            sql` and `
          )} order by r.artifact_id asc limit ${SCAN_LIMIT}`
        );
        return page(
          candidates,
          options.limit,
          cursorBinding,
          (row) => identifier(row["artifact_id"]),
          (row) => publishedRecord(tx, principal, scope, row, at)
        );
      }
    );
  };

  const findRecordArtifact: VertexStore["findRecordArtifact"] = async (
    principal,
    scope,
    raw
  ) => {
    const input = exact(raw, [
      "contractName",
      "recordId",
      "artifactId",
    ]) as VertexRecordLookup;
    const byArtifact = input.artifactId !== undefined;
    if (
      byArtifact === (input.recordId !== undefined) ||
      (!byArtifact && input.contractName === undefined)
    )
      fail("invalid");
    const contractName =
      input.contractName === undefined ? null : name(input.contractName);
    const identity = identifier(byArtifact ? input.artifactId : input.recordId);
    return await ctx.run(
      principal,
      scope,
      null,
      "records",
      "read",
      async (tx, at) => {
        const filters: SQL[] = [
          sql`r.account_alias = ${scope.accountAlias}`,
          sql`r.environment = ${scope.environment}`,
          byArtifact
            ? sql`r.artifact_id = ${identity}`
            : sql`r.record_id = ${identity}`,
        ];
        if (contractName !== null)
          filters.push(sql`r.contract_name = ${contractName}`);
        const candidates = await rows(
          tx,
          sql`select r.* from vertex_records r inner join vertex_artifacts a on a.account_alias = r.account_alias and a.environment = r.environment and a.artifact_id = r.artifact_id and a.collection_key = r.collection_key where ${sql.join(filters, sql` and `)} order by r.artifact_id asc limit ${SCAN_LIMIT}`
        );
        let result: VertexArtifactMetadata | null = null;
        for (const row of candidates) {
          try {
            const metadata = await publishedRecord(
              tx,
              principal,
              scope,
              row,
              at
            );
            if (metadata) {
              // Never guess a current revision when multiple immutable versions
              // share a record ID. Callers must pin the sealed artifact identity.
              if (result !== null) fail("conflict");
              result = metadata;
            }
          } catch (error) {
            if (!denied(error)) throw error;
          }
        }
        if (candidates.length === SCAN_LIMIT) fail("unavailable");
        return result;
      }
    );
  };

  const getAcceptedEvidence: VertexStore["getAcceptedEvidence"] = async (
    principal,
    scope,
    collection,
    evidenceId
  ) => {
    identifier(collection);
    identifier(evidenceId);
    return await ctx.run(
      principal,
      scope,
      collection,
      evidenceId,
      "read",
      async (tx, at) => {
        const source = await one(
          tx,
          "vertex_records",
          scope,
          sql`collection_key = ${collection} and contract_name = 'ResearchEvidence' and record_id = ${evidenceId}`
        );
        if (!source) return null;
        const artifact = await publishedRecord(
          tx,
          principal,
          scope,
          source,
          at
        );
        if (!artifact) return null;
        // Select the latest review first, NEVER the latest ACCEPTED review.
        // A later rejection, expiry or missing atomic overlay blocks acceptance.
        const latest = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`collection_key = ${collection} and artifact_id = ${artifact.artifactId} and purpose = 'research'`,
          sql`order by reviewed_at_ns desc, review_id desc`
        );
        if (!latest) return null;
        if ((await ctx.hash(latest["payload"])) !== latest["record_hash"])
          fail("integrity");
        const review = await ctx.validate("AcceptedReview", latest["payload"]);
        if (
          review["artifactId"] !== artifact.artifactId ||
          review["artifactSha256"] !== artifact.artifactSha256 ||
          review["collectionId"] !== collection
        )
          fail("integrity");
        const currentAt = ctx.now();
        if (
          review["decision"] !== "accepted" ||
          time(review["reviewedAt"]) > time(currentAt) ||
          time(review["expiresAt"]) <= time(currentAt)
        )
          return null;
        const linked = await one(
          tx,
          "vertex_reviewed_artifact_links",
          scope,
          sql`review_id = ${review["reviewId"]} and collection_key = ${collection} and artifact_id = ${artifact.artifactId} and artifact_sha256 = ${artifact.artifactSha256}`
        );
        if (!linked) return null;
        await ctx.authorize(
          principal,
          scope,
          collection,
          identifier(review["reviewId"]),
          "read",
          currentAt
        );
        const evidence = await ctx.validate(
          "ResearchEvidence",
          source["payload"]
        );
        if ((await ctx.hash(evidence)) !== artifact.artifactSha256)
          fail("integrity");
        const current = await ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          artifact.artifactId,
          "read",
          ctx.now()
        );
        if (!current || current.artifactSha256 !== artifact.artifactSha256)
          fail("integrity");
        if (time(review["expiresAt"]) <= time(ctx.now())) return null;
        return { artifact: current, evidence, review };
      }
    );
  };

  const scopedList = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    raw: VertexScopedRecordListInput,
    kind: "review" | "admission" | "projection"
  ): Promise<VertexPage<VertexRecord>> => {
    const input = exact(raw, [
      "strategyVersion",
      "limit",
      "cursor",
    ]) as VertexScopedRecordListInput;
    const options = pageOptions(input);
    const strategyVersion =
      input.strategyVersion === undefined
        ? null
        : identifier(input.strategyVersion);
    const cursorBinding = await binding(principal, scope, kind, {
      strategyVersion,
    });
    const after = decodeCursor(options.cursor, cursorBinding);
    const resource =
      kind === "review"
        ? "reviews"
        : kind === "admission"
          ? "paper-admissions"
          : "execution-audit";
    const table =
      kind === "review"
        ? "vertex_reviews"
        : kind === "admission"
          ? "vertex_paper_jobs"
          : "vertex_execution_projections";
    const idColumn =
      kind === "review"
        ? "review_id"
        : kind === "admission"
          ? "admission_id"
          : "projection_id";
    return ctx.run(principal, scope, null, resource, "read", async (tx, at) => {
      const filters: SQL[] = [scopeWhere(scope)];
      if (after !== null)
        filters.push(sql`${sql.identifier(idColumn)} > ${after}`);
      if (strategyVersion !== null)
        filters.push(
          kind === "review"
            ? sql`strategy_version = ${strategyVersion}`
            : sql`payload ->> 'strategyVersion' = ${strategyVersion}`
        );
      const candidates =
        kind === "projection"
          ? await rows(
              tx,
              sql`select * from (select projection_id, event_hash, payload, null::text as proof_journal_sequence, null::text as proof_journal_head_hash, null::integer as fact_ordinal, null::text as fact_kind, null::text as proof_artifact_id, null::text as proof_sha256, null::text as proof_source_event_id, 'ExecutionProjection' as contract_name from vertex_execution_projections where ${sql.join(filters, sql` and `)} union all select projection_id, event_hash, payload, proof_journal_sequence, proof_journal_head_hash, fact_ordinal, fact_kind, proof_artifact_id, proof_sha256, proof_source_event_id, 'NativeFactProjection' as contract_name from vertex_native_fact_projections where ${sql.join(filters, sql` and `)}) observations order by projection_id asc limit ${SCAN_LIMIT}`
            )
          : await rows(
              tx,
              sql`select * from ${sql.identifier(table)} where ${sql.join(filters, sql` and `)} order by ${sql.identifier(idColumn)} asc limit ${SCAN_LIMIT}`
            );
      return page(
        candidates,
        options.limit,
        cursorBinding,
        (row) => identifier(row[idColumn]),
        async (row) => {
          const contractName =
            kind === "review"
              ? "AcceptedReview"
              : kind === "admission"
                ? "PaperSimulationAdmission"
                : row["contract_name"] === "NativeFactProjection"
                  ? "NativeFactProjection"
                  : row["contract_name"] === "ExecutionProjection"
                    ? "ExecutionProjection"
                    : fail("integrity");
          const value = await ctx.validate(contractName, row["payload"]);
          ctx.scoped(value, scope);
          if (kind === "projection") {
            const { eventHash, ...body } = value;
            if (
              (await ctx.hash(body)) !== eventHash ||
              row["event_hash"] !== eventHash
            )
              fail("integrity");
            await ctx.authorize(
              principal,
              scope,
              null,
              identifier(value["streamId"]),
              "read",
              at
            );
            if (contractName === "NativeFactProjection") {
              const reference = object(value["proof"]);
              if (
                row["projection_id"] !== value["projectionId"] ||
                row["proof_journal_sequence"] !==
                  value["proofJournalSequence"] ||
                row["proof_journal_head_hash"] !==
                  value["proofJournalHeadHash"] ||
                row["fact_ordinal"] !== value["factOrdinal"] ||
                row["fact_kind"] !== object(value["fact"])["kind"] ||
                row["proof_artifact_id"] !== reference["artifactId"] ||
                row["proof_sha256"] !== reference["sha256"] ||
                row["proof_source_event_id"] !== reference["sourceEventId"]
              )
                fail("integrity");
              const proofRow = await one(
                tx,
                "vertex_native_journal_proofs",
                scope,
                sql`artifact_id = ${reference["artifactId"]} and sha256 = ${reference["sha256"]}`
              );
              if (
                !proofRow ||
                typeof proofRow["canonical_json"] !== "string" ||
                proofRow["canonical_json"].length > 1_048_576
              )
                fail("integrity");
              const proofBytes = new TextEncoder().encode(
                requirePresent(proofRow, "proofRow")["canonical_json"] as string
              );
              if (
                proofBytes.byteLength === 0 ||
                proofBytes.byteLength > 1_048_576 ||
                (await ctx.digest(proofBytes)) !== reference["sha256"]
              )
                fail("integrity");
              const proof = await ctx.validate(
                "NativeJournalProof",
                requirePresent(proofRow, "proofRow")["payload"]
              );
              if (
                new TextDecoder().decode(ctx.encode(proof)) !==
                  requirePresent(proofRow, "proofRow")["canonical_json"] ||
                proof["accountAlias"] !== scope.accountAlias ||
                proof["environment"] !== scope.environment ||
                proof["streamId"] !== value["streamId"] ||
                proof["ownerEpoch"] !== value["ownerEpoch"] ||
                proof["sourceEventId"] !== reference["sourceEventId"] ||
                proof["journalSequence"] !== value["proofJournalSequence"] ||
                proof["journalHeadHash"] !== value["proofJournalHeadHash"] ||
                proof["factOrdinal"] !== value["factOrdinal"] ||
                proof["occurredAt"] !== value["occurredAt"] ||
                (await ctx.hash(proof["payload"])) !==
                  (await ctx.hash(value["fact"]))
              )
                fail("integrity");
              const fact = object(value["fact"]);
              if (
                proof["eventType"] !== fact["kind"] ||
                (fact["kind"] === "checkpoint" &&
                  (fact["journalSequence"] !== proof["journalSequence"] ||
                    fact["journalHeadHash"] !== proof["journalHeadHash"]))
              )
                fail("integrity");
              if (
                requirePresent(proofRow, "proofRow")["artifact_id"] !==
                  reference["artifactId"] ||
                requirePresent(proofRow, "proofRow")["sha256"] !==
                  reference["sha256"] ||
                String(requirePresent(proofRow, "proofRow")["byte_length"]) !==
                  proofBytes.byteLength.toString() ||
                requirePresent(proofRow, "proofRow")["stream_id"] !==
                  proof["streamId"] ||
                requirePresent(proofRow, "proofRow")["owner_epoch"] !==
                  proof["ownerEpoch"] ||
                requirePresent(proofRow, "proofRow")["source_event_id"] !==
                  proof["sourceEventId"] ||
                requirePresent(proofRow, "proofRow")["occurred_at"] !==
                  proof["occurredAt"] ||
                requirePresent(proofRow, "proofRow")["event_type"] !==
                  proof["eventType"] ||
                requirePresent(proofRow, "proofRow")["journal_sequence"] !==
                  proof["journalSequence"] ||
                requirePresent(proofRow, "proofRow")["journal_head_hash"] !==
                  proof["journalHeadHash"] ||
                requirePresent(proofRow, "proofRow")["fact_ordinal"] !==
                  proof["factOrdinal"]
              )
                fail("integrity");
              await ctx.authorize(
                principal,
                scope,
                null,
                identifier(reference["artifactId"]),
                "read",
                ctx.now()
              );
            }
            return value;
          }
          if ((await ctx.hash(value)) !== row["record_hash"]) fail("integrity");
          const review =
            kind === "review"
              ? row
              : await one(
                  tx,
                  "vertex_reviews",
                  scope,
                  sql`review_id = ${row["review_id"]}`
                );
          if (
            !review ||
            (await ctx.hash(review["payload"])) !== review["record_hash"]
          )
            fail("integrity");
          const artifactRecord = await one(
            tx,
            "vertex_records",
            scope,
            sql`artifact_id = ${requirePresent(review, "review")["artifact_id"]} and collection_key = ${requirePresent(review, "review")["collection_key"]}`
          );
          if (!artifactRecord) fail("integrity");
          const artifact = await publishedRecord(
            tx,
            principal,
            scope,
            requirePresent(artifactRecord, "artifactRecord"),
            at
          );
          if (!artifact) return null;
          if (
            artifact.artifactSha256 !==
              requirePresent(review, "review")["artifact_sha256"] ||
            (kind === "admission" &&
              artifact.artifactSha256 !== value["intentSha256"])
          )
            fail("integrity");
          await ctx.authorize(
            principal,
            scope,
            collectionId(requirePresent(review, "review")["collection_key"]),
            identifier(row[idColumn]),
            "read",
            at
          );
          return value;
        }
      );
    });
  };
  return {
    listArtifacts,
    findRecordArtifact,
    getAcceptedEvidence,
    listScopeReviews: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => scopedList(principal, scope, input, "review"),
    listPaperAdmissions: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => scopedList(principal, scope, input, "admission"),
    listExecutionProjections: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => scopedList(principal, scope, input, "projection"),
  };
};
