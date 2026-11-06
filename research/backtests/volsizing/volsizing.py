"""Vol-target position sizing (Carver method, own implementation) for Vertex debit spreads.

Research only. Nothing here creates, routes or simulates a broker order, and nothing is promoted
to paper or live trading. No code from pysystemtrade (GPL-3.0) is used; the method is written
from its published description (Systematic Trading, Leveraged Trading, pysystemtrade docs).

    <nautilus-venv>/bin/python research/backtests/volsizing/volsizing.py \
        --data ~/Documents/reports/vertex-core7/data --out research/backtests/volsizing/results.json

Pipeline:
1. Signals: each library strategy (QuantJourney O01, O02, O12 DSL definitions in
   research/backtests/quantjourney/library.json) runs on each Core 7 ETF twin in the Nautilus
   engine of record (services/research/nautilus_backtest, run_spec). Its trade list gives the
   entry and exit bars and fill prices of the underlying.
2. Expression: every long signal trade is a call debit spread with the Vertex proposal shape
   (packages/api/src/pick-list-proposal.ts): 120 DTE, long the ~0.60 delta call, short the
   ~0.30 delta call, Black-Scholes with r = 4% and no dividends. The spread is rolled to a new
   120 DTE spread when 30 days remain and closed when the signal exits.
3. Sizing variants (all inside the owner 2% NLV max-loss gate per position, integer contracts).
4. A daily mark-to-market portfolio per strategy across the 7 instruments on one account.

Option prices need an implied volatility. The public data has none, so the proxy is
1.1 x EWMA(span 20) realized volatility (implied vol usually trades above realized), floored at
8%. A robustness run prices with the 252-day realized volatility of the proposal model instead.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from statistics import NormalDist

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

UNIVERSE = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURE_OF = {"SPY": "ES=F", "QQQ": "NQ=F", "DIA": "YM=F", "IWM": "RTY=F", "GLD": "GC=F",
             "SLV": "SI=F", "USO": "CL=F"}
STRATEGY_IDS = ("O01", "O02", "O12")
LIBRARY = ROOT / "research" / "backtests" / "quantjourney" / "library.json"

START = date(2007, 1, 3)  # first session with >= 180 returns on every member (USO lists 2006-04)
CAPITAL = 1_000_000.0  # dummy account size
TRADING_DAYS = 252
RISK_FREE = 0.04
TARGET_DTE = 120
ROLL_DTE = 30
LONG_DELTA = 0.60
SHORT_DELTA = 0.30
MAX_LOSS_GATE = 0.02  # owner hard gate: max loss of a new position <= 2% NLV
CURRENT_RISK = 0.005  # proposal "full" tier: 0.50% NLV max loss per position
IV_MARKUP = 1.1
IV_FLOOR = 0.08
# IBKR Pro US options (packages/api/src/backtest-costs.ts): $0.65 per contract, $1 minimum per
# order, OCC + CAT $0.0253 per contract. Half spread per leg: max($0.01, 0.5% of the leg premium).
COMMISSION = 0.65
MIN_ORDER = 1.0
FEE = 0.025 + 0.0003
HALF_SPREAD = 0.005
MULT = 100
# Carver defaults from the pysystemtrade docs (values only).
CARVER_VOL_TARGET = 0.16
FAST_SPAN = 35
SLOW_YEARS = 10
SLOW_WEIGHT = 0.3
BUFFER = 0.10
IDM_CAP = 2.5
FORECAST_IN = 10.0  # binary long-only rule: forecast 10 in position, 0 flat (cap 20 unused)
REVIEW_EVERY = 5  # buffered resize check, in sessions

_N = NormalDist()


# --- data -----------------------------------------------------------------------------------

@dataclass(frozen=True)
class Series:
    symbol: str
    days: tuple[date, ...]
    o: tuple[float, ...]
    h: tuple[float, ...]
    l: tuple[float, ...]  # noqa: E741
    c: tuple[float, ...]


def load_series(path: Path, symbol: str) -> Series:
    """Raw (split-adjusted, not dividend-adjusted) OHLC: options settle on the traded price.

    Rows the Vertex bar importer rejects are dropped (non-positive price, low above open or
    close, high below open or close)."""
    days, o, h, lo, c = [], [], [], [], []
    with path.open() as handle:
        for row in csv.DictReader(handle):
            try:
                values = [float(row[k]) for k in ("open", "high", "low", "close")]
            except (TypeError, ValueError):
                continue
            op, hi, low, cl = values
            if min(values) <= 0 or low > min(op, cl) or hi < max(op, cl):
                continue
            days.append(date.fromisoformat(row["date"]))
            o.append(op)
            h.append(hi)
            lo.append(low)
            c.append(cl)
    return Series(symbol, tuple(days), tuple(o), tuple(h), tuple(lo), tuple(c))


def epoch_ms(day: date) -> float:
    return float((day - date(1970, 1, 1)).days * 86_400_000)


# --- volatility -----------------------------------------------------------------------------

def returns(close) -> list[float]:
    out = [math.nan]
    for i in range(1, len(close)):
        out.append(close[i] / close[i - 1] - 1)
    return out


def ewma_vol(rets, span: int) -> list[float]:
    """Annualized EWMA standard deviation of daily returns (around zero), NaN until 10 returns."""
    alpha = 2 / (span + 1)
    var = math.nan
    seen = 0
    out = []
    for r in rets:
        if not math.isnan(r):
            var = r * r if math.isnan(var) else (1 - alpha) * var + alpha * r * r
            seen += 1
        out.append(math.sqrt(var * TRADING_DAYS) if seen >= 10 else math.nan)
    return out


def carver_vol(rets) -> list[float]:
    """Blend of 70% fast EWMA (span 35) vol and 30% of its own 10-year average (expanding until
    10 years of history exist): the pysystemtrade default instrument-risk estimate."""
    fast = ewma_vol(rets, FAST_SPAN)
    window = SLOW_YEARS * TRADING_DAYS
    out, total, count, hist = [], 0.0, 0, []
    for v in fast:
        if math.isnan(v):
            out.append(math.nan)
            continue
        hist.append(v)
        total += v
        count += 1
        if count > window:
            total -= hist[-window - 1]
            count = window
        out.append((1 - SLOW_WEIGHT) * v + SLOW_WEIGHT * total / count)
    return out


def slow_vol(rets) -> list[float]:
    """10-year (expanding until then) average of the fast EWMA vol: the long-run level."""
    fast = ewma_vol(rets, FAST_SPAN)
    window = SLOW_YEARS * TRADING_DAYS
    out, hist, total = [], [], 0.0
    for v in fast:
        if math.isnan(v):
            out.append(math.nan)
            continue
        hist.append(v)
        total += v
        if len(hist) > window:
            total -= hist[-window - 1]
        out.append(total / min(len(hist), window))
    return out


def realized_252(close) -> list[float]:
    """Proposal-model volatility: sample std of up to 252 daily log returns x sqrt(252)."""
    logs = [math.nan] + [math.log(close[i] / close[i - 1]) for i in range(1, len(close))]
    out = []
    for i in range(len(close)):
        window = logs[max(1, i - 251): i + 1]
        if len(window) < 60:
            out.append(math.nan)
            continue
        mean = sum(window) / len(window)
        var = sum((x - mean) ** 2 for x in window) / (len(window) - 1)
        out.append(math.sqrt(var * TRADING_DAYS))
    return out


def iv_proxy(rets) -> list[float]:
    return [v if math.isnan(v) else max(IV_FLOOR, IV_MARKUP * v) for v in ewma_vol(rets, 20)]


# --- options --------------------------------------------------------------------------------

def bs_call(s: float, k: float, t: float, sigma: float, r: float = RISK_FREE) -> float:
    if t <= 0:
        return max(0.0, s - k)
    st = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r + sigma * sigma / 2) * t) / st
    return s * _N.cdf(d1) - k * math.exp(-r * t) * _N.cdf(d1 - st)


def call_delta(s: float, k: float, t: float, sigma: float, r: float = RISK_FREE) -> float:
    if t <= 0:
        return 1.0 if s > k else 0.0
    st = sigma * math.sqrt(t)
    return _N.cdf((math.log(s / k) + (r + sigma * sigma / 2) * t) / st)


def strike_for_delta(s: float, delta: float, t: float, sigma: float) -> float:
    """N(d1) = delta  =>  K = S exp(-d1 sigma sqrt(T) + (r + sigma^2/2) T), rounded to $1
    ($0.50 below $25), as in the proposal model."""
    d1 = _N.inv_cdf(delta)
    k = s * math.exp(-d1 * sigma * math.sqrt(t) + (RISK_FREE + sigma * sigma / 2) * t)
    step = 1.0 if s >= 25 else 0.5
    return max(step, round(k / step) * step)


@dataclass(frozen=True)
class Spread:
    k1: float
    k2: float
    expiry: date
    debit: float  # per share, mid
    delta: float  # long delta minus short delta


def open_spread(s: float, day: date, sigma: float) -> Spread:
    t = TARGET_DTE / 365
    k1 = strike_for_delta(s, LONG_DELTA, t, sigma)
    k2 = strike_for_delta(s, SHORT_DELTA, t, sigma)
    if k2 <= k1:
        k2 = k1 + (1.0 if s >= 25 else 0.5)
    debit = bs_call(s, k1, t, sigma) - bs_call(s, k2, t, sigma)
    delta = call_delta(s, k1, t, sigma) - call_delta(s, k2, t, sigma)
    return Spread(k1, k2, day + timedelta(days=TARGET_DTE), debit, delta)


def spread_value(sp: Spread, s: float, day: date, sigma: float) -> float:
    t = max(0.0, (sp.expiry - day).days / 365)
    return bs_call(s, sp.k1, t, sigma) - bs_call(s, sp.k2, t, sigma)


def leg_prices(sp: Spread, s: float, day: date, sigma: float) -> tuple[float, float]:
    t = max(0.0, (sp.expiry - day).days / 365)
    return bs_call(s, sp.k1, t, sigma), bs_call(s, sp.k2, t, sigma)


def trade_cost(contracts: int, legs: tuple[float, float]) -> float:
    """Commission, fees and half spread of one two-leg combo order of `contracts` spreads."""
    if contracts <= 0:
        return 0.0
    commission = max(MIN_ORDER, 2 * COMMISSION * contracts)
    fees = 2 * FEE * contracts
    slip = sum(max(0.01, HALF_SPREAD * p) for p in legs) * MULT * contracts
    return commission + fees + slip


def max_loss_per_contract(sp: Spread, legs: tuple[float, float]) -> float:
    """Max loss of one debit spread: the debit paid plus its entry and exit charges."""
    return sp.debit * MULT + 2 * trade_cost(1, legs)


# --- sizing ---------------------------------------------------------------------------------

def gate_cap(nlv: float, loss_pc: float) -> int:
    """Largest contract count whose max loss stays inside the 2% NLV gate."""
    return max(0, math.floor(MAX_LOSS_GATE * nlv / loss_pc + 1e-9))


def size_fixed_risk(nlv: float, loss_pc: float, risk: float = CURRENT_RISK) -> int:
    """Current Vertex rule: fixed % NLV max loss, never above the gate."""
    return min(math.floor(risk * nlv / loss_pc + 1e-9), gate_cap(nlv, loss_pc))


def vol_target_contracts(nlv: float, tau: float, weight: float, idm: float, forecast: float,
                         sigma: float, s: float, delta: float) -> float:
    """Carver position in contracts (unrounded): cash vol target x weight x IDM x forecast/10,
    divided by the annual cash vol of one spread (delta x S x 100 x instrument vol)."""
    if sigma <= 0 or delta <= 0:
        return 0.0
    return nlv * tau * weight * idm * (forecast / 10) / (delta * s * MULT * sigma)


def size_vol_target(nlv: float, loss_pc: float, **kw) -> int:
    return min(max(0, round(vol_target_contracts(nlv, **kw))), gate_cap(nlv, loss_pc))


def size_vol_brake(nlv: float, loss_pc: float, fast: float, slow: float) -> int:
    """Shrink-only overlay: the current size times min(1, long-run vol / fast vol)."""
    base = size_fixed_risk(nlv, loss_pc)
    if math.isnan(fast) or math.isnan(slow) or fast <= 0:
        return base
    return math.floor(base * min(1.0, slow / fast) + 1e-9)


def buffered(current: int, target: float) -> int:
    """Position inertia: keep the position inside target +/- 10% (at least half a contract);
    outside the band trade to the nearest edge."""
    width = max(BUFFER * abs(target), 0.5)
    low, high = target - width, target + width
    if current < low:
        return max(0, math.ceil(low - 1e-9))
    if current > high:
        return max(0, math.floor(high + 1e-9))
    return current


def idm_from_corr(corr: list[list[float]], weights: list[float]) -> float:
    """1 / sqrt(w' H w) with negative correlations floored at zero, capped at 2.5."""
    total = 0.0
    for i, wi in enumerate(weights):
        for j, wj in enumerate(weights):
            total += wi * wj * max(0.0, corr[i][j])
    return min(IDM_CAP, 1 / math.sqrt(total))


def weekly_corr(series: dict[str, Series], start: date, end: date) -> list[list[float]]:
    """Correlation of Friday-to-Friday (last session of the ISO week) returns."""
    weekly = {}
    for sym, ser in series.items():
        last = {}
        for d, c in zip(ser.days, ser.c):
            if start <= d <= end:
                last[d.isocalendar()[:2]] = c
        weekly[sym] = last
    weeks = sorted(set.intersection(*(set(v) for v in weekly.values())))
    rets = {s: [weekly[s][weeks[i]] / weekly[s][weeks[i - 1]] - 1 for i in range(1, len(weeks))]
            for s in series}
    syms = list(series)

    def corr(a, b):
        ma, mb = sum(a) / len(a), sum(b) / len(b)
        cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        va = sum((x - ma) ** 2 for x in a)
        vb = sum((y - mb) ** 2 for y in b)
        return cov / math.sqrt(va * vb)

    return [[corr(rets[a], rets[b]) for b in syms] for a in syms]


# --- signals (Nautilus engine of record) ----------------------------------------------------

def nautilus_trades(ser: Series, definition: dict) -> list[dict]:
    from nautilus_backtest.bars import Bars
    from nautilus_backtest.engine import run_spec

    bars = Bars.from_columns({"t": [epoch_ms(d) for d in ser.days], "o": list(ser.o),
                              "h": list(ser.h), "l": list(ser.l), "c": list(ser.c)})
    result = run_spec(bars, {"rule": {"kind": "dsl", "definition": definition}, "costBps": 10,
                             "costs": None})
    return list(result.trades)


# --- portfolio simulation -------------------------------------------------------------------

@dataclass
class Position:
    symbol: str
    spread: Spread
    contracts: int
    trade_end: date
    exit_price: float


@dataclass
class SimStats:
    entries: int = 0
    skipped: int = 0
    gate_bound: int = 0
    contracts: list = field(default_factory=list)
    risk_pct: list = field(default_factory=list)
    resizes: int = 0
    costs: float = 0.0
    # per entry: (symbol, vol target that would give the same contracts) - the vol target the
    # fixed-risk rule implies for that trade
    implied_tau: list = field(default_factory=list)


@dataclass(frozen=True)
class Market:
    """Everything a simulation reads, aligned to the master calendar."""
    calendar: tuple[date, ...]
    close: dict  # symbol -> list aligned to calendar (forward filled)
    iv: dict
    rv: dict  # proposal-model 252-day realized vol (robustness pricing)
    vol: dict  # Carver instrument-risk estimate
    fast: dict
    slow: dict
    entries: dict  # symbol -> {date: (entry_price, exit_date, exit_price)}
    idm: float


def simulate(m: Market, variant: str, tau: float = CARVER_VOL_TARGET, iv_key: str = "iv"):
    """Daily mark-to-market of one strategy's spreads across the universe on one account."""
    ivs = m.iv if iv_key == "iv" else m.rv
    weight = 1 / len(UNIVERSE)
    cash = CAPITAL
    book: dict[str, Position] = {}
    stats = SimStats()
    curve = []

    def target(sym, i, nlv, s, sp):
        return vol_target_contracts(nlv, tau=tau, weight=weight, idm=m.idm, forecast=FORECAST_IN,
                                    sigma=m.vol[sym][i], s=s, delta=sp.delta)

    def size(sym, i, nlv, s, sp, legs):
        loss_pc = max_loss_per_contract(sp, legs)
        per_tau = target(sym, i, nlv, s, sp) / tau
        if per_tau > 0:
            stats.implied_tau.append((sym, CURRENT_RISK * nlv / loss_pc / per_tau))
        if variant == "current":
            c = size_fixed_risk(nlv, loss_pc)
            raw = CURRENT_RISK * nlv / loss_pc
        elif variant == "brake":
            c = size_vol_brake(nlv, loss_pc, m.fast[sym][i], m.slow[sym][i])
            raw = c
        else:
            raw = target(sym, i, nlv, s, sp)
            c = min(max(0, round(raw)), gate_cap(nlv, loss_pc))
        if c < round(raw) and c == gate_cap(nlv, loss_pc):
            stats.gate_bound += 1
        return c, loss_pc

    for i, day in enumerate(m.calendar):
        marks = {sym: spread_value(p.spread, m.close[sym][i], day, ivs[sym][i])
                 for sym, p in book.items()}
        nlv = cash + sum(marks[s] * book[s].contracts * MULT for s in book)
        # exits (signal end) and rolls
        for sym in list(book):
            p = book[sym]
            s = p.exit_price if day >= p.trade_end else m.close[sym][i]
            legs = leg_prices(p.spread, s, day, ivs[sym][i])
            value = (legs[0] - legs[1]) * MULT * p.contracts
            cost = trade_cost(p.contracts, legs)
            if day >= p.trade_end:
                cash += value - cost
                stats.costs += cost
                del book[sym]
            elif (p.spread.expiry - day).days <= ROLL_DTE:
                cash += value - cost
                stats.costs += cost
                sp = open_spread(s, day, ivs[sym][i])
                legs2 = leg_prices(sp, s, day, ivs[sym][i])
                c, _ = size(sym, i, nlv, s, sp, legs2)
                if c > 0:
                    cost2 = trade_cost(c, legs2)
                    cash -= sp.debit * MULT * c + cost2
                    stats.costs += cost2
                    book[sym] = Position(sym, sp, c, p.trade_end, p.exit_price)
                else:
                    del book[sym]
        # buffered resizing (vol target only)
        if variant == "vt-buffer" and i % REVIEW_EVERY == 0:
            for sym, p in book.items():
                s = m.close[sym][i]
                legs = leg_prices(p.spread, s, day, ivs[sym][i])
                value_pc = (legs[0] - legs[1]) * MULT
                t_rem = max(0.0, (p.spread.expiry - day).days / 365)
                delta = (call_delta(s, p.spread.k1, t_rem, ivs[sym][i])
                         - call_delta(s, p.spread.k2, t_rem, ivs[sym][i]))
                tgt = vol_target_contracts(nlv, tau=tau, weight=weight, idm=m.idm,
                                           forecast=FORECAST_IN, sigma=m.vol[sym][i], s=s,
                                           delta=delta)
                new = buffered(p.contracts, tgt)
                if new > p.contracts:  # adds may not push the position past the gate
                    new = min(new, max(p.contracts, gate_cap(nlv, value_pc + 2 * trade_cost(1, legs))))
                if new != p.contracts:
                    change = new - p.contracts
                    cost = trade_cost(abs(change), legs)
                    cash -= value_pc * change + cost
                    stats.costs += cost
                    stats.resizes += 1
                    p.contracts = new
        # new signal entries
        for sym in UNIVERSE:
            entry = m.entries[sym].get(day)
            if entry is None or sym in book:
                continue
            s, exit_day, exit_price = entry
            sigma = ivs[sym][i]
            if math.isnan(sigma) or math.isnan(m.vol[sym][i]):
                continue
            sp = open_spread(s, day, sigma)
            legs = leg_prices(sp, s, day, sigma)
            c, loss_pc = size(sym, i, nlv, s, sp, legs)
            stats.entries += 1
            if c <= 0:
                stats.skipped += 1
                continue
            cost = trade_cost(c, legs)
            cash -= sp.debit * MULT * c + cost
            stats.costs += cost
            stats.contracts.append(c)
            stats.risk_pct.append(c * loss_pc / nlv)
            assert c * loss_pc <= MAX_LOSS_GATE * nlv + 1e-6, "2% max-loss gate breached"
            book[sym] = Position(sym, sp, c, exit_day, exit_price)
        marks = {sym: spread_value(p.spread, m.close[sym][i], day, ivs[sym][i])
                 for sym, p in book.items()}
        curve.append(cash + sum(marks[s] * book[s].contracts * MULT for s in book))
    return curve, stats


# --- statistics -----------------------------------------------------------------------------

def metrics(calendar, curve, stats: SimStats) -> dict:
    years = (calendar[-1] - calendar[0]).days / 365.25
    rets = [curve[i] / curve[i - 1] - 1 for i in range(1, len(curve))]
    mean = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1))
    peak, mdd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    month_end = {}
    for d, v in zip(calendar, curve):
        month_end[(d.year, d.month)] = v
    months = [CAPITAL] + [month_end[k] for k in sorted(month_end)]
    monthly = [months[i] / months[i - 1] - 1 for i in range(1, len(months))]
    worst = min(range(len(monthly)), key=lambda k: monthly[k])
    worst_key = sorted(month_end)[worst]
    n = len(stats.contracts)
    return {
        "cagr": (curve[-1] / curve[0]) ** (1 / years) - 1,
        "sharpe": mean / sd * math.sqrt(TRADING_DAYS) if sd > 0 else None,
        "vol": sd * math.sqrt(TRADING_DAYS),
        "maxDrawdown": mdd,
        "worstMonth": monthly[worst],
        "worstMonthAt": f"{worst_key[0]}-{worst_key[1]:02d}",
        "entries": stats.entries,
        "skipped": stats.skipped,
        "gateBound": stats.gate_bound,
        "contractsMean": sum(stats.contracts) / n if n else 0,
        "contractsMedian": sorted(stats.contracts)[n // 2] if n else 0,
        "contractsMax": max(stats.contracts) if n else 0,
        "riskPctMean": sum(stats.risk_pct) / n if n else 0,
        "riskPctMax": max(stats.risk_pct) if n else 0,
        "resizes": stats.resizes,
        "costsPctCapital": stats.costs / CAPITAL,
        "endNlv": curve[-1],
        **implied_tau_summary(stats.implied_tau),
    }


def implied_tau_summary(pairs) -> dict:
    """How far the fixed-risk rule is from vol parity: the vol target each entry's fixed-risk
    size implies (per instrument mean, and the coefficient of variation over all entries)."""
    if not pairs:
        return {}
    values = [v for _, v in pairs]
    mean = sum(values) / len(values)
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1))
    by = {}
    for sym, v in pairs:
        by.setdefault(sym, []).append(v)
    return {"impliedTauMean": mean, "impliedTauCv": sd / mean,
            "impliedTauBySymbol": {k: sum(v) / len(v) for k, v in by.items()}}


def monthly_curve(calendar, curve) -> list[list]:
    out = {}
    for d, v in zip(calendar, curve):
        out[f"{d.year}-{d.month:02d}"] = v / CAPITAL
    return [[k, round(v, 5)] for k, v in out.items()]


def matched_tau(m: Market, target_vol: float, variant: str = "vt") -> float:
    """Vol target whose realized portfolio vol equals `target_vol` (bisection)."""
    lo, hi = 0.002, 0.6
    for _ in range(22):
        mid = (lo + hi) / 2
        curve, _ = simulate(m, variant, tau=mid)
        rets = [curve[i] / curve[i - 1] - 1 for i in range(1, len(curve))]
        mu = sum(rets) / len(rets)
        vol = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1) * TRADING_DAYS)
        if vol < target_vol:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


# --- main -----------------------------------------------------------------------------------

def build_market(series: dict[str, Series], definition: dict, idm: float) -> tuple[Market, dict]:
    calendar = tuple(d for d in series["SPY"].days if d >= START)
    close, iv, rv, vol, fast, slow, entries, signal = {}, {}, {}, {}, {}, {}, {}, {}
    for sym, ser in series.items():
        rets = returns(ser.c)
        cols = {"close": list(ser.c), "iv": iv_proxy(rets), "rv": realized_252(ser.c),
                "vol": carver_vol(rets), "fast": ewma_vol(rets, FAST_SPAN), "slow": slow_vol(rets)}
        index = {d: k for k, d in enumerate(ser.days)}
        aligned = {name: [] for name in cols}
        last = None
        for d in calendar:
            last = index.get(d, last)
            for name, col in cols.items():
                aligned[name].append(math.nan if last is None else col[last])
        close[sym], iv[sym], rv[sym] = aligned["close"], aligned["iv"], aligned["rv"]
        vol[sym], fast[sym], slow[sym] = aligned["vol"], aligned["fast"], aligned["slow"]
        trades = nautilus_trades(ser, definition)
        signal[sym] = len(trades)
        cal = set(calendar)
        entries[sym] = {}
        for t in trades:
            e, x = ser.days[t["entryIndex"]], ser.days[t["exitIndex"]]
            if e >= START and e in cal:
                entries[sym][e] = (t["entryPrice"], x, t["exitPrice"])
    return Market(calendar, close, iv, rv, vol, fast, slow, entries, idm), signal


VARIANTS = (
    ("current", "Current: fixed 0.50% NLV max loss", "current"),
    ("vt-matched", "Vol target, risk-matched to current", "vt"),
    ("vt-buffer", "Vol target, risk-matched, weekly buffered resize", "vt-buffer"),
    ("brake", "Current + shrink-only vol brake", "brake"),
    ("vt-16", "Vol target 16% (Carver default), 2% gate", "vt"),
)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    series = {s: load_series(args.data / "daily" / f"{s}.csv", s) for s in UNIVERSE}
    end = min(ser.days[-1] for ser in series.values())
    corr = weekly_corr(series, START, end)
    idm = idm_from_corr(corr, [1 / len(UNIVERSE)] * len(UNIVERSE))
    library = {s["id"]: s for s in json.loads(LIBRARY.read_text())["strategies"]}
    from nautilus_backtest.engine import ENGINE_ID

    out = {"researchOnly": True, "promoted": [], "engine": ENGINE_ID, "capital": CAPITAL,
           "window": [START.isoformat(), end.isoformat()], "universe": list(UNIVERSE),
           "futureOf": FUTURE_OF, "idm": idm,
           "corr": [[round(x, 3) for x in row] for row in corr], "strategies": []}
    for sid in STRATEGY_IDS:
        lib = library[sid]
        market, signal = build_market(series, lib["dsl"], idm)
        cur_curve, cur_stats = simulate(market, "current")
        cur = metrics(market.calendar, cur_curve, cur_stats)
        tau_m = matched_tau(market, cur["vol"])
        tau_b = matched_tau(market, cur["vol"], "vt-buffer")
        rows, curves = [], {}
        for key, label, variant in VARIANTS:
            tau = {"vt-matched": tau_m, "vt-buffer": tau_b}.get(key, CARVER_VOL_TARGET)
            curve, st = (cur_curve, cur_stats) if key == "current" else simulate(market, variant, tau)
            row = {"id": key, "label": label, "tau": tau if variant.startswith("vt") else None,
                   **metrics(market.calendar, curve, st)}
            rv_curve, rv_st = simulate(market, variant, tau, iv_key="rv")
            row["robustRv252"] = {k: metrics(market.calendar, rv_curve, rv_st)[k]
                                  for k in ("cagr", "sharpe", "maxDrawdown", "contractsMean")}
            rows.append(row)
            curves[key] = monthly_curve(market.calendar, curve)
        out["strategies"].append({"id": sid, "name": lib["name"], "definition": lib["dsl"],
                                  "signalTrades": signal, "variants": rows, "curves": curves})
        print(sid, "done", file=sys.stderr)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
