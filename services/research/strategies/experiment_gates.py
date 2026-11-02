"""Preregistered criteria + source-verified measurements -> quant review.

This is the only new gate admission entrypoint. No supplied pass/outcome field
exists. Private immutable observation bytes, original ResearchEvidence and exact
current review pins are preserved. A completed review remains non-executable.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256
import re

from backtesting.lineage import AcceptanceCriterion, Pin, time_ns
from .core import count, digest_text, identity, instant
from .lab_authority import (LabScope, LabVerifier, LabVerifierPin, LabVerificationReceipt,
                            ReviewedEvidence, bounded_tuple, evidence_record, original_record,
                            receipt_record, text, timestamp, verify_binding)
from .publication import AuthoritativeValidator, CanonicalCodec, Unavailable, encode_authoritatively
from .quant import (PROMOTION_GATES, ExperimentEvidence, ExperimentHandoff, ExperimentWindow,
                    PromotionReview, review_experiment)

ORIGINS = {"reproducible-backtest": "backtest", "out-of-sample": "backtest",
           "walk-forward": "walk-forward", "stress": "stress",
           "cost-sensitivity": "cost-sensitivity", "forward-paper": "forward-paper-observation"}
GATE_POLICY_COMMITMENT_PREFIX = "gate-policy:"
GATE_POLICY_VERSION = "2.0.0"


def parse_time(value: str) -> datetime:
    # This private profile supports exact microseconds; never silently truncate ns.
    if type(value) is not str or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value) is None:
        raise ValueError("Exact UTC microsecond timestamp required by lab v1")
    return instant(datetime.fromisoformat(value.replace("Z", "+00:00")))


@dataclass(frozen=True)
class GateCriterion:
    criterion_id: str
    gate: str
    criterion: AcceptanceCriterion
    unit: str
    window: ExperimentWindow
    method: Pin
    maximum_age_seconds: int
    rule_method: Pin

    def __post_init__(self) -> None:
        identity(self.criterion_id)
        text(self.unit, 160)
        if self.gate not in PROMOTION_GATES or type(self.criterion) is not AcceptanceCriterion:
            raise ValueError("Known gate and existing exact-decimal acceptance criterion required")
        if (type(self.window) is not ExperimentWindow or type(self.method) is not Pin
                or type(self.rule_method) is not Pin):
            raise ValueError("Explicit reviewed window, binding method and rule-only method required")
        count(self.maximum_age_seconds, positive=True)
        bounded_tuple(self.criterion.evidence_ids, 64, minimum=1)

    def record(self) -> dict:
        return {"criterionId": self.criterion_id, "gate": self.gate,
                "criterion": self.criterion.record(), "unit": self.unit,
                "window": {"start": timestamp(self.window.start_at), "end": timestamp(self.window.end_at)},
                "method": asdict(self.method), "maximumAgeSeconds": self.maximum_age_seconds,
                "ruleMethod": asdict(self.rule_method), "requiredOrigin": ORIGINS[self.gate]}


@dataclass(frozen=True)
class GatePolicy:
    policy_id: str
    revision: int
    experiment_hash: str
    registered_at: datetime
    criteria: tuple[GateCriterion, ...]
    rules_hash: str

    def __post_init__(self) -> None:
        identity(self.policy_id)
        count(self.revision, positive=True)
        digest_text(self.experiment_hash)
        digest_text(self.rules_hash)
        instant(self.registered_at)
        bounded_tuple(self.criteria, 96, minimum=6)
        if any(type(c) is not GateCriterion for c in self.criteria):
            raise ValueError("Explicit reviewed gate criteria required")
        if (len({c.criterion_id for c in self.criteria}) != len(self.criteria)
                or {c.gate for c in self.criteria} != set(PROMOTION_GATES)):
            raise ValueError("All six gates need unique declared criteria; no default thresholds")
        for gate in PROMOTION_GATES:
            items = [c for c in self.criteria if c.gate == gate]
            if (len(items) > 16 or len({(c.window, c.method, c.rule_method) for c in items}) != 1
                    or len({c.criterion.metric_id for c in items}) != len(items)):
                raise ValueError("Bounded distinct gate metrics with one explicit window/method required")

    def rules_record(self) -> dict:
        """Non-circular science only; full reviewed binding remains in record().

        Method rule digests retain scientific definitions and exact model pins.
        Experiment/run/mapping/result identities, review evidence identities and
        asserted registration dates belong to the independently checked envelope.
        """
        return {"format": "vertex-experiment-gate-rules-v2", "policyId": self.policy_id,
            "revision": self.revision, "criteria": [
                {"criterionId": c.criterion_id, "gate": c.gate,
                 "criterion": {"metricId": c.criterion.metric_id, "operator": c.criterion.operator,
                               "threshold": c.criterion.threshold},
                 "unit": c.unit, "window": c.record()["window"], "method": asdict(c.rule_method),
                 "maximumAgeSeconds": c.maximum_age_seconds, "requiredOrigin": ORIGINS[c.gate]}
                for c in self.criteria], "executionAuthority": "none"}

    def record(self) -> dict:
        return {"format": "vertex-experiment-gate-policy-v2", "policyId": self.policy_id,
                "revision": self.revision, "experimentHash": self.experiment_hash,
                "registeredAt": timestamp(self.registered_at), "rulesHash": self.rules_hash,
                "criteria": [c.record() for c in self.criteria], "executionAuthority": "none"}


def committed_policy_rules(policy: GatePolicy, frozen_bytes: bytes, *, codec: CanonicalCodec) -> str | Unavailable:
    """Check original bytes only; the verifier separately proves publication.

    Never insert a marker into an old experiment or treat a current review,
    requestedAt or registeredAt as evidence of prior publication.
    """
    _, digest = encode_authoritatively(policy.rules_record(), codec)
    if digest != policy.rules_hash:
        raise ValueError("Gate policy rule core differs from its exact canonical pin")
    frozen = original_record(frozen_bytes, codec=codec)
    markers = [value for value in frozen["hypothesis"]["assumptions"]
        if type(value) is str and value.startswith(GATE_POLICY_COMMITMENT_PREFIX)]
    if markers != [GATE_POLICY_COMMITMENT_PREFIX + GATE_POLICY_VERSION + ":sha256:" + digest]:
        return Unavailable(("gate-policy-original-rule-precommitment-unavailable",))
    return digest


@dataclass(frozen=True)
class GateObservation:
    """Closed observation JSON, original provenance artifact, expected current review.

    Observation keys: format, observationId, experimentHash, policyHash, gate,
    producedAt, availableAt, window{start,end}, origin, method{identity,version,digest},
    provenanceId, provenanceHash, reviewerId, metrics[{criterionId,metricId,value,unit}],
    contaminated, limitations. No outcome/pass/accepted key is permitted.
    Provenance bytes may be engine results or genuinely observed forward records;
    the selected verifier must establish their semantics and immutable publication.
    """
    observation_bytes: bytes
    provenance_bytes: bytes
    evidence: ReviewedEvidence

    def __post_init__(self) -> None:
        for value in (self.observation_bytes, self.provenance_bytes):
            if type(value) is not bytes or not 1 <= len(value) <= 700_000:
                raise ValueError("Bounded immutable gate/provenance originals required")
        if type(self.evidence) is not ReviewedEvidence:
            raise ValueError("Original reviewed evidence required")


@dataclass(frozen=True)
class AdmittedExperimentReview:
    review: PromotionReview
    evidence: tuple[ExperimentEvidence, ...]
    admission_bytes: bytes
    admission_hash: str
    receipt: LabVerificationReceipt

    def record(self) -> dict:
        return {"format": "vertex-experiment-review-result-v1", "admissionHash": self.admission_hash,
                "state": self.review.state, "missingGates": list(self.review.missing_gates),
                "rejectedGates": list(self.review.rejected_gates), "receipt": receipt_record(self.receipt),
                "executionAuthority": "none", "requiresSeparateHumanApproval": True}


def review_with_gate_evidence(handoff: ExperimentHandoff, policy: GatePolicy, *,
                             expected_policy_hash: str, policy_evidence: ReviewedEvidence,
                             observations: tuple[GateObservation, ...], scope: LabScope, as_of: datetime,
                             codec: CanonicalCodec | None, validator: AuthoritativeValidator | None,
                             verifier: LabVerifier | None, verifier_pin: LabVerifierPin | None) -> AdmittedExperimentReview | Unavailable:
    """Verifier checks committed experiment and preregistration before quant review.

    Missing observations remain missing gates. Missing/changed authority returns
    Unavailable, never a pass. Every invocation re-resolves current authority;
    retaining a prior result or receipt does not authorize a later operation.
    """
    if codec is None or validator is None or verifier is None or verifier_pin is None:
        return Unavailable(("experiment-gate-admission-ports-unavailable",))
    bounded_tuple(observations, 6)
    frozen = original_record(handoff.canonical_bytes, codec=codec)
    if policy.experiment_hash != handoff.content_hash or frozen["requiredEvidenceGates"] != list(PROMOTION_GATES):
        raise ValueError("Gate policy does not bind exact frozen experiment")
    rules_hash = committed_policy_rules(policy, handoff.canonical_bytes, codec=codec)
    if isinstance(rules_hash, Unavailable):
        return rules_hash
    policy_bytes, policy_hash = encode_authoritatively(policy.record(), codec)
    digest_text(expected_policy_hash)
    if policy_hash != expected_policy_hash:
        raise ValueError("Gate policy differs from independently selected original identity")
    policy_source, policy_review = evidence_record(policy_evidence, scope=scope, as_of=as_of, codec=codec, validator=validator)
    if (policy_source["contentHash"] != policy_hash
            or any(policy_source["evidenceId"] not in c.criterion.evidence_ids for c in policy.criteria)):
        raise ValueError("Original reviewed evidence must bind the exact declared criteria")
    historical_start = parse_time(frozen["windows"]["training"]["start"])
    historical_end = parse_time(frozen["windows"]["outOfSample"]["end"])
    for c in policy.criteria:
        if c.gate == "forward-paper":
            if c.window.start_at < parse_time(frozen["requestedAt"]):
                raise ValueError("Forward gate cannot use pre-plan observations")
        elif c.window.start_at < historical_start or c.window.end_at > historical_end:
            raise ValueError("Historical gate window lies outside frozen experiment")
        if c.gate == "out-of-sample" and c.window != ExperimentWindow(
                parse_time(frozen["windows"]["outOfSample"]["start"]), historical_end):
            raise ValueError("OOS criterion must bind the exact frozen OOS interval")
    admitted, observation_records, reviews = [], [], [policy_review]
    originals = [handoff.canonical_bytes, policy_bytes, policy_evidence.original_bytes]
    review_deadlines = [policy_evidence.current_review.expires_ns, policy_evidence.current_review.rights_valid_until_ns]
    seen_gates, seen_ids, seen_evidence = set(), set(), {policy_source["evidenceId"]}
    for supplied in observations:
        if type(supplied) is not GateObservation:
            raise ValueError("Immutable gate observation required")
        row = original_record(supplied.observation_bytes, codec=codec)
        if set(row) != {"format", "observationId", "experimentHash", "policyHash", "gate", "producedAt",
                        "availableAt", "window", "origin", "method", "provenanceId", "provenanceHash",
                        "reviewerId", "metrics", "contaminated", "limitations"}:
            raise ValueError("Closed measured-observation profile required; pass flags are not proof")
        gate = row["gate"]
        if (row["format"] != "vertex-experiment-gate-observation-v1" or gate not in PROMOTION_GATES
                or gate in seen_gates or row["experimentHash"] != handoff.content_hash
                or row["policyHash"] != policy_hash or row["origin"] != ORIGINS[gate]):
            raise ValueError("Observation experiment/policy/gate/origin mismatch")
        for key in ("observationId", "provenanceId", "reviewerId"):
            identity(row[key])
        if row["observationId"] in seen_ids or row["provenanceHash"] != sha256(supplied.provenance_bytes).hexdigest():
            raise ValueError("Observation/provenance immutable identity mismatch")
        criteria = [c for c in policy.criteria if c.gate == gate]
        if (row["window"] != criteria[0].record()["window"] or row["method"] != asdict(criteria[0].method)
                or type(row["contaminated"]) is not bool or type(row["limitations"]) is not list
                or len(row["limitations"]) > 64):
            raise ValueError("Measurement window/method/limitations must be explicit")
        for limitation in row["limitations"]:
            text(limitation)
        produced, available = parse_time(row["producedAt"]), parse_time(row["availableAt"])
        if (not produced <= available <= instant(as_of)
                or criteria[0].window.end_at > produced
                or any(time_ns(as_of) - time_ns(available) > c.maximum_age_seconds * 1_000_000_000 for c in criteria)):
            raise ValueError("Future, stale or pre-window gate measurement")
        source, current_review = evidence_record(supplied.evidence, scope=scope, as_of=as_of, codec=codec, validator=validator)
        if (source["evidenceId"] in seen_evidence or source["contentHash"] != sha256(supplied.observation_bytes).hexdigest()
                or not time_ns(available) <= time_ns(source["capturedAt"]) <= time_ns(as_of)):
            raise ValueError("Current evidence must bind original observation bytes/time")
        metrics = row["metrics"]
        if (type(metrics) is not list or len(metrics) != len(criteria)
                or any(type(m) is not dict or set(m) != {"criterionId", "metricId", "value", "unit"} for m in metrics)
                or len({m["criterionId"] for m in metrics}) != len(metrics)
                or {m["criterionId"] for m in metrics} != {c.criterion_id for c in criteria}):
            raise ValueError("All declared measurements required; no inferred metric/threshold")
        passed = True
        for criterion in criteria:
            metric = next(m for m in metrics if m["criterionId"] == criterion.criterion_id)
            if (metric["metricId"], metric["unit"]) != (criterion.criterion.metric_id, criterion.unit):
                raise ValueError("Reviewed metric identity/unit mismatch")
            passed = criterion.criterion.accepts(metric["value"]) and passed
        # Preliminary computation is not returned until the trusted verifier admits
        # the originals and complete contamination/limitations/source semantics.
        admitted.append(ExperimentEvidence(gate, handoff.content_hash, supplied.evidence.artifact_hash,
            instant(as_of), row["reviewerId"], "pass" if passed else "fail",
            row["contaminated"], tuple(dict.fromkeys((
                *policy_source["limitations"], *source["limitations"], *row["limitations"])))))
        observation_records.append({"observation": row, "observationHash": source["contentHash"],
                                    "evidenceHash": supplied.evidence.artifact_hash})
        reviews.append(current_review)
        originals.extend((supplied.observation_bytes, supplied.provenance_bytes, supplied.evidence.original_bytes))
        review_deadlines.extend((supplied.evidence.current_review.expires_ns, supplied.evidence.current_review.rights_valid_until_ns))
        seen_gates.add(gate)
        seen_ids.add(row["observationId"])
        seen_evidence.add(source["evidenceId"])
    binding = {"experimentId": handoff.experiment_id, "experimentHash": handoff.content_hash,
               "policyHash": policy_hash, "policyRulesHash": rules_hash,
               "policy": policy.record(), "observations": observation_records,
               "currentReviews": reviews}
    receipt = verify_binding("experiment-gates", binding, tuple(originals), scope=scope, as_of=as_of,
        codec=codec, verifier=verifier, verifier_pin=verifier_pin, valid_until_ns=min(review_deadlines))
    if isinstance(receipt, Unavailable):
        return receipt
    evidence = tuple(admitted)
    review = review_experiment(handoff, evidence, as_of=as_of)
    encoded, digest = encode_authoritatively({"format": "vertex-experiment-gate-admission-v1",
        "binding": binding, "receipt": receipt_record(receipt),
        "review": {"state": review.state, "missingGates": list(review.missing_gates),
                   "rejectedGates": list(review.rejected_gates)},
        "executionAuthority": "none", "requiresSeparateHumanApproval": True}, codec)
    return AdmittedExperimentReview(review, evidence, encoded, digest, receipt)
