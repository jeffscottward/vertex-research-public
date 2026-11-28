"""Dry-run study of alternative exit rules (card stoploss-alt-exit-dryrun; research only, no live change).

Evaluates alternatives to the three live exit rules studied in PR #489 (stoploss-stopping-premium-backtests):
  * Family A (Share stop): no share stop, wider ATR ladders (2x/3x ATR), close-confirmed ladder, wider
    trailing ATR stops (3x/4x/5x ATR), Kaminski-Lo 21d window stop, 10-month trend filter.
  * Family B (LEAPS ladder): cheaper ladder variants — close-confirmed, wider ATR/stop spacing, fewer/back-loaded
    rungs (3-rung, 2-rung, single deep stop), grace-period ladder, premium-loss stops (40%, 50%, 35%/55% ladder),
    and no ladder (time exit T-2 only).
  * Family C (Pre-expiry loss close): hold losing options to 15:45 expiry-day close (T-0, including 2x expiry
    spread stress), T-1 loser close, deep-loser-only T-3 (>=50% / >=75% loss), and salvage-filtered T-3.

Every candidate is evaluated BOTH:
  1. Against no exit rule using PR #489's fixed Kaminski-Lo stopping-premium rubric (delta-mu, 90% circular
     block bootstrap interval, time halves, +/-25% threshold check, drawdown cut, insurance cost, verdict).
  2. Head-to-head against the current live rule (`vsLive`: delta-mu vs live, 90% CI vs live, halves vs live,
     drawdown change vs live, insurance-cost ratio vs live, stop-event reduction).

Works identically on model-priced trades (`options.Trade`) and real historical option-quote trades
(`real_quotes.RealTrade`), and on both standard and survivorship-free PIT equity universes (`pit.PitMembership`).
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date
import math
from typing import Any, Protocol

from . import books, entries, optiontests, pit, premium, shares, study
from .bars import Series, atr, rolling_mean
from .options import Trade, bid as model_bid
from .portfolio import PathReturns, aggregate, stop_step, with_exposure
from .real_quotes import RealTrade, spread_diagnostics

# Standard weights for alternative LEAPS ladder shapes (sum = 1.0)
WEIGHTS_5 = optiontests.LADDER_WEIGHTS            # (0.10, 0.15, 0.20, 0.25, 0.30)
WEIGHTS_3 = (0.15, 0.30, 0.55)                    # back-loaded 3-rung
WEIGHTS_2 = (0.30, 0.70)                          # wide 2-rung
WEIGHTS_1 = (1.0,)                                # single deep stop
WEIGHTS_PREM_2 = (0.35, 0.65)                     # 2-step premium ladder


class OptionTradeLike(Protocol):
    """Minimal interface shared by model `options.Trade` and real-quote `real_quotes.RealTrade`."""

    u: Any
    expiry: date
    expiry_i: int
    entry_i: int
    exit_i: int
    debit: float

    def mid(self, i: int) -> float: ...


@dataclass(frozen=True)
class AltEntryTrade:
    """Entry + trade + calendar alignment + rf (works for either `Trade` or `RealTrade`)."""

    entry: entries.Entry
    trade: Trade | RealTrade
    k: int
    rf: list[float]


AltRule = Callable[[OptionTradeLike, int, float], list[tuple[float, float | None]]]


def trade_exit_bid(t: Trade | RealTrade, i: int, spot: float | None = None, *,
                   expiry_spread_mult: float = 1.0) -> float:
    """Executable exit bid per share on day `i`, for either model `Trade` or real-quote `RealTrade`."""
    if isinstance(t, RealTrade):
        return t.exit_bid(i, spot, expiry_spread_mult=expiry_spread_mult)
    # Model-priced Trade: support optional expiry-day spread stress on expiry_i.
    if spot is None and i == t.expiry_i and expiry_spread_mult != 1.0:
        q = t.u.quote(t.legs, i, t.expiry, expiry_i=t.expiry_i)
        if not q:
            return 0.0
        return max(0.0, q[0] - q[1] * expiry_spread_mult)
    return model_bid(t, i, spot)


def trade_spread_pct(t: Trade | RealTrade, i: int) -> float | None:
    if isinstance(t, RealTrade):
        return t.spread_pct(i)
    q = t.u.quote(t.legs, i, t.expiry, expiry_i=t.expiry_i)
    if not q or q[0] <= 0:
        return None
    return (2.0 * q[1]) / q[0]


def option_path(
    t: Trade | RealTrade,
    rule: AltRule,
    rf: Sequence[float],
    start: int,
    *,
    expiry_spread_mult: float = 1.0,
) -> PathReturns:
    """Simulate both legs of one option trade (with `rule` vs without `rule`) on model or real quotes."""
    p = PathReturns(start=start)
    units = 1.0 / t.debit
    held, cash = 1.0, 0.0
    prev_w = prev_o = 1.0
    for i in range(t.entry_i + 1, t.exit_i + 1):
        cash *= 1 + rf[i]
        if i < t.exit_i and held > 0:
            for share, spot in rule(t, i, held):
                share = min(share, held)
                if share <= 0:
                    continue
                cash += share * units * trade_exit_bid(t, i, spot)
                held -= share
                p.stop(i - t.entry_i)
        if i == t.exit_i:
            last = trade_exit_bid(t, i, expiry_spread_mult=expiry_spread_mult)
            v_w = cash + held * units * last
            v_o = units * last
        else:
            v_w = cash + held * units * t.mid(i)
            v_o = units * t.mid(i)
        p.add(v_w - prev_w, v_o - prev_o, (cash / v_w if v_w > 0 else 1.0) if i < t.exit_i else 0.0)
        prev_w, prev_o = v_w, v_o
    return p


# --- Head-to-head comparison against the live rule ---------------------------------------------------

def compare_vs_live(cand: premium.Legs, live: premium.Legs, step: int) -> dict:
    """Direct head-to-head comparison of a candidate's `with_rule` leg against the live rule's `with_rule` leg.

    Both legs must be aligned on the same dates (the common overlap is sliced automatically if lengths differ).
    A positive `premiumVsLive` with `intervalVsLive[0] > 0` means the candidate beat the live rule after costs.
    """
    if cand.dates != live.dates:
        live_idx = {d: i for i, d in enumerate(live.dates)}
        common = [(i, live_idx[d]) for i, d in enumerate(cand.dates) if d in live_idx]
        dates = tuple(cand.dates[i] for i, _ in common)
        w = tuple(cand.with_rule[i] for i, _ in common)
        o = tuple(live.with_rule[j] for _, j in common)
        rf = tuple(cand.rf[i] for i, _ in common)
        out = tuple(cand.out[i] for i, _ in common)
    else:
        dates, w, o, rf, out = cand.dates, cand.with_rule, live.with_rule, cand.rf, cand.out

    h2h = premium.Legs(dates, w, o, rf, out, cand.stop_events, cand.stop_days)
    s = premium.summary(h2h, max(1, step))
    sc = premium.summary(cand, max(1, step), interval=(0.0, 0.0))
    sl = premium.summary(live, max(1, step), interval=(0.0, 0.0))
    ic_cand = premium.insurance_cost(sc)
    ic_live = premium.insurance_cost(sl)
    ic_ratio = (ic_cand / ic_live) if (ic_cand is not None and ic_live is not None and ic_live > 0) else None
    return {
        "premiumVsLive": s["premium"],
        "intervalVsLive": list(s["interval"]),
        "halvesVsLive": list(s["halves"]),
        "beatsLive90": s["premium"] > 0 and s["interval"][0] > 0,
        "mddCand": sc["mddWith"],
        "mddLive": sl["mddWith"],
        "mddDiff": abs(sl["mddWith"]) - abs(sc["mddWith"]),  # >0 = candidate has smaller drawdown than live
        "drawdownCutCand": premium.drawdown_cut(sc),
        "drawdownCutLive": premium.drawdown_cut(sl),
        "insuranceCostCand": ic_cand,
        "insuranceCostLive": ic_live,
        "insuranceCostRatio": ic_ratio,
        "stopEventsCand": cand.stop_events,
        "stopEventsLive": live.stop_events,
    }


def _evaluate_with_live(
    name: str,
    data: study.Data,
    main: Sequence[PathReturns],
    low: Sequence[PathReturns] | None,
    high: Sequence[PathReturns] | None,
    *,
    live_legs: premium.Legs | None,
    step: int | None = None,
    note: str = "",
    value_weighted: bool = False,
    exposure: float = 1.0,
    headline: bool = False,
    is_live: bool = False,
) -> tuple[dict, premium.Legs]:
    """Evaluate one variant and attach `vsLive` head-to-head comparison against `live_legs`."""
    full = aggregate(data.calendar, data.rf, main, value_weighted=value_weighted)
    lg = with_exposure(full, exposure) if exposure < 1 else full
    st = step if step is not None else stop_step(main)
    v = study.evaluate(name, data, main, low, high, step=st, note=note,
                       value_weighted=value_weighted, exposure=exposure, headline=headline)
    v["isLive"] = is_live
    if live_legs is not None:
        v["vsLive"] = compare_vs_live(lg, live_legs, st)
    return v, lg


# --- Family A: Share stop alternatives ---------------------------------------------------------------

def no_stop_path(s: Series, lo: int, hi: int, rf: Sequence[float], start: int) -> PathReturns:
    """Buy-and-hold path (`with == without`, 0 stop events) for direct head-to-head vs live share stop."""
    path = PathReturns(start=start)
    for i in range(lo + 1, hi):
        r = s.close[i] / s.close[i - 1] - 1
        path.add(r, r, 0.0)
    return path


def close_ladder_path(s: Series, lo: int, hi: int, rf: Sequence[float], start: int, *,
                      mult: float = 1.0, five: bool = True, scale: float = 1.0) -> PathReturns:
    """Share ladder whose rungs trigger ONLY on daily close <= level (eliminates intraday stop-hunt whipsaws)."""
    a = atr(s.high, s.low, s.close, 14)
    ma50 = rolling_mean(s.close, 50)
    path = PathReturns(start=start)
    units, cash = 1.0 / s.close[lo], 0.0
    rungs: list[shares.Rung] = []
    sold: list[shares.SoldRung] = []
    month = None

    def layout(i: int) -> None:
        nonlocal units, cash, rungs, sold, month
        month = s.dates[i][:7]
        if cash > 0:
            units += cash * (1 - shares.COST) / s.close[i]
            cash = 0.0
        sold = []
        rungs = []
        if a[i] is None:
            return
        plan = shares.ladder(s, i, a[i], ma50[i], mult=mult, five=five, scale=scale)
        if plan:
            rungs = [shares.Rung(lv, units * w) for lv, w in plan]

    layout(lo)
    prev = units * s.close[lo] + cash
    for i in range(lo + 1, hi):
        cash *= 1 + rf[i]
        for r in rungs:
            if not r.sold and s.close[i] <= r.level:
                cash += r.qty * s.close[i] * (1 - shares.COST)
                units -= r.qty
                r.sold = True
                sold.append(shares.SoldRung(r.level, r.qty, s.dates[i]))
                path.stop(i - lo)
        keep = []
        for sr in sold:
            age = (date.fromisoformat(s.dates[i]) - date.fromisoformat(sr.day)).days
            if sr.day != s.dates[i] and age <= shares.RECLAIM_DAYS and s.close[i] >= sr.level * (1 + shares.RECLAIM_PCT / 100):
                qty = min(sr.qty, cash / (s.close[i] * (1 + shares.COST)))
                if qty > 0:
                    cash -= qty * s.close[i] * (1 + shares.COST)
                    units += qty
                    continue
            if age <= shares.RECLAIM_DAYS:
                keep.append(sr)
        sold = keep
        if s.dates[i][:7] != month:
            layout(i)
        value = units * s.close[i] + cash
        path.add(value / prev - 1, s.close[i] / s.close[i - 1] - 1, cash / value if value > 0 else 0.0)
        prev = value
    return path


def trailing_atr_path(
    s: Series,
    lo: int,
    hi: int,
    rf: Sequence[float],
    start: int,
    *,
    atr_mult: float = 3.0,
    reentry_ma: int = 50,
    close_confirmed: bool = True,
) -> PathReturns:
    """Single wide trailing ATR stop (Chandelier style): out when price falls `atr_mult * ATR14` below its
    peak close since entry; re-enters when close reclaims the `reentry_ma`-day SMA (checked at close)."""
    a = atr(s.high, s.low, s.close, 14)
    ma = rolling_mean(s.close, reentry_ma)
    path = PathReturns(start=start)
    inside = True
    peak = s.close[lo]
    for i in range(lo + 1, hi):
        r = s.close[i] / s.close[i - 1] - 1
        rw = r if inside else rf[i]
        a_prev = a[i - 1]
        if inside:
            stop_lv = (peak - atr_mult * a_prev) if a_prev is not None else None
            if stop_lv is not None and (s.close[i] <= stop_lv if close_confirmed else s.low[i] <= stop_lv):
                if close_confirmed:
                    fill = s.close[i]
                else:
                    fill = min(s.open[i], stop_lv)
                rw = (fill / s.close[i - 1]) * (1 - shares.COST) - 1
                inside = False
                path.stop(i - lo)
            else:
                if s.close[i] > peak:
                    peak = s.close[i]
        else:
            if ma[i] is not None and s.close[i] >= ma[i]:
                inside = True
                peak = s.close[i]
                rw = (1 + rw) * (1 - shares.COST) - 1
        path.add(rw, r, 0.0 if inside else 1.0)
    return path


def test_a_alternatives(
    data: study.Data,
    *,
    pit_membership: pit.PitMembership | None = None,
    start: str = "2000-01-03",
    distress_haircut: float = 0.0,
    progress: study.Progress = None,
) -> dict:
    """Family A: Live 5-rung share stop vs No share stop and wider ATR / close-confirmed alternatives."""
    stock_names = {sym: data.names[sym] for sym in data.stocks()}

    def run_all(fn: Callable[[Series, int, int, list[float], int], PathReturns]) -> list[PathReturns]:
        if pit_membership is not None:
            return pit.pit_share_paths(
                stock_names, data.calendar, data.name_rf, data.first_k,
                pit_membership, start, fn, warmup=study.WARMUP, distress_haircut=distress_haircut,
            )
        out = []
        for sym in sorted(stock_names):
            s = stock_names[sym]
            lo = next((i for i, d in enumerate(s.dates) if d >= start and i >= study.WARMUP), None)
            if lo is None or lo + 2 >= len(s.dates):
                continue
            k = data.first_k(s, lo + 1)
            if k is None:
                continue
            out.append(fn(s, lo, len(s.dates), data.name_rf(s), k))
        return out

    # 1. Live baseline anchor (5-rung 1x ATR intraday ladder)
    study._log(progress, "A-alt live 5-rung 1x ATR anchor")
    live_main = run_all(lambda s, lo, hi, rf, k: shares.ladder_path(s, lo, hi, rf, k, mult=1.0, five=True))
    live_lo = run_all(lambda s, lo, hi, rf, k: shares.ladder_path(s, lo, hi, rf, k, mult=1.0, five=True, scale=0.75))
    live_hi = run_all(lambda s, lo, hi, rf, k: shares.ladder_path(s, lo, hi, rf, k, mult=1.0, five=True, scale=1.25))
    live_var, live_legs = _evaluate_with_live(
        "A1: Live 5-rung ladder, 1x ATR (intraday)", data, live_main, live_lo, live_hi,
        live_legs=None, step=21, note="current live rule (anchor)", headline=True, is_live=True,
    )
    live_var["vsLive"] = compare_vs_live(live_legs, live_legs, 21)

    variants = [live_var]

    # 2. A0: No share stop (buy & hold)
    study._log(progress, "A-alt A0 no share stop")
    a0_main = run_all(no_stop_path)
    v0, _ = _evaluate_with_live(
        "A0: No share stop (hold)", data, a0_main, None, None,
        live_legs=live_legs, step=21, note="candidate: remove share stop (vsLive shows gain over live A1)",
        headline=True,
    )
    variants.insert(0, v0)

    # 3. Wider 5-rung ladders & close-confirmed 5-rung ladder
    for label, fn, note in (
        ("A2: Wider 5-rung ladder, 2x ATR (intraday)",
         lambda s, lo, hi, rf, k, sc=1.0: shares.ladder_path(s, lo, hi, rf, k, mult=2.0, five=True, scale=sc),
         "wider ATR floor (2x ATR)"),
        ("A3: Wider 5-rung ladder, 3x ATR (intraday)",
         lambda s, lo, hi, rf, k, sc=1.0: shares.ladder_path(s, lo, hi, rf, k, mult=3.0, five=True, scale=sc),
         "wider ATR floor (3x ATR)"),
        ("A4: Close-confirmed 5-rung ladder, 2x ATR",
         lambda s, lo, hi, rf, k, sc=1.0: close_ladder_path(s, lo, hi, rf, k, mult=2.0, five=True, scale=sc),
         "triggers on daily close only, 2x ATR floor"),
    ):
        study._log(progress, f"A-alt {label}")
        m = run_all(lambda s, lo, hi, rf, k, f=fn: f(s, lo, hi, rf, k, 1.0))
        lo_p = run_all(lambda s, lo, hi, rf, k, f=fn: f(s, lo, hi, rf, k, 0.75))
        hi_p = run_all(lambda s, lo, hi, rf, k, f=fn: f(s, lo, hi, rf, k, 1.25))
        v, _ = _evaluate_with_live(label, data, m, lo_p, hi_p, live_legs=live_legs, step=21, note=note)
        variants.append(v)

    # 4. Single wider trailing ATR stops (3x, 4x, 5x ATR, close-confirmed, 50d SMA reentry)
    for code, mult in (("A5", 3.0), ("A6", 4.0), ("A7", 5.0)):
        label = f"{code}: Trailing {mult:g}x ATR stop (close-confirmed, 50d MA reentry)"
        study._log(progress, f"A-alt {label}")
        m = run_all(lambda s, lo, hi, rf, k, m=mult: trailing_atr_path(s, lo, hi, rf, k, atr_mult=m))
        lo_p = run_all(lambda s, lo, hi, rf, k, m=mult: trailing_atr_path(s, lo, hi, rf, k, atr_mult=m * 0.75))
        hi_p = run_all(lambda s, lo, hi, rf, k, m=mult: trailing_atr_path(s, lo, hi, rf, k, atr_mult=m * 1.25))
        v, _ = _evaluate_with_live(label, data, m, lo_p, hi_p, live_legs=live_legs, step=21,
                                   note=f"threshold check {mult * 0.75:.2f}x / {mult * 1.25:.2f}x ATR")
        variants.append(v)

    # 5. Reference anchors: paper 21d -10% window stop & 10-month trend filter
    study._log(progress, "A-alt reference window stop & 10m MA")
    w_m = run_all(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k, gamma=0.10))
    w_l = run_all(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k, gamma=0.075))
    w_h = run_all(lambda s, lo, hi, rf, k: shares.window_stop_path(s, lo, hi, rf, k, gamma=0.125))
    vw, _ = _evaluate_with_live("A8: Paper 21-day -10% window stop (reference)", data, w_m, w_l, w_h,
                                live_legs=live_legs, step=21, note="Kaminski-Lo (2014) reference rule")
    variants.append(vw)

    ma_m = run_all(lambda s, lo, hi, rf, k: books.ma_rule_path(s, lo, hi, rf, k, months=10))
    ma_l = run_all(lambda s, lo, hi, rf, k: books.ma_rule_path(s, lo, hi, rf, k, months=8))
    ma_h = run_all(lambda s, lo, hi, rf, k: books.ma_rule_path(s, lo, hi, rf, k, months=12))
    vma, _ = _evaluate_with_live("A9: 10-month MA trend filter (reference)", data, ma_m, ma_l, ma_h,
                                 live_legs=live_legs, step=21, note="monthly close vs 10m SMA (8m/12m check)")
    variants.append(vma)

    cov = (pit.coverage_summary(pit_membership, stock_names, data.calendar, start, data.calendar[-1])
           if pit_membership is not None else None)
    if cov is not None:
        uni = (f"PIT survivorship-free S&P 500 ({cov['covered']}/{cov['totalEverConstituents']} ever-constituents "
               f"= {cov['coveragePct']}%; {cov['coveredRemovedStillTrading']} removed-still-trading, "
               f"{cov['coveredDelisted']} delisted, {cov['coveredDistressDelisted']} distress-delisted) from {start}")
        bias = (f"point-in-time membership enforced; {cov['missingCount']} older delisted tickers lack free bars "
                f"(distress haircut={distress_haircut:.0%})")
    else:
        uni = f"{len(stock_names)} stocks (current list, non-PIT) from {start}"
        bias = study.SURVIVOR_NOTE

    return {
        "id": "A-alt",
        "title": "Share stop alternatives (no stop & wider ATR stops vs live 5-rung ladder)",
        "prices": "real",
        "live": False,
        "bias": bias,
        "universe": uni,
        "pitCoverage": cov,
        "variants": variants,
    }


# --- Family B: Cheaper LEAPS ladder variants ---------------------------------------------------------

def flex_ladder_levels(
    und_limit: float,
    stop: float,
    atr14: float | None,
    *,
    n_rungs: int = 5,
    min_atr: float = 1.0,
    stop_scale: float = 1.0,
) -> list[float]:
    """General N-rung underlying ladder (`n_rungs >= 1`), nearest rung first, deepest rung at scaled stop."""
    eff_stop = max(0.01, und_limit - stop_scale * (und_limit - stop))
    cap = und_limit - (min_atr * atr14 if atr14 else 0.0)
    if n_rungs <= 1:
        return [round(max(0.01, min(eff_stop, cap)), 2)]
    # Ensure deepest rung respects the min_atr floor even when min_atr > stop_scale.
    if cap < eff_stop - 1e-9:
        step_atr = 0.25 * atr14 if atr14 else 0.05
        r1 = math.floor(max(0.01, cap) * 100) / 100
        eff_stop = max(0.01, r1 - (n_rungs - 1) * step_atr)
    else:
        d = und_limit - eff_stop
        r1 = math.floor((und_limit - max(min_atr * atr14 if atr14 else 0.0, d / 2)) * 100) / 100
    if r1 <= eff_stop + 0.01:
        return [round(eff_stop, 2)] * n_rungs
    step = (r1 - eff_stop) / (n_rungs - 1)
    return [math.floor((r1 - i * step) * 100 + 1e-9) / 100 for i in range(n_rungs - 1)] + [round(eff_stop, 2)]


def flex_ladder_rule(
    levels: Sequence[float],
    weights: Sequence[float],
    *,
    close_confirmed: bool = False,
    grace_sessions: int = 0,
) -> AltRule:
    """Underlying-level ladder rule supporting arbitrary rung count, weights, close-confirm, and grace period."""
    assert len(levels) == len(weights)
    sold = [False] * len(levels)

    def rule(t: OptionTradeLike, i: int, held: float) -> list[tuple[float, float | None]]:
        if i - t.entry_i <= grace_sessions:
            return []
        out: list[tuple[float, float | None]] = []
        for k, lv in enumerate(levels):
            if sold[k]:
                continue
            hit = (t.u.close[i] <= lv) if close_confirmed else (t.u.low[i] <= lv)
            if hit:
                sold[k] = True
                fill_spot = None if close_confirmed else min(t.u.open[i], lv)
                out.append((weights[k], fill_spot))
        return out

    return rule


def premium_ladder_rule(losses: Sequence[float], weights: Sequence[float]) -> AltRule:
    """Close-confirmed option premium loss stop/ladder (e.g. `losses=(0.35, 0.55), weights=(0.35, 0.65)`)."""
    assert len(losses) == len(weights)
    sold = [False] * len(losses)

    def rule(t: OptionTradeLike, i: int, held: float) -> list[tuple[float, float | None]]:
        if held <= 0 or i >= t.exit_i:
            return []
        cur = t.mid(i)
        out: list[tuple[float, float | None]] = []
        for k, loss in enumerate(losses):
            if not sold[k] and cur <= (1.0 - loss) * t.debit:
                sold[k] = True
                out.append((weights[k], None))
        return out

    return rule


def no_rule() -> AltRule:
    def rule(t: OptionTradeLike, i: int, held: float) -> list[tuple[float, float | None]]:
        return []
    return rule


def _make_ladder_builder(
    *,
    n_rungs: int,
    weights: Sequence[float],
    min_atr: float,
    stop_scale: float,
    close_confirmed: bool,
    grace_sessions: int = 0,
    threshold_scale: float = 1.0,
) -> Callable[[AltEntryTrade], AltRule]:
    def build(et: AltEntryTrade) -> AltRule:
        e, u = et.entry, et.trade.u
        f = u.factor[e.i]
        lim = e.price * f
        raw_stop = e.stop * f
        raw_atr = e.atr * f
        levels = flex_ladder_levels(
            lim, raw_stop, raw_atr * threshold_scale,
            n_rungs=n_rungs, min_atr=min_atr, stop_scale=stop_scale * threshold_scale,
        )
        return flex_ladder_rule(levels, weights, close_confirmed=close_confirmed, grace_sessions=grace_sessions)
    return build


def _alt_paths(trades: Iterable[AltEntryTrade], make_rule: Callable[[AltEntryTrade], AltRule], *,
               expiry_spread_mult: float = 1.0) -> list[PathReturns]:
    return [option_path(et.trade, make_rule(et), et.rf, et.k, expiry_spread_mult=expiry_spread_mult)
            for et in trades]


def test_b_alternatives(
    data: study.Data,
    trades: Sequence[AltEntryTrade],
    *,
    test_id: str = "B-alt",
    title: str = "Cheaper 📅 LEAPS ladder variants vs live 5-rung ladder",
    prices_label: str = "model price",
    universe_label: str = "",
    bias_note: str = "",
    progress: study.Progress = None,
) -> dict:
    """Family B: Compare live 5-rung LEAPS ladder against cheaper structural, timing, and premium-stop variants."""
    if not trades:
        return {"id": test_id, "title": title, "prices": prices_label, "live": False,
                "bias": bias_note, "universe": universe_label, "variants": []}

    # 1. Live baseline anchor (5-rung intraday ladder, 1x ATR, 10/15/20/25/30%)
    study._log(progress, f"{test_id} live 5-rung intraday anchor ({len(trades)} trades)")
    live_kw = dict(n_rungs=5, weights=WEIGHTS_5, min_atr=1.0, stop_scale=1.0, close_confirmed=False)
    live_m = _alt_paths(trades, _make_ladder_builder(**live_kw, threshold_scale=1.0))
    live_l = _alt_paths(trades, _make_ladder_builder(**live_kw, threshold_scale=0.75))
    live_h = _alt_paths(trades, _make_ladder_builder(**live_kw, threshold_scale=1.25))
    live_var, live_legs = _evaluate_with_live(
        "B1: Live 5-rung intraday ladder (1x ATR, 10/15/20/25/30%)", data, live_m, live_l, live_h,
        live_legs=None, note=f"{len(trades)} trades; current live rule (anchor)",
        headline=True, is_live=True, **study.OPTION_BOOK,
    )
    live_var["vsLive"] = compare_vs_live(live_legs, live_legs, stop_step(live_m))

    variants: list[dict] = []

    # 2. B0: No LEAPS ladder (time exit T-2 only)
    study._log(progress, f"{test_id} B0 no ladder")
    b0_m = _alt_paths(trades, lambda _et: no_rule())
    v0, _ = _evaluate_with_live(
        "B0: No LEAPS ladder (time exit T-2 only)", data, b0_m, None, None,
        live_legs=live_legs, note=f"{len(trades)} trades; zero-cost reference (vsLive = gain over live ladder)",
        headline=True, **study.OPTION_BOOK,
    )
    variants.append(v0)
    variants.append(live_var)

    # 3. Underlying-based cheaper ladder candidates (B2..B8)
    ladder_specs = [
        ("B2: Close-confirmed 5-rung ladder (1x ATR, 10/15/20/25/30%)",
         dict(n_rungs=5, weights=WEIGHTS_5, min_atr=1.0, stop_scale=1.0, close_confirmed=True),
         "same levels as live, triggers on daily close only (eliminates intraday whipsaws)"),
        ("B3: Wider 5-rung intraday ladder (2x ATR, 1.5x stop)",
         dict(n_rungs=5, weights=WEIGHTS_5, min_atr=2.0, stop_scale=1.5, close_confirmed=False),
         "wider ATR floor & 1.5x stop distance, intraday low"),
        ("B4: Wider 5-rung close-confirmed ladder (2x ATR, 1.5x stop)",
         dict(n_rungs=5, weights=WEIGHTS_5, min_atr=2.0, stop_scale=1.5, close_confirmed=True),
         "wider ATR floor & 1.5x stop distance, daily close only"),
        ("B5: Back-loaded 3-rung close ladder (1.5x ATR, 15/30/55%)",
         dict(n_rungs=3, weights=WEIGHTS_3, min_atr=1.5, stop_scale=1.25, close_confirmed=True),
         "fewer exits, back-loaded weights, close-confirmed"),
        ("B6: Wide 2-rung close ladder (2x ATR, 30/70%)",
         dict(n_rungs=2, weights=WEIGHTS_2, min_atr=2.0, stop_scale=1.5, close_confirmed=True),
         "only two exits: 30% initial trim, 70% deep stop"),
        ("B7: Single deep close stop (3x ATR / 2x stop, 100%)",
         dict(n_rungs=1, weights=WEIGHTS_1, min_atr=3.0, stop_scale=2.0, close_confirmed=True),
         "no partial exits; single deep tail stop"),
        ("B8: Grace-period 5-rung close ladder (10-session grace, 1x ATR)",
         dict(n_rungs=5, weights=WEIGHTS_5, min_atr=1.0, stop_scale=1.0, close_confirmed=True, grace_sessions=10),
         "ladder inactive for first 10 sessions after entry"),
    ]
    for label, kw, note in ladder_specs:
        study._log(progress, f"{test_id} {label}")
        m = _alt_paths(trades, _make_ladder_builder(**kw, threshold_scale=1.0))
        lo_p = _alt_paths(trades, _make_ladder_builder(**kw, threshold_scale=0.75))
        hi_p = _alt_paths(trades, _make_ladder_builder(**kw, threshold_scale=1.25))
        v, _ = _evaluate_with_live(label, data, m, lo_p, hi_p, live_legs=live_legs,
                                   note=f"{len(trades)} trades; {note}", **study.OPTION_BOOK)
        variants.append(v)

    # 4. Option-premium-based stops/ladders (B9..B11)
    prem_specs = [
        ("B9: Single 40% premium loss stop (close-confirmed)", (0.40,), WEIGHTS_1,
         "close 100% if option mid <= 60% of entry debit (threshold 30%/50%)"),
        ("B10: Single 50% premium loss stop (close-confirmed)", (0.50,), WEIGHTS_1,
         "close 100% if option mid <= 50% of entry debit (threshold 37.5%/62.5%)"),
        ("B11: 2-step premium ladder (35%/55% loss, 35/65% weights)", (0.35, 0.55), WEIGHTS_PREM_2,
         "staged premium stop at -35% and -55% of entry debit"),
    ]
    for label, losses, wts, note in prem_specs:
        study._log(progress, f"{test_id} {label}")
        m = _alt_paths(trades, lambda _et, ls=losses, w=wts: premium_ladder_rule(ls, w))
        lo_p = _alt_paths(trades, lambda _et, ls=losses, w=wts: premium_ladder_rule(tuple(x * 0.75 for x in ls), w))
        hi_p = _alt_paths(trades, lambda _et, ls=losses, w=wts: premium_ladder_rule(tuple(min(0.95, x * 1.25) for x in ls), w))
        v, _ = _evaluate_with_live(label, data, m, lo_p, hi_p, live_legs=live_legs,
                                   note=f"{len(trades)} trades; {note}", **study.OPTION_BOOK)
        variants.append(v)

    real_trades = [et.trade for et in trades if isinstance(et.trade, RealTrade)]
    return {
        "id": test_id,
        "title": title,
        "prices": prices_label,
        "live": False,
        "bias": bias_note,
        "universe": universe_label,
        "spreadDiagnostics": spread_diagnostics(real_trades) if real_trades else None,
        "variants": variants,
    }


# --- Family C: Pre-expiry loss close alternatives ----------------------------------------------------

def deep_loser_close_rule(sessions_before: int, min_loss: float) -> AltRule:
    """Close at `T - sessions_before` ONLY if the option mid is down at least `min_loss` from entry debit."""
    def rule(t: OptionTradeLike, i: int, held: float) -> list[tuple[float, float | None]]:
        if held > 0 and i == t.expiry_i - sessions_before and t.mid(i) <= (1.0 - min_loss) * t.debit:
            return [(held, None)]
        return []
    return rule


def salvage_loser_close_rule(sessions_before: int, *, min_bid: float = 0.10,
                             max_spread_pct: float = 0.25) -> AltRule:
    """Close a losing option at `T - sessions_before` ONLY if salvage bid >= `min_bid` and spread <= `max_spread_pct`."""
    def rule(t: OptionTradeLike, i: int, held: float) -> list[tuple[float, float | None]]:
        if held <= 0 or i != t.expiry_i - sessions_before or t.mid(i) >= t.debit:
            return []
        b = trade_exit_bid(t, i)  # type: ignore[arg-type]
        sp = trade_spread_pct(t, i)  # type: ignore[arg-type]
        if b >= min_bid and (sp is None or sp <= max_spread_pct):
            return [(held, None)]
        return []
    return rule


def loser_recovery_stats(trades: Sequence[AltEntryTrade], sessions_before: int = 3) -> dict:
    """Diagnostic decomposition of options that are losing at T-N: how often holding to 15:45 expiry wins."""
    eligible = 0
    losers = 0
    recovered_to_profit = 0
    finished_above_t_bid = 0
    expired_worthless = 0
    sum_t_ratio = 0.0
    sum_exp_ratio = 0.0
    for et in trades:
        t = et.trade
        chk = t.expiry_i - sessions_before
        if chk <= t.entry_i or chk >= t.exit_i:
            continue
        eligible += 1
        if t.mid(chk) < t.debit:
            losers += 1
            b_early = trade_exit_bid(t, chk)
            b_exp = trade_exit_bid(t, t.exit_i)
            sum_t_ratio += b_early / t.debit
            sum_exp_ratio += b_exp / t.debit
            if b_exp >= t.debit:
                recovered_to_profit += 1
            if b_exp > b_early:
                finished_above_t_bid += 1
            if b_exp <= 0.0:
                expired_worthless += 1
    return {
        "sessionsBefore": sessions_before,
        "eligibleTrades": eligible,
        "losersAtCheck": losers,
        "loserShare": losers / eligible if eligible else 0.0,
        "recoveredToProfit": recovered_to_profit,
        "recoveredToProfitShare": recovered_to_profit / losers if losers else 0.0,
        "finishedAboveEarlyBid": finished_above_t_bid,
        "finishedAboveEarlyBidShare": finished_above_t_bid / losers if losers else 0.0,
        "expiredWorthless": expired_worthless,
        "meanEarlyBidOfDebit": (sum_t_ratio / losers) if losers > 0 else 0.0,
        "meanExpiryPayoutOfDebit": (sum_exp_ratio / losers) if losers > 0 else 0.0,
        "holdMinusEarlyOfDebit": ((sum_exp_ratio - sum_t_ratio) / losers) if losers > 0 else 0.0,
    }


def test_c_alternatives(
    data: study.Data,
    trade_groups: Sequence[tuple[str, Sequence[AltEntryTrade]]],
    *,
    test_id: str = "C-alt",
    title: str = "Hold losing options to 15:45 expiry close & pre-expiry alternatives vs live T-3 close",
    prices_label: str = "model price",
    universe_label: str = "",
    bias_note: str = "",
    progress: study.Progress = None,
) -> dict:
    """Family C: Evaluate holding losers to 15:45 expiry-day close (T-0) and filtered pre-expiry alternatives."""
    variants: list[dict] = []
    recovery_by_struct: dict[str, dict] = {}
    spread_by_struct: dict[str, dict] = {}

    for structure, trades in trade_groups:
        if not trades:
            continue
        study._log(progress, f"{test_id} {structure} ({len(trades)} trades)")
        recovery_by_struct[structure] = loser_recovery_stats(trades, sessions_before=3)
        real_tr = [et.trade for et in trades if isinstance(et.trade, RealTrade)]
        if real_tr:
            spread_by_struct[structure] = spread_diagnostics(real_tr)

        # 1. Live T-3 loser close anchor (with T-2 / T-4 threshold check)
        live_m = _alt_paths(trades, lambda _et: optiontests.loser_close_rule(3))
        live_l = _alt_paths(trades, lambda _et: optiontests.loser_close_rule(2))
        live_h = _alt_paths(trades, lambda _et: optiontests.loser_close_rule(4))
        live_var, live_legs = _evaluate_with_live(
            f"{structure} — C1: Live T-3 loser close", data, live_m, live_l, live_h,
            live_legs=None, note=f"{len(trades)} trades; current live rule (T-2/T-4 check)",
            headline=True, is_live=True, **study.OPTION_BOOK,
        )
        live_var["vsLive"] = compare_vs_live(live_legs, live_legs, stop_step(live_m))

        # 2. C0: Hold losing options to 15:45 expiry-day close (T-0) — primary candidate!
        c0_m = _alt_paths(trades, lambda _et: no_rule())
        v0, _ = _evaluate_with_live(
            f"{structure} — C0: Hold losers to 15:45 expiry close (T-0)", data, c0_m, None, None,
            live_legs=live_legs,
            note=f"{len(trades)} trades; primary candidate (vsLive = gain of holding to T-0 vs live T-3)",
            headline=True, **study.OPTION_BOOK,
        )
        # 2b. C0s: 2x expiry-day closing spread stress test (apples-to-apples vs live T-3 ALSO at 2x expiry spread)
        live_stress_m = _alt_paths(trades, lambda _et: optiontests.loser_close_rule(3), expiry_spread_mult=2.0)
        live_stress_full = aggregate(data.calendar, data.rf, live_stress_m, value_weighted=True)
        live_stress_legs = with_exposure(live_stress_full, study.PREMIUM_BUCKET)
        c0_stress = _alt_paths(trades, lambda _et: no_rule(), expiry_spread_mult=2.0)
        v0s, _ = _evaluate_with_live(
            f"{structure} — C0s: Hold to 15:45 close (2x expiry spread stress)", data, c0_stress, None, None,
            live_legs=live_stress_legs,
            note=f"{len(trades)} trades; apples-to-apples 2x ITM expiry spread on both C0 and live T-3 winners",
            **study.OPTION_BOOK,
        )
        variants.extend([v0, live_var, v0s])

        # 3. C2: T-1 loser close (1 session before expiry)
        c2_m = _alt_paths(trades, lambda _et: optiontests.loser_close_rule(1))
        v2, _ = _evaluate_with_live(
            f"{structure} — C2: T-1 loser close (1 session before expiry)", data, c2_m, None, None,
            live_legs=live_legs, note=f"{len(trades)} trades; comparison row (avoids 0DTE pin/gamma)",
            **study.OPTION_BOOK,
        )
        variants.append(v2)

        # 4. C3 / C4: Deep-loser-only close at T-3 (>=50% and >=75% loss)
        for code, loss in (("C3", 0.50), ("C4", 0.75)):
            m = _alt_paths(trades, lambda _et, lv=loss: deep_loser_close_rule(3, lv))
            lo_p = _alt_paths(trades, lambda _et, lv=loss: deep_loser_close_rule(3, lv * 0.75))
            hi_p = _alt_paths(trades, lambda _et, lv=loss: deep_loser_close_rule(3, min(0.95, lv * 1.25)))
            vc, _ = _evaluate_with_live(
                f"{structure} — {code}: Deep-loser close at T-3 (loss >= {loss:.0%})", data, m, lo_p, hi_p,
                live_legs=live_legs,
                note=f"{len(trades)} trades; threshold check {loss * 0.75:.1%} / {min(0.95, loss * 1.25):.1%}",
                **study.OPTION_BOOK,
            )
            variants.append(vc)

        # 5. C5: Salvage-filtered T-3 loser close (bid >= $0.10 and spread <= 25%)
        c5_m = _alt_paths(trades, lambda _et: salvage_loser_close_rule(3, min_bid=0.10, max_spread_pct=0.25))
        c5_l = _alt_paths(trades, lambda _et: salvage_loser_close_rule(3, min_bid=0.075, max_spread_pct=0.3125))
        c5_h = _alt_paths(trades, lambda _et: salvage_loser_close_rule(3, min_bid=0.125, max_spread_pct=0.1875))
        v5, _ = _evaluate_with_live(
            f"{structure} — C5: Salvage-filtered T-3 close (bid >= $0.10, spread <= 25%)",
            data, c5_m, c5_l, c5_h, live_legs=live_legs,
            note=f"{len(trades)} trades; avoids paying wide spreads on near-worthless losers",
            **study.OPTION_BOOK,
        )
        variants.append(v5)

    return {
        "id": test_id,
        "title": title,
        "prices": prices_label,
        "live": False,
        "bias": bias_note,
        "universe": universe_label,
        "recoveryStats": recovery_by_struct,
        "spreadDiagnostics": spread_by_struct or None,
        "variants": variants,
    }
