"""Closed composite binding profiles on the existing reviewed sleeve source owners.

Inputs: composite_hmm_binding and composite_jump_binding vertex-sleeve-input-v1
envelopes whose payloads are the reviewed binding attestations (see
strategies.composite). Dependencies: exactly the two component ResearchEvidence
records, each loaded by the unchanged _Inputs.load (current exact review pin,
contract, content-hash binding, capturedAt <= as_of). The component content is
re-read by its pinned reference and hash-checked before decoding. Each binding
envelope observed_at is the component capturedAt it attests to.
"""
from __future__ import annotations

import hashlib
from typing import Any

from strategies.composite import VARIANT, ComponentSource, bind_components
from .sleeve_research import _Inputs, _canonical, _fail, _identifier, _instant, _record

ROLES = (("composite_hmm_binding", "hmm"), ("composite_jump_binding", "jump"))


def decode_composite(policy: _Inputs, parameters: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    params = _record(parameters, {"variant", "market_id", "calendar_id"})
    if params["variant"] != VARIANT:
        _fail("composite-variant-unavailable")
    job = policy.job
    _identifier(job, params["market_id"])
    _identifier(job, params["calendar_id"])
    dependencies = [source for source in policy.sources if source.role is None]
    if len(dependencies) != 2:
        _fail("composite-component-membership-invalid")
    loaded: dict[str, tuple[Any, ComponentSource]] = {}
    for role, key in ROLES:
        binding = policy.source(role).payload
        matches = [source for source in dependencies if source.pin["evidenceId"] == binding.get("component_evidence_id")]
        if len(matches) != 1:
            _fail("composite-component-unpinned")
        source = matches[0]
        content = job.artifact(source.reference, collection_id=source.pin["collectionId"])
        if not content or hashlib.sha256(content).hexdigest() != source.reference["sha256"]:
            _fail("composite-component-content-digest-mismatch")
        value = _canonical(job, content)
        if type(value.get("asOf")) is not str:
            _fail("composite-component-as-of-invalid")
        component_as_of = job.context.contracts.epoch_ns(value["asOf"])
        _instant(job, value["asOf"])
        captured = _instant(job, source.evidence["capturedAt"])
        policy.observation(role, (captured,))
        loaded[key] = (binding, ComponentSource(source.pin["evidenceId"], source.reference["sha256"],
            job.context.contracts.epoch_ns(source.evidence["capturedAt"]), component_as_of, value))
    if {item[1].evidence_id for item in loaded.values()} != {source.pin["evidenceId"] for source in dependencies}:
        _fail("composite-component-membership-invalid")
    try:
        bound = bind_components(market_id=params["market_id"], calendar_id=params["calendar_id"],
            hmm_binding=loaded["hmm"][0], jump_binding=loaded["jump"][0], hmm=loaded["hmm"][1],
            jump=loaded["jump"][1], as_of=policy.as_of, maximum_age_ns=policy.maximum_age_ns)
    except ValueError as error:
        _fail(str(error))
    return {"bound": bound}, {}
