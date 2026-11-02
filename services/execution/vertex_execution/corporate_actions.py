"""Evidence-gated local position transformations, never broker instructions.

Splits/remaps are journal facts, not new strategy versions or recreated fills.
The controller never invents prices, rounds split quantities, or grants authority
from a public portfolio projection. Risk stays paused after transformation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .exact import add, decimal, units
from .owner import PaperExecutionOwner, digest_reference, reference
from .ports import ExecutionError

_MAX_NS = (1 << 63) - 1
_MAX_RATIO = 10**18
_MAX_LINEAGE = 10000


def _integer(value: int, *, positive: bool = False, maximum: int = _MAX_NS) -> None:
    if type(value) is not int or value < (1 if positive else 0) or value > maximum:
        raise ExecutionError("corporate-action-exact-integer-required")


@dataclass(frozen=True)
class CorporateActionProof:
    action_id: str
    action_kind: str
    account_alias: str
    simulator_id: str
    owner_epoch: int
    currency: str
    ledger_sequence: int
    ledger_sha256: str
    old_instrument_id: str
    new_instrument_id: str
    previous_quantity: str
    quantity_numerator: int
    quantity_denominator: int
    previous_qualification_id: str
    previous_qualification_sha256: str
    replacement_qualification_id: str
    replacement_qualification_sha256: str
    lineage_sha256: str
    evidence_sha256: str
    effective_ns: int
    observed_ns: int
    valid_until_ns: int
    cash_delta: str = "0"
    cash_evidence_sha256: str | None = None
    cash_settlement_due_ns: int | None = None

    def __post_init__(self) -> None:
        for name in ("action_id", "account_alias", "simulator_id", "currency", "old_instrument_id", "new_instrument_id",
                     "previous_qualification_id", "replacement_qualification_id"):
            reference(getattr(self, name))
        if self.action_kind not in {"split", "reverse-split", "instrument-remap"}:
            raise ExecutionError("corporate-action-kind-not-supported")
        for name in ("ledger_sha256", "previous_qualification_sha256", "replacement_qualification_sha256", "lineage_sha256", "evidence_sha256"):
            digest_reference(getattr(self, name))
        _integer(self.owner_epoch, positive=True)
        _integer(self.ledger_sequence)
        for value in (self.effective_ns, self.observed_ns, self.valid_until_ns):
            _integer(value)
        if not self.effective_ns <= self.observed_ns < self.valid_until_ns:
            raise ExecutionError("corporate-action-proof-time-order")
        _integer(self.quantity_numerator, positive=True, maximum=_MAX_RATIO)
        _integer(self.quantity_denominator, positive=True, maximum=_MAX_RATIO)
        if units(self.previous_quantity) == 0:
            raise ExecutionError("corporate-action-position-required")
        cash = units(self.cash_delta)
        if cash != 0:
            if self.cash_evidence_sha256 is None or self.cash_settlement_due_ns is None:
                raise ExecutionError("cash-in-lieu-requires-explicit-settlement-proof")
            digest_reference(self.cash_evidence_sha256)
            _integer(self.cash_settlement_due_ns)
            if self.cash_settlement_due_ns < self.effective_ns:
                raise ExecutionError("cash-in-lieu-before-action-effective")
        elif self.cash_evidence_sha256 is not None or self.cash_settlement_due_ns is not None:
            raise ExecutionError("zero-cash-action-has-ambiguous-cash-proof")
        if self.action_kind == "split" and self.quantity_numerator <= self.quantity_denominator:
            raise ExecutionError("split-ratio-must-increase-quantity")
        if self.action_kind == "reverse-split" and self.quantity_numerator >= self.quantity_denominator:
            raise ExecutionError("reverse-split-ratio-must-decrease-quantity")
        if self.action_kind == "instrument-remap" and self.old_instrument_id == self.new_instrument_id:
            raise ExecutionError("instrument-remap-requires-distinct-identity")


class CorporateActionAuthority(Protocol):
    def verify_action(self, proof: CorporateActionProof, *, ledger: Mapping[str, Any], now_ns: int) -> bool:
        """Verify authentic issuer/exchange evidence and current old/new metadata.

        Bind the exact owner/account/epoch, cash currency, source/current ledger,
        complete old AND destination lots, prior action chain, immutable strategy
        and fill lineage, verified split/delivery ratio, effective calendar and
        old/replacement qualification digests. Verify new lot size/multiplier;
        unsupported adjusted deliverables must fail closed. A nonzero cash_delta
        additionally needs an explicit settled cash-in-lieu entitlement with a
        known exact price/amount; no inferred fractional-share sale or mark.
        Return literal True only. This capability is injected; no default lookup,
        network request, price model, broker operation or public projection trust.
        """
        ...


def action_lineage(ledger: Mapping[str, Any], old_instrument_id: str, new_instrument_id: str) -> dict[str, Any]:
    """Bounded private digest input; history is referenced, never rewritten."""
    affected = {old_instrument_id, new_instrument_id}
    fills = {key: value for key, value in ledger["fillLineage"].items() if value["instrumentId"] in affected}
    orders = {key: {"strategyArtifactId": order["strategyArtifactId"], "legs": order["legs"], "fills": order["fills"]}
              for key, order in ledger["orders"].items()
              if affected.intersection(order["legs"]) or affected.intersection(order["shareReserve"])}
    actions = {key: action for key, action in ledger["corporateActions"].items()
               if action["oldInstrumentId"] in affected or action["newInstrumentId"] in affected}
    if len(fills) > _MAX_LINEAGE or len(orders) > _MAX_LINEAGE or len(actions) > _MAX_LINEAGE:
        raise ExecutionError("corporate-action-lineage-bound")
    return {"positions": {instrument: ledger["positions"].get(instrument, "0") for instrument in sorted(affected)},
            "fillLineage": fills, "orders": orders, "corporateActions": actions}


def _record(proof: CorporateActionProof) -> dict[str, Any]:
    return {
        "actionId": proof.action_id,
        "actionKind": proof.action_kind,
        "accountAlias": proof.account_alias,
        "simulatorId": proof.simulator_id,
        "ownerEpoch": str(proof.owner_epoch),
        "currency": proof.currency,
        "ledgerSequence": str(proof.ledger_sequence),
        "ledgerSha256": proof.ledger_sha256,
        "oldInstrumentId": proof.old_instrument_id,
        "newInstrumentId": proof.new_instrument_id,
        "quantityNumerator": str(proof.quantity_numerator),
        "quantityDenominator": str(proof.quantity_denominator),
        "previousQuantity": proof.previous_quantity,
        "cashDelta": proof.cash_delta,
        "previousQualificationId": proof.previous_qualification_id,
        "previousQualificationSha256": proof.previous_qualification_sha256,
        "replacementQualificationId": proof.replacement_qualification_id,
        "replacementQualificationSha256": proof.replacement_qualification_sha256,
        "lineageSha256": proof.lineage_sha256,
        "evidenceSha256": proof.evidence_sha256,
        "effectiveNs": str(proof.effective_ns),
        "observedNs": str(proof.observed_ns),
        "validUntilNs": str(proof.valid_until_ns),
        "cashEvidenceSha256": proof.cash_evidence_sha256,
        "cashSettlementDueNs": None if proof.cash_settlement_due_ns is None else str(proof.cash_settlement_due_ns),
    }


class CorporateActionController:
    def __init__(self, owner: PaperExecutionOwner, authority: CorporateActionAuthority) -> None:
        self.owner = owner
        self.authority = authority

    def apply(self, proof: CorporateActionProof, *, now_ns: int) -> None:
        if not isinstance(proof, CorporateActionProof):
            raise ExecutionError("typed-corporate-action-proof-required")
        _integer(now_ns)
        owner = self.owner
        with owner.journal.mutex:
            ledger = owner._scope()
            if (proof.account_alias != ledger["accountAlias"] or proof.simulator_id != ledger["simulatorId"]
                    or ledger["environment"] != "paper" or proof.currency != ledger["currency"]
                    or proof.owner_epoch != owner.epoch or str(proof.owner_epoch) != ledger["ownerEpoch"]):
                raise ExecutionError("corporate-action-owner-scope-mismatch")
            record = _record(proof)
            record["proofSha256"] = owner.authority.digest(record)
            applied = ledger["corporateActions"].get(proof.action_id)
            if applied is not None:
                if {key: value for key, value in applied.items() if key != "newQuantity"} != record:
                    raise ExecutionError("corporate-action-idempotency-conflict")
                # Exact already-journaled action is a no-op even after freshness
                # expires. It grants no new authority and never transforms twice.
                return
            if not proof.effective_ns <= proof.observed_ns <= now_ns < proof.valid_until_ns:
                raise ExecutionError("corporate-action-proof-not-current")
            snapshot, sequence, digest = owner.journal.snapshot()
            if proof.ledger_sequence != sequence or proof.ledger_sha256 != digest:
                raise ExecutionError("corporate-action-ledger-conflict")
            if owner.authority.digest(action_lineage(snapshot, proof.old_instrument_id, proof.new_instrument_id)) != proof.lineage_sha256:
                raise ExecutionError("corporate-action-lineage-mismatch")
            current = ledger["positions"].get(proof.old_instrument_id, "0")
            if current != proof.previous_quantity:
                raise ExecutionError("corporate-action-position-conflict")
            affected = {proof.old_instrument_id, proof.new_instrument_id}
            if any((affected.intersection(order["legs"]) or affected.intersection(order["shareReserve"]))
                   and (order["reservationState"] != "released" or order.get("finalityProven") is not True)
                   for order in ledger["orders"].values()):
                raise ExecutionError("corporate-action-open-order-or-collateral")
            if any(position["instrumentId"] in affected for position in ledger["unsettledPositions"].values()):
                raise ExecutionError("corporate-action-unsettled-position")
            if any(key in ledger["unsettledCredits"] and lineage["instrumentId"] in affected
                   for key, lineage in ledger["fillLineage"].items()):
                raise ExecutionError("corporate-action-unsettled-cash-lineage")
            product = units(current) * proof.quantity_numerator
            if product % proof.quantity_denominator:
                raise ExecutionError("corporate-action-inexact-quantity")
            transformed = decimal(product // proof.quantity_denominator)
            # Preflight all reducer arithmetic before the first durable write.
            destination = "0" if proof.old_instrument_id == proof.new_instrument_id else ledger["positions"].get(proof.new_instrument_id, "0")
            add(destination, transformed)
            resulting_cash = add(ledger["cash"], proof.cash_delta)
            other_cash = sum(units(order["cashReserve"]) for order in ledger["orders"].values() if order["reservationState"] != "released")
            if units(resulting_cash) < other_cash:
                raise ExecutionError("corporate-action-cash-deficit-retain-collateral")
            if proof.cash_settlement_due_ns is not None and proof.cash_settlement_due_ns > min(proof.observed_ns, now_ns):
                raise ExecutionError("cash-in-lieu-not-mature")
            if self.authority.verify_action(proof, ledger=snapshot, now_ns=now_ns) is not True:
                raise ExecutionError("corporate-action-evidence-unverified")
            # Evidence callbacks receive only a copy. Still fail closed if a
            # reentrant caller changed the owner or journal while verifying it.
            owner._scope()
            _, current_sequence, current_hash = owner.journal.snapshot()
            if current_sequence != sequence or current_hash != digest:
                raise ExecutionError("corporate-action-ledger-changed-during-verification")
            # Out-of-band durable inhibit survives a failed native-fact encode
            # or first invalidation append; successful reset owns latch release.
            owner.journal.latch_pause("corporate-action", now_ns=now_ns)
            for instrument in sorted(affected):
                if instrument not in owner.journal.state["invalidQualifications"]:
                    owner.journal.append("qualification-invalidated", {"instrumentId": instrument}, now_ns=now_ns,
                                         event_id="action-invalidate-" + owner.authority.digest({"proof": record["proofSha256"], "instrument": instrument}))
            # If any append fails, existing invalidations remain durable and
            # paused. No rollback/unpause or stale-proof automatic retry. A new
            # proof must bind the new journal head before resuming the action.
            if not owner.journal.state["pausedNewRisk"] or proof.old_instrument_id not in owner.journal.state["invalidQualifications"]:
                raise ExecutionError("corporate-action-requires-paused-invalid-qualification")
            owner.journal.append("corporate-action", record, now_ns=now_ns,
                                 event_id="corporate-action-" + owner.authority.digest({"actionId": proof.action_id}))
            # Never restore qualifications or reset risk here. Reconciliation,
            # trusted requalification and separately authorized reset must follow.
