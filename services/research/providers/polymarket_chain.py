"""Polymarket on-chain rows: decode exchange fills and ConditionalTokens resolutions from Polygon logs.

Research only. The functions here are pure: they turn ``eth_getLogs`` log
objects (as a JSON-RPC endpoint returns them) into the row shape that
``providers.prediction_markets`` reads, so the calibration code does not change.
They do not contact a network, read an account, or place or simulate orders.
Design, chain facts and their checks: docs/vertex-rebuild/prediction-market-onchain-sample.md.

* Trade rows keep the upstream column names: ``maker_asset_id`` and
  ``taker_asset_id`` (``"0"`` is collateral), ``maker_amount`` and
  ``taker_amount``. Ids and amounts are decimal text, because they are 256-bit
  integers. Exchange version 2 logs carry ``side`` and ``tokenId`` instead of
  two asset ids; a BUY maker gives collateral and a SELL maker gives tokens.
* Market rows hold one resolved binary condition for one collateral, with
  ``outcome_prices`` (payout fractions) and ``clob_token_ids`` (the two
  computed outcome token ids) as JSON text pairs, as the upstream market table
  does.
* Outcome token ids are ConditionalTokens position ids. The collection id uses
  the alt_bn128 curve method of the Gnosis ConditionalTokens contracts; Keccak-256
  comes from pycryptodome (optional extra ``prediction``), imported only when an
  id is computed.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

# Polygon contracts (lower case). Checked against chain data on 2026-11-25.
CONDITIONAL_TOKENS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"
USDC_E = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
# wcol() of the NegRisk adapter 0xd91e80cf2e7be2e162c6513ced06f1dd0da35296.
NEG_RISK_WRAPPED_COLLATERAL = "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2"
EXCHANGES_V1 = ("0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", "0xc5d563a36ae78145c45a50134d48a1215220f80a")
EXCHANGES_V2 = ("0xe111180000d2663c0091e4f400237545b87b996b", "0xe2222d279d744050d28e00520010520000310f59")
EXCHANGES = EXCHANGES_V1 + EXCHANGES_V2
COLLATERALS = (USDC_E, NEG_RISK_WRAPPED_COLLATERAL)

# Keccak-256 of the event signatures (tests recompute them).
ORDER_FILLED_V1_SIGNATURE = "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"
ORDER_FILLED_V2_SIGNATURE = "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)"
CONDITION_RESOLUTION_SIGNATURE = "ConditionResolution(bytes32,address,bytes32,uint256,uint256[])"
ORDER_FILLED_V1 = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6"
ORDER_FILLED_V2 = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"
CONDITION_RESOLUTION = "0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894"

# Field prime of alt_bn128; the curve is y^2 = x^3 + 3.
_P = 0x30644E72E131A029B85045B68181585D97816A916871CA8D3C208C16D87CFD47
_B = 3
_WORD = 64  # hex digits in one 32-byte word

TRADE_COLUMNS = ("block_number", "block_time", "transaction_hash", "log_index", "exchange", "version",
                 "maker", "taker", "maker_asset_id", "taker_asset_id", "maker_amount", "taker_amount", "fee")
MARKET_COLUMNS = ("condition_id", "collateral", "closed", "outcome_prices", "clob_token_ids",
                  "block_number", "block_time")


def keccak256(data: bytes) -> bytes:
    """Keccak-256 (the Ethereum hash, not NIST SHA3-256)."""
    from Crypto.Hash import keccak  # Optional extra "prediction"; imported only here.

    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return digest.digest()


def _hex_bytes(value: Any, length: int | None = None) -> bytes:
    """Bytes of a ``0x`` hex string; ``ValueError`` for anything else or a wrong length."""
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError("expected 0x hex text")
    raw = bytes.fromhex(value[2:])
    if length is not None and len(raw) != length:
        raise ValueError(f"expected {length} bytes")
    return raw


def _words(data: Any) -> list[int]:
    raw = _hex_bytes(data)
    if len(raw) % 32:
        raise ValueError("data is not whole 32-byte words")
    return [int.from_bytes(raw[i:i + 32], "big") for i in range(0, len(raw), 32)]


def _address(topic: Any) -> str:
    word = _hex_bytes(topic, 32)
    if any(word[:12]):
        raise ValueError("address topic has high bytes")
    return "0x" + word[12:].hex()


def _quantity(value: Any) -> int:
    """A JSON-RPC quantity (``0x`` hex text) as ``int``."""
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError("expected 0x quantity")
    return int(value, 16)


def _log_position(log: Mapping[str, Any]) -> dict[str, Any]:
    timestamp = log.get("blockTimestamp")
    return {
        "block_number": _quantity(log.get("blockNumber")),
        "block_time": None if timestamp is None else _quantity(timestamp),
        "transaction_hash": "0x" + _hex_bytes(log.get("transactionHash"), 32).hex(),
        "log_index": _quantity(log.get("logIndex")),
    }


def decode_order_filled(log: Mapping[str, Any]) -> dict[str, Any]:
    """One trade row from a version 1 or version 2 ``OrderFilled`` log.

    ``ValueError`` for a log that is not an ``OrderFilled`` log of a known
    exchange, has the wrong number of topics or data words, or has a version 2
    side other than 0 (BUY) or 1 (SELL). The caller counts such logs.
    """
    topics = log.get("topics")
    if not isinstance(topics, list) or len(topics) != 4:
        raise ValueError("OrderFilled needs four topics")
    exchange = str(log.get("address", "")).lower()
    topic = str(topics[0]).lower()
    words = _words(log.get("data"))
    if topic == ORDER_FILLED_V1 and exchange in EXCHANGES_V1:
        if len(words) != 5:
            raise ValueError("version 1 OrderFilled needs five data words")
        maker_asset, taker_asset, maker_amount, taker_amount, fee = words
        version = 1
    elif topic == ORDER_FILLED_V2 and exchange in EXCHANGES_V2:
        if len(words) != 7:
            raise ValueError("version 2 OrderFilled needs seven data words")
        side, token, maker_amount, taker_amount, fee = words[:5]
        if side == 0:  # BUY: the maker gives collateral and receives the token.
            maker_asset, taker_asset = 0, token
        elif side == 1:  # SELL: the maker gives the token and receives collateral.
            maker_asset, taker_asset = token, 0
        else:
            raise ValueError("unknown side")
        version = 2
    else:
        raise ValueError("not an OrderFilled log of a known exchange")
    return {
        **_log_position(log),
        "exchange": exchange,
        "version": version,
        "maker": _address(topics[2]),
        "taker": _address(topics[3]),
        "maker_asset_id": str(maker_asset),
        "taker_asset_id": str(taker_asset),
        "maker_amount": str(maker_amount),
        "taker_amount": str(taker_amount),
        "fee": str(fee),
    }


def decode_condition_resolution(log: Mapping[str, Any]) -> dict[str, Any]:
    """Condition id, oracle, question id and payout numerators of a ``ConditionResolution`` log.

    ``ValueError`` for another log, a log from another contract, or data that
    does not hold one ``uint256[]`` of ``outcomeSlotCount`` entries.
    """
    topics = log.get("topics")
    if (not isinstance(topics, list) or len(topics) != 4 or str(topics[0]).lower() != CONDITION_RESOLUTION
            or str(log.get("address", "")).lower() != CONDITIONAL_TOKENS):
        raise ValueError("not a ConditionResolution log")
    words = _words(log.get("data"))
    if len(words) < 3 or words[1] != 64:
        raise ValueError("unexpected ConditionResolution data layout")
    slots, count = words[0], words[2]
    payouts = words[3:]
    if count != slots or len(payouts) != count:
        raise ValueError("payout count does not match the outcome slot count")
    return {
        **_log_position(log),
        "condition_id": "0x" + _hex_bytes(topics[1], 32).hex(),
        "oracle": _address(topics[2]),
        "question_id": "0x" + _hex_bytes(topics[3], 32).hex(),
        "payout_numerators": tuple(payouts),
    }


def collection_id(condition_id: bytes, index_set: int) -> bytes:
    """Collection id of one outcome set of a condition, with no parent collection.

    The Gnosis ConditionalTokens method: hash the condition id and the index
    set, take the result as an x coordinate on alt_bn128 (stepping x up until
    x^3 + 3 is a square), choose the y root with the parity of the hash's top
    bit, and store the y parity in bit 254 of x.
    """
    if len(condition_id) != 32 or not 0 < index_set < 2 ** 256:
        raise ValueError("condition id must be 32 bytes and the index set a positive uint256")
    x = int.from_bytes(keccak256(condition_id + index_set.to_bytes(32, "big")), "big")
    odd = x >> 255 != 0
    while True:
        x = (x + 1) % _P
        yy = (pow(x, 3, _P) + _B) % _P
        y = pow(yy, (_P + 1) // 4, _P)  # _P % 4 == 3, so this is a square root when one exists.
        if y * y % _P == yy:
            break
    if odd != (y % 2 == 1):
        y = _P - y
    if y & 1:
        x ^= 1 << 254
    return x.to_bytes(32, "big")


def position_id(collateral: str, collection: bytes) -> int:
    """ConditionalTokens position id (the ERC-1155 token id) of a collateral and a collection."""
    return int.from_bytes(keccak256(_hex_bytes(collateral, 20) + collection), "big")


def market_rows(resolution: Mapping[str, Any], collaterals: tuple[str, ...] = COLLATERALS) -> list[dict[str, Any]]:
    """Market rows of one decoded resolution: one row per collateral for a binary condition.

    ``[]`` for a condition with other than two outcomes or with payouts that sum
    to zero; the caller counts these. Only one collateral's token ids can match
    traded tokens; the other row never joins.
    """
    payouts = resolution["payout_numerators"]
    total = sum(payouts)
    if len(payouts) != 2 or total <= 0:
        return []
    condition = _hex_bytes(resolution["condition_id"], 32)
    prices = json.dumps([str(payout / total) for payout in payouts])
    collections = (collection_id(condition, 1), collection_id(condition, 2))
    return [{
        "condition_id": resolution["condition_id"],
        "collateral": collateral,
        "closed": True,
        "outcome_prices": prices,
        "clob_token_ids": json.dumps([str(position_id(collateral, c)) for c in collections]),
        "block_number": resolution["block_number"],
        "block_time": resolution["block_time"],
    } for collateral in collaterals]


def is_maker_order_row(row: Mapping[str, Any]) -> bool:
    """True for a maker-order fill row; False for the taker's aggregate row, whose ``taker`` is an exchange.

    Addresses are compared in lower case against all four exchange contracts.
    """
    return str(row.get("taker", "")).lower() not in EXCHANGES
