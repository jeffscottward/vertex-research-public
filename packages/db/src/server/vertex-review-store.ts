import { decimalUnits } from "@darkfactory/shared/vertex";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  collectionId,
  collectionKey,
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
import type { VertexRecord, VertexScope, VertexStore } from "./vertex-ports.ts";

export const createReviewOperations = (
  ctx: PersistenceContext,
  currentPortfolio: (
    tx: Transaction,
    scope: VertexScope,
    at: string
  ) => Promise<VertexRecord | null>
) => {
  const recordReview: VertexStore["recordReview"] = async (
    principal,
    scope,
    input
  ) => {
    const value = await ctx.validate("AcceptedReview", input);
    ctx.scoped(value, scope);
    const collection =
      value["collectionId"] === null ? null : identifier(value["collectionId"]);
    const hash = await ctx.hash(value);
    return ctx.run(
      principal,
      scope,
      collection,
      identifier(value["artifactId"]),
      "review",
      async (tx, at) => {
        if (
          value["actorId"] !== principal.actorId ||
          time(value["reviewedAt"]) > time(at) ||
          time(value["expiresAt"]) <= time(at)
        )
          fail("denied");
        const artifact = await ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          identifier(value["artifactId"]),
          "read",
          at
        );
        if (!artifact || artifact.artifactSha256 !== value["artifactSha256"])
          fail("integrity");
        const record = await one(
          tx,
          "vertex_records",
          scope,
          sql`artifact_id = ${value["artifactId"]} and collection_key = ${collectionKey(collection)}`
        );
        const strategy = await one(
          tx,
          "vertex_records",
          scope,
          sql`contract_name = 'StrategySpec' and artifact_id = ${value["strategyVersion"]}`
        );
        if (!(record && strategy)) fail("integrity");
        const body = object(requirePresent(record, "record")["payload"]);
        if ((await ctx.hash(body)) !== artifact.artifactSha256)
          fail("integrity");
        if (
          body["strategyVersion"] !== undefined &&
          body["strategyVersion"] !== value["strategyVersion"]
        )
          fail("integrity");
        if (
          requirePresent(record, "record")["contract_name"] ===
            "StrategySpec" &&
          requirePresent(record, "record")["artifact_id"] !==
            value["strategyVersion"]
        )
          fail("integrity");
        if (
          value["purpose"] === "paper-simulation" &&
          (requirePresent(record, "record")["contract_name"] !==
            "TradeIntent" ||
            scope.environment !== "paper")
        )
          fail("denied");
        const strategyArtifact = await ctx.artifact(
          tx,
          principal,
          scope,
          collectionId(requirePresent(strategy, "strategy")["collection_key"]),
          identifier(value["strategyVersion"]),
          "read",
          at
        );
        if (!strategyArtifact) fail("denied");
        const strategyHash = await ctx.hash(
          requirePresent(strategy, "strategy")["payload"]
        );
        if (
          strategyHash !==
            requirePresent(strategyArtifact, "strategyArtifact")
              .artifactSha256 ||
          strategyHash !== requirePresent(strategy, "strategy")["record_hash"]
        )
          fail("integrity");
        const previous = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`review_id = ${value["reviewId"]}`
        );
        if (previous) {
          if (previous["record_hash"] !== hash) fail("conflict");
          return "duplicate" as const;
        }
        const latest = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`artifact_id = ${value["artifactId"]} and collection_key = ${collectionKey(collection)} and purpose = ${value["purpose"]}`,
          sql`order by reviewed_at_ns desc, review_id desc`
        );
        if (
          (latest?.["review_id"] ?? null) !== value["supersedesReviewId"] ||
          (latest &&
            time(value["reviewedAt"]) <=
              BigInt(string(latest["reviewed_at_ns"])))
        )
          fail("conflict");
        await insert(tx, "vertex_reviews", scope, {
          collection_key: collectionKey(collection),
          review_id: value["reviewId"],
          artifact_id: value["artifactId"],
          artifact_sha256: value["artifactSha256"],
          actor_id: value["actorId"],
          policy_version: value["policyVersion"],
          strategy_version: value["strategyVersion"],
          review_version: value["reviewVersion"],
          decision: value["decision"],
          purpose: value["purpose"],
          reviewed_at_ns: time(value["reviewedAt"]).toString(),
          expires_at_ns: time(value["expiresAt"]).toString(),
          supersedes_review_id: value["supersedesReviewId"],
          record_hash: hash,
          payload: value,
        });
        return "recorded" as const;
      }
    );
  };
  const listReviews: VertexStore["listReviews"] = async (
    principal,
    scope,
    artifactId
  ) => {
    return await ctx.run(
      principal,
      scope,
      null,
      identifier(artifactId),
      "read",
      async (tx, at) => {
        const artifact = await one(
          tx,
          "vertex_artifacts",
          scope,
          sql`artifact_id = ${artifactId}`
        );
        if (!artifact) return [];
        const collection = collectionId(artifact["collection_key"]);
        if (
          !(await ctx.artifact(
            tx,
            principal,
            scope,
            collection,
            artifactId,
            "read",
            at
          ))
        )
          fail("denied");
        const found = await rows(
          tx,
          sql`select * from vertex_reviews where ${scopeWhere(scope)} and collection_key = ${collectionKey(collection)} and artifact_id = ${artifactId} order by reviewed_at_ns desc, review_id desc limit 512`
        );
        const values: VertexRecord[] = [];
        for (const row of found) {
          if ((await ctx.hash(row["payload"])) !== row["record_hash"])
            fail("integrity");
          values.push(structuredClone(object(row["payload"])));
        }
        return values;
      }
    );
  };
  const admitPaperSimulation: VertexStore["admitPaperSimulation"] = async (
    principal,
    scope,
    input
  ) => {
    const value = await ctx.validate("PaperSimulationAdmission", input);
    ctx.scoped(value, scope);
    const hash = await ctx.hash(value);
    return ctx.run(
      principal,
      scope,
      null,
      identifier(value["admissionId"]),
      "admit-paper-simulation",
      async (tx, at) => {
        if (
          scope.environment !== "paper" ||
          value["admissionKind"] !== "PAPER-SIMULATION" ||
          value["actorId"] !== principal.actorId ||
          value["simulationOnly"] !== true ||
          value["brokerSubmissionAllowed"] !== false ||
          value["liveAuthorization"] !== false ||
          value["executionAuthorized"] !== false
        )
          fail("denied");
        const review = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`review_id = ${value["reviewId"]}`
        );
        if (
          !review ||
          (await ctx.hash(review["payload"])) !== review["record_hash"]
        )
          fail("integrity");
        const reviewed = object(requirePresent(review, "review")["payload"]);
        const collection = collectionId(
          requirePresent(review, "review")["collection_key"]
        );
        await ctx.authorize(
          principal,
          scope,
          collection,
          identifier(value["admissionId"]),
          "admit-paper-simulation",
          at
        );
        const artifact = await ctx.artifact(
          tx,
          principal,
          scope,
          collection,
          identifier(requirePresent(review, "review")["artifact_id"]),
          "read",
          at
        );
        if (
          artifact?.contractName !== "TradeIntent" ||
          artifact.artifactSha256 !== value["intentSha256"] ||
          value["reviewedArtifactSha256"] !== artifact.artifactSha256
        )
          fail("integrity");
        const intentRecord = await one(
          tx,
          "vertex_records",
          scope,
          sql`artifact_id = ${artifact.artifactId} and collection_key = ${collectionKey(collection)} and contract_name = 'TradeIntent'`
        );
        if (
          !intentRecord ||
          (await ctx.hash(intentRecord["payload"])) !== artifact.artifactSha256
        )
          fail("integrity");
        const intent = object(
          requirePresent(intentRecord, "intentRecord")["payload"]
        );
        if (
          intent["intentId"] !== value["intentId"] ||
          intent["strategyVersion"] !== value["strategyVersion"] ||
          intent["accountAlias"] !== scope.accountAlias ||
          intent["environment"] !== "paper" ||
          intent["executionAuthorized"] !== false ||
          intent["proposalOnly"] !== true
        )
          fail("integrity");
        const latest = await one(
          tx,
          "vertex_reviews",
          scope,
          sql`artifact_id = ${artifact.artifactId} and collection_key = ${collectionKey(collection)} and purpose = 'paper-simulation'`,
          sql`order by reviewed_at_ns desc, review_id desc`
        );
        if (
          !latest ||
          latest["review_id"] !== value["reviewId"] ||
          reviewed["decision"] !== "accepted" ||
          reviewed["purpose"] !== "paper-simulation"
        )
          fail("denied");
        for (const key of [
          "reviewVersion",
          "actorId",
          "policyVersion",
          "strategyVersion",
        ]) {
          if (reviewed[key] !== value[key]) fail("integrity");
        }
        const strategy = await one(
          tx,
          "vertex_records",
          scope,
          sql`contract_name = 'StrategySpec' and artifact_id = ${value["strategyVersion"]}`
        );
        if (!strategy) fail("integrity");
        const strategyArtifact = await ctx.artifact(
          tx,
          principal,
          scope,
          collectionId(requirePresent(strategy, "strategy")["collection_key"]),
          identifier(value["strategyVersion"]),
          "read",
          at
        );
        if (!strategyArtifact) fail("denied");
        const strategyHash = await ctx.hash(
          requirePresent(strategy, "strategy")["payload"]
        );
        if (
          strategyHash !==
            requirePresent(strategyArtifact, "strategyArtifact")
              .artifactSha256 ||
          strategyHash !== requirePresent(strategy, "strategy")["record_hash"]
        )
          fail("integrity");
        const limits = object(
          object(requirePresent(strategy, "strategy")["payload"])["riskLimits"]
        );
        if (
          decimalUnits(string(value["maximumLoss"])) >
            decimalUnits(string(intent["maxLossBudget"])) ||
          decimalUnits(string(value["maximumLoss"])) >
            decimalUnits(string(limits["maximumLoss"])) ||
          decimalUnits(string(value["maximumNotional"])) >
            decimalUnits(string(limits["maximumNotional"]))
        )
          fail("denied");
        if (
          time(value["admittedAt"]) > time(at) ||
          time(value["admittedAt"]) < time(reviewed["reviewedAt"]) ||
          time(value["expiresAt"]) <= time(at) ||
          time(reviewed["expiresAt"]) <= time(at) ||
          time(intent["expiresAt"]) <= time(at) ||
          time(value["expiresAt"]) > time(reviewed["expiresAt"]) ||
          time(value["expiresAt"]) > time(intent["expiresAt"])
        )
          fail("stale");
        await ctx.authorize(principal, scope, null, "portfolio", "read", at);
        const portfolio = await currentPortfolio(tx, scope, at);
        if (
          !portfolio ||
          portfolio["snapshotId"] !== value["portfolioSnapshotId"] ||
          portfolio["sequence"] !== value["portfolioSequence"] ||
          portfolio["streamId"] !== value["streamId"] ||
          portfolio["ownerEpoch"] !== value["ownerEpoch"] ||
          portfolio["sourceKind"] === "source-unavailable" ||
          object(portfolio["continuity"])["state"] !== "continuous" ||
          object(object(portfolio["continuity"])["freshness"])["status"] !==
            "fresh"
        )
          fail("stale");
        const head = await one(
          tx,
          "vertex_projection_heads",
          scope,
          sql`stream_id = ${value["streamId"]}`
        );
        if (
          !head ||
          head["owner_epoch"] !== value["ownerEpoch"] ||
          head["high_water_sequence"] !== value["portfolioSequence"] ||
          head["high_water_event_hash"] !==
            requirePresent(portfolio, "portfolio")["sourceEventHash"] ||
          head["state"] !== "continuous"
        )
          fail("stale");
        const previous = await one(
          tx,
          "vertex_paper_jobs",
          scope,
          sql`admission_id = ${value["admissionId"]} or idempotency_key = ${value["idempotencyKey"]}`
        );
        if (previous) {
          if (
            previous["record_hash"] !== hash ||
            previous["admission_id"] !== value["admissionId"]
          )
            fail("conflict");
          return "duplicate" as const;
        }
        await insert(tx, "vertex_paper_jobs", scope, {
          admission_id: value["admissionId"],
          simulator_id: value["simulatorId"],
          review_id: value["reviewId"],
          intent_id: value["intentId"],
          intent_sha256: value["intentSha256"],
          portfolio_snapshot_id: value["portfolioSnapshotId"],
          idempotency_key: value["idempotencyKey"],
          record_hash: hash,
          expires_at_ns: time(value["expiresAt"]).toString(),
          payload: value,
        });
        // This is an internal simulation job, not a synthetic public EventEnvelope
        // or a notification. No reservation allocation, spend or release occurs.
        await insert(tx, "vertex_outbox", scope, {
          collection_key: collectionKey(collection),
          event_id: `simulation-${hash}`,
          event_type: "vertex.paper-simulation.admitted",
          idempotency_key: `simulation-${hash}`,
          record_hash: hash,
          payload: value,
          available_at_ns: time(at).toString(),
          lease_owner: null,
          lease_fence: "0",
          lease_expires_at: null,
          lease_expires_at_ns: null,
          published_at: null,
          settlement_hash: null,
        });
        return "admitted" as const;
      }
    );
  };
  return { recordReview, listReviews, admitPaperSimulation };
};
