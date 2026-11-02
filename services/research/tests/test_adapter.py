"""Offline native-boundary characterization; no original repository import."""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import FrozenInstanceError
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import MappingProxyType

import pytest

from gamma.adapter import InputArtifact, ResearchAdapter, freeze_native
from gamma.engines import SetupEngine
from gamma.features import (
    FundamentalCatalystFeatures, LiquidityFeatures, MarketStructureFeatures,
    MomentumFeatures, OptionFlowFeatures, VolatilityFeatures,
)
from gamma.schemas import OptionFlowSnapshot
from .test_setup_parity import (
    NOW, _candidate, _flow_snapshot, _fundamental, _liquidity,
    _market_regime, _market_structure, _research_brief, _volatility,
)

FIXTURE = Path(__file__).parent / "fixtures" / "pure-research.json"


def receipt(value, *, observed=NOW, available=NOW):
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    content = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return InputArtifact(content, hashlib.sha256(content).hexdigest(), observed, available)


@pytest.fixture
def corpus():
    return json.loads(FIXTURE.read_bytes())


def cases(corpus):
    adapter = ResearchAdapter(as_of=NOW)
    ticker = corpus["ticker"]
    rows, benchmark = corpus["rows"], corpus["benchmarkRows"]
    yield "momentum", adapter.momentum(ticker=ticker, rows=receipt(rows), spy_rows=receipt(benchmark), qqq_rows=receipt(benchmark)), MomentumFeatures().compute(ticker=ticker, rows=rows, spy_rows=benchmark, qqq_rows=benchmark)
    yield "marketStructure", adapter.market_structure(ticker=ticker, rows=receipt(rows)), MarketStructureFeatures().compute(ticker=ticker, rows=rows)
    yield "volatility", adapter.volatility(ticker=ticker, payload=receipt(corpus["volatility"])), VolatilityFeatures().compute(ticker=ticker, payload=corpus["volatility"])
    yield "liquidity", adapter.liquidity(ticker=ticker, stock_rows=receipt(rows), option_chain=receipt(corpus["optionChain"])), LiquidityFeatures().compute(ticker=ticker, stock_rows=rows, option_chain=corpus["optionChain"], as_of=NOW)
    yield "fundamental", adapter.fundamental_catalyst(ticker=ticker, payload=receipt(corpus["fundamental"])), FundamentalCatalystFeatures().compute(ticker=ticker, payload=corpus["fundamental"])
    yield "flow", adapter.option_flow(receipt(corpus["flow"])), OptionFlowFeatures().compute(OptionFlowSnapshot.model_validate(corpus["flow"]))


def test_all_six_native_results_match_characterized_source_and_literal_expectations(corpus):
    for name, result, native in cases(corpus):
        assert result.payload == freeze_native(native)
        assert result.native_json == native.to_json().encode() or json.loads(result.native_json) == native.to_json_dict()
        assert result.native_sha256 == hashlib.sha256(result.native_json).hexdigest()
        for key, expected in corpus["expected"][name].items():
            actual = result.payload[key]
            if isinstance(expected, (int, float)) and not isinstance(expected, bool):
                assert actual == pytest.approx(expected, abs=1e-12)
            else:
                assert actual == freeze_native(expected)
        assert not hasattr(result, "execution_authorized")
    structure = list(cases(corpus))[1][1]
    assert structure.payload["atr_percent"] == pytest.approx(2 / 105 * 100)


def test_deterministic_repeats_cover_all_six_complete_artifact_graphs(corpus):
    first, second = list(cases(corpus)), list(cases(copy.deepcopy(corpus)))
    for (_, result, _), (_, repeated, _) in zip(first, second, strict=True):
        assert result == repeated
        assert result.native_json == repeated.native_json
        assert result.identity_sha256 == repeated.identity_sha256


def test_results_detach_and_freeze_every_nested_container(corpus):
    source = receipt(corpus["flow"])
    result = ResearchAdapter(as_of=NOW).option_flow(source)
    corpus["flow"]["raw"]["nested"]["labels"].append("caller-mutated")
    decoded = source.decode()
    decoded["raw"]["nested"]["labels"].append("decoded-mutated")
    assert result.payload["raw"]["nested"]["labels"] == ("deterministic",)
    with pytest.raises(TypeError):
        result.payload["raw"]["nested"]["labels"][0] = "changed"
    with pytest.raises(TypeError):
        result.payload["raw"]["nested"]["other"] = True
    with pytest.raises(TypeError):
        result.input_identity["snapshot"]["source_sha256"] = "changed"
    with pytest.raises(FrozenInstanceError):
        result.native_json = b"changed"
    with pytest.raises(FrozenInstanceError):
        source.content = b"changed"


def test_shared_descendants_are_detached_without_freezing_caller_graph():
    shared = {"values": [1, 2]}
    raw = {"left": shared, "right": shared}
    result = freeze_native(raw)
    shared["values"].append(3)
    assert result["left"]["values"] == result["right"]["values"] == (1, 2)
    assert isinstance(result, MappingProxyType)


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), {1: "key"}, {1}, bytearray(b"a"), object()])
def test_freeze_rejects_non_native_unsupported_graphs(bad):
    with pytest.raises(ValueError):
        freeze_native(bad)


def test_freeze_rejects_cycles_and_excessive_depth():
    cyclic = []
    cyclic.append(cyclic)
    with pytest.raises(ValueError, match="cyclic"):
        freeze_native(cyclic)
    nested = []
    for _ in range(50):
        nested = [nested]
    with pytest.raises(ValueError, match="depth"):
        freeze_native(nested)


@pytest.mark.parametrize("content", [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}', b'\xff', b'{'])
def test_hash_bound_inputs_reject_ambiguous_invalid_or_nonfinite_json(content):
    with pytest.raises(ValueError):
        InputArtifact(content, hashlib.sha256(content).hexdigest(), NOW, NOW)


def test_input_digest_and_metadata_fail_closed():
    with pytest.raises(ValueError, match="digest mismatch"):
        InputArtifact(b"{}", "0" * 64, NOW, NOW)
    with pytest.raises(ValueError, match="SHA-256"):
        InputArtifact(b"{}", "G" * 64, NOW, NOW)
    with pytest.raises(ValueError, match="observation"):
        receipt({}, observed=NOW + timedelta(microseconds=1))
    with pytest.raises(ValueError, match="timezone"):
        receipt({}, observed=NOW.replace(tzinfo=None))
    with pytest.raises(ValueError, match="timezone"):
        ResearchAdapter(as_of=NOW.replace(tzinfo=None))
    with pytest.raises(ValueError, match="bounded"):
        InputArtifact(b"", hashlib.sha256(b"").hexdigest(), NOW, NOW)
    with pytest.raises(ValueError, match="bounded"):
        content = b" " * (8 * 1024 * 1024 + 1)
        InputArtifact(content, hashlib.sha256(content).hexdigest(), NOW, NOW)


def test_exact_availability_boundary_and_next_microsecond(corpus):
    artifact = receipt(corpus["flow"])
    ResearchAdapter(as_of=NOW).option_flow(artifact)
    with pytest.raises(ValueError, match="reference cutoff"):
        ResearchAdapter(as_of=NOW - timedelta(microseconds=1)).option_flow(artifact)


@pytest.mark.parametrize("key", ["as_of", "datetime", "timestamp", "observed_at", "published_at", "available_at", "captured_at", "fetched_at"])
def test_nested_future_metadata_is_rejected_even_inside_raw(corpus, key):
    corpus["flow"]["raw"]["nested"][key] = (NOW + timedelta(microseconds=1)).isoformat()
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).option_flow(receipt(corpus["flow"]))


@pytest.mark.parametrize("method", ["momentum", "market_structure"])
def test_future_bar_and_benchmark_cannot_leak_into_features(corpus, method):
    corpus["rows"][-1]["date"] = "2026-06-09"
    adapter = ResearchAdapter(as_of=NOW)
    with pytest.raises(ValueError, match="knowledge horizon"):
        getattr(adapter, method)(ticker="SYNTH", rows=receipt(corpus["rows"]))
    with pytest.raises(ValueError, match="knowledge horizon"):
        adapter.momentum(ticker="SYNTH", rows=receipt(corpus["benchmarkRows"]), spy_rows=receipt(corpus["rows"]))


def test_missing_row_time_or_invalid_shape_is_not_fabricated(corpus):
    adapter = ResearchAdapter(as_of=NOW)
    with pytest.raises(ValueError, match="timestamp"):
        adapter.momentum(ticker="SYNTH", rows=receipt([{"close": 1}, {"close": 2}]))
    with pytest.raises(ValueError, match="array"):
        adapter.market_structure(ticker="SYNTH", rows=receipt({}))
    with pytest.raises(ValueError, match="object"):
        adapter.volatility(ticker="SYNTH", payload=receipt([]))
    with pytest.raises(ValueError, match="observed input"):
        adapter.liquidity(ticker="SYNTH")


@pytest.mark.parametrize("timestamp", ["2026-06-08T12:00:00", "2026-06-08T12:00:00.000000001Z", True])
def test_native_boundary_does_not_silently_accept_naive_or_wire_nano_timestamps(corpus, timestamp):
    corpus["flow"]["as_of"] = timestamp
    with pytest.raises(ValueError):
        ResearchAdapter(as_of=NOW).option_flow(receipt(corpus["flow"]))


def test_future_schedule_allowed_but_realized_future_earnings_rejected(corpus):
    adapter = ResearchAdapter(as_of=NOW)
    result = adapter.fundamental_catalyst(ticker="SYNTH", payload=receipt(corpus["fundamental"]))
    assert "2026-07-31" in result.payload["earnings_dates"]
    corpus["fundamental"]["earnings"][0]["surprise_percent"] = 8.5
    with pytest.raises(ValueError, match="future earnings outcome"):
        adapter.fundamental_catalyst(ticker="SYNTH", payload=receipt(corpus["fundamental"]))


def test_explicit_observation_not_reference_cutoff_labels_missing_timestamp_payload():
    observed = NOW - timedelta(hours=1)
    result = ResearchAdapter(as_of=NOW).volatility(ticker="SYNTH", payload=receipt({"ivRank": .5}, observed=observed))
    assert result.payload["as_of"] == observed
    assert result.as_of == NOW
    assert isinstance(result.payload["iv_rank"], float)


def test_null_fundamental_payload_retains_native_missing_context():
    result = ResearchAdapter(as_of=NOW).fundamental_catalyst(ticker="SYNTH", payload=receipt(None))
    assert result.payload["financial_metric_changes"] == {}
    assert result.payload["market_cap"] is None


def setup_inputs(*, rejected=False):
    return {
        "candidate": _candidate(options_available=not rejected),
        "research_brief": _research_brief(),
        "flow_snapshot": _flow_snapshot(as_of=NOW - timedelta(days=5), put_premium=2500) if rejected else _flow_snapshot(),
        "market_structure": _market_structure(),
        "volatility": _volatility(iv_rank=.91) if rejected else _volatility(),
        "liquidity": _liquidity(spread=.42, viable_count=0, total_volume=0, total_open_interest=0) if rejected else _liquidity(),
        "fundamental_catalyst": _fundamental(earnings_dates=["2026-06-12"]) if rejected else _fundamental(),
        "market_regime": _market_regime("risk_on_growth"),
    }


@pytest.mark.parametrize("rejected", [False, True])
def test_complete_setup_output_and_ordered_rejection_trail_match_native(rejected):
    models = setup_inputs(rejected=rejected)
    native = SetupEngine().identify_setup(**models, as_of=NOW)
    inputs = {key: receipt(value) for key, value in models.items()}
    result = ResearchAdapter(as_of=NOW).identify_setup(**inputs)
    assert result.payload == freeze_native(native)
    assert result == ResearchAdapter(as_of=NOW).identify_setup(**inputs)
    if rejected:
        assert result.payload["setup_score"] == 49
        assert result.payload["rejection_reasons"] == (
            "no options liquidity", "flow contradicts thesis", "IV too high for long premium",
            "market regime conflict", "too close to earnings", "spread too wide", "stale data",
        )
    else:
        assert result.payload["setup_score"] == 94.44
        assert result.payload["confidence"] == .9444
        assert result.payload["score_components"]["fundamental_confirmation"] == .8333
        assert result.payload["rejection_reasons"] == ()
    models["research_brief"].source_refs[0].title = "changed after return"
    assert result.payload["research_brief"]["source_refs"][0]["title"] == "Photonics demand"
    with pytest.raises(TypeError):
        result.payload["research_brief"]["source_refs"][0]["title"] = "changed"


def test_missing_chain_stays_rejected_instead_of_fake_readiness():
    inputs = {"candidate": receipt(_candidate(options_available=None)), "research_brief": receipt(_research_brief()),
              "flow_snapshot": None, "market_structure": receipt(_market_structure(trend_label="range", breakout_status="none")),
              "volatility": receipt(_volatility())}
    result = ResearchAdapter(as_of=NOW).identify_setup(**inputs)
    assert result.payload["rejection_reasons"] == ("missing chain", "structure unclear")
    assert result.payload["score_components"]["fundamental_confirmation"] == .5
    assert "legs" not in result.payload


@pytest.mark.parametrize("name", ["flow_snapshot", "market_structure", "volatility", "liquidity", "market_regime"])
def test_setup_cannot_use_post_cutoff_snapshots(name):
    models = setup_inputs()
    models[name].as_of = NOW + timedelta(microseconds=1)
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).identify_setup(**{key: receipt(value) for key, value in models.items()})


def test_setup_rejects_mismatched_tickers_and_post_cutoff_source_evidence():
    models = setup_inputs()
    models["research_brief"].ticker = "OTHER"
    with pytest.raises(ValueError, match="ticker"):
        ResearchAdapter(as_of=NOW).identify_setup(**{key: receipt(value) for key, value in models.items()})
    models = setup_inputs()
    models["flow_snapshot"].notable_contracts[0].underlying = "OTHER"
    with pytest.raises(ValueError, match="underlying"):
        ResearchAdapter(as_of=NOW).identify_setup(**{key: receipt(value) for key, value in models.items()})
    models = setup_inputs()
    models["research_brief"].source_refs[0].timestamp = NOW + timedelta(seconds=1)
    with pytest.raises(ValueError, match="knowledge horizon"):
        ResearchAdapter(as_of=NOW).identify_setup(**{key: receipt(value) for key, value in models.items()})


def test_native_setup_id_is_legacy_but_receipt_identity_binds_reference_cutoff():
    inputs = {key: receipt(value) for key, value in setup_inputs().items()}
    first = ResearchAdapter(as_of=NOW).identify_setup(**inputs)
    later = ResearchAdapter(as_of=NOW + timedelta(days=3)).identify_setup(**inputs)
    assert first.payload["setup_id"] == later.payload["setup_id"]
    assert first.identity_sha256 != later.identity_sha256
    assert first.native_sha256 != later.native_sha256


def test_fixture_bytes_are_pinned_independently_of_native_output_identity():
    ledger = json.loads((FIXTURE.parents[2] / "provenance" / "fixtures.json").read_bytes())
    assert hashlib.sha256(FIXTURE.read_bytes()).hexdigest() == ledger["fixtures"][0]["sha256"]
