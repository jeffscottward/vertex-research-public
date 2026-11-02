"""Closed jump-model input profiles on the existing reviewed sleeve source owners."""
from __future__ import annotations

from dataclasses import fields
from typing import Any

from strategies.jump import (FixedCentroidJumpModel, JumpFeatureObservation, JumpFeatureScaler,
                             MAX_FEATURES, MAX_OBSERVATIONS, MAX_STATES, VARIANT)
from .sleeve_research import _Inputs, _digest, _fail, _identifier, _native, _projection, _record


def _tuple(value: Any, maximum: int) -> tuple[Any, ...]:
    if type(value) is not list or not 1 <= len(value) <= maximum:
        _fail("jump-dimension-budget")
    return tuple(value)


def decode_jump(policy: _Inputs, parameters: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    params = _record(parameters, {"variant"})
    if params["variant"] != VARIANT:
        _fail("jump-variant-unavailable")
    job = policy.job
    parsed = {}
    for role, kind in (("jump_model", FixedCentroidJumpModel), ("jump_scaler", JumpFeatureScaler)):
        raw = _record(policy.source(role).payload, {field.name for field in fields(kind)})
        raw["feature_order"] = _tuple(raw["feature_order"], MAX_FEATURES)
        if role == "jump_model":
            raw["state_labels"] = _tuple(raw["state_labels"], MAX_STATES)
            raw["centroids"] = tuple(_tuple(row, MAX_FEATURES) for row in _tuple(raw["centroids"], MAX_STATES))
        else:
            for key in ("center", "scale"):
                raw[key] = _tuple(raw[key], MAX_FEATURES)
        item = _native(job, kind, raw, times=("fit_cutoff", "available_at"),
                       integers=("window_length",) if role == "jump_model" else ())
        _identifier(job, item.source_id)
        _digest(item.source_hash)
        policy.provenance(item.source_id, item.source_hash, item.available_at, role=role)
        policy.observation(role, (item.available_at,))
        if int(_projection(item.available_at)) != policy.source(role).available_ns:
            _fail("jump-parameter-availability-mismatch")
        parsed["model" if role == "jump_model" else "scaler"] = item
    payload = _record(policy.source("jump_features").payload,
                      {"profile", "feature_order", "feature_construction", "observations"})
    if payload["profile"] != "vertex-jump-features-v1" or type(payload["feature_construction"]) is not str:
        _fail("jump-feature-profile-invalid")
    order = _tuple(payload["feature_order"], MAX_FEATURES)
    observations = []
    for value in _tuple(payload["observations"], MAX_OBSERVATIONS):
        raw = _record(value, {field.name for field in fields(JumpFeatureObservation)})
        raw["values"] = _tuple(raw["values"], MAX_FEATURES)
        row = _native(job, JumpFeatureObservation, raw, times=("observed_at", "available_at"))
        _identifier(job, row.source_id)
        _digest(row.source_hash)
        policy.provenance(row.source_id, row.source_hash, row.available_at, role="jump_features")
        observations.append(row)
    policy.observation("jump_features", tuple(row.observed_at for row in observations))
    return {**parsed, "feature_order": order, "feature_construction": payload["feature_construction"],
            "observations": tuple(observations)}, {}
