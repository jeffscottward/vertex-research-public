"""Task 2 agreement continuation study: futures state + options agreement replay (research only).

Re-runs the continuation study of `docs/specs/strategies/flow-control-continuation.md` with the streamed ES/NQ
futures state (`flow-futures-rules.v1` or a calibrated successor) and its agreement with the options net drift
state (`flow-control-rules.v1`), and reports how often each futures state, options group state, and agreement
value occurred across qualifying streamed RTH sessions.

Hold gate: requires at least 20 qualifying streamed RTH sessions (>= 370 of 390 RTH minutes with
`covered_seconds >= min_covered_seconds` for both ES and NQ, aligned with QuantData net drift for SPX/SPY/QQQ/NDX).
Below the gate, the CLI reports qualification counts only and exits with status 3 (`EXIT_TIME_GATED`) without
computing returns or trades.

Research only: reads PostgreSQL in read-only transactions and local net-drift files; places no orders, writes
nothing to the database, and leaves the frozen options-only spec (`rules.SPEC_SHA256`) untouched.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import subprocess
import sys
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from strategies.qc_ports import data as qc_data
from strategies.triple_rsi.report import STYLE, _e, _mark, _table

from . import data, fomc, options, rules, study
from .control import (
    AGREE,
    BALANCED,
    BEARISH,
    BOTH_BALANCED,
    BULLISH,
    BUYERS,
    DIVERGE,
    FUTURES_RULES,
    GAP,
    MIXED,
    NO_DATA,
    NOT_COMPARABLE,
    ONE_SIDED,
    RULES,
    SELLERS,
    SESSION_START,
    AgreementResult,
    ControlRules,
    FuturesRules,
    agreement_of,
    fold_control_state,
    fold_futures_state,
    group_options_state,
)
from .download import outside_repository
from .rules import (
    BARS,
    ENTRY_FIRST,
    ENTRY_LAST,
    HARD_STOP_PCT,
    SPEC_SHA256,
    TIME_EXIT,
    Params,
    Session,
    Trade,
    group_states,
    trend,
)
from .stability import (
    EXIT_TIME_GATED,
    FIRST_STREAMED_DAY,
    MIN_STREAMED_COVERED_MINUTES,
    SESSION_MINUTES,
    TASK2_MIN_SESSIONS,
    DisqualifiedDay,
    SessionTapeInput,
    build_session_inputs,
    classify_session_day,
    load_rows_from_psql,
)

SCHEMA = "flow-control-agreement-study-v1"
LIMIT_TEXT = "Streamed ES/NQ futures + options agreement rule with modelled fills."
REPO_ROOT = Path(__file__).resolve().parents[4]

# group_key -> (future_symbol, primary_ticker, check_ticker)
GROUPS: dict[str, tuple[str, str, str]] = {
    "sp500": ("ES", "SPX", "SPY"),
    "nasdaq100": ("NQ", "QQQ", "NDX"),
}
INSTRUMENT_GROUP: dict[str, str] = {
    "ES": "sp500",
    "SPY": "sp500",
    "NQ": "nasdaq100",
    "QQQ": "nasdaq100",
}
MODES = ("agreement", "futures_only", "options_only")
FUTURES_STATE_KEYS = (BUYERS, SELLERS, BALANCED, NO_DATA)
OPTIONS_STATE_KEYS = (BUYERS, SELLERS, BALANCED, MIXED, NO_DATA)
AGREEMENT_STATE_KEYS = (AGREE, DIVERGE, ONE_SIDED, BOTH_BALANCED, NOT_COMPARABLE)
MARKET_SYMBOLS = ("SPY", "QQQ")


def _validate_iso_day(value: str) -> str:
    return date.fromisoformat(value).isoformat()


# --- alignment and qualification ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class AlignedSessions:
    """Result of qualifying streamed ES/NQ RTH sessions and aligning them with net drift."""

    from_day: str | None
    to_day: str | None
    min_covered_minutes: int
    streamed_qualifying_days: tuple[str, ...]
    usable_days: tuple[str, ...]
    disqualified_tape_days: tuple[DisqualifiedDay, ...]
    missing_net_drift_days: tuple[dict[str, object], ...]
    net_drift_only_days: tuple[str, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "fromDay": self.from_day,
            "toDay": self.to_day,
            "minCoveredMinutes": self.min_covered_minutes,
            "streamedQualifyingCount": len(self.streamed_qualifying_days),
            "streamedQualifyingDays": list(self.streamed_qualifying_days),
            "usableSessionCount": len(self.usable_days),
            "usableDays": list(self.usable_days),
            "disqualifiedTapeDays": [d.to_json() for d in self.disqualified_tape_days],
            "missingNetDriftDays": [dict(item) for item in self.missing_net_drift_days],
            "netDriftOnlyDays": list(self.net_drift_only_days),
        }


def align_sessions(
    tape_sessions: Mapping[tuple[str, str], SessionTapeInput],
    loaded: data.Loaded,
    *,
    min_covered_minutes: int = MIN_STREAMED_COVERED_MINUTES,
    from_day: str | None = FIRST_STREAMED_DAY,
    to_day: str | None = None,
) -> AlignedSessions:
    """Qualify streamed ES/NQ RTH sessions (>= 370/390 covered min each) and intersect with net-drift days."""
    if min_covered_minutes < 1 or min_covered_minutes > SESSION_MINUTES:
        raise ValueError(
            f"min_covered_minutes must be between 1 and {SESSION_MINUTES}, got {min_covered_minutes}"
        )
    norm_from = _validate_iso_day(from_day) if from_day is not None else None
    norm_to = _validate_iso_day(to_day) if to_day is not None else None
    if norm_from is not None and norm_to is not None and norm_to < norm_from:
        raise ValueError(f"to_day ({norm_to}) precedes from_day ({norm_from})")

    tape_days = sorted({day for day, _ in tape_sessions})
    if norm_from is not None:
        tape_days = [d for d in tape_days if d >= norm_from]
    if norm_to is not None:
        tape_days = [d for d in tape_days if d <= norm_to]

    skip_reasons_by_day: dict[str, list[str]] = defaultdict(list)
    for item in loaded.skipped:
        day = str(item.get("day", ""))
        ticker = str(item.get("ticker", ""))
        reason = str(item.get("reason", ""))
        if day:
            skip_reasons_by_day[day].append(f"{ticker}:{reason}" if ticker else reason)

    streamed_qualifying: list[str] = []
    usable: list[str] = []
    disqualified: list[DisqualifiedDay] = []
    missing_nd: list[dict[str, object]] = []

    for day in tape_days:
        es_input = tape_sessions.get((day, "ES"))
        nq_input = tape_sessions.get((day, "NQ"))
        es_cov = len(es_input.covered_minutes) if es_input else 0
        nq_cov = len(nq_input.covered_minutes) if nq_input else 0
        reason = classify_session_day(day, es_cov, nq_cov, min_covered_minutes=min_covered_minutes)
        if reason is not None or es_input is None or nq_input is None:
            disqualified.append(
                DisqualifiedDay(
                    day=day,
                    reason=reason or "both_under_covered",
                    es_covered_minutes=es_cov,
                    nq_covered_minutes=nq_cov,
                )
            )
            continue
        streamed_qualifying.append(day)
        if day in loaded.sessions:
            usable.append(day)
        else:
            reasons = skip_reasons_by_day.get(day) or ["missing"]
            missing_nd.append({"day": day, "reasons": reasons})

    qualifying_set = set(streamed_qualifying)
    nd_only = [
        day
        for day in loaded.days
        if (norm_from is None or day >= norm_from)
        and (norm_to is None or day <= norm_to)
        and day not in qualifying_set
    ]
    return AlignedSessions(
        from_day=norm_from,
        to_day=norm_to,
        min_covered_minutes=min_covered_minutes,
        streamed_qualifying_days=tuple(streamed_qualifying),
        usable_days=tuple(usable),
        disqualified_tape_days=tuple(disqualified),
        missing_net_drift_days=tuple(missing_nd),
        net_drift_only_days=tuple(nd_only),
    )


# --- timelines and state/agreement frequencies --------------------------------------------------------------------


@dataclass(frozen=True)
class GroupTimeline:
    """Minute-by-minute futures state, options group state and agreement for one group and session."""

    day: str
    group: str
    future_symbol: str
    futures_states: tuple[str, ...]
    futures_no_data_reasons: tuple[str | None, ...]
    options_states: tuple[str, ...]
    agreements: tuple[AgreementResult, ...]
    effective_agreement_states: tuple[str, ...]


def _padded_options_states(minutes, options_rules: ControlRules, steps_count: int) -> list[str]:
    steps = fold_control_state(minutes, options_rules)
    out = [step.state for step in steps[:steps_count]]
    if len(out) < steps_count:
        out.extend([NO_DATA] * (steps_count - len(out)))
    return out


def _effective_agreement_state(result: AgreementResult) -> str:
    if result.state == AGREE and result.direction == BULLISH:
        return BUYERS
    if result.state == AGREE and result.direction == BEARISH:
        return SELLERS
    return result.state


def fold_group_timeline(
    day: str,
    group: str,
    tape_input: SessionTapeInput,
    tickers: Mapping[str, data.TickerSession],
    *,
    options_rules: ControlRules = RULES,
    futures_rules: FuturesRules = FUTURES_RULES,
    steps_count: int = SESSION_MINUTES,
) -> GroupTimeline:
    """Fold both the options group state and the futures state over `0..steps_count - 1` and compute agreement."""
    fut_symbol, primary_sym, check_sym = GROUPS[group]
    primary = _padded_options_states(tickers[primary_sym].minutes, options_rules, steps_count)
    check = _padded_options_states(tickers[check_sym].minutes, options_rules, steps_count)
    opt_states = tuple(group_options_state(p, c) for p, c in zip(primary, check, strict=True))

    fut_steps = fold_futures_state(tape_input.covered_minutes, rules=futures_rules, through=steps_count - 1)
    fut_states = tuple(step.state for step in fut_steps[:steps_count])
    fut_reasons = tuple(step.no_data_reason for step in fut_steps[:steps_count])

    agreements = tuple(agreement_of(f, o) for f, o in zip(fut_states, opt_states, strict=True))
    effective = tuple(_effective_agreement_state(a) for a in agreements)
    return GroupTimeline(
        day=day,
        group=group,
        future_symbol=fut_symbol,
        futures_states=fut_states,
        futures_no_data_reasons=fut_reasons,
        options_states=opt_states,
        agreements=agreements,
        effective_agreement_states=effective,
    )


def build_timelines(
    days: Sequence[str],
    tape_sessions: Mapping[tuple[str, str], SessionTapeInput],
    loaded: data.Loaded,
    *,
    options_rules: ControlRules = RULES,
    futures_rules: FuturesRules = FUTURES_RULES,
    steps_count: int = SESSION_MINUTES,
) -> list[GroupTimeline]:
    """Build per-(day, group) timelines across all usable sessions."""
    out: list[GroupTimeline] = []
    for day in days:
        tickers = loaded.sessions[day]
        for group, (fut_sym, _, _) in GROUPS.items():
            tape_input = tape_sessions[(day, fut_sym)]
            out.append(
                fold_group_timeline(
                    day,
                    group,
                    tape_input,
                    tickers,
                    options_rules=options_rules,
                    futures_rules=futures_rules,
                    steps_count=steps_count,
                )
            )
    return out


def _count_window(timelines: Sequence[GroupTimeline], start: int, end_exclusive: int) -> dict[str, object]:
    fut_counts: dict[str, int] = {k: 0 for k in (*FUTURES_STATE_KEYS, SESSION_START, GAP)}
    opt_counts: dict[str, int] = {k: 0 for k in OPTIONS_STATE_KEYS}
    agr_counts: dict[str, int] = {
        k: 0 for k in (*AGREEMENT_STATE_KEYS, "agreeBullish", "agreeBearish")
    }
    total = 0
    for tl in timelines:
        stop = min(end_exclusive, len(tl.futures_states))
        for idx in range(start, stop):
            total += 1
            f_state = tl.futures_states[idx]
            fut_counts[f_state] += 1
            if f_state == NO_DATA:
                reason = tl.futures_no_data_reasons[idx]
                if reason == SESSION_START:
                    fut_counts[SESSION_START] += 1
                elif reason == GAP:
                    fut_counts[GAP] += 1
            opt_counts[tl.options_states[idx]] += 1
            agr = tl.agreements[idx]
            agr_counts[agr.state] += 1
            if agr.state == AGREE:
                if agr.direction == BULLISH:
                    agr_counts["agreeBullish"] += 1
                elif agr.direction == BEARISH:
                    agr_counts["agreeBearish"] += 1

    def _shares(counts: Mapping[str, int], keys: Sequence[str]) -> dict[str, float]:
        return {k: round(counts[k] / total, 6) if total > 0 else 0.0 for k in keys}

    return {
        "sessions": len(timelines),
        "totalMinutes": total,
        "futuresStates": fut_counts,
        "futuresShares": _shares(fut_counts, FUTURES_STATE_KEYS),
        "optionsStates": opt_counts,
        "optionsShares": _shares(opt_counts, OPTIONS_STATE_KEYS),
        "agreementStates": agr_counts,
        "agreementShares": _shares(agr_counts, AGREEMENT_STATE_KEYS),
    }


def summarize_frequencies(timelines: Sequence[GroupTimeline]) -> dict[str, object]:
    """Summarize state and agreement frequencies over full RTH (0..389) and entry window (15..120)."""
    by_group: dict[str, list[GroupTimeline]] = {g: [] for g in GROUPS}
    for tl in timelines:
        by_group[tl.group].append(tl)

    def _scope(start: int, end_exclusive: int) -> dict[str, object]:
        out = {g: _count_window(by_group[g], start, end_exclusive) for g in GROUPS}
        out["ALL"] = _count_window(timelines, start, end_exclusive)
        return out

    per_session: list[dict[str, object]] = []
    for tl in timelines:
        full_one = _count_window([tl], 0, SESSION_MINUTES)
        entry_one = _count_window([tl], ENTRY_FIRST, ENTRY_LAST + 1)
        per_session.append(
            {
                "day": tl.day,
                "group": tl.group,
                "futureSymbol": tl.future_symbol,
                "futuresStates": full_one["futuresStates"],
                "optionsStates": full_one["optionsStates"],
                "agreementStates": full_one["agreementStates"],
                "entryWindowAgreementStates": entry_one["agreementStates"],
            }
        )

    return {
        "fullSession": _scope(0, SESSION_MINUTES),
        "entryWindow": _scope(ENTRY_FIRST, ENTRY_LAST + 1),
        "perSession": per_session,
    }


# --- continuation trade rule with futures state and agreement -----------------------------------------------------


def session_trade_from_states(session: Session, states: Sequence[str], params: Params) -> Trade | None:
    """First trade of the session using the continuation rule of `flow-control-continuation.md` on `states`."""
    price, tp = session.price, session.trend_price
    for m in range(ENTRY_FIRST, params.entry_last + 1):
        if states[m] == BUYERS and trend(tp, m) == 1:
            side = 1
        elif states[m] == SELLERS and trend(tp, m) == -1:
            side = -1
        else:
            continue
        entry_bar = m + 1
        entry_price = price[entry_bar]
        for k in range(entry_bar, TIME_EXIT):
            if side * (price[k] / entry_price - 1) <= -HARD_STOP_PCT / 100:
                reason = "stop"
            elif states[k] != states[m]:
                reason = "state"
            else:
                continue
            exit_price = price[k + 1]
            return Trade(
                session.day,
                side,
                entry_bar,
                k + 1,
                entry_price,
                exit_price,
                reason,
                side * (exit_price - entry_price),
            )
        exit_price = price[TIME_EXIT]
        return Trade(
            session.day,
            side,
            entry_bar,
            TIME_EXIT,
            entry_price,
            exit_price,
            "time",
            side * (exit_price - entry_price),
        )
    return None


def trades_for_mode(
    instrument: str,
    days: Sequence[str],
    sessions: Sequence[Session],
    tape_sessions: Mapping[tuple[str, str], SessionTapeInput],
    loaded: data.Loaded,
    params: Params,
    *,
    mode: str = "agreement",
    options_rules: ControlRules = RULES,
    futures_rules: FuturesRules = FUTURES_RULES,
) -> list[Trade]:
    """Generate trades for one instrument across `days` under `agreement`, `futures_only`, or `options_only`."""
    if mode not in MODES:
        raise ValueError(f"Unsupported mode {mode!r}; expected one of {MODES}")
    group = INSTRUMENT_GROUP[instrument]
    fut_sym = GROUPS[group][0]
    opt_r = dataclasses.replace(options_rules, window_minutes=params.window_minutes)
    fut_r = dataclasses.replace(futures_rules, window_minutes=params.window_minutes)

    out: list[Trade] = []
    for day, session in zip(days, sessions, strict=True):
        if params.skip_fomc and fomc.is_fomc_day(day):
            continue
        if mode == "options_only":
            states: Sequence[str] = group_states(session, opt_r)
        elif mode == "futures_only":
            fut_steps = fold_futures_state(
                tape_sessions[(day, fut_sym)].covered_minutes, rules=fut_r, through=BARS - 1
            )
            states = [s.state for s in fut_steps[:BARS]]
        else:
            tl = fold_group_timeline(
                day,
                group,
                tape_sessions[(day, fut_sym)],
                loaded.sessions[day],
                options_rules=opt_r,
                futures_rules=fut_r,
                steps_count=BARS,
            )
            states = tl.effective_agreement_states
        trade = session_trade_from_states(session, states, params)
        if trade is not None:
            out.append(trade)
    return out


# --- study runner -------------------------------------------------------------------------------------------------


def _parts_stats(
    parts: Mapping[str, Sequence[str]],
    days: Sequence[str],
    pnl: Sequence[float],
    nets_by_day: Sequence[tuple[str, float]],
    held_by_day: Sequence[tuple[str, float]],
    capital: float,
    instruments: int,
) -> dict[str, dict]:
    index = {day: i for i, day in enumerate(days)}
    out: dict[str, dict] = {}
    for name, part in parts.items():
        members = set(part)
        out[name] = study.row_stats(
            [net for day, net in nets_by_day if day in members],
            [pnl[index[d]] for d in part],
            part,
            capital,
            sum(h for day, h in held_by_day if day in members),
            instruments,
        )
    return out


def _option_records(booked: Mapping) -> list[tuple[str, float]]:
    from strategies.imom.data import local_times

    clock = booked["clock"]
    out: list[tuple[str, float]] = []
    for record in booked["result"].trades:
        day = local_times([clock.real(record["entryDate"])])[0][0]
        out.append((day, float(record["pnl"])))
    return out


def _spread_held(spreads: Sequence) -> list[tuple[str, float]]:
    return [(s.day, (s.exit_ms - s.event.entry_ms) / 60_000) for s in spreads]


def _futures_rows_for_cfg(
    cfg: str,
    cfg_trades: Mapping[str, Sequence[Trade]],
    days: Sequence[str],
    parts: Mapping[str, Sequence[str]],
) -> tuple[dict[str, dict], list[float]]:
    rows: dict[str, dict] = {}
    both: dict[str, dict] = {}
    base_pnl: list[float] = [0.0] * len(days)
    for tick in study.SLIPPAGE_TICKS:
        pnl_sum = [0.0] * len(days)
        nets: list[tuple[str, float]] = []
        held: list[tuple[str, float]] = []
        for key in study.FUTURES:
            ts = cfg_trades[key]
            pnl = study.session_pnl(ts, days, key, tick)
            pnl_sum = [a + b for a, b in zip(pnl_sum, pnl, strict=True)]
            key_nets = [(t.day, study.trade_net(t, key, tick)) for t in ts]
            key_held = [(t.day, float(t.exit_bar - t.entry_bar)) for t in ts]
            nets += key_nets
            held += key_held
            rows.setdefault(
                f"{cfg}-F-{key}",
                {"form": "F", "instruments": [key], "capital": study.CAPITAL, "ticks": {}},
            )["ticks"][str(tick)] = _parts_stats(parts, days, pnl, key_nets, key_held, study.CAPITAL, 1)
        both[str(tick)] = _parts_stats(parts, days, pnl_sum, nets, held, 2 * study.CAPITAL, 2)
        if tick == study.BASE_TICKS:
            base_pnl = pnl_sum
    rows[f"{cfg}-F"] = {
        "form": "F",
        "instruments": list(study.FUTURES),
        "capital": 2 * study.CAPITAL,
        "ticks": both,
    }
    return rows, base_pnl


def _options_rows_for_cfg(
    cfg: str,
    cfg_trades: Mapping[str, Sequence[Trade]],
    days: Sequence[str],
    parts: Mapping[str, Sequence[str]],
    markets: Mapping[str, qc_data.Market],
    *,
    nautilus: bool,
) -> tuple[dict[str, dict], list[float], list[dict], list[float], dict[str, list]]:
    rows: dict[str, dict] = {}
    pnl_sum = [0.0] * len(days)
    nets: list[tuple[str, float]] = []
    held: list[tuple[str, float]] = []
    skipped_all: list[dict] = []
    max_gaps: list[float] = []
    spreads_by_sym: dict[str, list] = {}
    for symbol in study.OPTION_SYMBOLS:
        spreads, skipped = options.price_trades(symbol, cfg_trades[symbol], markets[symbol])
        spreads_by_sym[symbol] = spreads
        skipped_all += skipped
        use_engine = nautilus and cfg == "C0"
        booked = options.book_form(spreads, days, nautilus=use_engine)
        if use_engine and booked["maxGap"] is not None:
            max_gaps.append(booked["maxGap"])
        pnl = options.session_pnl_from_equity(booked["points"], days)
        sym_nets, sym_held = _option_records(booked), _spread_held(spreads)
        rows[f"{cfg}-O-{symbol}"] = {
            "form": "O",
            "instruments": [symbol],
            "capital": options.ACCOUNT,
            "priced": len(spreads),
            "skipped": len(skipped),
            "parts": _parts_stats(parts, days, pnl, sym_nets, sym_held, options.ACCOUNT, 1),
        }
        pnl_sum = [a + b for a, b in zip(pnl_sum, pnl, strict=True)]
        nets += sym_nets
        held += sym_held
    rows[f"{cfg}-O"] = {
        "form": "O",
        "instruments": list(study.OPTION_SYMBOLS),
        "capital": 2 * options.ACCOUNT,
        "priced": sum(rows[f"{cfg}-O-{s}"]["priced"] for s in study.OPTION_SYMBOLS),
        "skipped": sum(rows[f"{cfg}-O-{s}"]["skipped"] for s in study.OPTION_SYMBOLS),
        "parts": _parts_stats(parts, days, pnl_sum, nets, held, 2 * options.ACCOUNT, 2),
    }
    return rows, pnl_sum, skipped_all, max_gaps, spreads_by_sym


def _verdict_for_agreement(
    days_count: int,
    split_status: str,
    whole_trades: int,
    oos_trades: int,
    oos_net: float,
    dsr: Mapping[str, object],
    *,
    options_status: str = "ran",
) -> tuple[str, str]:
    if split_status != "full_walk_forward":
        return (
            "needs-more-data",
            f"Needs more data: {days_count} streamed sessions ({study.MIN_SESSIONS} needed for the "
            f"60/20/20 walk-forward split); {whole_trades} whole-period C0-F trades, 0 out-of-sample "
            f"trades ({study.MIN_OOS_TRADES} out-of-sample trades needed). {LIMIT_TEXT}",
        )
    net = study.usd(oos_net)
    if oos_trades < study.MIN_OOS_TRADES:
        return (
            "needs-more-data",
            f"Needs more data: {oos_trades} out-of-sample trades, {study.MIN_OOS_TRADES} needed. {LIMIT_TEXT}",
        )
    if options_status != "ran":
        return (
            "needs-more-data",
            f"Needs more data: option market data is required for the 10-trial deflated Sharpe ratio "
            f"({oos_trades} out-of-sample trades, net {net} at 1 tick per side). {LIMIT_TEXT}",
        )
    p = dsr.get("probability")
    if p is None:
        return (
            "no-edge",
            f"No edge: deflated Sharpe not computable: {dsr.get('error')}. {oos_trades} out-of-sample "
            f"trades, net {net} at 1 tick per side. {LIMIT_TEXT}",
        )
    if oos_net > 0 and float(p) >= study.DSR_PASS:
        return (
            "edge",
            f"Edge: {oos_trades} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe "
            f"{float(p):.3f} (bar 0.95, N = 10). {LIMIT_TEXT}",
        )
    return (
        "no-edge",
        f"No edge: {oos_trades} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe "
        f"{float(p):.3f} (bar 0.95, N = 10). {LIMIT_TEXT}",
    )


def run_agreement_study(
    days: Sequence[str],
    tape_sessions: Mapping[tuple[str, str], SessionTapeInput],
    loaded: data.Loaded,
    *,
    options_rules: ControlRules = RULES,
    futures_rules: FuturesRules = FUTURES_RULES,
    markets: Mapping[str, qc_data.Market] | None = None,
    nautilus: bool = True,
    min_sessions: int = TASK2_MIN_SESSIONS,
    alignment: AlignedSessions | None = None,
) -> dict[str, object]:
    """Run the Task 2 continuation study with futures state and agreement across `days`."""
    day_list = list(days)
    timelines = build_timelines(
        day_list, tape_sessions, loaded, options_rules=options_rules, futures_rules=futures_rules
    )
    frequencies = summarize_frequencies(timelines)

    if len(day_list) >= study.MIN_SESSIONS:
        split = study.split_sessions(day_list)
        split_status = "full_walk_forward"
        parts = study.part_days(split, day_list)
    else:
        split = study.Split((), (), (), ())
        split_status = "below_min_sessions"
        parts = {
            "whole": tuple(day_list),
            "train": (),
            "validation": (),
            "test": (),
            "outOfSample": (),
            "windowChoice": (),
        }

    sessions = {
        key: [study.build_session(key, day, loaded.sessions[day]) for day in day_list]
        for key in study.INSTRUMENTS
    }
    agreement_trades = {
        cfg: {
            key: trades_for_mode(
                key,
                day_list,
                sessions[key],
                tape_sessions,
                loaded,
                params,
                mode="agreement",
                options_rules=options_rules,
                futures_rules=futures_rules,
            )
            for key in study.INSTRUMENTS
        }
        for cfg, params in study.CONFIGS.items()
    }

    rows: dict[str, dict] = {}
    series: dict[str, list[float]] = {}
    oos_index = [day_list.index(d) for d in split.out_of_sample]
    for cfg in study.CONFIGS:
        f_rows, base_pnl = _futures_rows_for_cfg(cfg, agreement_trades[cfg], day_list, parts)
        rows.update(f_rows)
        if split_status == "full_walk_forward":
            series[f"{cfg}-F"] = [base_pnl[i] for i in oos_index]

    options_status = "not_provided"
    options_skipped: list[dict] = []
    max_gaps: list[float] = []
    if markets is not None:
        options_status = "ran"
        c0_spreads: dict[str, list] = {}
        for cfg in study.CONFIGS:
            o_rows, o_pnl, skipped, gaps, spreads_map = _options_rows_for_cfg(
                cfg, agreement_trades[cfg], day_list, parts, markets, nautilus=nautilus
            )
            rows.update(o_rows)
            if cfg == "C0":
                options_skipped = skipped
                c0_spreads = spreads_map
                max_gaps.extend(gaps)
            if split_status == "full_walk_forward":
                series[f"{cfg}-O"] = [o_pnl[i] for i in oos_index]
        # Stress: twice the spread cost on C0 option spreads.
        stress_pnl = [0.0] * len(day_list)
        stress_nets: list[tuple[str, float]] = []
        stress_held: list[tuple[str, float]] = []
        for symbol in study.OPTION_SYMBOLS:
            stressed = [options.stress_costs(s) for s in c0_spreads[symbol]]
            booked = options.book_form(stressed, day_list, nautilus=False)
            pnl = options.session_pnl_from_equity(booked["points"], day_list)
            stress_pnl = [a + b for a, b in zip(stress_pnl, pnl, strict=True)]
            stress_nets += _option_records(booked)
            stress_held += _spread_held(stressed)
        rows["C0-O-stress"] = {
            "form": "O",
            "instruments": list(study.OPTION_SYMBOLS),
            "capital": 2 * options.ACCOUNT,
            "priced": sum(len(v) for v in c0_spreads.values()),
            "parts": _parts_stats(parts, day_list, stress_pnl, stress_nets, stress_held, 2 * options.ACCOUNT, 2),
        }

    # Companion mode comparison at C0 on the exact same sessions.
    mode_comparison: dict[str, dict[str, dict]] = {}
    for mode in MODES:
        if mode == "agreement":
            mode_trades = agreement_trades["C0"]
        else:
            mode_trades = {
                key: trades_for_mode(
                    key,
                    day_list,
                    sessions[key],
                    tape_sessions,
                    loaded,
                    study.CONFIGS["C0"],
                    mode=mode,
                    options_rules=options_rules,
                    futures_rules=futures_rules,
                )
                for key in study.INSTRUMENTS
            }
        m_rows, _ = _futures_rows_for_cfg("C0", mode_trades, day_list, parts)
        if markets is not None:
            mo_rows, _, _, _, _ = _options_rows_for_cfg(
                "C0", mode_trades, day_list, parts, markets, nautilus=False
            )
            m_rows.update(mo_rows)
        mode_comparison[mode] = m_rows

    if split_status != "full_walk_forward":
        dsr: dict[str, object] = {
            "probability": None,
            "error": f"walk-forward split requires at least {study.MIN_SESSIONS} sessions (have {len(day_list)})",
            "trials": study.N_TRIALS,
            "rows": len(series),
        }
    elif markets is None:
        dsr = {
            "probability": None,
            "error": "option market data not provided (only 5 of 10 trials ran)",
            "trials": study.N_TRIALS,
            "rows": len(series),
        }
    else:
        order = [f"{cfg}-{form}" for form in study.FORMS for cfg in study.CONFIGS]
        series = {name: series[name] for name in order}
        dsr = study.deflated_sharpe(series, primary=study.PRIMARY, n_trials=study.N_TRIALS)

    whole_c0 = rows["C0-F"]["ticks"][str(study.BASE_TICKS)]["whole"]
    oos_c0 = rows["C0-F"]["ticks"][str(study.BASE_TICKS)]["outOfSample"]
    verdict, verdict_reason = _verdict_for_agreement(
        len(day_list),
        split_status,
        int(whole_c0["trades"]),
        int(oos_c0["trades"]),
        float(oos_c0["netUsd"]),
        dsr,
        options_status=options_status,
    )

    if nautilus:
        naut = study.nautilus_check(sessions, agreement_trades["C0"])
        if max_gaps:
            naut["optionsMaxGap"] = max(max_gaps)
    else:
        naut = {"status": "not run", "reason": "disabled"}

    fomc_days = [d for d in day_list if fomc.is_fomc_day(d)]
    split_summary = {
        name: {
            "sessions": len(part),
            "first": part[0] if part else None,
            "last": part[-1] if part else None,
        }
        for name, part in parts.items()
    }

    return {
        "schema": SCHEMA,
        "readyForTask2": len(day_list) >= min_sessions,
        "minSessions": min_sessions,
        "usableSessionCount": len(day_list),
        "first": day_list[0] if day_list else None,
        "last": day_list[-1] if day_list else None,
        "splitStatus": split_status,
        "split": split_summary,
        "verdict": verdict,
        "verdictReason": verdict_reason,
        "optionsStatus": options_status,
        "rules": {
            "options": {
                "version": options_rules.version,
                "windowMinutes": options_rules.window_minutes,
                "enterRatio": options_rules.enter_ratio,
                "exitRatio": options_rules.exit_ratio,
                "minMinutes": options_rules.min_minutes,
                "minBuckets": options_rules.min_buckets,
            },
            "futures": futures_rules.to_json(),
            "specSha256": SPEC_SHA256,
        },
        "alignment": alignment.to_json() if alignment is not None else None,
        "frequencies": frequencies,
        "rows": rows,
        "modeComparison": mode_comparison,
        "series": series,
        "deflatedSharpe": dsr,
        "diagnostics": {
            "nautilus": naut,
            "fomc": {"days": fomc_days, "count": len(fomc_days)},
            "optionsSkipped": {"count": len(options_skipped), "items": options_skipped[:20]},
        },
    }


def _time_gated_payload(
    aligned: AlignedSessions,
    *,
    min_sessions: int,
    options_rules: ControlRules = RULES,
    futures_rules: FuturesRules = FUTURES_RULES,
) -> dict[str, object]:
    """Return a zero-peeking status payload when fewer than `min_sessions` qualifying sessions exist."""
    return {
        "schema": SCHEMA,
        "readyForTask2": False,
        "minSessions": min_sessions,
        "streamedQualifyingCount": len(aligned.streamed_qualifying_days),
        "usableSessionCount": len(aligned.usable_days),
        "rules": {
            "options": {"version": options_rules.version},
            "futures": futures_rules.to_json(),
            "specSha256": SPEC_SHA256,
        },
        "alignment": aligned.to_json(),
    }


# --- Markdown and dark HTML reports -------------------------------------------------------------------------------


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _num(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def format_markdown_report(result: Mapping[str, object]) -> str:
    """Format a concise Markdown report for either a time-gated status or a completed Task 2 study."""
    ready = bool(result.get("readyForTask2"))
    min_sess = int(result.get("minSessions", TASK2_MIN_SESSIONS))
    usable_n = int(result.get("usableSessionCount", 0))
    status = f"**READY ({usable_n}/{min_sess} qualifying streamed RTH sessions)**" if ready else (
        f"**TIME-GATED ({usable_n}/{min_sess} qualifying streamed RTH sessions)**"
    )
    lines = [
        "# Flow control: Task 2 agreement continuation study",
        "",
        f"- Status: {status}",
    ]
    rules_info = result.get("rules", {})
    if isinstance(rules_info, Mapping):
        opt_v = rules_info.get("options", {}).get("version", RULES.version)
        fut_v = rules_info.get("futures", {}).get("version", FUTURES_RULES.version)
        lines.append(f"- Rules: options `{opt_v}`, futures `{fut_v}`")
    lines.append("- Research only: modelled fills; no orders, no deployment, no trading authority.")
    lines.append("")

    alignment = result.get("alignment")
    if not ready:
        lines.append("No returns, trades, or verdict were computed before the 20-session time gate.")
        if isinstance(alignment, Mapping):
            lines.append(
                f"- Streamed qualifying tape sessions: {alignment.get('streamedQualifyingCount', 0)}; "
                f"aligned with net drift: {usable_n}"
            )
            missing_nd = alignment.get("missingNetDriftDays") or []
            if missing_nd:
                lines.append("")
                lines.append("## Streamed sessions missing net drift")
                lines.append("")
                lines.append("| Day | Net drift skip reasons |")
                lines.append("| --- | --- |")
                for item in missing_nd:
                    lines.append(f"| {item['day']} | {', '.join(item['reasons'])} |")
            disq = alignment.get("disqualifiedTapeDays") or []
            if disq:
                lines.append("")
                lines.append("## Disqualified tape days observed")
                lines.append("")
                lines.append("| Day | Reason | ES covered | NQ covered |")
                lines.append("| --- | --- | ---: | ---: |")
                for d in disq:
                    lines.append(
                        f"| {d['day']} | {d['reason']} | {d['esCoveredMinutes']}/390 | {d['nqCoveredMinutes']}/390 |"
                    )
        lines.append("")
        return "\n".join(lines)

    lines.extend([
        "## Verdict",
        "",
        f"- **Verdict:** `{result['verdict']}`",
        f"- **Reason:** {result['verdictReason']}",
        f"- **Sessions:** {usable_n} ({result['first']} to {result['last']}); split: `{result['splitStatus']}`",
        "",
        "## State and agreement frequencies",
        "",
    ])
    freqs = result["frequencies"]
    for scope_key, title in (("fullSession", "Full RTH session (09:30-15:59, 390 min/session)"),
                             ("entryWindow", "Entry window (09:45-11:30, 106 min/session)")):
        lines.append(f"### {title}")
        lines.append("")
        lines.append(
            "| Group | Minutes | Fut B / S / Bal / ND | Opt B / S / Bal / Mix / ND | "
            "Agree (Bull/Bear) | Diverge | One-sided | Both bal | Not comp |"
        )
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for g in ("sp500", "nasdaq100", "ALL"):
            agg = freqs[scope_key][g]
            fs = agg["futuresStates"]
            os_ = agg["optionsStates"]
            ag = agg["agreementStates"]
            ags = agg["agreementShares"]
            lines.append(
                f"| {g} | {agg['totalMinutes']} | "
                f"{fs[BUYERS]}/{fs[SELLERS]}/{fs[BALANCED]}/{fs[NO_DATA]} | "
                f"{os_[BUYERS]}/{os_[SELLERS]}/{os_[BALANCED]}/{os_[MIXED]}/{os_[NO_DATA]} | "
                f"{ag[AGREE]} ({_pct(ags[AGREE])}; {ag['agreeBullish']}/{ag['agreeBearish']}) | "
                f"{ag[DIVERGE]} ({_pct(ags[DIVERGE])}) | "
                f"{ag[ONE_SIDED]} ({_pct(ags[ONE_SIDED])}) | "
                f"{ag[BOTH_BALANCED]} ({_pct(ags[BOTH_BALANCED])}) | "
                f"{ag[NOT_COMPARABLE]} ({_pct(ags[NOT_COMPARABLE])}) |"
            )
        lines.append("")

    lines.extend([
        "## Mode comparison (C0, whole period, 1 tick/side)",
        "",
        "| Mode | Form | Trades | Net | Win rate | Profit factor | Sharpe (ann.) | Max DD $ |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for mode in MODES:
        mc = result["modeComparison"][mode]
        f_stat = mc["C0-F"]["ticks"][str(study.BASE_TICKS)]["whole"]
        lines.append(
            f"| {mode} | C0-F (ES+NQ) | {f_stat['trades']} | {study.usd(f_stat['netUsd'])} | "
            f"{_pct(f_stat['winRate'])} | {_num(f_stat['profitFactor'])} | "
            f"{_num(f_stat['sharpe'])} | {study.usd(f_stat['maxDrawdownUsd'])} |"
        )
        if "C0-O" in mc:
            o_stat = mc["C0-O"]["parts"]["whole"]
            lines.append(
                f"| {mode} | C0-O (SPY+QQQ) | {o_stat['trades']} | {study.usd(o_stat['netUsd'])} | "
                f"{_pct(o_stat['winRate'])} | {_num(o_stat['profitFactor'])} | "
                f"{_num(o_stat['sharpe'])} | {study.usd(o_stat['maxDrawdownUsd'])} |"
            )
    lines.append("")

    lines.extend([
        "## Agreement variants (whole period, 1 tick/side)",
        "",
        "| Row | Trades | Net | Win rate | Profit factor | Sharpe (ann.) | Max DD $ |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for cfg in study.CONFIGS:
        s = result["rows"][f"{cfg}-F"]["ticks"][str(study.BASE_TICKS)]["whole"]
        lines.append(
            f"| {cfg}-F | {s['trades']} | {study.usd(s['netUsd'])} | {_pct(s['winRate'])} | "
            f"{_num(s['profitFactor'])} | {_num(s['sharpe'])} | {study.usd(s['maxDrawdownUsd'])} |"
        )
    if result.get("optionsStatus") == "ran":
        for cfg in (*study.CONFIGS,):
            s = result["rows"][f"{cfg}-O"]["parts"]["whole"]
            lines.append(
                f"| {cfg}-O | {s['trades']} | {study.usd(s['netUsd'])} | {_pct(s['winRate'])} | "
                f"{_num(s['profitFactor'])} | {_num(s['sharpe'])} | {study.usd(s['maxDrawdownUsd'])} |"
            )
        stress = result["rows"]["C0-O-stress"]["parts"]["whole"]
        lines.append(
            f"| C0-O-stress | {stress['trades']} | {study.usd(stress['netUsd'])} | {_pct(stress['winRate'])} | "
            f"{_num(stress['profitFactor'])} | {_num(stress['sharpe'])} | {study.usd(stress['maxDrawdownUsd'])} |"
        )
    per_session = freqs.get("perSession") or []
    if per_session:
        lines.extend([
            "",
            "## Per-session state and agreement counts (390 min)",
            "",
            "| Day | Group | Fut B/S/Bal/ND | Opt B/S/Bal/Mix/ND | Agree (+ / -) | Diverge | One-sided | Both bal | Not comp |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ])
        for row in per_session:
            fs = row["futuresStates"]
            os_ = row["optionsStates"]
            ag = row["agreementStates"]
            lines.append(
                f"| {row['day']} | {row['group']} | "
                f"{fs[BUYERS]}/{fs[SELLERS]}/{fs[BALANCED]}/{fs[NO_DATA]} | "
                f"{os_[BUYERS]}/{os_[SELLERS]}/{os_[BALANCED]}/{os_[MIXED]}/{os_[NO_DATA]} | "
                f"{ag[AGREE]} (+{ag['agreeBullish']}/-{ag['agreeBearish']}) | "
                f"{ag[DIVERGE]} | {ag[ONE_SIDED]} | {ag[BOTH_BALANCED]} | {ag[NOT_COMPARABLE]} |"
            )
    if isinstance(alignment, Mapping):
        disq = alignment.get("disqualifiedTapeDays") or []
        missing_nd = alignment.get("missingNetDriftDays") or []
        if missing_nd:
            lines.extend(["", "## Streamed sessions missing net drift", "", "| Day | Net drift skip reasons |", "| --- | --- |"])
            for item in missing_nd:
                lines.append(f"| {item['day']} | {', '.join(item['reasons'])} |")
        if disq:
            lines.extend(["", "## Disqualified tape days observed", "", "| Day | Reason | ES covered | NQ covered |", "| --- | --- | ---: | ---: |"])
            for d in disq:
                lines.append(f"| {d['day']} | {d['reason']} | {d['esCoveredMinutes']}/390 | {d['nqCoveredMinutes']}/390 |")
    lines.append("")
    return "\n".join(lines)


def render_html_report(result: Mapping[str, object]) -> str:
    """Render a self-contained dark HTML report for the Task 2 agreement study (no scripts, no external calls)."""
    heading = "Flow control continuation study: futures state and agreement (Task 2)"
    verdict = str(result.get("verdict", "time-gated"))
    verdict_class = "pass" if verdict == "edge" else "fail"
    out = [
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        f"<title>{_e(heading)}</title><style>{STYLE}</style></head><body><main>",
        f"<h1>{_e(heading)}</h1>",
        "<p class='dim'>Research only. Modelled fills; no live or paper orders, no trading authority.</p>",
        "<h2>Verdict</h2>",
        f"<p><span class='{verdict_class}'>{_e(verdict)}</span></p>",
        f"<p>{_e(str(result.get('verdictReason', '')))}</p>",
    ]

    rules_info = result.get("rules", {})
    if isinstance(rules_info, Mapping):
        opt = rules_info.get("options", {})
        fut = rules_info.get("futures", {})
        out += [
            "<h2>Rules</h2>",
            _table(
                ("Side", "Version", "Window", "Enter / Exit", "Min min", "Extra"),
                [
                    [
                        "Options",
                        _e(str(opt.get("version", ""))),
                        f"{opt.get('windowMinutes', '')} min",
                        f"{opt.get('enterRatio', '')} / {opt.get('exitRatio', '')}",
                        str(opt.get("minMinutes", "")),
                        f"minBuckets={opt.get('minBuckets', '')}",
                    ],
                    [
                        "Futures",
                        _e(str(fut.get("version", ""))),
                        f"{fut.get('windowMinutes', '')} min",
                        f"{fut.get('enterRatio', '')} / {fut.get('exitRatio', '')}",
                        str(fut.get("minMinutes", "")),
                        f"minTrades={fut.get('minTrades', '')}, minCoveredSec={fut.get('minCoveredSeconds', '')}, "
                        f"maxMissing={fut.get('maxMissingMinutes', '')}",
                    ],
                ],
                text=True,
            ),
        ]

    freqs = result.get("frequencies")
    if isinstance(freqs, Mapping):
        out.append("<h2>State and agreement frequencies</h2>")
        for scope_key, title in (
            ("fullSession", "Full RTH session (09:30-15:59, 390 min/session)"),
            ("entryWindow", "Entry window (09:45-11:30, 106 min/session)"),
        ):
            scope = freqs[scope_key]
            out.append(f"<h3>{_e(title)}</h3>")
            rows_html = []
            for g in ("sp500", "nasdaq100", "ALL"):
                agg = scope[g]
                ag = agg["agreementStates"]
                ags = agg["agreementShares"]
                fs = agg["futuresStates"]
                os_ = agg["optionsStates"]
                rows_html.append([
                    _e(g),
                    str(agg["sessions"]),
                    str(agg["totalMinutes"]),
                    f"{fs[BUYERS]}/{fs[SELLERS]}/{fs[BALANCED]}/{fs[NO_DATA]}",
                    f"{os_[BUYERS]}/{os_[SELLERS]}/{os_[BALANCED]}/{os_[MIXED]}/{os_[NO_DATA]}",
                    f"{ag[AGREE]} ({_pct(ags[AGREE])}; +{ag['agreeBullish']}/-{ag['agreeBearish']})",
                    f"{ag[DIVERGE]} ({_pct(ags[DIVERGE])})",
                    f"{ag[ONE_SIDED]} ({_pct(ags[ONE_SIDED])})",
                    f"{ag[BOTH_BALANCED]} ({_pct(ags[BOTH_BALANCED])})",
                    f"{ag[NOT_COMPARABLE]} ({_pct(ags[NOT_COMPARABLE])})",
                ])
            out.append(
                _table(
                    (
                        "Group",
                        "Sessions",
                        "Minutes",
                        "Futures (B/S/Bal/ND)",
                        "Options (B/S/Bal/Mix/ND)",
                        "agree",
                        "diverge",
                        "one_sided",
                        "both_balanced",
                        "not_comparable",
                    ),
                    rows_html,
                )
            )

    mc = result.get("modeComparison")
    if isinstance(mc, Mapping):
        out.append("<h2>Mode comparison (C0, whole period, 1 tick/side)</h2>")
        mc_rows = []
        for mode in MODES:
            f_stat = mc[mode]["C0-F"]["ticks"][str(study.BASE_TICKS)]["whole"]
            mc_rows.append([
                _e(mode),
                "C0-F (ES+NQ)",
                str(f_stat["trades"]),
                _e(study.usd(f_stat["netUsd"])),
                _pct(f_stat["winRate"]),
                _num(f_stat["profitFactor"]),
                _num(f_stat["sharpe"]),
                _e(study.usd(f_stat["maxDrawdownUsd"])),
            ])
            if "C0-O" in mc[mode]:
                o_stat = mc[mode]["C0-O"]["parts"]["whole"]
                mc_rows.append([
                    _e(mode),
                    "C0-O (SPY+QQQ)",
                    str(o_stat["trades"]),
                    _e(study.usd(o_stat["netUsd"])),
                    _pct(o_stat["winRate"]),
                    _num(o_stat["profitFactor"]),
                    _num(o_stat["sharpe"]),
                    _e(study.usd(o_stat["maxDrawdownUsd"])),
                ])
        out.append(
            _table(
                ("Mode", "Form", "Trades", "Net", "Win rate", "Profit factor", "Sharpe (ann.)", "Max DD $"),
                mc_rows,
            )
        )

    dsr = result.get("deflatedSharpe", {})
    if isinstance(dsr, Mapping):
        p = dsr.get("probability")
        dsr_line = (
            f"{float(p):.3f} (per-session Sharpe {float(dsr['sharpe']):.4f}, expected max "
            f"{float(dsr['expectedMax']):.4f}, N={dsr['trials']})"
            if p is not None
            else f"not computable: {dsr.get('error', '')}"
        )
        out += [
            "<h2>Deflated Sharpe</h2>",
            f"<p>{_mark(p is not None and float(p) >= study.DSR_PASS)} {_e(dsr_line)}; bar 0.95.</p>",
        ]

    out.append("</main></body></html>")
    return "\n".join(out)


# --- CLI ----------------------------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Task 2 agreement continuation study on qualifying streamed ES/NQ RTH sessions "
            "(exits 3 when time-gated below --min-sessions)."
        )
    )
    parser.add_argument("--from-day", default=FIRST_STREAMED_DAY, help="First NY session date (YYYY-MM-DD).")
    parser.add_argument("--to-day", default=None, help="Last NY session date (YYYY-MM-DD).")
    parser.add_argument(
        "--min-sessions",
        type=int,
        default=TASK2_MIN_SESSIONS,
        help="Minimum aligned qualifying streamed RTH sessions required (default 20).",
    )
    parser.add_argument(
        "--min-covered",
        type=int,
        default=MIN_STREAMED_COVERED_MINUTES,
        help="Minimum covered minutes of 390 per futures symbol (default 370).",
    )
    parser.add_argument("--data", type=Path, default=None, help="QuantData net-drift root folder (outside repo).")
    parser.add_argument(
        "--market-data",
        type=Path,
        default=None,
        help="Optional daily SPY/QQQ/VIX/VXN/IRX folder for option debit vertical pricing.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Optional output directory outside the repository for index.html and summary.md (written only when ready).",
    )
    parser.add_argument("--dsn", default=None, help="PostgreSQL DSN (defaults to DATABASE_URL env var).")
    parser.add_argument("--ssh-host", default=None, help="Optional SSH host for remote read-only psql.")
    parser.add_argument("--docker-container", default=None, help="Optional Docker container running Postgres on ssh-host.")
    parser.add_argument("--pg-user", default="vertex_research", help="PostgreSQL user (with --ssh-host).")
    parser.add_argument("--pg-db", default="vertex", help="PostgreSQL database name (with --ssh-host).")
    parser.add_argument("--no-nautilus", action="store_true", help="Skip NautilusTrader fill check.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Stdout format.")
    args = parser.parse_args(argv)

    try:
        actual_sha = rules.spec_sha256()
    except FileNotFoundError as exc:
        print(f"Error: frozen spec missing: {exc}", file=sys.stderr)
        return 2
    if actual_sha != SPEC_SHA256:
        print(
            f"Error: frozen spec SHA-256 {actual_sha[:16]} differs from rules.SPEC_SHA256 {SPEC_SHA256[:16]}",
            file=sys.stderr,
        )
        return 2

    try:
        norm_from = _validate_iso_day(args.from_day)
        norm_to = _validate_iso_day(args.to_day) if args.to_day is not None else None
        if norm_to is not None and norm_to < norm_from:
            raise ValueError(f"--to-day ({norm_to}) precedes --from-day ({norm_from})")
        if args.min_covered < 1 or args.min_covered > SESSION_MINUTES:
            raise ValueError(f"--min-covered must be between 1 and {SESSION_MINUTES}, got {args.min_covered}")
        if args.min_sessions < 1:
            raise ValueError(f"--min-sessions must be at least 1, got {args.min_sessions}")
        data_dir = outside_repository(data.data_root(args.data), REPO_ROOT)
        out_dir = outside_repository(args.out, REPO_ROOT) if args.out is not None else None
        market_dir = (
            outside_repository(qc_data.data_root(args.market_data), REPO_ROOT)
            if args.market_data is not None
            else None
        )
    except (ValueError, SystemExit) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn and not args.ssh_host:
        print("Error: set DATABASE_URL, pass --dsn, or pass --ssh-host.", file=sys.stderr)
        return 2

    try:
        minute_rows, trade_rows = load_rows_from_psql(
            from_day=norm_from,
            to_day=norm_to,
            dsn=dsn,
            ssh_host=args.ssh_host,
            docker_container=args.docker_container,
            pg_user=args.pg_user,
            pg_db=args.pg_db,
        )
        tape_sessions = build_session_inputs(minute_rows, trade_rows, rules=FUTURES_RULES)
        loaded = data.load_all(data_dir, first_day=norm_from)
        aligned = align_sessions(
            tape_sessions,
            loaded,
            min_covered_minutes=args.min_covered,
            from_day=norm_from,
            to_day=norm_to,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if len(aligned.usable_days) < args.min_sessions:
        gated = _time_gated_payload(aligned, min_sessions=args.min_sessions)
        if args.format == "json":
            print(json.dumps(gated, indent=2))
        else:
            print(format_markdown_report(gated))
        return EXIT_TIME_GATED

    try:
        markets = (
            {sym: qc_data.load_market(sym, market_dir) for sym in MARKET_SYMBOLS}
            if market_dir is not None
            else None
        )
        result = run_agreement_study(
            aligned.usable_days,
            tape_sessions,
            loaded,
            options_rules=RULES,
            futures_rules=FUTURES_RULES,
            markets=markets,
            nautilus=not args.no_nautilus,
            min_sessions=args.min_sessions,
            alignment=aligned,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except (RuntimeError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    md_text = format_markdown_report(result)
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "summary.md").write_text(md_text + "\n")
        (out_dir / "index.html").write_text(render_html_report(result) + "\n")

    if args.format == "json":
        print(json.dumps(result, indent=2, allow_nan=False))
    else:
        print(md_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
