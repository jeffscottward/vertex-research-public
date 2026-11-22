"""The worker's series ids (nautilus_backtest/signals.py SERIES_IDS) equal the contract's
STRATEGY_SERIES_IDS (packages/api/src/strategy-dsl.ts), in the same order: a run whose definition
reads a series the worker does not know would fail on the worker only."""
from __future__ import annotations

import re
from pathlib import Path

from nautilus_backtest import signals

DSL = Path(__file__).resolve().parents[3] / "packages" / "api" / "src" / "strategy-dsl.ts"


def _contract_ids() -> tuple[str, ...]:
    text = DSL.read_text(encoding="utf-8")
    match = re.search(r"export const STRATEGY_SERIES_IDS = \[(.*?)\] as const;", text, re.S)
    assert match is not None, "STRATEGY_SERIES_IDS not found in strategy-dsl.ts"
    return tuple(re.findall(r'"([^"]+)"', match.group(1)))


def test_worker_series_ids_equal_the_contract() -> None:
    ids = _contract_ids()
    assert len(ids) == 33
    assert signals.SERIES_IDS == ids


def test_breadth_series_is_known_to_the_worker() -> None:
    assert "NYSE_UPVOL_PCT" in signals.SERIES_REFS
