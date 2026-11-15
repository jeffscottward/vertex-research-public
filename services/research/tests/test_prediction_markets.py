"""Smoke tests for the prediction-market calibration port (synthetic rows only)."""
import ast
from pathlib import Path

import pytest

from providers.prediction_markets import (
    Position,
    SkippedRows,
    calibration_by_price,
    kalshi_calibration,
    kalshi_positions,
    kalshi_resolution,
    polymarket_calibration,
    polymarket_positions,
    polymarket_token_resolution,
)

ROOT = Path(__file__).resolve().parents[1]

KALSHI_MARKETS = [
    {"ticker": "A", "status": "finalized", "result": "yes"},
    {"ticker": "B", "status": "finalized", "result": "no"},
    {"ticker": "C", "status": "open", "result": ""},
]
KALSHI_TRADES = [
    {"ticker": "A", "yes_price": 60, "no_price": 40, "taker_side": "yes"},
    {"ticker": "B", "yes_price": 30, "no_price": 70, "taker_side": "yes"},
    {"ticker": "C", "yes_price": 50, "no_price": 50, "taker_side": "no"},
]
POLY_MARKETS = [
    {"closed": True, "outcome_prices": '["0.995", "0.005"]', "clob_token_ids": '["111", "222"]'},
    {"closed": True, "outcome_prices": '["0.5", "0.5"]', "clob_token_ids": '["333", "444"]'},
    {"closed": False, "outcome_prices": '["1", "0"]', "clob_token_ids": '["555", "666"]'},
    {"closed": True, "outcome_prices": "not json", "clob_token_ids": '["777", "888"]'},
]
POLY_TRADES = [
    # Maker pays 0.65 USDC per winning token 111: buyer 65 won, counterparty 35 lost.
    {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 650_000, "taker_amount": 1_000_000},
    # Maker sells losing token 222 at 0.125: 12.5 rounds half away from zero to 13; counterparty 87.5 -> 88.
    {"maker_asset_id": "222", "taker_asset_id": "0", "maker_amount": 1_000_000, "taker_amount": 125_000},
    {"maker_asset_id": "0", "taker_asset_id": "333", "maker_amount": 500_000, "taker_amount": 1_000_000},
    {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 0, "taker_amount": 1_000_000},
]


def test_kalshi_taker_and_maker_positions_on_resolved_markets_only():
    positions = list(kalshi_positions(KALSHI_TRADES, kalshi_resolution(KALSHI_MARKETS)))
    assert positions == [Position(60, True), Position(40, False), Position(30, False), Position(70, True)]


def test_polymarket_resolution_and_positions_match_upstream_rounding():
    token_won = polymarket_token_resolution(POLY_MARKETS)
    assert token_won == {"111": True, "222": False}
    assert list(polymarket_positions(POLY_TRADES, token_won)) == [
        Position(65, True), Position(35, False), Position(13, False), Position(88, True)]


def test_polymarket_half_cent_prices_round_like_upstream_sql():
    # 100 * 23 / 40 = 57.5 -> 58 and 42.5 -> 43; dividing first gives 57.49999 -> 57.
    trade = {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 23, "taker_amount": 40}
    assert list(polymarket_positions([trade], {"111": True})) == [Position(58, True), Position(43, False)]
    trade = {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 5_750_000, "taker_amount": 10_000_000}
    assert next(polymarket_positions([trade], {"111": True})) == Position(58, True)
    # 0.49999999999999994 is below a half cent: price 0, not 1 (adding 0.5 first gives exactly 1.0).
    trade = {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 35_000_000_000_000,
             "taker_amount": 7_000_000_000_000_001}
    assert list(polymarket_positions([trade], {"111": True})) == [Position(0, True), Position(100, False)]


def test_calibration_scores_from_hand_computed_values():
    report = calibration_by_price(kalshi_positions(KALSHI_TRADES, kalshi_resolution(KALSHI_MARKETS)))
    assert [(b.price_cents, b.total_trades, b.wins) for b in report.buckets] == [(30, 1, 0), (40, 1, 0), (60, 1, 1),
                                                                               (70, 1, 1)]
    assert report.total_trades == 4
    assert report.brier_score == 0.125  # (0.16 + 0.16 + 0.09 + 0.09) / 4
    assert report.ece == 0.35  # (0.4 + 0.4 + 0.3 + 0.3) / 4
    assert report.log_loss == pytest.approx(0.43375, abs=1e-4)


def test_empty_or_out_of_range_input_is_unavailable_not_a_perfect_score():
    report = calibration_by_price([Position(0, False), Position(100, True)])
    assert (report.total_trades, report.out_of_range_positions, report.available) == (0, 2, False)
    assert (report.brier_score, report.log_loss, report.ece) == (None, None, None)
    assert calibration_by_price([]).buckets == ()


def test_no_resolved_markets_gives_unavailable_scores():
    report = polymarket_calibration(POLY_MARKETS[1:], POLY_TRADES)
    assert (report.available, report.brier_score, report.ece) == (False, None, None)


def test_venue_calibration_reads_each_iterable_once_and_counts_skipped_rows():
    # Iterators can be read only once: markets fully first, then trades.
    kalshi = kalshi_calibration(iter(KALSHI_MARKETS), iter(KALSHI_TRADES))
    assert (kalshi.total_trades, kalshi.skipped_rows, kalshi.available) == (4, 0, True)
    polymarket = polymarket_calibration(iter(POLY_MARKETS), iter(POLY_TRADES))
    assert [b.price_cents for b in polymarket.buckets] == [13, 35, 65, 88]
    assert polymarket.skipped_rows == 1  # the zero-amount trade


def test_invalid_kalshi_rows_are_skipped():
    rows = [{"ticker": "A", "yes_price": 1, "no_price": 99, "taker_side": "maybe"},
            {"ticker": "A", "yes_price": None, "no_price": 99, "taker_side": "yes"},
            {"ticker": "A", "yes_price": 20, "no_price": 80, "taker_side": "no"}]
    skipped = SkippedRows()
    assert list(kalshi_positions(rows, {"A": "yes"}, skipped)) == [Position(80, False), Position(20, True)]
    assert skipped.count == 2


def test_bad_rows_do_not_stop_the_run():
    # A finalized market without a ticker is left out; an infinite price is a skipped, counted row.
    assert kalshi_resolution([{"status": "finalized", "result": "yes"}, KALSHI_MARKETS[0]]) == {"A": "yes"}
    skipped = SkippedRows()
    rows = [{"ticker": "A", "yes_price": float("inf"), "no_price": 1, "taker_side": "yes"}]
    assert list(kalshi_positions(rows, {"A": "yes"}, skipped)) == []
    amounts = [{"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": float("inf"), "taker_amount": 10}]
    assert list(polymarket_positions(amounts, {"111": True}, skipped)) == []
    assert skipped.count == 2


def test_rows_without_a_join_key_never_join():
    # A missing ticker, asset id or token id is not the text "None".
    resolution = kalshi_resolution([{"ticker": "None", "status": "finalized", "result": "yes"}])
    trade = {"yes_price": 60, "no_price": 40, "taker_side": "yes"}
    assert list(kalshi_positions([trade], resolution)) == []
    token_won = polymarket_token_resolution(
        [{"closed": True, "outcome_prices": '["1", "0"]', "clob_token_ids": '["111", null]'}])
    assert token_won == {"111": True}
    no_token = {"maker_asset_id": None, "taker_asset_id": "0", "maker_amount": 10, "taker_amount": 5}
    assert list(polymarket_positions([no_token], {"None": True})) == []
    # NaN is the missing marker of some row readers; it never joins either.
    nan = float("nan")
    assert kalshi_resolution([{"ticker": nan, "status": "finalized", "result": "yes"}]) == {}
    assert list(kalshi_positions([dict(trade, ticker=nan)], {"nan": "yes"})) == []
    assert polymarket_token_resolution(
        [{"closed": True, "outcome_prices": '["1", "0"]', "clob_token_ids": '[NaN, "222"]'}]) == {"222": False}
    assert list(polymarket_positions([dict(no_token, maker_asset_id=nan)], {"nan": True})) == []


def test_fractional_boolean_and_oversized_numbers_are_skipped_and_counted():
    skipped = SkippedRows()
    kalshi = [{"ticker": "A", "yes_price": 30.7, "no_price": 69.3, "taker_side": "yes"},
              {"ticker": "A", "yes_price": True, "no_price": 99, "taker_side": "yes"},
              {"ticker": "A", "yes_price": "30", "no_price": 70.0, "taker_side": "yes"}]
    assert list(kalshi_positions(kalshi, {"A": "yes"}, skipped)) == [Position(30, True), Position(70, False)]
    poly = [{"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 1.9, "taker_amount": 3},
            {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 10 ** 400, "taker_amount": 3},
            {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 10 ** 307, "taker_amount": 3},
            {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": "1" * 5000, "taker_amount": 3},
            {"maker_asset_id": 10 ** 5000, "taker_asset_id": "0", "maker_amount": 3, "taker_amount": 1}]
    assert list(polymarket_positions(poly, {"111": True}, skipped)) == []
    assert skipped.count == 7
    # More digits than the interpreter converts: the row is skipped, and the run goes on.
    digits = [{"ticker": "A", "yes_price": "1" * 5000, "no_price": 1, "taker_side": "yes"},
              {"ticker": 10 ** 5000, "yes_price": 60, "no_price": 40, "taker_side": "yes"}]
    assert list(kalshi_positions(digits, {"A": "yes"}, skipped)) == []
    assert skipped.count == 9
    assert kalshi_resolution([{"ticker": 10 ** 5000, "status": "finalized", "result": "yes"}]) == {}
    assert polymarket_token_resolution(
        [{"closed": True, "outcome_prices": '["1", "0"]', "clob_token_ids": [10 ** 5000, 1]}]) == {}


def test_only_whole_numbers_of_plain_types_are_read_as_prices():
    class IndexOnly:  # has __index__ but is not an integer type (like a numpy boolean or array)
        def __index__(self):
            return 1

    skipped = SkippedRows()
    rows = [{"ticker": "A", "yes_price": price, "no_price": 50, "taker_side": "yes"}
            for price in (IndexOnly(), "30.0", "1e2", "1_000", b"30", [30], float("nan"))]
    assert list(kalshi_positions(rows, {"A": "yes"}, skipped)) == []
    assert skipped.count == 7
    good = [{"ticker": "A", "yes_price": price, "no_price": 70, "taker_side": "yes"} for price in (30, 30.0, " 30 ", "+30")]
    assert list(kalshi_positions(good, {"A": "yes"}, skipped)) == [Position(30, True), Position(70, False)] * 4
    assert skipped.count == 7


def test_oversized_outcome_price_is_not_resolved():
    huge = "[1" + "0" * 400 + ", 0]"
    rows = [{"closed": True, "outcome_prices": huge, "clob_token_ids": '["111", "222"]'}]
    assert polymarket_token_resolution(rows) == {}


def test_market_fields_of_another_shape_are_not_resolved():
    rows = [{"closed": True, "outcome_prices": {"1": 0, "0": 0}, "clob_token_ids": '["111", "222"]'},
            {"closed": True, "outcome_prices": "", "clob_token_ids": '["333", "444"]'},
            {"closed": True, "outcome_prices": ["1", "0"], "clob_token_ids": ("555", "666")}]
    assert polymarket_token_resolution(rows) == {"555": True, "666": False}


def test_polymarket_half_cent_sides_sum_to_101_as_upstream():
    # 100 * 305 / 1000 = 30.5 -> 31 and 100 - 30.5 = 69.5 -> 70: each side is rounded on its own.
    trade = {"maker_asset_id": "0", "taker_asset_id": "111", "maker_amount": 305, "taker_amount": 1000}
    assert list(polymarket_positions([trade], {"111": True})) == [Position(31, True), Position(70, False)]


def test_domain_module_has_no_io_vendor_or_order_imports():
    tree = ast.parse((ROOT / "providers" / "prediction_markets.py").read_text())
    modules = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    modules |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
    assert modules <= {"__future__", "json", "math", "numbers", "collections", "dataclasses", "typing"}

