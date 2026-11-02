"""Gamma causal scan; no providers, clocks, stores, or execution imports.
Source: forge/src/options_alpha/backtesting/replay.py, lines 35-76, 487-659.
SHA256: 493b41ca09e7dcfbf183b7bac689930c1d9af2fff694956307be6f8390b1c1a4
Authorized first-party reuse. Original scan behavior retained; revision and
availability timestamp aliases extend the cutoff protection in this adapter.
"""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time
from typing import Any

_SOURCE_TIMESTAMP_KEYS = frozenset(
    {
        "asOf",
        "as_of",
        "createdAt",
        "created_at",
        "dateTime",
        "datetime",
        "endTime",
        "end_time",
        "executedAt",
        "executed_at",
        "fetchedAt",
        "fetched_at",
        "generatedAt",
        "generated_at",
        "observedAt",
        "observed_at",
        "quoteFetchedAt",
        "quoteObservedAt",
        "quote_fetched_at",
        "quote_observed_at",
        "snapshotAt",
        "snapshotTime",
        "snapshot_at",
        "snapshot_time",
        "startTime",
        "start_time",
        "time",
        "timestamp",
        "tradeTime",
        "trade_time",
        "updatedAt",
        "updated_at",
    }
)

# Full option-chain artifacts can contain thousands of contracts. These named
# budgets are intentionally high enough for complete provider payloads while
# still failing closed on pathological recursion or unbounded object graphs.
MAX_SOURCE_TIMESTAMP_SCAN_DEPTH = 32
MAX_SOURCE_TIMESTAMP_SCAN_NODES = 250_000

# Publication/availability is distinct from event time. Neither may look ahead.
_SOURCE_TIMESTAMP_KEYS |= frozenset({
    "availableAt", "available_at", "publishedAt", "published_at",
    "revisionAt", "revision_at", "vintageAt", "vintage_at",
    "receivedAt", "received_at",
})

def validate_source_cutoffs(
    value: Any, decision_at: datetime, *, scan_budget: list[int] | None = None,
) -> None:
    """Reject future, naive, malformed and over-budget source observations."""
    if decision_at.tzinfo is None or decision_at.utcoffset() is None:
        raise ValueError("decision_at must be timezone-aware")
    if scan_budget is None:
        scan_budget = [0, MAX_SOURCE_TIMESTAMP_SCAN_NODES]
    if len(scan_budget) != 2 or any(type(item) is not int for item in scan_budget):
        raise ValueError("invalid source scan budget")
    if not 0 <= scan_budget[0] <= scan_budget[1] <= MAX_SOURCE_TIMESTAMP_SCAN_NODES:
        raise ValueError("source scan budget exceeded")
    _validate_replay_source_cutoff(
        "source", value, decision_at.astimezone(UTC), depth=0, visited_nodes=scan_budget
    )

def _validate_replay_source_cutoff(
    path: str,
    value: Any,
    decision_at: datetime,
    *,
    depth: int,
    visited_nodes: list[int],
) -> None:
    _consume_source_scan_node(path, depth, visited_nodes)
    if isinstance(value, Mapping):
        for key, item in value.items():
            child_path = f"{path}.{_safe_source_path_segment(key)}"
            if str(key) == "option_chain_latest_retry":
                _validate_option_chain_latest_retry_flag(child_path, item)
            elif str(key) in _SOURCE_TIMESTAMP_KEYS:
                _validate_timestamp_value(
                    child_path,
                    item,
                    decision_at,
                    depth=depth + 1,
                    visited_nodes=visited_nodes,
                )
            elif str(key) == "date" and _is_price_observation_path(path):
                _validate_price_observation_date(
                    child_path,
                    item,
                    decision_at,
                    depth=depth + 1,
                    visited_nodes=visited_nodes,
                )
            else:
                _validate_replay_source_cutoff(
                    child_path,
                    item,
                    decision_at,
                    depth=depth + 1,
                    visited_nodes=visited_nodes,
                )
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, item in enumerate(value):
            _validate_replay_source_cutoff(
                f"{path}[{index}]",
                item,
                decision_at,
                depth=depth + 1,
                visited_nodes=visited_nodes,
            )


def _is_price_observation_path(path: str) -> bool:
    lowered = path.lower()
    return any(
        segment in lowered
        for segment in (
            "price_history",
            "historical_bars",
            ".bars",
            ".candles",
        )
    )


def _validate_price_observation_date(
    path: str,
    value: Any,
    decision_at: datetime,
    *,
    depth: int,
    visited_nodes: list[int],
) -> None:
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        _consume_source_scan_node(path, depth, visited_nodes)
        try:
            observed_date = date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"replay source timestamp {path} is invalid") from exc
        _reject_post_cutoff_timestamp(
            path,
            datetime.combine(observed_date, time.max, tzinfo=UTC),
            decision_at,
        )
        return
    _validate_timestamp_value(
        path,
        value,
        decision_at,
        depth=depth,
        visited_nodes=visited_nodes,
    )


def _consume_source_scan_node(
    path: str,
    depth: int,
    visited_nodes: list[int],
) -> None:
    if depth > MAX_SOURCE_TIMESTAMP_SCAN_DEPTH:
        raise ValueError(
            f"replay source timestamp scan depth budget exceeded at {path}"
        )
    visited_nodes[0] += 1
    maximum = min(MAX_SOURCE_TIMESTAMP_SCAN_NODES, visited_nodes[1]) if len(visited_nodes) == 2 else MAX_SOURCE_TIMESTAMP_SCAN_NODES
    if visited_nodes[0] > maximum:
        raise ValueError(f"replay source timestamp scan node budget exceeded at {path}")


def _safe_source_path_segment(value: object) -> str:
    text = str(value)
    if 1 <= len(text) <= 64 and all(
        character.isalnum() or character in "_.-" for character in text
    ):
        return text
    return "<key>"


def _validate_option_chain_latest_retry_flag(path: str, value: Any) -> None:
    if value is not False:
        raise ValueError(f"replay source flag {path} is not causal")


def _validate_timestamp_value(
    path: str,
    value: Any,
    decision_at: datetime,
    *,
    depth: int,
    visited_nodes: list[int],
) -> None:
    _consume_source_scan_node(path, depth, visited_nodes)
    if value is None:
        return
    timestamp = _parse_source_timestamp(value)
    if timestamp is not None:
        _reject_post_cutoff_timestamp(path, timestamp, decision_at)
        return
    if isinstance(value, Mapping):
        raise ValueError(f"replay source timestamp {path} is invalid")
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, item in enumerate(value):
            _validate_timestamp_value(
                f"{path}[{index}]",
                item,
                decision_at,
                depth=depth + 1,
                visited_nodes=visited_nodes,
            )
        return
    raise ValueError(f"replay source timestamp {path} is invalid")


def _parse_source_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text or ("T" not in text and " " not in text):
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _reject_post_cutoff_timestamp(
    path: str,
    timestamp: datetime,
    decision_at: datetime,
) -> None:
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError(f"replay source timestamp {path} must be timezone-aware")
    if timestamp.astimezone(UTC) > decision_at:
        raise ValueError(f"replay source timestamp {path} occurs after decision_at")
