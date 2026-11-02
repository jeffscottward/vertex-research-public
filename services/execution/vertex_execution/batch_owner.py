"""One durable reservation for an ordered set of independently reviewed paper legs.

The public receipt still describes the primary intent, not authorization for the
other legs. Their complete immutable identities and native risk evidence remain
in the private journal. Atomic admission does not imply atomic market fills:
native risk must reserve every independent partial-leg and settlement outcome.
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from .exact import units
from .owner import PaperExecutionOwner, digest_reference, reference
from .ports import ExecutionError, PaperEvent, RiskPlan


class AtomicBatchOwner(PaperExecutionOwner):
    def _load_batch(self, legs: tuple[tuple[str, str], ...]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        if type(legs) is not tuple or not 1 <= len(legs) <= 8:
            raise ExecutionError("batch-requires-one-to-eight-reviewed-legs")
        records = []
        strategy = None
        for pair in legs:
            if type(pair) is not tuple or len(pair) != 2:
                raise ExecutionError("batch-leg-requires-exact-artifact-pair")
            intent_id, admission_id = pair
            intent, intent_hash = self._artifact(intent_id, "TradeIntent")
            admission, admission_hash = self._artifact(admission_id, "PaperSimulationAdmission")
            review, review_hash = self._artifact(admission["reviewId"], "AcceptedReview")
            current_strategy, strategy_hash = self._artifact(admission["strategyVersion"], "StrategySpec")
            if strategy is not None and current_strategy != strategy:
                raise ExecutionError("batch-mixed-strategy")
            strategy = current_strategy
            records.append({"intentArtifactId": intent_id, "intentSha256": intent_hash,
                            "admissionArtifactId": admission_id, "admissionSha256": admission_hash,
                            "reviewArtifactId": admission["reviewId"], "reviewSha256": review_hash,
                            "strategyArtifactId": admission["strategyVersion"], "strategySha256": strategy_hash,
                            "intent": intent, "admission": admission, "review": review})
        # Order-leg maps cannot represent repeated instruments, even if sides
        # differ. Do not net, collapse or silently drop any reviewed identity.
        for values in (
            [r["intentArtifactId"] for r in records], [r["intentSha256"] for r in records],
            [r["admissionArtifactId"] for r in records], [r["admissionSha256"] for r in records],
            [r["reviewArtifactId"] for r in records],
            [r["intent"]["intentId"] for r in records], [r["intent"]["instrumentId"] for r in records],
            [r["admission"]["admissionId"] for r in records],
            [r["admission"]["idempotencyKey"] for r in records],
        ):
            if len(set(values)) != len(records):
                raise ExecutionError("duplicate-reviewed-batch-leg")
        assert strategy is not None
        return records, strategy

    @staticmethod
    def _batch_identity(batch_key: str, records: list[dict[str, Any]]) -> dict[str, Any]:
        names = ("intentArtifactId", "intentSha256", "admissionArtifactId", "admissionSha256",
                 "reviewArtifactId", "reviewSha256", "strategyArtifactId", "strategySha256")
        return {"accountAlias": records[0]["admission"]["accountAlias"], "environment": "paper",
                "idempotencyKey": batch_key,
                "legs": [{name: record[name] for name in names} for record in records]}

    def _qualified_keys(self, records: list[dict[str, Any]]) -> list[str]:
        return ["submission-" + self.authority.digest({"accountAlias": r["admission"]["accountAlias"],
                "environment": "paper", "idempotencyKey": r["admission"]["idempotencyKey"]}) for r in records]

    def _check_batch_bindings(self, records: list[dict[str, Any]], state: Mapping[str, Any], now_ns: int,
                              *, review_checkpoint: Mapping[str, Any] | None = None) -> None:
        primary = records[0]
        first = primary["admission"]
        checkpoint = review_checkpoint if review_checkpoint is not None else state.get("portfolioCheckpoint")
        if not checkpoint or checkpoint["ownerEpoch"] != str(self.epoch):
            raise ExecutionError("batch-owned-review-checkpoint-required")
        common = ("accountAlias", "environment", "simulatorId", "streamId", "ownerEpoch", "actorId",
                  "strategyVersion", "policyVersion", "portfolioSnapshotId", "portfolioSequence", "reviewVersion")
        for record in records:
            intent, admission, review = record["intent"], record["admission"], record["review"]
            if (any(admission[name] != first[name] for name in common)
                    or record["strategyArtifactId"] != primary["strategyArtifactId"]
                    or record["strategySha256"] != primary["strategySha256"]
                    or review["collectionId"] != primary["review"]["collectionId"]):
                raise ExecutionError("batch-mixed-review-context")
            if (admission["accountAlias"] != state["accountAlias"] or admission["environment"] != "paper"
                    or admission["simulatorId"] != state["simulatorId"] or admission["streamId"] != self.stream_id
                    or admission["ownerEpoch"] != str(self.epoch) or intent["accountAlias"] != state["accountAlias"]
                    or intent["environment"] != "paper" or intent["strategyVersion"] != admission["strategyVersion"]
                    or intent["idempotencyKey"] != admission["idempotencyKey"] or intent["intentId"] != admission["intentId"]
                    or record["intentSha256"] != admission["intentSha256"]
                    or record["intentSha256"] != admission["reviewedArtifactSha256"]
                    or review["artifactId"] != record["intentArtifactId"] or review["artifactSha256"] != record["intentSha256"]
                    or review["reviewId"] != admission["reviewId"] or review["reviewVersion"] != admission["reviewVersion"]
                    or review["actorId"] != admission["actorId"] or review["decision"] != "accepted"
                    or review["purpose"] != "paper-simulation" or review["accountAlias"] != state["accountAlias"]
                    or review["environment"] != "paper" or review["strategyVersion"] != admission["strategyVersion"]
                    or review["policyVersion"] != admission["policyVersion"]
                    or admission["portfolioSnapshotId"] != checkpoint["snapshotId"]
                    or admission["portfolioSequence"] != checkpoint["sequence"]
                    or not (self.authority.epoch_ns(admission["admittedAt"]) <= now_ns < self.authority.epoch_ns(admission["expiresAt"]))
                    or not (self.authority.epoch_ns(review["reviewedAt"]) <= now_ns < self.authority.epoch_ns(review["expiresAt"]))
                    or not (self.authority.epoch_ns(intent["proposedAt"]) <= now_ns < self.authority.epoch_ns(intent["expiresAt"]))
                    or self.admission_authority.permits(admission=admission, review=review, now_ns=now_ns) is not True):
                raise ExecutionError("batch-admission-binding-or-authority-invalid")

    def _canonical_record(self, payload: bytes, reason: str) -> dict[str, Any]:
        if type(payload) is not bytes or not 0 < len(payload) <= 2_000_000:
            raise ExecutionError(reason)
        try:
            value = json.loads(payload)
            if type(value) is not dict or self.authority.encode(value) != payload:
                raise ExecutionError(reason)
            return value
        except (ValueError, TypeError) as error:
            raise ExecutionError(reason) from error

    def _check_batch_plan(self, plan: RiskPlan, records: list[dict[str, Any]], batch_digest: str, submission_key: str,
                          revision: int, ledger_hash: str, now_ns: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        primary = records[0]
        expiry = min(self.authority.epoch_ns(r[k]["expiresAt"]) for r in records for k in ("intent", "admission", "review"))
        expected_legs = tuple((r["intent"]["instrumentId"], r["intent"]["side"], r["intent"]["quantity"]) for r in records)
        if (not isinstance(plan, RiskPlan) or plan.intent_sha256 != primary["intentSha256"]
                or plan.strategy_artifact_id != primary["strategyArtifactId"]
                or plan.policy_version != primary["admission"]["policyVersion"]
                or plan.ledger_sequence != revision or plan.ledger_sha256 != ledger_hash
                or type(plan.valid_until_ns) is not int or not now_ns < plan.valid_until_ns <= expiry
                or type(plan.settlement_required) is not bool or plan.legs != expected_legs
                or units(plan.cash_reserve) < 0 or units(plan.maximum_loss) <= 0 or units(plan.maximum_notional) <= 0
                or units(plan.maximum_loss) > sum(units(r["admission"]["maximumLoss"]) for r in records)
                or units(plan.maximum_notional) > sum(units(r["admission"]["maximumNotional"]) for r in records)):
            raise ExecutionError("batch-risk-plan-mismatch-or-limit")
        if len(dict(plan.share_reserve)) != len(plan.share_reserve):
            raise ExecutionError("duplicate-plan-instrument")
        for instrument, amount in plan.share_reserve:
            reference(instrument)
            if units(amount) < 0:
                raise ExecutionError("invalid-share-reservation")
        command = self._canonical_record(plan.command_bytes, "noncanonical-simulator-command")
        evidence = self._canonical_record(plan.batch_evidence_bytes, "batch-native-evidence-required")
        reservation = self._canonical_record(plan.kernel_reservation_bytes, "batch-native-reservation-required")
        if (evidence.get("commandSha256") != self.authority.digest(command)
                or ("batchDigest" in evidence and evidence["batchDigest"] != batch_digest)
                or type(evidence.get("orderedLegs")) is not list or len(evidence["orderedLegs"]) != len(records)):
            raise ExecutionError("batch-command-evidence-mismatch")
        totals = {"maximumLoss": 0, "maximumNotional": 0, "cashReservation": 0}
        covered_shares: dict[str, int] = {}
        settlement_required = False
        for record, leg in zip(records, evidence["orderedLegs"], strict=True):
            intent, admission = record["intent"], record["admission"]
            expected = {"intentSha256": record["intentSha256"], "admissionSha256": record["admissionSha256"],
                        "instrumentId": intent["instrumentId"], "side": intent["side"], "quantity": intent["quantity"]}
            if type(leg) is not dict or any(leg.get(k) != v for k, v in expected.items()):
                raise ExecutionError("batch-native-leg-identity-mismatch")
            try:
                loss, notional = units(leg["maximumLoss"]), units(leg["maximumNotional"])
                cash, cost, settlement = (units(leg[name]) for name in ("cashReservation", "costReservation", "settlementCash"))
            except KeyError as error:
                raise ExecutionError("batch-native-leg-bounds-missing") from error
            if (not 0 < loss <= min(units(admission["maximumLoss"]), units(intent["maxLossBudget"]))
                    or not 0 < notional <= units(admission["maximumNotional"])
                    or min(cash, cost, settlement) < 0 or cost + settlement > cash or cash > loss
                    or type(leg.get("settlementRequired")) is not bool
                    or (settlement > 0 and not leg["settlementRequired"])):
                raise ExecutionError("batch-native-leg-exceeds-reviewed-cap")
            digest_reference(leg.get("qualifiedLegSha256"))
            native = leg.get("nativeLegPlan")
            native_expected = {"instrument_id": intent["instrumentId"], "intent_hash": record["intentSha256"],
                               "quantity": intent["quantity"], "limit_price": intent["limitPrice"],
                               "maximum_loss": leg["maximumLoss"], "gross_notional": leg["maximumNotional"],
                               "cash_reservation": leg["cashReservation"], "cost_reservation": leg["costReservation"],
                               "settlement_cash": leg["settlementCash"]}
            if (type(native) is not dict or any(native.get(k) != v for k, v in native_expected.items())
                    or units(native["limit_price"]) <= 0
                    or type(native.get("covered_shares")) is not dict
                    or "expiry_ns" not in native or "settlement_at_ns" not in native):
                raise ExecutionError("batch-native-leg-plan-mismatch")
            clocks = (native["expiry_ns"], native["settlement_at_ns"])
            if leg["settlementRequired"]:
                if any(type(value) is not str or not value.isascii() or not value.isdecimal()
                       or len(value) > 39 or str(int(value)) != value or int(value) >= 2**127 for value in clocks):
                    raise ExecutionError("batch-native-settlement-clock-invalid")
                if not now_ns < int(clocks[0]) <= int(clocks[1]) or plan.valid_until_ns > int(clocks[0]):
                    raise ExecutionError("batch-native-settlement-clock-invalid")
            elif any(value is not None for value in clocks):
                raise ExecutionError("batch-native-settlement-clock-invalid")
            for instrument, amount in native["covered_shares"].items():
                reference(instrument)
                if units(amount) < 0:
                    raise ExecutionError("invalid-share-reservation")
                covered_shares[instrument] = covered_shares.get(instrument, 0) + units(amount)
            for name in totals:
                totals[name] += units(leg[name])
            settlement_required = settlement_required or leg["settlementRequired"]
        # These are independent pessimistic native bounds, never offsetting sale
        # credits or a best-case spread loss. Cash already includes all costs and
        # settlement cash; do not count either twice.
        if (totals["maximumLoss"] != units(plan.maximum_loss)
                or totals["maximumNotional"] != units(plan.maximum_notional)
                or totals["cashReservation"] != units(plan.cash_reserve)
                or covered_shares != {instrument: units(amount) for instrument, amount in plan.share_reserve}
                or settlement_required != plan.settlement_required
                or reservation.get("proposal_hashes") != [r["intentSha256"] for r in records]
                or reservation.get("reservation_id") != submission_key
                or reservation.get("strategy_artifact_id") != primary["strategyArtifactId"]
                or reservation.get("cash") != plan.cash_reserve
                or reservation.get("maximum_loss") != plan.maximum_loss
                or reservation.get("gross_notional") != plan.maximum_notional
                or reservation.get("covered_shares") != dict(plan.share_reserve)):
            raise ExecutionError("batch-native-aggregate-evidence-mismatch")
        return command, evidence, reservation

    def admit_batch(self, batch_idempotency_key: str, legs: tuple[tuple[str, str], ...], *, now_ns: int) -> str:
        reference(batch_idempotency_key)
        with self.journal.mutex:
            state = self._scope()
            records, strategy = self._load_batch(legs)
            batch = self._batch_identity(batch_idempotency_key, records)
            batch_digest = self.authority.digest(batch)
            key = "batchsubmission-" + self.authority.digest({"accountAlias": batch["accountAlias"],
                    "environment": "paper", "idempotencyKey": batch_idempotency_key})
            old = state["orders"].get(key)
            if old is not None:
                if (old.get("batchDigest") != batch_digest or old.get("batch") != batch
                        or old["payloadSha256"] != batch_digest):
                    raise ExecutionError("qualified-idempotency-payload-conflict")
                return key  # Immutable exact replay is observation, not re-admission.
            qualified_keys = self._qualified_keys(records)
            claimed = {q for order in state["orders"].values()
                       for q in order.get("qualifiedKeys", [order["submissionKey"]])}
            if any(q in claimed for q in qualified_keys):
                raise ExecutionError("qualified-leg-already-owned")
            self._ready(now_ns)
            self._check_batch_bindings(records, state, now_ns)
            snapshot, revision, ledger_hash = self.journal.snapshot()
            plan = self.risk.assess_batch(batch_submission_key=key,
                    intents=tuple(r["intent"] for r in records), admissions=tuple(r["admission"] for r in records),
                    strategy=strategy, ledger=snapshot, ledger_sequence=revision, ledger_sha256=ledger_hash, now_ns=now_ns)
            command, evidence, reservation = self._check_batch_plan(plan, records, batch_digest, key, revision, ledger_hash, now_ns)
            primary = records[0]
            data = {"submissionKey": key, "payloadSha256": batch_digest,
                    "qualifiedKeys": qualified_keys, "batch": batch, "batchDigest": batch_digest,
                    "batchLegs": records, "batchEvidence": evidence,
                    "reviewCheckpoint": dict(state["portfolioCheckpoint"]), "reservationEventId": "reserve-" + key,
                    "intent": primary["intent"], "admission": primary["admission"],
                    "intentArtifactId": primary["intentArtifactId"], "admissionArtifactId": primary["admissionArtifactId"],
                    "strategySha256": primary["strategySha256"], "strategyArtifactId": primary["strategyArtifactId"],
                    "cashReserve": plan.cash_reserve, "shareReserve": dict(plan.share_reserve),
                    "maximumLoss": plan.maximum_loss, "maximumNotional": plan.maximum_notional,
                    "command": command, "riskValidUntilNs": str(plan.valid_until_ns),
                    "riskLedgerSequence": str(revision), "riskLedgerSha256": ledger_hash,
                    "legs": {i: {"side": side, "maximumQuantity": quantity, "filled": "0"} for i, side, quantity in plan.legs},
                    "settlementRequired": plan.settlement_required, "reservationState": "reserved",
                    "status": "not-submitted", "dispatchMarked": False, "cancelRequested": False,
                    "finalityProven": False, "reconciledEpoch": str(self.epoch), "orderRef": None,
                    "kernelReservation": reservation, "events": {}, "fills": {}}
            event_id = "reserve-" + key
            # One append atomically publishes the whole reserve plus its outbox
            # receipt. There is no per-leg append and no compensating release.
            self.journal.append("reserve", data, now_ns=now_ns, event_id=event_id, expected_sequence=revision,
                                projection=self._projection(key, now_ns, now_ns, event_id))
            return key

    def dispatch_once(self, submission_key: str, *, now_ns: int) -> tuple[PaperEvent, ...]:
        with self.journal.mutex:
            state = self._scope()
            order = state["orders"].get(submission_key)
            if order is None or "batchDigest" not in order:
                return super().dispatch_once(submission_key, now_ns=now_ns)
            if order["dispatchMarked"]:
                return ()
            self._ready(now_ns, reviewed_checkpoint=False)
            if (order["reservationState"] != "reserved" or order["status"] != "not-submitted"
                    or order["cancelRequested"] or order["finalityProven"]):
                raise ExecutionError("batch-reservation-not-dispatchable")
            if now_ns >= int(order["riskValidUntilNs"]):
                raise ExecutionError("dispatch-admission-expired")
            records, strategy = self._load_batch(tuple((r["intentArtifactId"], r["admissionArtifactId"]) for r in order["batchLegs"]))
            batch = self._batch_identity(order["batch"]["idempotencyKey"], records)
            if (records != order["batchLegs"] or batch != order["batch"]
                    or self.authority.digest(batch) != order["batchDigest"]
                    or order["payloadSha256"] != order["batchDigest"]
                    or self._qualified_keys(records) != order["qualifiedKeys"]):
                raise ExecutionError("pinned-batch-artifacts-changed")
            self._check_batch_bindings(records, state, now_ns, review_checkpoint=order["reviewCheckpoint"])
            current, revision, ledger_hash = self.journal.snapshot()
            # Native checks exact reservation lineage before excluding ONLY this
            # still-unfilled reserve; all other positions/reservations survive.
            current["dispatchReservationKey"] = submission_key
            plan = self.risk.assess_batch(batch_submission_key=submission_key,
                    intents=tuple(r["intent"] for r in records), admissions=tuple(r["admission"] for r in records),
                    strategy=strategy, ledger=current, ledger_sequence=revision, ledger_sha256=ledger_hash, now_ns=now_ns)
            _, evidence, _ = self._check_batch_plan(plan, records, order["batchDigest"], submission_key, revision, ledger_hash, now_ns)
            if (units(plan.cash_reserve) > units(order["cashReserve"]) or dict(plan.share_reserve) != order["shareReserve"]
                    or units(plan.maximum_loss) > units(order["maximumLoss"])
                    or units(plan.maximum_notional) > units(order["maximumNotional"])
                    or plan.settlement_required != order["settlementRequired"] or evidence != order["batchEvidence"]
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
                self.pause_new_risk("simulation-outcome-unknown", now_ns=now_ns)
                raise ExecutionError("simulation-outcome-unknown-no-resubmit") from error
