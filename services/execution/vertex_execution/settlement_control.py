"""Promote qualified *local* simulation settlement into the owned journal.

Pure settlement.py outputs remain nonspendable until this durable boundary verifies
source/model/calendar/fill lineage and exact maturity. No public portfolio row,
LLM claim or unqualified simulator boolean can unlock collateral.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Protocol

from .exact import add, decimal, subtract, units
from .owner import PaperExecutionOwner, digest_reference, reference
from .ports import ExecutionError
from .settlement import SettlementEvent


@dataclass(frozen=True)
class TradeSettlementProof:
    proof_id: str
    fill_keys: tuple[str, ...]
    account_alias: str
    simulator_id: str
    owner_epoch: int
    due_ns: int
    observed_ns: int
    calendar_artifact_id: str
    evidence_sha256: str


class SettlementEvidencePort(Protocol):
    def verify_trade(self, proof: TradeSettlementProof, *, ledger: Mapping[str, Any], now_ns: int) -> bool:
        """Verify actual exchange/instrument settlement calendar per EACH fill.

        No universal T+1/day/latency default. Verify proof source signatures/cache
        provenance and economic maturity; not just caller-supplied due_ns.
        """
        ...
    def verify_options(self, events: tuple[SettlementEvent, ...], *, submission_key: str,
                       ledger: Mapping[str, Any], evidence_sha256: str, now_ns: int) -> bool:
        """Recompute exact pinned model outputs from qualified fixing/exercise
        evidence. Bind account, simulator, currency, full option-position units,
        originating fills, delivery lots, calendar and signed obligations.
        """
        ...
    def verify_requalification(self, *, instrument_id: str, previous_evidence_sha256: str,
                              replacement_evidence_sha256: str, ledger: Mapping[str, Any], now_ns: int) -> bool:
        """Unambiguous split/remap/multiplier changes require an audited exact
        local position transformation first. Return false if quantities/lineage
        differ or any open order still uses incompatible metadata.
        """
        ...


def _amount(value: Any) -> str:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ExecutionError("finite-exact-settlement-decimal-required")
    # Decimal instances from the pure simulator are formatted, never float-cast.
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in {"-0", ""}:
        text = "0"
    units(text)
    return text


class SettlementController:
    def __init__(self, owner: PaperExecutionOwner, evidence: SettlementEvidencePort) -> None:
        self.owner, self.evidence = owner, evidence

    def record_option_obligations(self, submission_key: str, events: tuple[SettlementEvent, ...], *,
                                  evidence_sha256: str, now_ns: int) -> None:
        from .exact import timestamp
        owner = self.owner
        with owner.journal.mutex:
            ledger = owner._scope()
            order = ledger["orders"][submission_key]
            if (not events or len(events) > 8 or order["reservationState"] == "released"
                    or self.evidence.verify_options(events, submission_key=submission_key, ledger=owner.journal.snapshot()[0],
                                                   evidence_sha256=evidence_sha256, now_ns=now_ns) is not True):
                raise ExecutionError("pending-option-obligation-not-qualified")
            digest_reference(evidence_sha256)
            facts = []
            for event in events:
                if (event.instrument_id not in order["legs"] or event.status not in {"assigned", "exercised", "expired"}
                        or event.currency != ledger["currency"] or event.settlement_kind not in {"cash", "physical"}
                        or any(type(v) is not int or v < 0 for v in (now_ns, event.occurred_at_ns, event.settlement_due_ns))
                        or event.occurred_at_ns > now_ns or units(_amount(event.contracts)) <= 0
                        or units(_amount(event.contracts)) > units(order["legs"][event.instrument_id]["filled"])):
                    raise ExecutionError("pending-option-obligation-lineage-invalid")
                source_ids = [data["eventId"] for data in order["events"].values()
                              if data["eventKind"] == "fill" and data["instrumentId"] == event.instrument_id]
                if not 1 <= len(source_ids) <= 512:
                    raise ExecutionError("pending-option-fill-lineage-required")
                facts.append({"kind": {"assigned": "assignment", "exercised": "exercise", "expired": "option-expiry"}[event.status],
                    "settlementId": reference(event.event_id), "instrumentId": event.instrument_id, "underlyingId": event.underlying_id,
                    "settlementKind": event.settlement_kind, "settlementState": "pending", "quantity": _amount(event.contracts),
                    "currency": event.currency, "cashDelta": _amount(event.cash_delta), "shareDelta": _amount(event.underlying_delta),
                    "dueAt": timestamp(event.settlement_due_ns), "fillEventIds": source_ids})
            obligation_id = "obligation-" + owner.authority.digest({"submissionKey": submission_key, "facts": facts,
                                                                  "evidenceSha256": evidence_sha256})
            owner.journal.append("option-obligation", {"obligationId": obligation_id, "submissionKey": submission_key,
                                 "optionFacts": facts, "evidenceSha256": evidence_sha256},
                                 now_ns=now_ns, event_id=obligation_id)

    def settle_trades(self, proof: TradeSettlementProof, *, now_ns: int) -> None:
        owner = self.owner
        with owner.journal.mutex:
            ledger = owner._scope()
            if any(type(v) is not int or v < 0 for v in (proof.owner_epoch, proof.due_ns, proof.observed_ns, now_ns)):
                raise ExecutionError("integer-settlement-clock-required")
            if (proof.account_alias != ledger["accountAlias"] or proof.simulator_id != ledger["simulatorId"]
                    or proof.owner_epoch != owner.epoch or not (proof.due_ns <= proof.observed_ns <= now_ns)
                    or not proof.fill_keys or len(proof.fill_keys) > 512 or len(set(proof.fill_keys)) != len(proof.fill_keys)
                    or self.evidence.verify_trade(proof, ledger=owner.journal.snapshot()[0], now_ns=now_ns) is not True):
                raise ExecutionError("trade-settlement-not-qualified")
            reference(proof.proof_id)
            reference(proof.calendar_artifact_id)
            digest_reference(proof.evidence_sha256)
            for key in proof.fill_keys:
                lineage = ledger["fillLineage"].get(key)
                if not lineage or int(lineage["occurredNs"]) > proof.due_ns:
                    raise ExecutionError("trade-settlement-fill-lineage-mismatch")
            owner.journal.append("trade-settled", {"fillKeys": list(proof.fill_keys), "evidenceSha256": proof.evidence_sha256,
                                 "cashDelta": decimal(sum(units(ledger["unsettledCredits"].get(key, "0")) for key in proof.fill_keys)),
                                 "dueNs": str(proof.due_ns), "calendarArtifactId": proof.calendar_artifact_id},
                                 now_ns=now_ns, event_id="trade-settlement-" + proof.proof_id)

    def settle_options(self, submission_key: str, events: tuple[SettlementEvent, ...], *,
                       evidence_sha256: str, now_ns: int) -> None:
        owner = self.owner
        with owner.journal.mutex:
            ledger = owner._scope()
            order = ledger["orders"][submission_key]
            filled_legs = {instrument for instrument, leg in order["legs"].items() if units(leg["filled"]) > 0}
            command_legs = order["command"].get("legs")
            if not isinstance(command_legs, list) or not 1 <= len(command_legs) <= 8:
                raise ExecutionError("option-settlement-contract-identity-required")
            instruments: dict[str, Mapping[str, Any]] = {}
            for command_leg in command_legs:
                instrument = command_leg.get("instrument") if isinstance(command_leg, dict) else None
                if (not isinstance(instrument, dict) or not isinstance(instrument.get("instrument_id"), str)
                        or instrument["instrument_id"] not in order["legs"]
                        or instrument["instrument_id"] in instruments):
                    raise ExecutionError("option-settlement-contract-identity-required")
                instruments[instrument["instrument_id"]] = instrument
            if set(instruments) != set(order["legs"]):
                raise ExecutionError("option-settlement-contract-identity-required")
            required_legs = {instrument for instrument in filled_legs
                             if instruments[instrument].get("kind") == "option"
                             and isinstance(instruments[instrument].get("option"), dict)}
            # This transition releases the whole reservation. Do not use option
            # events to settle filled non-option legs or invent an empty release.
            if (not order["finalityProven"] or order["reservationState"] != "settlement-held"
                    or not events or len(events) > 8 or len({e.instrument_id for e in events}) != len(events)
                    or len({e.event_id for e in events}) != len(events)
                    or required_legs != filled_legs or {e.instrument_id for e in events} != required_legs
                    or self.evidence.verify_options(events, submission_key=submission_key,
                                                   ledger=owner.journal.snapshot()[0], evidence_sha256=evidence_sha256,
                                                   now_ns=now_ns) is not True):
                raise ExecutionError("option-settlement-not-qualified")
            digest_reference(evidence_sha256)
            cash_delta = "0"
            positions: dict[str, str] = {}
            event_ids = []
            option_facts = []
            for event in events:
                leg = order["legs"][event.instrument_id]
                contracts = _amount(event.contracts)
                if (any(type(v) is not int or v < 0 for v in (event.occurred_at_ns, event.settlement_due_ns, now_ns))
                        or units(_amount(event.fees)) < 0):
                    raise ExecutionError("exact-settlement-time-and-fees-required")
                if (event.status not in {"assigned", "exercised", "expired"} or event.final is not True
                        or event.pin_risk or _amount(event.remaining_contracts) != "0"
                        or event.settlement_due_ns is None or not (event.occurred_at_ns <= event.settlement_due_ns <= now_ns)
                        or event.currency != ledger["currency"] or contracts != leg["filled"]):
                    raise ExecutionError("unresolved-option-maturity-or-partial-assignment")
                # Partial assignment events remain modeled evidence and retain ALL
                # collateral; caller must reconcile full cumulative obligation.
                # Pure settlement event cash_delta already includes its fees.
                cash_delta = add(cash_delta, _amount(event.cash_delta))
                closing = units(contracts) * (-1 if leg["side"] == "buy" else 1)
                positions[event.instrument_id] = add(positions.get(event.instrument_id, "0"), decimal(closing))
                positions[event.underlying_id] = add(positions.get(event.underlying_id, "0"), _amount(event.underlying_delta))
                event_ids.append(reference(event.event_id))
                from .exact import timestamp
                source_ids = [data["eventId"] for data in order["events"].values()
                              if data["eventKind"] == "fill" and data["instrumentId"] == event.instrument_id]
                if not source_ids or len(source_ids) > 512:
                    raise ExecutionError("bounded-option-fill-lineage-required")
                option_facts.append({"kind": {"assigned": "assignment", "exercised": "exercise", "expired": "option-expiry"}[event.status],
                    "settlementId": event.event_id, "instrumentId": event.instrument_id, "underlyingId": event.underlying_id,
                    "settlementKind": event.settlement_kind, "settlementState": "settled", "quantity": contracts,
                    "currency": event.currency, "cashDelta": _amount(event.cash_delta), "shareDelta": _amount(event.underlying_delta),
                    "dueAt": timestamp(event.settlement_due_ns), "fillEventIds": source_ids})
            other_orders = [o for key, o in ledger["orders"].items() if key != submission_key and o["reservationState"] != "released"]
            other_cash = sum(units(o["cashReserve"]) for o in other_orders)
            if units(ledger["cash"]) + units(cash_delta) < other_cash:
                raise ExecutionError("settlement-cash-deficit-retain-collateral")
            for instrument, delta in positions.items():
                if instrument in order["legs"]:
                    continue
                pending = sum(units(p["quantity"]) for p in ledger["unsettledPositions"].values() if p["instrumentId"] == instrument)
                other_shares = sum(units(o["shareReserve"].get(instrument, "0")) for o in other_orders)
                if units(ledger["positions"].get(instrument, "0")) + units(delta) - pending < other_shares:
                    raise ExecutionError("settlement-share-deficit-retain-collateral")
            settlement_id = "settlement-" + owner.authority.digest({"submissionKey": submission_key,
                            "eventIds": event_ids, "evidenceSha256": evidence_sha256})
            owner.journal.append("settlement", {"settlementId": settlement_id, "submissionKey": submission_key,
                                 "cashDelta": cash_delta, "positionDeltas": positions, "eventIds": event_ids,
                                 "optionFacts": option_facts,
                                 "evidenceSha256": evidence_sha256, "strategyArtifactId": order["strategyArtifactId"]},
                                 now_ns=now_ns, event_id=settlement_id)

    def restore_qualification(self, instrument_id: str, *, previous_evidence_sha256: str,
                              replacement_evidence_sha256: str, now_ns: int) -> None:
        owner = self.owner
        with owner.journal.mutex:
            ledger = owner._scope()
            reference(instrument_id)
            digest_reference(previous_evidence_sha256)
            digest_reference(replacement_evidence_sha256)
            if self.evidence.verify_requalification(instrument_id=instrument_id, previous_evidence_sha256=previous_evidence_sha256,
                    replacement_evidence_sha256=replacement_evidence_sha256, ledger=owner.journal.snapshot()[0], now_ns=now_ns) is not True:
                raise ExecutionError("corporate-action-qualification-ambiguous")
            owner.journal.append("qualification-restored", {"instrumentId": instrument_id,
                                 "previousEvidenceSha256": previous_evidence_sha256,
                                 "replacementEvidenceSha256": replacement_evidence_sha256}, now_ns=now_ns,
                                 event_id="requalify-" + replacement_evidence_sha256)
            # New risk remains paused; fresh observation + reconciliation +
            # separately authorized reset are still required.
