import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  array,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  type Row,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type { VertexRecord, VertexScope, VertexStore } from "./vertex-ports.ts";
import { createProjectionIngestion } from "./vertex-projection-ingestion.ts";

// Shared observation normalization, not a genesis/authority gate. Callers must
// validate the exact immutable snapshot and admit it under the account fence.
export const persistPortfolioSnapshotRows = async (
  tx: Transaction,
  scope: VertexScope,
  value: VertexRecord,
  hash: string
): Promise<void> => {
  await insert(tx, "vertex_portfolio_snapshots", scope, {
    snapshot_id: value["snapshotId"],
    stream_id: value["streamId"],
    owner_epoch: value["ownerEpoch"],
    sequence: value["sequence"],
    source_event_hash: value["sourceEventHash"],
    source_kind: value["sourceKind"],
    as_of_at_ns: time(value["asOfAt"]).toString(),
    received_at_ns: time(value["receivedAt"]).toString(),
    record_hash: hash,
    payload: value,
  });
  const instrumentIds = new Set<string>();
  for (const row of [
    ...array(value["positions"], 10_000),
    ...array(value["lots"], 20_000),
    ...array(value["reservations"], 10_000),
  ].map(object)) {
    if (row["instrumentId"] !== null)
      instrumentIds.add(identifier(row["instrumentId"]));
  }
  for (const instrumentId of instrumentIds) {
    await tx.execute(
      sql`insert into vertex_instruments (account_alias,environment,instrument_id,observed_at) values (${scope.accountAlias},${scope.environment},${instrumentId},${value["asOfAt"]}) on conflict (account_alias,environment,instrument_id) do nothing`
    );
  }
  for (const row of array(value["positions"], 10_000).map(object)) {
    await insert(tx, "vertex_portfolio_positions", scope, {
      snapshot_id: value["snapshotId"],
      instrument_id: row["instrumentId"],
      quantity: row["quantity"],
      market_value: row["marketValue"],
      cost_basis: row["costBasis"],
      currency: row["currency"],
      price_as_of: row["priceAsOf"],
      sleeve_id: row["sleeveId"],
    });
  }
  for (const row of array(value["lots"], 20_000).map(object)) {
    await insert(tx, "vertex_portfolio_lots", scope, {
      snapshot_id: value["snapshotId"],
      lot_id: row["lotId"],
      instrument_id: row["instrumentId"],
      quantity: row["quantity"],
      unit_cost: row["unitCost"],
      currency: row["currency"],
      opened_at: row["openedAt"],
      source_event_id: row["sourceEventId"],
    });
  }
  for (const row of array(value["reservations"], 10_000).map(object)) {
    await insert(tx, "vertex_reservation_observations", scope, {
      snapshot_id: value["snapshotId"],
      reservation_id: row["reservationId"],
      submission_key: row["submissionKey"],
      instrument_id: row["instrumentId"],
      cash_amount: row["cashAmount"],
      share_quantity: row["shareQuantity"],
      currency: row["currency"],
      state: row["state"],
      source_event_id: row["sourceEventId"],
      authoritative: false,
    });
  }
  for (const row of array(value["sleeveAllocations"], 128).map(object)) {
    await insert(tx, "vertex_sleeve_observations", scope, {
      snapshot_id: value["snapshotId"],
      sleeve_id: row["sleeveId"],
      allocated_amount: row["allocatedAmount"],
      currency: row["currency"],
      source_event_id: row["sourceEventId"],
      authoritative: false,
    });
  }
};

export const createProjectionOperations = (ctx: PersistenceContext) => {
  const ingestion = createProjectionIngestion(ctx);
  const continuity = (
    scope: VertexScope,
    head: Row,
    at: string
  ): VertexRecord => {
    const observed =
      head["last_occurred_at"] === null
        ? null
        : string(head["last_occurred_at"]);
    const received =
      head["last_received_at"] === null
        ? null
        : string(head["last_received_at"]);
    if (received !== null && time(received) > time(at)) fail("stale");
    let maxAgeMs = ctx.maxProjectionAgeMs;
    if (observed !== null && head["expires_at_ns"] !== null) {
      const ttl = BigInt(string(head["expires_at_ns"])) - time(observed) - 1n;
      const bound = ttl <= 0n ? 0n : ttl / 1_000_000n;
      if (bound < BigInt(maxAgeMs)) maxAgeMs = Number(bound);
    }
    const stale =
      observed !== null &&
      time(at) - time(observed) > BigInt(maxAgeMs) * 1_000_000n;
    const storedState = string(head["state"]);
    const state = ["gap", "epoch-mismatch", "unavailable"].includes(storedState)
      ? storedState
      : observed === null
        ? "empty"
        : stale
          ? "stale"
          : "continuous";
    return {
      accountAlias: scope.accountAlias,
      environment: scope.environment,
      streamId: head["stream_id"],
      ownerEpoch: head["owner_epoch"],
      highWaterSequence: head["high_water_sequence"],
      highWaterEventHash: head["high_water_event_hash"],
      lastOccurredAt: observed,
      lastReceivedAt: received,
      evaluatedAt: at,
      freshness: {
        status: observed === null ? "missing" : stale ? "stale" : "fresh",
        observedAt: observed,
        evaluatedAt: at,
        maxAgeMs,
      },
      state,
      expectedNextSequence: (
        sequence(head["high_water_sequence"]) + 1n
      ).toString(),
      receivedSequence:
        state === "gap" || state === "epoch-mismatch"
          ? head["received_sequence"]
          : null,
      newRiskInhibited: true,
      authoritative: false,
    };
  };
  const currentPortfolio = async (
    tx: Transaction,
    scope: VertexScope,
    at: string
  ): Promise<VertexRecord | null> => {
    // A retired epoch can have a later receipt timestamp than its replacement.
    // Select only a snapshot belonging to its stream's CURRENT owner fence.
    const stored = await one(
      tx,
      "vertex_portfolio_snapshots",
      scope,
      sql`exists (select 1 from vertex_projection_heads h where h.account_alias = vertex_portfolio_snapshots.account_alias and h.environment = vertex_portfolio_snapshots.environment and h.stream_id = vertex_portfolio_snapshots.stream_id and h.owner_epoch = vertex_portfolio_snapshots.owner_epoch)`,
      sql`order by received_at_ns desc, as_of_at_ns desc, snapshot_id desc`
    );
    if (!stored) return null;
    if ((await ctx.hash(stored["payload"])) !== stored["record_hash"])
      fail("integrity");
    const value = object(stored["payload"]);
    if (
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment ||
      value["snapshotId"] !== stored["snapshot_id"] ||
      value["streamId"] !== stored["stream_id"] ||
      value["ownerEpoch"] !== stored["owner_epoch"] ||
      value["sequence"] !== stored["sequence"] ||
      value["sourceEventHash"] !== stored["source_event_hash"]
    )
      fail("integrity");
    const head = await one(
      tx,
      "vertex_projection_heads",
      scope,
      sql`stream_id = ${value["streamId"]}`
    );
    if (!head) fail("integrity");
    if (requirePresent(head, "head")["owner_epoch"] !== value["ownerEpoch"])
      return null;
    // Preserve this immutable snapshot's high-water identity. A newer head does
    // not relabel old holdings as current holdings.
    const snapshotHead: Row = {
      ...head,
      stream_id: value["streamId"],
      owner_epoch: value["ownerEpoch"],
      high_water_sequence: value["sequence"],
      high_water_event_hash: value["sourceEventHash"],
      last_occurred_at: value["asOfAt"],
      last_received_at: value["receivedAt"],
    };
    if (
      requirePresent(head, "head")["high_water_sequence"] !==
        value["sequence"] ||
      requirePresent(head, "head")["high_water_event_hash"] !==
        value["sourceEventHash"]
    ) {
      snapshotHead["state"] = "gap";
      snapshotHead["received_sequence"] = requirePresent(head, "head")[
        "high_water_sequence"
      ];
    }
    if (value["sourceKind"] === "source-unavailable")
      snapshotHead["state"] = "unavailable";
    return {
      ...structuredClone(value),
      continuity: continuity(scope, snapshotHead, at),
    };
  };
  const appendExecutionProjection: VertexStore["appendExecutionProjection"] =
    async (principal, scope, input) => {
      const value = await ctx.validate("ExecutionProjection", input);
      ctx.scoped(value, scope);
      if (value["actorId"] !== principal.actorId) fail("denied");
      const { eventHash, ...identity } = value;
      if ((await ctx.hash(identity)) !== eventHash) fail("integrity");
      return ctx.run(
        principal,
        scope,
        null,
        identifier(value["streamId"]),
        "project",
        async (tx, at) => {
          if (
            time(value["receivedAt"]) > time(at) ||
            time(object(value["receipt"])["lastReconciledAt"]) >
              time(value["receivedAt"])
          )
            fail("invalid");
          if (value["sourceKind"] === "paper-simulation") {
            const admission = await one(
              tx,
              "vertex_paper_jobs",
              scope,
              sql`admission_id = ${value["admissionId"]}`
            );
            if (
              !admission ||
              (await ctx.hash(admission["payload"])) !==
                admission["record_hash"]
            )
              fail("integrity");
            const admitted = object(
              requirePresent(admission, "admission")["payload"]
            );
            // Projection actor is the explicitly authorized native emitter. The
            // human reviewer actor remains preserved on the linked admission.
            for (const key of [
              "policyVersion",
              "strategyVersion",
              "reviewedArtifactSha256",
              "streamId",
              "ownerEpoch",
            ]) {
              if (value[key] !== admitted[key]) fail("integrity");
            }
            // Admission expiry inhibits new work; it does not erase later native
            // fills, cancellations or reconciliation facts for the admitted intent.
            if (
              object(value["receipt"])["intentId"] !== admitted["intentId"] ||
              time(value["occurredAt"]) < time(admitted["admittedAt"])
            )
              fail("integrity");
          }
          return ingestion.append(tx, scope, value, at, "order", async () => {
            const receipt = object(value["receipt"]);
            await insert(tx, "vertex_receipt_orders", scope, {
              projection_id: value["projectionId"],
              submission_key: receipt["submissionKey"],
              intent_id: receipt["intentId"],
              broker_order_ref: receipt["brokerOrderRef"],
              status: receipt["status"],
              total_quantity: receipt["totalQuantity"],
              filled_quantity: receipt["filledQuantity"],
              remaining_quantity: receipt["remainingQuantity"],
              payload: receipt,
            });
            return await insert(tx, "vertex_receipt_fills", scope, {
              projection_id: value["projectionId"],
              submission_key: receipt["submissionKey"],
              cumulative_filled_quantity: receipt["filledQuantity"],
              last_reconciled_at: receipt["lastReconciledAt"],
            });
          });
        }
      );
    };
  const recordPortfolioSnapshot: VertexStore["recordPortfolioSnapshot"] =
    async (principal, scope, input) => {
      const value = await ctx.validate("PortfolioSnapshot", input);
      ctx.scoped(value, scope);
      const hash = await ctx.hash(value);
      return ctx.run(
        principal,
        scope,
        null,
        identifier(value["streamId"]),
        "project",
        async (tx, at) => {
          if (time(value["receivedAt"]) > time(at)) fail("invalid");
          const prior = await one(
            tx,
            "vertex_portfolio_snapshots",
            scope,
            sql`snapshot_id = ${value["snapshotId"]} or (stream_id = ${value["streamId"]} and owner_epoch = ${value["ownerEpoch"]} and sequence = ${value["sequence"]})`
          );
          if (prior) {
            if (
              prior["record_hash"] !== hash ||
              prior["snapshot_id"] !== value["snapshotId"]
            )
              fail("conflict");
            return "duplicate" as const;
          }
          const head = await one(
            tx,
            "vertex_projection_heads",
            scope,
            sql`stream_id = ${value["streamId"]}`
          );
          if (head) {
            if (
              head["owner_epoch"] !== value["ownerEpoch"] ||
              head["high_water_sequence"] !== value["sequence"] ||
              head["high_water_event_hash"] !== value["sourceEventHash"] ||
              head["last_occurred_at"] !== value["asOfAt"] ||
              head["last_received_at"] !== value["receivedAt"]
            )
              fail("stale");
            const event = await ingestion.findAppliedProjection(
              tx,
              scope,
              value["streamId"],
              value["ownerEpoch"],
              value["sequence"],
              value["sourceEventHash"]
            );
            if (!event) fail("integrity");
            const native = object(requirePresent(event, "event")["payload"]);
            if (
              value["sourceKind"] !== "source-unavailable" &&
              value["sourceKind"] !== native["sourceKind"]
            )
              fail("integrity");
          } else {
            // Only the native simulator may originate an initial local checkpoint.
            // This transaction OBSERVES it; no cloud value becomes spendable state.
            const sourceContinuity = object(value["continuity"]);
            if (
              scope.environment !== "paper" ||
              value["sourceKind"] !== "paper-simulation" ||
              value["sequence"] !== "1" ||
              sourceContinuity["state"] !== "continuous" ||
              time(sourceContinuity["evaluatedAt"]) > time(at)
            )
              fail("stale");
            const previousFacts = await one(
              tx,
              "vertex_execution_projections",
              scope,
              sql`stream_id = ${value["streamId"]}`
            );
            const previousNativeFacts = await one(
              tx,
              "vertex_native_fact_projections",
              scope,
              sql`stream_id = ${value["streamId"]}`
            );
            const previousSnapshot = await one(
              tx,
              "vertex_portfolio_snapshots",
              scope,
              sql`stream_id = ${value["streamId"]}`
            );
            if (previousFacts || previousNativeFacts || previousSnapshot)
              fail("conflict");
            const {
              sourceEventHash: _sourceEventHash,
              continuity: _continuity,
              ...genesisBody
            } = value;
            const {
              highWaterEventHash: _highWaterEventHash,
              ...continuityBody
            } = sourceContinuity;
            if (
              (await ctx.hash({
                ...genesisBody,
                continuity: continuityBody,
              })) !== value["sourceEventHash"]
            )
              fail("integrity");
            const freshness = object(sourceContinuity["freshness"]);
            const sourceMaxAgeMs = freshness["maxAgeMs"];
            if (
              typeof sourceMaxAgeMs !== "number" ||
              !Number.isSafeInteger(sourceMaxAgeMs) ||
              sourceMaxAgeMs < 0
            )
              fail("invalid");
            const maxAgeMs = Math.min(sourceMaxAgeMs, ctx.maxProjectionAgeMs);
            const expiresAtNs =
              time(value["asOfAt"]) + BigInt(maxAgeMs) * 1_000_000n + 1n;
            const stale = time(at) >= expiresAtNs;
            await ctx.ensureAccount(tx, scope, at);
            await insert(tx, "vertex_projection_heads", scope, {
              stream_id: value["streamId"],
              owner_epoch: value["ownerEpoch"],
              high_water_sequence: "1",
              high_water_event_hash: value["sourceEventHash"],
              last_occurred_at: value["asOfAt"],
              last_received_at: value["receivedAt"],
              expires_at_ns: expiresAtNs.toString(),
              state: stale ? "stale" : "continuous",
              received_sequence: null,
            });
          }
          const latest = await one(
            tx,
            "vertex_portfolio_snapshots",
            scope,
            sql`stream_id = ${value["streamId"]} and owner_epoch = ${value["ownerEpoch"]}`,
            sql`order by received_at_ns desc, as_of_at_ns desc, snapshot_id desc`
          );
          if (
            latest &&
            (BigInt(string(latest["received_at_ns"])) >
              time(value["receivedAt"]) ||
              BigInt(string(latest["as_of_at_ns"])) > time(value["asOfAt"]))
          )
            fail("stale");
          await persistPortfolioSnapshotRows(tx, scope, value, hash);
          return "recorded" as const;
        }
      );
    };
  const getPortfolioSnapshot: VertexStore["getPortfolioSnapshot"] = async (
    principal,
    scope
  ) => {
    return await ctx.run(
      principal,
      scope,
      null,
      "portfolio",
      "read",
      (tx, at) => currentPortfolio(tx, scope, at)
    );
  };
  const getContinuity: VertexStore["getContinuity"] = async (
    principal,
    scope,
    streamId
  ) => {
    return await ctx.run(
      principal,
      scope,
      null,
      identifier(streamId),
      "read",
      async (tx, at) => {
        const head = await one(
          tx,
          "vertex_projection_heads",
          scope,
          sql`stream_id = ${streamId}`
        );
        return head ? continuity(scope, head, at) : null;
      }
    );
  };
  return {
    appendExecutionProjection,
    recordPortfolioSnapshot,
    getPortfolioSnapshot,
    getContinuity,
    continuity,
    currentPortfolio,
  };
};
