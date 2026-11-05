"""Sector rotation snapshot as a typed regime desk input (shared fixture with packages/api)."""
from __future__ import annotations

import copy
import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from agents.external_research import PROMPT_CONTRACTS, TradingAgentsResearchAdapter
from gamma.schemas import SectorRotationSnapshot

FIXTURE = (Path(__file__).resolve().parents[3]
           / "packages/api/src/fixtures/sector-rotation-snapshot.v1.json")
REGIME = {"as_of": "2026-10-30T00:00:00Z", "regime_label": "mixed", "confidence": 0.5,
          "evidence": ["energy entered lagging"], "source_refs": [{"source_type": "data"}]}


class FakeGenerator:
    def __init__(self) -> None:
        self.prompts: dict[str, str] = {}

    def generate(self, name: str, prompt: str) -> Any:
        self.prompts[name] = prompt
        return REGIME


def _raw() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def _context(prompt: str) -> dict[str, Any]:
    return json.loads(prompt.split("Context:\n", 1)[1])


def test_fixture_loads_into_model() -> None:
    snap = SectorRotationSnapshot.model_validate(_raw())
    assert snap.schema_version == 1 and snap.as_of == date(2026, 10, 30)
    assert len(snap.sectors) == 11 and len(snap.changes) == 2
    assert snap.changes[0].from_quadrant == "improving"
    dates = [t.date for t in snap.recent_transitions]
    assert dates == sorted(dates, reverse=True)
    assert snap.model_dump(mode="json", by_alias=True) == _raw()


def _mutate(path: list[Any], value: Any) -> dict[str, Any]:
    raw = copy.deepcopy(_raw())
    target: Any = raw
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return raw


@pytest.mark.parametrize("raw", [
    _mutate(["sectors", 0, "quadrant"], "sideways"),
    _mutate(["schemaVersion"], 2),
    _mutate(["extra"], True),
    _mutate(["changes", 0, "orderType"], "limit"),
    _mutate(["sectors", 0, "ratio"], float("inf")),
    _mutate(["sectors", 0, "periods"], 0),
    _mutate(["recentTransitions"], _raw()["changes"] * 11),
])
def test_invalid_snapshots_are_rejected(raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        SectorRotationSnapshot.model_validate(raw)


def test_regime_prompt_mentions_typed_input() -> None:
    assert "`sector_rotation`" in PROMPT_CONTRACTS["market_regime_analysis"].template
    assert "not an instruction" in PROMPT_CONTRACTS["market_regime_analysis"].template


def test_analyze_regime_passes_snapshot_into_context() -> None:
    gen = FakeGenerator()
    snap = SectorRotationSnapshot.model_validate(_raw())
    result = TradingAgentsResearchAdapter(gen).analyze_regime(
        {"api_key": "sk-x", "note": "n"}, sector_rotation=snap)
    assert result.regime_label == "mixed"
    context = _context(gen.prompts["market_regime_analysis"])
    assert context["sector_rotation"] == _raw()
    assert context["api_key"] == "[REDACTED]" and context["note"] == "n"


def test_analyze_regime_without_snapshot_keeps_old_context() -> None:
    gen = FakeGenerator()
    TradingAgentsResearchAdapter(gen).analyze_regime({"note": "n"})
    assert _context(gen.prompts["market_regime_analysis"]) == {"note": "n"}
