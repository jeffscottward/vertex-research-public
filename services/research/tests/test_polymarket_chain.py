"""Polymarket on-chain decoders and token ids (providers.polymarket_chain).

Needs the optional extra "prediction" (pycryptodome 4.6.0, duckdb 2.0.1; lock
requirements-prediction-linux-py312.lock). Without it the tests skip, unless
VERTEX_REQUIRE_PREDICTION=1 (the prediction run of scripts/ci/research-python.sh),
where a missing package is a failure. No network.
"""
from __future__ import annotations

import ast
import inspect
import json
from typing import Any

import pytest

from providers import polymarket_chain as chain
from tests.polymarket_fixtures import (
    MAKER,
    NEEDS_EXTRA,
    RESOLUTION_LOG,
    TAKER,
    TOKEN_OUTCOME_0,
    V2_EXCHANGE,
    fill_log,
    words,
)

pytestmark = NEEDS_EXTRA


def test_module_imports_only_the_standard_library_and_a_lazy_keccak() -> None:
    tree = ast.parse(inspect.getsource(chain))
    top = {alias.name.split(".")[0] for node in tree.body if isinstance(node, ast.Import) for alias in node.names}
    top |= {node.module.split(".")[0] for node in tree.body if isinstance(node, ast.ImportFrom) and node.module}
    assert top <= {"__future__", "json", "collections", "typing"}
    nested = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)} - {
        n.module for n in tree.body if isinstance(n, ast.ImportFrom)}
    assert nested == {"Crypto.Hash"}


def test_topic_constants_are_the_keccak_of_their_signatures() -> None:
    for signature, topic in ((chain.ORDER_FILLED_V1_SIGNATURE, chain.ORDER_FILLED_V1),
                             (chain.ORDER_FILLED_V2_SIGNATURE, chain.ORDER_FILLED_V2),
                             (chain.CONDITION_RESOLUTION_SIGNATURE, chain.CONDITION_RESOLUTION)):
        assert "0x" + chain.keccak256(signature.encode()).hex() == topic
    assert chain.keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def test_position_id_matches_a_token_traded_on_chain() -> None:
    condition = bytes.fromhex(RESOLUTION_LOG["topics"][1][2:])
    assert chain.position_id(chain.USDC_E, chain.collection_id(condition, 1)) == TOKEN_OUTCOME_0
    assert chain.position_id(chain.USDC_E, chain.collection_id(condition, 2)) != TOKEN_OUTCOME_0
    assert chain.position_id(chain.NEG_RISK_WRAPPED_COLLATERAL, chain.collection_id(condition, 1)) != TOKEN_OUTCOME_0
    for bad in ((condition[:31], 1), (condition, 0), (condition, 2 ** 256)):
        with pytest.raises(ValueError):
            chain.collection_id(*bad)


def test_decode_v2_buy_fill() -> None:
    log = fill_log()
    assert chain.decode_order_filled(log) == {
        "block_number": 0x5D6EF21, "block_time": 0x6B07A66F, "transaction_hash": log["transactionHash"],
        "log_index": 0xA5, "exchange": V2_EXCHANGE, "version": 2, "maker": MAKER, "taker": TAKER,
        "maker_asset_id": "0", "taker_asset_id": str(TOKEN_OUTCOME_0),
        "maker_amount": str(0x42C444), "taker_amount": str(0x42D560), "fee": "0",
    }


def test_decode_v2_sell_fill_bad_side_and_missing_time() -> None:
    row = chain.decode_order_filled(fill_log(side=1, token=5, maker_amount=300, taker_amount=100))
    assert (row["maker_asset_id"], row["taker_asset_id"], row["maker_amount"], row["taker_amount"]) == ("5", "0", "300", "100")
    with pytest.raises(ValueError, match="side"):
        chain.decode_order_filled(fill_log(side=2))
    log = fill_log()
    del log["blockTimestamp"]
    assert chain.decode_order_filled(log)["block_time"] is None


def _v1_log(*values: int) -> dict[str, Any]:
    log = fill_log()
    log.update(address=chain.EXCHANGES_V1[0], data=words(*values))
    log["topics"] = [chain.ORDER_FILLED_V1, *log["topics"][1:]]
    return log


def test_decode_v1_fill_keeps_asset_ids() -> None:
    row = chain.decode_order_filled(_v1_log(0, 9, 40, 100, 7))
    assert (row["version"], row["maker_asset_id"], row["taker_asset_id"], row["fee"]) == (1, "0", "9", "7")
    with pytest.raises(ValueError, match="five"):
        chain.decode_order_filled(_v1_log(0, 9, 40, 100))


@pytest.mark.parametrize("change", [
    {"topics": fill_log()["topics"][:3]},
    {"address": chain.EXCHANGES_V1[0]},  # a version 2 topic from a version 1 exchange
    {"data": "0x" + "00" * 31},
    {"data": "0x" + "00" * 64},
    {"data": "nothex"},
    {"blockNumber": 12},
    {"transactionHash": "0x12"},
    {"topics": [chain.ORDER_FILLED_V2, "0x" + "cd" * 32, "0x" + "11" * 32, "0x" + "00" * 32]},
])
def test_decode_fill_rejects_bad_logs(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        chain.decode_order_filled({**fill_log(), **change})


def test_decode_resolution_and_market_rows() -> None:
    resolution = chain.decode_condition_resolution(RESOLUTION_LOG)
    assert resolution["payout_numerators"] == (1, 0)
    assert resolution["oracle"] == "0x65070be91477460d8a7aeeb94ef92fe056c2f2a7"
    rows = chain.market_rows(resolution)
    assert [row["collateral"] for row in rows] == list(chain.COLLATERALS)
    usdc = rows[0]
    assert usdc["closed"] is True and json.loads(usdc["outcome_prices"]) == ["1.0", "0.0"]
    assert json.loads(usdc["clob_token_ids"])[0] == str(TOKEN_OUTCOME_0)
    assert set(usdc) == set(chain.MARKET_COLUMNS)


@pytest.mark.parametrize(("payouts", "count"), [((0, 0), 0), ((1, 1, 0), 0), ((1, 1), 2)])
def test_market_rows_only_for_binary_conditions_with_payouts(payouts: tuple[int, ...], count: int) -> None:
    resolution = dict(chain.decode_condition_resolution(RESOLUTION_LOG), payout_numerators=payouts)
    assert len(chain.market_rows(resolution)) == count


@pytest.mark.parametrize("change", [
    {"address": V2_EXCHANGE},
    {"topics": RESOLUTION_LOG["topics"][:3]},
    {"data": words(2, 32, 2, 1, 0)},
    {"data": words(3, 64, 2, 1, 0)},
    {"data": words(2, 64)},
])
def test_decode_resolution_rejects_bad_logs(change: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        chain.decode_condition_resolution({**RESOLUTION_LOG, **change})


def test_maker_order_rows() -> None:
    assert chain.is_maker_order_row({"taker": TAKER})
    assert not chain.is_maker_order_row({"taker": V2_EXCHANGE.upper().replace("0X", "0x")})
    assert chain.is_maker_order_row({})
