"""Observed Gamma edge behavior, including limitations that must not be hidden."""

from __future__ import annotations

import copy
from datetime import UTC, date, datetime, timedelta

import pytest

from gamma.engines.setup_engine import SetupEngine, _latest_complete_trading_session
from gamma.features import (
    FundamentalCatalystFeatures, LiquidityFeatures, MarketStructureFeatures,
    MomentumFeatures, OptionFlowFeatures, VolatilityFeatures,
)
from gamma.schemas import OptionFlowSnapshot
from .test_adapter import corpus, receipt, setup_inputs
from gamma.adapter import ResearchAdapter

NOW = datetime(2026, 6, 8, 12, tzinfo=UTC)


@pytest.mark.parametrize("rows", [[], [{"date": "2026-06-05", "close": 1}]])
def test_momentum_and_structure_require_two_bars(rows):
    for feature in (MomentumFeatures(), MarketStructureFeatures()):
        with pytest.raises(ValueError, match="at least two"):
            feature.compute(ticker="SYNTH", rows=rows)


def test_sorted_rows_produce_identical_outputs(corpus):
    for feature in (MomentumFeatures(), MarketStructureFeatures()):
        expected = feature.compute(ticker="SYNTH", rows=corpus["rows"])
        actual = feature.compute(ticker="SYNTH", rows=list(reversed(corpus["rows"])))
        assert actual.to_json_dict() == expected.to_json_dict()


def test_momentum_breakout_is_strict_but_volume_threshold_is_inclusive(corpus):
    rows = corpus["rows"]
    rows[-1]["close"] = 102  # equal to prior high, not a breakout
    rows[-1]["open"] = rows[-2]["close"] * 1.02
    result = MomentumFeatures().compute(ticker="SYNTH", rows=rows)
    assert not result.twenty_day_breakout
    assert not result.fifty_day_breakout
    assert not result.gap_and_hold
    assert result.volume_expansion
    rows[-1]["volume"] = 149.999
    assert not MomentumFeatures().compute(ticker="SYNTH", rows=rows).volume_expansion
    rows[0]["volume"] = None
    assert not MomentumFeatures().compute(ticker="SYNTH", rows=rows).volume_expansion


def test_nonpositive_first_close_does_not_fabricate_returns(corpus):
    corpus["rows"][0]["close"] = 0
    result = MomentumFeatures().compute(ticker="SYNTH", rows=corpus["rows"], spy_rows=corpus["benchmarkRows"])
    assert result.relative_strength_vs_spy is None
    assert result.trend_acceleration is None
    assert MarketStructureFeatures().compute(ticker="SYNTH", rows=corpus["rows"]).trend_label == "unknown"


@pytest.mark.parametrize("close,label", [(103, "uptrend"), (97, "downtrend"), (102.999, "range")])
def test_three_percent_trend_boundaries(corpus, close, label):
    corpus["rows"][-1]["close"] = close
    assert MarketStructureFeatures().compute(ticker="SYNTH", rows=corpus["rows"]).trend_label == label


def test_structure_is_close_distribution_and_range_percent_not_true_volume_profile(corpus):
    result = MarketStructureFeatures().compute(ticker="SYNTH", rows=corpus["rows"])
    assert result.raw["value_area_low"] == result.raw["value_area_high"] == 101
    assert result.atr_percent == pytest.approx(2 / 105 * 100)
    assert "approximation" in result.notes
    del corpus["rows"][-1]["vwap"]
    assert MarketStructureFeatures().compute(ticker="SYNTH", rows=corpus["rows"]).vwap_relation == "unknown"
    with pytest.raises(ValueError, match="lookback"):
        MarketStructureFeatures(lookback=1)


@pytest.mark.parametrize("change,label", [(0.03, "expanding"), (-0.03, "contracting"), (0.02999, "stable"), (None, "unknown")])
def test_volatility_change_boundaries(change, label):
    result = VolatilityFeatures().compute(ticker="SYNTH", payload={"iv_change": change}, as_of=NOW)
    assert result.iv_change_label == label
    assert result.term_structure_label == "unknown"


@pytest.mark.parametrize("front,back,label", [(1.05, 1, "flat"), (1.05001, 1, "backwardation"), (1, 1.05001, "contango")])
def test_term_structure_strict_five_percent_boundary(front, back, label):
    result = VolatilityFeatures().compute(ticker="SYNTH", payload={"front_iv": front, "back_iv": back}, as_of=NOW)
    assert result.term_structure_label == label


def test_liquidity_missing_values_pass_native_threshold_but_are_not_readiness():
    result = LiquidityFeatures().compute(ticker="SYNTH", option_chain=[{}], as_of=NOW,
                                         option_totals={"volume": 1000, "open_interest": 5000})
    assert result.minimum_viable_contract_count == 1
    assert result.median_bid_ask_spread_pct is None
    assert result.option_total_volume == 1000
    assert result.option_total_open_interest == 5000
    # No claim of provider-backed quotes or execution authority follows.
    assert not hasattr(result, "quote_readiness")


def test_liquidity_totals_only_fill_zero_sums_and_exact_thresholds_pass():
    result = LiquidityFeatures(max_spread_pct=0.2).compute(ticker="SYNTH", as_of=NOW,
        option_chain=[{"bid": 9, "ask": 11, "volume": 10, "open_interest": 100}],
        option_totals={"volume": 9999, "open_interest": 9999})
    assert result.minimum_viable_contract_count == 1
    assert result.median_bid_ask_spread_pct == .2
    assert result.option_total_volume == 10
    assert result.option_total_open_interest == 100


def test_fundamental_missing_context_invalid_numbers_and_signed_changes():
    feature = FundamentalCatalystFeatures()
    assert feature.compute(ticker="SYNTH", payload=None).earnings_dates == []
    result = feature.compute(ticker="SYNTH", payload={
        "company_facts": {"marketCap": -1, "employeeCount": 10.9},
        "financial_metrics": {"revenue_growth": -.2, "bad_delta": "invalid", "ignore": 1},
        "earnings": [{"date": "2026-01-01", "surprise_percent": 4.999},
                     {"date": "2026-02-01", "surprise_percent": -5}],
    })
    assert result.market_cap == 0
    assert result.employee_count == 10
    assert result.financial_metric_changes == {"revenue_growth": -.2}
    assert result.earnings_surprise_flags == ["negative_surprise"]


def test_option_flow_provider_totals_override_contract_sums_and_zero_put_ratio(corpus):
    snapshot = OptionFlowSnapshot.model_validate(corpus["flow"])
    snapshot.total_call_premium = 10
    snapshot.total_put_premium = 0
    result = OptionFlowFeatures().compute(snapshot)
    assert result.call_premium == 10
    assert result.put_premium == 0
    assert result.call_put_premium_ratio is None
    snapshot.call_put_premium_ratio = 9
    assert OptionFlowFeatures().compute(snapshot).call_put_premium_ratio == 9


def test_flow_45_day_boundary_missing_oi_and_expired_short_bucket_are_preserved(corpus):
    snapshot = OptionFlowSnapshot.model_validate(corpus["flow"])
    snapshot.notable_contracts[0].expiry = NOW.date() + timedelta(days=45)
    snapshot.notable_contracts[1].expiry = NOW.date() - timedelta(days=1)
    snapshot.notable_contracts[1].open_interest = None
    result = OptionFlowFeatures().compute(snapshot)
    assert result.short_dated_premium == 180
    assert result.contracts_missing_open_interest == 1
    assert not result.open_interest_validated
    snapshot.notable_contracts[0].expiry += timedelta(days=1)
    assert OptionFlowFeatures().compute(snapshot).short_dated_premium == 80
    with pytest.raises(ValueError, match="non-negative"):
        OptionFlowFeatures(short_dated_max_dte=-1)


def test_two_sided_unusual_flow_and_empty_flow(corpus):
    snapshot = OptionFlowSnapshot.model_validate(corpus["flow"])
    snapshot.total_call_premium = 100
    snapshot.total_put_premium = 100
    snapshot.unusual_call_volume = snapshot.unusual_put_volume = 2
    assert OptionFlowFeatures().compute(snapshot).flow_label == "volatility"
    snapshot.notable_contracts = []
    snapshot.total_call_premium = snapshot.total_put_premium = 0
    result = OptionFlowFeatures().compute(snapshot)
    assert result.flow_label == "neutral"
    assert not result.open_interest_validated
    assert result.short_dated_premium_pct is None


@pytest.mark.parametrize("reference,expected", [
    ("2026-06-08T20:14:59.999999+00:00", date(2026, 6, 5)),
    ("2026-06-08T20:15:00+00:00", date(2026, 6, 8)),
    ("2026-07-06T12:00:00+00:00", date(2026, 7, 2)),
    ("2026-03-09T20:15:00+00:00", date(2026, 3, 9)),
    ("2026-11-02T21:15:00+00:00", date(2026, 11, 2)),
])
def test_source_regular_session_calendar_with_pinned_timezone(reference, expected):
    assert _latest_complete_trading_session(datetime.fromisoformat(reference)) == expected


def test_early_close_is_explicitly_not_an_exchange_calendar_adaptation():
    # Source algorithm still assumes 16:15 on the half-day after Thanksgiving.
    # This is characterization of the limitation, not approval for 0DTE use.
    assert _latest_complete_trading_session(datetime(2026, 11, 27, 18, 15, tzinfo=UTC)) == date(2026, 11, 25)


def test_setup_staleness_threshold_is_inclusive_then_rejects_one_microsecond_later():
    models = setup_inputs()
    models["flow_snapshot"].as_of = NOW - timedelta(days=2)
    assert "stale data" not in SetupEngine().identify_setup(**models, as_of=NOW).rejection_reasons
    models["flow_snapshot"].as_of -= timedelta(microseconds=1)
    assert "stale data" in SetupEngine().identify_setup(**models, as_of=NOW).rejection_reasons


def test_boundary_rejects_future_quote_rows_and_volatility_date(corpus):
    corpus["optionChain"][0]["timestamp"] = "2026-06-09T00:00:00Z"
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).liquidity(ticker="SYNTH", option_chain=receipt(corpus["optionChain"]))
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({"date": "2026-06-09"}))
