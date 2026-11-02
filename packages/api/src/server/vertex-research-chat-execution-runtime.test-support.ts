import { AsyncLocalStorage } from "node:async_hooks";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  createVertexStore,
  type VertexAction,
  type VertexArtifactMetadata,
  type VertexRecord,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import { vertexPersistenceBoundary } from "./vertex-experience-adapter.ts";
import { takeDecodedFixtureSql } from "./vertex-research-chat-worker-sql.test-support.ts";
import { createVertexResearchChatExecutionRuntime } from "./vertex-research-chat-execution-runtime.ts";
import {
  computeRuntimePolicySelectionHash,
  parseRuntimePolicySelection,
  RuntimePolicySelectionSchema,
} from "../contracts/vertex-policy.ts";
import { VertexResearchChatParticipantConfigurationV1Schema } from "../contracts/vertex-research-chat-execution.ts";
import {
  researchChatContextUseResource,
  researchChatStorageReviewResource,
} from "../../../db/src/server/vertex-research-chat-execution-ports.ts";

export const BEFORE = "2026-09-24T11:00:00.000000001Z";
export const AT = "2026-09-24T12:00:00.000000001Z";
export const LATER = "2026-09-24T12:01:00.000000001Z";
export const END = "2026-09-24T13:00:00.000000001Z";
export const scope = {
  accountAlias: "synthetic-chat-composition",
  environment: "research",
} as const;
export const owner = { actorId: "fixture-owner" };
export const reviewer = { actorId: "fixture-independent-reviewer" };
const issuer = { actorId: "fixture-storage-issuer" };
const admin = { actorId: "fixture-grant-admin" };
export const SENTINELS = {
  human: "HUMAN_NO_LIFECYCLE_COPY_87e6",
  query: "QUERY_NO_LIFECYCLE_COPY_728c",
  excerpt: "EXCERPT_NO_LIFECYCLE_COPY_a298",
  persona: "PERSONA_NO_LIFECYCLE_COPY_319c",
};
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalArtifactJson(value));
const epoch = (value: string): string =>
  timestampToEpochNanoseconds(value).toString();
// biome-ignore lint/suspicious/noExplicitAny: in-memory SQL/JSON fixture rows are untyped transport data; tests assert shapes via schemas, and unknown cascades casts into every consumer test
type FixtureValue = any;
type Row = Record<string, FixtureValue>;
interface Query {
  sql: string;
  params: unknown[];
}

// SQL storage only, deliberately no validators/owners are mocked. Rollback is
// simulated; this cannot establish PostgreSQL concurrency/constraint behavior.
// retainQueries: false keeps `calls` empty for scenarios that never read it.
// The three-turn debate rechecks issue about 1.6M statements; keeping them
// all held about 0.8 GB of heap for the whole test.
const sqlMemory = (
  observeQuery?: (query: Query) => void,
  retainQueries = true
) => {
  const tables = new Map<string, Row[]>(),
    calls: Query[] = [];
  const record = retainQueries
    ? calls.push.bind(calls)
    : (): number => calls.length;
  if (observeQuery || !retainQueries) {
    // Both raw SQL and the worker SQL adapter append here BEFORE execution.
    // Keep the mutable afterQuery fault injector independent and unchanged.
    Object.defineProperty(calls, "push", {
      value: (...queries: Query[]): number => {
        for (const query of queries) observeQuery?.(query);
        return record(...queries);
      },
    });
  }
  const transactionContext = new AsyncLocalStorage<{ active: boolean }>();
  const state = {
    at: BEFORE,
    afterQuery: (_query: Query): void => undefined,
    afterRead: (_id: string): void => undefined,
    afterCommit: (): void => undefined,
    activeTransactions: 0,
    inTransaction: (): boolean =>
      transactionContext.getStore()?.active === true,
  };
  const table = (name: string): Row[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const dialect = new PgDialect();
  // Non-global patterns, so reusing one per column is stateless.
  const parameterPatterns = new Map<string, RegExp>();
  const parameter = (q: Query, column: string): unknown => {
    let pattern = parameterPatterns.get(column);
    if (pattern === undefined) {
      pattern = new RegExp(`${column.replaceAll(".", "\\.")} = \\$(\\d+)`);
      parameterPatterns.set(column, pattern);
    }
    const match = pattern.exec(q.sql);
    return match ? q.params[Number(match[1]) - 1] : undefined;
  };
  // A WHERE text is parsed once into its parameter comparisons and literal
  // equalities; every row is then checked in the same order as before.
  type Conditions = Readonly<{
    compared: readonly (readonly [string, string, number])[];
    literal: readonly (readonly [string, string])[];
  }>;
  const conditions = new Map<string, Conditions>();
  const parsedWhere = (where: string): Conditions => {
    const known = conditions.get(where);
    if (known !== undefined) return known;
    const value: Conditions = {
      compared: [
        ...where.matchAll(
          /(?:\b\w+\.)?"?([a-z_0-9]+)"?\s*(=|>=|<=|>|<|is not distinct from)\s*\$(\d+)/g
        ),
      ].map((match) => [match[1]!, match[2]!, Number(match[3]) - 1] as const),
      literal: [...where.matchAll(/\b([a-z_0-9]+)\s*=\s*'([^']*)'/g)].map(
        (match) => [match[1]!, match[2]!] as const
      ),
    };
    conditions.set(where, value);
    return value;
  };
  const matches = (row: Row, query: Query, where: string): boolean => {
    const { compared, literal } = parsedWhere(where);
    for (const [column, operator, position] of compared) {
      const actual = row[column],
        expected = query.params[position];
      if (
        (operator === "=" || operator === "is not distinct from") &&
        actual !== expected
      )
        return false;
      if (operator !== "=" && operator !== "is not distinct from") {
        if (
          actual === null ||
          actual === undefined ||
          expected === null ||
          expected === undefined
        )
          return false;
        const a = BigInt(String(actual)),
          b = BigInt(String(expected));
        if (
          (operator === ">=" && a < b) ||
          (operator === "<=" && a > b) ||
          (operator === ">" && a <= b) ||
          (operator === "<" && a >= b)
        )
          return false;
      }
    }
    for (const [column, text] of literal)
      if (row[column] !== text) return false;
    return true;
  };
  const execute = async (fragment: SQL) => {
    const q = takeDecodedFixtureSql(fragment) ?? dialect.sqlToQuery(fragment);
    calls.push(q);
    state.afterQuery(q);
    if (q.sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (q.sql.includes("as expected(ordinal, purpose, copy_id)")) {
      const relation =
        /from \(values (.*?)\) as expected\(ordinal, purpose, copy_id\)/.exec(
          q.sql
        );
      if (
        !(
          relation &&
          q.sql.includes(
            "to_jsonb(e) || jsonb_build_object('intent_committed_at_ns', e.intent_committed_at_ns::text) as effect_row, to_jsonb(o) as observation_row"
          ) &&
          q.sql.endsWith("order by expected.ordinal limit 4")
        )
      )
        throw new Error("Unsupported historical proof projection");
      const expected = [
        ...relation[1]!.matchAll(/\((\d+), '([^']+)', \$(\d+)\)/g),
      ].map((match) => ({
        ordinal: Number(match[1]),
        purpose: match[2]!,
        copy_id: q.params[Number(match[3]) - 1],
      }));
      const join = (
        alias: string,
        tableName: string,
        copyId: unknown
      ): (Row | null)[] => {
        const clause = new RegExp(
          `left join ${tableName} ${alias} on (.*?)(?= left join| order by)`
        ).exec(q.sql)?.[1];
        if (
          !(
            clause?.includes(`${alias}.copy_id = expected.copy_id`) &&
            clause.includes(`${alias}.operation = 'create'`)
          )
        )
          throw new Error("Unsupported historical proof join");
        const accountAlias = parameter(q, `${alias}.account_alias`),
          environment = parameter(q, `${alias}.environment`),
          request = parameter(q, `${alias}.response_request_id`);
        if (
          accountAlias === undefined ||
          environment === undefined ||
          request === undefined
        )
          throw new Error("Unscoped historical proof join");
        const found = table(tableName).filter(
          (row) =>
            row["account_alias"] === accountAlias &&
            row["environment"] === environment &&
            row["response_request_id"] === request &&
            row["copy_id"] === copyId &&
            row["operation"] === "create"
        );
        return found.length ? found : [null];
      };
      const found: Row[] = [];
      for (const pair of expected) {
        const effects = join(
            "e",
            "vertex_research_chat_copy_effects",
            pair.copy_id
          ),
          observations = join(
            "o",
            "vertex_research_chat_copy_effect_observations",
            pair.copy_id
          );
        // SQL LEFT JOIN preserves missing sides and emits the full cross product
        // for corrupt duplicate matches; never find()/deduplicate these rows.
        for (const effect of effects)
          for (const observation of observations)
            found.push({
              ...pair,
              effect_row: effect
                ? {
                    ...effect,
                    intent_committed_at_ns:
                      effect["intent_committed_at_ns"] === null
                        ? null
                        : String(effect["intent_committed_at_ns"]),
                  }
                : null,
              observation_row: observation,
            });
      }
      found.sort((a, b) => a["ordinal"] - b["ordinal"]);
      return { rows: structuredClone(found.slice(0, 4)) };
    }
    if (q.sql.includes("from vertex_grant_bindings")) {
      const accountAlias = parameter(q, "b.account_alias"),
        environment = parameter(q, "b.environment");
      const selectors = [
        "grantee_actor_id",
        "collection_key",
        "resource_id",
        "grant_id",
      ].map((column) => ({ column, expected: parameter(q, `b.${column}`) }));
      const action =
        parameter(q, "a.action") ??
        (q.sql.includes("a.action = 'read'") ? "read" : undefined);
      const found: Row[] = [];
      for (const binding of table("vertex_grant_bindings")) {
        if (
          accountAlias !== binding["account_alias"] ||
          environment !== binding["environment"]
        )
          continue;
        if (
          selectors.some(
            ({ column, expected }) =>
              expected !== undefined && expected !== binding[column]
          )
        )
          continue;
        if (
          q.sql.includes("b.collection_key = ''") &&
          binding["collection_key"] !== ""
        )
          continue;
        const head = table("vertex_grant_current").find(
          (r) => r["grant_id"] === binding["grant_id"]
        );
        const version = table("vertex_grant_versions").find(
          (r) =>
            r["grant_id"] === binding["grant_id"] &&
            r["version"] === head?.["current_version"]
        );
        if (!(head && version)) continue;
        if (
          action !== undefined &&
          !table("vertex_grant_actions").some(
            (r) =>
              r["grant_id"] === binding["grant_id"] &&
              r["version"] === version["version"] &&
              r["action"] === action
          )
        )
          continue;
        found.push({
          ...binding,
          ...version,
          payload: version["payload"],
          binding_payload: binding["payload"],
          version_payload: version["payload"],
          version_status: version["status"],
          version_name: version["version"],
          version_revision: version["revision"],
          current_version: head["current_version"],
          current_revision: head["revision"],
        });
      }
      return { rows: found };
    }
    const inserted =
      /^insert into "?(\w+)"? \((.*?)\) values \((.*?)\)(.*)$/.exec(q.sql);
    if (inserted) {
      const columns = inserted[2]!
          .split(",")
          .map((s) => s.trim().replaceAll('"', "")),
        values = inserted[3]!.split(",");
      const row: Row = {};
      for (const [i, column] of columns.entries()) {
        const token = values[i]!.trim(),
          parameter = /\$(\d+)/.exec(token);
        const value = parameter
          ? q.params[Number(parameter[1]) - 1]
          : token === "null"
            ? null
            : token.replace(/^'|'$/g, "");
        row[column] = token.includes("::jsonb")
          ? JSON.parse(value as string)
          : value;
      }
      table(inserted[1]!).push(row);
      const returned = /returning (\w+)/.exec(inserted[4]!);
      return { rows: returned ? [{ [returned[1]!]: row[returned[1]!] }] : [] };
    }
    const updated = /^update (\w+) set (.*?) where (.*?) returning (\w+)$/.exec(
      q.sql
    );
    if (updated) {
      const found = table(updated[1]!).filter((row) =>
        matches(row, q, updated[3]!)
      );
      for (const row of found)
        for (const match of updated[2]!.matchAll(
          /(\w+) = \$(\d+)(::jsonb)?/g
        )) {
          const value = q.params[Number(match[2]) - 1];
          row[match[1]!] = match[3] ? JSON.parse(value as string) : value;
        }
      return {
        rows: found.map((row) => ({ [updated[4]!]: row[updated[4]!] })),
      };
    }
    const selected = /from "?(vertex_\w+)"? where (.*)/.exec(q.sql);
    if (selected) {
      const found = table(selected[1]!).filter((row) =>
        matches(row, q, selected[2]!)
      );
      for (const key of ["reviewed_at_ns", "revision", "sequence"])
        if (q.sql.includes(`order by ${key}`))
          found.sort((a, b) => {
            const direction = q.sql.includes(`order by ${key} desc`) ? -1 : 1;
            return BigInt(a[key]) < BigInt(b[key])
              ? -direction
              : BigInt(a[key]) > BigInt(b[key])
                ? direction
                : 0;
          });
      const limit = /limit (\d+)/.exec(q.sql);
      return { rows: limit ? found.slice(0, Number(limit[1])) : found };
    }
    throw new Error(`Unsupported source-fixture SQL: ${q.sql}`);
  };
  const tx = { execute } as unknown as Transaction;
  // SQL boundary models the owner's scope lock; concurrent callers cannot both
  // observe an absent intent. Commit-ACK loss is injected AFTER durable state.
  let turn: Promise<void> = Promise.resolve();
  const db = {
    execute,
    transaction: async (operation: (tx: Transaction) => Promise<unknown>) => {
      const previous = turn;
      let release!: () => void;
      turn = new Promise<void>((resolve) => {
        return (release = resolve);
      });
      await previous;
      const before = structuredClone(tables);
      const marker = { active: true };
      return transactionContext.run(marker, async () => {
        let result: unknown;
        state.activeTransactions += 1;
        try {
          try {
            result = await operation(tx);
          } catch (error) {
            tables.clear();
            for (const [name, rows] of before) tables.set(name, rows);
            throw error;
          }
          state.afterCommit();
          return result;
        } finally {
          marker.active = false;
          state.activeTransactions -= 1;
          release();
        }
      });
    },
  } as unknown as Database;
  return { tables, table, calls, db, tx, state };
};
export const compositionFixture = async (
  fixtureOptions: Readonly<{
    frozenRightsAtExecution?: boolean;
    corpusReviewExpiresAt?: string;
    participantId?: string;
    observeQuery?: (query: Query) => void;
    retainQueries?: boolean;
  }> = {}
) => {
  const f = sqlMemory(
      fixtureOptions.observeQuery,
      fixtureOptions.retainQueries
    ),
    { table, db, state } = f;
  // Conditional source composition only: issue original observations at the
  // actual frozen execution clock, never restamp an already-issued record.
  if (fixtureOptions.frozenRightsAtExecution) state.at = AT;
  const participantId = fixtureOptions.participantId ?? "expert-1";
  const clock = { now: () => state.at };
  // The external administrative identity boundary is doubled, not persisted
  // grants/rights/reviews. Every grant below is issued by the actual owner.
  const authorization = createVertexAuthorization(db, {
    clock,
    privilegedAuthorization: {
      authorize: async (request) =>
        request.principal.actorId === admin.actorId &&
        request.binding.scope.accountAlias === scope.accountAlias &&
        request.binding.scope.environment === scope.environment,
    },
  });
  const store = createVertexStore(db, {
    boundary: vertexPersistenceBoundary,
    authorization,
    clock,
    maxProjectionAgeMs: 60_000,
  });
  const grant = async (
    actorId: string,
    resourceId: string,
    actions: readonly VertexAction[],
    collectionId: string | null = null,
    expiresAt = END
  ) => {
    const grantId = `grant-${await hashArtifact({ actorId, resourceId, actions, collectionId })}`;
    await authorization.issueGrant({
      principal: admin,
      grantId,
      granteeActorId: actorId,
      scope,
      collectionId,
      resourceId,
      actions,
      version: "1.0.0",
      expectedVersion: null,
      validFrom: BEFORE,
      expiresAt,
    });
    return grantId;
  };
  for (const actor of [owner, reviewer, issuer])
    await grant(actor.actorId, "account-scope", ["read"]);
  await grant(owner.actorId, "research-chat", ["read", "publish"]);
  const rights = async (
    policyId: string,
    collectionId: string | null = null
  ) => {
    await grant(admin.actorId, policyId, ["manage-rights"], collectionId);
    const value = {
      policyId,
      version: "1.0.0",
      status: "granted" as const,
      allowedUses: ["store", "read", "derive", "export"] as const,
      checkedAt: fixtureOptions.frozenRightsAtExecution ? clock.now() : BEFORE,
      expiresAt: END,
      retentionUntil: null,
    };
    await store.putRights(admin, scope, collectionId, value);
    return value;
  };
  const objects = new Map<string, { id: string; body: Uint8Array }>();
  const objectCapabilities = (): VertexObjectCapabilities => ({
    head: async (key) => {
      const object = objects.get(key);
      return object
        ? {
            status: "ok",
            value: {
              key,
              size: object.body.byteLength,
              checksum: await hashArtifact(object.body),
              createdAt: BEFORE,
              updatedAt: BEFORE,
            },
          }
        : { status: "not-found" };
    },
    getBounded: async (key, maximum) => {
      const object = objects.get(key);
      if (!object || object.body.byteLength > maximum)
        return { status: "not-found" };
      const body = new Uint8Array(object.body);
      state.afterRead(object.id);
      return {
        status: "ok",
        value: {
          body,
          metadata: {
            key,
            size: body.byteLength,
            createdAt: BEFORE,
            updatedAt: BEFORE,
          },
        },
      };
    },
  });
  const sourceRights = await rights("corpus-rights", "corpus");
  const policyRights = await rights("policy-rights");
  const artifact = async (
    artifactId: string,
    value: Row,
    contractName: string,
    collectionId: string | null = null,
    privateStage = false
  ) => {
    const body = encode(value),
      sha256 = await hashArtifact(body),
      key = vertexQualifiedObjectKey(scope, collectionId, "manifest", sha256);
    const pin = {
      artifactId,
      artifactSha256: sha256,
      contractName,
      schemaVersion: "1.0.0" as const,
    };
    const pinnedRights = collectionId === null ? policyRights : sourceRights;
    const metadata = {
      ...pin,
      scope,
      collectionId,
      objectKey: key,
      sourceContentSha256: value["contentHash"] ?? null,
      byteLength: body.byteLength,
      contentType: "application/json",
      rights: pinnedRights,
      lineageArtifactIds: [],
      createdAt: BEFORE,
    };
    objects.set(key, { id: artifactId, body });
    for (const actor of [owner, reviewer])
      await grant(actor.actorId, artifactId, ["read", "publish"], collectionId);
    if (collectionId !== null) {
      await store.registerArtifact(owner, metadata as VertexArtifactMetadata);
    } else if (!privateStage) {
      // Original private policy rows are historical external SQL inputs. Their
      // content/metadata/current rights are still read by real runtime owners.
      table("vertex_artifacts").push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        collection_key: "",
        artifact_id: artifactId,
        artifact_sha256: sha256,
        object_key: key,
        byte_length: String(body.byteLength),
        rights_policy_id: pinnedRights.policyId,
        rights_version: pinnedRights.version,
        metadata_hash: await hashArtifact(metadata),
        payload: metadata,
      });
    }
    return { pin, value, body, key, metadata };
  };
  const sourceIdentity = {
    sourceId: "authored-fixture-source",
    snapshotId: "source-snapshot",
    provider: "authored-fixture",
    contentHash: await hashArtifact(
      new TextEncoder().encode(
        "Whole authored source content, distinct from bounded claim"
      )
    ),
  };
  const corpus = await artifact(
    "evidence-artifact",
    {
      schemaVersion: "1.0.0",
      evidenceId: "evidence",
      collectionId: "corpus",
      snapshotId: "snapshot",
      sourceType: "article",
      sourceUri: "https://example.com/authored-fixture",
      sourceIdentity,
      sourceLocator: "claim-1",
      attribution: "Synthetic test author; no real corpus permission claimed",
      publishedAt: null,
      capturedAt: BEFORE,
      contentHash: sourceIdentity.contentHash,
      claim: SENTINELS.excerpt,
      method: "Synthetic authored fixture",
      limitations: ["Not real corpus rights or research"],
      acceptanceStatus: "unreviewed",
      rightsPolicyId: sourceRights.policyId,
      untrustedContent: true,
    },
    "ResearchEvidence",
    "corpus"
  );
  const knowledge = await artifact(
    "knowledge-artifact",
    {
      schemaVersion: "1.0.0",
      collectionId: "corpus",
      snapshotId: "snapshot",
      sourceIdentities: [sourceIdentity],
      contentHashes: [sourceIdentity.contentHash],
      duplicateMappings: [],
      unavailableSources: [],
      transcriptQuality: "not-applicable",
      retrievalScope: "collection-only",
      rightsPolicyId: sourceRights.policyId,
      replacementScope: "collection-snapshot",
      contentClass: "article",
      untrustedContent: true,
    },
    "KnowledgeImport",
    "corpus"
  );
  await grant(owner.actorId, "corpus", ["publish"], "corpus");
  const publicationHash = await hashArtifact({
    scope,
    collectionId: "corpus",
    expectedActiveSnapshotId: null,
    snapshotId: "snapshot",
    importArtifacts: [knowledge.pin],
    evidenceArtifacts: [corpus.pin],
    datasetArtifacts: [],
  });
  const eventIdentity = {
    schemaVersion: "1.0.0",
    eventType: "knowledge.imported",
    occurredAt: clock.now(),
    effectiveAt: clock.now(),
    correlationId: `publication-${publicationHash}`,
    causationId: null,
    actorId: owner.actorId,
    moduleId: "vertex-persistence",
    moduleVersion: "1.0.0",
    environment: scope.environment,
    idempotencyKey: `publication-${publicationHash}-0`,
    payload: knowledge.value,
  };
  await grant(
    owner.actorId,
    `event-${await hashArtifact(eventIdentity)}`,
    ["publish"],
    "corpus"
  );
  await store.publishCollectionSnapshot({
    principal: owner,
    scope,
    collectionId: "corpus",
    expectedActiveSnapshotId: null,
    imports: [{ record: knowledge.value, artifact: knowledge.pin }],
    evidence: [{ record: corpus.value, artifact: corpus.pin }],
    datasets: [],
    idempotencyKey: "authored-source-publication",
  });
  const rule = {
    ruleId: "fixture-rule",
    featureId: "fixture-feature",
    operator: "gt",
    threshold: "0",
    lookbackBars: 1,
  };
  const strategy = await artifact(
    "strategy-artifact",
    {
      schemaVersion: "1.0.0",
      strategyId: "strategy",
      version: "1.0.0",
      sleeve: "quant",
      hypothesis: "Authored fixture review target only",
      universe: ["SYNTHETIC"],
      signalSchedule: {
        calendar: "fixture-calendar",
        timezone: "UTC",
        interval: "bar-close",
      },
      entryRules: [rule],
      exitRules: [rule],
      riskLimits: {
        maximumLoss: "1",
        maximumNotional: "1",
        maximumPositions: 1,
      },
      requiredData: [
        {
          kind: "candles",
          maximumAgeMs: 1000,
          pointInTimeRequired: true,
          entitlementPolicyId: sourceRights.policyId,
        },
      ],
      costModel: {
        commissionPerUnit: "0",
        spreadBps: "0",
        slippageBps: "0",
        borrowAnnualBps: "0",
        impactModel: "fixed-bps",
        maximumParticipationBps: "1",
      },
      codeDigest: "a".repeat(64),
    },
    "StrategySpec",
    "corpus"
  );
  await store.recordImmutable({
    principal: owner,
    scope,
    collectionId: "corpus",
    contractName: "StrategySpec",
    record: strategy.value,
    artifact: strategy.pin,
    idempotencyKey: "strategy",
  });
  await grant(reviewer.actorId, corpus.pin.artifactId, ["review"], "corpus");
  await grant(reviewer.actorId, corpus.pin.artifactId, ["review"], null);
  const command = {
    ...scope,
    artifactId: corpus.pin.artifactId,
    artifactSha256: corpus.pin.artifactSha256,
    strategyVersion: strategy.pin.artifactId,
    decision: "accepted",
    purpose: "research",
    expectedReviewId: null,
    idempotencyKey: "corpus-review",
  };
  const requestHash = await hashArtifact({
    actorId: reviewer.actorId,
    kind: "review",
    input: command,
  });
  const corpusReview = {
    schemaVersion: "1.0.0",
    ...scope,
    collectionId: "corpus",
    artifactId: corpus.pin.artifactId,
    artifactSha256: corpus.pin.artifactSha256,
    reviewId: `review-${requestHash}`,
    reviewVersion: "12.34.5",
    decision: "accepted",
    purpose: "research",
    actorId: reviewer.actorId,
    reviewedAt: BEFORE,
    expiresAt: fixtureOptions.corpusReviewExpiresAt ?? END,
    policyVersion: "1.0.0",
    strategyVersion: strategy.pin.artifactId,
    supersedesReviewId: null,
    executionAuthorized: false,
  };
  await store.recordReviewedEvidence({
    principal: reviewer,
    scope,
    idempotencyKey: command.idempotencyKey,
    requestHash,
    command,
    review: corpusReview,
    acceptedEvidence: null,
  });
  await grant(owner.actorId, "evidence", ["read"], "corpus");
  await grant(owner.actorId, corpusReview.reviewId, ["read"], "corpus");
  const endpoint = (endpoint_id: string, operation: string, path: string) => ({
    endpoint_id,
    operation,
    path,
    provider: "fixture-provider",
    origin: "https://model.example.com",
    method: "POST",
    credential_reference_id: "credential-reference-only",
    credential_header: "Authorization",
    credential_prefix: "Bearer ",
    allowed_query_keys: [],
    policy_id: "endpoint-policy",
    source_reference: "fixture-source",
    maximum_request_bytes: 1_000_000,
    maximum_response_bytes: 1_000_000,
    timeout_ms: 1000,
    allowed_ip_addresses: ["93.184.216.34"],
  });
  const tokenize = await artifact(
    "tokenize-policy",
    endpoint("tokenize", "model-tokenize", "/tokenize"),
    "EndpointPolicy"
  );
  const completion = await artifact(
    "completion-policy",
    endpoint("complete", "model-completion", "/v1/chat/completions"),
    "EndpointPolicy"
  );
  const tokenizer = await artifact(
    "tokenizer",
    { tokenizer: "original synthetic tokenizer bytes" },
    "Tokenizer"
  );
  const manifest = await artifact(
    "serving-manifest",
    {
      profile: "vertex-exact-vllm-serving-v1",
      model_version: "fixture-model",
      served_model: "served-fixture",
      model_revision: "a".repeat(40),
      tokenizer_sha256: tokenizer.pin.artifactSha256,
      chat_template_sha256: "c".repeat(64),
      backend: "vllm-0.9.2",
      runtime_image_sha256: "d".repeat(64),
      replica_policy: "immutable-identical-no-hot-swap",
      template_policy: "reviewed-pure-no-clock-random-or-external-state",
      input_profile: "text-only-decoder-only-no-documents",
      adapter_policy: "no-lora-no-prompt-adapters-no-tools-no-truncation",
      tokenize_authentication: "authenticated-reverse-proxy-both-paths",
      pricing_profile:
        "all-prompt-and-completion-token-ids-single-rate-no-cache-discount",
    },
    "ServingManifest"
  );
  const prices = await artifact(
    "prices",
    {
      profile: "vertex-model-price-v1",
      model_version: "fixture-model",
      input_usd_per_million: "1",
      output_usd_per_million: "2",
      rounding: "ceil-aggregate-to-1e-18-usd",
    },
    "ModelPricing"
  );
  const modelPolicy = await artifact(
    "model-policy",
    {
      policy_id: "model-policy",
      model_version: "fixture-model",
      served_model: "served-fixture",
      backend: "vllm-0.9.2",
      model_revision: "a".repeat(40),
      tokenizer_sha256: tokenizer.pin.artifactSha256,
      chat_template_sha256: "c".repeat(64),
      serving_manifest_sha256: manifest.pin.artifactSha256,
      tokenize_endpoint_id: "tokenize",
      completion_endpoint_id: "complete",
      pricing_source_artifact_id: prices.pin.artifactId,
      input_usd_per_million: "1",
      output_usd_per_million: "2",
      maximum_context_tokens: 4096,
    },
    "ModelPolicy"
  );
  const descriptor = await artifact(
    "model-descriptor",
    {
      format: "vertex-model-binding-v1",
      ...scope,
      providerId: "fixture-provider",
      modelVersion: "fixture-model",
      tokenizerArtifactId: tokenizer.pin.artifactId,
      tokenizerSha256: tokenizer.pin.artifactSha256,
      endpointReferenceId: "complete",
      endpointSha256: completion.pin.artifactSha256,
      modelUsePolicyVersion: "1.0.0",
      expiresAt: END,
      pricing: {
        currency: "USD",
        basis: "conservative-input-byte-output-token-ceiling",
        tokenizationBaseUsd: "0.001",
        tokenizationInputByteUsd: "0.000000001",
        completionBaseUsd: "0.001",
        completionInputByteUsd: "0.000000001",
        outputTokenUsd: "0.0001",
        expiresAt: END,
      },
    },
    "ModelDescriptor"
  );
  const retention = await artifact(
    "retention",
    {
      schemaVersion: "1.0.0",
      format: "vertex-research-chat-copy-retention-policy-v1",
      ...scope,
      policyId: "chat-retention",
      policyVersion: "1.0.0",
      rules: [
        { kind: "context", cleanupTrigger: "response-attempt-terminal" },
        { kind: "model-input", cleanupTrigger: "response-attempt-terminal" },
        { kind: "derived-output", cleanupTrigger: "explicit-user-cleanup" },
      ],
      earlierCleanupTriggers: ["revocation", "rights-expiry"],
    },
    "VertexResearchChatCopyRetentionPolicy"
  );
  const provenance = await artifact(
    "provenance",
    { source: "authored-fixture" },
    "Provenance"
  );
  const module = await artifact(
    "module",
    { module: "authored-fixture" },
    "PrivateModule"
  );
  const policyPins: Row[] = [];
  for (const role of ["licensing-rights", "tool", "provider-budget"]) {
    const item = await artifact(`selected-${role}`, { role }, "PrivatePolicy");
    policyPins.push({
      role,
      policyId:
        role === "licensing-rights" ? policyRights.policyId : `policy-${role}`,
      version: "1.0.0",
      artifact: item.pin,
    });
  }
  policyPins.push({
    role: "retention",
    policyId: "chat-retention",
    version: "1.0.0",
    artifact: retention.pin,
  });
  const facts: Row[] = [];
  for (const item of [tokenize, completion]) {
    const fact = await artifact(
      `fact-${item.value["endpoint_id"]}`,
      { observation: "authored input, not actual provider qualification" },
      "ProviderFact"
    );
    facts.push({
      capabilityId: `capability-${item.value["endpoint_id"]}`,
      providerId: "fixture-provider",
      endpointReferenceId: item.value["endpoint_id"],
      endpointSha256: item.pin.artifactSha256,
      modelVersion: "fixture-model",
      operation: item.value["operation"],
      state: "unknown",
      rightsPolicyId: policyRights.policyId,
      rightsPolicyVersion: policyRights.version,
      observedAt: BEFORE,
      expiresAt: END,
      evidenceArtifact: fact.pin,
    });
  }
  const references = [tokenize, completion].map((item) => ({
    referenceId: item.value["endpoint_id"],
    referenceSha256: item.pin.artifactSha256,
    kind: "nonsecret-reference",
  }));
  references.push({
    referenceId: "credential-reference-only",
    referenceSha256: "9".repeat(64),
    kind: "secret-reference",
  });
  const rawSelection = RuntimePolicySelectionSchema.parse({
    schemaVersion: "1.0.0",
    ...scope,
    selectionId: "selection",
    selectionSha256: "a".repeat(64),
    revision: "1",
    issuedAt: BEFORE,
    expiresAt: END,
    sourcePins: [
      {
        sourceId: "fixture-source",
        revision: "1",
        sourceSha256: provenance.pin.artifactSha256,
        provenanceArtifact: provenance.pin,
      },
    ],
    modules: [
      {
        moduleId: "fixture-module",
        version: "1.0.0",
        codeSha256: "e".repeat(64),
        contractSha256: "f".repeat(64),
        artifact: module.pin,
        enabled: false,
        capabilities: ["research"],
        requiredComponents: ["unqualified-fixture-worker"],
      },
    ],
    policies: policyPins,
    configuration: [
      "broker-execution",
      "quantvps-transport",
      "options-analytics",
      "fundamentals-news",
      "historical-quant-data",
      "models-agent-tools",
      "storage-queue-audit",
    ].map((group) => ({
      group,
      state: "unknown",
      referenceIds: [],
      reasonCodes: ["synthetic-source-only"],
      provenanceSourceIds: ["fixture-source"],
    })),
    references: references.map((entry) => ({
      ...entry,
      ...scope,
      logicalName: entry.referenceId,
      ownerService: "fixture-consumer",
      permissions: ["read"],
      entitlementPolicyId: null,
      rotationOwner: "fixture-owner",
      requiredWhen: [],
      legacyAliases: [],
      verificationState: "unknown",
      lastVerifiedAt: null,
      expiresAt: END,
      exposure: "server-only",
    })),
    providerCapabilities: facts,
    artifacts: [
      { bindingId: "model", role: "model", artifact: descriptor.pin },
      {
        bindingId: "model-policy",
        role: "tool-config",
        artifact: modelPolicy.pin,
      },
      { bindingId: "tokenizer", role: "tokenizer", artifact: tokenizer.pin },
      { bindingId: "tokenize", role: "endpoint", artifact: tokenize.pin },
      { bindingId: "complete", role: "endpoint", artifact: completion.pin },
      { bindingId: "manifest", role: "tool-config", artifact: manifest.pin },
      { bindingId: "prices", role: "tool-config", artifact: prices.pin },
    ],
    research: {
      moduleId: "fixture-module",
      taskContract: "research-task",
      modelVersion: "fixture-model",
      modelCapabilityId: facts[0]!["capabilityId"],
      tokenBudget: 3000,
      costBudgetUsd: "2",
      rightsPolicyId: policyRights.policyId,
      allowedTools: [],
      requiredComponents: ["unqualified-fixture-worker"],
    },
    review: null,
    simulation: null,
    readOnly: true,
    nativeRearmAllowed: false,
    cloudCapitalAuthority: false,
  });
  const selection = await parseRuntimePolicySelection({
    ...rawSelection,
    selectionSha256: await computeRuntimePolicySelectionHash(rawSelection),
  });
  // Persisted selection/head are SQL-boundary inputs; no runtime-ready boolean
  // is supplied to the composition. All original pins/current rights are joined.
  table("vertex_policy_selections").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    selection_id: selection.selectionId,
    selection_sha256: selection.selectionSha256,
    revision: selection.revision,
    issued_at_ns: epoch(BEFORE),
    expires_at_ns: epoch(END),
    payload: selection,
  });
  const head = {
    ...scope,
    selectionId: selection.selectionId,
    selectionSha256: selection.selectionSha256,
    revision: "2",
    state: "active-read-only",
    updatedAt: BEFORE,
  };
  table("vertex_policy_heads").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    selection_id: head.selectionId,
    selection_sha256: head.selectionSha256,
    revision: head.revision,
    state: head.state,
    updated_at: BEFORE,
    record_hash: await hashArtifact(head),
    payload: head,
  });
  for (const id of [
    "runtime-policy",
    "selection",
    "policy-consumer:fixture-consumer",
  ])
    await grant(owner.actorId, id, ["read"]);
  const reviewPins = [
    {
      collectionId: "corpus",
      evidenceId: "evidence",
      artifactId: corpus.pin.artifactId,
      artifactSha256: corpus.pin.artifactSha256,
      reviewId: corpusReview.reviewId,
      reviewVersion: corpusReview.reviewVersion,
      rightsPolicyId: sourceRights.policyId,
      rightsVersion: sourceRights.version,
    },
  ];
  const configuration =
    VertexResearchChatParticipantConfigurationV1Schema.parse({
      schemaVersion: "1.0.0",
      ...(participantId === "first-mate"
        ? {
            format: "vertex-research-chat-first-mate-configuration-v1",
            mode: "single-turn-advisory",
          }
        : { format: "vertex-research-chat-expert-configuration-v1" }),
      ...scope,
      participantId,
      participantLabel:
        participantId === "first-mate"
          ? "Authored Fixture First Mate"
          : "Authored Fixture Expert",
      personaText: SENTINELS.persona,
      collectionId: "corpus",
      snapshotId: "snapshot",
      taskContract: "research-task",
      reviewPins,
      modelPolicy: modelPolicy.pin,
      budgets: {
        requestTokens: 2000,
        attemptTokens: 1500,
        requestCostUsd: "1",
        attemptCostUsd: "0.5",
        tokenizeCostUsd: "0.01",
        completionCostUsd: "0.1",
      },
      provider: {
        providerId: "fixture-provider",
        modelVersion: "fixture-model",
        servedModel: "served-fixture",
        tokenizerArtifact: tokenizer.pin,
        tokenizeEndpoint: tokenize.pin,
        completionEndpoint: completion.pin,
        maximumInputTokens: 1000,
        maximumOutputTokens: 128,
        maximumCostUsd: "0.4",
      },
      advisoryMaximumBytes: 20_000,
      expiresAt: END,
    });
  const config = await artifact(
    participantId === "first-mate" ? "first-mate-config" : "expert-config",
    configuration,
    participantId === "first-mate"
      ? "ResearchChatFirstMateConfiguration"
      : "ResearchChatExpertConfiguration"
  );
  const report = await artifact(
    "storage-report",
    {
      report: "synthetic storage external observation, not real qualification",
    },
    "StorageReport"
  );
  const storageIdentity = {
    capabilityReferenceId: "fixture-copy-capability",
    backendDeploymentId: "fixture-deployment",
    storageProfileSha256: "a".repeat(64),
    implementationSha256: "b".repeat(64),
    contractSha256: "c".repeat(64),
  };
  const storageEvidence = await artifact(
    "storage-evidence",
    {
      schemaVersion: "1.0.0",
      format: "vertex-research-chat-storage-evidence-v1",
      ...scope,
      ...storageIdentity,
      evidenceId: "storage-evidence",
      issuerActorId: issuer.actorId,
      observedAt: BEFORE,
      expiresAt: END,
      namespace: "vertex/chat-copy/v1",
      createSemantics: "conditional-create-no-overwrite",
      readSemantics: "exact-bound-current-bytes-or-fenced",
      fenceSemantics: "conditional-permanent-tombstone-no-resurrection",
      retainedVersions: "no-application-readable-prior-content-version",
      durabilityEvidence: [report.pin],
      claimScope: "application-managed-copy-namespace-only",
      excludedClaims: [
        "provider",
        "backups",
        "physical-media",
        "RAM",
        "exports",
      ],
    },
    "ResearchChatStorageEvidence",
    null,
    true
  );
  const eventId = "historical-stage-event",
    jobId = `job-${await hashArtifact({ scope, eventId })}`;
  const stable = {
    kind: "research-run",
    researchPrincipalId: issuer.actorId,
    payloadArtifactId: "historical-stage-input",
    payloadSha256: "d".repeat(64),
    policySelectionId: "historical-stage-selection",
    policySelectionSha256: "e".repeat(64),
    deadlineAt: END,
  };
  const lease = {
    ...scope,
    ...stable,
    jobId,
    eventId,
    leaseId: "historical-lease",
    leaseEpoch: "1",
  };
  const service = {
    ...scope,
    grantId: "historical-stage-grant",
    servicePrincipalId: "historical-stage-worker",
    operations: ["stageArtifact"],
    issuedAt: BEFORE,
    expiresAt: END,
    revokedAt: null,
  };
  const stage = {
    ...scope,
    artifactId: storageEvidence.pin.artifactId,
    jobId,
    collectionId: null,
    contentSha256: storageEvidence.pin.artifactSha256,
    canonicalSha256: storageEvidence.pin.artifactSha256,
    contentType: "application/json",
    rightsPolicyId: policyRights.policyId,
    rightsVersion: policyRights.version,
    createdAt: BEFORE,
  };
  table("vertex_worker_stages").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    collection_key: "",
    artifact_id: stage.artifactId,
    job_id: jobId,
    content_sha256: stage.contentSha256,
    canonical_sha256: stage.canonicalSha256,
    byte_length: storageEvidence.body.byteLength,
    object_key: storageEvidence.key,
    request_hash: await hashArtifact(stage),
    payload: stage,
  });
  table("vertex_worker_jobs").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    event_id: eventId,
    grant_id: service.grantId,
    lease_id: lease.leaseId,
    lease_epoch: lease.leaseEpoch,
    binding_hash: await hashArtifact({ scope, eventId, ...stable }),
    payload: lease,
  });
  table("vertex_worker_run_admissions").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    job_id: jobId,
    admitted_at: BEFORE,
    lease_epoch: lease.leaseEpoch,
  });
  table("vertex_worker_service_grants").push({
    account_alias: scope.accountAlias,
    environment: scope.environment,
    grant_id: service.grantId,
    service_principal_id: service.servicePrincipalId,
    record_hash: await hashArtifact(service),
    payload: service,
  });
  await grant(issuer.actorId, storageEvidence.pin.artifactId, ["publish"]);
  await grant(reviewer.actorId, storageEvidence.pin.artifactId, ["review"]);
  state.at = AT;
  const thread = await store.createResearchChatThread({
    principal: owner,
    scope,
    title: "Authored source composition fixture",
    participantIds: [participantId],
    idempotencyKey: "thread",
  });
  const append = (revision: string, key: string) =>
    store.sendResearchChatMessage({
      principal: owner,
      scope,
      threadId: thread["threadId"] as string,
      expectedRevision: revision,
      idempotencyKey: key,
      body: `${SENTINELS.human} ${key}`,
      requestedParticipantIds: [],
      mode: "discuss",
    });
  const message = await append("1", "first");
  const request = {
    ...scope,
    threadId: thread["threadId"] as string,
    parentMessageId: (message["message"] as Row)["messageId"],
    participantId,
    snapshotRevision: "2",
    contextStartSequence: "1",
    retrievalQuery: SENTINELS.query,
    idempotencyKey: "response",
  };
  const responseRequestId = `response-${await hashArtifact({ operation: "requestResponse", actorId: owner.actorId, scope, threadId: request.threadId, idempotencyKey: request.idempotencyKey })}`;
  await grant(
    owner.actorId,
    researchChatContextUseResource(responseRequestId),
    ["publish"]
  );
  await grant(
    reviewer.actorId,
    researchChatStorageReviewResource(responseRequestId),
    ["review"]
  );
  const unexpected = async (): Promise<never> => {
    throw new Error("No copy/model/worker execution in plan/review/approval");
  };
  const runtimeOptions = {
    db,
    clock,
    objectCapabilities,
    policy: {
      consumerServiceId: "fixture-consumer",
      components: [],
      jobModules: [],
    },
    experts:
      participantId === "first-mate"
        ? []
        : [{ participantId, artifact: config.pin }],
    ...(participantId === "first-mate"
      ? { firstMate: { artifact: config.pin } }
      : {}),
    storage: {
      ...storageIdentity,
      evidence: storageEvidence.pin,
      reviewerActorId: reviewer.actorId,
      capabilities: {
        createCopy: unexpected,
        inspectCopy: unexpected,
        readCopy: unexpected,
        fenceCopy: unexpected,
      },
    },
    maxProjectionAgeMs: 60_000,
  };
  const runtime = createVertexResearchChatExecutionRuntime(runtimeOptions);
  const reviewInput = (plan: VertexRecord) => ({
    ...scope,
    responseRequestId,
    planId: plan["planId"],
    planSha256: plan["planSha256"],
    evidence: storageEvidence.pin,
    decision: "accepted",
    allowedCopyOperations: ["create", "inspect", "read", "fence"],
    expiresAt: plan["expiresAt"],
    expectedReviewId: null,
    idempotencyKey: "private-storage-review",
  });
  const approveInput = (plan: VertexRecord) => ({
    planId: plan["planId"],
    planSha256: plan["planSha256"],
    request,
  });
  return {
    ...f,
    objects,
    runtime,
    runtimeOptions,
    store,
    authorization,
    grant,
    artifact,
    corpus,
    corpusReview,
    config,
    selection,
    modelPolicy,
    descriptor,
    tokenize,
    completion,
    request,
    responseRequestId,
    reviewInput,
    approveInput,
    append,
    storageEvidence,
  };
};
