"""Mounted exact thesis-chain adapter; no review, head or execution writes.

Existing sleeve recipe/research-run integration contract:
* Operations/roles are OPERATION_ROLES below. Keep the existing closed sleeve
  job, source envelopes, 64 original pins, 16MB input budget and admission.
* Parameters are COMMON_PARAMETERS plus maximum_feature_age_seconds for
  fundamental-review-thesis, or candidate for fundamental-revise-thesis.
* head_profile is an {artifactId, sha256} reference to the SINGLE selected
  tool-config/WorkerThesisHeadProfile@1.0.0 artifact. "research-policy" names
  this profile's meaning, NOT a new RuntimePolicySelection role. The existing
  policySelection RPC must materialize the exact CURRENT job-owned selection.
  Job ownership may survive drain: this is NOT the globally newest thesis.
* Profile and original revision shapes are the closed *_FIELDS constants.
  chain entries are {revision, previous_revision, parent_content, source,
  reviewer_id, reviewed_at, review_record_sha256}. source is {review: the exact
  eight-field WorkerReviewPin, content: {artifactId, sha256}}. parent_content
  is null at genesis, otherwise the exact preceding original content ref.
  genesis_content/head_content bind the first/last original content refs.
* Original revisions have author_id/authored_at, NEVER self-asserted acceptance.
  evidence_refs are {evidence_id, record: {artifactId, sha256}, content: same}.
  Each refers to an already-loaded, separately reviewed opaque dependency.
  Rule rows are all native Rule fields plus unit. Features preserve that unit.
* thesis_observations payload is {instrument_id, thesis_id, head_content,
  features: [{feature: all FeatureObservation fields, source_hash, unit}],
  material_events: [{event_id, observed_at, available_at, source_id, source_hash}]}.
  These are source-reported research observations, NOT authoritative events.
* candidate is {proposed_at, text, evidence_refs, invalidation_rules}. Its author
  is explicitly the requesting principal, not a reviewer. Native revise_thesis
  requires accepted_at/reviewer_id, so it is ONLY called for genuinely reviewed
  historical chain links, never to fabricate candidate acceptance.
* After _Inputs loads every source: decode_thesis_research(policy, op, params),
  admit, refresh_thesis_research(policy, decoded), compute_thesis_research(decoded).
  Project the returned dataclasses with the existing exact _projection. Before
  publication refresh again, pass ALL original policy.sources review pins, and
  preserve source lineage. Always publish derived/unreviewed/untrusted evidence.
* REQUIRED server integration: publishArtifact's finalChecks must re-materialize
  the exact lease selection at transaction-final time, as well as its existing
  latest-review/rights/source checks. An earlier policySelection RPC cannot
  substitute for this. Do not mount this adapter until that check is in place.

No selected policy, accepted review, configuration activation, portfolio, risk
capacity, source data, database, endpoint or live authority is created here.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from strategies.core import FeatureObservation, ResearchDecision, Rule
from strategies.fundamental import (Dossier, FinancialFact, ThesisRevision, ValuationAssumptions,
                                    build_dossier, review_thesis, revise_thesis)


OPERATION_ROLES = {
    "fundamental-build-dossier": (frozenset({"facts", "assumptions"}), frozenset()),
    "fundamental-review-thesis": (frozenset({"facts", "assumptions", "thesis_observations"}), frozenset()),
    "fundamental-revise-thesis": (frozenset({"facts", "assumptions"}), frozenset()),
}
COMMON_PARAMETERS = {"instrument_id", "thesis_id", "head_profile", "instrument_kind", "currency",
                     "maximum_fact_age_days"}
PROFILE_FIELDS = {"profile", "basis", "account_alias", "environment", "collection_id", "snapshot_id",
                  "module_id", "task_contract", "instrument_id", "thesis_id", "genesis_content",
                  "head_revision", "head_content", "chain"}
CHAIN_FIELDS = {"revision", "previous_revision", "parent_content", "source", "reviewer_id",
                "reviewed_at", "review_record_sha256"}
REVISION_FIELDS = {"profile", "instrument_id", "thesis_id", "revision", "previous_revision",
                   "parent_content", "author_id", "authored_at", "text", "evidence_refs", "invalidation_rules"}
RULE_FIELDS = {"rule_id", "feature_id", "operator", "threshold", "lookback_bars", "unit"}
CANDIDATE_FIELDS = {"proposed_at", "text", "evidence_refs", "invalidation_rules"}
MAX_CHAIN = 32
MAX_RULES = 64
MAX_FEATURES = 256


@dataclass(frozen=True)
class OriginalThesisInput:
    role: str | None
    collection_id: str
    evidence_id: str
    artifact_id: str
    artifact_sha256: str
    review_id: str
    review_version: str
    rights_policy_id: str
    rights_version: str
    content_artifact_id: str
    content_sha256: str
    review_record_sha256: str
    reviewer_id: str
    reviewed_at: datetime
    review_expires_at: datetime


@dataclass(frozen=True)
class ThesisHeadSelection:
    selection_id: str
    selection_sha256: str
    profile_artifact_id: str
    profile_sha256: str
    instrument_id: str
    thesis_id: str
    head_revision: int
    head_content_artifact_id: str
    head_content_sha256: str
    basis: str = "job-selected-research-policy-head"
    global_latest_verified: bool = False


@dataclass(frozen=True)
class ThesisRevisionProvenance:
    revision: int
    previous_revision: int | None
    source: OriginalThesisInput
    parent_content_artifact_id: str | None
    parent_content_sha256: str | None
    author_id: str
    authored_at: datetime
    rule_units: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class UnreviewedThesisCandidate:
    instrument_id: str
    thesis_id: str
    revision: int
    previous_revision: int
    parent_content_artifact_id: str
    parent_content_sha256: str
    author_id: str
    proposed_at: datetime
    text: str
    evidence_ids: tuple[str, ...]
    invalidation_rules: tuple[Rule, ...]
    rule_units: tuple[tuple[str, str], ...]
    acceptance_status: str = "unreviewed"
    selected_head_updated: bool = False
    execution_authorized: bool = False


@dataclass(frozen=True)
class DecodedThesisResearch:
    operation: str
    selection: ThesisHeadSelection
    as_of: datetime
    facts: tuple[FinancialFact, ...]
    revisions: tuple[ThesisRevision, ...]
    scenarios: tuple[ValuationAssumptions, ...]
    instrument_kind: str
    currency: str
    maximum_fact_age_days: int
    revision_provenance: tuple[ThesisRevisionProvenance, ...]
    input_pins: tuple[OriginalThesisInput, ...]
    features: tuple[FeatureObservation, ...]
    maximum_feature_age_seconds: int | None
    material_event_ids: tuple[str, ...]
    candidate: UnreviewedThesisCandidate | None


@dataclass(frozen=True)
class ThesisResearchResult:
    operation: str
    selection: ThesisHeadSelection
    dossier: Dossier
    decision: ResearchDecision | None
    candidate: UnreviewedThesisCandidate | None
    revision_provenance: tuple[ThesisRevisionProvenance, ...]
    input_pins: tuple[OriginalThesisInput, ...]
    acceptance_status: str = "unreviewed"
    proposal_only: bool = True
    selected_head_updated: bool = False
    execution_authorized: bool = False
    portfolio_capacity_verified: bool = False

    @property
    def status(self) -> str:
        if self.dossier.missing or (self.decision is not None and self.decision.status == "unavailable"):
            return "unavailable"
        return "research"


def _reference(job: Any, value: Any) -> dict[str, str]:
    from .sleeve_research import _digest, _identifier, _record
    row = _record(value, {"artifactId", "sha256"})
    _identifier(job, row["artifactId"])
    _digest(row["sha256"])
    return row


def _selection(job: Any) -> dict[str, Any]:
    """Current for this job's immutable ownership pin; not global current head."""
    from vertex_control.client import ControlError
    from .sleeve_research import _fail
    job.check()
    try:
        current = job.control.artifacts.call("policySelection", selectionId=job.lease["policySelectionId"],
                                             selectionSha256=job.lease["policySelectionSha256"])
        if (current != job.selection or current["selectionId"] != job.lease["policySelectionId"]
                or current["selectionSha256"] != job.lease["policySelectionSha256"]
                or current["accountAlias"] != job.lease["accountAlias"]
                or current["environment"] != job.lease["environment"]
                or not job.context.contracts.epoch_ns(current["issuedAt"]) <= job.clock.now_ns()
                < job.context.contracts.epoch_ns(current["expiresAt"])):
            _fail("thesis-selected-configuration-mismatch")
        return current
    except ControlError:
        _fail("thesis-selected-configuration-unavailable")


def _profile(policy: Any, reference: Any) -> tuple[dict[str, Any], dict[str, str]]:
    from vertex_control.adapters import decode_content
    from vertex_control.client import ControlError
    from .sleeve_research import _canonical, _fail, _record
    job = policy.job
    ref = _reference(job, reference)
    selection = _selection(job)
    bindings = [item for item in selection["artifacts"]
                if item["artifact"]["contractName"] == "WorkerThesisHeadProfile"]
    if (len(bindings) != 1 or bindings[0]["role"] != "tool-config"
            or bindings[0]["artifact"]["schemaVersion"] != "1.0.0"
            or bindings[0]["artifact"]["artifactId"] != ref["artifactId"]
            or bindings[0]["artifact"]["artifactSha256"] != ref["sha256"]
            or len([item for item in selection["artifacts"]
                    if item["artifact"]["artifactId"] == ref["artifactId"]]) != 1
            or ref["artifactId"] == policy.recipe["publication"]["evidenceId"]
            or any(ref["artifactId"] in (source.pin["artifactId"], source.reference["artifactId"])
                   for source in policy.sources)):
        _fail("thesis-selected-head-profile-unavailable")
    # Selected private configuration is scope-level (null collection), unlike
    # evidence. ArtifactAdapter.read defaults None to the job's collection, so
    # use the existing fenced primitive only after exact selected membership.
    try:
        receipt = job.control.artifacts.call("readArtifact", collectionId=None, artifactId=ref["artifactId"])
        if (receipt["artifact"] != {"artifactId": ref["artifactId"], "artifactSha256": ref["sha256"]}
                or receipt["contentSha256"] != ref["sha256"] or receipt["canonicalSha256"] != ref["sha256"]
                or receipt["contentType"] != "application/json"):
            _fail("thesis-head-profile-reference-mismatch")
        original = decode_content(receipt["contentBase64"], ref["sha256"])
    except ControlError:
        _fail("thesis-head-profile-original-unavailable")
    if not original or job.input_bytes + len(original) > 16_000_000:
        _fail("thesis-head-profile-aggregate-byte-budget")
    job.input_bytes += len(original)
    profile = _record(_canonical(job, original), PROFILE_FIELDS)
    if (profile["profile"] != "vertex-thesis-head-policy-v1"
            or profile["basis"] != "job-selected-research-policy-head"
            or profile["account_alias"] != job.lease["accountAlias"]
            or profile["environment"] != job.lease["environment"]
            or any(profile[key] != policy.recipe[key]
                   for key in ("collection_id", "snapshot_id", "module_id", "task_contract"))
            or not any(module["moduleId"] == profile["module_id"] and module["enabled"] is True
                       for module in selection["modules"])):
        _fail("thesis-head-profile-scope-mismatch")
    return profile, ref


def _reviews(policy: Any) -> tuple[OriginalThesisInput, ...]:
    """Return genuine author/time from current review records, never the reader."""
    from vertex_control.client import ControlError
    from .sleeve_research import MAX_PINS, REVIEW_FIELDS, _digest, _fail, _identifier, _instant, _record
    job, rights = policy.job, policy.job.control.rights
    if (not 1 <= len(policy.sources) <= MAX_PINS
            or (rights.context.fence["accountAlias"], rights.context.fence["environment"])
            != (job.lease["accountAlias"], job.lease["environment"])):
        _fail("thesis-original-source-scope-invalid")
    pins = []
    for source in policy.sources:
        pin = _record(source.pin, REVIEW_FIELDS)
        for key, value in pin.items():
            _digest(value) if key == "artifactSha256" else _identifier(job, value)
        _reference(job, source.reference)
        if (pin["collectionId"] != policy.recipe["collection_id"]
                or hashlib.sha256(source.evidence_bytes).hexdigest() != pin["artifactSha256"]):
            _fail("thesis-original-record-mismatch")
        job.check()
        try:
            receipt = rights.read_current_review_receipt(actor_id=job.lease["researchPrincipalId"],
                account_alias=job.lease["accountAlias"], environment=job.lease["environment"],
                collection_id=pin["collectionId"], snapshot_id=policy.recipe["snapshot_id"],
                evidence_id=pin["evidenceId"], artifact_digest=pin["artifactSha256"],
                original_bytes=source.evidence_bytes, purpose="research", reference_ns=job.clock.now_ns(),
                authorization=job.authorization, expected_pin=pin)
        except ControlError:
            _fail("thesis-current-exact-review-unavailable")
        evidence, review = source.evidence, receipt.review
        if (evidence["contentHash"] != source.reference["sha256"]
                or evidence["sourceIdentity"]["contentHash"] != source.reference["sha256"]
                or not _instant(job, evidence["capturedAt"]) <= _instant(job, review["reviewedAt"]) <= policy.as_of):
            _fail("thesis-review-provenance-not-point-in-time")
        pins.append(OriginalThesisInput(source.role, pin["collectionId"], pin["evidenceId"], pin["artifactId"],
            pin["artifactSha256"], pin["reviewId"], pin["reviewVersion"], pin["rightsPolicyId"], pin["rightsVersion"],
            source.reference["artifactId"], source.reference["sha256"], receipt.review_sha256,
            _identifier(job, review["actorId"]), _instant(job, review["reviewedAt"]), _instant(job, review["expiresAt"])))
    for key in ("evidence_id", "artifact_id", "content_artifact_id", "review_id"):
        if len({getattr(pin, key) for pin in pins}) != len(pins):
            _fail("thesis-reused-source-identity")
    if {pin.artifact_id for pin in pins} & {pin.content_artifact_id for pin in pins}:
        _fail("thesis-crossed-source-identity")
    return tuple(pins)


def _source(policy: Any, value: Any) -> Any:
    from .sleeve_research import REVIEW_FIELDS, _fail, _record
    row = _record(value, {"review", "content"})
    pin = _record(row["review"], REVIEW_FIELDS)
    ref = _reference(policy.job, row["content"])
    matches = [source for source in policy.sources if source.role is None
               and source.pin == pin and source.reference == ref]
    if len(matches) != 1:
        _fail("thesis-original-revision-dependency-unavailable")
    return matches[0]


def _citations(policy: Any, value: Any, at: datetime, forbidden: set[str]) -> tuple[str, ...]:
    from .sleeve_research import MAX_PINS, _fail, _identifier, _instant, _record
    if type(value) is not list or not 1 <= len(value) <= MAX_PINS:
        _fail("thesis-citation-budget")
    ids = []
    for raw in value:
        row = _record(raw, {"evidence_id", "record", "content"})
        evidence_id = _identifier(policy.job, row["evidence_id"])
        record, content = _reference(policy.job, row["record"]), _reference(policy.job, row["content"])
        matches = [source for source in policy.sources if source.role is None
                   and source.pin["evidenceId"] == evidence_id
                   and {"artifactId": source.pin["artifactId"], "sha256": source.pin["artifactSha256"]} == record
                   and source.reference == content]
        if (len(matches) != 1 or evidence_id in forbidden or evidence_id in ids
                or _instant(policy.job, matches[0].evidence["capturedAt"]) > at):
            _fail("thesis-citation-not-exact-or-known-at-authorship")
        ids.append(evidence_id)
    return tuple(ids)


def _rules(job: Any, value: Any) -> tuple[tuple[Rule, ...], tuple[tuple[str, str], ...]]:
    from .sleeve_research import _fail, _identifier, _native, _record
    if type(value) is not list or not 1 <= len(value) <= MAX_RULES:
        _fail("thesis-rule-budget")
    rules, units = [], {}
    for raw in value:
        row = _record(raw, RULE_FIELDS)
        unit = _identifier(job, row.pop("unit"))
        rule = _native(job, Rule, row, decimals=("threshold",), integers=("lookback_bars",))
        if rule.feature_id in units and units[rule.feature_id] != unit:
            _fail("thesis-feature-unit-conflict")
        rules.append(rule)
        units[rule.feature_id] = unit
    if len({rule.rule_id for rule in rules}) != len(rules):
        _fail("thesis-duplicate-rule")
    return tuple(rules), tuple(sorted(units.items()))


def _chain(policy: Any, profile: dict[str, Any], pins: tuple[OriginalThesisInput, ...]
           ) -> tuple[tuple[ThesisRevision, ...], tuple[ThesisRevisionProvenance, ...]]:
    from .sleeve_research import _canonical, _digest, _fail, _identifier, _instant, _integer, _record
    job, rows = policy.job, profile["chain"]
    if type(rows) is not list or not 1 <= len(rows) <= MAX_CHAIN:
        _fail("thesis-chain-budget")
    head_number = _integer(profile["head_revision"])
    if head_number != len(rows):
        _fail("thesis-chain-not-complete-from-genesis")
    genesis, head = _reference(job, profile["genesis_content"]), _reference(job, profile["head_content"])
    entries = [_record(row, CHAIN_FIELDS) for row in rows]
    sources = [_source(policy, row["source"]) for row in entries]
    chain_ids = {source.pin["evidenceId"] for source in sources}
    if (len(chain_ids) != len(rows) or len({source.reference["sha256"] for source in sources}) != len(rows)
            or sources[0].reference != genesis or sources[-1].reference != head):
        _fail("thesis-chain-reuse-or-head-mismatch")
    revisions, provenance = [], []
    for index, (entry, source) in enumerate(zip(entries, sources), 1):
        parent = None if index == 1 else sources[index - 2].reference
        previous = None if index == 1 else index - 1
        if (_integer(entry["revision"]) != index or entry["previous_revision"] != previous
                or (entry["previous_revision"] is not None and type(entry["previous_revision"]) is not int)
                or entry["parent_content"] != parent):
            _fail("thesis-chain-gap-or-parent-mismatch")
        original = job.artifact(source.reference, collection_id=policy.recipe["collection_id"])
        if hashlib.sha256(original).hexdigest() != source.reference["sha256"]:
            _fail("thesis-original-revision-hash-mismatch")
        raw = _record(_canonical(job, original), REVISION_FIELDS)
        if (raw["profile"] != "vertex-thesis-revision-v1" or raw["instrument_id"] != profile["instrument_id"]
                or raw["thesis_id"] != profile["thesis_id"] or _integer(raw["revision"]) != index
                or raw["previous_revision"] != previous
                or (raw["previous_revision"] is not None and type(raw["previous_revision"]) is not int)
                or raw["parent_content"] != parent):
            _fail("thesis-original-revision-identity-mismatch")
        pin = next(pin for pin in pins if pin.evidence_id == source.pin["evidenceId"])
        if (entry["reviewer_id"] != pin.reviewer_id or _instant(job, entry["reviewed_at"]) != pin.reviewed_at
                or _digest(entry["review_record_sha256"]) != pin.review_record_sha256):
            _fail("thesis-selected-review-provenance-mismatch")
        authored = _instant(job, raw["authored_at"])
        if (not authored <= _instant(job, source.evidence["capturedAt"]) <= pin.reviewed_at <= policy.as_of
                or (revisions and authored <= revisions[-1].accepted_at)):
            _fail("thesis-authorship-acceptance-order-invalid")
        if type(raw["text"]) is not str or not raw["text"].strip():
            _fail("thesis-text-required")
        evidence_ids = _citations(policy, raw["evidence_refs"], authored, chain_ids)
        rules, units = _rules(job, raw["invalidation_rules"])
        revision = ThesisRevision(profile["thesis_id"], index, previous, raw["text"], pin.reviewed_at,
                                  pin.reviewer_id, evidence_ids, rules)
        if revisions:
            revise_thesis(revisions[-1], revision)
        revisions.append(revision)
        provenance.append(ThesisRevisionProvenance(index, previous, pin,
            None if parent is None else parent["artifactId"], None if parent is None else parent["sha256"],
            _identifier(job, raw["author_id"]), authored, units))
    return tuple(revisions), tuple(provenance)


def _observations(policy: Any, selection: ThesisHeadSelection, head: ThesisRevision,
                  units: tuple[tuple[str, str], ...]) -> tuple[tuple[FeatureObservation, ...], tuple[str, ...]]:
    from .sleeve_research import _digest, _fail, _identifier, _instant, _native, _projection, _record
    job = policy.job
    row = _record(policy.source("thesis_observations").payload,
                  {"instrument_id", "thesis_id", "head_content", "features", "material_events"})
    if (row["instrument_id"] != selection.instrument_id or row["thesis_id"] != selection.thesis_id
            or _reference(job, row["head_content"]) != {"artifactId": selection.head_content_artifact_id,
                                                       "sha256": selection.head_content_sha256}
            or type(row["features"]) is not list or len(row["features"]) > MAX_FEATURES
            or type(row["material_events"]) is not list or len(row["material_events"]) > MAX_RULES
            or not row["features"] and not row["material_events"]):
        _fail("thesis-observation-identity-or-budget-invalid")
    features, events, observed_times = [], [], []
    expected_units = dict(units)
    for value in row["features"]:
        raw = _record(value, {"feature", "source_hash", "unit"})
        feature = _native(job, FeatureObservation, raw["feature"], optional_decimals=("value",),
                          times=("observed_at", "available_at"), integers=("completed_bars",))
        if (expected_units.get(feature.feature_id) != _identifier(job, raw["unit"])
                or not feature.observed_at <= feature.available_at <= policy.as_of):
            _fail("thesis-feature-unit-or-time-mismatch")
        policy.provenance(feature.source_id, _digest(raw["source_hash"]), feature.available_at,
                          role="thesis_observations")
        features.append(feature)
        observed_times.append(feature.observed_at)
    for value in row["material_events"]:
        raw = _record(value, {"event_id", "observed_at", "available_at", "source_id", "source_hash"})
        observed, available = _instant(job, raw["observed_at"]), _instant(job, raw["available_at"])
        if (not observed <= available <= policy.as_of or available <= head.accepted_at
                or policy.as_of_ns - int(_projection(observed)) > policy.maximum_age_ns):
            _fail("thesis-material-event-not-new-or-point-in-time")
        policy.provenance(_identifier(job, raw["source_id"]), _digest(raw["source_hash"]), available,
                          role="thesis_observations")
        events.append(_identifier(job, raw["event_id"]))
        observed_times.append(observed)
    if len({feature.feature_id for feature in features}) != len(features) or len(set(events)) != len(events):
        _fail("thesis-duplicate-observation")
    policy.observation("thesis_observations", tuple(observed_times))
    return tuple(features), tuple(events)


def decode_thesis_research(policy: Any, operation: str, parameters: Any) -> DecodedThesisResearch:
    from .sleeve_research import _bounded_tree, _decode_inputs, _fail, _identifier, _instant, _integer, _record
    if type(operation) is not str or operation not in OPERATION_ROLES:
        _fail("thesis-operation-unavailable")
    extra = ({"maximum_feature_age_seconds"} if operation == "fundamental-review-thesis"
             else {"candidate"} if operation == "fundamental-revise-thesis" else set())
    params = _record(parameters, COMMON_PARAMETERS | extra)
    _bounded_tree(params)
    job = policy.job
    for key in ("instrument_id", "thesis_id"):
        _identifier(job, params[key])
    roles = [source.role for source in policy.sources if source.role is not None]
    required, _ = OPERATION_ROLES[operation]
    if (set(roles) != required or len(roles) != len(required) or policy.as_of_ns > job.clock.now_ns()
            or policy.recipe["operation"] != operation):
        _fail("thesis-source-roles-or-cutoff-mismatch")
    profile, reference = _profile(policy, params["head_profile"])
    if profile["instrument_id"] != params["instrument_id"] or profile["thesis_id"] != params["thesis_id"]:
        _fail("thesis-selected-head-identity-mismatch")
    pins = _reviews(policy)
    revisions, provenance = _chain(policy, profile, pins)
    native, valuation = _decode_inputs(policy, "fundamental-value-equity",
        {key: params[key] for key in ("instrument_id", "instrument_kind", "currency", "maximum_fact_age_days")})
    selection = ThesisHeadSelection(job.lease["policySelectionId"], job.lease["policySelectionSha256"],
        reference["artifactId"], reference["sha256"], profile["instrument_id"], profile["thesis_id"],
        revisions[-1].revision, profile["head_content"]["artifactId"], profile["head_content"]["sha256"])
    features, events, age, candidate = (), (), None, None
    if operation == "fundamental-review-thesis":
        age = _integer(params["maximum_feature_age_seconds"])
        if age > 31_536_000:
            _fail("thesis-feature-freshness-policy-invalid")
        features, events = _observations(policy, selection, revisions[-1], provenance[-1].rule_units)
    if operation == "fundamental-revise-thesis":
        raw = _record(params["candidate"], CANDIDATE_FIELDS)
        proposed = _instant(job, raw["proposed_at"])
        if (not revisions[-1].accepted_at < proposed <= policy.as_of or type(raw["text"]) is not str
                or not raw["text"].strip()):
            _fail("thesis-candidate-time-or-text-invalid")
        ids = _citations(policy, raw["evidence_refs"], proposed, {item.source.evidence_id for item in provenance})
        rules, units = _rules(job, raw["invalidation_rules"])
        if (raw["text"], ids, rules, units) == (revisions[-1].text, revisions[-1].evidence_ids,
                                              revisions[-1].invalidation_rules, provenance[-1].rule_units):
            _fail("thesis-no-op-candidate")
        candidate = UnreviewedThesisCandidate(selection.instrument_id, selection.thesis_id,
            selection.head_revision + 1, selection.head_revision, selection.head_content_artifact_id,
            selection.head_content_sha256, _identifier(job, job.lease["researchPrincipalId"]), proposed,
            raw["text"], ids, rules, units)
    return DecodedThesisResearch(operation, selection, policy.as_of, native["facts"], revisions,
        (native["assumptions"],), valuation["instrument_kind"], valuation["currency"],
        valuation["maximum_fact_age_days"], provenance, pins, features, age, events, candidate)


def refresh_thesis_research(policy: Any, inputs: DecodedThesisResearch) -> None:
    """Precompute/prepublish guard; server transaction-final guards remain required."""
    from .sleeve_research import _fail
    selection = _selection(policy.job)
    if (selection["selectionId"] != inputs.selection.selection_id
            or selection["selectionSha256"] != inputs.selection.selection_sha256
            or _reviews(policy) != inputs.input_pins):
        _fail("thesis-selected-head-or-original-review-changed")


def compute_thesis_research(inputs: DecodedThesisResearch) -> ThesisResearchResult:
    """Deterministic existing computations; returns advice, never an AcceptedReview."""
    dossier = build_dossier(instrument_id=inputs.selection.instrument_id, as_of=inputs.as_of,
        facts=inputs.facts, revisions=inputs.revisions, scenarios=inputs.scenarios,
        instrument_kind=inputs.instrument_kind, currency=inputs.currency,
        maximum_fact_age_days=inputs.maximum_fact_age_days)
    decision = None
    if inputs.operation == "fundamental-review-thesis":
        decision = review_thesis(dossier, {feature.feature_id: feature for feature in inputs.features},
            as_of=inputs.as_of, maximum_feature_age_seconds=inputs.maximum_feature_age_seconds,
            material_event_ids=inputs.material_event_ids)
    return ThesisResearchResult(inputs.operation, inputs.selection, dossier, decision, inputs.candidate,
                                inputs.revision_provenance, inputs.input_pins)
