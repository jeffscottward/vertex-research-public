"""Volume-weighted value area (port of market-watch-bot auction/profile.py)."""

from __future__ import annotations

import pytest

from gamma.features import market_structure_features as msf
from gamma.features.market_structure_features import MarketStructureFeatures


def rows(bars: list[tuple[float, float, float, float | None]]) -> list[dict[str, object]]:
    return [
        {"date": f"2026-11-{day + 1:02d}", "open": close, "high": high, "low": low, "close": close, "volume": volume}
        for day, (low, high, close, volume) in enumerate(bars)
    ]


def test_volume_profile_spreads_each_bar_over_its_range() -> None:
    profile = msf.volume_profile([(1.00, 1.02, 300.0), (1.01, 1.01, 50.0), (2.0, 1.0, 9.0), (1.0, 1.0, 0.0)], 0.01)
    assert profile == {100: 100.0, 101: 150.0, 102: 100.0}


def test_value_area_expands_from_poc_by_larger_neighbour() -> None:
    # POC 5 (40); neighbours 4 (30) vs 6 (10): take 4, then 3 (15) vs 6 (10): take 3 -> 85 of 100.
    assert msf.value_area({2: 5.0, 3: 15.0, 4: 30.0, 5: 40.0, 6: 10.0}, 0.8) == (3, 5)
    # Tie between neighbours goes up; tie between POCs goes to the middle, then up.
    assert msf.value_area({1: 10.0, 2: 50.0, 3: 10.0}, 0.8) == (2, 3)
    assert msf.value_area({1: 9.0, 2: 9.0}) == (1, 2)
    # Upper edge reached: keep expanding down; a gap bin counts as zero volume.
    assert msf.value_area({0: 50.0, 2: 50.0}) == (0, 2)


def test_compute_uses_volume_profile_when_every_bar_has_volume() -> None:
    bars = [(99.0, 101.0, 100.0, 1000.0)] * 9 + [(104.0, 106.0, 105.0, 10.0)]
    result = MarketStructureFeatures(lookback=10).compute(ticker="SYNTH", rows=rows(bars))
    assert result.raw["value_area_method"] == "ohlcv_volume_profile_70pct"
    # A heavy volume node at 99-101 holds the value area; the light last bar at 105 stays outside.
    assert 99.0 <= result.raw["value_area_low"] < result.raw["value_area_high"] <= 101.2
    assert result.value_area_relation == "accepting_above"
    assert "70% of volume" in result.notes


@pytest.mark.parametrize("last_volume", [None, 0.0])
def test_compute_falls_back_to_close_distribution_without_volume(last_volume: float | None) -> None:
    bars = [(99.0, 101.0, 100.0, 1000.0)] * 9 + [(104.0, 106.0, 105.0, last_volume)]
    result = MarketStructureFeatures(lookback=10).compute(ticker="SYNTH", rows=rows(bars))
    assert result.raw["value_area_method"] == "ohlcv_close_distribution_approximation"
    assert "approximation" in result.notes


def test_compute_falls_back_when_no_bar_has_a_valid_range() -> None:
    bars = [(101.0, 99.0, 100.0, 1000.0), (106.0, 104.0, 105.0, 1000.0)]
    result = MarketStructureFeatures().compute(ticker="SYNTH", rows=rows(bars))
    assert result.raw["value_area_method"] == "ohlcv_close_distribution_approximation"
