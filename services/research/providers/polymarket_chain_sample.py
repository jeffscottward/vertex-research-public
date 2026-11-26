"""Sample Polymarket fills and resolutions from a Polygon JSON-RPC endpoint into local Parquet files.

Research only; the owner accepted the PublicNode terms for this use on 2026-11-25
(docs/vertex-rebuild/prediction-market-onchain-sample.md). The command reads
public chain logs, writes ``trades.parquet`` and ``markets.parquet`` to a local
folder outside the repository (it refuses a folder inside it and existing
files; never commit or publish the files) and prints the endpoint, block ranges,
row counts, skipped logs and file SHA-256. It does not sign, send a transaction,
read an account or place orders.

    python -m providers.polymarket_chain_sample --out DIR --fills-back BLOCKS \
        [--fills-span BLOCKS] [--slices K] [--slice-blocks S] [--horizon-blocks H]

Fills come from ``K`` slices of ``S`` blocks, spread evenly over
``[latest - fills_back, latest - fills_back + fills_span)``. Resolutions come
from the first fill block to the last fill block plus ``H`` (never past the
latest block minus ``CONFIRMATIONS``). Market rows are written only for tokens
that a sampled fill traded. The keyless PublicNode endpoint serves about the
latest 2,000,000 blocks; an older range fails with an archive-token error,
which stops the run.

HTTP: ``urllib`` with redirects refused (as ``providers.financialdatasets_cli``),
a fixed request spacing and back-off for HTTP 429, 5xx and network errors. The
repository's ``adapters.http.HttpsTransport`` is not used: it needs endpoint
policies, a secret resolver and a host admission gate, which a keyless one-off
research pull does not have.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import http.client
import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from providers.polymarket_chain import (
    CONDITION_RESOLUTION,
    CONDITIONAL_TOKENS,
    EXCHANGES_V1,
    EXCHANGES_V2,
    MARKET_COLUMNS,
    ORDER_FILLED_V1,
    ORDER_FILLED_V2,
    TRADE_COLUMNS,
    decode_condition_resolution,
    decode_order_filled,
    market_rows,
)

PUBLICNODE_POLYGON = "https://polygon-bor-rpc.publicnode.com"
USER_AGENT = "vertex-research-prediction-sample/1"
CONFIRMATIONS = 256  # blocks below the latest block that a run reads, so reorganized blocks are not read
FILL_STEP = 50  # about 60-90 fill logs per block in November 2026; 50 blocks stay under 10,000 results
RESOLUTION_STEP = 2_000
REQUEST_SPACING = 0.1  # seconds between requests
TRIES = 6  # back-off 1, 2, 4, 8, 16 s between tries
TIMEOUT = 60.0
REPOSITORY = Path(__file__).resolve().parents[3]
# Text of a rate limit: back off and retry the same range. Checked before the range words.
_RATE_ERROR_WORDS = ("rate limit", "rate-limit", "ratelimit", "too many requests", "capacity", "throttl")
# Text of a refused range: halve the block step. The archive-token error is never a range error.
_RANGE_ERROR_WORDS = ("range", "more than", "response size", "too large", "query returned", "results", "timeout")
_COLUMN_TYPES = {
    "block_number": "BIGINT", "block_time": "BIGINT", "log_index": "BIGINT", "version": "INTEGER",
    "closed": "BOOLEAN",
}


class RpcError(RuntimeError):
    """An error object in a JSON-RPC response."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # urllib then raises HTTPError with the 3xx status


@dataclass
class JsonRpc:
    """Minimal JSON-RPC client over HTTPS POST with spacing, retry and back-off for transient failures."""

    url: str = PUBLICNODE_POLYGON
    tries: int = TRIES
    timeout: float = TIMEOUT
    spacing: float = REQUEST_SPACING
    sleep: Callable[[float], object] = time.sleep
    opener: Callable[..., Any] = field(default_factory=lambda: urllib.request.build_opener(_NoRedirect()).open)
    calls: int = field(default=0, init=False)

    def call(self, method: str, params: list[Any]) -> Any:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        request = urllib.request.Request(self.url, data=body, headers={
            "content-type": "application/json", "user-agent": USER_AGENT})
        for attempt in range(self.tries):
            if attempt:
                self.sleep(2 ** (attempt - 1))
            elif self.calls:
                self.sleep(self.spacing)
            self.calls += 1
            try:
                with self.opener(request, timeout=self.timeout) as response:
                    reply = json.loads(response.read())
            except urllib.error.HTTPError as error:
                if error.code == 429 or error.code >= 500:
                    continue
                if error.code != 403:  # PublicNode answers archive ranges with 403 and a JSON error.
                    raise
                raw = error.read() or b""
                try:
                    reply = json.loads(raw)
                except ValueError:
                    raise RpcError(f"HTTP 403: {raw[:200]!r}") from None
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError, ValueError):
                continue  # network failure, cut or non-JSON body: retry
            error_value = reply.get("error") if isinstance(reply, dict) else reply
            if isinstance(reply, dict) and "result" in reply and error_value is None:
                return reply["result"]
            message = str(error_value.get("message", error_value) if isinstance(error_value, dict) else error_value)
            if any(word in message.lower() for word in _RATE_ERROR_WORDS):
                continue
            raise RpcError(message)
        raise RpcError(f"{method}: no answer after {self.tries} tries")


def fetch_logs(rpc: JsonRpc, address: str, topic: str, start: int, end: int, step: int) -> Iterator[dict[str, Any]]:
    """Logs of one contract and event in ``[start, end]`` (both ends included), in block chunks.

    A refused range halves the chunk; after ten good chunks it doubles again up
    to ``step``. The archive-token error and other errors stop the run. Logs
    marked ``removed`` (reorganized) are left out.
    """
    block, size, good = start, step, 0
    while block <= end:
        upper = min(block + size - 1, end)
        try:
            logs = rpc.call("eth_getLogs", [{"address": address, "topics": [topic],
                                             "fromBlock": hex(block), "toBlock": hex(upper)}])
        except RpcError as error:
            text = str(error).lower()
            if size > 1 and "archive" not in text and any(word in text for word in _RANGE_ERROR_WORDS):
                size, good = max(1, size // 2), 0
                continue
            raise
        yield from (log for log in logs if not log.get("removed"))
        block, good = upper + 1, good + 1
        if good >= 10 and size < step:
            size, good = min(step, size * 2), 0


def outside_repository(path: Path, repository: Path = REPOSITORY) -> Path:
    """The resolved folder; ``SystemExit`` when it is the repository or inside it."""
    resolved, top = path.expanduser().resolve(), repository.resolve()
    if resolved == top or top in resolved.parents:
        raise SystemExit(f"refusing a folder inside the repository: {resolved}")
    return resolved


def write_parquet(rows: Sequence[Mapping[str, Any]], columns: Sequence[str], path: Path) -> str:
    """Write rows to one new Parquet file through a temporary CSV and DuckDB; return its SHA-256."""
    import duckdb  # Optional extra "prediction"; imported only here.

    if path.exists():
        raise SystemExit(f"refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", newline="", suffix=".csv", dir=path.parent, delete=False) as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for row in rows:
            writer.writerow(["" if row.get(c) is None else row[c] for c in columns])
        staging = Path(handle.name)
    try:
        types = ", ".join(f"'{c}': '{_COLUMN_TYPES.get(c, 'VARCHAR')}'" for c in columns)
        with duckdb.connect() as connection:
            connection.execute(
                f"COPY (SELECT * FROM read_csv(?, header = true, columns = {{{types}}})) TO ? (FORMAT parquet)",
                [str(staging), str(path)])
    finally:
        staging.unlink()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _block_time(rpc: JsonRpc, block: int) -> str:
    header = rpc.call("eth_getBlockByNumber", [hex(block), False])
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(header["timestamp"], 16)))


def fill_slices(first: int, span: int, slices: int, slice_blocks: int) -> list[tuple[int, int]]:
    """``slices`` block ranges of ``slice_blocks`` blocks, spread evenly over ``[first, first + span)``."""
    if slices <= 0 or slice_blocks <= 0 or span < slices * slice_blocks:
        raise ValueError("need slices > 0, slice_blocks > 0 and span >= slices * slice_blocks")
    gap = span // slices
    return [(first + i * gap, first + i * gap + slice_blocks - 1) for i in range(slices)]


def _token(row: Mapping[str, Any]) -> str:
    return row["taker_asset_id"] if row["maker_asset_id"] == "0" else row["maker_asset_id"]


def sample(rpc: JsonRpc, slices: Sequence[tuple[int, int]], resolutions_to: int, out_dir: Path,
           step: int = FILL_STEP, resolution_step: int = RESOLUTION_STEP) -> dict[str, Any]:
    """Fetch, decode and write one sample; return the summary that ``main`` prints."""
    if not slices or any(not 0 <= a <= b for a, b in slices) or max(b for _, b in slices) > resolutions_to:
        raise ValueError("need ordered fill slices that end at or before resolutions_to")
    trades: dict[tuple[str, int], dict[str, Any]] = {}  # (transaction hash, log index) -> row; no duplicates
    skipped_fills = 0
    for start, end in slices:
        for exchanges, topic in ((EXCHANGES_V1, ORDER_FILLED_V1), (EXCHANGES_V2, ORDER_FILLED_V2)):
            for exchange in exchanges:
                for log in fetch_logs(rpc, exchange, topic, start, end, step):
                    try:
                        row = decode_order_filled(log)
                    except (ValueError, TypeError):
                        skipped_fills += 1
                        continue
                    trades[(row["transaction_hash"], row["log_index"])] = row
    traded = {_token(row) for row in trades.values()}
    markets: list[dict[str, Any]] = []
    resolutions = skipped_resolutions = not_binary = untraded = 0
    seen: set[str] = set()
    first = min(a for a, _ in slices)
    for log in fetch_logs(rpc, CONDITIONAL_TOKENS, CONDITION_RESOLUTION, first, resolutions_to, resolution_step):
        try:
            resolution = decode_condition_resolution(log)
            rows = market_rows(resolution)
        except (ValueError, TypeError):
            skipped_resolutions += 1
            continue
        if resolution["condition_id"] in seen:  # a condition resolves once; a repeated log is a duplicate
            continue
        seen.add(resolution["condition_id"])
        resolutions += 1
        if not rows:
            not_binary += 1
            continue
        kept = [row for row in rows if set(json.loads(row["clob_token_ids"])) & traded]
        untraded += not kept
        markets.extend(kept)
    return {
        "endpoint": rpc.url,
        "fill_slices": f"{len(slices)} x {slices[0][1] - slices[0][0] + 1} blocks, "
                       f"{slices[0][0]}..{slices[-1][1]} ({_block_time(rpc, slices[0][0])} .. "
                       f"{_block_time(rpc, slices[-1][1])})",
        "resolutions": f"{first}..{resolutions_to} (to {_block_time(rpc, resolutions_to)})",
        "trade_rows": len(trades),
        "traded_tokens": len(traded),
        "skipped_fill_logs": skipped_fills,
        "resolution_logs": resolutions,
        "skipped_resolution_logs": skipped_resolutions,
        "non_binary_or_zero_payout": not_binary,
        "resolved_conditions_without_sampled_fill": untraded,
        "market_rows": len(markets),
        "trades_sha256": write_parquet(list(trades.values()), TRADE_COLUMNS, out_dir / "trades.parquet"),
        "markets_sha256": write_parquet(markets, MARKET_COLUMNS, out_dir / "markets.parquet"),
        "rpc_calls": rpc.calls,
    }


def main(argv: Sequence[str] | None = None, rpc: JsonRpc | None = None, out: Callable[[str], object] = print) -> int:
    parser = argparse.ArgumentParser(prog="python -m providers.polymarket_chain_sample")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--rpc", default=PUBLICNODE_POLYGON)
    parser.add_argument("--fills-back", required=True, type=int, help="first fill block = latest - this")
    parser.add_argument("--fills-span", type=int, default=403_200, help="blocks the slices spread over (7 days)")
    parser.add_argument("--slices", type=int, default=28)
    parser.add_argument("--slice-blocks", type=int, default=100)
    parser.add_argument("--horizon-blocks", type=int, default=403_200,
                        help="resolutions are read up to the last fill block plus this (7 days)")
    args = parser.parse_args(argv)
    out_dir = outside_repository(args.out)
    for name in ("trades.parquet", "markets.parquet"):
        if (out_dir / name).exists():
            parser.error(f"refusing to overwrite {out_dir / name}")
    client = rpc or JsonRpc(args.rpc)
    head = int(client.call("eth_blockNumber", []), 16) - CONFIRMATIONS
    first = head + CONFIRMATIONS - args.fills_back
    slices = fill_slices(first, args.fills_span, args.slices, args.slice_blocks)
    resolutions_to = slices[-1][1] + args.horizon_blocks
    if resolutions_to > head:
        parser.error("the fill window plus the horizon ends after the latest confirmed block")
    summary = sample(client, slices, resolutions_to, out_dir)
    for key, value in summary.items():
        out(f"{key}: {value}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
