"""DuckDB Parquet reader parity (providers.prediction_market_parquet).

The same rows give the same report in memory (providers.prediction_markets) and
through Parquet files read with DuckDB, including bad rows, 77-digit token ids,
the maker-row filter and the resolution horizon. Needs the optional extra
"prediction" (see tests/polymarket_fixtures.py). Synthetic rows only; no network.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from providers.prediction_markets import polymarket_calibration
from tests.polymarket_fixtures import NEEDS_EXTRA, V2_EXCHANGE

pytestmark = NEEDS_EXTRA

TOKEN_A = str(2 ** 255 + 12345)  # 77 digits: does not fit DuckDB HUGEINT or DECIMAL(38)
TOKEN_B = str(2 ** 254 + 7)
TOKEN_C = "31"
TOKEN_D = "32"
MARKETS: list[dict[str, Any]] = [
    {"condition_id": "0xaa", "closed": True, "outcome_prices": json.dumps(["1.0", "0.0"]),
     "clob_token_ids": json.dumps([TOKEN_A, TOKEN_B]), "block_number": 1_000},
    {"condition_id": "0xbb", "closed": True, "outcome_prices": json.dumps(["0.0", "1.0"]),
     "clob_token_ids": json.dumps([TOKEN_C, TOKEN_D]), "block_number": 5_000},
    {"condition_id": "0xcc", "closed": True, "outcome_prices": json.dumps(["0.5", "0.5"]),
     "clob_token_ids": json.dumps(["41", "42"]), "block_number": 900},
    {"condition_id": "0xdd", "closed": False, "outcome_prices": "not json", "clob_token_ids": "[]", "block_number": 0},
]


def _trade(maker_asset: str, taker_asset: str, maker_amount: str, taker_amount: str, block: int,
           taker: str = "0x" + "00" * 18 + "0b0b") -> dict[str, Any]:
    return {"maker_asset_id": maker_asset, "taker_asset_id": taker_asset, "maker_amount": maker_amount,
            "taker_amount": taker_amount, "block_number": block, "taker": taker}


TRADES: list[dict[str, Any]] = [
    _trade("0", TOKEN_A, "30", "100", 900),          # buyer of A at 30 (won)
    _trade(TOKEN_A, "0", "100", "55", 100),          # seller of A at 55, fill 900 blocks before resolution
    _trade("0", TOKEN_B, "305", "1000", 990, V2_EXCHANGE),  # aggregate taker row, 30.5 rounds half away
    _trade("0", TOKEN_C, "80", "100", 4_990),         # buyer of C at 80 (lost)
    _trade("0", TOKEN_D, "1", "0", 4_990),            # zero amount: skipped and counted
    _trade("0", TOKEN_D, "x1", "5", 4_990),           # unreadable amount: skipped and counted
    _trade("0", "41", "50", "100", 800),             # split payout market: no join
    _trade("0", "999", "50", "100", 800),            # unknown token: no join
]


def _write(rows: list[dict[str, Any]], path: Path, types: dict[str, str]) -> Path:
    import duckdb

    columns = list(types)
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE t (" + ", ".join(f'"{c}" {types[c]}' for c in columns) + ")")
        connection.executemany(f"INSERT INTO t VALUES ({', '.join('?' for _ in columns)})",
                               [[row[c] for c in columns] for row in rows])
        connection.execute("COPY t TO ? (FORMAT parquet)", [str(path)])
    return path


@pytest.fixture
def files(tmp_path: Path) -> tuple[Path, Path]:
    markets = _write(MARKETS, tmp_path / "markets.parquet", {
        "condition_id": "VARCHAR", "closed": "BOOLEAN", "outcome_prices": "VARCHAR",
        "clob_token_ids": "VARCHAR", "block_number": "BIGINT"})
    trades = _write(TRADES, tmp_path / "trades.parquet", {
        "maker_asset_id": "VARCHAR", "taker_asset_id": "VARCHAR", "maker_amount": "VARCHAR",
        "taker_amount": "VARCHAR", "block_number": "BIGINT", "taker": "VARCHAR"})
    return markets, trades


def test_parquet_report_equals_the_in_memory_report(files: tuple[Path, Path]) -> None:
    from providers.prediction_market_parquet import polymarket_calibration_from_parquet

    expected = polymarket_calibration(MARKETS, TRADES)
    actual = polymarket_calibration_from_parquet(*files)
    assert actual == expected
    assert (actual.total_trades, actual.skipped_rows) == (8, 2)
    assert {b.price_cents for b in actual.buckets} >= {30, 31, 70, 80, 20}


def test_maker_rows_only_and_horizon_equal_the_filtered_in_memory_report(files: tuple[Path, Path]) -> None:
    from providers.prediction_market_parquet import polymarket_calibration_from_parquet

    makers = [row for row in TRADES if row["taker"] != V2_EXCHANGE]
    assert polymarket_calibration_from_parquet(*files, maker_rows_only=True) == polymarket_calibration(MARKETS, makers)
    # Horizon 100: the seller row (900 blocks before resolution) and rows on unresolved tokens drop out.
    near = [TRADES[0], TRADES[2], TRADES[3], TRADES[4], TRADES[5]]
    assert polymarket_calibration_from_parquet(*files, horizon_blocks=100) == polymarket_calibration(MARKETS, near)


def test_iter_parquet_rows_checks_arguments(files: tuple[Path, Path]) -> None:
    from providers.prediction_market_parquet import iter_parquet_rows

    rows = list(iter_parquet_rows(files[0], ["condition_id", "closed"], batch_rows=1))
    assert rows[0] == {"condition_id": "0xaa", "closed": True} and len(rows) == 4
    for columns, batch in ((["x; DROP"], 10), ([], 10), (["closed"], 0)):
        with pytest.raises(ValueError):
            list(iter_parquet_rows(files[0], columns, batch_rows=batch))


def test_condition_bootstrap_and_cli(files: tuple[Path, Path]) -> None:
    from providers.prediction_market_parquet import condition_bootstrap, main

    boot = condition_bootstrap(*files, draws=50, seed=1)
    assert boot.conditions == 2 and boot.draws == 50
    assert boot.brier.low is not None and boot.brier.high is not None and boot.brier.low <= boot.brier.high
    with pytest.raises(ValueError):
        condition_bootstrap(*files, draws=0)
    lines: list[str] = []
    assert main(["--markets", str(files[0]), "--trades", str(files[1]), "--bootstrap", "20",
                 "--horizon-blocks", "100000"], out=lines.append) == 0
    text = lines[0]
    assert "positions in 1..99 cents: 8" in text and "conditions: 2" in text and "21-30 | " in text
    lines.clear()
    assert main(["--markets", str(files[0]), "--trades", str(files[1]), "--maker-rows-only"], out=lines.append) == 0
    assert "bootstrap" not in lines[0]


def test_bootstrap_without_joined_markets_has_no_interval(tmp_path: Path) -> None:
    from providers.prediction_market_parquet import condition_bootstrap

    markets = _write(MARKETS[2:], tmp_path / "m.parquet", {
        "condition_id": "VARCHAR", "closed": "BOOLEAN", "outcome_prices": "VARCHAR",
        "clob_token_ids": "VARCHAR", "block_number": "BIGINT"})
    trades = _write(TRADES[:1], tmp_path / "t.parquet", {
        "maker_asset_id": "VARCHAR", "taker_asset_id": "VARCHAR", "maker_amount": "VARCHAR",
        "taker_amount": "VARCHAR", "block_number": "BIGINT", "taker": "VARCHAR"})
    boot = condition_bootstrap(markets, trades, draws=5)
    assert boot.conditions == 0 and boot.brier.low is None
