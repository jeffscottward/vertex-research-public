"""Dedicated durable admission boundary; never call from an engine tick callback.

The owner accepts only independently reviewed PAPER-SIMULATION admissions, then
re-runs current deterministic risk against its own journal under a single fence.
All sync IO stays on the service worker, never callback/model/backtest threads.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import json
import re
from typing import Any, Callable, Mapping

from .exact import units
from .journal import Journal
from .ports import (AdmissionAuthorityPort, ArtifactPort, ContractAuthority,
                    DisabledPaperTransport, ExecutionError, MutationAuthorityPort,
                    MutationGrant, ObservationAuthorityPort, PaperEvent,
                    PaperTransportPort, PortfolioObservation, RiskPlan, RiskPort)
from .projection import build_projection

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")


def reference(value: str) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise ExecutionError("invalid-internal-reference")
    return value


def digest_reference(value: str) -> str:
    if not isinstance(value, str) or _HASH.fullmatch(value) is None:
        raise ExecutionError("invalid-evidence-digest")
    return value


class PaperExecutionOwner:
    def __init__(self, *, journal: Journal, authority: ContractAuthority,
                 artifacts: ArtifactPort, risk: RiskPort,
                 admission_authority: AdmissionAuthorityPort,
                 observation_authority: ObservationAuthorityPort,
                 mutation_authority: MutationAuthorityPort,
                 stream_id: str, native_emitter_actor_id: str, native_policy_version: str,
                 projection_ttl_ns: int, now_ns: int,
                 transport: PaperTransportPort | None = None) -> None:
        if type(projection_ttl_ns) is not int or projection_ttl_ns <= 0:
            raise ExecutionError("explicit-projection-retention-policy-required")
        self.journal, self.authority, self.artifacts, self.risk = journal, authority, artifacts, risk
        self.admission_authority = admission_authority
        self.observation_authority = observation_authority
        self.mutation_authority = mutation_authority
        self.stream_id = reference(stream_id)
        self.native_emitter_actor_id = reference(native_emitter_actor_id)
        if not isinstance(native_policy_version, str) or re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", native_policy_version) is None:
            raise ExecutionError("native-emitter-policy-version-required")
        self.native_policy_version = native_policy_version
        self.projection_ttl_ns = projection_ttl_ns
        self.transport = transport if transport is not None else DisabledPaperTransport()
        if self.transport.simulation_only is not True or self.transport.broker_submission_allowed is not False:
            raise ExecutionError("broker-transport-forbidden")
        self._disruption_held = False
        self.journal.native_fact_factory = None
        self.epoch = journal.claim(now_ns=now_ns)
        from .transition_facts import TransitionFactFactory
        self.journal.native_fact_factory = TransitionFactFactory(self)

    def _artifact(self, artifact_id: str, contract_name: str) -> tuple[dict[str, Any], str]:
        reference(artifact_id)
        artifact = self.artifacts.get(artifact_id)
        if artifact.artifact_id != artifact_id or artifact.contract_name != contract_name or len(artifact.canonical_bytes) > 4_000_000:
            raise ExecutionError("immutable-artifact-scope-mismatch")
        value = json.loads(artifact.canonical_bytes)
        if self.authority.validate(contract_name, value) is not True:
            raise ExecutionError("native-validation-required")
        digest = self.authority.digest(value)
        if self.authority.encode(value) != artifact.canonical_bytes or digest != artifact.sha256:
            raise ExecutionError("immutable-artifact-hash-mismatch")
        return value, digest

    def _scope(self) -> dict[str, Any]:
        self.journal._db()
        if self.epoch != self.journal.epoch or self._disruption_held:
            raise ExecutionError("owner-fenced-for-disruption")
        return self.journal.state

    def _fresh_observation(self, now_ns: int) -> None:
        if type(now_ns) is not int or now_ns < 0:
            raise ExecutionError("exact-owner-clock-required")
        state = self._scope()
        observation = state["observation"]
        if observation is None or not (int(observation["observedNs"]) <= int(observation["receivedNs"]) <= now_ns < int(observation["validUntilNs"])):
            raise ExecutionError("qualified-observation-not-current")

    def _ready(self, now_ns: int, *, reviewed_checkpoint: bool = True) -> None:
        self._fresh_observation(now_ns)
        state = self._scope()
        if state["pausedNewRisk"] or self.journal.pause_latched() or not state["reconciled"] or state["invalidQualifications"] or state["optionObligations"]:
            raise ExecutionError("new-risk-paused-or-unreconciled")
        if any(o["status"] == "unknown" for o in state["orders"].values()):
            raise ExecutionError("unknown-acceptance-lock")
        checkpoint = state.get("portfolioCheckpoint")
        if reviewed_checkpoint and (not checkpoint or checkpoint["ownerEpoch"] != str(self.epoch)
                or checkpoint["portfolioRevision"] != state["portfolioRevision"]):
            raise ExecutionError("current-native-review-checkpoint-required")

    def _projection(self, key: str, now_ns: int, received_ns: int, event_id: str) -> Callable[..., dict[str, Any]]:
        def create(state: dict[str, Any], sequence: int, event_hash: str) -> dict[str, Any]:
            projection_sequence, previous = self.journal.projection_head()
            if projection_sequence < 1:
                raise ExecutionError("native-genesis-required-before-execution-facts")
            return build_projection(authority=self.authority, state=state, order_key=key,
                                    stream_id=self.stream_id, epoch=self.epoch,
                                    native_emitter_actor_id=self.native_emitter_actor_id,
                                    sequence=projection_sequence + 1, previous_hash=previous,
                                    occurred_ns=now_ns, received_ns=received_ns,
                                    ttl_ns=self.projection_ttl_ns, audit_event_id=event_id)
        return create

    def observe(self, observation: PortfolioObservation, *, now_ns: int) -> None:
        if not isinstance(observation, PortfolioObservation):
            raise ExecutionError("public-portfolio-projection-is-not-authority")
        with self.journal.mutex:
            state = self._scope()
            if any(type(v) is not int or v < 0 for v in (now_ns, observation.observed_ns, observation.received_ns,
                    observation.valid_until_ns, observation.journal_sequence)):
                raise ExecutionError("exact-observation-clock-required")
            if state["observation"] is None:
                reference(observation.seed_policy_artifact_id)
                digest_reference(observation.seed_policy_sha256)
            if (observation.account_alias != state["accountAlias"] or observation.environment != "paper"
                    or observation.simulator_id != state["simulatorId"] or observation.currency != state["currency"]
                    or observation.journal_sequence != self.journal.sequence or observation.journal_sha256 != self.journal.event_hash
                    or not (observation.observed_ns <= observation.received_ns <= now_ns < observation.valid_until_ns)
                    or type(observation.source_sequence) is not int or observation.source_sequence <= 0
                    or self.observation_authority.verify(observation, now_ns=now_ns) is not True):
                raise ExecutionError("observation-not-qualified")
            reference(observation.observation_id)
            digest_reference(observation.evidence_sha256)
            if units(observation.cash) < 0 or len(observation.positions) > 10_000:
                raise ExecutionError("invalid-observed-balance")
            positions = dict(observation.positions)
            if len(positions) != len(observation.positions):
                raise ExecutionError("duplicate-observed-instrument")
            for instrument, amount in positions.items():
                reference(instrument)
                units(amount)
            data = {"observationId": observation.observation_id, "sourceSequence": str(observation.source_sequence),
                    "observedNs": str(observation.observed_ns), "receivedNs": str(observation.received_ns),
                    "validUntilNs": str(observation.valid_until_ns), "cash": observation.cash,
                    "seedPolicyArtifactId": observation.seed_policy_artifact_id,
                    "seedPolicySha256": observation.seed_policy_sha256,
                    "positions": positions, "evidenceSha256": observation.evidence_sha256}
            self.journal.append("observation", data, now_ns=now_ns, event_id="observation-" + observation.observation_id)

    def finish_reconciliation(self, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._fresh_observation(now_ns)
            self.journal.append("reconciled", {}, now_ns=now_ns,
                                event_id=f"reconciled-{self.epoch}-{self.journal.sequence + 1}")

    def record_genesis(self, snapshot_id: str, max_age_ms: int, *, now_ns: int) -> dict[str, Any]:
        from .exact import timestamp
        from .portfolio_projection import build_genesis
        with self.journal.mutex:
            self._fresh_observation(now_ns)
            state, sequence, _ = self.journal.snapshot()
            if self.journal.projection_head()[0] != 0:
                raise ExecutionError("epoch-genesis-already-recorded")
            observation = state["observation"]
            value = build_genesis(authority=self.authority, owned_state=state, stream_id=self.stream_id,
                                  owner_epoch=self.epoch, observed_at=timestamp(int(observation["observedNs"])),
                                  received_at=timestamp(int(observation["receivedNs"])), evaluated_at=timestamp(now_ns),
                                  max_age_ms=max_age_ms, snapshot_id=reference(snapshot_id))
            data = {"snapshotId": value["snapshotId"], "sequence": value["sequence"],
                    "ownerEpoch": str(self.epoch), "sourceEventHash": value["sourceEventHash"]}
            self.journal.append("portfolio-genesis", data, now_ns=now_ns,
                                event_id=f"genesis-{self.epoch}", expected_sequence=sequence,
                                projection=lambda _state, _seq, _hash: value, projection_kind="portfolio-genesis")
            return value

    def record_portfolio_checkpoint(self, snapshot_id: str, max_age_ms: int, *, now_ns: int) -> dict[str, Any]:
        from .exact import timestamp
        from .portfolio_projection import build_snapshot
        with self.journal.mutex:
            self._fresh_observation(now_ns)
            state, sequence, _ = self.journal.snapshot()
            row = self.journal._db().execute("SELECT payload FROM projections WHERE owner_epoch=? AND kind IN ('execution','native-fact','portfolio-genesis') ORDER BY publication_sequence DESC LIMIT 1", (str(self.epoch),)).fetchone()
            if row is None:
                raise ExecutionError("native-genesis-required")
            head = json.loads(row[0])
            number, head_hash = self.journal.projection_head()
            value = build_snapshot(authority=self.authority, owned_state=state, stream_id=self.stream_id,
                                   owner_epoch=self.epoch, observed_at=head.get("occurredAt", head.get("asOfAt")),
                                   received_at=head["receivedAt"], evaluated_at=timestamp(now_ns), max_age_ms=max_age_ms,
                                   snapshot_id=reference(snapshot_id), sequence=number, source_event_hash=head_hash)
            data = {"snapshotId": value["snapshotId"], "sequence": value["sequence"],
                    "ownerEpoch": str(self.epoch), "sourceEventHash": value["sourceEventHash"]}
            self.journal.append("portfolio-checkpoint", data, now_ns=now_ns,
                                event_id="portfolio-checkpoint-" + snapshot_id, expected_sequence=sequence,
                                projection=lambda _state, _seq, _hash: value, projection_kind="portfolio-snapshot")
            return value
    def checkpoint(self, *, now_ns: int) -> tuple[int, str]:
        with self.journal.mutex:
            self._scope()
            row = self.journal._db().execute("SELECT payload FROM projections WHERE owner_epoch=? AND kind IN ('portfolio-genesis','portfolio-snapshot') ORDER BY publication_sequence DESC LIMIT 1", (str(self.epoch),)).fetchone()
            if row is None:
                raise ExecutionError("public-native-checkpoint-required")
            snapshot = json.loads(row[0])
            data = {"snapshotId": snapshot["snapshotId"], "snapshotSha256": self.authority.digest(snapshot)}
            self.journal.append("checkpoint-recorded", data, now_ns=now_ns,
                                event_id=f"checkpoint-{self.epoch}-{self.journal.sequence + 1}")
            return self.journal.checkpoint()


    def _grant(self, grant: MutationGrant, action: str, key: str | None, now_ns: int) -> None:
        state = self._scope()
        if (grant.action != action or grant.submission_key != key or grant.account_alias != state["accountAlias"]
                or grant.environment != "paper" or grant.owner_epoch != self.epoch
                or not (grant.issued_ns <= now_ns < grant.expires_ns)
                or self.mutation_authority.verify(grant, now_ns=now_ns) is not True):
            raise ExecutionError("mutation-permission-denied")
        reference(grant.grant_id)
        reference(grant.actor_id)
        digest_reference(grant.evidence_sha256)

    def pause_new_risk(self, reason: str, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._scope()
            self.journal.latch_pause(reference(reason), now_ns=now_ns)
            self.journal.append("pause", {"reason": reference(reason)}, now_ns=now_ns,
                                event_id=f"pause-{self.epoch}-{self.journal.sequence + 1}")

    def reset_new_risk(self, grant: MutationGrant, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._grant(grant, "reset-new-risk", None, now_ns)
            self._fresh_observation(now_ns)
            if self.journal.state["optionObligations"]:
                raise ExecutionError("reset-with-unsettled-option-obligation")
            if any(o["status"] == "unknown" for o in self.journal.state["orders"].values()):
                raise ExecutionError("reset-with-unknown-obligation")
            self.journal.append("reset", {"grantId": grant.grant_id, "evidenceSha256": grant.evidence_sha256},
                                now_ns=now_ns, event_id="reset-" + grant.grant_id)

    def admit(self, intent_artifact_id: str, admission_artifact_id: str, *, now_ns: int) -> str:
        # Local immutable cache only; all canonical inputs are cloned at boundary.
        intent, intent_hash = self._artifact(intent_artifact_id, "TradeIntent")
        admission, admission_hash = self._artifact(admission_artifact_id, "PaperSimulationAdmission")
        review, _ = self._artifact(admission["reviewId"], "AcceptedReview")
        strategy, strategy_hash = self._artifact(admission["strategyVersion"], "StrategySpec")
        key = "submission-" + self.authority.digest({"accountAlias": admission["accountAlias"],
                "environment": "paper", "idempotencyKey": admission["idempotencyKey"]})
        payload_hash = self.authority.digest({"intentSha256": intent_hash, "admissionSha256": admission_hash,
                                             "strategyArtifactId": admission["strategyVersion"], "strategySha256": strategy_hash})
        with self.journal.mutex:
            state = self._scope()
            old = state["orders"].get(key)
            if old is not None:
                if old["payloadSha256"] != payload_hash:
                    raise ExecutionError("qualified-idempotency-payload-conflict")
                return key  # replay is observation, never another dispatch
            self._ready(now_ns)
            if (admission["accountAlias"] != state["accountAlias"] or admission["environment"] != "paper"
                    or admission["simulatorId"] != state["simulatorId"] or admission["streamId"] != self.stream_id
                    or admission["ownerEpoch"] != str(self.epoch) or intent["accountAlias"] != state["accountAlias"]
                    or admission["portfolioSnapshotId"] != state["portfolioCheckpoint"]["snapshotId"]
                    or admission["portfolioSequence"] != state["portfolioCheckpoint"]["sequence"]
                    or intent["environment"] != "paper" or intent["strategyVersion"] != admission["strategyVersion"]
                    or intent["idempotencyKey"] != admission["idempotencyKey"] or intent["intentId"] != admission["intentId"]
                    or intent_hash != admission["intentSha256"] or intent_hash != admission["reviewedArtifactSha256"]
                    or review["artifactId"] != intent_artifact_id or review["artifactSha256"] != intent_hash
                    or review["reviewId"] != admission["reviewId"] or review["reviewVersion"] != admission["reviewVersion"]
                    or review["decision"] != "accepted" or review["purpose"] != "paper-simulation"
                    or review["accountAlias"] != state["accountAlias"] or review["environment"] != "paper"
                    or review["strategyVersion"] != admission["strategyVersion"] or review["policyVersion"] != admission["policyVersion"]
                    or not (self.authority.epoch_ns(admission["admittedAt"]) <= now_ns < self.authority.epoch_ns(admission["expiresAt"]))
                    or not (self.authority.epoch_ns(review["reviewedAt"]) <= now_ns < self.authority.epoch_ns(review["expiresAt"]))
                    or not (self.authority.epoch_ns(intent["proposedAt"]) <= now_ns < self.authority.epoch_ns(intent["expiresAt"]))
                    or self.admission_authority.permits(admission=admission, review=review, now_ns=now_ns) is not True):
                raise ExecutionError("admission-binding-or-authority-invalid")
            # portfolioSnapshotId/Sequence are review provenance only. No cloud
            # projection is read, copied or promoted into spendable balances.
            snapshot, revision, ledger_hash = self.journal.snapshot()
            plan = self.risk.assess(intent=intent, admission=admission, strategy=strategy,
                                    ledger=snapshot, ledger_sequence=revision, ledger_sha256=ledger_hash, now_ns=now_ns)
            self._check_plan(plan, intent_hash, admission, revision, ledger_hash, now_ns)
            command = json.loads(plan.command_bytes)
            if self.authority.encode(command) != plan.command_bytes:
                raise ExecutionError("noncanonical-simulator-command")
            data = {"submissionKey": key, "payloadSha256": payload_hash, "intent": intent, "admission": admission,
                    "intentArtifactId": intent_artifact_id, "admissionArtifactId": admission_artifact_id,
                    "qualifiedKeys": [key], "reservationEventId": "reserve-" + key,
                    "strategySha256": strategy_hash, "strategyArtifactId": admission["strategyVersion"],
                    "cashReserve": plan.cash_reserve, "shareReserve": dict(plan.share_reserve),
                    "maximumLoss": plan.maximum_loss, "maximumNotional": plan.maximum_notional,
                    "command": command, "riskValidUntilNs": str(plan.valid_until_ns),
                    "legs": {i: {"side": side, "maximumQuantity": quantity, "filled": "0"} for i, side, quantity in plan.legs},
                    "settlementRequired": plan.settlement_required, "reservationState": "reserved",
                    "status": "not-submitted", "dispatchMarked": False, "cancelRequested": False,
                    "finalityProven": False, "reconciledEpoch": str(self.epoch), "orderRef": None,
                    "kernelReservation": json.loads(plan.kernel_reservation_bytes) if plan.kernel_reservation_bytes else None,
                    "events": {}, "fills": {}}
            event_id = "reserve-" + key
            self.journal.append("reserve", data, now_ns=now_ns, event_id=event_id, expected_sequence=revision,
                                projection=self._projection(key, now_ns, now_ns, event_id))
            return key

    def _check_plan(self, plan: RiskPlan, intent_hash: str, admission: Mapping[str, Any],
                    revision: int, ledger_hash: str, now_ns: int) -> None:
        if (not isinstance(plan, RiskPlan) or plan.intent_sha256 != intent_hash or plan.strategy_artifact_id != admission["strategyVersion"]
                or plan.ledger_sequence != revision or plan.ledger_sha256 != ledger_hash or plan.policy_version != admission["policyVersion"]
                or now_ns >= plan.valid_until_ns or plan.valid_until_ns > self.authority.epoch_ns(admission["expiresAt"])
                or len(plan.command_bytes) > 2_000_000 or not 1 <= len(plan.legs) <= 8
                or units(plan.cash_reserve) < 0 or units(plan.maximum_loss) <= 0 or units(plan.maximum_notional) <= 0
                or units(plan.maximum_loss) > units(admission["maximumLoss"]) or units(plan.maximum_notional) > units(admission["maximumNotional"])):
            raise ExecutionError("risk-plan-mismatch-or-limit")
        if len(dict(plan.share_reserve)) != len(plan.share_reserve) or len({i for i, _, _ in plan.legs}) != len(plan.legs):
            raise ExecutionError("duplicate-plan-instrument")
        for instrument, side, quantity in plan.legs:
            reference(instrument)
            if side not in {"buy", "sell"} or units(quantity) <= 0:
                raise ExecutionError("invalid-qualified-leg")
        for instrument, amount in plan.share_reserve:
            reference(instrument)
            if units(amount) < 0:
                raise ExecutionError("invalid-share-reservation")

    def dispatch_once(self, submission_key: str, *, now_ns: int) -> tuple[PaperEvent, ...]:
        with self.journal.mutex:
            state = self._scope()
            order = state["orders"].get(submission_key)
            if order is None:
                raise ExecutionError("unknown-submission")
            if order["dispatchMarked"]:
                return ()  # UNKNOWN and duplicate delivery never resubmit
            self._ready(now_ns, reviewed_checkpoint=False)
            if now_ns >= min(int(order["riskValidUntilNs"]), self.authority.epoch_ns(order["admission"]["expiresAt"])):
                raise ExecutionError("dispatch-admission-expired")
            # Re-run current native policy at the last durable boundary. Original
            # reservation stays locked; kernel must exclude THIS reservation from
            # incremental cash while retaining all existing position obligations.
            current, revision, ledger_hash = self.journal.snapshot()
            current["dispatchReservationKey"] = submission_key
            strategy, digest = self._artifact(order["strategyArtifactId"], "StrategySpec")
            if digest != order["strategySha256"]:
                raise ExecutionError("pinned-strategy-changed")
            review, _ = self._artifact(order["admission"]["reviewId"], "AcceptedReview")
            if (order["admission"]["ownerEpoch"] != str(self.epoch)
                    or not (self.authority.epoch_ns(review["reviewedAt"]) <= now_ns < self.authority.epoch_ns(review["expiresAt"]))
                    or now_ns >= self.authority.epoch_ns(order["intent"]["expiresAt"])
                    or self.admission_authority.permits(admission=order["admission"], review=review, now_ns=now_ns) is not True):
                raise ExecutionError("dispatch-authority-expired-revoked-or-stale-epoch")
            plan = self.risk.assess(intent=order["intent"], admission=order["admission"], strategy=strategy,
                                   ledger=current, ledger_sequence=revision, ledger_sha256=ledger_hash, now_ns=now_ns)
            self._check_plan(plan, order["admission"]["intentSha256"], order["admission"], revision, ledger_hash, now_ns)
            if (units(plan.cash_reserve) > units(order["cashReserve"]) or dict(plan.share_reserve) != order["shareReserve"]
                    or self.authority.encode(order["command"]) != plan.command_bytes):
                raise ExecutionError("reservation-no-longer-covers-current-risk")
            event_id = "dispatch-" + submission_key
            self.journal.append("dispatch", {"submissionKey": submission_key, "payloadSha256": order["payloadSha256"]},
                                now_ns=now_ns, event_id=event_id, expected_sequence=revision,
                                projection=self._projection(submission_key, now_ns, now_ns, event_id))
            try:
                events = self.transport.submit(submission_key, order["payloadSha256"], plan.command_bytes, now_ns=now_ns)
                for event in events:
                    self.ingest(event, received_ns=now_ns)
                return events
            except Exception as error:
                # Durable dispatch already says UNKNOWN. Retain everything, no
                # implicit retry/release. Reconciliation may recover later.
                self.pause_new_risk("simulation-outcome-unknown", now_ns=now_ns)
                raise ExecutionError("simulation-outcome-unknown-no-resubmit") from error

    def ingest(self, event: PaperEvent, *, received_ns: int) -> None:
        with self.journal.mutex:
            self._scope()
            if not isinstance(event, PaperEvent) or event.occurred_ns > received_ns:
                raise ExecutionError("invalid-paper-event-chronology")
            reference(event.event_id)
            reference(event.submission_key)
            digest_reference(event.payload_sha256)
            digest_reference(event.evidence_sha256)
            if event.order_ref is not None:
                reference(event.order_ref)
            if event.kind == "fill":
                reference(event.fill_id)
                reference(event.instrument_id)
                units(event.quantity)
                units(event.cash_delta)
                units(event.fee)
            data = {"submissionKey": event.submission_key, "payloadSha256": event.payload_sha256,
                    "eventId": event.event_id, "eventKind": event.kind, "occurredNs": str(event.occurred_ns),
                    "orderRef": event.order_ref, "fillId": event.fill_id, "instrumentId": event.instrument_id,
                    "quantity": event.quantity, "cashDelta": event.cash_delta, "fee": event.fee,
                    "evidenceSha256": event.evidence_sha256}
            event_id = "event-" + self.authority.digest({"submissionKey": event.submission_key, "eventId": event.event_id})
            self.journal.append("paper-event", data, now_ns=event.occurred_ns, event_id=event_id,
                                projection=self._projection(event.submission_key, event.occurred_ns, received_ns, event_id))

    def reconcile_order(self, submission_key: str, *, now_ns: int) -> bool:
        with self.journal.mutex:
            self._scope()
            order = self.journal.state["orders"][submission_key]
            if order["finalityProven"]:
                return True
            if not order["dispatchMarked"]:
                return False
            result = self.transport.reconcile(submission_key, order["payloadSha256"], now_ns=now_ns)
            if (result.submission_key != submission_key or result.payload_sha256 != order["payloadSha256"]
                    or not result.recovered_state_proven):
                raise ExecutionError("reconciliation-state-provenance-missing")
            digest_reference(result.source_evidence_sha256)
            for event in result.events:
                self.ingest(event, received_ns=now_ns)
            if result.status == "unknown":
                return False
            data = {"submissionKey": submission_key, "payloadSha256": order["payloadSha256"],
                    "status": result.status, "cumulativeFills": dict(result.cumulative_fills),
                    "evidenceSha256": result.source_evidence_sha256}
            event_id = "reconcile-" + self.authority.digest({**data, "epoch": str(self.epoch)})
            self.journal.append("order-reconciled", data, now_ns=now_ns, event_id=event_id,
                                projection=self._projection(submission_key, now_ns, now_ns, event_id))
            if result.terminal and result.finality_proven:
                event_id = "finalize-" + submission_key
                data = {"submissionKey": submission_key, "payloadSha256": order["payloadSha256"],
                        "finalEventIds": list(result.final_event_ids), "evidenceSha256": result.source_evidence_sha256}
                self.journal.append("finalized", data, now_ns=now_ns, event_id=event_id,
                                    projection=self._projection(submission_key, now_ns, now_ns, event_id))
                return True
            return False

    def cancel_simulation(self, submission_key: str, grant: MutationGrant, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._grant(grant, "cancel-simulation", submission_key, now_ns)
            order = self.journal.state["orders"][submission_key]
            if order["cancelRequested"]:
                return  # no blind cancellation retry after possible acceptance
            data = {"submissionKey": submission_key, "payloadSha256": order["payloadSha256"], "grantId": grant.grant_id}
            if not order["dispatchMarked"]:
                event_id = "abandon-" + grant.grant_id
                self.journal.append("abandon-reserved", data, now_ns=now_ns, event_id=event_id,
                                    projection=self._projection(submission_key, now_ns, now_ns, event_id))
                return
            self.journal.append("cancel-request", data, now_ns=now_ns, event_id="cancel-" + grant.grant_id)
            for event in self.transport.cancel(submission_key, grant, now_ns=now_ns):
                self.ingest(event, received_ns=now_ns)

    def request_liquidation(self, grant: MutationGrant, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._grant(grant, "request-liquidation", None, now_ns)
            self.journal.append("liquidation-request", {"grantId": grant.grant_id, "evidenceSha256": grant.evidence_sha256},
                                now_ns=now_ns, event_id="liquidation-" + grant.grant_id)

    def invalidate_qualification(self, instrument_id: str, evidence_sha256: str, *, now_ns: int) -> None:
        with self.journal.mutex:
            self._scope()
            self.journal.latch_pause("qualification-invalidated", now_ns=now_ns)
            self.journal.append("qualification-invalidated", {"instrumentId": reference(instrument_id),
                                "evidenceSha256": digest_reference(evidence_sha256)}, now_ns=now_ns,
                                event_id="qualification-" + evidence_sha256)

    def safety_snapshot(self) -> dict[str, Any]:
        with self.journal.mutex:
            state = self.journal.state
            return {"accountAlias": state["accountAlias"], "environment": "paper", "ownerEpoch": str(self.epoch),
                    "journalSequence": str(self.journal.sequence), "reconciled": state["reconciled"],
                    "pausedNewRisk": state["pausedNewRisk"],
                    "unknownAcceptanceCount": sum(o["status"] == "unknown" for o in state["orders"].values()),
                    "activeReservationCount": sum(o["reservationState"] != "released" for o in state["orders"].values())}


class AsyncExecutionService:
    """Serialized worker boundary. No background startup or automatically sent IO."""
    def __init__(self, owner: PaperExecutionOwner) -> None:
        self.owner = owner
        self._lock = asyncio.Lock()

    async def admit(self, intent_artifact_id: str, admission_artifact_id: str, *, now_ns: int) -> str:
        async with self._lock:
            return await asyncio.to_thread(self.owner.admit, intent_artifact_id, admission_artifact_id, now_ns=now_ns)

    async def dispatch_once(self, submission_key: str, *, now_ns: int) -> tuple[PaperEvent, ...]:
        async with self._lock:
            return await asyncio.to_thread(self.owner.dispatch_once, submission_key, now_ns=now_ns)

    async def reconcile_order(self, submission_key: str, *, now_ns: int) -> bool:
        async with self._lock:
            return await asyncio.to_thread(self.owner.reconcile_order, submission_key, now_ns=now_ns)

    async def admit_batch(self, batch_idempotency_key: str, legs: tuple[tuple[str, str], ...], *, now_ns: int) -> str:
        from .batch_owner import AtomicBatchOwner
        if not isinstance(self.owner, AtomicBatchOwner):
            raise ExecutionError("atomic-batch-owner-not-injected")
        async with self._lock:
            return await asyncio.to_thread(self.owner.admit_batch, batch_idempotency_key, legs, now_ns=now_ns)

    async def observe(self, observation: PortfolioObservation, *, now_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.observe, observation, now_ns=now_ns)

    async def ingest(self, event: PaperEvent, *, received_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.ingest, event, received_ns=received_ns)

    async def pause_new_risk(self, reason: str, *, now_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.pause_new_risk, reason, now_ns=now_ns)

    async def cancel_simulation(self, submission_key: str, grant: MutationGrant, *, now_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.cancel_simulation, submission_key, grant, now_ns=now_ns)

    async def request_liquidation(self, grant: MutationGrant, *, now_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.request_liquidation, grant, now_ns=now_ns)

    async def reset_new_risk(self, grant: MutationGrant, *, now_ns: int) -> None:
        async with self._lock:
            await asyncio.to_thread(self.owner.reset_new_risk, grant, now_ns=now_ns)
