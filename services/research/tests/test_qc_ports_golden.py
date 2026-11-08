"""qc-ports golden fixtures: options_golden.json and portfolio_golden.json equal a fresh golden.py run.

The TypeScript port (packages/api/src/options-engine) replays this fixture, so a change to the
Python runner that is not regenerated here would leave the port pinned to stale numbers.
Strings, integers, None and the structure must match exactly. Floats must match to 1e-12
relative: unrounded values (premium, Sharpe statistics) go through the C library's erf/erfc,
exp and log, which glibc versions round differently in the last bit (glibc 2.41+ erf and erfc
are correctly rounded, older ones are not); every cent-rounded value still matches exactly.
"""
import json
import math

from tests import qc_ports_golden as golden

REL_TOL = 1e-12


def _same(actual, expected, path="$"):
    if isinstance(expected, float) and isinstance(actual, float):
        assert actual == expected or math.isclose(actual, expected, rel_tol=REL_TOL), (path, actual, expected)
        return
    assert type(actual) is type(expected), (path, actual, expected)
    if isinstance(expected, dict):
        assert list(actual) == list(expected), path
        for key in expected:
            _same(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (left, right) in enumerate(zip(actual, expected, strict=True)):
            _same(left, right, f"{path}[{index}]")
    else:
        assert actual == expected, (path, actual, expected)


def test_committed_fixture_matches_a_fresh_build():
    committed = json.loads(golden.FIXTURE.read_text(encoding="utf-8"))
    _same(json.loads(json.dumps(golden.build(), allow_nan=False)), committed)


def test_fixture_covers_every_exit_and_skip_reason():
    data = golden.build()
    reasons = {trade["exitReason"] for case in data["cases"] for trade in case["book"]["trades"]}
    skips = {skip["reason"] for case in data["cases"] for skip in case["book"]["skipped"]}
    ledger_skips = {skip["reason"] for case in data["cases"] for ledger in case["ledgers"]
                    for skip in ledger["result"]["skipped"]}
    structures = {case["options"]["structure"] for case in data["cases"]}
    assert reasons == {"expiry", "stale-iv", "exitDte", "profitTake", "signal", "end"}
    assert skips == {"no bar to enter and exit", "no IV", "no rate", "exitDte at entry", "no strikes", "no premium"}
    assert ledger_skips == {"size"}
    assert structures == {"callDebitVertical", "putDebitVertical", "putCreditVertical", "callCreditVertical"}
    assert min(close for close in data["marketSets"]["main"]["SLV"]["close"]) < 25
    assert None in data["marketSets"]["main"]["USO"]["ivIndex"]


def test_committed_portfolio_fixture_matches_a_fresh_build():
    committed = json.loads(golden.PORTFOLIO_FIXTURE.read_text(encoding="utf-8"))
    _same(json.loads(json.dumps(golden.portfolio_build(), allow_nan=False)), committed)


def test_portfolio_fixture_covers_the_policies():
    inputs = json.loads(golden.PORTFOLIO_DEFINITIONS.read_text(encoding="utf-8"))["cases"]
    blocks = [case["definition"].get("portfolio") or {} for case in inputs]
    assert {block.get("policy") for block in blocks} == {"roll", "flat", "window", None}
    assert any(block.get("frame") == "monthly" and "tieBreak" in block.get("select", {}) for block in blocks)
    assert any(block.get("shift") for block in blocks) and any(block.get("legs") for block in blocks)
    assert {block.get("cadence") for block in blocks} >= {"daily", "monthEnd"}
    built = golden.portfolio_build()
    assert all(case["result"]["trades"]["rows"] for case in built["cases"])
