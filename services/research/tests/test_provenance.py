"""Fixture-byte, dependency-lock, import-surface and public-signature checks for the research package."""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import tomllib
from pathlib import Path

from gamma.engines import SetupEngine
from gamma.features import (
    FundamentalCatalystFeatures, LiquidityFeatures, MarketStructureFeatures,
    MomentumFeatures, OptionFlowFeatures, VolatilityFeatures,
)

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    return json.loads((ROOT / "provenance" / name).read_bytes())


def test_fixture_bytes_match_their_ledger():
    for entry in load("fixtures.json")["fixtures"]:
        assert hashlib.sha256((ROOT / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]


def test_locked_dependencies_use_only_pinned_wheel_hashes():
    requirements = (ROOT / "requirements-linux-py312.lock").read_text().splitlines()
    expected = []
    for dependency in load("dependency-lock.json")["dependencies"]:
        expected.append(dependency["name"] + "==" + dependency["version"] + " " + " ".join(
            "--hash=sha256:" + wheel["sha256"] for wheel in dependency["wheels"]))
    assert [line for line in requirements if line and not line.startswith("#")] == expected
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert project["project"]["dependencies"] == ["pydantic==2.13.4", "tzdata==2026.2"]
    assert project["build-system"]["requires"] == ["setuptools==82.0.1"]


def test_native_dependency_surface_has_no_provider_execution_or_clock_import():
    allowed = {"__future__", "collections", "datetime", "decimal", "fnmatch", "hashlib", "importlib", "inspect", "json", "math",
               "pydantic", "re", "statistics", "typing", "types", "dataclasses", "zoneinfo", "gamma"}
    for path in (ROOT / "gamma").rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert all(alias.name.split(".")[0] in allowed for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                assert node.module.split(".")[0] in allowed
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in {"now", "utcnow", "today"}


def test_public_feature_and_setup_signatures_stay_stable():
    expected = [
        (MomentumFeatures.compute, ["self", "ticker", "rows", "spy_rows", "qqq_rows"]),
        (MarketStructureFeatures.compute, ["self", "ticker", "rows", "timeframe"]),
        (VolatilityFeatures.compute, ["self", "ticker", "payload", "as_of"]),
        (LiquidityFeatures.compute, ["self", "ticker", "stock_rows", "option_chain", "as_of", "option_totals"]),
        (FundamentalCatalystFeatures.compute, ["self", "ticker", "payload"]),
        (OptionFlowFeatures.compute, ["self", "snapshot"]),
        (SetupEngine.identify_setup, ["self", "candidate", "research_brief", "flow_snapshot", "market_structure",
                                      "volatility", "liquidity", "fundamental_catalyst", "market_regime", "as_of"]),
    ]
    for method, names in expected:
        signature = inspect.signature(method)
        assert list(signature.parameters) == names
        if method is not OptionFlowFeatures.compute:
            assert all(parameter.kind is inspect.Parameter.KEYWORD_ONLY
                       for name, parameter in signature.parameters.items() if name != "self")
    assert inspect.signature(MarketStructureFeatures.compute).parameters["timeframe"].default == "1d"
    assert inspect.signature(SetupEngine.identify_setup).parameters["as_of"].default is None
