"""Pure in-process byte adapter to vertex_execution_kernel::evaluate_json.

No executable/subprocess, ffi loader or network is selected automatically. The
composition root injects the verified compiled native function AND a trusted,
preloaded exact metadata/evidence resolver. Missing any dependency fails closed.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable, Mapping, Protocol

from .exact import decimal, units
from .ports import ContractAuthority, ExecutionError, RiskPlan


@dataclass(frozen=True)
class QualifiedRiskInputs:
    policy: Mapping[str, Any]
    legs: tuple[Mapping[str, Any], ...]
    positions: tuple[Mapping[str, Any], ...]
    evidence_sha256: str


class QualifiedEvidencePort(Protocol):
    """Trusted local cache, not user/model-provided qualification booleans.

    Resolve actual immutable contract/calendar/tzdb/Greek/quote/entitlement/cost
    policies and evidence. Verify owner-reviewed 0DTE gates and all sleeve lots.
    No made-up fee, settlement date, delay or position valuation defaults.
    """
    def resolve(self, *, intent: Mapping[str, Any], admission: Mapping[str, Any],
                strategy: Mapping[str, Any], ledger: Mapping[str, Any], now_ns: int) -> QualifiedRiskInputs: ...
    def resolve_batch(self, *, intents: tuple[Mapping[str, Any], ...], admissions: tuple[Mapping[str, Any], ...],
                      strategy: Mapping[str, Any], ledger: Mapping[str, Any], now_ns: int) -> QualifiedRiskInputs: ...
    def command_batch(self, *, inputs: QualifiedRiskInputs, native_plan: Mapping[str, Any],
                      intents: tuple[Mapping[str, Any], ...], admissions: tuple[Mapping[str, Any], ...]) -> bytes: ...
    def verify(self, inputs: QualifiedRiskInputs, *, ledger_sha256: str, now_ns: int) -> bool: ...
    def command(self, *, inputs: QualifiedRiskInputs, native_plan: Mapping[str, Any],
                intent: Mapping[str, Any], admission: Mapping[str, Any]) -> bytes:
        """Canonical private SubmitCommand recipe, inverse of bridge decoder.encode.

        Excludes submission key/hash/time injected at dispatch; includes complete
        qualified legs, model IDs, explicit fee/legging/cost/latency limits.
        """
        ...


class NativeRiskPort:
    def __init__(self, *, authority: ContractAuthority, evaluate: Callable[[bytes], bytes],
                 evidence: QualifiedEvidencePort, journal_id: str) -> None:
        self.authority, self.evaluate, self.evidence, self.journal_id = authority, evaluate, evidence, journal_id

    def assess(self, *, intent: Mapping[str, Any], admission: Mapping[str, Any],
               strategy: Mapping[str, Any], ledger: Mapping[str, Any],
               ledger_sequence: int, ledger_sha256: str, now_ns: int) -> RiskPlan:
        key = "submission-" + self.authority.digest({"accountAlias": admission["accountAlias"],
                "environment": "paper", "idempotencyKey": admission["idempotencyKey"]})
        return self.assess_batch(batch_submission_key=key, intents=(intent,), admissions=(admission,),
                                 strategy=strategy, ledger=ledger, ledger_sequence=ledger_sequence,
                                 ledger_sha256=ledger_sha256, now_ns=now_ns)

    def assess_batch(self, *, batch_submission_key: str, intents: tuple[Mapping[str, Any], ...],
                     admissions: tuple[Mapping[str, Any], ...], strategy: Mapping[str, Any],
                     ledger: Mapping[str, Any], ledger_sequence: int, ledger_sha256: str, now_ns: int) -> RiskPlan:
        if not 1 <= len(intents) <= 8 or len(intents) != len(admissions):
            raise ExecutionError("bounded-reviewed-leg-set-required")
        intent, admission = intents[0], admissions[0]
        for proposed, admitted in zip(intents, admissions):
            if (self.authority.validate("TradeIntent", proposed) is not True
                    or self.authority.validate("PaperSimulationAdmission", admitted) is not True):
                raise ExecutionError("native-artifact-validation-required")
            if (self.authority.digest(proposed) != admitted["intentSha256"]
                    or proposed["strategyVersion"] != admission["strategyVersion"]
                    or admitted["strategyVersion"] != admission["strategyVersion"]
                    or admitted["policyVersion"] != admission["policyVersion"]):
                raise ExecutionError("batch-native-review-binding-mismatch")
        inputs = (self.evidence.resolve(intent=intent, admission=admission, strategy=strategy, ledger=ledger, now_ns=now_ns)
                  if len(intents) == 1 else self.evidence.resolve_batch(intents=intents, admissions=admissions,
                  strategy=strategy, ledger=ledger, now_ns=now_ns))
        if (self.evidence.verify(inputs, ledger_sha256=ledger_sha256, now_ns=now_ns) is not True
                or inputs.policy["version"] != admission["policyVersion"]):
            raise ExecutionError("qualified-native-input-evidence-unverified")
        if len(inputs.legs) != len(intents) or any(leg["intent_hash"] != self.authority.digest(proposed)
                for leg, proposed in zip(inputs.legs, intents)):
            raise ExecutionError("every-package-leg-requires-exact-reviewed-admission")
        observation = ledger.get("observation")
        if not observation or ledger["environment"] != "paper":
            raise ExecutionError("owned-observation-required")
        quantities: dict[str, int] = {}
        settled: dict[str, int] = {}
        for position in inputs.positions:
            instrument = position["instrument_id"]
            quantities[instrument] = quantities.get(instrument, 0) + units(position["quantity"])
            settled[instrument] = settled.get(instrument, 0) + units(position["settled_quantity"])
        actual = {i: units(q) for i, q in ledger["positions"].items() if units(q) != 0}
        if {i: q for i, q in quantities.items() if q != 0} != actual:
            raise ExecutionError("native-evidence-omits-owned-position")
        for instrument, amount in settled.items():
            pending = sum(units(p["quantity"]) for p in ledger["unsettledPositions"].values() if p["instrumentId"] == instrument)
            if amount > max(0, actual.get(instrument, 0) - pending):
                raise ExecutionError("native-evidence-spends-unsettled-shares")
        reservations = []
        for key, order in ledger["orders"].items():
            if order["reservationState"] == "released":
                continue
            reservation = order.get("kernelReservation")
            if reservation is None:
                raise ExecutionError("owned-reservation-native-lineage-missing")
            reservation = json.loads(self.authority.encode(reservation))
            reservation["reservation_id"] = key
            if reservation["cash"] != order["cashReserve"] or reservation["covered_shares"] != order["shareReserve"]:
                raise ExecutionError("native-reservation-collateral-drift")
            reservations.append(reservation)
        key = batch_submission_key
        journal = {"source": "local-execution-journal", "journal_id": self.journal_id,
                   "revision": str(ledger_sequence), "owner_epoch": ledger["ownerEpoch"], "head_hash": ledger_sha256,
                   "account_alias": ledger["accountAlias"], "environment": "paper", "currency": ledger["currency"],
                   "observed_at_ns": observation["observedNs"], "reconciled_at_ns": observation["receivedNs"],
                   "durable": True, "continuity_complete": True, "fully_reconciled": ledger["reconciled"],
                   "unknown_acceptance": any(o["status"] == "unknown" for o in ledger["orders"].values()),
                   "kill_new_risk": ledger["pausedNewRisk"], "settled_cash": ledger["cash"],
                   "positions": list(inputs.positions), "reservations": reservations}
        request = {"request_version": "vertex.execution-kernel.v1", "operation": "evaluate", "mode": "PAPER-SIMULATION",
                   "request_id": key, "now_ns": str(now_ns), "account_alias": ledger["accountAlias"],
                   "strategy_artifact_id": admission["strategyVersion"], "strategy": dict(strategy), "intents": [dict(i) for i in intents],
                   "policy": dict(inputs.policy), "journal": journal, "legs": list(inputs.legs),
                   "dispatch_reservation_key": ledger.get("dispatchReservationKey")}
        encoded = self.authority.encode(request)
        if len(encoded) > 4_194_304:
            raise ExecutionError("native-risk-request-too-large")
        raw = self.evaluate(encoded)
        if not isinstance(raw, bytes) or len(raw) > 2_000_000:
            raise ExecutionError("native-risk-response-bound")
        response = json.loads(raw)
        if (self.authority.encode(response) != raw or response["request_version"] != "vertex.execution-kernel.v1"
                or response["status"] != "admitted" or response["live_authorization"] is not False
                or response["broker_submission_allowed"] is not False or response["plan"] is None):
            raise ExecutionError("native-risk-rejected")
        plan = response["plan"]
        if (plan["request_id"] != key or plan["account_alias"] != ledger["accountAlias"]
                or plan["mode"] != "PAPER-SIMULATION" or plan["strategy_artifact_id"] != admission["strategyVersion"]
                or plan["strategy_hash"] != self.authority.digest(strategy) or plan["policy_hash"] != self.authority.digest(inputs.policy)
                or plan["policy_id"] != inputs.policy["policy_id"]
                or plan["cost_model_id"] != inputs.policy["costs"]["model_id"]
                or plan["latency_model_id"] != inputs.policy["costs"]["latency_model_id"]
                or plan["journal_id"] != self.journal_id or plan["journal_revision"] != str(ledger_sequence)
                or plan["journal_head_hash"] != ledger_sha256 or plan["owner_epoch"] != ledger["ownerEpoch"]
                or plan["evaluated_at_ns"] != str(now_ns) or plan["live_authorization"] is not False
                or plan["broker_submission_allowed"] is not False):
            raise ExecutionError("native-plan-context-mismatch")
        reserve = plan["reservation"]
        expiry = min(int(plan["expires_at_ns"]), *(self.authority.epoch_ns(a["expiresAt"]) for a in admissions))
        if (expiry <= now_ns or reserve["reservation_id"] != key
                or reserve["strategy_artifact_id"] != admission["strategyVersion"]
                or reserve["sleeve"] != strategy["sleeve"]
                or reserve["proposal_hashes"] != [self.authority.digest(i) for i in intents]):
            raise ExecutionError("native-reservation-context-or-expiry-mismatch")
        if len(plan["legs"]) != len(intents):
            raise ExecutionError("native-plan-leg-count-mismatch")
        leg_evidence = []
        for native, proposed, admitted, qualified in zip(plan["legs"], intents, admissions, inputs.legs):
            if (native["instrument_id"] != proposed["instrumentId"] or native["quantity"] != proposed["quantity"]
                    or native["intent_hash"] != self.authority.digest(proposed)
                    or native["limit_price"] != proposed["limitPrice"]
                    or units(native["maximum_loss"]) <= 0 or units(native["gross_notional"]) <= 0
                    or units(native["cash_reservation"]) < 0 or units(native["cost_reservation"]) < 0
                    or units(native["settlement_cash"]) < 0
                    or units(native["cash_reservation"]) < units(native["cost_reservation"]) + units(native["settlement_cash"])
                    or units(native["maximum_loss"]) > units(admitted["maximumLoss"])
                    or units(native["gross_notional"]) > units(admitted["maximumNotional"])):
                raise ExecutionError("native-leg-exceeds-separate-admission")
            leg_evidence.append({"intentSha256": self.authority.digest(proposed), "admissionSha256": self.authority.digest(admitted),
                                 "instrumentId": native["instrument_id"], "side": proposed["side"], "quantity": native["quantity"],
                                 "maximumLoss": native["maximum_loss"], "maximumNotional": native["gross_notional"],
                                 "cashReservation": native["cash_reservation"], "costReservation": native["cost_reservation"],
                                 "nativeLegPlan": dict(native), "qualifiedLegSha256": self.authority.digest(qualified),
                                 "settlementCash": native["settlement_cash"], "settlementRequired": qualified["instrument"]["kind"] == "option"})
        for native_key, evidence_key in (("cash", "cashReservation"), ("maximum_loss", "maximumLoss"), ("gross_notional", "maximumNotional")):
            if units(reserve[native_key]) != sum(units(e[evidence_key]) for e in leg_evidence):
                raise ExecutionError("native-aggregate-leg-bound-mismatch")
        command = (self.evidence.command(inputs=inputs, native_plan=plan, intent=intent, admission=admission)
                   if len(intents) == 1 else self.evidence.command_batch(inputs=inputs, native_plan=plan,
                   intents=intents, admissions=admissions))
        if not isinstance(command, bytes) or self.authority.encode(json.loads(command)) != command:
            raise ExecutionError("qualified-simulator-command-not-canonical")
        return RiskPlan(intent_sha256=self.authority.digest(intent), strategy_artifact_id=admission["strategyVersion"],
                        ledger_sequence=ledger_sequence, ledger_sha256=ledger_sha256, policy_version=admission["policyVersion"],
                        cash_reserve=reserve["cash"], share_reserve=tuple(sorted(reserve["covered_shares"].items())),
                        maximum_loss=reserve["maximum_loss"], maximum_notional=reserve["gross_notional"], command_bytes=command,
                        legs=tuple((leg["instrument_id"], proposed["side"], leg["quantity"]) for leg, proposed in zip(plan["legs"], intents)),
                        settlement_required=any(leg["instrument"]["kind"] == "option" for leg in inputs.legs),
                        valid_until_ns=expiry, kernel_reservation_bytes=self.authority.encode(reserve),
                        batch_evidence_bytes=self.authority.encode({"orderedLegs": leg_evidence,
                            "commandSha256": self.authority.digest(json.loads(command))}))
