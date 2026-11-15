"""The session expiry of gate version 2 against the expiry rule of the study.

spread_gate.session_expiry holds the rule of strategies.volspike.options.weekly_expiry(day, 3) again, on the
calendar of liquidity.py, because the study module needs numpy and pydantic at import. Without them this
test skips, unless VERTEX_REQUIRE_NUMERIC=1 (set by scripts/ci/research-python.sh for the numeric run), where
a missing module is a failure. No network and no data file."""
from __future__ import annotations

import importlib
import os
from datetime import date, timedelta

import pytest

from strategies.leveraged_etf import liquidity, spread_gate

STUDY_MODULE = "strategies.volspike.options"


def _study_options():
    if os.environ.get("VERTEX_REQUIRE_NUMERIC") == "1":
        return importlib.import_module(STUDY_MODULE)  # the numeric CI run fails here instead of skipping
    try:
        return importlib.import_module(STUDY_MODULE)
    except ImportError:
        return None


def test_session_expiry_equals_the_expiry_rule_of_the_study_for_2026_and_2027():
    options = _study_options()
    if options is None:
        pytest.skip("the study module needs numpy and pydantic; CI runs this in the numeric venv")
    days = [date(2026, 1, 1) + timedelta(days=offset) for offset in range(730)]
    sessions = [day for day in days if liquidity.session_close(day) is not None]
    assert (sessions[0], sessions[-1], len(sessions)) == (date(2026, 1, 2), date(2027, 12, 31), 502)
    different = [day for day in sessions if spread_gate.session_expiry(day) != options.weekly_expiry(day, 3)]
    assert different == []
