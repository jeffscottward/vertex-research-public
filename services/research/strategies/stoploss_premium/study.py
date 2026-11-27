"""Runs tests A-H of the stopping-premium plan on a daily-bar data directory and returns one result per test.

The data directory is a qc-ports / options-forms directory (see bars.py): SP100 stocks, ETFs and the index
files VIX, VXN, RVX, VXD, GVZ, OVX, VXSLV and IRX. Test E (Crown) takes counts of the stored Crown history
from the caller; it needs no prices.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import books, csp, entries, optiontests, premium, shares
from .bars import Series, daily_rf, load_bars, load_index
from .options import IV_INDEX, Leg, Trade, Underlying, leaps_expiry, open_trade, strike_for_delta, target_expiry
from .portfolio import PathReturns, aggregate, stop_step, trade_returns, with_exposure

ETFS = ("SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE",
        "XLC", "TLT", "IEF", "GLD", "SLV", "USO", "DBC", "EEM", "EFA", "VNQ", "GDX", "EWA", "EWC", "FXA",
        "FXB", "FXE", "CORN")
INDEX_FILES = ("VIX", "VXN", "RVX", "VXD", "GVZ", "OVX", "VXSLV", "IRX", "VIX3M", "VIX6M", "TNX")
TREND_UNIVERSE = ("SPY", "QQQ", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLU", "TLT", "IEF", "GLD", "SLV",
                  "USO", "DBC")
ROTATION_UNIVERSE = ("SPY", "XLK", "XLE", "XLF", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
                     "IWM", "TLT", "GLD", "SLV", "USO")
CSP_NAMES = ("F", "BAC", "PFE", "T", "VZ", "CMCSA", "CSX", "KR", "MDLZ", "USB", "BMY", "NKE", "XLF", "XLE", "XLU")
WARMUP = 260
TRADING_DAYS = 252
# Option books (tests B, C, D): share of the account in premium; the rest earns the T-bill rate. 25% is the live
# LEAPS bucket (MW_HIST_MAX_TOTAL, market-watch-bot reentry/config.py); the live per-name caps are 6% and 2% NLV.
PREMIUM_BUCKET = 0.25
OPTION_BOOK = {"value_weighted": True, "exposure": PREMIUM_BUCKET}
EXPOSURES = (0.06, PREMIUM_BUCKET, 1.0)  # drawdown-test stability check: per-name LEAPS cap, bucket, all premium
RANDOM_SEED = 11
# Live rules ported from the market-watch-bot repository (no import across repositories). The ported files are
# identical at a8df702b and at 57a1b3b (origin/main on 2026-11-27).
PORTED_FROM = {"repository": "jeffscottward/market-watch-bot", "commit": "57a1b3b", "files": {
    "shares.compute_levels, shares.min_atr": "market_watch/reentry/harness.py, market_watch/stops.py",
    "optiontests.ladder_levels, LADDER_WEIGHTS, LAST_CHANCE_DAYS": "market_watch/reentry/leaps.py",
    "optiontests.loser_close_rule": "market_watch/exit_rule.py",
    "entries (reclaim, zdip, stops)": "market_watch/reentry/config.py, market_watch/reentry/gates.py",
    "entries (acceptance, failed_breakdown, stops)": "market_watch/auction/rules.py",
    "csp": "market_watch/income/rules.py, market_watch/income/model.py, market_watch/income/backtest.py",
    "books.atr_book, books.trend_selector": "market_watch/research/backtests.py, market_watch/copyrot/trend.py",
    "books.rotation_selector": "market_watch/copyrot/rotation.py",
    "books.atr_book brake": "market_watch/risk/__init__.py"}}
SURVIVOR_NOTE = ("survivorship bias: today's SP100 list; names that left the index are missing, which likely "
                 "favours holding over the rule")


@dataclass
class Data:
    calendar: list[str]
    rf: list[float]
    names: dict[str, Series]
    indexes: dict[str, dict[str, float]]
    k: dict[str, int] = field(init=False)

    def __post_init__(self) -> None:
        self.k = {d: i for i, d in enumerate(self.calendar)}

    def stocks(self) -> list[str]:
        return sorted(s for s in self.names if s not in ETFS and "=" not in s)

    def name_rf(self, s: Series) -> list[float]:
        out, last = [], 0.0
        for d in s.dates:
            k = self.k.get(d)
            if k is not None:
                last = self.rf[k]
            out.append(last)
        return out

    def first_k(self, s: Series, i: int) -> int | None:
        """Calendar index of the name's day i (None when the calendar lacks it)."""
        return self.k.get(s.dates[i])

    def underlying(self, sym: str, spread_scale: float = 1.0) -> Underlying:
        s = self.names[sym]
        idx = self.indexes.get(IV_INDEX.get(sym, ""))
        rates = [x * TRADING_DAYS for x in self.name_rf(s)]
        return Underlying(s, idx, etf=sym in ETFS, spread_scale=spread_scale, rates=rates)


def load(data_dir: Path) -> Data:
    names = {}
    for p in sorted(data_dir.glob("*.csv")):
        sym = p.stem
        if sym in INDEX_FILES or sym == "SHILLER" or "=" in sym or p.name.endswith(".splits.csv"):
            continue
        s = load_bars(p, sym)
        if len(s.dates) > WARMUP:
            names[sym] = s
    indexes = {i: load_index(data_dir / f"{i}.csv") for i in INDEX_FILES if (data_dir / f"{i}.csv").exists()}
    calendar = list(names["SPY"].dates)
    return Data(calendar, daily_rf(indexes.get("IRX", {}), calendar), names, indexes)


# --- evaluation -------------------------------------------------------------------------------------

def curve(legs: premium.Legs, every: int = 21) -> dict:
    w = o = 1.0
    out = {"dates": [], "with": [], "without": []}
    for j, (a, b) in enumerate(zip(legs.with_rule, legs.without)):
        w *= 1 + a
        o *= 1 + b
        if j % every == 0 or j == len(legs.dates) - 1:
            out["dates"].append(legs.dates[j])
            out["with"].append(round(w, 5))
            out["without"].append(round(o, 5))
    return out


def evaluate(name: str, data: Data, main: Sequence[PathReturns], low: Sequence[PathReturns] | None,
             high: Sequence[PathReturns] | None, *, step: int | None = None, note: str = "",
             legs: premium.Legs | None = None, low_legs: premium.Legs | None = None,
             high_legs: premium.Legs | None = None, value_weighted: bool = False,
             exposure: float = 1.0, headline: bool = False) -> dict:
    """One variant: summary, threshold premiums, verdict. Paths are aggregated on the calendar unless the
    legs are given (books). Option and put books pass value_weighted (and the premium bucket as exposure)."""
    def book(p: Sequence[PathReturns]) -> premium.Legs:  # exposure 1; other shares are a linear mix
        return aggregate(data.calendar, data.rf, p, value_weighted=value_weighted)
    full = legs if legs is not None else book(main)
    lg = with_exposure(full, exposure) if legs is None and exposure < 1 else full
    st = step if step is not None else stop_step(main)
    s = premium.summary(lg, st)
    thr = []
    for p, q in ((low, low_legs), (high, high_legs)):
        if q is not None:
            thr.append(premium.premium(q))
        elif p is not None:
            thr.append(premium.premium(with_exposure(book(p), exposure)))
    out = {"name": name, "note": note, "headline": headline, "summary": s, "thresholds": thr,
           "verdict": premium.verdict(s, thr if thr else None),
           "insuranceCost": premium.insurance_cost(s), "drawdownCut": premium.drawdown_cut(s),
           "perTrade": trade_returns(main) if value_weighted else None, "exposure": exposure,
           "curve": curve(lg)}
    if legs is None and value_weighted and exposure < 1:
        # the drawdown test is not linear in the premium share: report the verdict at each share. The daily
        # difference of the legs scales with the share, so the interval and the threshold signs carry over.
        out["byExposure"] = {}
        lo, hi = s["interval"]
        for e in EXPOSURES:
            k = e / exposure
            se = premium.summary(with_exposure(full, e), st, interval=(lo * k, hi * k))
            out["byExposure"][f"{e:g}"] = {"verdict": premium.verdict(se, thr if thr else None),
                                           "premium": se["premium"], "mddWith": se["mddWith"],
                                           "mddWithout": se["mddWithout"]}
    return out


def _log(progress: Callable[[str], None] | None, text: str) -> None:
    if progress:
        progress(text)


# --- test A -----------------------------------------------------------------------------------------

def test_a(data: Data, start: str = "2000-01-03", progress=None) -> dict:
    def run(fn: Callable[[Series, int, int, list[float], int], PathReturns]) -> list[PathReturns]:
        out = []
        for sym in data.stocks():
            s = data.names[sym]
            lo = next((i for i, d in enumerate(s.dates) if d >= start and i >= WARMUP), None)
            if lo is None or lo + 2 >= len(s.dates):
                continue
            k = data.first_k(s, lo + 1)
            if k is None:
                continue
            out.append(fn(s, lo, len(s.dates), data.name_rf(s), k))
        return out

    variants = []
    for label, kw in (("3-level ladder, 1 x ATR (plan)", {"mult": 1.0, "five": False}),
                      ("3-level ladder, 2 x ATR", {"mult": 2.0, "five": False}),
                      ("5-rung ladder, 1 x ATR (live harness)", {"mult": 1.0, "five": True})):
        _log(progress, f"A {label}")
        main = run(lambda s, lo, hi, rf, k, kw=kw: shares.ladder_path(s, lo, hi, rf, k, **kw))
        low = run(lambda s, lo, hi, rf, k, kw=kw: shares.ladder_path(s, lo, hi, rf, k, scale=0.75, **kw))
        high = run(lambda s, lo, hi, rf, k, kw=kw: shares.ladder_path(s, lo, hi, rf, k, scale=1.25, **kw))
        variants.append(evaluate(label, data, main, low, high, step=21, headline="live harness" in label))
    _log(progress, "A window stop")
    main = run(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k))
    low = run(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k, gamma=0.075))
    high = run(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k, gamma=0.125))
    variants.append(evaluate("paper window stop: out below -10% over 21 days, in at >= 0%", data, main, low, high, step=21))
    return {"id": "A", "title": "Share stop ladder", "prices": "real", "live": True, "bias": SURVIVOR_NOTE,
            "variants": variants,
            "universe": f"{len(data.stocks())} SP100 stocks, held from {start}"}


# --- tests B, C, D ----------------------------------------------------------------------------------

@dataclass
class EntryTrade:
    entry: entries.Entry
    trade: Trade
    k: int  # calendar index of the first day after entry
    rf: list[float]


def entry_list(data: Data, start: str, end_buffer_days: int,
               symbols: Sequence[str] | None = None) -> dict[str, list[entries.Entry]]:
    """Signal entries per name (default: the stocks) from `start` to `end_buffer_days` before the data end."""
    out = {}
    last = date.fromisoformat(data.calendar[-1])
    for sym in (data.stocks() if symbols is None else [x for x in symbols if x in data.names]):
        s = data.names[sym]
        lo = next((i for i, d in enumerate(s.dates) if d >= start and i >= WARMUP), None)
        if lo is None:
            continue
        hi = next((i for i, d in enumerate(s.dates) if (last - date.fromisoformat(d)).days < end_buffer_days),
                  len(s.dates))
        out[sym] = entries.signals(s, lo=lo, hi=hi)
    return out


def random_list(data: Data, real: dict[str, list[entries.Entry]]) -> dict[str, list[entries.Entry]]:
    return {sym: entries.random_entries(data.names[sym], es, RANDOM_SEED) for sym, es in real.items()}


def build_trades(data: Data, ent: dict[str, list[entries.Entry]],
                 make: Callable[[Underlying, entries.Entry], Trade | None], progress=None,
                 spread_scale: float = 1.0) -> list[EntryTrade]:
    out = []
    for n, (sym, es) in enumerate(sorted(ent.items())):
        if not es:
            continue
        u = data.underlying(sym, spread_scale)
        rf = data.name_rf(u.s)
        for e in es:
            t = make(u, e)
            if t is None or t.entry_i + 1 >= len(u.s.dates):
                continue
            k = data.first_k(u.s, t.entry_i + 1)
            if k is not None:
                out.append(EntryTrade(e, t, k, rf))
        if n % 20 == 0:
            _log(progress, f"  priced {sym} ({n + 1}/{len(ent)}), {len(out)} trades")
    return out


def make_leaps(u: Underlying, e: entries.Entry) -> Trade | None:
    d = u.dates[e.i]
    expiry = leaps_expiry(d)
    k = strike_for_delta(u, e.i, expiry, "call", 0.75)
    if k is None:
        return None
    return open_trade(u, (Leg("call", k, 1),), e.i, expiry, last_chance=optiontests.LAST_CHANCE_DAYS)


def make_call45(u: Underlying, e: entries.Entry) -> Trade | None:
    expiry = target_expiry(u.dates[e.i], 30, 60, 45)
    if expiry is None:
        return None
    k = strike_for_delta(u, e.i, expiry, "call", 0.50)
    return None if k is None else open_trade(u, (Leg("call", k, 1),), e.i, expiry)


def make_spread45(u: Underlying, e: entries.Entry) -> Trade | None:
    expiry = target_expiry(u.dates[e.i], 30, 60, 45)
    if expiry is None:
        return None
    k1 = strike_for_delta(u, e.i, expiry, "call", 0.50)
    k2 = strike_for_delta(u, e.i, expiry, "call", 0.30)
    if k1 is None or k2 is None or k2 <= k1:
        return None
    return open_trade(u, (Leg("call", k1, 1), Leg("call", k2, -1)), e.i, expiry)


def option_paths(trades: Iterable[EntryTrade], rule: Callable[[EntryTrade], optiontests.Rule]) -> list[PathReturns]:
    return [optiontests.path(et.trade, rule(et), et.rf, et.k) for et in trades]


def ladder_for(scale: float) -> Callable[[EntryTrade], optiontests.Rule]:
    def make(et: EntryTrade) -> optiontests.Rule:
        e, u = et.entry, et.trade.u
        f = u.factor[e.i]
        lim = e.price * f
        stop = lim - scale * (lim - e.stop * f)
        return optiontests.ladder_rule(optiontests.ladder_levels(lim, stop, scale * e.atr * f))
    return make


LEAPS = "📅 LEAPS call (delta 0.75)"
CALL45 = "45-day call (delta 0.50)"
SPREAD45 = "45-day call debit spread (0.50 / 0.30 delta)"


def option_sets(data: Data, progress=None) -> dict[str, list[EntryTrade]]:
    """Every trade list of tests B, C and D (stocks; ETFs with a Cboe IV index; random control entries;
    stocks at half the model spread)."""
    stocks = entry_list(data, "2005-01-03", 400)
    etfs = entry_list(data, "2005-01-03", 400, sorted(IV_INDEX))
    _log(progress, f"entries: {sum(len(v) for v in stocks.values())} stock, {sum(len(v) for v in etfs.values())} ETF")
    sets = {}
    for key, ent, make, scale in (
            ("leaps", stocks, make_leaps, 1.0), ("leaps random", random_list(data, stocks), make_leaps, 1.0),
            ("call45", stocks, make_call45, 1.0), ("spread45", stocks, make_spread45, 1.0),
            ("call45 half spread", stocks, make_call45, 0.5), ("spread45 half spread", stocks, make_spread45, 0.5),
            ("leaps etf", etfs, make_leaps, 1.0), ("call45 etf", etfs, make_call45, 1.0),
            ("spread45 etf", etfs, make_spread45, 1.0)):
        _log(progress, f"pricing {key}")
        sets[key] = build_trades(data, ent, make, progress, spread_scale=scale)
    return sets


def test_b(data: Data, sets: dict[str, list[EntryTrade]], progress=None) -> dict:
    leaps = sets["leaps"]
    groups: dict[str, tuple[list[EntryTrade], str]] = {
        "all proxy entries": (leaps, "headline row"),
        "momentum entries (reclaim + acceptance)": ([et for et in leaps if et.entry.family == "momentum"], ""),
        "dip entries (z-score + failed breakdown)": ([et for et in leaps if et.entry.family == "dip"], "")}
    groups.update({f"only {k}": ([et for et in leaps if et.entry.kind == k], "") for k in entries.KINDS})
    groups["control: random entry days, stop 2 x ATR"] = (sets["leaps random"], "control row, not a live entry")
    groups["ETFs with a Cboe IV index (all entry kinds)"] = (sets["leaps etf"], "IV from the index, not realized vol")
    variants = []
    for label, (sel, extra) in groups.items():
        if not sel:
            continue
        _log(progress, f"B {label}: {len(sel)} trades")
        main = option_paths(sel, ladder_for(1.0))
        low = option_paths(sel, ladder_for(0.75))
        high = option_paths(sel, ladder_for(1.25))
        note = f"{len(sel)} entries" + (f"; {extra}" if extra else "")
        variants.append(evaluate(label, data, main, low, high, note=note, headline=label == "all proxy entries",
                                 **OPTION_BOOK))
    return {"id": "B", "title": "📅 LEAPS exit ladder", "prices": "model price", "live": True, "bias": SURVIVOR_NOTE,
            "variants": variants,
            "universe": f"{len(data.stocks())} SP100 stocks (and {len(IV_INDEX)} IV-index ETFs in one row); "
                        "delta-0.75 call, first monthly expiry >= 365 days; entries 2005 to 400 days before the data end"}


def test_c(data: Data, sets: dict[str, list[EntryTrade]], progress=None) -> dict:
    variants = []
    for structure, key in ((CALL45, "call45"), (SPREAD45, "spread45")):
        trades = sets[key]
        _log(progress, f"C {structure}: {len(trades)} trades")
        for n, low, high in ((3, 2, 4), (1, None, None), (5, None, None)):
            main = option_paths(trades, lambda et, n=n: optiontests.loser_close_rule(n))
            lo = option_paths(trades, lambda et, x=low: optiontests.loser_close_rule(x)) if low else None
            hi = option_paths(trades, lambda et, x=high: optiontests.loser_close_rule(x)) if high else None
            label = f"{structure}: loser closes {n} sessions before expiry" + (" (live rule)" if n == 3 else "")
            note = (f"{len(trades)} entries; threshold check T-2 and T-4" if low else
                    f"{len(trades)} entries; comparison row (no threshold check, cannot pass 'adds return')")
            variants.append(evaluate(label, data, main, lo, hi, note=note, headline=n == 3, **OPTION_BOOK))
        for extra_key, label, note in ((f"{key} half spread", "at half the model spread (1.5% per leg)",
                                        "spread sensitivity"),
                                       (f"{key} etf", "ETFs with a Cboe IV index", "IV from the index")):
            tr = sets[extra_key]
            if not tr:
                continue
            main = option_paths(tr, lambda et: optiontests.loser_close_rule(3))
            lo = option_paths(tr, lambda et: optiontests.loser_close_rule(2))
            hi = option_paths(tr, lambda et: optiontests.loser_close_rule(4))
            variants.append(evaluate(f"{structure}: T-3 loser close, {label}", data, main, lo, hi,
                                     note=f"{len(tr)} entries; {note}", **OPTION_BOOK))
    return {"id": "C", "title": "Options exit rule (loser close before expiry)", "prices": "model price",
            "live": True, "bias": SURVIVOR_NOTE, "variants": variants,
            "universe": "same entry kinds as B; 30-60 day options, expiry nearest 45 days"}


def test_d(data: Data, sets: dict[str, list[EntryTrade]], progress=None) -> dict:
    variants = []
    for structure, key in ((LEAPS, "leaps"), (CALL45, "call45"), (SPREAD45, "spread45"),
                           (LEAPS + ", IV-index ETFs", "leaps etf"), (CALL45 + ", IV-index ETFs", "call45 etf"),
                           (SPREAD45 + ", IV-index ETFs", "spread45 etf")):
        trades = sets[key]
        if not trades:
            continue
        _log(progress, f"D {structure}: {len(trades)} trades")
        main = option_paths(trades, lambda et: optiontests.premium_stop_rule(0.50))
        low = option_paths(trades, lambda et: optiontests.premium_stop_rule(0.375))
        high = option_paths(trades, lambda et: optiontests.premium_stop_rule(0.625))
        variants.append(evaluate(f"{structure}: stop at a 50% loss of premium", data, main, low, high,
                                 note=f"{len(trades)} entries; threshold check at 37.5% and 62.5% loss",
                                 **OPTION_BOOK))
    return {"id": "D", "title": "Premium stop on long options and debit spreads", "prices": "model price",
            "live": False, "bias": SURVIVOR_NOTE, "variants": variants,
            "universe": "same entries as B; stocks (IV from realized vol) and ETFs with a Cboe IV index"}


# --- test F -----------------------------------------------------------------------------------------

def test_f(data: Data, start: str = "2011-01-03", progress=None) -> dict:
    rows: list[tuple[Underlying, csp.Position, int, list[float], int]] = []
    for sym in CSP_NAMES:
        if sym not in data.names:
            continue
        u = data.underlying(sym)
        rf = data.name_rf(u.s)
        lo = next((i for i, d in enumerate(u.s.dates) if d >= start and i >= WARMUP), None)
        if lo is None:
            continue
        for i, e in csp.entry_days(u, lo, len(u.s.dates)):
            pos = csp.open_put(u, i, e)
            k = data.first_k(u.s, i + 1) if i + 1 < len(u.s.dates) else None
            if pos is not None and k is not None:
                rows.append((u, pos, i, rf, k))
    _log(progress, f"F {len(rows)} cash-secured puts")
    base = {id(r[1]): csp.simulate(r[0], r[1], r[2], r[3])[0] for r in rows}

    def paths(**kw) -> list[PathReturns]:
        out = []
        for u, pos, i, rf, k in rows:
            v, ev = csp.simulate(u, pos, i, rf, **kw)
            out.append(csp.pair(v, base[id(pos)], rf, i, k, ev))
        return out
    names = sorted({r[0].s.symbol for r in rows})
    variants = [
        evaluate("today's design + stop at 2 x credit", data, paths(stop_mult=2.0), paths(stop_mult=1.75),
                 paths(stop_mult=2.25), note="threshold check 1.75 x and 2.25 x", value_weighted=True),
        evaluate("today's design, roll down and out for a credit instead of the loss close", data,
                 paths(roll=True), paths(roll=True, loss_sessions=2), paths(roll=True, loss_sessions=4),
                 note="threshold check: roll at T-2 and T-4", value_weighted=True),
    ]
    return {"id": "F", "title": "Cash-secured puts", "prices": "model price", "live": False, "variants": variants,
            "universe": f"{', '.join(names)} from {start}; one put per monthly expiry"}


# --- tests G, H -------------------------------------------------------------------------------------

def _book_legs(data: Data, a: books.BookResult, b: books.BookResult, start: int, events: int) -> premium.Legs:
    n = len(a.returns)
    return premium.Legs(tuple(data.calendar[start + 1:start + 1 + n]), tuple(a.returns), tuple(b.returns),
                        tuple(data.rf[start + 1:start + 1 + n]), tuple(a.out), events, len(a.stop_dates))


def _median(xs: list[int], default: int = 21) -> int:
    return sorted(xs)[len(xs) // 2] if xs else default


def test_g(data: Data, start: str = "1999-12-31", progress=None) -> dict:
    k0 = next(i for i, d in enumerate(data.calendar) if d >= start)
    end = len(data.calendar)
    variants = []
    for label, universe, select in (("trend book", TREND_UNIVERSE, books.trend_selector()),
                                    ("sector rotation (momentum part)", ROTATION_UNIVERSE, books.rotation_selector())):
        al = books.align({s: data.names[s] for s in universe if s in data.names}, data.calendar)
        _log(progress, f"G {label}")
        runs = {x: books.atr_book(al, data.rf, select, start=k0, end=end, stop_atr=x) for x in (2.0, 1.5, 2.5)}
        none = books.atr_book(al, data.rf, select, start=k0, end=end, stop_atr=None)
        main = _book_legs(data, runs[2.0], none, k0, runs[2.0].stop_events)
        variants.append(evaluate(f"{label}: with the 2 x ATR stop", data, [], None, None,
                                 step=_median(runs[2.0].days_to_stop), legs=main,
                                 low_legs=_book_legs(data, runs[1.5], none, k0, 0),
                                 high_legs=_book_legs(data, runs[2.5], none, k0, 0),
                                 note="threshold check 1.5 x and 2.5 x ATR"))
    _log(progress, "G 10-month rule")
    lo_paths: dict[int, list[PathReturns]] = {8: [], 10: [], 12: []}
    for sym in TREND_UNIVERSE:
        s = data.names.get(sym)
        if s is None:
            continue
        lo = next((i for i, d in enumerate(s.dates) if d >= start and i >= WARMUP), None)
        if lo is None:
            continue
        k = data.first_k(s, lo + 1)
        if k is None:
            continue
        for m in lo_paths:
            lo_paths[m].append(books.ma_rule_path(s, lo, len(s.dates), data.name_rf(s), k, months=m))
    variants.append(evaluate("10-month rule against buy and hold (15 ETFs, equal weight)", data, lo_paths[10],
                             lo_paths[8], lo_paths[12], step=21, note="threshold check 8 and 12 months"))
    return {"id": "G", "title": "Trend book and sector rotation", "prices": "real", "live": False, "variants": variants,
            "universe": "trend: 15 ETFs; rotation: 16 ETFs vs SPY (no SOXX in the data); decisions from " + start}


def test_h(data: Data, start: str = "1999-12-31", progress=None) -> dict:
    k0 = next(i for i, d in enumerate(data.calendar) if d >= start)
    end = len(data.calendar)
    variants = []
    for label, universe, select in (("trend book", TREND_UNIVERSE, books.trend_selector()),
                                    ("sector rotation (momentum part)", ROTATION_UNIVERSE, books.rotation_selector())):
        al = books.align({s: data.names[s] for s in universe if s in data.names}, data.calendar)
        _log(progress, f"H {label}")
        none = books.atr_book(al, data.rf, select, start=k0, end=end)
        runs = {b: books.atr_book(al, data.rf, select, start=k0, end=end, brake=b)
                for b in ((0.10, 0.15), (0.075, 0.1125), (0.125, 0.1875))}
        main = runs[(0.10, 0.15)]
        legs = premium.Legs(tuple(data.calendar[k0 + 1:end]), tuple(main.returns), tuple(none.returns),
                            tuple(data.rf[k0 + 1:end]), tuple(main.brake_flags),
                            main.brake_events, main.brake_events)
        thr_lo = _book_legs(data, runs[(0.075, 0.1125)], none, k0, 0)
        thr_hi = _book_legs(data, runs[(0.125, 0.1875)], none, k0, 0)
        v = evaluate(f"{label}: brake -10% / -15%", data, [], None, None, step=21, legs=legs, low_legs=thr_lo,
                     high_legs=thr_hi, note=f"brake engaged {main.brake_events} times; active "
                                            f"{main.brake_days} of {len(main.returns)} days; threshold check +/-25%")
        variants.append(v)
    return {"id": "H", "title": "Drawdown brake", "prices": "real", "live": False, "variants": variants,
            "universe": "the G books with their 2 x ATR stops"}


def test_e(closed_trades: int, level_exits: int, notes: int, first: str, last: str) -> dict:
    s = {"stopEvents": level_exits}
    return {"id": "E", "title": "Crown spread copies", "prices": "none", "live": False, "variants": [{
        "name": "close when Crown's stated level breaks, against holding to the exit rule",
        "note": (f"stored Crown history: {notes} desk notes from {first} to {last}, {closed_trades} closed "
                 f"trades, {level_exits} notes with a 'close below' level; Crown is switched off"),
        "summary": s, "thresholds": [], "verdict": premium.NOT_ENOUGH, "insuranceCost": None,
        "drawdownCut": None, "curve": None}], "universe": "Crown desk notes (stored, read only)"}
