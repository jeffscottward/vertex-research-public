"""Pure observation-only genesis from a fenced owner's replayed journal state.

The caller must pass journal.snapshot()[0] under the native ownership fence,
AFTER the independent observation/capital-policy authority has qualified it.
This is not an input importer or a means of restoring buying power from cloud
PortfolioSnapshot records. One genesis per owner epoch and durable outbox/chain
publication are journal-owner responsibilities, not work performed here.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .exact import units
from .ports import ContractAuthority, ExecutionError


_PLACEHOLDER = "0" * 64
_PUBLIC_ONLY_KEYS = frozenset({
    "schemaVersion", "snapshotId", "sequence", "sourceEventHash", "sourceKind",
    "asOfAt", "receivedAt", "netAssetValue", "reservations", "sleeveAllocations",
    "continuity", "observationOnly", "executionAuthorized", "researchNotionalIncluded",
})
_TERMINAL = frozenset({"filled", "cancelled", "rejected"})
_ORDER_STATUSES = _TERMINAL | {"not-submitted", "submitted", "partially-filled", "unknown"}


def _digest(value: Any) -> str:
    if type(value) is not str or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ExecutionError("genesis-invalid-native-digest")
    return value


def _integer_string(value: Any, *, positive: bool = False) -> int:
    if (
        type(value) is not str or not value.isascii() or not value.isdecimal()
        or len(value) > 39 or (len(value) > 1 and value.startswith("0"))
    ):
        raise ExecutionError("genesis-invalid-native-integer")
    result = int(value)
    if result >= 2**127 or (positive and result == 0):
        raise ExecutionError("genesis-invalid-native-integer")
    return result


def _amount(value: Any, *, nonnegative: bool = False) -> str:
    if type(value) is not str:
        raise ExecutionError("genesis-exact-native-decimal-required")
    if nonnegative and units(value) < 0:
        raise ExecutionError("genesis-negative-native-collateral")
    units(value)
    return value


def _hash_body(snapshot: dict[str, Any]) -> dict[str, Any]:
    body = deepcopy(snapshot)
    del body["sourceEventHash"]
    del body["continuity"]["highWaterEventHash"]
    return body


def validate_genesis(authority: ContractAuthority, snapshot: dict[str, Any]) -> str:
    """Native equivalent of the frozen v4 parsePortfolioGenesis hash boundary.

    The native authority alone owns PortfolioSnapshot/public field validation.
    The only self-hash omissions are sourceEventHash and highWaterEventHash;
    chronology, freshness, scope and every economic observation stay covered.
    """
    if authority.validate("PortfolioGenesis", snapshot, schema_version="1.0.0") is not True:
        raise ExecutionError("genesis-public-contract-rejected")
    if (
        snapshot["environment"] != "paper" or snapshot["sourceKind"] != "paper-simulation"
        or snapshot["sequence"] != "1" or snapshot["continuity"]["state"] != "continuous"
    ):
        raise ExecutionError("genesis-paper-initial-stream-only")
    source_hash = _digest(snapshot["sourceEventHash"])
    if snapshot["continuity"]["highWaterEventHash"] != source_hash:
        raise ExecutionError("genesis-continuity-hash-mismatch")
    if _digest(authority.digest(_hash_body(snapshot))) != source_hash:
        raise ExecutionError("genesis-content-hash-mismatch")
    return source_hash


def _owned_scope(state: dict[str, Any], owner_epoch: int) -> dict[str, Any]:
    if type(state) is not dict or _PUBLIC_ONLY_KEYS.intersection(state):
        raise ExecutionError("cloud-portfolio-is-not-native-genesis-authority")
    required = {"accountAlias", "environment", "simulatorId", "currency", "ownerEpoch", "cash", "positions", "orders", "observation", "reconciled", "pausedNewRisk"}
    if not required.issubset(state):
        raise ExecutionError("genesis-native-owner-state-incomplete")
    if state["environment"] != "paper" or type(state["simulatorId"]) is not str or not state["simulatorId"]:
        raise ExecutionError("genesis-native-paper-scope-required")
    if type(owner_epoch) is not int or owner_epoch <= 0 or state["ownerEpoch"] != str(owner_epoch):
        raise ExecutionError("genesis-owner-epoch-mismatch")
    _integer_string(state["ownerEpoch"], positive=True)
    if type(state["reconciled"]) is not bool or type(state["pausedNewRisk"]) is not bool:
        raise ExecutionError("genesis-native-readiness-unavailable")
    if not state["reconciled"] and not state["pausedNewRisk"]:
        raise ExecutionError("genesis-unreconciled-owner-must-remain-paused")
    if type(state["positions"]) is not dict or type(state["orders"]) is not dict:
        raise ExecutionError("genesis-native-ledger-maps-required")
    observation = state["observation"]
    if type(observation) is not dict or not {
        "observationId", "sourceSequence", "observedNs", "receivedNs", "validUntilNs",
        "cash", "positions", "evidenceSha256",
    }.issubset(observation):
        raise ExecutionError("genesis-qualified-owner-observation-required")
    _integer_string(observation["sourceSequence"], positive=True)
    _digest(observation["evidenceSha256"])
    if observation["cash"] != state["cash"] or observation["positions"] != state["positions"]:
        raise ExecutionError("genesis-observation-does-not-reconcile-current-owned-balances")
    return observation


def _reservations(authority: ContractAuthority, state: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if len(state["orders"]) > 10_000 or any(type(key) is not str for key in state["orders"]):
        raise ExecutionError("genesis-order-projection-bound-exceeded")
    for submission_key, order in sorted(state["orders"].items()):
        if type(order) is not dict or not {
            "submissionKey", "reservationEventId", "cashReserve", "shareReserve", "reservationState",
            "status", "dispatchMarked", "finalityProven", "cancelRequested", "reconciledEpoch", "admission",
        }.issubset(order):
            raise ExecutionError("genesis-reservation-lineage-unavailable")
        if order["submissionKey"] != submission_key or type(order["reservationEventId"]) is not str or not order["reservationEventId"]:
            raise ExecutionError("genesis-reservation-source-event-mismatch")
        admission = order["admission"]
        if authority.validate("PaperSimulationAdmission", admission, schema_version="1.0.0") is not True:
            raise ExecutionError("genesis-reservation-admission-rejected")
        if (
            admission["accountAlias"] != state["accountAlias"] or admission["environment"] != "paper"
            or admission["simulatorId"] != state["simulatorId"]
            or _integer_string(admission["ownerEpoch"], positive=True) > int(state["ownerEpoch"])
        ):
            raise ExecutionError("genesis-reservation-scope-mismatch")
        status, reservation_state = order["status"], order["reservationState"]
        if status not in _ORDER_STATUSES or reservation_state not in {"reserved", "settlement-held", "released"}:
            raise ExecutionError("genesis-unsupported-reservation-state")
        if any(type(order[field]) is not bool for field in ("dispatchMarked", "finalityProven", "cancelRequested")):
            raise ExecutionError("genesis-reservation-finality-unavailable")
        reconciled_epoch = _integer_string(order["reconciledEpoch"], positive=True)
        if reconciled_epoch > int(state["ownerEpoch"]):
            raise ExecutionError("genesis-reservation-future-epoch")
        if reservation_state in {"released", "settlement-held"} and not order["finalityProven"]:
            raise ExecutionError("genesis-reservation-release-not-proven")
        projected_state = "reserved"
        if reservation_state == "released":
            projected_state = "released"
        elif status == "unknown" or (
            not order["finalityProven"] and (
                status in _TERMINAL or order["cancelRequested"]
                or (order["dispatchMarked"] and reconciled_epoch != int(state["ownerEpoch"]))
            )
        ):
            projected_state = "unknown"
        cash = _amount(order["cashReserve"], nonnegative=True)
        shares = order["shareReserve"]
        if type(shares) is not dict or any(type(key) is not str for key in shares):
            raise ExecutionError("genesis-share-reservation-map-required")
        if len(result) + 1 + len(shares) > 10_000:
            raise ExecutionError("genesis-reservation-projection-bound-exceeded")
        components = [(None, cash, "0"), *((instrument, "0", _amount(quantity, nonnegative=True)) for instrument, quantity in sorted(shares.items()))]
        for instrument, cash_amount, share_quantity in components:
            identity = {"kind": "native-genesis-reservation-v1", "accountAlias": state["accountAlias"],
                        "submissionKey": submission_key, "instrumentId": instrument}
            result.append({
                "reservationId": "reservation-" + _digest(authority.digest(identity)),
                "submissionKey": submission_key, "instrumentId": instrument,
                "cashAmount": cash_amount, "shareQuantity": share_quantity, "currency": state["currency"],
                "state": projected_state, "sourceEventId": order["reservationEventId"], "authoritative": False,
            })
    return result


def _lots(state: dict[str, Any]) -> list[dict[str, Any]]:
    # Current journal has no lot-cost ledger. Absence means no owned lot records,
    # not zero unit costs or permission to reconstruct tax lots from fill cash.
    owned = state.get("lots", {})
    if type(owned) is not dict or len(owned) > 20_000 or any(type(key) is not str for key in owned):
        raise ExecutionError("genesis-native-lot-map-required")
    result = []
    fields = ("lotId", "instrumentId", "quantity", "unitCost", "currency", "openedAt", "sourceEventId")
    for lot_id, lot in sorted(owned.items()):
        if type(lot) is not dict or not set(fields).issubset(lot) or lot["lotId"] != lot_id:
            raise ExecutionError("genesis-owned-lot-cost-or-lineage-unavailable")
        _amount(lot["quantity"])
        _amount(lot["unitCost"], nonnegative=True)
        result.append({key: deepcopy(lot[key]) for key in fields})
    return result


def _build_snapshot(
    authority: ContractAuthority,
    owned_state: dict[str, Any],
    stream_id: str,
    owner_epoch: int,
    observed_at: str,
    received_at: str,
    evaluated_at: str,
    max_age_ms: int,
    snapshot_id: str,
    sequence: int,
    source_event_hash: str,
    *,
    genesis: bool,
) -> dict[str, Any]:
    """Map only qualified current native balances; caller owns durable head proof."""
    observation = _owned_scope(owned_state, owner_epoch)
    if type(sequence) is not int or not 1 <= sequence < 2**127 - 1:
        raise ExecutionError("portfolio-native-sequence-required")
    _digest(source_event_hash)
    if any(type(value) is not str for value in (observed_at, received_at, evaluated_at)):
        raise ExecutionError("genesis-native-timestamp-strings-required")
    clocks = tuple(authority.epoch_ns(value) for value in (observed_at, received_at, evaluated_at))
    if any(type(value) is not int for value in clocks):
        raise ExecutionError("genesis-native-exact-clock-required")
    observed_ns, received_ns, evaluated_ns = clocks
    native_observed = _integer_string(observation["observedNs"])
    native_received = _integer_string(observation["receivedNs"])
    valid_until = _integer_string(observation["validUntilNs"])
    if (
        type(max_age_ms) is not int or not 0 <= max_age_ms <= 2**53 - 1
        or not native_observed <= native_received <= evaluated_ns < valid_until
        or not observed_ns <= received_ns <= evaluated_ns
        or evaluated_ns - native_observed > max_age_ms * 1_000_000
        or evaluated_ns - observed_ns > max_age_ms * 1_000_000
        or (genesis and (observed_ns != native_observed or received_ns != native_received))
    ):
        raise ExecutionError("genesis-observation-clock-or-freshness-invalid")
    positions = owned_state["positions"]
    if len(positions) > 10_000 or any(type(key) is not str for key in positions):
        raise ExecutionError("genesis-position-projection-bound-exceeded")
    scope = {"accountAlias": owned_state["accountAlias"], "environment": "paper",
             "streamId": stream_id, "ownerEpoch": str(owner_epoch)}
    snapshot = {
        "schemaVersion": "1.0.0", "snapshotId": snapshot_id, **scope,
        "sequence": str(sequence), "sourceEventHash": source_event_hash, "sourceKind": "paper-simulation",
        "asOfAt": observed_at, "receivedAt": received_at, "currency": owned_state["currency"],
        "cash": _amount(owned_state["cash"], nonnegative=True), "netAssetValue": None,
        "positions": [{"instrumentId": instrument, "quantity": _amount(quantity), "marketValue": None,
                       "costBasis": None, "currency": owned_state["currency"], "priceAsOf": None, "sleeveId": None}
                      for instrument, quantity in sorted(positions.items())],
        "lots": _lots(owned_state), "reservations": _reservations(authority, owned_state), "sleeveAllocations": [],
        "continuity": {
            **scope, "highWaterSequence": str(sequence), "highWaterEventHash": source_event_hash,
            "lastOccurredAt": observed_at, "lastReceivedAt": received_at, "evaluatedAt": evaluated_at,
            "freshness": {"status": "fresh", "observedAt": observed_at, "evaluatedAt": evaluated_at, "maxAgeMs": max_age_ms},
            "state": "continuous", "expectedNextSequence": str(sequence + 1), "receivedSequence": None,
            "newRiskInhibited": True, "authoritative": False,
        },
        "observationOnly": True, "executionAuthorized": False, "researchNotionalIncluded": False,
    }
    if authority.validate("PortfolioSnapshot", snapshot, schema_version="1.0.0") is not True:
        raise ExecutionError("genesis-public-contract-rejected")
    return snapshot


def build_genesis(
    authority: ContractAuthority,
    owned_state: dict[str, Any],
    stream_id: str,
    owner_epoch: int,
    observed_at: str,
    received_at: str,
    evaluated_at: str,
    max_age_ms: int,
    snapshot_id: str,
) -> dict[str, Any]:
    """Create sequence one from native state; never accept public seed capital.

    Both placeholder hashes satisfy PortfolioSnapshot shape validation before
    hashing. Only the final matched hashes are submitted to PortfolioGenesis.
    """
    snapshot = _build_snapshot(
        authority, owned_state, stream_id, owner_epoch, observed_at, received_at,
        evaluated_at, max_age_ms, snapshot_id, 1, _PLACEHOLDER, genesis=True,
    )
    digest = _digest(authority.digest(_hash_body(snapshot)))
    snapshot["sourceEventHash"] = digest
    snapshot["continuity"]["highWaterEventHash"] = digest
    validate_genesis(authority, snapshot)
    return snapshot


def build_snapshot(
    authority: ContractAuthority,
    owned_state: dict[str, Any],
    stream_id: str,
    owner_epoch: int,
    observed_at: str,
    received_at: str,
    evaluated_at: str,
    max_age_ms: int,
    snapshot_id: str,
    sequence: int,
    source_event_hash: str,
) -> dict[str, Any]:
    """Project a qualified owned state linked to the owner's exact durable head.

    This is not a new event or a genesis rehash. Parent must prove supplied
    sequence/hash/clocks from its fenced durable projection/native-fact chain.
    A current matching native observation may precede or follow that event.
    Neither it nor this cloud-facing record is promoted into spendable capital.
    """
    return _build_snapshot(
        authority, owned_state, stream_id, owner_epoch, observed_at, received_at,
        evaluated_at, max_age_ms, snapshot_id, sequence, source_event_hash, genesis=False,
    )
