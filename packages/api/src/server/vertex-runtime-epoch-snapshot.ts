import {
  PaperSimulationAdmissionSchema,
  PortfolioSnapshotSchema,
  parsePortfolioGenesis,
} from "../contracts/vertex-control.ts";
import {
  canonical,
  hashArtifact,
  ns,
  record,
  requireEpoch,
  same,
  sha,
  text,
  timestampToEpochNanoseconds,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import { units } from "./vertex-runtime-epoch-replay.ts";

const amount = (value: unknown, nonnegative = false): string => {
  const result = text(value);
  requireEpoch(!nonnegative || units(result) >= 0n);
  units(result);
  return result;
};

// Rebuild every public economic field from native replay; only public identity
// and clocks are parameters. No public cash/reservation/notional is imported.
export const rebuildEpochSnapshot = async (
  state: NativeRecord,
  input: unknown,
  genesis = true
): Promise<NativeRecord> => {
  const target = PortfolioSnapshotSchema.parse(input);
  requireEpoch(
    state["environment"] === "paper" &&
      ns(state["ownerEpoch"]) > 0n &&
      state["ownerEpoch"] === target.ownerEpoch &&
      state["accountAlias"] === target.accountAlias &&
      state["currency"] === target.currency
  );
  requireEpoch(
    typeof state["reconciled"] === "boolean" &&
      typeof state["pausedNewRisk"] === "boolean" &&
      (state["reconciled"] || state["pausedNewRisk"])
  );
  const observation = record(state["observation"]);
  requireEpoch(
    ns(observation["sourceSequence"]) > 0n &&
      observation["cash"] === state["cash"] &&
      same(observation["positions"], state["positions"])
  );
  sha(observation["evidenceSha256"]);
  const observed = timestampToEpochNanoseconds(target.asOfAt);
  const received = timestampToEpochNanoseconds(target.receivedAt);
  const evaluated = timestampToEpochNanoseconds(target.continuity.evaluatedAt);
  const age = BigInt(target.continuity.freshness.maxAgeMs) * 1_000_000n;
  requireEpoch(
    ns(observation["observedNs"]) <= ns(observation["receivedNs"]) &&
      ns(observation["receivedNs"]) <= evaluated &&
      evaluated < ns(observation["validUntilNs"]) &&
      observed <= received &&
      received <= evaluated &&
      evaluated - ns(observation["observedNs"]) <= age &&
      evaluated - observed <= age
  );
  if (genesis)
    requireEpoch(
      observed === ns(observation["observedNs"]) &&
        received === ns(observation["receivedNs"])
    );
  const positions = Object.entries(record(state["positions"]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([instrumentId, quantity]) => ({
      instrumentId,
      quantity: amount(quantity),
      marketValue: null,
      costBasis: null,
      currency: state["currency"],
      priceAsOf: null,
      sleeveId: null,
    }));
  requireEpoch(positions.length <= 10_000);
  const lots = Object.entries(record(state["lots"] ?? {}))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lotId, raw]) => {
      const lot = record(raw);
      requireEpoch(lot["lotId"] === lotId);
      amount(lot["quantity"]);
      amount(lot["unitCost"], true);
      return Object.fromEntries(
        [
          "lotId",
          "instrumentId",
          "quantity",
          "unitCost",
          "currency",
          "openedAt",
          "sourceEventId",
        ].map((key) => [key, lot[key]])
      );
    });
  requireEpoch(lots.length <= 20_000);
  const reservations: NativeRecord[] = [];
  const orders = Object.entries(record(state["orders"])).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  requireEpoch(orders.length <= 10_000);
  for (const [submissionKey, raw] of orders) {
    const order = record(raw);
    requireEpoch(
      order["submissionKey"] === submissionKey &&
        typeof order["reservationEventId"] === "string"
    );
    const admission = PaperSimulationAdmissionSchema.parse(order["admission"]);
    requireEpoch(
      admission.accountAlias === state["accountAlias"] &&
        admission.environment === "paper" &&
        admission.simulatorId === state["simulatorId"] &&
        ns(admission.ownerEpoch) <= ns(state["ownerEpoch"])
    );
    requireEpoch(
      [
        "not-submitted",
        "submitted",
        "partially-filled",
        "filled",
        "cancelled",
        "rejected",
        "unknown",
      ].includes(order["status"]) &&
        ["reserved", "settlement-held", "released"].includes(
          order["reservationState"]
        )
    );
    requireEpoch(
      ["dispatchMarked", "finalityProven", "cancelRequested"].every(
        (key) => typeof order[key] === "boolean"
      ) &&
        ns(order["reconciledEpoch"]) > 0n &&
        ns(order["reconciledEpoch"]) <= ns(state["ownerEpoch"])
    );
    requireEpoch(
      !["released", "settlement-held"].includes(order["reservationState"]) ||
        order["finalityProven"]
    );
    let projected = "reserved";
    if (order["reservationState"] === "released") {
      projected = "released";
    } else if (
      order["status"] === "unknown" ||
      (!order["finalityProven"] &&
        (["filled", "cancelled", "rejected"].includes(order["status"]) ||
          order["cancelRequested"] ||
          (order["dispatchMarked"] &&
            order["reconciledEpoch"] !== state["ownerEpoch"])))
    )
      projected = "unknown";
    const components: [string | null, string, string][] = [
      [null, amount(order["cashReserve"], true), "0"],
    ];
    for (const [instrument, quantity] of Object.entries(
      record(order["shareReserve"])
    ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      components.push([instrument, "0", amount(quantity, true)]);
    requireEpoch(reservations.length + components.length <= 10_000);
    for (const [instrumentId, cashAmount, shareQuantity] of components) {
      const reservationId = `reservation-${await hashArtifact({ kind: "native-genesis-reservation-v1", accountAlias: state["accountAlias"], submissionKey, instrumentId })}`;
      reservations.push({
        reservationId,
        submissionKey,
        instrumentId,
        cashAmount,
        shareQuantity,
        currency: state["currency"],
        state: projected,
        sourceEventId: order["reservationEventId"],
        authoritative: false,
      });
    }
  }
  const scope = {
    accountAlias: state["accountAlias"],
    environment: "paper",
    streamId: target.streamId,
    ownerEpoch: state["ownerEpoch"],
  };
  const body: NativeRecord = {
    schemaVersion: "1.0.0",
    snapshotId: target.snapshotId,
    ...scope,
    sequence: target.sequence,
    sourceKind: "paper-simulation",
    asOfAt: target.asOfAt,
    receivedAt: target.receivedAt,
    currency: state["currency"],
    cash: amount(state["cash"], true),
    netAssetValue: null,
    positions,
    lots,
    reservations,
    sleeveAllocations: [],
    continuity: {
      ...scope,
      highWaterSequence: target.sequence,
      lastOccurredAt: target.asOfAt,
      lastReceivedAt: target.receivedAt,
      evaluatedAt: target.continuity.evaluatedAt,
      freshness: {
        status: "fresh",
        observedAt: target.asOfAt,
        evaluatedAt: target.continuity.evaluatedAt,
        maxAgeMs: target.continuity.freshness.maxAgeMs,
      },
      state: "continuous",
      expectedNextSequence: (ns(target.sequence) + 1n).toString(),
      receivedSequence: null,
      newRiskInhibited: true,
      authoritative: false,
    },
    observationOnly: true,
    executionAuthorized: false,
    researchNotionalIncluded: false,
  };
  const sourceHash = genesis
    ? await hashArtifact(body)
    : target.sourceEventHash;
  body["sourceEventHash"] = sourceHash;
  body["continuity"].highWaterEventHash = sourceHash;
  requireEpoch(same(body, target));
  if (genesis) await parsePortfolioGenesis(body);
  canonical(body);
  return body;
};
