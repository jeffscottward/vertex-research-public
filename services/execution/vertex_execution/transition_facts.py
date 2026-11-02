"""Pure mapping from native-owned journal transitions to typed observed facts.

Journal invokes this inside the same transaction as the transition, never from a
market callback. A fact is not a grant; unsupported/missing native metadata fails
closed instead of manufacturing an order receipt or settlement terms.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .exact import timestamp
from .ports import ExecutionError

if TYPE_CHECKING:
    from .owner import PaperExecutionOwner


class TransitionFactFactory:
    def __init__(self, owner: PaperExecutionOwner) -> None:
        self.owner = owner

    def __call__(self, state: dict[str, Any], event: dict[str, Any], head_sequence: int,
                 head_hash: str | None) -> tuple[tuple[dict[str, Any], bytes], ...]:
        # Before approved native genesis there is no public stream. Initial
        # observation/reconcile/pause are still durably in the private journal.
        if head_sequence == 0:
            return ()
        from .native_facts import build_native_fact_bundle
        kind, data = event["kind"], event["data"]
        facts: list[dict[str, Any]] = []
        if kind in {"pause", "reset", "qualification-invalidated", "liquidation-request"}:
            action = "reset-new-risk" if kind == "reset" else "reconcile-required" if kind == "qualification-invalidated" else "pause-new-risk"
            reason = data.get("reason", "explicit-reset-after-reconciliation" if kind == "reset" else kind)
            facts.append({"kind": "kill-state", "action": action, "reasonCodes": [reason], "grantId": data.get("grantId")})
        elif kind == "reconciled":
            facts.append({"kind": "reconciliation", "reconciliationId": event["eventId"],
                          "observedSnapshotId": state["observation"]["observationId"],
                          "unknownCount": sum(order["status"] == "unknown" for order in state["orders"].values()),
                          "reconciled": state["reconciled"]})
        elif kind == "trade-settled":
            facts.append({"kind": "cash-settlement", "settlementId": event["eventId"], "currency": state["currency"],
                          "cashDelta": data["cashDelta"],
                          "fillEventIds": [state["fillLineage"][key]["sourceEventId"] for key in data["fillKeys"]]})
        elif kind == "settlement":
            facts.extend(data["optionFacts"])
        elif kind == "option-obligation":
            facts.extend(data["optionFacts"])
        elif kind == "corporate-action":
            applied = state["corporateActions"][data["actionId"]]
            facts.append({"kind": "corporate-action", "actionId": data["actionId"],
                          "oldInstrumentId": data["oldInstrumentId"], "newInstrumentId": data["newInstrumentId"],
                          "quantityNumerator": data["quantityNumerator"], "quantityDenominator": data["quantityDenominator"],
                          "previousQuantity": data["previousQuantity"], "newQuantity": applied["newQuantity"],
                          "cashDelta": data["cashDelta"], "currency": state["currency"],
                          "previousQualificationSha256": data["previousQualificationSha256"],
                          "replacementQualificationSha256": data["replacementQualificationSha256"]})
        elif kind == "checkpoint-recorded":
            facts.append({"kind": "checkpoint", "snapshotId": data["snapshotId"], "snapshotSha256": data["snapshotSha256"],
                          "journalSequence": event["sequence"], "journalHeadHash": self.owner.authority.digest(event)})
        if len(facts) > 64:
            raise ExecutionError("native-fact-transition-bound")
        bundles = []
        for ordinal, fact in enumerate(facts):
            identity = "nativefact-" + self.owner.authority.digest({"sourceEventId": event["eventId"], "ordinal": ordinal})
            projection, proof = build_native_fact_bundle(authority=self.owner.authority, owned_state=state,
                stream_id=self.owner.stream_id, owner_epoch=self.owner.epoch, sequence=head_sequence + 1,
                previous_event_hash=head_hash, native_emitter_actor_id=self.owner.native_emitter_actor_id,
                policy_version=self.owner.native_policy_version, occurred_ns=int(event["occurredNs"]),
                received_ns=int(event["occurredNs"]), ttl_ns=self.owner.projection_ttl_ns,
                event_id=identity, journal_event=event, fact=fact, fact_ordinal=ordinal)
            bundles.append((projection, proof))
            head_sequence, head_hash = int(projection["sequence"]), projection["eventHash"]
        return tuple(bundles)
