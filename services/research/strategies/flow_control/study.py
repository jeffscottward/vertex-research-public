"""Options-side continuation study: instruments, trials, futures ledger, split, statistics, verdict, NautilusTrader
fill check, checks of stored rows and the results document (research only; no order, no deployment).

Spec: docs/specs/strategies/flow-control-continuation.md. Futures results are modelled from index prices and the
option form from Black-Scholes prices; the study tests the options side of the flow control signals only.
"""
from __future__ import annotations

import dataclasses
import math
import statistics
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from backtesting.optimizer import deflated_sharpe_ratio
from strategies.imom.data import local_times, ms_at
from strategies.noise_band_futures_run import max_drawdown_usd
from strategies.qc_ports.data import Market
from strategies.trend_trio.study import moments, sharpe

from . import fomc, options
from .control import RULES
from .data import Loaded, TickerSession, bucket_path, parse_part
from .rules import BARS, ENTRY_LAST_LATE, OPEN_MINUTE_OF_DAY, Params, Session, Trade, group_states, signal_arrays
from .rules import trades as rule_trades

SCHEMA = "flow-control-continuation-study-v1"
# key: (form, price ticker, primary, check)
INSTRUMENTS: dict[str, tuple[str, str, str, str]] = {
    "ES": ("F", "SPX", "SPX", "SPY"),
    "NQ": ("F", "NDX", "QQQ", "NDX"),
    "SPY": ("O", "SPY", "SPX", "SPY"),
    "QQQ": ("O", "QQQ", "QQQ", "NDX"),
}
FUTURES = ("ES", "NQ")
OPTION_SYMBOLS = ("SPY", "QQQ")

POINT_USD = {"ES": 50.0, "NQ": 20.0}
TICK_USD = {"ES": 12.50, "NQ": 5.00}
FEES_USD = 4.50
SLIPPAGE_TICKS = (0, 1, 2)
BASE_TICKS = 1
STRESS_TICKS = 2
CAPITAL = 100_000.0
SESSIONS_PER_YEAR = 252
SESSION_MINUTES = 390

CONFIGS: dict[str, Params] = {
    "C0": Params(),
    "V1": Params(window_minutes=15),
    "V2": Params(window_minutes=60),
    "V3": Params(entry_last=ENTRY_LAST_LATE),
    "V4": Params(skip_fomc=False),
}
FORMS = ("F", "O")
N_TRIALS = 10
PRIMARY = "C0-F"

SPLIT = (0.6, 0.2, 0.2)
GAP_SESSIONS = 5
MIN_SESSIONS = 30
WINDOW_CHOICE = ("2026-10-28", "2026-11-13")
PARTS = ("whole", "train", "validation", "test", "outOfSample", "windowChoice")

MIN_OOS_TRADES = 100
DSR_PASS = 0.95
LIVE_ROW_TOLERANCE = 0.01
LIMIT_TEXT = "Options-side rule with modelled fills."


def usd(value: float | None) -> str:
    return "n/a" if value is None else f"${value:,.0f}"


def build_session(key: str, day: str, tickers: Mapping[str, TickerSession]) -> Session:
    _, price, primary, check = INSTRUMENTS[key]
    return Session(day, tickers[price].price, tickers[primary].price, tickers[primary].minutes,
                   tickers[check].minutes)


# --- futures ledger -----------------------------------------------------------------------------------------------

def trade_net(trade: Trade, key: str, slip_ticks: int) -> float:
    return trade.points * POINT_USD[key] - FEES_USD - 2 * slip_ticks * TICK_USD[key]


def session_pnl(trades: Sequence[Trade], days: Sequence[str], key: str, slip_ticks: int) -> list[float]:
    by_day: dict[str, float] = defaultdict(float)
    for trade in trades:
        by_day[trade.day] += trade_net(trade, key, slip_ticks)
    return [by_day.get(day, 0.0) for day in days]


# --- split --------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Split:
    train: tuple[str, ...]
    validation: tuple[str, ...]
    test: tuple[str, ...]
    window_choice: tuple[str, ...]

    @property
    def out_of_sample(self) -> tuple[str, ...]:
        return self.validation + self.test


def split_sessions(days: Sequence[str]) -> Split:
    n = len(days)
    if n < MIN_SESSIONS:
        raise ValueError(f"{n} usable sessions; the split needs at least {MIN_SESSIONS}")
    usable = n - 2 * GAP_SESSIONS
    n_train = math.floor(SPLIT[0] * usable)
    n_validation = math.floor(SPLIT[1] * usable)
    train = list(days[:n_train])
    validation = list(days[n_train + GAP_SESSIONS:n_train + GAP_SESSIONS + n_validation])
    test = list(days[n_train + 2 * GAP_SESSIONS + n_validation:])
    lo, hi = WINDOW_CHOICE

    def inside(day: str) -> bool:
        return lo <= day <= hi

    choice = tuple(day for day in days if inside(day))
    return Split(tuple(d for d in train if not inside(d)), tuple(d for d in validation if not inside(d)),
                 tuple(d for d in test if not inside(d)), choice)


def part_days(split: Split, days: Sequence[str]) -> dict[str, tuple[str, ...]]:
    return {"whole": tuple(days), "train": split.train, "validation": split.validation, "test": split.test,
            "outOfSample": split.out_of_sample, "windowChoice": split.window_choice}


# --- statistics ---------------------------------------------------------------------------------------------------

def capital_curve(days: Sequence[str], pnl: Sequence[float], capital: float) -> dict:
    """Returns on the capital basis (no compounding): CAGR, max drawdown (negative fraction of the peak) and
    month-end points."""
    equity, peak, worst = capital, capital, 0.0
    months: dict[str, dict] = {}
    for day, value in zip(days, pnl, strict=True):
        equity += value
        peak = max(peak, equity)
        drawdown = equity / peak - 1 if peak > 0 else -1.0
        worst = min(worst, drawdown)
        months[day[:7]] = {"month": day[:7], "value": max(-1.0, equity / capital - 1),
                           "drawdown": max(-1.0, min(0.0, drawdown))}
    years = (date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days / 365.25 if days else 0.0
    ratio = equity / capital
    cagr = (ratio ** (1 / years) - 1 if ratio > 0 else -1.0) if years > 0 else 0.0
    return {"cagr": max(-1.0, cagr), "maxDrawdown": max(-1.0, worst), "months": list(months.values())}


def row_stats(nets: Sequence[float], pnl: Sequence[float], days: Sequence[str], capital: float,
              held_minutes: float, instruments: int) -> dict:
    gains = sum(x for x in nets if x > 0)
    losses = -sum(x for x in nets if x < 0)
    session_sharpe = sharpe(pnl)
    curve = capital_curve(days, pnl, capital)
    return {
        "trades": len(nets),
        "sessions": len(days),
        "first": days[0] if days else None,
        "last": days[-1] if days else None,
        "netUsd": float(sum(pnl)),
        "winRate": (sum(1 for x in nets if x > 0) / len(nets)) if nets else 0.0,
        "profitFactor": (gains / losses) if losses > 0 else None,
        "sessionSharpe": session_sharpe,
        "sharpe": session_sharpe * math.sqrt(SESSIONS_PER_YEAR),
        "cagr": curve["cagr"],
        "maxDrawdown": curve["maxDrawdown"],
        "maxDrawdownUsd": max_drawdown_usd(pnl),
        "timeInMarket": (held_minutes / (instruments * SESSION_MINUTES * len(days))) if days else 0.0,
    }


def deflated_sharpe(series: Mapping[str, Sequence[float]], primary: str = PRIMARY, n_trials: int = N_TRIALS) -> dict:
    """Per-session Sharpe of the primary row against the variance of the per-session Sharpes of the trial series."""
    sharpes = [sharpe(values) for values in series.values()]
    values = series[primary]
    skew, kurtosis = moments(values) if values else (0.0, 3.0)
    try:
        result = deflated_sharpe_ratio(sharpe(values), n_trials, statistics.variance(sharpes), len(values),
                                       skew, kurtosis)
    except (ValueError, statistics.StatisticsError, ZeroDivisionError) as error:
        return {"probability": None, "error": str(error)[:200] or type(error).__name__}
    return {"probability": result.probability, "sharpe": result.sharpe, "expectedMax": result.expected_max_sharpe,
            "variance": result.sharpe_variance, "observations": result.n_observations, "skew": skew,
            "kurtosis": kurtosis, "trials": n_trials, "rows": len(sharpes)}


def verdict_of(oos_trades: int, oos_net: float, dsr: Mapping) -> tuple[str, str]:
    net = usd(oos_net)
    if oos_trades < MIN_OOS_TRADES:
        return "needs-more-data", f"Needs more data: {oos_trades} out-of-sample trades, 100 needed. {LIMIT_TEXT}"
    p = dsr.get("probability")
    if p is None:
        return "no-edge", (f"No edge: deflated Sharpe not computable: {dsr.get('error')}. {oos_trades} out-of-sample "
                           f"trades, net {net} at 1 tick per side. {LIMIT_TEXT}")
    if oos_net > 0 and p >= DSR_PASS:
        return "edge", (f"Edge: {oos_trades} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe "
                        f"{p:.3f} (bar 0.95, N = 10). {LIMIT_TEXT}")
    return "no-edge", (f"No edge: {oos_trades} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe "
                       f"{p:.3f} (bar 0.95, N = 10). {LIMIT_TEXT}")


# --- NautilusTrader fill check ------------------------------------------------------------------------------------

def engine_trades(sessions: Sequence[Session], trades: Sequence[Trade], side: int) -> list[tuple]:
    """(day, entry bar, exit bar, entry price, exit price) of one NautilusTrader run over the joined sessions."""
    from nautilus_backtest.bars import Bars
    from nautilus_backtest.engine import run_signal_backtest
    from nautilus_backtest.signals import Compiled, RunOptions

    by_day = {trade.day: trade for trade in trades}
    t, px, signals, exits, close_at = [], [], [], [], []
    for session in sessions:
        t += [int(ms_at(session.day, OPEN_MINUTE_OF_DAY + bar)) for bar in range(BARS)]
        px += list(session.price[:BARS])
        s, e, c = signal_arrays(session, by_day.get(session.day), side)
        signals += s
        exits += e
        close_at += c
    bars = Bars.from_columns({"t": t, "o": px, "h": px, "l": px, "c": px})
    compiled = Compiled(signals=tuple(signals), exits=tuple(exits), stop_distance=None, target_distance=None,
                        close_at=tuple(close_at))
    run_options = RunOptions(cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None,
                             side="short" if side < 0 else None)
    result = run_signal_backtest(bars, compiled, run_options)
    out = []
    for item in result.trades:
        s_in, entry_bar = divmod(item["entryIndex"], BARS)
        _, exit_bar = divmod(item["exitIndex"], BARS)
        out.append((sessions[s_in].day, entry_bar, exit_bar, item["entryPrice"], item["exitPrice"]))
    return out


def nautilus_check(sessions: Mapping[str, Sequence[Session]], trades: Mapping[str, Sequence[Trade]],
                   tolerance: float = 1e-6) -> dict:
    from nautilus_backtest import engine

    try:
        engine.require()
    except engine.NautilusUnavailable as error:
        return {"status": "not run", "reason": str(error)[:200]}
    mismatches: list[dict] = []
    booked = total = 0
    for key, key_sessions in sessions.items():
        for side in (1, -1):
            ours = sorted((t for t in trades[key] if t.side == side), key=lambda t: t.day)
            theirs = engine_trades(key_sessions, ours, side)
            booked += len(theirs)
            total += len(ours)
            for index in range(max(len(ours), len(theirs))):
                a = ours[index] if index < len(ours) else None
                b = theirs[index] if index < len(theirs) else None
                same = (a is not None and b is not None and a.day == b[0] and a.entry_bar == b[1]
                        and a.exit_bar == b[2]
                        and math.isclose(a.entry_price, b[3], rel_tol=tolerance, abs_tol=tolerance)
                        and math.isclose(a.exit_price, b[4], rel_tol=tolerance, abs_tol=tolerance))
                if not same:
                    mismatches.append({"instrument": key, "side": side,
                                       "rule": None if a is None else [a.day, a.entry_bar, a.exit_bar, a.entry_price,
                                                                       a.exit_price, a.exit_reason],
                                       "engine": None if b is None else list(b)})
    return {"status": "ran", "engine": engine.ENGINE_ID, "trades": total, "booked": booked,
            "same": not mismatches and booked == total, "mismatches": mismatches[:20], "optionsMaxGap": None}


# --- descriptions and checks of stored rows -----------------------------------------------------------------------

def two_sided_description(deep_trades: Sequence[Mapping], sessions: Sequence[Session]) -> list[dict]:
    by_day = {session.day: session for session in sessions}
    rows: dict[str, list[tuple[int, str, float]]] = defaultdict(list)
    for row in deep_trades:
        if row["symbol"] != "ES":
            continue
        day, minute = local_times([int(row["second_s"]) * 1000])[0]
        m = minute - OPEN_MINUTE_OF_DAY
        if day in by_day and 0 <= m < SESSION_MINUTES:
            rows[day].append((m, row["side"], float(row["size"])))
    out = []
    for day in sorted(rows):
        states = group_states(by_day[day], RULES)
        net_by_minute: dict[int, float] = defaultdict(float)
        buy = sell = 0.0
        for m, side, size in rows[day]:
            if side == "buy":
                buy += size
                net_by_minute[m] += size
            else:
                sell += size
                net_by_minute[m] -= size
        control = [m for m in range(len(states)) if states[m] in ("buyers", "sellers")]
        trade_minutes = [m for m in control if m in net_by_minute]
        same = [m for m in trade_minutes
                if (states[m] == "buyers" and net_by_minute[m] > 0) or (states[m] == "sellers" and net_by_minute[m] < 0)]
        out.append({"day": day, "trades": len(rows[day]), "buyVolume": buy, "sellVolume": sell,
                    "netVolume": buy - sell, "controlMinutes": len(control), "tradeMinutes": len(trade_minutes),
                    "sameSignMinutes": len(same)})
    return out


def live_rows_check(rows: Sequence[Mapping], root: Path) -> dict:
    if not rows:
        return {"status": "not provided"}
    groups: dict[tuple[str, str], list[Mapping]] = defaultdict(list)
    for row in rows:
        groups[(row["ticker"], row["part"])].append(row)
    pairs, day = [], None
    for (ticker, part), items in sorted(groups.items()):
        day = local_times([int(items[0]["minute_ms"])])[0][0]
        path = bucket_path(root, ticker, part, day)
        downloaded = parse_part(path.read_text()) if path.exists() else {}
        stored = {int(row["minute_ms"]): row for row in items}
        common = stored.keys() & downloaded.keys()
        diffs = [max(abs(float(stored[k]["net_call_premium"]) - downloaded[k][0]),
                     abs(float(stored[k]["net_put_premium"]) - downloaded[k][1])) for k in common]
        pairs.append({"ticker": ticker, "part": part, "stored": len(stored), "downloaded": len(downloaded),
                      "common": len(common), "equal": sum(1 for d in diffs if d <= LIVE_ROW_TOLERANCE),
                      "maxAbsDiffUsd": max(diffs, default=0.0), "onlyStored": len(stored.keys() - downloaded.keys()),
                      "onlyDownloaded": len(downloaded.keys() - stored.keys())})
    return {"status": "ran", "day": day, "pairs": pairs}


# --- the run ------------------------------------------------------------------------------------------------------

def _held(trades: Sequence[Trade]) -> float:
    return float(sum(t.exit_bar - t.entry_bar for t in trades))


def _parts_stats(parts: Mapping[str, Sequence[str]], days: Sequence[str], pnl: Sequence[float],
                 nets_by_day: Sequence[tuple[str, float]], held_by_day: Sequence[tuple[str, float]], capital: float,
                 instruments: int) -> dict:
    index = {day: i for i, day in enumerate(days)}
    out = {}
    for name, part in parts.items():
        members = set(part)
        out[name] = row_stats([net for day, net in nets_by_day if day in members], [pnl[index[d]] for d in part],
                              part, capital, sum(h for day, h in held_by_day if day in members), instruments)
    return out


def _option_records(booked: Mapping) -> list[tuple[str, float]]:
    clock = booked["clock"]
    out = []
    for record in booked["result"].trades:
        day = local_times([clock.real(record["entryDate"])])[0][0]
        out.append((day, float(record["pnl"])))
    return out


def _spread_held(spreads: Sequence) -> list[tuple[str, float]]:
    return [(s.day, (s.exit_ms - s.event.entry_ms) / 60_000) for s in spreads]


def run(loaded: Loaded, root: Path, *, markets: Mapping[str, Market], market_files: Sequence[Path] = (),
        deep_trades: Sequence[Mapping] = (), live_rows: Sequence[Mapping] = (), nautilus: bool = True) -> dict:
    from .data import data_hash, data_manifest

    days = list(loaded.days)
    split = split_sessions(days)
    parts = part_days(split, days)
    sessions = {key: [build_session(key, day, loaded.sessions[day]) for day in days] for key in INSTRUMENTS}
    trades = {cfg: {key: rule_trades(sessions[key], params) for key in INSTRUMENTS}
              for cfg, params in CONFIGS.items()}

    rows: dict[str, dict] = {}
    series: dict[str, list[float]] = {}
    oos_index = [days.index(d) for d in split.out_of_sample]
    for cfg in CONFIGS:
        both: dict[str, dict] = {}
        for tick in SLIPPAGE_TICKS:
            pnl_sum = [0.0] * len(days)
            nets, held = [], []
            for key in FUTURES:
                ts = trades[cfg][key]
                pnl = session_pnl(ts, days, key, tick)
                pnl_sum = [a + b for a, b in zip(pnl_sum, pnl)]
                key_nets = [(t.day, trade_net(t, key, tick)) for t in ts]
                key_held = [(t.day, float(t.exit_bar - t.entry_bar)) for t in ts]
                nets += key_nets
                held += key_held
                rows.setdefault(f"{cfg}-F-{key}", {"form": "F", "instruments": [key], "capital": CAPITAL,
                                                   "ticks": {}})["ticks"][str(tick)] = _parts_stats(
                    parts, days, pnl, key_nets, key_held, CAPITAL, 1)
            both[str(tick)] = _parts_stats(parts, days, pnl_sum, nets, held, 2 * CAPITAL, 2)
            if tick == BASE_TICKS:
                series[f"{cfg}-F"] = [pnl_sum[i] for i in oos_index]
                if cfg == "C0":
                    c0_pnl = pnl_sum
        rows[f"{cfg}-F"] = {"form": "F", "instruments": list(FUTURES), "capital": 2 * CAPITAL, "ticks": both}

    options_skipped: list[dict] = []
    max_gaps: list[float] = []
    c0_spreads: dict[str, list] = {}
    for cfg in CONFIGS:
        pnl_sum = [0.0] * len(days)
        nets, held = [], []
        for symbol in OPTION_SYMBOLS:
            spreads, skipped = options.price_trades(symbol, trades[cfg][symbol], markets[symbol])
            if cfg == "C0":
                options_skipped += skipped
                c0_spreads[symbol] = spreads
            use_engine = nautilus and cfg == "C0"
            booked = options.book_form(spreads, days, nautilus=use_engine)
            if use_engine and booked["maxGap"] is not None:
                max_gaps.append(booked["maxGap"])
            pnl = options.session_pnl_from_equity(booked["points"], days)
            sym_nets, sym_held = _option_records(booked), _spread_held(spreads)
            rows[f"{cfg}-O-{symbol}"] = {"form": "O", "instruments": [symbol], "capital": options.ACCOUNT,
                                         "priced": len(spreads), "skipped": len(skipped),
                                         "parts": _parts_stats(parts, days, pnl, sym_nets, sym_held, options.ACCOUNT, 1)}
            pnl_sum = [a + b for a, b in zip(pnl_sum, pnl)]
            nets += sym_nets
            held += sym_held
        rows[f"{cfg}-O"] = {"form": "O", "instruments": list(OPTION_SYMBOLS), "capital": 2 * options.ACCOUNT,
                            "priced": sum(rows[f"{cfg}-O-{s}"]["priced"] for s in OPTION_SYMBOLS),
                            "parts": _parts_stats(parts, days, pnl_sum, nets, held, 2 * options.ACCOUNT, 2)}
        series[f"{cfg}-O"] = [pnl_sum[i] for i in oos_index]

    pnl_sum = [0.0] * len(days)
    nets, held = [], []
    for symbol in OPTION_SYMBOLS:
        stressed = [options.stress_costs(s) for s in c0_spreads[symbol]]
        booked = options.book_form(stressed, days, nautilus=False)
        pnl = options.session_pnl_from_equity(booked["points"], days)
        pnl_sum = [a + b for a, b in zip(pnl_sum, pnl)]
        nets += _option_records(booked)
        held += _spread_held(stressed)
    rows["C0-O-stress"] = {"form": "O", "instruments": list(OPTION_SYMBOLS), "capital": 2 * options.ACCOUNT,
                           "parts": _parts_stats(parts, days, pnl_sum, nets, held, 2 * options.ACCOUNT, 2)}

    order = [f"{cfg}-{form}" for form in FORMS for cfg in CONFIGS]
    series = {name: series[name] for name in order}
    dsr = deflated_sharpe(series)
    oos = rows[PRIMARY]["ticks"][str(BASE_TICKS)]["outOfSample"]
    verdict, reason = verdict_of(oos["trades"], oos["netUsd"], dsr)

    if nautilus:
        naut = nautilus_check(sessions, trades["C0"])
        if naut.get("status") == "ran":
            naut["optionsMaxGap"] = max(max_gaps) if max_gaps else None
    else:
        naut = {"status": "not run", "reason": "disabled"}

    net_manifest = data_manifest(loaded.files)
    market_manifest = data_manifest(market_files)
    fomc_days = sorted(d for d in days if fomc.is_fomc_day(d))
    skipped_counts = Counter(item["reason"] for item in options_skipped)
    return {
        "schema": SCHEMA,
        "data": {"days": len(days), "first": days[0], "last": days[-1], "skipped": list(loaded.skipped),
                 "earlyCloseDays": loaded.early_close_days, "derivedTotalDays": loaded.derived_total_days,
                 "files": len(net_manifest), "marketFiles": market_manifest,
                 "dataHash": data_hash([*net_manifest, *market_manifest])},
        "split": {name: {"first": part[0] if part else None, "last": part[-1] if part else None,
                         "sessions": len(part)} for name, part in parts.items()},
        "rows": rows,
        "series": series,
        "deflatedSharpe": dsr,
        "verdict": verdict,
        "verdictReason": reason,
        "diagnostics": {
            "nautilus": naut,
            "twoSided": two_sided_description(deep_trades, sessions["ES"]) if deep_trades else [],
            "liveRows": live_rows_check(live_rows, root),
            "fomc": {"source": fomc.FOMC_SOURCE, "readOn": fomc.FOMC_READ_ON, "days": fomc_days},
            "optionsSkipped": {"count": len(options_skipped), "byReason": dict(skipped_counts),
                               "items": options_skipped[:50]},
            "optionsStress": rows["C0-O-stress"]["parts"]["outOfSample"],
        },
        "curve": capital_curve(days, c0_pnl, 2 * CAPITAL)["months"],
        "rules": {"control": RULES.to_json(), "params": {cfg: dataclasses.asdict(p) for cfg, p in CONFIGS.items()}},
    }


def stats_of(results: Mapping, row: str, part: str = "whole", tick: int = BASE_TICKS) -> dict:
    item = results["rows"][row]
    return item["ticks"][str(tick)][part] if "ticks" in item else item["parts"][part]
