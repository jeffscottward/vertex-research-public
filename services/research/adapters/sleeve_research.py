"""Exact reviewed sleeve inputs -> pure computation -> unreviewed evidence.

Private integration contract (not a new public artifact or execution API):
WorkerSleeveRecipe / vertex-sleeve-recipe-v1 uses RECIPE_FIELDS below;
vertex-sleeve-research-v1 uses JOB_FIELDS. Select the recipe as an exact
WorkerSleeveRecipe@1.0.0 tool-config before constructing the existing _Job
with recipe collection_id/snapshot_id. Call run_sleeve_research(job, payload).
Mounted by the existing research-run handler and selected private recipe builder;
this module itself creates no policy selection, provider or execution authority.

Each input is {role, review, content}; each dependency is {review, content}.
review is the existing eight-field WorkerReviewPin; content is an original
{artifactId, sha256} reference. ResearchEvidence must bind both original
content hashes. Inputs contain canonical vertex-sleeve-input-v1 envelopes
with INPUT_FIELDS and the exact operation-specific payload described by
_decode_inputs. Dependencies are original opaque artifacts, not aliases.
Every financial/macro source_id+source_hash and every bar source_id resolves
to these separately reviewed dependencies. No inferred units or timestamps.

Supported operations are exactly OPERATION_ROLES. Wheel state is only a
source-supplied research state: no live position, event reconciliation,
assignment, collateral readiness, capital allocation or execution claim.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from strategies.core import exact, public_decimal
from strategies.fundamental import FinancialFact, ValuationAssumptions, value_equity
from strategies.macro import MacroAxis, MacroVintage, classify_regime
from strategies.publication import encode_authoritatively
from strategies.swing import (Bar, RegimeObservation, SessionStudyEvidence, SessionWindow, SwingPolicy,
                              completed_bars, dual_zone_review, momentum, session_breakout, swing_decision)
from strategies.wheel import ShortOption, WheelContract, WheelState, obligations

from .ports import AdapterUnavailable
from .thesis_research import OPERATION_ROLES as THESIS_OPERATION_ROLES

JOB_FIELDS = {"profile", "recipe", "recipeArtifactId", "recipeSha256", "run_id", "trace_id",
              "actor_id", "task_contract", "account_alias", "environment", "input_evidence_ids"}
RECIPE_FIELDS = {"profile", "module_id", "task_contract", "collection_id", "snapshot_id", "as_of",
                 "max_input_age_ns", "operation", "parameters", "inputs", "dependencies", "publication"}
INPUT_FIELDS = {"profile", "role", "collection_id", "snapshot_id", "observed_at", "available_at", "payload"}
REVIEW_FIELDS = {"collectionId", "evidenceId", "artifactId", "artifactSha256", "reviewId",
                 "reviewVersion", "rightsPolicyId", "rightsVersion"}
PUBLICATION_FIELDS = {"evidenceId", "collectionId", "snapshotId", "sourceUri", "sourceIdentity",
                      "sourceLocator", "attribution", "publishedAt", "capturedAt", "claim", "limitations", "rightsPolicyId"}
OPERATION_ROLES = {
    "fundamental-value-equity": ({"facts", "assumptions"}, set()),
    "swing-momentum": ({"bars"}, {"benchmark_bars"}),
    "swing-decision": ({"bars", "regime"}, {"benchmark_bars"}),
    "swing-dual-zone-review": ({"bars"}, {"benchmark_bars"}),
    "swing-session-breakout": ({"bars", "session", "study"}, set()),
    "macro-classify-regime": ({"macro_vintages"}, set()),
    "macro-hmm-forward-v1": ({"hmm_features", "hmm_model", "hmm_scaler"}, set()),
    "macro-jump-state-v1": ({"jump_features", "jump_model", "jump_scaler"}, set()),
    "macro-regime-composite-envelope-v1": ({"composite_hmm_binding", "composite_jump_binding"}, set()),
    "wheel-obligations": ({"wheel_state"}, set()),
    "wheel-early-exercise-review": ({"wheel_state", "exercise_quotes"}, {"dividend_calendar"}),
    **THESIS_OPERATION_ROLES,
}
MAX_ROWS = 4096
MAX_TOTAL_ROWS = 8192
MAX_PINS = 64
MAX_AGE_NS = 31_536_000_000_000_000
# Numerical research operations publish their own limitations and encoding; the
# method text names the numerical kind. HMM output text is byte-identical.
NUMERICAL_METHODS = {
    "macro-hmm-forward-v1": "; binary64 diagonal Gaussian causal forward filter",
    "macro-jump-state-v1": "; fixed-centroid trailing-window jump DP hard assignment, not probability",
    "macro-regime-composite-envelope-v1": "; implemented-components (HMM, JM) agreement envelope, not an average, vote or probability",
}
LIMITATIONS = (
    "Advisory research only; generated evidence is unreviewed and untrusted.",
    "Source review is not verified live holdings, assignment, collateral or execution authority.",
    "No portfolio sizing, cash reservation, broker events, fills or settlement are produced.",
    "Point-in-time results use only explicit original source times, units and pinned assumptions.",
)


def _fail(reason: str) -> None:
    raise AdapterUnavailable("sleeve-" + reason)


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        _fail("closed-shape-invalid")
    return dict(value)


def _identifier(job: Any, value: Any) -> str:
    if job.context.contracts.validate("Identifier", value, "1.0.0") is not True:
        _fail("identity-invalid")
    return value


def _digest(value: Any) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        _fail("digest-invalid")
    return value


def _bounded_tree(value: Any) -> None:
    pending = [(value, 0)]
    nodes = 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if nodes > 100_000 or depth > 20:
            _fail("tree-budget")
        if type(item) is dict:
            if len(item) > 64 or any(type(key) is not str or len(key) > 160 for key in item):
                _fail("object-budget")
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            if len(item) > MAX_ROWS:
                _fail("list-budget")
            pending.extend((child, depth + 1) for child in item)
        elif type(item) is str:
            if len(item) > 4096 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]", item):
                _fail("text-budget")
        elif item is None or type(item) is bool:
            continue
        elif type(item) is int and abs(item) <= 9_007_199_254_740_991:
            continue
        else:
            _fail("exact-json-required")


def _canonical(job: Any, content: bytes) -> dict[str, Any]:
    if type(content) is not bytes or not 0 < len(content) <= 1_048_576:
        _fail("source-byte-budget")
    value = json.loads(content)
    _bounded_tree(value)
    if type(value) is not dict or job.context.contracts.encode(value) != content:
        _fail("canonical-original-required")
    return value


def _instant(job: Any, value: Any) -> datetime:
    ns = job.context.contracts.epoch_ns(value)
    if ns % 1000:
        _fail("nanosecond-source-not-representable")
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ns // 1000)


def _decimal(value: Any) -> Decimal:
    if type(value) is not str or len(value) > 123:
        _fail("decimal-text-required")
    return exact(value)


def _integer(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
        _fail("nonnegative-integer-required")
    return value


def _native(job: Any, kind: Any, value: Any, *, decimals: tuple[str, ...] = (),
            times: tuple[str, ...] = (), integers: tuple[str, ...] = (),
            optional_decimals: tuple[str, ...] = ()) -> Any:
    row = _record(value, {field.name for field in fields(kind)})
    for key in decimals:
        row[key] = _decimal(row[key])
    for key in optional_decimals:
        row[key] = None if row[key] is None else _decimal(row[key])
    for key in times:
        row[key] = _instant(job, row[key])
    for key in integers:
        row[key] = _integer(row[key])
    return kind(**row)


def _projection(value: Any, depth: int = 0) -> Any:
    if depth > 20:
        _fail("projection-depth")
    if isinstance(value, Decimal):
        # Never silently round a native exact result into the public v1 domain.
        return public_decimal(value)
    if isinstance(value, datetime):
        delta = value.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return str((delta.days * 86_400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000)
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: _projection(getattr(value, field.name), depth + 1) for field in fields(value)}
    if isinstance(value, (tuple, list)):
        return [_projection(item, depth + 1) for item in value]
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is int and abs(value) <= 9_007_199_254_740_991:
        return value
    _fail("projection-type-unavailable")


@dataclass(frozen=True)
class _ReviewedSource:
    role: str | None
    pin: dict[str, Any]
    reference: dict[str, str]
    evidence: dict[str, Any]
    evidence_bytes: bytes
    payload: dict[str, Any] | None
    observed_ns: int | None
    available_ns: int | None


class _Inputs:
    def __init__(self, job: Any, recipe: dict[str, Any]):
        self.job, self.recipe = job, recipe
        self.sources: list[_ReviewedSource] = []
        self.as_of_ns = job.context.contracts.epoch_ns(recipe["as_of"])
        self.as_of = _instant(job, recipe["as_of"])
        age = recipe["max_input_age_ns"]
        if type(age) is not str or re.fullmatch(r"[1-9][0-9]{0,16}", age) is None or int(age) > MAX_AGE_NS:
            _fail("freshness-policy-invalid")
        self.maximum_age_ns = int(age)
        self.rows = 0

    def refresh(self) -> None:
        for source in self.sources:
            self.review(source.pin, source.evidence_bytes)

    def review(self, pin: dict[str, Any], original: bytes) -> None:
        from vertex_control.client import ControlError
        self.job.check()
        rights = self.job.control.rights
        if (rights.context.fence["accountAlias"], rights.context.fence["environment"]) != (
                self.job.lease["accountAlias"], self.job.lease["environment"]):
            _fail("current-review-fence-mismatch")
        try:
            # Preserve generic reviewVersion strings and the genuine reviewer;
            # do not use the agent-only consuming-principal projection.
            rights.read_current_review_receipt(actor_id=self.job.lease["researchPrincipalId"],
                account_alias=self.job.lease["accountAlias"], environment=self.job.lease["environment"],
                collection_id=self.recipe["collection_id"], snapshot_id=self.recipe["snapshot_id"],
                evidence_id=pin["evidenceId"], artifact_digest=pin["artifactSha256"],
                original_bytes=original, purpose="research", reference_ns=self.job.clock.now_ns(),
                authorization=self.job.authorization, expected_pin=pin)
        except ControlError:
            _fail("current-exact-review-unavailable")

    def load(self, value: Any, *, input_role: bool) -> None:
        row = _record(value, {"role", "review", "content"} if input_role else {"review", "content"})
        pin = _record(row["review"], REVIEW_FIELDS)
        for key, item in pin.items():
            _digest(item) if key == "artifactSha256" else _identifier(self.job, item)
        reference = _record(row["content"], {"artifactId", "sha256"})
        _identifier(self.job, reference["artifactId"])
        _digest(reference["sha256"])
        if pin["collectionId"] != self.recipe["collection_id"]:
            _fail("source-scope-mismatch")
        original = self.job.artifact({"artifactId": pin["artifactId"], "sha256": pin["artifactSha256"]},
                                     collection_id=pin["collectionId"])
        if hashlib.sha256(original).hexdigest() != pin["artifactSha256"]:
            _fail("original-record-digest-mismatch")
        evidence = _canonical(self.job, original)
        if (self.job.context.contracts.validate("ResearchEvidence", evidence, "1.0.0") is not True
                or evidence["evidenceId"] != pin["evidenceId"] or evidence["collectionId"] != pin["collectionId"]
                or evidence["snapshotId"] != self.recipe["snapshot_id"]
                or evidence["rightsPolicyId"] != pin["rightsPolicyId"]
                or evidence["contentHash"] != reference["sha256"]
                or evidence["sourceIdentity"]["contentHash"] != reference["sha256"]):
            _fail("reviewed-content-binding-mismatch")
        captured = self.job.context.contracts.epoch_ns(evidence["capturedAt"])
        if captured > self.as_of_ns or (evidence["publishedAt"] is not None
                and self.job.context.contracts.epoch_ns(evidence["publishedAt"]) > captured):
            _fail("source-not-point-in-time")
        self.review(pin, original)
        content = self.job.artifact(reference, collection_id=pin["collectionId"])
        if not content or hashlib.sha256(content).hexdigest() != reference["sha256"]:
            _fail("original-content-digest-mismatch")
        payload, observed, available = None, None, None
        if input_role:
            binding = _record(_canonical(self.job, content), INPUT_FIELDS)
            if (binding["profile"] != "vertex-sleeve-input-v1" or binding["role"] != row["role"]
                    or binding["collection_id"] != pin["collectionId"]
                    or binding["snapshot_id"] != self.recipe["snapshot_id"]):
                _fail("input-profile-binding-mismatch")
            observed = self.job.context.contracts.epoch_ns(binding["observed_at"])
            available = self.job.context.contracts.epoch_ns(binding["available_at"])
            _instant(self.job, binding["observed_at"])
            _instant(self.job, binding["available_at"])
            if not observed <= available <= captured <= self.as_of_ns or self.as_of_ns - observed > self.maximum_age_ns:
                _fail("input-not-point-in-time-qualified")
            if type(binding["payload"]) is not dict:
                _fail("input-payload-invalid")
            payload = binding["payload"]
        self.sources.append(_ReviewedSource(row.get("role"), pin, reference, evidence, original,
                                            payload, observed, available))

    def source(self, role: str) -> _ReviewedSource:
        return next(source for source in self.sources if source.role == role)

    def sequence(self, role: str, key: str) -> list[Any]:
        payload = _record(self.source(role).payload, {key})
        rows = payload[key]
        if type(rows) is not list or not 1 <= len(rows) <= MAX_ROWS:
            _fail("row-budget")
        self.rows += len(rows)
        if self.rows > MAX_TOTAL_ROWS:
            _fail("aggregate-row-budget")
        return rows

    def provenance(self, source_id: str, source_hash: str | None, available_at: datetime,
                   *, role: str) -> None:
        matches = [source for source in self.sources if source.role is None
                   and source.evidence["sourceIdentity"]["sourceId"] == source_id
                   and (source_hash is None or source.reference["sha256"] == source_hash)]
        if len(matches) != 1:
            _fail("original-provenance-unavailable")
        origin = matches[0]
        captured = _instant(self.job, origin.evidence["capturedAt"])
        envelope = self.source(role)
        envelope_time = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=envelope.available_ns // 1000)
        if not captured <= available_at <= envelope_time <= self.as_of:
            _fail("row-availability-not-source-bound")

    def observation(self, role: str, values: tuple[datetime, ...]) -> None:
        # Envelope freshness cannot be made newer than the actual source rows.
        if not values or int(_projection(max(values))) != self.source(role).observed_ns:
            _fail("observation-not-row-bound")


def _decode_swing(policy: _Inputs, operation: str, parameters: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Regime payload={observation: RegimeObservation}; study payload contains
    every SessionStudyEvidence field. Session payload={session: SessionWindow,
    source_id, source_hash, observed_at, available_at}; no calendar inference.
    Held protective orders/positions are deliberately not part of this profile.
    """
    job = policy.job
    if operation == "swing-session-breakout":
        params = _record(parameters, {"minimum_relative_volume"})
        params["minimum_relative_volume"] = _decimal(params["minimum_relative_volume"])
    else:
        extra = {"policy"} if operation == "swing-decision" else {"volume_trigger"} if operation == "swing-dual-zone-review" else set()
        params = _record(parameters, {"instrument_id", "benchmark_id"} | extra)
        _identifier(job, params["instrument_id"])
        if params["benchmark_id"] is not None:
            _identifier(job, params["benchmark_id"])
            if params["benchmark_id"] == params["instrument_id"]:
                _fail("benchmark-instrument-must-differ")
    roles = {source.role for source in policy.sources}
    if operation != "swing-session-breakout" and (params["benchmark_id"] is None) != ("benchmark_bars" not in roles):
        _fail("benchmark-role-mismatch")
    sources = {}
    for role in ("bars", "benchmark_bars"):
        if role not in roles:
            continue
        bars = tuple(_native(job, Bar, row, decimals=("open", "high", "low", "close"),
            optional_decimals=("volume",), times=("start_at", "end_at", "available_at"))
            for row in policy.sequence(role, "bars"))
        for bar in bars:
            policy.provenance(bar.source_id, None, bar.available_at, role=role)
        if any(bar.complete is not True for bar in bars):
            _fail("completed-bars-required")
        policy.observation(role, tuple(bar.end_at for bar in bars))
        sources[role] = bars
    if operation == "swing-decision":
        raw = _record(params["policy"], {field.name for field in fields(SwingPolicy)})
        regimes = raw["allowed_regimes"]
        if type(regimes) is not list or not 1 <= len(regimes) <= 64:
            _fail("regime-policy-invalid")
        for regime_id in regimes:
            _identifier(job, regime_id)
        if len(set(regimes)) != len(regimes):
            _fail("regime-policy-duplicates")
        raw["allowed_regimes"] = tuple(regimes)
        params["policy"] = _native(job, SwingPolicy, raw, integers=("maximum_age_seconds",),
            decimals=("minimum_relative_strength", "minimum_relative_volume", "maximum_atr_fraction",
                      "stop_atr_multiple", "target_risk_multiple", "tick_size"))
        observation = _record(policy.source("regime").payload, {"observation"})["observation"]
        regime = _native(job, RegimeObservation, observation, times=("observed_at", "available_at"))
        policy.provenance(regime.source_id, None, regime.available_at, role="regime")
        policy.observation("regime", (regime.observed_at,))
        sources["regime"] = regime
    elif operation == "swing-dual-zone-review":
        params["volume_trigger"] = _decimal(params["volume_trigger"])
    elif operation == "swing-session-breakout":
        raw = _record(policy.source("session").payload,
                      {"session", "source_id", "source_hash", "observed_at", "available_at"})
        session = _native(job, SessionWindow, raw["session"], integers=("bar_seconds",),
            times=("open_at", "opening_range_end_at", "entry_cutoff_at", "close_at"))
        if session.bar_seconds > 86_400 or session.close_at - session.open_at > timedelta(days=1):
            _fail("session-window-budget")
        observed, available = _instant(job, raw["observed_at"]), _instant(job, raw["available_at"])
        if observed > available:
            _fail("session-clock-order-invalid")
        policy.provenance(_identifier(job, raw["source_id"]), _digest(raw["source_hash"]), available, role="session")
        policy.observation("session", (observed,))
        study = _record(policy.source("study").payload, {field.name for field in fields(SessionStudyEvidence)})
        receipts = study["source_receipts"]
        if type(receipts) is not list or not 1 <= len(receipts) <= MAX_PINS:
            _fail("study-receipt-budget")
        for receipt in receipts:
            _digest(receipt)
        dependency_hashes = {source.reference["sha256"] for source in policy.sources if source.role is None}
        if len(set(receipts)) != len(receipts) or set(receipts) != dependency_hashes:
            _fail("study-receipts-not-original-dependencies")
        if any(job.context.contracts.epoch_ns(source.evidence["capturedAt"]) > policy.source("study").available_ns
               for source in policy.sources if source.role is None):
            _fail("study-receipt-not-known-at-source-availability")
        study["source_receipts"] = tuple(receipts)
        evidence = _native(job, SessionStudyEvidence, study)
        if evidence.continuous_contract:
            _fail("continuous-contract-study-unavailable")
        if any(bar.instrument_id != evidence.exact_contract_id or bar.session_id != session.session_id for bar in sources["bars"]):
            _fail("study-exact-contract-or-session-mismatch")
        sources.update({"session": session, "evidence": evidence})
    return sources, params


def _decode_inputs(policy: _Inputs, operation: str, parameters: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Closed payloads: dataclass fields are mandatory, including nullable fields.

    facts: {instrument_id, facts: FinancialFact[]}; assumptions: all
    ValuationAssumptions fields. bars/benchmark_bars: {bars: Bar[]}.
    macro_vintages: {vintages: MacroVintage[]}; parameters carry exact growth
    and inflation MacroAxis objects. wheel_state: {basis, state: WheelState}
    where basis is source-supplied-research-state, events=[], option is an
    explicit ShortOption (with complete WheelContract), and every scalar is
    provided. Decimal fields are plain exact strings, times are canonical public
    Timestamp strings exactly representable by datetime; no defaults. Output
    timestamps are explicitly labelled decimal epoch-nanosecond strings.
    """
    job = policy.job
    if operation in THESIS_OPERATION_ROLES:
        from .thesis_research import decode_thesis_research
        return {"inputs": decode_thesis_research(policy, operation, parameters)}, {}
    if operation == "wheel-early-exercise-review":
        from .wheel_scenarios import decode_wheel_exercise
        return {"inputs": decode_wheel_exercise(policy, parameters)}, {}
    if operation == "fundamental-value-equity":
        params = _record(parameters, {"instrument_id", "instrument_kind", "currency", "maximum_fact_age_days"})
        _identifier(job, params["instrument_id"])
        _identifier(job, params["currency"])
        if params["instrument_kind"] != "equity":
            _fail("equity-valuation-not-applicable")
        _integer(params["maximum_fact_age_days"])
        payload = _record(policy.source("facts").payload, {"instrument_id", "facts"})
        if payload["instrument_id"] != params["instrument_id"]:
            _fail("fact-instrument-mismatch")
        rows = payload["facts"]
        if type(rows) is not list or not 1 <= len(rows) <= MAX_ROWS:
            _fail("row-budget")
        facts = tuple(_native(job, FinancialFact, row, decimals=("value",),
            times=("period_end", "published_at", "available_at"), integers=("revision",)) for row in rows)
        for fact in facts:
            policy.provenance(fact.source_id, fact.source_hash, fact.available_at, role="facts")
        policy.observation("facts", tuple(fact.published_at for fact in facts))
        raw = _record(policy.source("assumptions").payload, {field.name for field in fields(ValuationAssumptions)})
        ids = raw["evidence_ids"]
        known_ids = {source.pin["evidenceId"] for source in policy.sources if source.role is None}
        if type(ids) is not list or not 1 <= len(ids) <= MAX_PINS or any(type(item) is not str for item in ids):
            _fail("assumption-evidence-invalid")
        if len(ids) != len(set(ids)) or not set(ids) <= known_ids:
            _fail("assumption-evidence-unreviewed")
        raw["evidence_ids"] = tuple(ids)
        assumptions = _native(job, ValuationAssumptions, raw,
            decimals=("revenue_growth", "free_cash_flow_margin", "terminal_fcf_multiple", "annual_discount_rate", "annual_dilution"),
            times=("known_at",), integers=("years",))
        envelope_ns = policy.source("assumptions").available_ns
        known_ns = int(_projection(assumptions.known_at))
        if known_ns > envelope_ns:
            _fail("assumptions-not-known-at-source-availability")
        if any(job.context.contracts.epoch_ns(source.evidence["capturedAt"]) > known_ns
               for source in policy.sources if source.pin["evidenceId"] in ids):
            _fail("assumption-citation-not-known-at-assumption-time")
        policy.observation("assumptions", (assumptions.known_at,))
        return {"facts": facts, "assumptions": assumptions}, {key: value for key, value in params.items() if key != "instrument_id"}
    if operation in ("swing-momentum", "swing-decision", "swing-dual-zone-review", "swing-session-breakout"):
        return _decode_swing(policy, operation, parameters)
    if operation == "macro-classify-regime":
        params = _record(parameters, {"growth", "inflation"})
        axes = {key: _native(job, MacroAxis, value, decimals=("positive_change_threshold",),
            integers=("maximum_release_age_days", "maximum_period_age_days")) for key, value in params.items()}
        vintages = tuple(_native(job, MacroVintage, row, decimals=("value",),
            times=("period_at", "release_at", "vintage_at", "available_at"))
            for row in policy.sequence("macro_vintages", "vintages"))
        for vintage in vintages:
            if vintage.measurement_kind != "measured" or vintage.series_id not in {axis.series_id for axis in axes.values()}:
                _fail("measured-macro-series-required")
            policy.provenance(vintage.source_id, vintage.source_hash, vintage.available_at, role="macro_vintages")
        policy.observation("macro_vintages", tuple(vintage.vintage_at for vintage in vintages))
        return {"rows": vintages}, axes
    if operation == "macro-hmm-forward-v1":
        from .hmm_research import decode_hmm
        return decode_hmm(policy, parameters)
    if operation == "macro-jump-state-v1":
        from .jump_research import decode_jump
        return decode_jump(policy, parameters)
    if operation == "macro-regime-composite-envelope-v1":
        from .composite_research import decode_composite
        return decode_composite(policy, parameters)
    if operation == "wheel-obligations":
        _record(parameters, set())
        payload = _record(policy.source("wheel_state").payload, {"basis", "state"})
        if payload["basis"] != "source-supplied-research-state":
            _fail("wheel-live-state-unavailable")
        state = _record(payload["state"], {field.name for field in fields(WheelState)})
        if state["events"] != [] or type(state["events"]) is not list or state["option"] is None:
            _fail("wheel-events-or-empty-option-unavailable")
        option = _record(state["option"], {"contract", "contracts"})
        contract = _native(job, WheelContract, option["contract"], decimals=("strike",),
                           times=("expiry_at",), integers=("multiplier",))
        if contract.settlement != "physical" or contract.expiry_at <= policy.as_of:
            _fail("wheel-settlement-or-expired-state-unavailable")
        state["option"] = ShortOption(contract, _integer(option["contracts"]))
        state["events"] = ()
        wheel = _native(job, WheelState, state, integers=("shares",),
            decimals=("share_cost", "net_cash_flow", "option_pnl", "realized_share_pnl", "dividend_income"))
        return {"state": wheel}, {}
    _fail("operation-unavailable")


def _compute(operation: str, sources: dict[str, Any], parameters: dict[str, Any], as_of: datetime) -> Any:
    if operation in THESIS_OPERATION_ROLES:
        from .thesis_research import compute_thesis_research
        return compute_thesis_research(**sources)
    if operation == "wheel-early-exercise-review":
        from .wheel_scenarios import compute_wheel_exercise
        return compute_wheel_exercise(**sources)
    if operation == "fundamental-value-equity":
        return value_equity(**sources, **parameters, as_of=as_of)
    if operation == "swing-momentum":
        return momentum(**sources, **parameters, as_of=as_of)
    if operation in ("swing-decision", "swing-dual-zone-review"):
        snapshot = momentum(bars=sources["bars"], benchmark_bars=sources.get("benchmark_bars", ()),
            instrument_id=parameters["instrument_id"], benchmark_id=parameters["benchmark_id"], as_of=as_of)
        if operation == "swing-decision":
            return swing_decision(snapshot, sources["regime"], as_of=as_of, policy=parameters["policy"],
                                  held_protection=None)
        bars = completed_bars(sources["bars"], instrument_id=parameters["instrument_id"], as_of=as_of)
        prior_close = bars[-2].close if len(bars) >= 2 else None
        return dual_zone_review(snapshot, prior_close=prior_close, volume_trigger=parameters["volume_trigger"])
    if operation == "swing-session-breakout":
        return session_breakout(**sources, **parameters, as_of=as_of)
    if operation == "macro-classify-regime":
        return classify_regime(**sources, **parameters, as_of=as_of)
    if operation == "macro-hmm-forward-v1":
        from strategies.hmm import filter_diagonal_gaussian
        return filter_diagonal_gaussian(**sources, as_of=as_of)
    if operation == "macro-jump-state-v1":
        from strategies.jump import assign_fixed_centroid_states
        return assign_fixed_centroid_states(**sources, as_of=as_of)
    if operation == "macro-regime-composite-envelope-v1":
        from strategies.composite import compose_envelope
        return compose_envelope(**sources, as_of=as_of)
    if operation == "wheel-obligations":
        return obligations(**sources)
    _fail("operation-unavailable")


def _refresh_inputs(policy: _Inputs, operation: str, sources: dict[str, Any]) -> None:
    if operation in THESIS_OPERATION_ROLES:
        from .thesis_research import refresh_thesis_research
        refresh_thesis_research(policy, sources["inputs"])
    else:
        policy.refresh()


def run_sleeve_research(job: Any, payload: Any) -> dict[str, Any]:
    """Use only existing lease/admission/current-review/immutable publication ports."""
    row = _record(payload, JOB_FIELDS)
    recipe = _record(row["recipe"], RECIPE_FIELDS)
    operation = recipe["operation"]
    if (row["profile"] != "vertex-sleeve-research-v1" or recipe["profile"] != "vertex-sleeve-recipe-v1"
            or type(operation) is not str or operation not in OPERATION_ROLES):
        _fail("operation-or-profile-unavailable")
    _bounded_tree(row)
    job.check()
    if (job.lease["kind"] != "research-run" or job.context.contracts.digest(row) != job.lease["payloadSha256"]
            or (row["actor_id"], row["account_alias"], row["environment"])
            != (job.lease["researchPrincipalId"], job.lease["accountAlias"], job.lease["environment"])):
        _fail("job-binding-mismatch")
    for name in ("run_id", "trace_id", "actor_id", "task_contract", "account_alias", "recipeArtifactId"):
        _identifier(job, row[name])
    for name in ("module_id", "task_contract", "collection_id", "snapshot_id"):
        _identifier(job, recipe[name])
    selected = [entry for entry in job.selection["artifacts"] if entry["artifact"]["artifactId"] == row["recipeArtifactId"]]
    if (len(selected) != 1 or selected[0]["role"] != "tool-config"
            or selected[0]["artifact"]["contractName"] != "WorkerSleeveRecipe"
            or selected[0]["artifact"]["schemaVersion"] != "1.0.0"
            or selected[0]["artifact"]["artifactSha256"] != _digest(row["recipeSha256"])
            or job.context.contracts.digest(recipe) != row["recipeSha256"]
            or recipe["task_contract"] != row["task_contract"]
            or recipe["collection_id"] != job.control.artifacts.context.collection_id
            or not any(module["moduleId"] == recipe["module_id"] and module["enabled"] is True for module in job.selection["modules"])):
        _fail("selected-recipe-unavailable")
    inputs, dependencies = recipe["inputs"], recipe["dependencies"]
    if (type(inputs) is not list or not 1 <= len(inputs) <= 3 or type(dependencies) is not list
            or len(inputs) + len(dependencies) > MAX_PINS):
        _fail("source-membership-budget")
    roles = [item.get("role") for item in inputs if type(item) is dict]
    required, optional = OPERATION_ROLES[operation]
    if (len(roles) != len(inputs) or any(type(role) is not str for role in roles)
            or len(set(roles)) != len(roles) or not required <= set(roles) <= required | optional):
        _fail("input-role-mismatch")
    if operation != "wheel-obligations" and not dependencies:
        _fail("original-source-dependencies-required")
    if operation == "wheel-obligations" and dependencies:
        _fail("wheel-factual-dependencies-unsupported")
    policy = _Inputs(job, recipe)
    if policy.as_of_ns > job.clock.now_ns():
        _fail("future-cutoff")
    for entry in dependencies:
        policy.load(entry, input_role=False)
    for entry in inputs:
        policy.load(entry, input_role=True)
    pins = [source.pin for source in policy.sources]
    evidence_ids = [pin["evidenceId"] for pin in pins]
    record_ids = [pin["artifactId"] for pin in pins]
    content_ids = [source.reference["artifactId"] for source in policy.sources]
    command_ids = row["input_evidence_ids"]
    if (len(set(evidence_ids)) != len(pins) or len(set(record_ids)) != len(pins)
            or len(set(content_ids)) != len(pins) or set(record_ids) & set(content_ids)
            or row["recipeArtifactId"] in set(record_ids + content_ids)
            or type(command_ids) is not list or any(type(item) is not str for item in command_ids)
            or len(command_ids) != len(pins) or set(command_ids) != set(evidence_ids)):
        _fail("source-dependency-identity-mismatch")
    metadata = _record(recipe["publication"], PUBLICATION_FIELDS)
    source_identity = _record(metadata["sourceIdentity"], {"provider", "sourceId", "snapshotId"})
    for value in source_identity.values():
        _identifier(job, value)
    _identifier(job, metadata["evidenceId"])
    if (metadata["collectionId"] != recipe["collection_id"] or metadata["snapshotId"] != recipe["snapshot_id"]
            or source_identity["snapshotId"] != recipe["snapshot_id"]
            or metadata["rightsPolicyId"] != job.rights_policy["policyId"]
            or metadata["evidenceId"] in set(evidence_ids + record_ids + content_ids + [row["recipeArtifactId"]])
            or not policy.as_of_ns <= job.context.contracts.epoch_ns(metadata["capturedAt"]) <= job.clock.now_ns()
            or (metadata["publishedAt"] is not None and not policy.as_of_ns <= job.context.contracts.epoch_ns(metadata["publishedAt"])
                <= job.context.contracts.epoch_ns(metadata["capturedAt"]))):
        _fail("publication-binding-mismatch")
    sources, parameters = _decode_inputs(policy, operation, recipe["parameters"])
    admission = job.admit_private_research(row)
    if admission is not None:
        return admission
    _refresh_inputs(policy, operation, sources)
    result = _compute(operation, sources, parameters, policy.as_of)
    job.check()
    if getattr(result, "status", None) == "unavailable" or getattr(result, "missing", ()):
        return {"status": "unavailable", "reason": "sleeve-input-or-computation-unavailable",
                "outputArtifactIds": [], "executionAuthorized": False}
    numerical = operation in NUMERICAL_METHODS
    result_limits = (*LIMITATIONS, *result.limitations) if numerical else LIMITATIONS
    content = {
        "profile": "vertex-sleeve-result-v1", "operation": operation, "asOf": recipe["as_of"],
        "recipeSha256": row["recipeSha256"], "parameters": recipe["parameters"],
        "proposalOnly": True, "executionAuthorized": False, "acceptanceStatus": "unreviewed",
        "simulatedCapitalEntersNav": False, "projectedResult": _projection(result),
        "projectionTimeEncoding": "epoch-nanoseconds-decimal-string",
        "projectionDecimalEncoding": result.numerical_encoding if numerical else "exact-decimal-string",
        "stateBasis": "source-supplied-research-state" if operation in ("wheel-obligations", "wheel-early-exercise-review") else None,
        "inputs": [{"role": source.role, "review": source.pin, "content": source.reference}
                   for source in policy.sources], "limitations": list(result_limits),
    }
    content_bytes, content_digest = encode_authoritatively(content, job.context.contracts)
    limits = metadata["limitations"]
    if type(limits) is not list or any(type(item) is not str for item in limits) or len(limits) > (57 if numerical else 60):
        _fail("publication-limitations-invalid")
    record = {**metadata, "schemaVersion": "1.0.0", "sourceType": "derived-analysis", "untrustedContent": True,
              "acceptanceStatus": "unreviewed", "contentHash": content_digest,
              "sourceIdentity": {**source_identity, "contentHash": content_digest},
              "limitations": list(dict.fromkeys([*limits, *result_limits])),
              "method": operation + NUMERICAL_METHODS.get(operation, "; exact decimal pure research")
                        + "; recipe " + row["recipeSha256"] + "; no execution authority."}
    if job.context.contracts.validate("ResearchEvidence", record, "1.0.0") is not True:
        _fail("publication-contract-invalid")
    record_bytes, record_digest = encode_authoritatively(record, job.context.contracts)
    _refresh_inputs(policy, operation, sources)
    lineage = tuple(record_ids)
    content_id = "sleeve-content-" + job.context.contracts.digest({"jobId": job.lease["jobId"], "contentSha256": content_digest})
    if (content_id in set(record_ids + content_ids + [metadata["evidenceId"], row["recipeArtifactId"]])
            or (operation in THESIS_OPERATION_ROLES
                and content_id == sources["inputs"].selection.profile_artifact_id)):
        _fail("publication-identity-conflict")
    from vertex_control.client import ControlError
    try:
        job.control.artifacts.stage(artifact_id=content_id, content=content_bytes, content_type="application/json",
            lineage_artifact_ids=lineage, collection_id=recipe["collection_id"],
            rights_policy_id=job.rights_policy["policyId"], rights_version=job.rights_policy["version"])
        _refresh_inputs(policy, operation, sources)
        job.check()
        job.control.artifacts.publish_record(contract_name="ResearchEvidence", artifact_id=metadata["evidenceId"],
            content=record_bytes, digest=record_digest, collection_id=recipe["collection_id"],
            lineage_artifact_ids=lineage, rights_policy_id=job.rights_policy["policyId"],
            rights_version=job.rights_policy["version"], review_pins=tuple(pins))
    except ControlError as error:
        status = "unknown" if error.effect == "unknown" else "unavailable"
        return {"status": status, "reason": "sleeve-publication-" + status,
                "outputArtifactIds": [], "executionAuthorized": False}
    return {"status": "completed", "outputArtifactIds": [metadata["evidenceId"]],
            "contentSha256": content_digest, "recordSha256": record_digest, "proposalOnly": True,
            "acceptanceStatus": "unreviewed", "executionAuthorized": False, "simulatedCapitalEntersNav": False}
