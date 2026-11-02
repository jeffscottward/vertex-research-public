"""Closed HMM input profiles on the existing reviewed sleeve source owners."""
from __future__ import annotations

from dataclasses import fields
from typing import Any

from strategies.hmm import (DiagonalGaussianModel, FeatureObservation, FeatureScaler,
                            MAX_FEATURES, MAX_OBSERVATIONS, MAX_STATES)
from .sleeve_research import _Inputs, _digest, _fail, _identifier, _native, _projection, _record


def _tuple(value: Any, maximum: int) -> tuple[Any, ...]:
    if type(value) is not list or not 1 <= len(value) <= maximum:
        _fail("hmm-dimension-budget")
    return tuple(value)


def decode_hmm(policy: _Inputs, parameters: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    params = _record(parameters, {"variant"})
    if params["variant"] != "diagonal-gaussian-log-forward-v1":
        _fail("hmm-variant-unavailable")
    job = policy.job
    parsed = {}
    for role, kind in (("hmm_model", DiagonalGaussianModel), ("hmm_scaler", FeatureScaler)):
        raw = _record(policy.source(role).payload, {field.name for field in fields(kind)})
        raw["feature_order"] = _tuple(raw["feature_order"], MAX_FEATURES)
        if role == "hmm_model":
            for key in ("state_labels", "initial_probabilities"):
                raw[key] = _tuple(raw[key], MAX_STATES)
            for key in ("transitions", "means", "variances"):
                raw[key] = tuple(_tuple(row, MAX_STATES if key == "transitions" else MAX_FEATURES)
                                 for row in _tuple(raw[key], MAX_STATES))
        else:
            for key in ("center", "scale"):
                raw[key] = _tuple(raw[key], MAX_FEATURES)
        item = _native(job, kind, raw, times=("fit_cutoff", "available_at"))
        _identifier(job, item.source_id)
        _digest(item.source_hash)
        policy.provenance(item.source_id, item.source_hash, item.available_at, role=role)
        policy.observation(role, (item.available_at,))
        if int(_projection(item.available_at)) != policy.source(role).available_ns:
            _fail("hmm-parameter-availability-mismatch")
        parsed["model" if role == "hmm_model" else "scaler"] = item
    payload = _record(policy.source("hmm_features").payload, {"profile", "feature_order", "observations"})
    if payload["profile"] != "vertex-hmm-features-v1":
        _fail("hmm-feature-profile-invalid")
    order = _tuple(payload["feature_order"], MAX_FEATURES)
    observations = []
    for value in _tuple(payload["observations"], MAX_OBSERVATIONS):
        raw = _record(value, {field.name for field in fields(FeatureObservation)})
        raw["values"] = _tuple(raw["values"], MAX_FEATURES)
        row = _native(job, FeatureObservation, raw, times=("observed_at", "available_at"))
        _identifier(job, row.source_id)
        _digest(row.source_hash)
        policy.provenance(row.source_id, row.source_hash, row.available_at, role="hmm_features")
        observations.append(row)
    policy.observation("hmm_features", tuple(row.observed_at for row in observations))
    return {**parsed, "feature_order": order, "observations": tuple(observations)}, {}
