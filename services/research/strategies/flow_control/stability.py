"""Task 1 streamed-session qualifier and futures state-stability counter (research only).

Counts how often the futures control state (`flow-futures-rules.v1`) starts, ends, flips and reverses per
qualifying streamed RTH session, the share of each session spent in each state, and how often each entry check
(`few_trades`, `delta_against`, `price_against`) holds an entry back.

Reads tape coverage, volume, delta, VWAP, close and deep-trade volume/counts only; never computes returns,
P&L or trade outcomes (plan docs/vertex-rebuild/designs/flow-streaming-tape/plan.md, sections 5 and 9).
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from strategies.imom.data import is_closed, is_early_close

from .control import (
    BALANCED,
    BUYERS,
    FUTURES_HOLDS,
    FUTURES_RULES,
    GAP,
    NO_DATA,
    SELLERS,
    SESSION_START,
    FuturesRules,
    FuturesStep,
    TapeMinute,
    fold_futures_state,
)

NY_TZ = ZoneInfo("America/New_York")
SYMBOLS = ("ES", "NQ")
RTH_OPEN_MINUTE_OF_DAY = 9 * 60 + 30  # 09:30 America/New_York
RTH_CLOSE_MINUTE_OF_DAY = 16 * 60  # 16:00 America/New_York
SESSION_MINUTES = RTH_CLOSE_MINUTE_OF_DAY - RTH_OPEN_MINUTE_OF_DAY  # 390
MIN_STREAMED_COVERED_MINUTES = 370
TASK1_MIN_SESSIONS = 5
TASK2_MIN_SESSIONS = 20
# First full NYSE RTH session after PR #328 (vertex-history 1.5.0 / migration 0083) deployed on 2026-11-19 22:49 ET.
FIRST_STREAMED_DAY = "2026-11-20"
EXIT_TIME_GATED = 3


@dataclass(frozen=True)
class RawMinuteRow:
    """One row from PostgreSQL `flow_minutes` for a futures symbol."""

    symbol: str
    minute: datetime
    covered_seconds: int
    delta: float
    volume: float
    vwap: float
    close: float


@dataclass(frozen=True)
class RawDeepTradeRow:
    """One row from PostgreSQL `flow_large_trades` for a futures symbol."""

    symbol: str
    second: datetime
    side: str
    size: float
    capture: str = "streamed"


@dataclass(frozen=True)
class SessionTapeInput:
    """One future's RTH tape rows for a single New York session date."""

    day: str
    symbol: str
    covered_minutes: tuple[TapeMinute, ...]
    stored_minutes: int
    last_stored_minute: int
    streamed_deep_trades: int
    sampled_deep_trades: int


@dataclass(frozen=True)
class DisqualifiedDay:
    """A session date observed in the tape that does not meet the streamed-session bar."""

    day: str
    reason: str
    es_covered_minutes: int
    nq_covered_minutes: int

    def to_json(self) -> dict[str, object]:
        return {
            "day": self.day,
            "reason": self.reason,
            "esCoveredMinutes": self.es_covered_minutes,
            "nqCoveredMinutes": self.nq_covered_minutes,
        }


@dataclass(frozen=True)
class SessionStability:
    """State-stability and entry-check hold counts for one future on one RTH session (no returns read)."""

    day: str
    symbol: str
    stored_minutes: int
    covered_minutes: int
    missing_minutes: int
    streamed_deep_trades: int
    sampled_deep_trades: int
    folded_steps: int
    starts: int
    buyers_starts: int
    sellers_starts: int
    ends: int
    ends_to_balanced: int
    ends_to_gap: int
    direct_flips: int
    reversals: int
    buyers_minutes: int
    sellers_minutes: int
    balanced_minutes: int
    no_data_minutes: int
    session_start_minutes: int
    gap_minutes: int
    ratio_reached_balanced_minutes: int
    hold_minutes: Mapping[str, int]
    hold_spells: Mapping[str, int]

    def to_json(self) -> dict[str, object]:
        denom = SESSION_MINUTES
        return {
            "day": self.day,
            "symbol": self.symbol,
            "storedMinutes": self.stored_minutes,
            "coveredMinutes": self.covered_minutes,
            "missingMinutes": self.missing_minutes,
            "streamedDeepTrades": self.streamed_deep_trades,
            "sampledDeepTrades": self.sampled_deep_trades,
            "foldedSteps": self.folded_steps,
            "starts": self.starts,
            "buyersStarts": self.buyers_starts,
            "sellersStarts": self.sellers_starts,
            "ends": self.ends,
            "endsToBalanced": self.ends_to_balanced,
            "endsToGap": self.ends_to_gap,
            "directFlips": self.direct_flips,
            "reversals": self.reversals,
            "stateMinutes": {
                BUYERS: self.buyers_minutes,
                SELLERS: self.sellers_minutes,
                BALANCED: self.balanced_minutes,
                NO_DATA: self.no_data_minutes,
                SESSION_START: self.session_start_minutes,
                GAP: self.gap_minutes,
            },
            "stateSessionShares": {
                BUYERS: round(self.buyers_minutes / denom, 6),
                SELLERS: round(self.sellers_minutes / denom, 6),
                BALANCED: round(self.balanced_minutes / denom, 6),
                NO_DATA: round(self.no_data_minutes / denom, 6),
            },
            "ratioReachedBalancedMinutes": self.ratio_reached_balanced_minutes,
            "holdMinutes": dict(self.hold_minutes),
            "holdSpells": dict(self.hold_spells),
        }


@dataclass(frozen=True)
class SymbolAggregate:
    """Aggregate totals and per-session averages across qualifying sessions for one symbol (or combined)."""

    symbol: str
    sessions: int
    starts_total: int
    starts_per_session: float
    buyers_starts_total: int
    sellers_starts_total: int
    ends_total: int
    ends_per_session: float
    ends_to_balanced_total: int
    ends_to_gap_total: int
    direct_flips_total: int
    reversals_total: int
    reversals_per_session: float
    state_minutes: Mapping[str, int]
    state_shares: Mapping[str, float]
    ratio_reached_balanced_minutes: int
    hold_minutes: Mapping[str, int]
    hold_spells: Mapping[str, int]

    def to_json(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "sessions": self.sessions,
            "startsTotal": self.starts_total,
            "startsPerSession": round(self.starts_per_session, 4),
            "buyersStartsTotal": self.buyers_starts_total,
            "sellersStartsTotal": self.sellers_starts_total,
            "endsTotal": self.ends_total,
            "endsPerSession": round(self.ends_per_session, 4),
            "endsToBalancedTotal": self.ends_to_balanced_total,
            "endsToGapTotal": self.ends_to_gap_total,
            "directFlipsTotal": self.direct_flips_total,
            "reversalsTotal": self.reversals_total,
            "reversalsPerSession": round(self.reversals_per_session, 4),
            "stateMinutes": dict(self.state_minutes),
            "stateShares": {k: round(v, 6) for k, v in self.state_shares.items()},
            "ratioReachedBalancedMinutes": self.ratio_reached_balanced_minutes,
            "holdMinutes": dict(self.hold_minutes),
            "holdSpells": dict(self.hold_spells),
        }


@dataclass(frozen=True)
class StabilityReport:
    """Full Task 1 qualification and state-stability report."""

    rules: FuturesRules
    min_covered_minutes: int
    min_sessions: int
    task2_min_sessions: int
    qualifying_days: tuple[str, ...]
    disqualified_days: tuple[DisqualifiedDay, ...]
    per_session: tuple[SessionStability, ...]
    by_symbol: Mapping[str, SymbolAggregate]

    @property
    def ready_for_task1(self) -> bool:
        return len(self.qualifying_days) >= self.min_sessions

    @property
    def ready_for_task2(self) -> bool:
        return len(self.qualifying_days) >= self.task2_min_sessions

    def to_json(self) -> dict[str, object]:
        return {
            "rules": self.rules.to_json(),
            "minCoveredMinutes": self.min_covered_minutes,
            "minSessions": self.min_sessions,
            "task2MinSessions": self.task2_min_sessions,
            "qualifyingSessionsCount": len(self.qualifying_days),
            "readyForTask1": self.ready_for_task1,
            "readyForTask2": self.ready_for_task2,
            "qualifyingDays": list(self.qualifying_days),
            "disqualifiedDays": [d.to_json() for d in self.disqualified_days],
            "bySymbol": {k: v.to_json() for k, v in self.by_symbol.items()},
            "perSession": [s.to_json() for s in self.per_session],
        }


def parse_utc_timestamp(value: str | datetime) -> datetime:
    """Parse an ISO-8601 timestamp string or datetime into a timezone-aware UTC datetime."""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def ny_session_minute(ts: datetime) -> tuple[str, int] | None:
    """Return (YYYY-MM-DD, minute_offset_from_0930) in America/New_York, or None outside 09:30..16:00."""
    local = ts.astimezone(NY_TZ)
    minute_of_day = local.hour * 60 + local.minute
    if minute_of_day < RTH_OPEN_MINUTE_OF_DAY or minute_of_day >= RTH_CLOSE_MINUTE_OF_DAY:
        return None
    return local.date().isoformat(), minute_of_day - RTH_OPEN_MINUTE_OF_DAY


def build_session_inputs(
    minute_rows: Iterable[RawMinuteRow],
    trade_rows: Iterable[RawDeepTradeRow],
    rules: FuturesRules = FUTURES_RULES,
) -> dict[tuple[str, str], SessionTapeInput]:
    """Assemble per-(day, symbol) RTH tape inputs identically to packages/api/src/server/flow-control.ts."""
    deep_by_key: dict[tuple[str, str, int], list[float | int]] = defaultdict(lambda: [0.0, 0.0, 0])
    capture_counts: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])  # [streamed, sampled]

    for trade in trade_rows:
        if trade.symbol not in SYMBOLS:
            continue
        loc = ny_session_minute(trade.second)
        if loc is None:
            continue
        day, minute_offset = loc
        bucket = deep_by_key[(day, trade.symbol, minute_offset)]
        if trade.side == "buy":
            bucket[0] = float(bucket[0]) + trade.size
        elif trade.side == "sell":
            bucket[1] = float(bucket[1]) + trade.size
        else:
            raise ValueError(f"Unexpected deep trade side {trade.side!r} on {day} {trade.symbol}")
        bucket[2] = int(bucket[2]) + 1
        counts = capture_counts[(day, trade.symbol)]
        if trade.capture == "sampled":
            counts[1] += 1
        else:
            counts[0] += 1

    # Deduplicate by (day, symbol, minute_offset); keep latest row if duplicates appear.
    minutes_by_session: dict[tuple[str, str], dict[int, RawMinuteRow]] = defaultdict(dict)
    for row in minute_rows:
        if row.symbol not in SYMBOLS:
            continue
        loc = ny_session_minute(row.minute)
        if loc is None:
            continue
        day, minute_offset = loc
        minutes_by_session[(day, row.symbol)][minute_offset] = row

    all_keys = sorted(set(minutes_by_session.keys()) | set(capture_counts.keys()))
    result: dict[tuple[str, str], SessionTapeInput] = {}
    for day, symbol in all_keys:
        stored_map = minutes_by_session.get((day, symbol), {})
        covered: list[TapeMinute] = []
        for minute_offset in sorted(stored_map.keys()):
            row = stored_map[minute_offset]
            if row.covered_seconds < rules.min_covered_seconds:
                continue
            deep_buy, deep_sell, deep_trades = deep_by_key.get((day, symbol, minute_offset), [0.0, 0.0, 0])
            covered.append(
                TapeMinute(
                    minute=minute_offset,
                    deep_buy=float(deep_buy),
                    deep_sell=float(deep_sell),
                    deep_trades=int(deep_trades),
                    delta=row.delta,
                    volume=row.volume,
                    vwap=row.vwap,
                    close=row.close,
                )
            )
        streamed_n, sampled_n = capture_counts.get((day, symbol), [0, 0])
        result[(day, symbol)] = SessionTapeInput(
            day=day,
            symbol=symbol,
            covered_minutes=tuple(covered),
            stored_minutes=len(stored_map),
            last_stored_minute=max(stored_map.keys()) if stored_map else -1,
            streamed_deep_trades=streamed_n,
            sampled_deep_trades=sampled_n,
        )
    return result


def summarize_futures_steps(
    day: str,
    symbol: str,
    steps: Sequence[FuturesStep],
    *,
    stored_minutes: int,
    covered_minutes: int,
    streamed_deep_trades: int = 0,
    sampled_deep_trades: int = 0,
    rules: FuturesRules = FUTURES_RULES,
) -> SessionStability:
    """Count starts, ends, flips, reversals, state minutes and entry-check holds over folded futures steps."""
    starts = buyers_starts = sellers_starts = 0
    ends = ends_to_balanced = ends_to_gap = 0
    direct_flips = reversals = 0
    buyers_minutes = sellers_minutes = balanced_minutes = no_data_minutes = 0
    session_start_minutes = gap_minutes = 0
    ratio_reached_balanced = 0
    hold_minutes: dict[str, int] = {h: 0 for h in FUTURES_HOLDS}
    hold_spells: dict[str, int] = {h: 0 for h in FUTURES_HOLDS}

    prev_state: str | None = None
    last_control_side: str | None = None
    prev_hold: str | None = None

    for step in steps:
        state = step.state
        if state == BUYERS:
            buyers_minutes += 1
        elif state == SELLERS:
            sellers_minutes += 1
        elif state == BALANCED:
            balanced_minutes += 1
        elif state == NO_DATA:
            no_data_minutes += 1
            if step.no_data_reason == SESSION_START:
                session_start_minutes += 1
            elif step.no_data_reason == GAP:
                gap_minutes += 1

        in_control = state in (BUYERS, SELLERS)
        prev_in_control = prev_state in (BUYERS, SELLERS)

        if in_control and prev_state != state:
            starts += 1
            if state == BUYERS:
                buyers_starts += 1
            else:
                sellers_starts += 1
            if prev_in_control:
                direct_flips += 1
            if last_control_side is not None and last_control_side != state:
                reversals += 1
            last_control_side = state
        elif prev_in_control and not in_control:
            ends += 1
            if state == BALANCED:
                ends_to_balanced += 1
            else:
                ends_to_gap += 1

        if state == BALANCED and step.ratio is not None and abs(step.ratio) >= rules.enter_ratio:
            ratio_reached_balanced += 1

        cur_hold = step.hold if state == BALANCED else None
        if cur_hold is not None:
            hold_minutes[cur_hold] = hold_minutes.get(cur_hold, 0) + 1
            if cur_hold != prev_hold:
                hold_spells[cur_hold] = hold_spells.get(cur_hold, 0) + 1
        prev_hold = cur_hold
        prev_state = state

    return SessionStability(
        day=day,
        symbol=symbol,
        stored_minutes=stored_minutes,
        covered_minutes=covered_minutes,
        missing_minutes=max(0, SESSION_MINUTES - covered_minutes),
        streamed_deep_trades=streamed_deep_trades,
        sampled_deep_trades=sampled_deep_trades,
        folded_steps=len(steps),
        starts=starts,
        buyers_starts=buyers_starts,
        sellers_starts=sellers_starts,
        ends=ends,
        ends_to_balanced=ends_to_balanced,
        ends_to_gap=ends_to_gap,
        direct_flips=direct_flips,
        reversals=reversals,
        buyers_minutes=buyers_minutes,
        sellers_minutes=sellers_minutes,
        balanced_minutes=balanced_minutes,
        no_data_minutes=no_data_minutes,
        session_start_minutes=session_start_minutes,
        gap_minutes=gap_minutes,
        ratio_reached_balanced_minutes=ratio_reached_balanced,
        hold_minutes=hold_minutes,
        hold_spells=hold_spells,
    )


def summarize_futures_session(
    tape_input: SessionTapeInput, rules: FuturesRules = FUTURES_RULES
) -> SessionStability:
    """Fold one session's covered tape minutes with `flow-futures-rules.v1` and count state stability."""
    steps = fold_futures_state(
        tape_input.covered_minutes,
        rules=rules,
        through=tape_input.last_stored_minute,
    )
    return summarize_futures_steps(
        day=tape_input.day,
        symbol=tape_input.symbol,
        steps=steps,
        stored_minutes=tape_input.stored_minutes,
        covered_minutes=len(tape_input.covered_minutes),
        streamed_deep_trades=tape_input.streamed_deep_trades,
        sampled_deep_trades=tape_input.sampled_deep_trades,
        rules=rules,
    )


def classify_session_day(
    day: str,
    es_covered: int,
    nq_covered: int,
    *,
    min_covered_minutes: int = MIN_STREAMED_COVERED_MINUTES,
) -> str | None:
    """Return None when `day` is a qualifying streamed RTH session, else the disqualification reason."""
    parsed = date.fromisoformat(day)
    if is_closed(parsed):
        return "closed"
    if is_early_close(parsed):
        return "early_close"
    es_ok = es_covered >= min_covered_minutes
    nq_ok = nq_covered >= min_covered_minutes
    if es_ok and nq_ok:
        return None
    if not es_ok and not nq_ok:
        return "both_under_covered"
    return "es_under_covered" if not es_ok else "nq_under_covered"


def _aggregate_symbol(symbol: str, rows: Sequence[SessionStability]) -> SymbolAggregate:
    count = len(rows)
    denom = count * SESSION_MINUTES
    state_minutes = {
        BUYERS: sum(r.buyers_minutes for r in rows),
        SELLERS: sum(r.sellers_minutes for r in rows),
        BALANCED: sum(r.balanced_minutes for r in rows),
        NO_DATA: sum(r.no_data_minutes for r in rows),
        SESSION_START: sum(r.session_start_minutes for r in rows),
        GAP: sum(r.gap_minutes for r in rows),
    }
    state_shares = {
        state: (state_minutes[state] / denom if denom > 0 else 0.0)
        for state in (BUYERS, SELLERS, BALANCED, NO_DATA)
    }
    starts_total = sum(r.starts for r in rows)
    ends_total = sum(r.ends for r in rows)
    reversals_total = sum(r.reversals for r in rows)
    return SymbolAggregate(
        symbol=symbol,
        sessions=count,
        starts_total=starts_total,
        starts_per_session=(starts_total / count if count else 0.0),
        buyers_starts_total=sum(r.buyers_starts for r in rows),
        sellers_starts_total=sum(r.sellers_starts for r in rows),
        ends_total=ends_total,
        ends_per_session=(ends_total / count if count else 0.0),
        ends_to_balanced_total=sum(r.ends_to_balanced for r in rows),
        ends_to_gap_total=sum(r.ends_to_gap for r in rows),
        direct_flips_total=sum(r.direct_flips for r in rows),
        reversals_total=reversals_total,
        reversals_per_session=(reversals_total / count if count else 0.0),
        state_minutes=state_minutes,
        state_shares=state_shares,
        ratio_reached_balanced_minutes=sum(r.ratio_reached_balanced_minutes for r in rows),
        hold_minutes={h: sum(r.hold_minutes.get(h, 0) for r in rows) for h in FUTURES_HOLDS},
        hold_spells={h: sum(r.hold_spells.get(h, 0) for r in rows) for h in FUTURES_HOLDS},
    )


def evaluate_stability(
    sessions: Mapping[tuple[str, str], SessionTapeInput],
    *,
    rules: FuturesRules = FUTURES_RULES,
    min_covered_minutes: int = MIN_STREAMED_COVERED_MINUTES,
    min_sessions: int = TASK1_MIN_SESSIONS,
    task2_min_sessions: int = TASK2_MIN_SESSIONS,
    from_day: str | None = FIRST_STREAMED_DAY,
    to_day: str | None = None,
) -> StabilityReport:
    """Qualify streamed RTH sessions and summarize futures state stability across them (no returns read)."""
    days = sorted({day for day, _ in sessions.keys()})
    if from_day is not None:
        days = [d for d in days if d >= from_day]
    if to_day is not None:
        days = [d for d in days if d <= to_day]

    qualifying_days: list[str] = []
    disqualified: list[DisqualifiedDay] = []
    per_session: list[SessionStability] = []

    for day in days:
        es_input = sessions.get((day, "ES"))
        nq_input = sessions.get((day, "NQ"))
        es_cov = len(es_input.covered_minutes) if es_input else 0
        nq_cov = len(nq_input.covered_minutes) if nq_input else 0
        reason = classify_session_day(day, es_cov, nq_cov, min_covered_minutes=min_covered_minutes)
        if reason is not None:
            disqualified.append(
                DisqualifiedDay(day=day, reason=reason, es_covered_minutes=es_cov, nq_covered_minutes=nq_cov)
            )
            continue
        qualifying_days.append(day)
        assert es_input is not None and nq_input is not None
        per_session.append(summarize_futures_session(es_input, rules=rules))
        per_session.append(summarize_futures_session(nq_input, rules=rules))

    by_symbol = {
        "ES": _aggregate_symbol("ES", [s for s in per_session if s.symbol == "ES"]),
        "NQ": _aggregate_symbol("NQ", [s for s in per_session if s.symbol == "NQ"]),
        "ALL": _aggregate_symbol("ALL", per_session),
    }
    return StabilityReport(
        rules=rules,
        min_covered_minutes=min_covered_minutes,
        min_sessions=min_sessions,
        task2_min_sessions=task2_min_sessions,
        qualifying_days=tuple(qualifying_days),
        disqualified_days=tuple(disqualified),
        per_session=tuple(per_session),
        by_symbol=by_symbol,
    )


def _validate_iso_day(value: str) -> str:
    return date.fromisoformat(value).isoformat()


READONLY_SESSION_SQL = "SET default_transaction_read_only = on;"


def build_readonly_sql(table: str, from_day: str, to_day: str | None = None) -> str:
    """Build a strictly read-only SELECT query emitting one JSON object per row."""
    start = _validate_iso_day(from_day)
    end_clause = ""
    if to_day is not None:
        end = _validate_iso_day(to_day)
        col = "minute" if table == "flow_minutes" else "second"
        end_clause = f" AND {col} < ('{end}'::date + INTERVAL '2 days') AT TIME ZONE 'UTC'"
    if table == "flow_minutes":
        inner = (
            "SELECT symbol, minute, covered_seconds, delta, volume, vwap, close "
            "FROM flow_minutes "
            "WHERE symbol IN ('ES', 'NQ') "
            f"AND minute >= ('{start}'::date - INTERVAL '1 day') AT TIME ZONE 'UTC'{end_clause} "
            "ORDER BY symbol, minute"
        )
    elif table == "flow_large_trades":
        inner = (
            "SELECT symbol, second, side, size, capture "
            "FROM flow_large_trades "
            "WHERE symbol IN ('ES', 'NQ') "
            f"AND second >= ('{start}'::date - INTERVAL '1 day') AT TIME ZONE 'UTC'{end_clause} "
            "ORDER BY symbol, second, seq"
        )
    else:
        raise ValueError(f"Unsupported table: {table}")
    return f"SELECT row_to_json(t) FROM ({inner}) AS t;"


def build_psql_command(
    sql: str,
    *,
    dsn: str | None = None,
    ssh_host: str | None = None,
    docker_container: str | None = None,
    pg_user: str = "vertex_research",
    pg_db: str = "vertex",
) -> list[str]:
    """Construct a read-only psql invocation (local DSN or remote SSH/docker container)."""
    base_psql = ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-Atq"]
    sql_args = ["-c", READONLY_SESSION_SQL, "-c", sql]
    if ssh_host:
        if docker_container:
            remote_args = [
                "docker",
                "exec",
                "-i",
                docker_container,
                *base_psql,
                "-U",
                pg_user,
                "-d",
                pg_db,
                *sql_args,
            ]
        else:
            remote_args = [*base_psql, "-U", pg_user, "-d", pg_db, *sql_args]
        return ["ssh", "-o", "BatchMode=yes", ssh_host, shlex.join(remote_args)]
    if dsn:
        return [*base_psql, dsn, *sql_args]
    return [*base_psql, *sql_args]


def _run_psql_jsonl(cmd: Sequence[str], label: str) -> list[dict]:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(f"psql {label} failed (exit {proc.returncode}): {err}")
    rows: list[dict] = []
    for line in proc.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parsed = json.loads(stripped)
        if not isinstance(parsed, dict):
            raise RuntimeError(f"psql {label}: expected JSON object row, got {type(parsed).__name__}")
        rows.append(parsed)
    return rows


def load_rows_from_psql(
    *,
    from_day: str = FIRST_STREAMED_DAY,
    to_day: str | None = None,
    dsn: str | None = None,
    ssh_host: str | None = None,
    docker_container: str | None = None,
    pg_user: str = "vertex_research",
    pg_db: str = "vertex",
) -> tuple[list[RawMinuteRow], list[RawDeepTradeRow]]:
    """Read `flow_minutes` and `flow_large_trades` from PostgreSQL in read-only transactions."""
    minutes_sql = build_readonly_sql("flow_minutes", from_day, to_day)
    trades_sql = build_readonly_sql("flow_large_trades", from_day, to_day)
    minutes_cmd = build_psql_command(
        minutes_sql,
        dsn=dsn,
        ssh_host=ssh_host,
        docker_container=docker_container,
        pg_user=pg_user,
        pg_db=pg_db,
    )
    trades_cmd = build_psql_command(
        trades_sql,
        dsn=dsn,
        ssh_host=ssh_host,
        docker_container=docker_container,
        pg_user=pg_user,
        pg_db=pg_db,
    )
    raw_minutes = _run_psql_jsonl(minutes_cmd, "flow_minutes")
    raw_trades = _run_psql_jsonl(trades_cmd, "flow_large_trades")

    minute_rows = [
        RawMinuteRow(
            symbol=str(r["symbol"]),
            minute=parse_utc_timestamp(r["minute"]),
            covered_seconds=int(r["covered_seconds"]),
            delta=float(r["delta"]),
            volume=float(r["volume"]),
            vwap=float(r["vwap"]),
            close=float(r["close"]),
        )
        for r in raw_minutes
    ]
    trade_rows = [
        RawDeepTradeRow(
            symbol=str(r["symbol"]),
            second=parse_utc_timestamp(r["second"]),
            side=str(r["side"]),
            size=float(r["size"]),
            capture=str(r.get("capture", "streamed")),
        )
        for r in raw_trades
    ]
    return minute_rows, trade_rows


def format_markdown_report(report: StabilityReport) -> str:
    """Format a concise Markdown summary for Task 1 (state-stability count, zero returns read)."""
    q_count = len(report.qualifying_days)
    status = "READY" if report.ready_for_task1 else "TIME-GATED"
    lines = [
        f"# Futures Control State Stability ({report.rules.version})",
        "",
        f"- Status: **{status}** ({q_count}/{report.min_sessions} qualifying streamed RTH sessions for Task 1; "
        f"{q_count}/{report.task2_min_sessions} for Task 2)",
        f"- Streamed session bar: full NYSE RTH day (390 min), >= {report.min_covered_minutes} covered minutes "
        f"(covered_seconds >= {report.rules.min_covered_seconds}) for both ES and NQ",
        "- Returns / P&L read: **none** (rules stability and entry-check holds only)",
        "",
    ]
    if report.qualifying_days:
        lines.append(f"Qualifying sessions ({q_count}): " + ", ".join(report.qualifying_days))
        lines.append("")
        lines.append("## Aggregate by symbol")
        lines.append("")
        lines.append(
            "| Symbol | Sessions | Starts (/sess) | Ends (/sess) | Ends (gap) | Direct flips | Reversals (/sess) | "
            "Buyers % | Sellers % | Balanced % | No-data % | Hold: few_trades (min/spells) | "
            "Hold: delta_against (min/spells) | Hold: price_against (min/spells) |"
        )
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for sym in ("ES", "NQ", "ALL"):
            agg = report.by_symbol[sym]
            lines.append(
                f"| {sym} | {agg.sessions} | {agg.starts_total} ({agg.starts_per_session:.2f}) | "
                f"{agg.ends_total} ({agg.ends_per_session:.2f}) | {agg.ends_to_gap_total} | "
                f"{agg.direct_flips_total} | {agg.reversals_total} ({agg.reversals_per_session:.2f}) | "
                f"{agg.state_shares[BUYERS] * 100:.1f}% | {agg.state_shares[SELLERS] * 100:.1f}% | "
                f"{agg.state_shares[BALANCED] * 100:.1f}% | {agg.state_shares[NO_DATA] * 100:.1f}% | "
                f"{agg.hold_minutes['few_trades']}/{agg.hold_spells['few_trades']} | "
                f"{agg.hold_minutes['delta_against']}/{agg.hold_spells['delta_against']} | "
                f"{agg.hold_minutes['price_against']}/{agg.hold_spells['price_against']} |"
            )
        lines.append("")
        lines.append("## Per session")
        lines.append("")
        lines.append(
            "| Day | Symbol | Covered | Starts (B/S) | Ends (bal/gap) | Flips (dir/rev) | "
            "B/S/Bal/ND min | Holds min (few/delta/price) | Sampled deep |"
        )
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for s in report.per_session:
            lines.append(
                f"| {s.day} | {s.symbol} | {s.covered_minutes}/390 | "
                f"{s.starts} ({s.buyers_starts}/{s.sellers_starts}) | "
                f"{s.ends} ({s.ends_to_balanced}/{s.ends_to_gap}) | "
                f"{s.direct_flips}/{s.reversals} | "
                f"{s.buyers_minutes}/{s.sellers_minutes}/{s.balanced_minutes}/{s.no_data_minutes} | "
                f"{s.hold_minutes['few_trades']}/{s.hold_minutes['delta_against']}/{s.hold_minutes['price_against']} | "
                f"{s.sampled_deep_trades} |"
            )
        lines.append("")
    if report.disqualified_days:
        lines.append("## Disqualified days observed")
        lines.append("")
        lines.append("| Day | Reason | ES covered | NQ covered |")
        lines.append("| --- | --- | ---: | ---: |")
        for d in report.disqualified_days:
            lines.append(f"| {d.day} | {d.reason} | {d.es_covered_minutes}/390 | {d.nq_covered_minutes}/390 |")
        lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Task 1 futures control state-stability count on streamed ES/NQ RTH sessions (no returns read)."
    )
    parser.add_argument("--from-day", default=FIRST_STREAMED_DAY, help="First NY session date (YYYY-MM-DD).")
    parser.add_argument("--to-day", default=None, help="Last NY session date (YYYY-MM-DD).")
    parser.add_argument("--min-sessions", type=int, default=TASK1_MIN_SESSIONS, help="Minimum streamed sessions required.")
    parser.add_argument(
        "--min-covered",
        type=int,
        default=MIN_STREAMED_COVERED_MINUTES,
        help="Minimum covered minutes of 390 per symbol.",
    )
    parser.add_argument("--dsn", default=None, help="PostgreSQL DSN (defaults to DATABASE_URL env var).")
    parser.add_argument("--ssh-host", default=None, help="Optional SSH host for remote read-only psql.")
    parser.add_argument("--docker-container", default=None, help="Optional Docker container running Postgres on ssh-host.")
    parser.add_argument("--pg-user", default="vertex_research", help="PostgreSQL user (with --ssh-host).")
    parser.add_argument("--pg-db", default="vertex", help="PostgreSQL database name (with --ssh-host).")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format.")
    args = parser.parse_args(argv)

    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn and not args.ssh_host:
        print("Error: set DATABASE_URL, pass --dsn, or pass --ssh-host.", file=sys.stderr)
        return 2

    minute_rows, trade_rows = load_rows_from_psql(
        from_day=args.from_day,
        to_day=args.to_day,
        dsn=dsn,
        ssh_host=args.ssh_host,
        docker_container=args.docker_container,
        pg_user=args.pg_user,
        pg_db=args.pg_db,
    )
    sessions = build_session_inputs(minute_rows, trade_rows, rules=FUTURES_RULES)
    report = evaluate_stability(
        sessions,
        rules=FUTURES_RULES,
        min_covered_minutes=args.min_covered,
        min_sessions=args.min_sessions,
        from_day=args.from_day,
        to_day=args.to_day,
    )
    if args.format == "json":
        print(json.dumps(report.to_json(), indent=2))
    else:
        print(format_markdown_report(report))
    return 0 if report.ready_for_task1 else EXIT_TIME_GATED


if __name__ == "__main__":
    raise SystemExit(main())
