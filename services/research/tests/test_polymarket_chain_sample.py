"""Sampler of Polymarket chain logs (providers.polymarket_chain_sample) against a fake JSON-RPC node.

Needs the optional extra "prediction" (see tests/polymarket_fixtures.py). The
node is a fake opener: no network.
"""
from __future__ import annotations

import io
import json
import urllib.error
from pathlib import Path

import pytest

from providers import polymarket_chain as chain
from tests.polymarket_fixtures import NEEDS_EXTRA, RESOLUTION_LOG, FakeNode, fill_log

pytestmark = NEEDS_EXTRA


def _rpc(node: FakeNode):  # type: ignore[no-untyped-def]
    from providers.polymarket_chain_sample import JsonRpc

    return JsonRpc(url="https://fake.invalid", sleep=lambda _s: None, opener=node, tries=3)


def _http_error(code: int, body: bytes = b"") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://fake.invalid", code, "x", {}, io.BytesIO(body))  # type: ignore[arg-type]


def test_sample_writes_parquet_that_the_reader_calibrates(tmp_path: Path) -> None:
    from providers.polymarket_chain_sample import main
    from providers.prediction_market_parquet import polymarket_calibration_from_parquet

    block = int(RESOLUTION_LOG["blockNumber"], 16)
    logs = [fill_log(block=block - 30), fill_log(side=9, block=block - 30, index=1),  # one undecodable fill
            fill_log(maker_amount=30, taker_amount=100, block=block - 29, index=2), RESOLUTION_LOG, RESOLUTION_LOG]
    node = FakeNode(logs, head=block + 300, max_range=40)
    lines: list[str] = []
    argv = ["--out", str(tmp_path / "w"), "--fills-back", "330", "--fills-span", "4", "--slices", "2",
            "--slice-blocks", "2", "--horizon-blocks", "100"]
    assert main(argv, rpc=_rpc(node), out=lines.append) == 0
    summary = dict(line.split(": ", 1) for line in lines)
    assert (summary["trade_rows"], summary["skipped_fill_logs"], summary["traded_tokens"]) == ("2", "1", "1")
    assert (summary["resolution_logs"], summary["market_rows"]) == ("1", "1")  # the USDC.e row; duplicate log dropped
    assert any(end - start + 1 < 2000 for start, end in node.ranges)  # the refused resolution range was halved
    report = polymarket_calibration_from_parquet(tmp_path / "w/markets.parquet", tmp_path / "w/trades.parquet")
    # 99.9 cents rounds to 100 (out of range); 30/100 gives a 30-cent winner and a 70-cent loser.
    assert (report.total_trades, report.out_of_range_positions) == (2, 2)
    with pytest.raises(SystemExit, match="overwrite"):
        main(argv, rpc=_rpc(FakeNode(logs, head=block + 300)), out=lines.append)


def test_main_refuses_a_folder_in_the_repository_and_a_window_past_the_head(tmp_path: Path) -> None:
    from providers.polymarket_chain_sample import REPOSITORY, main

    with pytest.raises(SystemExit, match="inside the repository"):
        main(["--out", str(REPOSITORY / "x"), "--fills-back", "10"], rpc=_rpc(FakeNode([])))
    with pytest.raises(SystemExit):
        main(["--out", str(tmp_path), "--fills-back", "10", "--fills-span", "4", "--slices", "1",
              "--slice-blocks", "4"], rpc=_rpc(FakeNode([])))


def test_fill_slices_and_bad_windows(tmp_path: Path) -> None:
    from providers.polymarket_chain_sample import fill_slices, sample

    assert fill_slices(100, 40, 4, 5) == [(100, 104), (110, 114), (120, 124), (130, 134)]
    for bad in ((100, 10, 4, 5), (100, 40, 0, 5), (100, 40, 4, 0)):
        with pytest.raises(ValueError):
            fill_slices(*bad)
    for slices, end in (([], 10), ([(5, 4)], 10), ([(5, 20)], 10)):
        with pytest.raises(ValueError):
            sample(_rpc(FakeNode([])), slices, end, tmp_path)


def test_fetch_logs_halves_regrows_skips_removed_and_stops_on_archive() -> None:
    from providers.polymarket_chain_sample import RpcError, fetch_logs

    removed = dict(RESOLUTION_LOG, removed=True, blockNumber=hex(int(RESOLUTION_LOG["blockNumber"], 16) + 1))
    start = int(RESOLUTION_LOG["blockNumber"], 16) - 5
    node = FakeNode([RESOLUTION_LOG, removed], max_range=8)
    logs = list(fetch_logs(_rpc(node), chain.CONDITIONAL_TOKENS, chain.CONDITION_RESOLUTION, start, start + 400, 16))
    assert logs == [RESOLUTION_LOG]
    assert max(end - s + 1 for s, end in node.ranges) == 16  # it tried the full step first
    archive = json.dumps({"error": {"message": "Archive requests require a personal token."}}).encode()
    with pytest.raises(RpcError, match="Archive"):
        list(fetch_logs(_rpc(FakeNode([], failures=[_http_error(403, archive)])), chain.CONDITIONAL_TOKENS,
                        chain.CONDITION_RESOLUTION, 1, 500, 100))


def test_rpc_retries_transient_failures_and_stops_on_others() -> None:
    from providers.polymarket_chain_sample import RpcError

    sleeps: list[float] = []
    rpc = _rpc(FakeNode([], head=7, failures=[_http_error(429), urllib.error.URLError("down")]))
    rpc.sleep = sleeps.append
    assert rpc.call("eth_blockNumber", []) == "0x7"
    assert sleeps == [1, 0.1, 2, 0.1]
    with pytest.raises(urllib.error.HTTPError):
        _rpc(FakeNode([], failures=[_http_error(404)])).call("eth_blockNumber", [])
    with pytest.raises(RpcError, match="no answer"):
        _rpc(FakeNode([], failures=[_http_error(503), TimeoutError(), ConnectionError()])).call("eth_blockNumber", [])


def test_default_opener_refuses_redirects() -> None:
    from providers.polymarket_chain_sample import JsonRpc, _NoRedirect

    assert _NoRedirect().redirect_request() is None
    assert callable(JsonRpc().opener)
