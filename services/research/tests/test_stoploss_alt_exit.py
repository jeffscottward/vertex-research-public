"""Tests for the alternative exit-rule dry-run study (card stoploss-alt-exit-dryrun).

Covers:
  * pit.py: PIT CSV loading, symbol normalization, active_on, membership_spans (additions, removals, re-entries),
    delisting & distress-delisting detection, terminal haircut math, PIT coverage summary, PIT share paths,
    and PIT entry filtering.
  * real_quotes.py: quote validation (crossed/negative/non-finite rejection), CSV loader, expiry/delta selection,
    RealTrade construction, exact ask/bid entry debit, OTM $0 expiry with $0 commission, ITM expiry close with
    real bid & 2x spread stress, intraday delta-adjusted fills, carried missing-day cap, spread diagnostics.
  * alternatives.py: head-to-head vs-live comparison math, Family A share alternatives (no stop, close-confirmed
    ladder, trailing ATR stop, full test_a_alternatives both PIT and non-PIT), Family B cheaper LEAPS variants
    (flex ladder, close-confirmed, grace period, premium ladder, full test_b_alternatives on both model and real
    quotes), Family C pre-expiry loss close alternatives (hold to 15:45 expiry close, 2x spread stress, T-1,
    deep loser, salvage filter, loser_recovery_stats, full test_c_alternatives on both model and real quotes).
"""
from __future__ import annotations

import csv
from datetime import date, timedelta
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from strategies.stoploss_premium import (  # noqa: E402
    alternatives,
    bars,
    entries,
    options,
    pit,
    portfolio,
    premium,
    real_quotes,
    study,
)


def _business_dates(start: date, count: int) -> tuple[str, ...]:
    out = []
    cur = start
    while len(out) < count:
        if cur.weekday() < 5:
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return tuple(out)


def _series(symbol: str, closes: list[float], *, start: date = date(2020, 1, 2),
            low_mult: float = 0.99, high_mult: float = 1.01, div_scale: float = 1.0) -> bars.Series:
    dates = _business_dates(start, len(closes))
    o = tuple(closes)
    h = tuple(c * high_mult for c in closes)
    lo = tuple(c * low_mult for c in closes)
    c = tuple(closes)
    raw = tuple(x * div_scale for x in closes)
    return bars.Series(symbol, dates, o, h, lo, c, raw)


# --- PIT universe tests ------------------------------------------------------------------------------

def test_pit_load_and_membership_spans(tmp_path: Path) -> None:
    p = tmp_path / "sp500.csv"
    p.write_text(
        'date,tickers\n'
        '2020-01-02,"AAPL,BRK.B,DEAD"\n'
        '2020-01-10,"AAPL,BRK.B,NEWCO"\n'
        '2020-01-20,"AAPL,BRK.B,DEAD,NEWCO"\n',
        encoding="utf-8",
    )
    pm = pit.load_pit_csv(p)
    assert pm.is_member("BRK-B", "2020-01-03")
    assert pm.is_member("DEAD", "2020-01-09")
    assert not pm.is_member("DEAD", "2020-01-10")
    assert pm.is_member("DEAD", "2020-01-22")
    assert pm.ever_members("2020-01-02", "2020-01-15") == frozenset({"AAPL", "BRK-B", "DEAD", "NEWCO"})

    dates = _business_dates(date(2020, 1, 2), 20)
    spans = pm.membership_spans("DEAD", dates, "2020-01-02", warmup=0)
    # Two spans: [0, exit_on_2020-01-10_idx+1) and [re_entry_on_2020-01-20, 20)
    assert len(spans) == 2
    assert dates[spans[0][0]] == "2020-01-02"
    assert dates[spans[0][1] - 1] == "2020-01-10"
    assert dates[spans[1][0]] == "2020-01-20"
    assert spans[1][1] == len(dates)


def test_pit_delisting_distress_and_terminal_haircut() -> None:
    cal = _business_dates(date(2020, 1, 2), 100)
    # Distress delisted: crashes from 100 to 2 and ends at bar 50
    crash = _series("SIVB", [100.0] * 40 + [80.0, 60.0, 40.0, 20.0, 10.0, 5.0, 3.0, 2.0, 1.5, 1.0])
    # Acquired at premium: rises from 100 to 130 and ends at bar 50
    acq = _series("ATVI", [100.0 + 0.6 * i for i in range(50)])
    # Surviving: full 100 bars
    alive = _series("AAPL", [100.0 + i for i in range(100)])

    assert pit.is_delisted(crash, cal)
    assert pit.is_distress_delisted(crash, cal)
    assert pit.is_delisted(acq, cal)
    assert not pit.is_distress_delisted(acq, cal)
    assert not pit.is_delisted(alive, cal)

    # Terminal haircut affects only the invested portion of with_rule and 100% of without
    p = portfolio.PathReturns(start=1, with_rule=[0.0, 0.0], without=[0.0, 0.0], out=[0.0, 0.6])
    hp = pit.apply_terminal_haircut(p, 0.5)
    assert hp.without[-1] == pytest.approx(-0.5)
    # with_rule had 40% invested (out=0.6), so haircut impact is 0.4 * 0.5 = -0.20
    assert hp.with_rule[-1] == pytest.approx(-0.2)


def test_pit_coverage_summary_and_pit_share_paths(tmp_path: Path) -> None:
    cal = _business_dates(date(2020, 1, 2), 40)
    p_csv = tmp_path / "pit.csv"
    p_csv.write_text(
        f'date,tickers\n'
        f'{cal[0]},"ALIVE,REMOVED,DELIST,MISSING"\n'
        f'{cal[20]},"ALIVE"\n',
        encoding="utf-8",
    )
    pm = pit.load_pit_csv(p_csv)
    names = {
        "ALIVE": _series("ALIVE", [100.0 + i * 0.5 for i in range(40)]),
        "REMOVED": _series("REMOVED", [100.0 - i * 0.5 for i in range(40)]),
        "DELIST": _series("DELIST", [100.0 - i * 4.0 for i in range(24)]),
    }
    cov = pit.coverage_summary(pm, names, cal, cal[0], cal[-1])
    assert cov["totalEverConstituents"] == 4
    assert cov["covered"] == 3
    assert cov["coveredCurrent"] == 1
    assert cov["coveredRemovedStillTrading"] == 1
    assert cov["coveredDelisted"] == 1
    assert cov["coveredDistressDelisted"] == 1
    assert cov["missingCount"] == 1

    cal_idx = {d: i for i, d in enumerate(cal)}
    paths = pit.pit_share_paths(
        names, cal,
        lambda s: [0.0] * len(s.dates),
        lambda s, i: cal_idx.get(s.dates[i]),
        pm, cal[0],
        alternatives.no_stop_path,
        warmup=0,
    )
    # All 3 covered names produced spans; REMOVED & DELIST stopped at cal[20]
    assert len(paths) == 3
    assert sorted(len(x) for x in paths) == [20, 20, 39]


# --- Real option quotes tests ------------------------------------------------------------------------

def _write_sample_quotes_csv(path: Path, dates: tuple[str, ...], exp: str,
                             rows_by_day: dict[str, list[tuple[float, float, float, float]]]) -> None:
    """Write `(strike, bid, ask, delta)` call quotes per day to CSV."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "symbol", "expiration", "strike", "type", "bid", "ask", "mark", "implied_volatility", "delta"])
        for d in dates:
            for strike, bid, ask, delta in rows_by_day.get(d, []):
                w.writerow([d, "SPY", exp, strike, "call", bid, ask, round((bid + ask) / 2, 4), 0.20, delta])


def test_real_quotes_validation_rejects_crossed_and_negative(tmp_path: Path) -> None:
    p = tmp_path / "q.csv"
    p.write_text(
        "date,symbol,expiration,strike,type,bid,ask,mark,implied_volatility,delta\n"
        "2024-01-02,SPY,2024-02-16,470,call,10.0,10.2,10.1,0.18,0.52\n"
        "2024-01-02,SPY,2024-02-16,475,call,8.0,7.5,7.75,0.18,0.45\n"     # crossed
        "2024-01-02,SPY,2024-02-16,480,call,-1.0,2.0,0.5,0.18,0.30\n"     # negative bid
        "2024-01-02,SPY,2024-02-16,485,call,2.0,2.2,2.1,0.18,0.28\n"      # valid
        "2024-01-02,QQQ,2024-02-16,400,call,5.0,5.2,5.1,0.22,0.50\n",     # other symbol
        encoding="utf-8",
    )
    book = real_quotes.load_quotes_csv(p, "SPY")
    assert book.stats["loaded"] == 2
    assert book.stats["skipped_crossed"] == 1
    assert book.stats["skipped_invalid"] == 1
    q = book.select_by_delta("2024-01-02", "2024-02-16", "call", 0.50)
    assert q is not None and q.strike == 470.0


def test_real_trade_otm_zero_commission_and_itm_spread_stress(tmp_path: Path) -> None:
    # 6 trading days ending on Friday 2024-01-19 (expiry)
    dates = ("2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19")
    exp = "2024-01-19"
    # Spot ends at 475: strike 470 is ITM ($5 intrinsic), strike 485 is OTM ($0)
    s = bars.Series("SPY", dates, (472, 471, 469, 470, 472, 475), (474, 473, 471, 472, 474, 476),
                    (470, 469, 468, 469, 471, 474), (472, 471, 469, 470, 472, 475),
                    (472, 471, 469, 470, 472, 475))
    u = real_quotes.RealUnderlying(s)
    rows = {
        "2024-01-11": [(470, 5.0, 5.2, 0.55), (485, 1.0, 1.2, 0.20)],
        "2024-01-12": [(470, 4.4, 4.6, 0.52), (485, 0.7, 0.9, 0.15)],
        "2024-01-16": [(470, 3.0, 3.2, 0.45), (485, 0.3, 0.4, 0.10)],  # T-3 loser for both
        "2024-01-17": [(470, 3.5, 3.7, 0.48), (485, 0.2, 0.3, 0.08)],
        "2024-01-18": [(470, 4.2, 4.4, 0.58), (485, 0.05, 0.10, 0.03)],
        "2024-01-19": [(470, 4.8, 5.2, 1.00), (485, 0.0, 0.05, 0.00)],  # expiry day quotes!
    }
    p = tmp_path / "spy.csv"
    _write_sample_quotes_csv(p, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p, "SPY")

    itm_tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 470.0, 1),), 0, exp)
    otm_tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 485.0, 1),), 0, exp)
    assert itm_tr is not None and otm_tr is not None
    # Entry debit = ask + LEG_COMMISSION
    assert itm_tr.debit == pytest.approx(5.2 + options.LEG_COMMISSION)
    # Expiry OTM pays $0 with $0 closing commission
    assert otm_tr.exit_bid(otm_tr.expiry_i) == 0.0
    # Expiry ITM pays real bid - LEG_COMMISSION; 2x spread stress doubles half-spread from mid
    b1 = itm_tr.exit_bid(itm_tr.expiry_i, expiry_spread_mult=1.0)
    b2 = itm_tr.exit_bid(itm_tr.expiry_i, expiry_spread_mult=2.0)
    assert b1 == pytest.approx(4.8 - options.LEG_COMMISSION)
    assert b2 < b1

    # Intraday delta-adjusted fill moves lower when intraday low < close
    b_eod = itm_tr.exit_bid(2)
    b_intra = itm_tr.exit_bid(2, spot=465.0)
    assert b_intra < b_eod

    diag = real_quotes.spread_diagnostics([itm_tr, otm_tr])
    assert diag["trades"] == 2
    assert diag["realExpiryQuoteShare"] == pytest.approx(1.0)


# --- Alternative rules & head-to-head tests ----------------------------------------------------------

def test_close_ladder_ignores_intraday_wick_unlike_intraday_ladder() -> None:
    # Build 300 calm days then one huge intraday spike-low wick that recovers by close
    closes = [100.0 + 0.05 * i for i in range(300)]
    s = _series("WICK", closes, low_mult=0.995, high_mult=1.005)
    # Inject a 12% intraday flash-crash wick on day 275 while close stays flat
    lows = list(s.low)
    lows[275] = s.close[275] * 0.85
    s_wick = bars.Series(s.symbol, s.dates, s.open, s.high, tuple(lows), s.close, s.raw_close)
    rf = [0.0] * len(s_wick.dates)

    p_intra = alternatives.shares.ladder_path(s_wick, 260, len(s_wick.dates), rf, 261, mult=1.0, five=True)
    p_close = alternatives.close_ladder_path(s_wick, 260, len(s_wick.dates), rf, 261, mult=1.0, five=True)
    assert p_intra.stop_events > 0
    assert p_close.stop_events == 0


def test_trailing_atr_stop_exits_on_crash_and_reenters_above_ma() -> None:
    # 70 flat bars at 100, then drop to 70 for 20 bars, then recover to 110 for 60 bars
    closes = [100.0] * 70 + [100.0 - 2.0 * i for i in range(1, 16)] + [70.0] * 15 + [70.0 + 1.5 * i for i in range(1, 35)]
    s = _series("TRL", closes, low_mult=0.99, high_mult=1.01)
    rf = [0.0] * len(s.dates)
    p = alternatives.trailing_atr_path(s, 55, len(s.dates), rf, 56, atr_mult=3.0, reentry_ma=20)
    assert p.stop_events >= 1
    assert any(x == 1.0 for x in p.out)      # spent time out of market during crash
    assert p.out[-1] == 0.0                  # re-entered on recovery above 20d MA


def test_flex_ladder_and_grace_period_and_premium_ladder(tmp_path: Path) -> None:
    dates = _business_dates(date(2024, 1, 2), 25)
    exp = dates[-1]
    # Sharp dip on day 2 (inside 5-session grace), recovers above 97 before day 6, then rallies
    closes = [100.0, 96.0, 90.0, 95.0, 97.5, 98.5] + [99.0 + 0.8 * i for i in range(19)]
    s = bars.Series("SPY", dates, tuple(closes), tuple(c * 1.01 for c in closes),
                    tuple(c * 0.99 for c in closes), tuple(closes), tuple(closes))
    u = real_quotes.RealUnderlying(s)
    # Option mid tracks intrinsic + time value: dips -40% on day 2, recovers to +50%
    rows = {}
    for idx, d in enumerate(dates):
        mid = max(1.0, 10.0 + 0.65 * (closes[idx] - 100.0))
        rows[d] = [(95.0, round(mid - 0.1, 2), round(mid + 0.1, 2), 0.70)]
    p_csv = tmp_path / "leaps.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 95.0, 1),), 0, exp, last_chance=2)
    assert tr is not None
    rf = [0.0] * len(dates)

    levels = alternatives.flex_ladder_levels(100.0, 92.0, 2.0, n_rungs=3, min_atr=1.5, stop_scale=1.0)
    assert len(levels) == 3 and levels[0] > levels[-1] == 92.0

    # Without grace period, day 2 (close 90 <= 92) triggers all 3 rungs
    p_nograce = alternatives.option_path(
        tr, alternatives.flex_ladder_rule(levels, alternatives.WEIGHTS_3, close_confirmed=True, grace_sessions=0), rf, 1
    )
    # With 5-session grace period, day 2 dip is ignored -> 0 stops and higher final value
    p_grace = alternatives.option_path(
        tr, alternatives.flex_ladder_rule(levels, alternatives.WEIGHTS_3, close_confirmed=True, grace_sessions=5), rf, 1
    )
    assert p_nograce.stop_events == 3
    assert p_grace.stop_events == 0
    assert sum(p_grace.with_rule) > sum(p_nograce.with_rule)

    # Premium ladder (35%/55% loss): day 2 mid is ~3.5 vs debit 10.11 -> -65% -> triggers both rungs
    p_prem = alternatives.option_path(
        tr, alternatives.premium_ladder_rule((0.35, 0.55), alternatives.WEIGHTS_PREM_2), rf, 1
    )
    assert p_prem.stop_events == 2


def test_loser_recovery_stats_and_deep_loser_rule(tmp_path: Path) -> None:
    dates = ("2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19")
    exp = "2024-01-19"
    # Spot rebounds strongly after T-3 (2024-01-16): 470C is a T-3 loser (-30%) that recovers to profit (+25%)
    s = bars.Series("SPY", dates, (472, 471, 469, 472, 475, 477), (474, 473, 471, 474, 477, 479),
                    (470, 469, 468, 470, 473, 476), (472, 471, 469, 472, 475, 477),
                    (472, 471, 469, 472, 475, 477))
    u = real_quotes.RealUnderlying(s)
    rows = {
        "2024-01-11": [(470, 5.0, 5.2, 0.55)],
        "2024-01-12": [(470, 4.4, 4.6, 0.52)],
        "2024-01-16": [(470, 3.5, 3.7, 0.45)],  # T-3: mid 3.6 vs debit ~5.21 (-31% loss)
        "2024-01-17": [(470, 4.8, 5.0, 0.58)],
        "2024-01-18": [(470, 6.0, 6.2, 0.75)],
        "2024-01-19": [(470, 6.8, 7.2, 1.00)],  # T-0: bid 6.8 > debit 5.21 -> recovered to profit!
    }
    p_csv = tmp_path / "rec.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 470.0, 1),), 0, exp)
    assert tr is not None
    et = alternatives.AltEntryTrade(
        entries.Entry("SPY", 0, "acceptance", 472.0, 468.0, 2.0), tr, 1, [0.0] * len(dates)
    )
    stats = alternatives.loser_recovery_stats([et], sessions_before=3)
    assert stats["losersAtCheck"] == 1
    assert stats["recoveredToProfit"] == 1
    assert stats["finishedAboveEarlyBid"] == 1
    assert stats["holdMinusEarlyOfDebit"] > 0

    # Deep loser (>= 50% loss) does NOT trigger on this -31% loser, whereas live T-3 DOES trigger
    p_live = alternatives.option_path(tr, alternatives.optiontests.loser_close_rule(3), [0.0] * len(dates), 1)
    p_deep = alternatives.option_path(tr, alternatives.deep_loser_close_rule(3, 0.50), [0.0] * len(dates), 1)
    assert p_live.stop_events == 1
    assert p_deep.stop_events == 0
    assert sum(p_deep.with_rule) > sum(p_live.with_rule)


def test_compare_vs_live_and_end_to_end_mini_study(tmp_path: Path) -> None:
    # Build synthetic 320-day mini-universe (SPY + 2 stocks) and run A-alt, B-alt, C-alt end-to-end
    n = 320
    dates = _business_dates(date(2020, 1, 2), n)
    spy_c = [100.0 * (1.0005 ** i) * (1.0 + 0.03 * ((i % 15) - 7) / 7) for i in range(n)]
    stk_c = [50.0 * (1.0006 ** i) * (1.0 + 0.05 * ((i % 13) - 6) / 6) for i in range(n)]
    spy = bars.Series("SPY", dates, tuple(spy_c), tuple(x * 1.015 for x in spy_c),
                      tuple(x * 0.985 for x in spy_c), tuple(spy_c), tuple(spy_c))
    aaa = bars.Series("AAA", dates, tuple(stk_c), tuple(x * 1.02 for x in stk_c),
                      tuple(x * 0.98 for x in stk_c), tuple(stk_c), tuple(stk_c))
    data = study.Data(
        calendar=list(dates),
        rf=[0.0001] * n,
        names={"SPY": spy, "AAA": aaa},
        indexes={"VIX": {d: 18.0 for d in dates}},
    )

    # Family A (non-PIT and PIT)
    res_a = alternatives.test_a_alternatives(data, start=dates[260])
    assert res_a["id"] == "A-alt"
    names_a = [v["name"] for v in res_a["variants"]]
    assert any("A0: No share stop" in x for x in names_a)
    assert any("A1: Live 5-rung" in x for x in names_a)
    assert any("A5: Trailing 3x ATR" in x for x in names_a)
    assert all("vsLive" in v for v in res_a["variants"])

    # Family B & C on model trades (fast smoke test verifying all variants and vsLive fields)
    u = data.underlying("AAA")
    rf = data.name_rf(u.s)
    ent = entries.Entry("AAA", 265, "acceptance", u.s.close[265], u.s.close[265] - 2.0, 1.0)
    tr_c = study.make_call45(u, ent)
    assert tr_c is not None
    et_c = alternatives.AltEntryTrade(ent, tr_c, 266, rf)

    res_b = alternatives.test_b_alternatives(data, [et_c], universe_label="mini")
    assert len(res_b["variants"]) == 12  # B0..B11
    assert all("vsLive" in v for v in res_b["variants"])

    res_c = alternatives.test_c_alternatives(data, [("45-day call", [et_c])], universe_label="mini")
    assert len(res_c["variants"]) == 7   # C0, C1, C0s, C2, C3, C4, C5
    assert "45-day call" in res_c["recoveryStats"]
    assert all("vsLive" in v for v in res_c["variants"])

    # Direct compare_vs_live sanity check: better candidate produces positive premiumVsLive
    l_live = premium.Legs(dates[:100], tuple([-0.001] * 100), tuple([0.001] * 100), tuple([0.0] * 100),
                          tuple([0.5] * 100), 10, 50)
    l_cand = premium.Legs(dates[:100], tuple([0.001] * 100), tuple([0.001] * 100), tuple([0.0] * 100),
                          tuple([0.0] * 100), 0, 0)
    cmp = alternatives.compare_vs_live(l_cand, l_live, 21)
    assert cmp["premiumVsLive"] > 0.40
    assert cmp["beatsLive90"] is True


def test_salvage_filter_skips_near_worthless_wide_spread_option(tmp_path: Path) -> None:
    dates = ("2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19")
    exp = "2024-01-19"
    s = bars.Series("SPY", dates, (470,) * 6, (471,) * 6, (469,) * 6, (470,) * 6, (470,) * 6)
    u = real_quotes.RealUnderlying(s)
    # At T-3 (2024-01-16), option bid is $0.05 and ask is $0.15 -> spread/mid = 100%, bid < $0.10
    rows = {
        "2024-01-11": [(480, 1.0, 1.1, 0.30)],
        "2024-01-12": [(480, 0.4, 0.5, 0.18)],
        "2024-01-16": [(480, 0.05, 0.15, 0.04)],
        "2024-01-17": [(480, 0.02, 0.08, 0.02)],
        "2024-01-18": [(480, 0.01, 0.05, 0.01)],
        "2024-01-19": [(480, 0.00, 0.02, 0.00)],
    }
    p_csv = tmp_path / "salv.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 480.0, 1),), 0, exp)
    assert tr is not None
    assert tr.spread_pct(2) == pytest.approx(1.0)
    p_live = alternatives.option_path(tr, alternatives.optiontests.loser_close_rule(3), [0.0] * 6, 1)
    p_salv = alternatives.option_path(
        tr, alternatives.salvage_loser_close_rule(3, min_bid=0.10, max_spread_pct=0.25), [0.0] * 6, 1
    )
    # Also verify max_spread_pct alone blocks closing even when bid >= min_bid (0.04 >= 0.01 but spread 100% > 25%)
    p_spread_only = alternatives.option_path(
        tr, alternatives.salvage_loser_close_rule(3, min_bid=0.01, max_spread_pct=0.25), [0.0] * 6, 1
    )
    assert p_live.stop_events == 1
    assert p_salv.stop_events == 0
    assert p_spread_only.stop_events == 0


def test_pit_entries_filters_out_non_member_signals(tmp_path: Path) -> None:
    cal = _business_dates(date(2020, 1, 2), 300)
    closes = [100.0] * 265 + [105.0, 106.0, 107.0] + [100.0] * 20 + [112.0, 113.0, 114.0] + [110.0] * 9
    s = _series("TMP", closes)
    p_csv = tmp_path / "pit_ent.csv"
    p_csv.write_text(f'date,tickers\n{cal[0]},"TMP"\n{cal[275]},"OTHER"\n', encoding="utf-8")
    pm = pit.load_pit_csv(p_csv)
    raw = entries.signals(s, lo=260, hi=295)
    filtered = pit.pit_entries({"TMP": s}, cal, pm, cal[260], 5, warmup=260)
    assert len(raw) >= 1
    for e in filtered.get("TMP", []):
        assert pm.is_member("TMP", s.dates[e.i])


def test_real_spread45_and_runner_guards(tmp_path: Path) -> None:
    import importlib.util

    # 45-day call debit spread on real quotes: long 470C (delta 0.52) / short 485C (delta 0.28)
    dates = _business_dates(date(2024, 1, 2), 35)
    exp = dates[-1]
    s = _series("SPY", [470.0 + 0.4 * i for i in range(35)], start=date(2024, 1, 2))
    u = real_quotes.RealUnderlying(s)
    rows = {}
    for idx, d in enumerate(dates):
        spot = 470.0 + 0.4 * idx
        b1, a1 = max(0.5, spot - 462.0), max(0.6, spot - 461.7)
        b2, a2 = max(0.2, spot - 468.0), max(0.25, spot - 467.85)
        rows[d] = [(470.0, round(b1, 2), round(a1, 2), 0.52), (485.0, round(b2, 2), round(a2, 2), 0.28)]
    p_csv = tmp_path / "spr.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.make_real_spread45(u, book, 0)
    assert tr is not None
    assert len(tr.legs) == 2 and tr.legs[0].strike == 470.0 and tr.legs[1].strike == 485.0
    assert tr.debit > 0

    # Verify run.py refuses --out inside the git repository and renders clean dark HTML
    repo_root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("alt_run", repo_root / "research/backtests/stoploss-alt-exit/run.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.main(["--data", str(tmp_path), "--out", str(repo_root / "research/backtests/stoploss-alt-exit")]) == 2

    fake_res = {"generatedAt": "2026-11-28T00:00:00Z", "code": {"commit": "a" * 40, "dirty": False}, "tests": {}}
    page = mod.render_html(fake_res, {})
    assert "Dry-Run Study of Alternative Exit Rules" in page
    assert "stoploss-alt-exit-dryrun" in page

    # Verify fetch_data.py pit_symbols deduplicates and normalizes BRK.B -> BRK-B
    fspec = importlib.util.spec_from_file_location(
        "alt_fetch", repo_root / "research/backtests/stoploss-alt-exit/fetch_data.py"
    )
    assert fspec is not None and fspec.loader is not None
    fmod = importlib.util.module_from_spec(fspec)
    fspec.loader.exec_module(fmod)
    pit_p = tmp_path / "p.csv"
    pit_p.write_text('date,tickers\n2004-01-01,"OLD"\n2004-06-01,"PRIOR"\n2010-01-01,"AAPL,BRK.B"\n', encoding="utf-8")
    # Includes latest snapshot <= start ("PRIOR") and all snapshots > start, excludes superseded "OLD"
    assert fmod.pit_symbols(pit_p, "2005-01-01") == ["AAPL", "BRK-B", "PRIOR"]
    assert fmod.main(["--out", str(repo_root / "research/backtests/stoploss-alt-exit")]) == 2


def test_underlying_rate_floors_negative_irx() -> None:
    s = _series("SPY", [100.0] * 10, start=date(2020, 3, 20))
    u = options.Underlying(s, rates=[-0.0005] * 10)
    assert u.rate(0) == 0.0
    # Black-Scholes pricing does not raise on negative IRX inputs
    q = u.quote((options.Leg("call", 100.0, 1),), 0, date(2020, 6, 19), atm=0.25)
    assert q is not None and q[0] > 0


def test_review_regressions_intraday_zero_bid_monthly_and_flex_ladder(tmp_path: Path) -> None:
    # Finding 1: Intraday fill uses prior-day close/bid/delta only (no same-day EOD leak on crash + IV spike)
    dates = ("2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19")
    exp = "2024-01-19"
    s = bars.Series("SPY", dates, (475, 474, 475, 474, 470, 476), (476, 475, 476, 475, 471, 477),
                    (474, 465, 474, 473, 468, 475), (475, 466, 475, 474, 470, 476), (475, 466, 475, 474, 470, 476))
    u = real_quotes.RealUnderlying(s)
    # Day 1 crashes from 475 to 466 while EOD bid spikes abnormally to 20.0 (IV spike); intraday rung at 470
    # MUST anchor from day 0 bid (10.0) + day 0 delta (0.6) * (470 - 475) = 7.0, NOT from day 1 EOD bid 20.0!
    # Also test Finding 3: zero-bid ITM contract on expiry day falls back to intrinsic ($6 - comm, not $0.00)!
    rows = {
        "2024-01-11": [(470, 10.0, 10.2, 0.60)],
        "2024-01-12": [(470, 20.0, 20.5, 0.40)],
        "2024-01-16": [(470, 9.0, 9.2, 0.58)],
        "2024-01-17": [(470, 8.0, 8.2, 0.56)],
        "2024-01-18": [(470, 5.0, 5.2, 0.55)],
        "2024-01-19": [(470, 0.0, 0.0, 1.00)],  # pulled zero-bid quote on ITM strike (spot 476 -> $6 intrinsic)
    }
    p_csv = tmp_path / "reg.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 470.0, 1),), 0, exp)
    assert tr is not None
    assert tr.exit_bid(1, spot=470.0) == pytest.approx((10.0 - options.LEG_COMMISSION) + 0.60 * (470.0 - 475.0))
    assert tr.exit_bid(5) == pytest.approx(6.0 - options.LEG_COMMISSION)
    assert tr.has_real_expiry_quote is False

    # Finding 3b: timestamp date suffix accepted and mark clamped into [bid, ask]
    q_ts, err = real_quotes.validate_quote("2024-01-19 16:00:00", "2024-01-19", 470.0, "call", 0.0, 0.50, mark=9.99)
    assert err is None and q_ts is not None
    assert q_ts.day == "2024-01-19" and q_ts.mark == 0.50

    # Finding 5: flex_ladder_levels enforces min_atr floor even when min_atr > stop_scale
    lvs = alternatives.flex_ladder_levels(100.0, 98.0, 2.0, n_rungs=5, min_atr=2.0, stop_scale=1.5)
    assert len(lvs) == 5
    assert lvs[0] <= 96.0  # <= 100 - 2.0 * 2.0
    assert all(lvs[i] > lvs[i + 1] for i in range(4))

    # Finding 7: open_real_trade rejects expiry beyond book.last_date
    s_long = _series("SPY", [470.0] * 30, start=date(2024, 1, 16))
    u_long = real_quotes.RealUnderlying(s_long)
    assert real_quotes.open_real_trade(u_long, book, (options.Leg("call", 470.0, 1),), 0, "2024-02-16") is None

    # Finding 9: select_expiry monthly_only rejects Thursday 0DTE (2024-02-15) and picks 3rd Friday (2024-02-16)
    b2 = real_quotes.QuoteBook("SPY")
    for exp_d in ("2024-02-15", "2024-02-16"):
        q, _ = real_quotes.validate_quote("2024-01-02", exp_d, 470.0, "call", 5.0, 5.2, delta=0.50)
        assert q is not None
        b2.add(q)
    b2.finalize()
    assert b2.select_expiry("2024-01-02", min_dte=30, max_dte=60, target_dte=44, monthly_only=True) == "2024-02-16"

    # Finding 10: loser_recovery_stats is equal-capital per trade, not dollar-debit-weighted
    # Two T-3 losers: trade 1 debit=1 (early=0.5, exp=1.0 -> +50% of debit), trade 2 debit=100 (early=50, exp=0 -> -50%)
    # Equal-capital mean holdMinusEarlyOfDebit = (+0.5 - 0.5) / 2 = 0.0 (dollar-weighted would be -49.0%!)
    t1 = real_quotes.RealTrade(u, (options.Leg("call", 10.0, 1),), date(2024, 1, 19), 5, 0, 5, 1.0,
                               [1.0, 0.9, 0.8, 0.7, 0.5, 1.0], [0.9, 0.8, 0.7, 0.6, 0.5, 1.0], [0.5] * 6, [0.1] * 6,
                               0.05, True, 6, 0)
    t2 = real_quotes.RealTrade(u, (options.Leg("call", 100.0, 1),), date(2024, 1, 19), 5, 0, 5, 100.0,
                               [100.0, 90.0, 80.0, 70.0, 50.0, 0.0], [99.0, 89.0, 79.0, 69.0, 50.0, 0.0], [0.5] * 6,
                               [0.1] * 6, 0.05, True, 6, 0)
    e_dummy = entries.Entry("SPY", 0, "acceptance", 475.0, 470.0, 2.0)
    st = alternatives.loser_recovery_stats(
        [alternatives.AltEntryTrade(e_dummy, t1, 1, [0.0] * 4), alternatives.AltEntryTrade(e_dummy, t2, 1, [0.0] * 4)],
        sessions_before=1,
    )
    assert st["holdMinusEarlyOfDebit"] == pytest.approx(0.0)


def test_round2_regressions_live_b1_parity_and_spread_short_zero_ask(tmp_path: Path) -> None:
    # Round 2 Finding 1: exact parity with optiontests.ladder_levels when lim - stop == 1x ATR (live anchor B1)
    live_ref = alternatives.optiontests.ladder_levels(100.0, 98.0, 2.0, min_atr=1.0)
    flex_live = alternatives.flex_ladder_levels(100.0, 98.0, 2.0, n_rungs=5, min_atr=1.0, stop_scale=1.0)
    assert flex_live == live_ref == [98.0] * 5
    # While min_atr > stop_scale still enforces the wider ATR floor cleanly
    flex_wide = alternatives.flex_ladder_levels(100.0, 98.0, 2.0, n_rungs=5, min_atr=2.0, stop_scale=1.5)
    assert flex_wide[0] == 96.0 and all(flex_wide[i] > flex_wide[i + 1] for i in range(4))

    # Round 2 Finding 2: ITM short leg with pulled 0.0/0.0 quote at expiry falls back to spread intrinsic (not > width)
    dates = ("2024-01-11", "2024-01-12", "2024-01-16", "2024-01-17", "2024-01-18", "2024-01-19")
    exp = "2024-01-19"
    s = bars.Series("SPY", dates, (475, 478, 482, 485, 488, 490), (476, 479, 483, 486, 489, 491),
                    (474, 477, 481, 484, 487, 489), (475, 478, 482, 485, 488, 490),
                    (475, 478, 482, 485, 488, 490))
    u = real_quotes.RealUnderlying(s)
    rows = {
        "2024-01-11": [(470, 8.0, 8.2, 0.65), (485, 1.5, 1.7, 0.25)],
        "2024-01-12": [(470, 10.0, 10.2, 0.72), (485, 2.2, 2.4, 0.32)],
        "2024-01-16": [(470, 13.0, 13.2, 0.80), (485, 3.0, 3.2, 0.42)],
        "2024-01-17": [(470, 15.5, 15.7, 0.88), (485, 3.5, 3.7, 0.50)],
        "2024-01-18": [(470, 18.0, 18.2, 0.95), (485, 4.0, 4.2, 0.70)],
        # Expiry at spot=490: 470C is $20 ITM, 485C is $5 ITM -> spread width is $15, NOT $19.89!
        "2024-01-19": [(470, 19.9, 20.1, 1.00), (485, 0.0, 0.0, 1.00)],
    }
    p_csv = tmp_path / "spr_zero.csv"
    _write_sample_quotes_csv(p_csv, dates, exp, rows)
    book = real_quotes.load_quotes_csv(p_csv, "SPY")
    tr = real_quotes.open_real_trade(u, book, (options.Leg("call", 470.0, 1), options.Leg("call", 485.0, -1)), 0, exp)
    assert tr is not None
    assert tr.exit_bid(5) == pytest.approx(15.0 - 2 * options.LEG_COMMISSION)
    assert tr.has_real_expiry_quote is False
