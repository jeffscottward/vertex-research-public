"""Shared fixtures for the Polymarket on-chain tests (not a test module).

``RESOLUTION_LOG`` keeps the real condition id, oracle contract and question id
of a ConditionResolution log of 2026-11-25 (block 0x5d6ef3f) so the token id
test checks the real derivation; ``TOKEN_OUTCOME_0`` is outcome 0 of that
condition with USDC.e collateral, a token that traded on chain. Wallet
addresses, order hashes and transaction hashes are synthetic, so no trader
appears in this public repository.
"""
from __future__ import annotations

import importlib.util
import json
import os
from typing import Any

import pytest

INSTALLED = all(importlib.util.find_spec(name) is not None for name in ("Crypto", "duckdb"))
if os.environ.get("VERTEX_REQUIRE_PREDICTION") == "1" and not INSTALLED:
    raise RuntimeError("VERTEX_REQUIRE_PREDICTION=1 but pycryptodome or duckdb is not installed")
NEEDS_EXTRA = pytest.mark.skipif(not INSTALLED, reason="extra 'prediction' (pycryptodome, duckdb) not installed")

V2_EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b"
MAKER = "0x" + "00" * 17 + "0a11ce"
TAKER = "0x" + "00" * 18 + "0b0b"
TOKEN_OUTCOME_0 = 2853587501996331168240397538225952061928550892051931092381130247510245474802


def words(*values: int) -> str:
    return "0x" + "".join(f"{value:064x}" for value in values)


def topic_address(address: str) -> str:
    return "0x" + "00" * 12 + address[2:]


RESOLUTION_LOG: dict[str, Any] = {
    "address": "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
    "topics": [
        "0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894",
        "0xe9bf9790e9ff9536e9e480d3672a4d712d848e5edb22991b4295500aff460e7b",
        "0x00000000000000000000000065070be91477460d8a7aeeb94ef92fe056c2f2a7",
        "0x9e4ccb19287e8df4edee39dbc3b0589c1c9862311aecbcfe935ff7cd0721a8f8",
    ],
    "data": words(2, 64, 2, 1, 0),
    "blockNumber": "0x5d6ef3f",
    "blockTimestamp": "0x6b07a69c",
    "transactionHash": "0x" + "ab" * 32,
    "logIndex": "0x5a",
}


def fill_log(side: int = 0, token: int = TOKEN_OUTCOME_0, maker_amount: int = 0x42C444,
             taker_amount: int = 0x42D560, block: int = 0x5D6EF21, index: int = 0xA5,
             taker: str = TAKER) -> dict[str, Any]:
    """A version 2 OrderFilled log (synthetic hashes and wallets)."""
    return {
        "address": V2_EXCHANGE,
        "topics": ["0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee", "0x" + "cd" * 32,
                   topic_address(MAKER), topic_address(taker)],
        "data": words(side, token, maker_amount, taker_amount, 0, 0, 0),
        "blockNumber": hex(block),
        "blockTimestamp": "0x6b07a66f",
        "transactionHash": "0x" + f"{block:064x}",
        "logIndex": hex(index),
    }


class Reply:
    def __init__(self, body: Any) -> None:
        self._body = json.dumps(body).encode()

    def __enter__(self) -> "Reply":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class FakeNode:
    """Answers eth_blockNumber, eth_getBlockByNumber and eth_getLogs from fixed logs; no network."""

    def __init__(self, logs: list[dict[str, Any]], head: int = 0x5D6F100, max_range: int = 10_000,
                 failures: list[Exception] | None = None) -> None:
        self.logs, self.head, self.max_range, self.failures = logs, head, max_range, list(failures or [])
        self.ranges: list[tuple[int, int]] = []

    def __call__(self, request: Any, timeout: float) -> Reply:
        if self.failures:
            raise self.failures.pop(0)
        payload = json.loads(request.data)
        method, params = payload["method"], payload["params"]
        if method == "eth_blockNumber":
            return Reply({"result": hex(self.head)})
        if method == "eth_getBlockByNumber":
            return Reply({"result": {"timestamp": "0x6b07a69c"}})
        query = params[0]
        start, end = int(query["fromBlock"], 16), int(query["toBlock"], 16)
        self.ranges.append((start, end))
        if end - start + 1 > self.max_range:
            return Reply({"error": {"code": -32005, "message": "query returned more than 10000 results"}})
        found = [log for log in self.logs if log["address"] == query["address"].lower()
                 and log["topics"][0] == query["topics"][0] and start <= int(log["blockNumber"], 16) <= end]
        return Reply({"result": found})
