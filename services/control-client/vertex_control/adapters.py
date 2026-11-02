"""Lease-scoped research ports over public Worker contracts, never SQL/brokers."""
from __future__ import annotations

import base64
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Mapping

from .client import ControlError, SameORPCJSON, parse_json

MAX_ARTIFACT_BYTES = 1_048_576
_CALL_LIMIT = ContextVar("vertex_control_call_limit", default=None)


@dataclass(frozen=True, kw_only=True)
class RunBinding:
    run_id: str
    trace_id: str
    request_digest: str
    token_budget: int
    cost_budget_usd: str


@dataclass(frozen=True, kw_only=True)
class ResearchContext:
    fence: Mapping[str, str]
    actor_id: str
    authorization: object
    clock: Any
    deadline_ns: int
    rights_policy_id: str
    rights_version: str
    collection_id: str | None = None
    snapshot_id: str | None = None
    run_binding: RunBinding | None = None
    # Only host-verified selection pins may populate this source-policy/version
    # to retention-policy identity mapping. A timestamp is never a policy ID.
    retention_policy_bindings: Mapping[tuple[str, str], str] = field(default_factory=dict)
    # Host-owned selected grant/endpoint closure; creates full authoritative
    # ModelUseRequest for eligibility probes, not a generic permission boolean.
    model_use_request_factory: Any = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        object.__setattr__(self, "fence", MappingProxyType(dict(self.fence)))
        object.__setattr__(self, "retention_policy_bindings", MappingProxyType(dict(self.retention_policy_bindings)))
        if (self.authorization is None or not callable(getattr(self.clock, "now", None))
                or type(self.deadline_ns) is not int or self.deadline_ns <= 0):
            raise ControlError("research-context-unavailable")


def decode_content(value: str, expected_digest: str) -> bytes:
    try:
        if type(value) is not str or len(value) > 1_398_104 or not value.isascii():
            raise ValueError()
        content = base64.b64decode(value, validate=True)
        if (len(content) > MAX_ARTIFACT_BYTES or base64.b64encode(content).decode("ascii") != value
                or sha256(content).hexdigest() != expected_digest):
            raise ValueError()
        return content
    except Exception:
        raise ControlError("artifact-content-rejected") from None


def _revision(version: str) -> int:
    # Private agent revision is an integer; public review version is SemVer.
    # Lossless length-prefixed mapping, NOT int(float(version)) or a made-up revision.
    parts = version.split(".")
    if len(parts) != 3 or any(not p.isascii() or not p.isdigit() for p in parts):
        raise ControlError("review-version-rejected")
    revision = int("1" + "".join(str(len(p)).zfill(2) + p for p in parts))
    if revision > 9_007_199_254_740_991:
        raise ControlError("review-version-not-representable")
    return revision


class _Port:
    def __init__(self, client, bridge, context):
        self.client, self.bridge, self.context = client, bridge, context
        self.authority = client.authority
        try:
            if self.authority.validate("WorkerFence", dict(context.fence), "1.0.0") is not True:
                raise ValueError()
        except Exception:
            raise ControlError("worker-fence-rejected") from None

    def now_ns(self):
        return self.authority.epoch_ns(self.context.clock.now())

    @contextmanager
    def operation(self, deadline_ns, cancellation):
        self.guard(deadline_ns, cancellation)
        token = _CALL_LIMIT.set((deadline_ns, cancellation))
        try:
            yield
        finally:
            _CALL_LIMIT.reset(token)

    def guard(self, deadline_ns=None, cancellation=None):
        deadline = self.context.deadline_ns if deadline_ns is None else min(deadline_ns, self.context.deadline_ns)
        inherited = _CALL_LIMIT.get()
        if inherited is not None:
            deadline = min(deadline, inherited[0])
            if inherited[1].cancelled() is not False:
                raise ControlError("domain-cancelled")
        if cancellation is not None and cancellation.cancelled() is not False:
            raise ControlError("domain-cancelled")
        remaining = (deadline - self.now_ns()) / 1_000_000_000
        if remaining <= 0:
            raise ControlError("domain-deadline-expired")
        return remaining

    def call(self, method, *, deadline_ns=None, cancellation=None, **fields):
        remaining = self.guard(deadline_ns, cancellation)
        if set(fields).intersection(self.context.fence):
            raise ControlError("worker-fence-override")
        return self.bridge.run(lambda: self.client.call(method, {**self.context.fence, **fields}),
                               timeout_seconds=remaining)

    def validate_record(self, name, content, digest):
        try:
            if type(content) is not bytes or len(content) > MAX_ARTIFACT_BYTES or sha256(content).hexdigest() != digest:
                raise ValueError()
            value = parse_json(content)
            if (self.authority.validate(name, value, "1.0.0") is not True
                    or self.authority.encode(value) != content or self.authority.digest(value) != digest):
                raise ValueError()
            return value
        except Exception:
            raise ControlError("publication-record-rejected") from None

    def scope(self, collection_id):
        if self.context.collection_id is not None and collection_id != self.context.collection_id:
            raise ControlError("collection-scope-denied")

    def accepted(self, response, *, allow_duplicate=True):
        if (response.get("jobId") != self.context.fence["jobId"]
                or response.get("status") not in ({"accepted", "duplicate"} if allow_duplicate else {"accepted"})):
            raise ControlError("worker-commit-unconfirmed", effect="unknown")
        return response


# Operations are explicit domain-to-public-use translations; unknown operations deny.
_OPERATION_USES = {
    "collection-import": ("store",), "source-import": ("store",),
    "collection-retrieve": ("read", "derive"), "evidence-retrieve": ("read", "derive"),
    "source-retrieve": ("read", "derive"), "dataset-publish": ("store",),
    "dataset-ingest": ("read", "store", "derive"), "provider-fetch": ("read", "derive"),
    "dataset-stage": ("read", "store", "derive"),
    "historical-bars": ("read", "store", "derive"),
    "fetch": ("read", "derive"), "store": ("store",), "read": ("read",),
    "derive": ("derive",), "export": ("export",),
    "paper-parse": ("read", "derive"), "historical-authorized-input": ("read", "derive"),
    "company-facts": ("read", "derive"), "financial-statements": ("read", "derive"),
    "financial-metrics": ("read", "derive"), "earnings": ("read", "derive"),
    "filings": ("read", "derive"), "filing-item": ("read", "derive"),
    "insider-trades": ("read", "derive"), "institutional-holdings": ("read", "derive"),
    "index-funds": ("read", "derive"), "equity-bars": ("read", "derive"),
    "screener": ("read", "derive"), "equity-snapshot": ("read", "derive"),
    "option-chain": ("read", "derive"), "option-flow": ("read", "derive"),
    "contract-statistics": ("read", "derive"), "open-interest-by-strike": ("read", "derive"),
    "option-price": ("read", "derive"), "iv-surface": ("read", "derive"),
}


@dataclass(frozen=True, kw_only=True)
class CurrentReviewReceipt:
    """Detached exact public review and pin, not an agent's consuming identity."""
    review: Mapping[str, str | bool | None]
    pin: Mapping[str, str]
    review_bytes: bytes
    review_sha256: str


class RightsAdapter(_Port):
    def __init__(self, client, bridge, context, *, mode="legacy"):
        super().__init__(client, bridge, context)
        if mode not in ("legacy", "local-observation-v1"):
            raise ControlError("rights-mode-unavailable")
        self.mode = mode
        self._pins: dict[str, dict] = {}

    def _read_rights(self, method, reference_ns, **fields):
        if self.mode == "legacy":
            return self.call(method, **fields), None
        schema, format_name = {
            "currentRights": ("WorkerCurrentRightsObservationOutput", "vertex-worker-current-rights-observation-v1"),
            "acceptedEvidence": ("WorkerAcceptedEvidenceObservationOutput", "vertex-worker-accepted-evidence-observation-v1"),
        }[method]
        response = self.call(method + "Observation", **fields)
        try:
            if (self.authority.validate(schema, response, "1.0.0") is not True
                    or set(response) != {"format", "observedAt", "value"} or response["format"] != format_name):
                raise ValueError()
            observed = self.authority.epoch_ns(response["observedAt"])
            result = response["value"]
            rights = result if method == "currentRights" else result["rights"]
            receipt = self.now_ns()
            if (not reference_ns <= observed <= receipt
                    or self.authority.epoch_ns(rights["checkedAt"]) > observed
                    or (rights["retentionUntil"] is not None
                        and self.authority.epoch_ns(rights["retentionUntil"]) <= receipt)):
                raise ValueError()
            return result, observed
        except Exception:
            raise ControlError("rights-observation-rejected") from None

    def current(self, policy_id, uses, *, collection_id=None, expected_version=None, reference_ns=None):
        self.scope(collection_id)
        reference = self.now_ns() if reference_ns is None else reference_ns
        reads = [self._read_rights("currentRights", reference, collectionId=collection_id, policyId=policy_id, use=use) for use in uses]
        results = [result for result, _ in reads]
        now = self.now_ns()
        for use, (result, observed) in zip(uses, reads):
            if (result["policyId"] != policy_id or result["status"] != "granted" or use not in result["allowedUses"]
                    or result["expiresAt"] is None or self.authority.epoch_ns(result["expiresAt"]) <= now
                    or not reference <= (self.authority.epoch_ns(result["checkedAt"]) if observed is None else observed) <= now
                    or (expected_version is not None and result["version"] != expected_version)):
                raise ControlError("current-rights-denied")
        if not results or len({row["version"] for row in results}) != 1:
            raise ControlError("rights-version-changed")
        return min(results, key=lambda row: self.authority.epoch_ns(row["expiresAt"]))

    def decide(self, request):
        from providers.ports import RightsDecision
        uses = _OPERATION_USES.get(request.operation)
        if uses is None:
            raise ControlError("rights-operation-unsupported")
        collection = self.context.collection_id
        if collection is not None and request.scope_id != collection:
            raise ControlError("rights-scope-denied")
        value = self.current(request.policy_id, uses, collection_id=collection,
                             reference_ns=self.authority.epoch_ns(request.evaluated_at))
        retention = None
        if value["retentionUntil"] is not None and self.authority.epoch_ns(value["retentionUntil"]) > self.now_ns():
            retention = self.context.retention_policy_bindings.get((value["policyId"], value["version"]))
        # This projection is for the caller's explicit evaluation instant. The
        # selected read proves freshness without changing stored checkedAt.
        return RightsDecision(scope_id=request.scope_id, policy_id=request.policy_id,
                              operation=request.operation, status="granted", checked_at=request.evaluated_at,
                              expires_at=value["expiresAt"], revision=value["version"],
                              source_ids=request.source_ids, retention_policy=retention)

    def _join(self, *, actor_id, collection_id, snapshot_id, evidence_id, artifact_digest,
              original_bytes, purpose, reference_ns, authorization):
        if (actor_id != self.context.actor_id or authorization is not self.context.authorization
                or purpose != "research" or reference_ns > self.now_ns()):
            raise ControlError("evidence-scope-denied")
        self.scope(collection_id)
        if self.context.snapshot_id is not None and snapshot_id != self.context.snapshot_id:
            raise ControlError("evidence-snapshot-denied")
        response, observed = self._read_rights("acceptedEvidence", reference_ns,
            collectionId=collection_id, evidenceId=evidence_id)
        artifact, evidence, review, rights = (response[key] for key in ("artifact", "evidence", "review", "rights"))
        content = decode_content(response["contentBase64"], artifact["artifactSha256"])
        if (content != original_bytes or sha256(content).hexdigest() != artifact_digest
                or self.authority.encode(evidence) != content or self.authority.digest(evidence) != artifact_digest
                or evidence["evidenceId"] != evidence_id or evidence["collectionId"] != collection_id
                or evidence["snapshotId"] != snapshot_id or review["collectionId"] != collection_id
                or review["artifactId"] != artifact["artifactId"] or review["artifactSha256"] != artifact_digest
                or review["accountAlias"] != self.context.fence["accountAlias"]
                or review["environment"] != self.context.fence["environment"]
                or review["purpose"] != purpose or review["decision"] != "accepted"
                or not self.authority.epoch_ns(review["reviewedAt"]) <= reference_ns < self.authority.epoch_ns(review["expiresAt"])):
            raise ControlError("current-review-denied")
        now = self.now_ns()
        if (rights["policyId"] != evidence["rightsPolicyId"] or rights["status"] != "granted"
                or not {"read", "derive", "export"}.issubset(rights["allowedUses"])
                or rights["expiresAt"] is None or self.authority.epoch_ns(rights["expiresAt"]) <= now
                or self.authority.epoch_ns(review["expiresAt"]) <= now
                or not reference_ns <= (self.authority.epoch_ns(rights["checkedAt"]) if observed is None else observed) <= now):
            raise ControlError("current-review-rights-denied")
        self._pins[evidence_id] = {"collectionId": collection_id, "evidenceId": evidence_id,
                                  "artifactId": artifact["artifactId"], "artifactSha256": artifact_digest,
                                  "reviewId": review["reviewId"], "reviewVersion": review["reviewVersion"],
                                  "rightsPolicyId": rights["policyId"], "rightsVersion": rights["version"]}
        return evidence, review, rights

    def read_current_review_receipt(self, *, actor_id, account_alias, environment, collection_id,
                                    snapshot_id, evidence_id, artifact_digest, original_bytes, purpose,
                                    reference_ns, authorization, expected_pin) -> CurrentReviewReceipt:
        """Read exact current authority without converting its reviewer or version.

        This is the same fenced original/current-review/rights join as the agent
        port, but returns the genuine public AcceptedReview, not AcceptedReview's
        agent projection whose actor is the consuming principal. All returned
        fields are defensive immutable copies; expected pins confer no authority.
        """
        try:
            if ((account_alias, environment) !=
                    (self.context.fence["accountAlias"], self.context.fence["environment"])
                    or type(original_bytes) is not bytes or not isinstance(expected_pin, Mapping)):
                raise ControlError("evidence-scope-denied")
            expected = dict(expected_pin)
            _, review, rights = self._join(actor_id=actor_id, collection_id=collection_id,
                snapshot_id=snapshot_id, evidence_id=evidence_id, artifact_digest=artifact_digest,
                original_bytes=original_bytes, purpose=purpose, reference_ns=reference_ns,
                authorization=authorization)
            pin = {"collectionId": collection_id, "evidenceId": evidence_id,
                   "artifactId": review["artifactId"], "artifactSha256": artifact_digest,
                   "reviewId": review["reviewId"], "reviewVersion": review["reviewVersion"],
                   "rightsPolicyId": rights["policyId"], "rightsVersion": rights["version"]}
            if pin != expected:
                raise ControlError("current-review-pin-mismatch")
            review_bytes = self.authority.encode(review)
            record = parse_json(review_bytes)
            if (self.authority.validate("AcceptedReview", record, "1.0.0") is not True
                    or record != review
                    or any(value is not None and type(value) not in (str, bool) for value in record.values())
                    or any(type(value) is not str for value in pin.values())):
                raise ControlError("current-review-record-invalid")
            # AcceptedReview@1.0.0 has scalar fields only. Refuse shape evolution
            # above rather than accidentally returning nested mutable authority.
            return CurrentReviewReceipt(review=MappingProxyType(record), pin=MappingProxyType(pin),
                review_bytes=bytes(review_bytes), review_sha256=sha256(review_bytes).hexdigest())
        except (ControlError, KeyError, TypeError, ValueError):
            self._pins.pop(evidence_id, None)
            raise ControlError("current-review-receipt-unavailable") from None

    def resolve_current(self, *, actor_id, account_alias, environment, collection_id, snapshot_id,
                        evidence_id, artifact_digest, original_bytes, purpose, reference_ns, authorization,
                        expected_pin=None):
        from agents.types import AcceptedReview
        if (account_alias, environment) != (self.context.fence["accountAlias"], self.context.fence["environment"]):
            return None
        try:
            evidence, review, rights = self._join(actor_id=actor_id, collection_id=collection_id,
                snapshot_id=snapshot_id, evidence_id=evidence_id, artifact_digest=artifact_digest,
                original_bytes=original_bytes, purpose=purpose, reference_ns=reference_ns, authorization=authorization)
            if expected_pin is not None and dict(expected_pin) != self._pins.get(evidence_id):
                raise ControlError("current-review-pin-mismatch")
            return AcceptedReview(review_id=review["reviewId"], revision=_revision(review["reviewVersion"]),
                actor_id=actor_id, account_alias=account_alias, environment=environment,
                collection_id=collection_id, snapshot_id=snapshot_id, evidence_id=evidence_id,
                artifact_digest=artifact_digest, rights_policy_id=evidence["rightsPolicyId"], purpose=purpose,
                status="accepted", current=True, superseded=False,
                effective_ns=self.authority.epoch_ns(review["reviewedAt"]),
                expires_ns=self.authority.epoch_ns(review["expiresAt"]), resolved_ns=reference_ns,
                rights_authorized=True, rights_valid_until_ns=self.authority.epoch_ns(rights["expiresAt"]))
        except ControlError:
            self._pins.pop(evidence_id, None)
            return None

    def authorize(self, *, actor_id, evidence, reference_ns, authorization):
        from agents.types import RightsGrant
        try:
            previous = self._pins.get(evidence["evidenceId"])
            if previous is None:
                raise ControlError("accepted-review-required-before-rights")
            content = self.authority.encode(evidence)
            record, _, rights = self._join(actor_id=actor_id, collection_id=evidence["collectionId"],
                snapshot_id=evidence["snapshotId"], evidence_id=evidence["evidenceId"],
                artifact_digest=sha256(content).hexdigest(), original_bytes=content,
                purpose="research", reference_ns=reference_ns, authorization=authorization)
            if self._pins.get(evidence["evidenceId"]) != previous:
                self._pins.pop(evidence["evidenceId"], None)
                raise ControlError("review-changed-during-authorization")
            allow_model = False
            valid_until = self.authority.epoch_ns(rights["expiresAt"])
            if self.context.model_use_request_factory is not None:
                refs = (self._model_ref(previous),)
                request = self.context.model_use_request_factory(operation="model-tokenize", input_bytes=content,
                    evidence_refs=refs, deadline_ns=self.context.deadline_ns)
                if request.get("operation") != "model-tokenize" or request.get("evidence") != list(refs):
                    raise ControlError("model-eligibility-request-rejected")
                proof = self.authorize_model_use(request=request, input_bytes=content,
                                                 deadline_ns=self.context.deadline_ns)
                valid_until = min(valid_until, self.authority.epoch_ns(proof["validUntil"]))
                allow_model = True
            return RightsGrant(actor_id=actor_id, evidence_id=record["evidenceId"],
                collection_id=record["collectionId"], snapshot_id=record["snapshotId"], content_hash=record["contentHash"],
                rights_policy_id=rights["policyId"], permitted_use="research-advisory",
                valid_until_ns=valid_until,
                # Eligibility only. Actual prepared tokenize/completion inputs
                # MUST receive separate current proofs at the provider boundary.
                allow_excerpt=True, allow_model=allow_model, allow_publication=True)
        except (ControlError, KeyError, TypeError):
            return None

    @staticmethod
    def _model_ref(pin):
        return {key: pin[key] for key in ("artifactId", "artifactSha256", "reviewId", "reviewVersion",
                                          "rightsPolicyId", "rightsVersion")}

    def _refresh_model_pin(self, pin):
        if self.mode == "legacy":
            response = self.call("acceptedEvidence", collectionId=pin["collectionId"], evidenceId=pin["evidenceId"])
        else:
            response, _ = self._read_rights("acceptedEvidence", self.now_ns(),
                collectionId=pin["collectionId"], evidenceId=pin["evidenceId"])
        body = decode_content(response["contentBase64"], pin["artifactSha256"])
        record = response["evidence"]
        # _join performs the current exact hash/review/rights binding; its second
        # fresh read also detects a review change while this read was in flight.
        self._join(actor_id=self.context.actor_id, collection_id=pin["collectionId"],
            snapshot_id=record["snapshotId"], evidence_id=pin["evidenceId"],
            artifact_digest=pin["artifactSha256"], original_bytes=body, purpose="research",
            reference_ns=self.now_ns(), authorization=self.context.authorization)
        if self._pins[pin["evidenceId"]] != pin:
            self._pins.pop(pin["evidenceId"], None)
            raise ControlError("model-evidence-review-changed")

    def model_evidence_refs(self, evidence):
        refs = []
        for item in evidence:
            pin = self._pins.get(item.evidence_id)
            if (pin is None or pin["artifactSha256"] != item.artifact_digest
                    or pin["reviewId"] != item.accepted_review_id
                    or _revision(pin["reviewVersion"]) != item.accepted_review_revision
                    or pin["collectionId"] != item.collection_id):
                raise ControlError("model-evidence-pin-unavailable")
            self._refresh_model_pin(dict(pin))
            refs.append(self._model_ref(pin))
        return tuple(refs)

    def model_privacy_review(self, *, request, prepare, deadline_ns):
        """One metadata exchange, never model authority, dispatch or retry."""
        try:
            value = parse_json(self.authority.encode(dict(request)))
            if (type(prepare) is not bool
                    or self.authority.validate("ModelUseRequest", value, "1.0.0") is not True
                    or self.authority.digest({k: v for k, v in value.items() if k != "requestSha256"}) != value["requestSha256"]
                    or any(value[key] != expected for key, expected in self.context.fence.items())
                    or value["researchPrincipalId"] != self.context.actor_id):
                raise ValueError()
        except Exception:
            raise ControlError("privacy-review-request-rejected") from None
        fields = {key: item for key, item in value.items() if key not in self.context.fence}
        response = self.call("prepareModelPrivacyReview" if prepare else "readModelPrivacyReview",
                             deadline_ns=deadline_ns, **fields)
        if (self.authority.validate("WorkerModelPrivacyReviewOutput", response, "1.0.0") is not True
                or response["requestId"] != value["requestId"] or response["requestSha256"] != value["requestSha256"]):
            raise ControlError("privacy-review-status-rejected", effect="unknown" if prepare else "none")
        try:
            self.guard(deadline_ns)
        except Exception:
            raise ControlError("privacy-review-observation-expired", effect="unknown" if prepare else "none") from None
        return response

    def authorize_model_use(self, *, request, input_bytes, deadline_ns):
        try:
            value = parse_json(self.authority.encode(dict(request)))
            if (type(input_bytes) is not bytes or len(input_bytes) > 2_097_152
                    or value["inputBytes"] != len(input_bytes)
                    or value["inputSha256"] != sha256(input_bytes).hexdigest()
                    or any(value[key] != expected for key, expected in self.context.fence.items())
                    or value["researchPrincipalId"] != self.context.actor_id
                    or self.authority.epoch_ns(value["deadlineAt"]) > min(deadline_ns, self.context.deadline_ns)):
                raise ValueError()
            digest_body = {key: item for key, item in value.items() if key != "requestSha256"}
            if (self.authority.digest(digest_body) != value["requestSha256"]
                    or self.authority.validate("ModelUseRequest", value, "1.0.0") is not True):
                raise ValueError()
        except Exception:
            raise ControlError("model-use-request-rejected") from None
        self.guard(deadline_ns)
        for reference in value["evidence"]:
            pin = next((row for row in self._pins.values() if row["artifactId"] == reference["artifactId"]), None)
            if pin is None or self._model_ref(pin) != reference:
                raise ControlError("model-use-evidence-pin-mismatch")
            self._refresh_model_pin(dict(pin))
        started = self.now_ns()
        fields = {key: item for key, item in value.items() if key not in self.context.fence}
        proof = self.call("currentModelUse", deadline_ns=deadline_ns, **fields)
        # Request digest covers all budgets/purpose/tools/input bytes. Proof
        # identity fields also bind directly, never accepted as a generic True.
        bound = ("requestId", "requestSha256", "accountAlias", "environment", "researchPrincipalId",
                 "consumerServiceId", "selectionId", "selectionSha256", "providerId", "modelVersion",
                 "tokenizerArtifactId", "tokenizerSha256", "endpointReferenceId", "endpointSha256",
                 "modelUsePolicyVersion", "jobId", "leaseId", "leaseEpoch", "grantId", "grantVersion", "operation")
        now = self.now_ns()
        if (proof["decision"] != "allowed" or any(proof[key] != value[key] for key in bound)
                or proof["currentEvidenceSha256"] != self.authority.digest(value["evidence"])
                or not started <= self.authority.epoch_ns(proof["checkedAt"]) <= now
                or not now < self.authority.epoch_ns(proof["validUntil"]) <= self.authority.epoch_ns(value["deadlineAt"])
                or proof["grantRevision"] is None or proof["privacyPolicyId"] is None
                or proof["privacyPolicyVersion"] is None or proof["modelProcessingOnly"] is not True
                or proof["executionAuthorized"] is not False):
            raise ControlError("model-use-proof-denied")
        return proof


class RunAdmissionAdapter(_Port):
    def claim(self, *, actor_id, run_id, trace_id, request_digest, token_budget, cost_budget_usd,
              deadline_ns, cancellation):
        binding = self.context.run_binding
        if (binding is None or type(token_budget) is not int or type(deadline_ns) is not int
                or actor_id != self.context.actor_id or deadline_ns != self.context.deadline_ns
                or (run_id, trace_id, request_digest, token_budget, cost_budget_usd)
                != (binding.run_id, binding.trace_id, binding.request_digest, binding.token_budget, binding.cost_budget_usd)):
            return False
        response = self.call("admitRun", deadline_ns=deadline_ns, cancellation=cancellation,
                             runId=run_id, requestSha256=request_digest)
        # Duplicate admission is never fresh authorization to consume a budget.
        return response["jobId"] == self.context.fence["jobId"] and response["status"] == "accepted"


class ArtifactAdapter(_Port):
    def __init__(self, client, bridge, context, rights):
        super().__init__(client, bridge, context)
        self.rights = rights

    def stage(self, *, artifact_id, content, content_type, canonical_digest=None,
              lineage_artifact_ids=(), collection_id=None, rights_policy_id=None, rights_version=None):
        collection = self.context.collection_id if collection_id is None else collection_id
        self.scope(collection)
        if type(content) is not bytes or len(content) > MAX_ARTIFACT_BYTES:
            raise ControlError("artifact-size-rejected")
        digest = sha256(content).hexdigest()
        if canonical_digest is not None:
            try:
                value = parse_json(content)
                if canonical_digest != digest or self.authority.encode(value) != content:
                    raise ValueError()
            except Exception:
                raise ControlError("canonical-content-rejected") from None
        policy = rights_policy_id or self.context.rights_policy_id
        version = rights_version or self.context.rights_version
        self.rights.current(policy, ("store",), collection_id=collection, expected_version=version)
        result = self.call("stageArtifact", collectionId=collection, artifactId=artifact_id,
            contentBase64=base64.b64encode(content).decode("ascii"), contentSha256=digest,
            canonicalSha256=canonical_digest, contentType=content_type, rightsPolicyId=policy,
            rightsVersion=version, lineageArtifactIds=list(lineage_artifact_ids))
        if (result["artifact"] != {"artifactId": artifact_id, "artifactSha256": digest}
                or result["contentSha256"] != digest or result["canonicalSha256"] != canonical_digest):
            raise ControlError("stage-receipt-mismatch", effect="unknown")
        return result["artifact"]

    def read(self, *, artifact_id, expected_digest, collection_id=None):
        collection = self.context.collection_id if collection_id is None else collection_id
        self.scope(collection)
        result = self.call("readArtifact", collectionId=collection, artifactId=artifact_id)
        if (result["artifact"] != {"artifactId": artifact_id, "artifactSha256": expected_digest}
                or result["contentSha256"] != expected_digest):
            raise ControlError("artifact-reference-mismatch")
        content = decode_content(result["contentBase64"], expected_digest)
        if result["canonicalSha256"] is not None:
            if (result["canonicalSha256"] != expected_digest
                    or self.authority.encode(parse_json(content)) != content):
                raise ControlError("artifact-canonical-mismatch")
        return content

    def read_governed_copy(self, *, copy_id, expected_digest, expected_length, deadline_ns, cancellation):
        """Exact chat copy read; null is deliberately NOT the collection default.

        The existing server operation owns original response/plan/approval,
        running admission, lease, current rights and storage fences on both sides
        of governed I/O. This helper neither creates nor stages an artifact.
        """
        with self.operation(deadline_ns, cancellation):
            if (type(copy_id) is not str or not copy_id
                    or type(expected_length) is not int or not 1 <= expected_length <= MAX_ARTIFACT_BYTES):
                raise ControlError("governed-copy-reference-rejected")
            result = self.call("readArtifact", collectionId=None, artifactId=copy_id)
            if (result.get("artifact") != {"artifactId": copy_id, "artifactSha256": expected_digest}
                    or result.get("contentSha256") != expected_digest
                    or result.get("canonicalSha256") is not None
                    or "canonicalSha256" not in result
                    or result.get("contentType") != "application/json"):
                raise ControlError("governed-copy-reference-mismatch")
            content = decode_content(result["contentBase64"], expected_digest)
            if len(content) != expected_length:
                raise ControlError("governed-copy-length-mismatch")
            self.guard(deadline_ns, cancellation)
            return content

    def chat_stage_capacity(self, *, collection_id, artifact_id, rights_policy_id, rights_version,
                            lineage_artifact_ids, maximum_content_bytes, maximum_response_bytes,
                            maximum_request_bytes, maximum_proof_bytes):
        """Predispatch byte reservation only, never a fabricated proof/grant.

        Both canonical and actual configured oRPC envelope ceilings stay at two
        MiB. Only the existing known serializer is supported for this bounded
        private extension; legacy methods and serializers are unchanged.
        """
        config = self.client.config
        if (type(config.envelope) is not SameORPCJSON or type(config.max_request_bytes) is not int
                or not 1 <= config.max_request_bytes <= 2_097_152
                or type(maximum_content_bytes) is not int or not 1 <= maximum_content_bytes <= 262_144
                or type(maximum_response_bytes) is not int or not 1 <= maximum_response_bytes <= MAX_ARTIFACT_BYTES
                or any(type(n) is not int or not 1 <= n <= 65_536 for n in (maximum_request_bytes, maximum_proof_bytes))):
            raise ControlError("chat-output-envelope-unavailable")
        self.scope(collection_id)
        # Empty containers below are solely serialized overhead measurement,
        # never validated, submitted, or treated as request/proof authority.
        shell = {**self.context.fence, "collectionId": collection_id, "artifactId": artifact_id,
            "contentBase64": "", "contentSha256": "0" * 64, "canonicalSha256": "0" * 64,
            "contentType": "application/json", "rightsPolicyId": rights_policy_id, "rightsVersion": rights_version,
            "lineageArtifactIds": list(lineage_artifact_ids),
            "chatCompletion": {"request": {}, "responseBase64": "", "proof": {}}}
        additional = (4 * ((maximum_content_bytes + 2) // 3) + 4 * ((maximum_response_bytes + 2) // 3)
                      + maximum_request_bytes + maximum_proof_bytes)
        if (len(self.authority.encode(shell)) + additional > config.max_request_bytes
                or len(config.envelope.encode(shell)) + additional > config.max_request_bytes):
            raise ControlError("chat-output-envelope-budget")

    def stage_chat_advisory(self, *, collection_id, artifact_id, content, maximum_content_bytes,
                            rights_policy_id, rights_version, lineage_artifact_ids,
                            completion_request, completion_response, completion_proof, deadline_ns, cancellation):
        """Stage ONLY an existing reserved copy via the strict chat extension."""
        with self.operation(deadline_ns, cancellation):
            self.scope(collection_id)
            if (type(content) is not bytes or type(maximum_content_bytes) is not int
                    or not 1 <= len(content) <= maximum_content_bytes <= 262_144
                    or type(completion_response) is not bytes or not 1 <= len(completion_response) <= MAX_ARTIFACT_BYTES):
                raise ControlError("chat-output-content-budget")
            digest = sha256(content).hexdigest()
            profile = parse_json(content)
            # Discriminator/shape gate only. The research consumer and server
            # own full profile validation; no reverse research import or local
            # callback can establish original publication/derived-use authority.
            retained_keys = {"profile", "responseRequestId", "planId", "planSha256", "runId", "traceId",
                "taskContract", "modelVersion", "modelUseRequestSha256", "responseSha256",
                "usage", "output", "executionAuthorized"}
            debate_keys = {"profile", "debateRunId", "runKey", "ordinal", "kind", "configuration",
                "participantIds", "synthesizerId", "humanWindowSha256", "predecessors",
                "turnTokens", "turnCostUsd", "aggregateTokens", "aggregateCostUsd", "derivedContext"}
            v2 = type(profile) is dict and profile.get("profile") == "vertex-research-chat-advisory-v2"
            if (type(profile) is not dict
                    or profile.get("profile") not in ("vertex-research-chat-advisory-v1", "vertex-research-chat-advisory-v2")
                    or set(profile) != retained_keys | ({"debate"} if v2 else set())
                    or profile.get("executionAuthorized") is not False
                    or v2 and (type(profile["debate"]) is not dict or set(profile["debate"]) != debate_keys
                               or profile["debate"].get("profile") != "vertex-research-chat-debate-plan-v1")):
                raise ControlError("chat-output-profile-rejected")
            if (self.authority.encode(profile) != content
                    or profile.get("responseSha256") != sha256(completion_response).hexdigest()
                    or profile.get("modelUseRequestSha256") != completion_request.get("requestSha256")
                    or completion_request.get("operation") != "model-completion"
                    or completion_proof.get("decision") != "allowed"
                    or completion_proof.get("externalDispatchAllowed") is not False
                    or completion_proof.get("requestSha256") != completion_request.get("requestSha256")
                    or self.authority.validate("ModelUseRequest", completion_request, "1.0.0") is not True
                    or self.authority.validate("ModelUseProof", completion_proof, "1.0.0") is not True):
                raise ControlError("chat-output-provenance-rejected")
            self.rights.current(rights_policy_id, ("store", "derive"), collection_id=collection_id, expected_version=rights_version)
            request = {**self.context.fence, "collectionId": collection_id, "artifactId": artifact_id,
                "contentBase64": base64.b64encode(content).decode("ascii"), "contentSha256": digest, "canonicalSha256": digest,
                "contentType": "application/json", "rightsPolicyId": rights_policy_id, "rightsVersion": rights_version,
                "lineageArtifactIds": list(lineage_artifact_ids), "chatCompletion": {
                    "request": completion_request, "responseBase64": base64.b64encode(completion_response).decode("ascii"),
                    "proof": completion_proof}}
            config = self.client.config
            if (type(config.envelope) is not SameORPCJSON or len(self.authority.encode(request)) > config.max_request_bytes
                    or len(config.envelope.encode(request)) > config.max_request_bytes
                    or config.max_request_bytes > 2_097_152):
                raise ControlError("chat-output-envelope-budget")
            if self.authority.validate("WorkerStageArtifactInput", request, "1.0.0") is not True:
                raise ControlError("chat-output-stage-contract-rejected")
            self.guard(deadline_ns, cancellation)
            try:
                result = self.call("stageArtifact", **{key: value for key, value in request.items() if key not in self.context.fence})
            except ControlError:
                raise
            except Exception:
                raise ControlError("chat-output-stage-unconfirmed", effect="unknown") from None
            try:
                if (self.authority.validate("WorkerStageArtifactOutput", result, "1.0.0") is not True
                        or result.get("status") not in ("accepted", "duplicate")
                        or result.get("artifact") != {"artifactId": artifact_id, "artifactSha256": digest}
                        or result.get("contentSha256") != digest or result.get("canonicalSha256") != digest):
                    raise ValueError()
                return result["artifact"]
            except Exception:
                raise ControlError("chat-output-stage-unconfirmed", effect="unknown") from None

    def publish_chat_agent(self, *, collection_id, public_content, public_digest, advisory,
                           review_pins, response_request_id, rights_policy_id, rights_version,
                           expected_lease, deadline_ns, cancellation):
        """Existing public bodyless stage + publishAgent; no ordinary advisory."""
        with self.operation(deadline_ns, cancellation):
            self.scope(collection_id)
            run = self.validate_record("AgentRun", public_content, public_digest)
            if (run.get("status") != "completed" or run.get("agentRole") != "research" or run.get("allowedTools") != []
                    or run.get("outputArtifactIds") != [advisory["artifactId"]] or run.get("errors") != []
                    or run.get("approvalRequests") != [] or run.get("executionAuthorized") is not False
                    or run.get("inputEvidenceIds") != [pin["evidenceId"] for pin in review_pins]):
                raise ControlError("chat-public-run-rejected")
            for pin in review_pins:
                if pin != self.rights._pins.get(pin["evidenceId"]):
                    raise ControlError("chat-public-review-pin-mismatch")
                self.rights._refresh_model_pin(dict(pin))
            self.rights.current(rights_policy_id, ("store", "derive"), collection_id=collection_id, expected_version=rights_version)
            # Ordinary storage is used ONLY for this bodyless public AgentRun.
            # Use the existing stageArtifact RPC, retaining its full receipt so
            # an unknown/invalid status cannot be laundered into a reference.
            stage_request = {**self.context.fence, "collectionId": collection_id, "artifactId": run["runId"],
                "contentBase64": base64.b64encode(public_content).decode("ascii"), "contentSha256": public_digest,
                "canonicalSha256": public_digest, "contentType": "application/json", "rightsPolicyId": rights_policy_id,
                "rightsVersion": rights_version, "lineageArtifactIds": []}
            if self.authority.validate("WorkerStageArtifactInput", stage_request, "1.0.0") is not True:
                raise ControlError("chat-public-stage-contract-rejected")
            self.guard(deadline_ns, cancellation)
            try:
                staged = self.call("stageArtifact", **{key: value for key, value in stage_request.items() if key not in self.context.fence})
            except ControlError:
                raise
            except Exception:
                raise ControlError("chat-public-stage-unconfirmed", effect="unknown") from None
            try:
                public = {"artifactId": run["runId"], "artifactSha256": public_digest}
                if (self.authority.validate("WorkerStageArtifactOutput", staged, "1.0.0") is not True
                        or staged.get("status") not in ("accepted", "duplicate") or staged.get("artifact") != public
                        or staged.get("contentSha256") != public_digest or staged.get("canonicalSha256") != public_digest):
                    raise ValueError()
            except Exception:
                raise ControlError("chat-public-stage-unconfirmed", effect="unknown") from None
            self.guard(deadline_ns, cancellation)
            try:
                result = self.call("publishAgent", collectionId=collection_id, artifact=public, run=run,
                    advisoryProfileArtifact=advisory, reviewPins=list(review_pins), idempotencyKey="chat-publish-" + response_request_id)
            except ControlError:
                raise
            except Exception:
                raise ControlError("chat-agent-publication-unconfirmed", effect="unknown") from None
            identity_fields = ("jobId", "eventId", "kind", "researchPrincipalId", "accountAlias", "environment",
                "payloadArtifactId", "payloadSha256", "policySelectionId", "policySelectionSha256", "deadlineAt", "leaseId", "leaseEpoch")
            try:
                lease = result.get("lease")
                if (self.authority.validate("WorkerResult", result, "1.0.0") is not True
                        or result.get("jobId") != self.context.fence["jobId"] or result.get("status") not in ("accepted", "duplicate")
                        or result.get("state") != "running" or result.get("reason") is not None
                        or not isinstance(lease, Mapping) or any(lease.get(key) != expected_lease[key] for key in identity_fields)
                        or result.get("outputArtifactIds") != [run["runId"]]):
                    raise ValueError()
                return tuple(result["outputArtifactIds"])
            except Exception:
                raise ControlError("chat-agent-publication-unconfirmed", effect="unknown") from None

    def read_experiment(self, *, experiment_id, artifact_id, expected_digest, collection_id,
                        deadline_ns, cancellation):
        """Require an exact committed private binding; generic reads are not proof."""
        with self.operation(deadline_ns, cancellation):
            if collection_id is None:
                raise ControlError("experiment-collection-required")
            self.scope(collection_id)
            if artifact_id != "experiment-" + self.authority.digest({
                    "collectionId": collection_id, "experimentId": experiment_id}):
                raise ControlError("experiment-read-identity-mismatch")
            artifact = {"artifactId": artifact_id, "artifactSha256": expected_digest}
            result = self.call("readExperiment", deadline_ns=deadline_ns, cancellation=cancellation,
                collectionId=collection_id, experimentId=experiment_id, artifact=artifact)
            if (result.get("jobId") != self.context.fence["jobId"]
                    or result.get("collectionId") != collection_id
                    or result.get("experimentId") != experiment_id
                    or result.get("artifact") != artifact
                    or result.get("contentSha256") != expected_digest
                    or result.get("canonicalSha256") != expected_digest
                    or result.get("contentType") != "application/json"):
                raise ControlError("experiment-read-identity-mismatch")
            content = decode_content(result["contentBase64"], expected_digest)
            record = self.check_experiment_bytes(content, expected_digest)
            if record.get("experimentId") != experiment_id:
                raise ControlError("experiment-read-identity-mismatch")
            return content

    def read_backtest_run(self, *, collection_id, artifact, planned_run, results, recipe,
                          experiment=None, deadline_ns=None, cancellation=None):
        """Read original bytes only after the server proves the committed graph.

        The returned jobId is the independently resolved producing backtest job,
        not this adapter's consuming job. No generic read or stage fallback.
        An explicit experiment reference requires the server's original causal
        relation; absent proof is failure, never an ordinary-reader fallback.
        """
        self.guard(deadline_ns, cancellation)
        if collection_id is None:
            raise ControlError("backtest-collection-required")
        self.scope(collection_id)
        try:
            references = {name: dict(reference) for name, reference in (
                ("artifact", artifact), ("plannedRun", planned_run), ("results", results), ("recipe", recipe))}
            if any(self.authority.validate("WorkerArtifactRef", reference, "1.0.0") is not True
                   for reference in references.values()):
                raise ValueError()
            if len({reference["artifactId"] for reference in references.values()}) != 4:
                raise ValueError()
            relation = {} if experiment is None else {"experiment": parse_json(self.authority.encode(experiment))}
        except Exception:
            raise ControlError("backtest-reference-rejected") from None
        response = self.call("readBacktestRun", deadline_ns=deadline_ns, cancellation=cancellation,
                             collectionId=collection_id, **references, **relation)
        self.guard(deadline_ns, cancellation)
        try:
            if (self.authority.validate("WorkerReadBacktestRunOutput", response, "1.0.0") is not True
                    or response["collectionId"] != collection_id
                    or any(response[name] != reference for name, reference in references.items())
                    or ("experiment" in response) != ("experiment" in relation)
                    or (relation and response.get("experiment") != relation["experiment"])
                    or response["contentType"] != "application/json"
                    or response["contentSha256"] != references["artifact"]["artifactSha256"]
                    or response["canonicalSha256"] != response["contentSha256"]):
                raise ValueError()
            content = decode_content(response["contentBase64"], response["contentSha256"])
            record = self.validate_record("BacktestRun", content, response["contentSha256"])
            if (record["resultsRef"] != references["results"]["artifactId"]
                    or references["artifact"]["artifactId"] != "backtest-run-" + response["contentSha256"]
                    or references["results"]["artifactId"] != "backtest-results-" + references["results"]["artifactSha256"]):
                raise ValueError()
            for name, prefix in (("receipt", "sandbox-receipt-"), ("isolation", "sandbox-isolation-")):
                proven = response[name]
                if proven["artifactId"] != prefix + proven["artifactSha256"]:
                    raise ValueError()
            all_refs = [*references.values(), response["receipt"], response["isolation"]]
            if len({reference["artifactId"] for reference in all_refs}) != len(all_refs):
                raise ValueError()
            detached = parse_json(self.authority.encode(response))
        except Exception:
            raise ControlError("backtest-read-proof-mismatch") from None
        self.guard(deadline_ns, cancellation)
        return detached

    def read_dataset(self, *, collection_id, manifest, manifest_bytes, member, source=None,
                     review_pins, deadline_ns=None, cancellation=None):
        """Manifest-qualified original content/capture; never generic stage fallback.

        The immutable manifest bytes are checked locally, but only readDataset's
        committed producer graph/current reviews can authorize a cross-job read.
        This proof does not grant scientific or point-in-time qualification.
        """
        self.guard(deadline_ns, cancellation)
        pins = [dict(pin) for pin in review_pins]
        if collection_id is None and self.context.collection_id is not None:
            # This method alone permits a global committed dataset through the
            # consumer's own source reviews. The server additionally proves the
            # current selected original recipe's exact collection/manifest pins.
            if not pins or any(pin.get("collectionId") != self.context.collection_id for pin in pins):
                raise ControlError("dataset-review-collection-denied")
        else:
            self.scope(collection_id)
        reference = dict(manifest)
        if self.authority.validate("WorkerArtifactRef", reference, "1.0.0") is not True:
            raise ControlError("dataset-manifest-reference-rejected")
        root = self.validate_record("DatasetManifest", manifest_bytes, reference["artifactSha256"])
        if root["datasetId"] != reference["artifactId"]:
            raise ControlError("dataset-manifest-identity-mismatch")
        if member == "content" and source is None:
            expected = {"artifactId": root["storageRef"], "artifactSha256": root["contentHash"]}
        elif member == "capture" and source is not None:
            source = dict(source)
            if root["sources"].count(source) != 1:
                raise ControlError("dataset-capture-not-a-manifest-member")
            expected = {"artifactId": "blob-" + source["contentHash"], "artifactSha256": source["contentHash"]}
        else:
            raise ControlError("dataset-read-member-rejected")
        response = self.call("readDataset", deadline_ns=deadline_ns, cancellation=cancellation,
            collectionId=collection_id, manifest=reference, member=member, source=source, reviewPins=pins)
        self.guard(deadline_ns, cancellation)
        if (self.authority.validate("WorkerReadDatasetOutput", response, "1.0.0") is not True
                or response["collectionId"] != collection_id or response["manifest"] != reference
                or response["member"] != member or response["source"] != source
                or response["artifact"] != expected or response["canonicalSha256"] is not None
                or response["contentSha256"] != expected["artifactSha256"]):
            raise ControlError("dataset-read-proof-mismatch")
        content = decode_content(response["contentBase64"], expected["artifactSha256"])
        return {"producer_job_id": response["producerJobId"], "manifest": reference,
                "artifact": expected, "member": member, "source": source,
                "content": content, "content_type": response["contentType"]}

    def publish_record(self, *, contract_name, artifact_id, content, digest, collection_id=None,
                       lineage_artifact_ids=(), rights_policy_id=None, rights_version=None, review_pins=None,
                       experiment_source=None):
        if contract_name not in {"DatasetManifest", "ResearchEvidence", "StrategySpec", "BacktestRun"}:
            raise ControlError("publication-contract-unsupported")
        record = self.validate_record(contract_name, content, digest)
        review_fields = {}
        if review_pins is not None:
            if contract_name != "ResearchEvidence" or not 1 <= len(review_pins) <= 64:
                raise ControlError("publication-review-pins-required")
            collection = self.context.collection_id if collection_id is None else collection_id
            pins = [dict(pin) for pin in review_pins]
            if (len({pin.get("evidenceId") for pin in pins}) != len(pins)
                    or any(pin.get("collectionId") != collection
                           or pin != self.rights._pins.get(pin.get("evidenceId")) for pin in pins)):
                raise ControlError("publication-review-pin-mismatch")
            review_fields["reviewPins"] = pins
        if experiment_source is not None:
            # This narrow server path preserves original canonical run bytes and
            # commits public metadata/record only after exact source verification.
            # It does not stage under a job ID, so identical cross-job retries do
            # not mistake another job's private stage for publication proof.
            if contract_name != "BacktestRun" or review_pins is not None or lineage_artifact_ids:
                raise ControlError("experiment-run-publication-profile")
            if type(experiment_source) is not dict or set(experiment_source) != {
                    "experimentId", "experimentHash", "bindingSha256", "bindingReview", "dependencyPins"}:
                raise ControlError("experiment-run-source-profile")
            collection = self.context.collection_id if collection_id is None else collection_id
            self.scope(collection)
            pin = experiment_source["bindingReview"]
            if (type(pin) is not dict or pin.get("collectionId") != collection
                    or pin != self.rights._pins.get(pin.get("evidenceId"))):
                raise ControlError("experiment-run-binding-review-mismatch")
            artifact = {"artifactId": artifact_id, "artifactSha256": digest}
            review_fields["experimentSource"] = experiment_source
        else:
            artifact = self.stage(artifact_id=artifact_id, content=content, content_type="application/json",
                canonical_digest=digest, lineage_artifact_ids=lineage_artifact_ids, collection_id=collection_id,
                rights_policy_id=rights_policy_id, rights_version=rights_version)
        result = self.call("publishArtifact", collectionId=self.context.collection_id if collection_id is None else collection_id,
            artifact=artifact, contractName=contract_name, record=record,
            idempotencyKey="publish-" + self.authority.digest({"contract": contract_name, "artifact": artifact, **review_fields}),
            **review_fields)
        self.accepted(result)
        if experiment_source is not None and (result.get("state") != "running"
                or artifact_id not in result.get("outputArtifactIds", ())):
            raise ControlError("experiment-run-commit-unconfirmed", effect="unknown")
        return result

    def put_if_absent(self, plan):
        from strategies.publication import PublicationReceipt
        result = self.publish_record(contract_name=plan.contract_name, artifact_id=plan.artifact_id,
                                     content=plan.canonical_bytes, digest=plan.content_hash)
        return PublicationReceipt(plan.artifact_id, plan.content_hash,
                                  "created" if result["status"] == "accepted" else "already-present")

    def publish_experiment(self, artifact, *, artifact_id=None, lineage_artifact_ids=()):
        if artifact.contract_name != "BacktestRun":
            raise ControlError("experiment-contract-rejected")
        value = self.validate_record("BacktestRun", artifact.payload_bytes, artifact.digest)
        return self.publish_record(contract_name="BacktestRun", artifact_id=artifact_id or value["runId"],
            content=artifact.payload_bytes, digest=artifact.digest, lineage_artifact_ids=lineage_artifact_ids)

    def check_experiment_bytes(self, content, digest):
        """Byte/identity checks only; the API owns full private profile validation."""
        try:
            if type(content) is not bytes or not 0 < len(content) <= MAX_ARTIFACT_BYTES:
                raise ValueError()
            record = parse_json(content)
            if (type(record) is not dict or sha256(content).hexdigest() != digest
                    or self.authority.encode(record) != content or self.authority.digest(record) != digest
                    or record.get("internalKind") != "vertex-quant-experiment-handoff-v1"
                    or record.get("executionAuthority") != "none"
                    or record.get("simulatedCapitalEntersNav") is not False):
                raise ValueError()
            return record
        except Exception:
            raise ControlError("experiment-original-bytes-rejected") from None

    def publish_experiment_handoff(self, *, experiment_id, content, digest, dependency_pins,
                                   deadline_ns, cancellation, source_review_pins=None):
        """Commit one private handoff, never relabel it as a public BacktestRun."""
        with self.operation(deadline_ns, cancellation):
            collection = self.context.collection_id
            if collection is None:
                raise ControlError("experiment-collection-required")
            record = self.check_experiment_bytes(content, digest)
            if record["experimentId"] != experiment_id:
                raise ControlError("experiment-identity-mismatch")
            pins = [dict(pin) for pin in dependency_pins]
            if (not 1 <= len(pins) <= 64
                    or len({pin.get("artifactId") for pin in pins}) != len(pins)):
                raise ControlError("experiment-dependency-pins-required")
            for pin in pins:
                if self.authority.validate("WorkerExperimentDependencyPin", pin, "1.0.0") is not True:
                    raise ControlError("experiment-dependency-pin-rejected")
            source_fields = {}
            if source_review_pins is not None:
                source_pins = [dict(pin) for pin in source_review_pins]
                # Only pins actually resolved by this rights adapter are eligible.
                # These remain expectations, never caller-supplied authority.
                if (not 1 <= len(source_pins) <= 64
                        or len({pin.get("evidenceId") for pin in source_pins}) != len(source_pins)
                        or len({pin.get("artifactId") for pin in source_pins}) != len(source_pins)
                        or any(pin.get("collectionId") != collection
                               or pin != self.rights._pins.get(pin.get("evidenceId"))
                               or pin.get("artifactId") in {item["artifactId"] for item in pins}
                               for pin in source_pins)):
                    raise ControlError("experiment-source-review-pin-mismatch")
                source_fields["sourceReviewPins"] = source_pins
            artifact_id = "experiment-" + self.authority.digest({
                "collectionId": collection, "experimentId": experiment_id})
            # Expected pins are not authority. The server re-resolves every
            # dependency/review/right within the committing job transaction.
            # No stage receipt, timeout or unknown response can satisfy this call.
            result = self.call("publishExperiment", deadline_ns=deadline_ns, cancellation=cancellation,
                collectionId=collection, experimentId=experiment_id,
                contentBase64=base64.b64encode(content).decode("ascii"), contentSha256=digest,
                rightsPolicyId=self.context.rights_policy_id, rightsVersion=self.context.rights_version,
                dependencyPins=pins, **source_fields)
            self.accepted(result)
            if (result.get("collectionId") != collection or result.get("experimentId") != experiment_id
                    or result.get("artifact") != {"artifactId": artifact_id, "artifactSha256": digest}):
                raise ControlError("experiment-commit-receipt-mismatch", effect="unknown")
            return result

    def publish(self, *, run_id, trace_id, artifacts, deadline_ns, cancellation):
        with self.operation(deadline_ns, cancellation):
            return self._publish(run_id=run_id, trace_id=trace_id, artifacts=artifacts,
                                 deadline_ns=deadline_ns, cancellation=cancellation)

    def _publish(self, *, run_id, trace_id, artifacts, deadline_ns, cancellation):
        self.guard(deadline_ns, cancellation)
        collection = self.context.collection_id
        if not isinstance(collection, str) or not collection:
            raise ControlError("agent-publication-collection-required")
        binding = self.context.run_binding
        if binding is None or (run_id, trace_id) != (binding.run_id, binding.trace_id):
            raise ControlError("agent-publication-scope-denied")
        rows = {row[0]: row for row in artifacts}
        if len(artifacts) != 2 or set(rows) != {"AgentRun", "vertex-internal-agent-advisory-v1"}:
            raise ControlError("agent-publication-pair-required")
        _, public_id, public_bytes, public_hash = rows["AgentRun"]
        _, advisory_id, advisory_bytes, advisory_hash = rows["vertex-internal-agent-advisory-v1"]
        run = self.validate_record("AgentRun", public_bytes, public_hash)
        if (run["runId"] != run_id or public_id != run_id or run["tokenBudget"] != binding.token_budget
                or run["costBudgetUsd"] != binding.cost_budget_usd):
            raise ControlError("agent-publication-binding-mismatch")
        advisory = parse_json(advisory_bytes)
        if (self.authority.encode(advisory) != advisory_bytes or sha256(advisory_bytes).hexdigest() != advisory_hash
                or advisory.get("profile") != "vertex-internal-agent-advisory-v1"
                or advisory_id != "agent-advisory-" + advisory_hash):
            raise ControlError("advisory-profile-rejected")
        result_value = advisory.get("result")
        if (type(result_value) is not dict or result_value.get("run_id") != run_id
                or result_value.get("trace_id") != trace_id or result_value.get("status") != run["status"]
                or advisory.get("taskContract") != run["taskContract"]
                or advisory.get("modelVersion") != run["modelVersion"]):
            raise ControlError("advisory-run-binding-mismatch")
        used_evidence = {row["evidence_id"]: row for row in result_value.get("evidence", [])}
        if set(used_evidence) != set(run["inputEvidenceIds"]):
            raise ControlError("advisory-evidence-binding-mismatch")
        pins = []
        # Pins come from fresh trusted joins, never advisory/model-supplied versions.
        for evidence_id in run["inputEvidenceIds"]:
            pin = self.rights._pins.get(evidence_id)
            if pin is None:
                raise ControlError("agent-current-review-pin-unavailable")
            used = used_evidence[evidence_id]
            if pin.get("collectionId") != collection or used.get("collection_id") != collection:
                raise ControlError("agent-publication-collection-mismatch")
            if (used.get("accepted_review_id") != pin["reviewId"]
                    or used.get("accepted_review_revision") != _revision(pin["reviewVersion"])
                    or used.get("artifact_digest") != pin["artifactSha256"]):
                raise ControlError("advisory-review-pin-mismatch")
            pins.append(dict(pin))
        profile = self.stage(artifact_id=advisory_id, content=advisory_bytes, content_type="application/json",
                             canonical_digest=advisory_hash, lineage_artifact_ids=[p["artifactId"] for p in pins])
        self.guard(deadline_ns, cancellation)
        public = self.stage(artifact_id=public_id, content=public_bytes, content_type="application/json",
                            canonical_digest=public_hash)
        # ONE commit: public run and private profile. Stage calls never publish.
        result = self.call("publishAgent", deadline_ns=deadline_ns, cancellation=cancellation,
            collectionId=collection, artifact=public, run=run, advisoryProfileArtifact=profile,
            reviewPins=pins, idempotencyKey="agent-" + public_hash)
        # Stage receipts prove storage only. Completion needs the existing
        # publishAgent receipt's owned public output under this exact fence.
        # Do not promote the private profile or synthesize IDs from the request.
        try:
            if self.authority.validate("WorkerResult", result, "1.0.0") is not True:
                raise ValueError()
            self.accepted(result)
            lease = result.get("lease")
            outputs = result.get("outputArtifactIds")
            if (result.get("state") != "running" or not isinstance(lease, Mapping)
                    or any(lease.get(key) != value for key, value in self.context.fence.items())
                    or outputs != [public_id]):
                raise ValueError()
        except Exception:
            raise ControlError("agent-publication-receipt-unconfirmed", effect="unknown") from None
        return tuple(outputs)


class DatasetAdapter(_Port):
    def __init__(self, client, bridge, context, artifacts):
        super().__init__(client, bridge, context)
        self.artifacts = artifacts

    def publish(self, plan):
        record = self.validate_record("DatasetManifest", plan.manifest.payload_bytes, plan.manifest.digest)
        if (plan.rights_revision != self.context.rights_version
                or record["entitlementPolicyId"] != self.context.rights_policy_id):
            raise ControlError("dataset-rights-version-mismatch")
        if not plan.content or len(plan.content) + len(plan.records) > 10_000:
            raise ControlError("dataset-stage-count-rejected")
        if record["contentHash"] not in {content.digest for content in plan.content}:
            raise ControlError("dataset-content-unavailable")
        for content in plan.content:
            if len(content.data) > MAX_ARTIFACT_BYTES or sha256(content.data).hexdigest() != content.digest:
                raise ControlError("dataset-content-digest-mismatch")
        for row in plan.records:
            self.validate_record(row.contract_name, row.payload_bytes, row.digest)
        for content in plan.content:
            identity = record["storageRef"] if content.digest == record["contentHash"] else "blob-" + content.digest
            self.artifacts.stage(artifact_id=identity, content=content.data, content_type=content.media_type)
        for row in plan.records:
            identity = "record-" + row.digest
            self.artifacts.stage(artifact_id=identity, content=row.payload_bytes,
                                 content_type="application/json", canonical_digest=row.digest)
        return self.artifacts.publish_record(contract_name="DatasetManifest", artifact_id=record["datasetId"],
            content=plan.manifest.payload_bytes, digest=plan.manifest.digest)
