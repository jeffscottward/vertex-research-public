import {
  record,
  list,
  ns,
  text,
  same,
  requireEpoch,
  epochFail,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import { present } from "./present.ts";

const SCALE = 10n ** 18n;
export const units = (value: unknown): bigint => {
  const valueText = text(value);
  requireEpoch(
    /^(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))$/.test(
      valueText
    )
  );
  const [whole, fraction = ""] = valueText.replace(/^-/, "").split(".");
  return (
    (valueText.startsWith("-") ? -1n : 1n) *
    (BigInt(present(whole)) * SCALE + BigInt(fraction.padEnd(18, "0")))
  );
};
export const decimal = (value: bigint): string => {
  const absolute = value < 0n ? -value : value;
  requireEpoch(absolute < 10n ** 48n);
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / SCALE}${fraction ? `.${fraction}` : ""}`;
};
const add = (a: unknown, b: unknown): string => decimal(units(a) + units(b));
const values = (value: unknown): NativeRecord[] =>
  Object.values(record(value)).map(record);
const terminal = (value: unknown): boolean =>
  ["filled", "cancelled", "rejected"].includes(text(value));
const omit = (value: NativeRecord, fields: string[]): NativeRecord =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !fields.includes(key))
  );
export const initialNativeEpochState = (
  accountAlias: string,
  simulatorId: string,
  currency: string
): NativeRecord => ({
  accountAlias,
  environment: "paper",
  simulatorId,
  currency,
  ownerEpoch: "0",
  pausedNewRisk: true,
  pauseReasons: ["initial-reconciliation-required"],
  reconciled: false,
  observation: null,
  cash: "0",
  positions: {},
  orders: {},
  unsettledCredits: {},
  unsettledPositions: {},
  fillLineage: {},
  corporateActions: {},
  optionObligations: {},
  portfolioRevision: "0",
  settlements: {},
  invalidQualifications: [],
  liquidationRequests: [],
});

// Source parity: execution/vertex_execution/journal.py apply_event. No IO,
// grants, seed construction or economic side effects: replay original evidence.
export const applyNativeEpochEvent = (
  state: NativeRecord,
  event: NativeRecord
): void => {
  const kind = text(event["kind"]);
  const data = record(event["data"]);
  if (
    [
      "observation",
      "reserve",
      "paper-event",
      "finalized",
      "abandon-reserved",
      "trade-settled",
      "settlement",
      "corporate-action",
    ].includes(kind)
  )
    state["portfolioRevision"] = (
      ns(state["portfolioRevision"]) + 1n
    ).toString();
  if (kind === "epoch-claimed") {
    requireEpoch(ns(data["epoch"]) === ns(state["ownerEpoch"]) + 1n);
    state["ownerEpoch"] = data["epoch"];
    state["pausedNewRisk"] = true;
    state["reconciled"] = false;
    state["pauseReasons"] = ["restart-reconciliation-required"];
    for (const order of values(state["orders"])) {
      if (order["dispatchMarked"] && !order["finalityProven"])
        order["status"] = "unknown";
    }
  } else if (kind === "observation") {
    if (state["observation"] === null) {
      state["cash"] = data["cash"];
      state["positions"] = structuredClone(data["positions"]);
    } else {
      requireEpoch(
        ns(data["sourceSequence"]) > ns(state["observation"].sourceSequence)
      );
      requireEpoch(
        data["cash"] === state["cash"] &&
          same(data["positions"], state["positions"])
      );
    }
    state["observation"] = structuredClone(data);
  } else if (kind === "reconciled") {
    requireEpoch(
      state["observation"] !== null &&
        !values(state["orders"]).some(
          (order) =>
            order["dispatchMarked"] &&
            !order["finalityProven"] &&
            (order["status"] === "unknown" ||
              order["reconciledEpoch"] !== state["ownerEpoch"])
        )
    );
    state["reconciled"] = true;
  } else if (kind === "portfolio-genesis" || kind === "portfolio-checkpoint") {
    if (kind === "portfolio-genesis") {
      requireEpoch(
        !state["portfolioCheckpoint"] ||
          state["portfolioCheckpoint"].ownerEpoch !== state["ownerEpoch"]
      );
    } else requireEpoch(data["ownerEpoch"] === state["ownerEpoch"]);
    state["portfolioCheckpoint"] = {
      ...structuredClone(data),
      portfolioRevision: state["portfolioRevision"],
    };
  } else if (kind === "checkpoint-recorded") {
    state["lastAuditCheckpoint"] = structuredClone(data);
  } else if (kind === "reserve") {
    const key = text(data["submissionKey"]);
    requireEpoch(
      !(Object.hasOwn(state["orders"], key) || state["pausedNewRisk"]) &&
        state["reconciled"]
    );
    const qualified = list(data["qualifiedKeys"] ?? [key]);
    requireEpoch(
      qualified.length > 0 && new Set(qualified).size === qualified.length
    );
    let cash = 0n;
    const shares = new Map<string, bigint>();
    for (const [oldKey, rawOrder] of Object.entries(record(state["orders"]))) {
      const order = record(rawOrder);
      requireEpoch(
        !list(order["qualifiedKeys"] ?? [oldKey]).some((candidate) =>
          qualified.includes(candidate)
        )
      );
      if (order["reservationState"] === "released") continue;
      cash += units(order["cashReserve"]);
      for (const [instrument, amount] of Object.entries(
        record(order["shareReserve"])
      ))
        shares.set(instrument, (shares.get(instrument) ?? 0n) + units(amount));
    }
    requireEpoch(
      units(data["cashReserve"]) >= 0n &&
        cash + units(data["cashReserve"]) <= units(state["cash"])
    );
    for (const [instrument, amount] of Object.entries(
      record(data["shareReserve"])
    )) {
      const unsettled = values(state["unsettledPositions"])
        .filter((position) => position["instrumentId"] === instrument)
        .reduce((total, position) => total + units(position["quantity"]), 0n);
      requireEpoch(
        units(amount) >= 0n &&
          (shares.get(instrument) ?? 0n) + units(amount) <=
            units(state["positions"][instrument] ?? "0") - unsettled
      );
    }
    Object.defineProperty(state["orders"], key, {
      value: structuredClone(data),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else if (
    [
      "dispatch",
      "cancel-request",
      "paper-event",
      "finalized",
      "order-reconciled",
      "abandon-reserved",
    ].includes(kind)
  ) {
    requireEpoch(Object.hasOwn(state["orders"], data["submissionKey"]));
    const order = record(state["orders"][data["submissionKey"]]);
    requireEpoch(order["payloadSha256"] === data["payloadSha256"]);
    if (kind === "abandon-reserved") {
      requireEpoch(
        !order["dispatchMarked"] &&
          Object.keys(record(order["fills"])).length === 0
      );
      Object.assign(order, {
        status: "rejected",
        cancelRequested: true,
        finalityProven: true,
        reservationState: "released",
      });
    } else if (kind === "dispatch") {
      requireEpoch(
        !order["dispatchMarked"] && order["status"] === "not-submitted"
      );
      Object.assign(order, { dispatchMarked: true, status: "unknown" });
    } else if (kind === "cancel-request") {
      requireEpoch(order["dispatchMarked"] && !order["finalityProven"]);
      order["cancelRequested"] = true;
    } else if (kind === "order-reconciled") {
      requireEpoch(
        [
          "submitted",
          "partially-filled",
          "filled",
          "cancelled",
          "rejected",
        ].includes(data["status"])
      );
      const totals = Object.fromEntries(
        Object.entries(record(order["legs"])).map(([instrument, leg]) => [
          instrument,
          record(leg)["filled"],
        ])
      );
      requireEpoch(same(data["cumulativeFills"], totals));
      Object.assign(order, {
        status: data["status"],
        reconciledEpoch: state["ownerEpoch"],
      });
    } else if (kind === "paper-event") {
      const identifier = text(data["eventId"]);
      if (Object.hasOwn(order["events"], identifier)) {
        requireEpoch(same(order["events"][identifier], data));
        return;
      }
      requireEpoch(!order["finalityProven"] && order["dispatchMarked"]);
      Object.defineProperty(order["events"], identifier, {
        value: structuredClone(data),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (data["orderRef"] !== undefined && data["orderRef"] !== null) {
        requireEpoch(
          order["orderRef"] === null || order["orderRef"] === data["orderRef"]
        );
        order["orderRef"] = data["orderRef"];
      }
      if (data["eventKind"] === "fill") {
        const fillId = text(data["fillId"]);
        const comparable = omit(data, ["eventId", "occurredNs"]);
        if (Object.hasOwn(order["fills"], fillId)) {
          requireEpoch(same(order["fills"][fillId], comparable));
          return;
        }
        const instrument = text(data["instrumentId"]);
        requireEpoch(Object.hasOwn(order["legs"], instrument));
        const leg = record(order["legs"][instrument]);
        requireEpoch(units(data["quantity"]) > 0n && units(data["fee"]) >= 0n);
        const filled = add(leg["filled"], data["quantity"]);
        requireEpoch(units(filled) <= units(leg["maximumQuantity"]));
        leg["filled"] = filled;
        Object.defineProperty(order["fills"], fillId, {
          value: structuredClone(comparable),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        const pending = `${data["submissionKey"]}:${fillId}`;
        if (units(data["cashDelta"]) > 0n) {
          state["unsettledCredits"][pending] = data["cashDelta"];
        } else state["cash"] = add(state["cash"], data["cashDelta"]);
        state["cash"] = decimal(units(state["cash"]) - units(data["fee"]));
        requireEpoch(units(state["cash"]) >= 0n);
        const delta =
          units(data["quantity"]) * (leg["side"] === "buy" ? 1n : -1n);
        requireEpoch(leg["side"] === "buy" || leg["side"] === "sell");
        Object.defineProperty(state["positions"], instrument, {
          value: decimal(units(state["positions"][instrument] ?? "0") + delta),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (delta > 0n)
          state["unsettledPositions"][pending] = {
            instrumentId: instrument,
            quantity: decimal(delta),
          };
        state["fillLineage"][pending] = {
          sourceEventId: identifier,
          strategyArtifactId: order["strategyArtifactId"],
          instrumentId: instrument,
          signedQuantity: decimal(delta),
          cashDelta: data["cashDelta"],
          fee: data["fee"],
          occurredNs: data["occurredNs"],
          settled: false,
        };
        order["status"] = values(order["legs"]).every(
          (legValue) => legValue["filled"] === legValue["maximumQuantity"]
        )
          ? "filled"
          : "partially-filled";
      } else if (data["eventKind"] === "accepted") {
        if (Object.keys(record(order["fills"])).length === 0)
          order["status"] = "submitted";
      } else if (
        data["eventKind"] === "cancelled" ||
        data["eventKind"] === "rejected"
      ) {
        requireEpoch(
          data["eventKind"] !== "rejected" ||
            Object.keys(record(order["fills"])).length === 0
        );
        order["status"] = data["eventKind"];
      } else if (data["eventKind"] === "unknown") {
        order["status"] = "unknown";
      } else epochFail();
    } else {
      requireEpoch(
        terminal(order["status"]) &&
          same(
            [...new Set(list(data["finalEventIds"]))].sort(),
            Object.keys(record(order["events"])).sort()
          )
      );
      order["finalityProven"] = true;
      order["finalEvidenceSha256"] = data["evidenceSha256"];
      order["reservationState"] =
        !order["settlementRequired"] ||
        Object.keys(record(order["fills"])).length === 0
          ? "released"
          : "settlement-held";
    }
  } else if (kind === "pause") {
    state["pausedNewRisk"] = true;
    if (!list(state["pauseReasons"]).includes(data["reason"]))
      state["pauseReasons"].push(data["reason"]);
  } else if (kind === "reset") {
    requireEpoch(
      state["reconciled"] && list(state["invalidQualifications"]).length === 0
    );
    state["pausedNewRisk"] = false;
    state["pauseReasons"] = [];
  } else if (kind === "qualification-invalidated") {
    if (!list(state["invalidQualifications"]).includes(data["instrumentId"]))
      state["invalidQualifications"].push(data["instrumentId"]);
    state["pausedNewRisk"] = true;
    state["reconciled"] = false;
  } else if (kind === "qualification-restored") {
    requireEpoch(
      list(state["invalidQualifications"]).includes(data["instrumentId"])
    );
    state["invalidQualifications"] = state["invalidQualifications"].filter(
      (instrument: unknown) => instrument !== data["instrumentId"]
    );
  } else if (kind === "corporate-action") {
    const old = text(data["oldInstrumentId"]);
    const replacement = text(data["newInstrumentId"]);
    requireEpoch(
      !Object.hasOwn(state["corporateActions"], data["actionId"]) &&
        list(state["invalidQualifications"]).includes(old)
    );
    requireEpoch(
      !values(state["orders"]).some(
        (order) =>
          (Object.hasOwn(order["legs"], old) ||
            Object.hasOwn(order["shareReserve"], old)) &&
          order["reservationState"] !== "released"
      )
    );
    requireEpoch(
      !values(state["unsettledPositions"]).some(
        (position) => position["instrumentId"] === old
      )
    );
    const current = state["positions"][old] ?? "0";
    const numerator = ns(data["quantityNumerator"]);
    const denominator = ns(data["quantityDenominator"]);
    requireEpoch(
      numerator > 0n &&
        denominator > 0n &&
        (units(current) * numerator) % denominator === 0n &&
        current === data["previousQuantity"]
    );
    const transformed = decimal((units(current) * numerator) / denominator);
    state["positions"][old] = "0";
    state["positions"][replacement] = add(
      state["positions"][replacement] ?? "0",
      transformed
    );
    state["cash"] = add(state["cash"], data["cashDelta"]);
    state["corporateActions"][data["actionId"]] = {
      ...structuredClone(data),
      newQuantity: transformed,
    };
    state["pausedNewRisk"] = true;
    state["reconciled"] = false;
  } else if (kind === "trade-settled") {
    for (const pending of list(data["fillKeys"])) {
      requireEpoch(Object.hasOwn(state["fillLineage"], pending));
      const lineage = record(state["fillLineage"][pending]);
      requireEpoch(!lineage["settled"]);
      state["cash"] = add(
        state["cash"],
        state["unsettledCredits"][pending] ?? "0"
      );
      delete state["unsettledCredits"][pending];
      delete state["unsettledPositions"][pending];
      lineage["settled"] = true;
      lineage["settlementEvidenceSha256"] = data["evidenceSha256"];
    }
  } else if (kind === "option-obligation") {
    requireEpoch(
      Object.hasOwn(state["orders"], data["submissionKey"]) &&
        state["orders"][data["submissionKey"]].reservationState !== "released"
    );
    state["optionObligations"][data["obligationId"]] = structuredClone(data);
    state["pausedNewRisk"] = true;
    state["reconciled"] = false;
  } else if (kind === "settlement") {
    requireEpoch(
      !Object.hasOwn(state["settlements"], data["settlementId"]) &&
        Object.hasOwn(state["orders"], data["submissionKey"])
    );
    const order = record(state["orders"][data["submissionKey"]]);
    requireEpoch(
      order["finalityProven"] && order["reservationState"] === "settlement-held"
    );
    state["cash"] = add(state["cash"], data["cashDelta"]);
    for (const [instrument, delta] of Object.entries(
      record(data["positionDeltas"])
    ))
      state["positions"][instrument] = add(
        state["positions"][instrument] ?? "0",
        delta
      );
    order["reservationState"] = "released";
    state["settlements"][data["settlementId"]] = structuredClone(data);
    for (const [obligationId, obligation] of Object.entries(
      record(state["optionObligations"])
    )) {
      if (record(obligation)["submissionKey"] === data["submissionKey"])
        delete state["optionObligations"][obligationId];
    }
  } else if (kind === "liquidation-request") {
    state["liquidationRequests"].push(structuredClone(data));
    state["pausedNewRisk"] = true;
  } else epochFail();
};
