"""Rule tests for the alert-template strategies on hand-made daily fixtures with known triggers."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from strategies import alert_templates as at
from strategies.alert_templates import (AnalystAction, DailyBar, Dividend, EarningsReport, Fundamentals,
                                        InsiderTrade, Series)

START = date(2021, 1, 4)  # a Monday


def sessions(n: int, start: date = START) -> list[date]:
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day)
        day += timedelta(days=1)
    return out


def bars_from(closes: list[float], volumes: list[float] | None = None, spread: float = 0.5,
              highs: dict[int, float] | None = None, lows: dict[int, float] | None = None,
              start: date = START) -> list[DailyBar]:
    days = sessions(len(closes), start)
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i else c
        h = (highs or {}).get(i, max(o, c) + spread)
        lo = (lows or {}).get(i, min(o, c) - spread)
        v = volumes[i] if volumes else 3e6
        out.append(DailyBar(days[i], o, h, lo, c, v))
    return out


def ramp(start: float, slope: float, n: int) -> list[float]:
    return [start + slope * i for i in range(n)]


def one_bar_series(**values: float | None) -> Series:
    """A Series whose last index (0) carries the given indicator values."""
    close = values.get("close", 100.0)
    bar = DailyBar(START, close, close, close, close, 1.0)
    one = lambda key, default=None: (values.get(key, default),)  # noqa: E731
    return Series((bar,), (close,), one("sma50"), one("sma200"), one("rsi14"), one("high_prior"),
                  one("year_high"), one("year_low"), one("avg_vol30", 5e6), one("avg_vol20", 5e6))


def indexes(signals: list[at.Signal]) -> list[int]:
    return [s.index for s in signals]


# --- shared helpers -----------------------------------------------------------------------------


def test_daily_bar_rejects_inconsistent_values():
    with pytest.raises(ValueError):
        DailyBar(START, 10, 9, 8, 10.5, 1)
    with pytest.raises(ValueError):
        DailyBar(START, 10, 11, 0, 10, 1)
    with pytest.raises(ValueError):
        DailyBar(START, float("nan"), 11, 9, 10, 1)


def test_prepare_requires_increasing_dates():
    bars = bars_from([10, 11])
    with pytest.raises(ValueError):
        at.prepare([bars[1], bars[0]])


def test_rolling_windows_exclude_or_include_current_bar():
    bars = bars_from(ramp(10, 1, 300))
    s = at.prepare(bars)
    assert s.high_prior[251] is None and s.year_high[250] is None
    assert s.high_prior[252] == bars[251].high
    assert s.year_high[252] == bars[252].high
    assert s.year_low[260] == bars[9].low
    assert s.avg_vol30[29] is None and s.avg_vol30[30] == 3e6


def test_refresh_days_monthly_and_weekly():
    s = at.prepare(bars_from([10.0] * 30, start=date(2021, 1, 27)))
    assert [s.bars[i].day for i in at.refresh_days(s, "monthly")] == [date(2021, 1, 27), date(2021, 2, 1),
                                                                       date(2021, 3, 1)]
    assert all(s.bars[i].day.weekday() == 0 for i in at.refresh_days(s, "weekly")[1:])
    with pytest.raises(ValueError):
        at.refresh_days(s, "daily")


def test_armed_scan_fires_once_per_window_and_rearms_next_refresh():
    s = at.prepare(bars_from([10.0] * 45))  # Jan 4 .. Mar 5 2021; refreshes at 0, 20 (Feb 1), 40 (Mar 1)
    fired = at.armed_scan(s, "monthly", lambda s, t: True,
                          lambda s, r, t: at.Signal(t, s.bars[t].day, "x") if t >= r + 2 else None)
    assert indexes(fired) == [2, 22, 42]
    assert at.armed_scan(s, "monthly", lambda s, t: t != 20,
                         lambda s, r, t: at.Signal(t, s.bars[t].day, "x") if t == 25 else None) == []


def test_crosses_use_yesterdays_average_as_level():
    closes = [10.0] * 60 + [9.0] * 5 + [9.2]
    bars = bars_from(closes, highs={65: 10.5})
    s = at.prepare(bars)
    assert at.crosses_above(s, s.sma50, 65)
    assert not at.crosses_above(s, s.sma50, 64)
    assert not at.crosses_above(s, s.sma50, 0)
    assert not at.crosses_below(s, s.sma50, 0)


# --- 1/2. 52-week-high breakouts ----------------------------------------------------------------

def breakout_fixture() -> list[DailyBar]:
    # Uptrend on thin volume (no alerts: average volume <= 1M), then a 40-session base just below the
    # high on 3M shares a day, then a breakout on session 300.
    closes = ramp(100, 0.3, 260) + [175.0] * 40 + [180.0, 181.0, 181.5]
    volumes = [0.5e6] * 260 + [3e6] * 43
    return bars_from(closes, volumes, highs={300: 182.0})


def test_quality_breakout_radar_fires_on_the_breakout_session():
    bars = breakout_fixture()
    signals = at.quality_breakout_radar(bars)
    assert indexes(signals) == [300]
    assert signals[0].kind == "new-52-week-high"
    assert signals[0].level == pytest.approx(at.prepare(bars).high_prior[300])


def test_quality_breakout_price_rule_edges():
    base = dict(close=95.0, sma50=90.0, sma200=80.0, year_high=100.0)
    assert at.quality_breakout_price(one_bar_series(**base), 0)
    assert not at.quality_breakout_price(one_bar_series(**{**base, "close": 94.9}), 0)  # > 5% below high
    assert not at.quality_breakout_price(one_bar_series(**{**base, "sma50": 96.0}), 0)
    assert not at.quality_breakout_price(one_bar_series(**{**base, "avg_vol30": 1e6}), 0)
    assert not at.quality_breakout_price(one_bar_series(**{**base, "sma200": None}), 0)


def test_under_the_radar_breakouts_fires_and_checks_low_and_volume():
    assert indexes(at.under_the_radar_breakouts(breakout_fixture())) == [300]
    base = dict(close=92.0, sma50=90.0, sma200=80.0, year_high=100.0, year_low=70.0, avg_vol30=2e6)
    assert at.under_radar_price(one_bar_series(**base), 0)
    assert not at.under_radar_price(one_bar_series(**{**base, "year_low": 71.0}), 0)  # < 30% above low
    assert not at.under_radar_price(one_bar_series(**{**base, "close": 91.9}), 0)  # > 8% below high
    assert not at.under_radar_price(one_bar_series(**{**base, "avg_vol30": 1.5e6}), 0)


# --- 3. Quality compounders on pullback ------------------------------------------------------------

def pullback_fixture() -> list[DailyBar]:
    # Uptrend to ~177, a fall to 151 (15% below the high), a 25-session base, then a reclaim on 316.
    closes = ramp(100, 0.3, 260) + ramp(177.7, -1.0, 27) + [151.0] * 29 + [175.0, 176.0]
    return bars_from(closes)


def test_quality_compounders_on_pullback_fires_on_the_reclaim():
    bars = pullback_fixture()
    s = at.prepare(bars)
    signals = at.quality_compounders_on_pullback(bars)
    assert indexes(signals) == [316]
    assert signals[0].kind == "reclaims-50-day" and signals[0].level == s.sma50[315]


def test_quality_compounder_price_rule_edges():
    base = dict(close=80.0, sma50=85.0, sma200=85.0, year_high=100.0)
    assert at.quality_compounder_price(one_bar_series(**base), 0)
    assert at.quality_compounder_price(one_bar_series(**{**base, "close": 88.0, "sma50": 89.0}), 0)
    assert not at.quality_compounder_price(one_bar_series(**{**base, "close": 88.1, "sma50": 89.0}), 0)
    assert not at.quality_compounder_price(one_bar_series(**{**base, "close": 69.9}), 0)  # > 30% off
    assert not at.quality_compounder_price(one_bar_series(**{**base, "sma200": 87.0}), 0)  # > 8% below 200d
    assert not at.quality_compounder_price(one_bar_series(**{**base, "sma50": 79.0}), 0)  # above 50d


# --- 4. Leader pullback and reclaim --------------------------------------------------------------

def test_leader_pullback_price_rule_edges():
    base = dict(close=90.0, sma50=95.0, sma200=80.0, year_high=100.0, rsi14=40.0)
    assert at.leader_pullback_price(one_bar_series(**base), 0)
    assert at.leader_pullback_price(one_bar_series(**{**base, "rsi14": 35.0}), 0)
    assert at.leader_pullback_price(one_bar_series(**{**base, "rsi14": 45.0}), 0)
    assert not at.leader_pullback_price(one_bar_series(**{**base, "rsi14": 45.1}), 0)
    assert not at.leader_pullback_price(one_bar_series(**{**base, "close": 92.1}), 0)  # < 8% off
    assert not at.leader_pullback_price(one_bar_series(**{**base, "close": 79.0, "sma200": 70.0}), 0)
    assert not at.leader_pullback_price(one_bar_series(**{**base, "avg_vol30": 2e6}), 0)


def leader_fixture() -> list[DailyBar]:
    # Uptrend to ~299, a 30-session saw-tooth (down 6, up 4: RSI near 40), then a reclaim on 431.
    saw = []
    price = 299.5
    for k in range(31):
        price += -6.0 if k % 2 == 0 else 4.0
        saw.append(price)
    return bars_from(ramp(100, 0.5, 400) + saw + [300.0, 301.0])


def test_leader_pullback_and_reclaim_fires_on_the_reclaim():
    bars = leader_fixture()
    s = at.prepare(bars)
    armed = [r for r in at.refresh_days(s, "weekly") if 400 <= r < 431 and at.leader_pullback_price(s, r)]
    assert armed, "the saw-tooth must pass the screen on at least one weekly refresh"
    assert indexes(at.leader_pullback_and_reclaim(bars)) == [431]


# --- 5. 200-day comeback --------------------------------------------------------------------------

def comeback_fixture() -> list[DailyBar]:
    # 300 sessions up to ~250, a fall to 160 and 60 sessions below the 200-day average, a lift to 175
    # (above the 50-day average, still below the 200-day), then a cross above the 200-day on 430.
    closes = ramp(100, 0.5, 300) + ramp(249.5, -3.0, 30) + [160.0] * 70 + ramp(161, 0.5, 30) + [200.0, 201.0]
    return bars_from(closes)


def test_two_hundred_day_comeback_fires_on_the_cross():
    bars = comeback_fixture()
    s = at.prepare(bars)
    signals = at.two_hundred_day_comeback(bars)
    assert indexes(signals) == [430]
    assert signals[0].kind == "crosses-above-200-day" and signals[0].level == s.sma200[429]


def test_comeback_price_rule_requires_40_of_60_sessions_below():
    bars = comeback_fixture()
    s = at.prepare(bars)
    assert at.comeback_price(s, 429)
    assert not at.comeback_price(s, 340)  # below the 50-day average during the fall
    assert not at.comeback_price(s, 30)  # warm-up


# --- 6. Sector leadership ---------------------------------------------------------------------------

def test_sector_leadership_labels_bounce_in_downtrend_and_leadership():
    down = ramp(200, -0.3, 260) + [120.0] * 20 + [126.0]  # cross above 50d while below 200d
    spy = bars_from(ramp(100, 0.5, 281))  # SPY rising fast: the sector trails it
    up = ramp(100, 0.3, 260) + [165.0] * 30 + [185.0]  # cross above 50d while above 200d
    sig_down = at.sector_leadership(bars_from(down), spy)
    sig_up = at.sector_leadership(bars_from(up), bars_from(ramp(100, 0.1, 291)))
    assert [(s.index, s.note) for s in sig_down] == [(280, "bounce-in-downtrend")]
    assert [(s.index, s.note) for s in sig_up] == [(290, "leadership")]


# --- 7. Market stress ---------------------------------------------------------------------------------

def test_session_moves_use_intraday_extremes_once_per_day():
    bars = bars_from([100, 100, 101, 100, 100], highs={2: 102.1}, lows={4: 97.9}, spread=0.1)
    assert [(s.index, s.kind) for s in at.session_moves(bars, 0.02)] == [(2, "move-up"), (4, "move-down")]


def test_vix_thresholds_rearm_after_reset():
    closes = [20, 26, 27, 24, 26, 36, 30, 12.5, 14, 12]
    bars = bars_from(closes, spread=0.2)
    got = [(s.index, s.kind) for s in at.vix_thresholds(bars)]
    assert got == [(1, "vix-above-25"), (4, "vix-above-25"), (5, "vix-above-35"), (7, "vix-below-13"),
                   (9, "vix-below-13")]


def test_market_stress_collects_every_symbol():
    flat = bars_from(ramp(100, 0.01, 250) + [96.0])
    spy = bars_from(ramp(100, 0.01, 250) + [97.0, 103.0], spread=0.1)
    data = {"^VIX": bars_from([20.0, 26.0]), "SPY": spy, "QQQ": flat, "IWM": flat, "TLT": flat, "HYG": flat}
    got = at.market_stress(data)
    assert [s.kind for s in got["^VIX"]] == ["vix-above-25"]
    assert [(s.index, s.kind) for s in got["SPY"]] == [(250, "crosses-below-200-day"), (250, "move-down"),
                                                       (251, "crosses-above-200-day"), (251, "move-up")]
    assert [(s.index, s.kind) for s in got["IWM"]] == [(250, "crosses-below-200-day")]
    assert [s.index for s in got["QQQ"]] == [250] and got["HYG"][0].index == 250


# --- 8. Earnings calendar -----------------------------------------------------------------------------

def test_earnings_reminders_once_per_report_three_days_before():
    days = sessions(20)  # Jan 4 .. Jan 29 2021
    got = at.earnings_reminders(days, [date(2021, 1, 14), date(2021, 1, 14), date(2021, 1, 25)])
    assert [(s.day, s.note) for s in got] == [(date(2021, 1, 11), "2021-01-14"), (date(2021, 1, 22), "2021-01-25")]


def test_large_moves_use_symbol_thresholds():
    bars = bars_from([100, 100, 100], highs={1: 105.5}, lows={2: 94.0}, spread=0.1)
    assert indexes(at.large_moves("AAPL", bars)) == [1, 2]
    assert indexes(at.large_moves("NVDA", bars)) == []


# --- 9. Post-earnings strength ---------------------------------------------------------------------

def earnings_fixture() -> tuple[list[DailyBar], EarningsReport]:
    closes = ramp(100, 0.2, 260) + [160.0, 152.0, 153.0, 153.5, 154.0, 154.0, 154.0, 154.0, 154.0, 154.0, 157.0]
    volumes = [3e6] * 260 + [3e6, 9e6] + [3e6] * 9
    bars = bars_from(closes, volumes, highs={261: 160.0, 270: 157.5})
    report = EarningsReport(bars[260].day, 1.10, 1.00, 110.0, 100.0)
    return bars, report


def test_post_earnings_reaction_day_is_the_higher_volume_session():
    bars, report = earnings_fixture()
    assert at.post_earnings_reaction(at.prepare(bars), report) == 261


def test_post_earnings_strength_fires_through_the_reaction_day_high():
    bars, report = earnings_fixture()
    # The reaction session (261) opened at 160 and closed at 152: a loss, so the stock does not qualify.
    assert at.post_earnings_strength(bars, [report]) == []
    closes = [b.close for b in bars]
    closes[261] = 166.0
    closes[262:270] = [163.0] * 8
    closes[270] = 167.0
    vols = [b.volume for b in bars]
    good = bars_from(closes, vols, highs={261: 167.0, 270: 168.0})
    report = EarningsReport(good[260].day, 1.10, 1.00, 110.0, 100.0)
    signals = at.post_earnings_strength(good, [report])
    assert [(s.index, s.kind, s.level) for s in signals] == [(270, "above-earnings-day-high", 167.0)]


def test_post_earnings_screen_reports_missing_and_failed_rules():
    bars, report = earnings_fixture()
    s = at.prepare(bars)
    missing = at.post_earnings_qualifies(s, EarningsReport(report.report_day, None, 1.0, 1.0, 1.0), 265)
    assert missing.missing == ("eps_or_revenue",) and not missing.passed
    miss = at.post_earnings_qualifies(s, EarningsReport(report.report_day, 0.9, 1.0, 90.0, 100.0), 265)
    assert {"eps_beat", "revenue_up_yoy", "reaction_gain>=3pct"} <= set(miss.failed)
    early = at.post_earnings_qualifies(s, report, 260)
    assert early.failed == ("no_reaction_yet",)


# --- 10. Insider purchase confirmation -----------------------------------------------------------------

def insider(day: date, **kw) -> InsiderTrade:
    base = dict(trade_day=day, insider="A. Smith", role="Director", code="P", security="common",
                shares=10_000, price=20.0, holding_before=50_000, filing_id="f1")
    base.update(kw)
    return InsiderTrade(**base)


def test_insider_purchase_counts_only_senior_open_market_buys_of_100k():
    d = START
    assert at.insider_purchase_counts(insider(d))
    assert not at.insider_purchase_counts(insider(d, code="M"))
    assert not at.insider_purchase_counts(insider(d, security="preferred"))
    assert not at.insider_purchase_counts(insider(d, role="10% Owner"))
    assert not at.insider_purchase_counts(insider(d, shares=4_999))
    assert not at.insider_purchase_counts(insider(d, price=0.0))
    assert at.insider_purchase_counts(insider(d, role="Chief Executive Officer"))


def test_insider_score_adds_two_points_per_factor():
    d = START
    big = insider(d, role="Chief Executive Officer", shares=30_000, holding_before=100_000)
    other = insider(d, insider="B. Jones", filing_id="f2")
    assert at.insider_score(big, [big, other]) == 8
    assert at.insider_score(insider(d, holding_before=None), [insider(d)]) == 0


def test_insider_purchase_confirmation_breakout_and_cooldown():
    closes = ramp(100, 0.1, 80) + [108.0, 107.0, 107.5, 109.0, 108.0, 110.0, 108.0, 111.0]
    bars = bars_from(closes)
    t0 = bars[80].day
    trades = [insider(t0), insider(bars[84].day, filing_id="f2", insider="B. Jones")]
    signals = at.insider_purchase_confirmation(bars, trades)
    # 83: close 109 above the post-purchase high close (108). 85 is inside the 14-day cooldown.
    assert [(s.index, s.kind) for s in signals] == [(83, "close-above-post-purchase-high")]
    assert at.insider_purchase_confirmation(bars, [insider(t0, code="S")]) == []


def test_insider_near_high_on_volume():
    closes = ramp(90, 0.1, 80) + [108.0, 107.0, 106.0, 105.5]
    vols = [3e6] * 83 + [5e6]
    bars = bars_from(closes, vols)
    signals = at.insider_purchase_confirmation(bars, [insider(bars[80].day)])
    assert [(s.index, s.kind) for s in signals] == [(83, "near-high-on-volume")]


# --- 11. Analyst upgrade clusters ------------------------------------------------------------------------

def test_analyst_action_direction():
    d = START
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Hold", "Buy")) == "positive"
    assert at.analyst_action_direction(AnalystAction(d, "F1", None, "Overweight")) == "positive"
    assert at.analyst_action_direction(AnalystAction(d, "F1", None, "Neutral")) == "neutral"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Buy", "Hold")) == "negative"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Strong Buy", "Buy")) == "lowered-positive"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Hold", "Strong Sell")) == "negative"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Buy", "Buy")) == "neutral"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Hold", "Buy", target_only=True)) == "neutral"
    assert at.analyst_action_direction(AnalystAction(d, "F1", "Hold", "Unrated")) == "neutral"


def test_analyst_cluster_dedups_firms_and_vetoes():
    d = START + timedelta(days=20)
    acts = [AnalystAction(d - timedelta(days=3), "F1", "Hold", "Buy"),
            AnalystAction(d - timedelta(days=2), "F1", "Hold", "Buy"),
            AnalystAction(d - timedelta(days=15), "F2", "Hold", "Buy")]
    assert at.analyst_cluster(acts, d) == (["F1"], False)
    acts.append(AnalystAction(d, "F3", None, "Buy"))
    acts.append(AnalystAction(d, "F4", "Buy", "Hold"))
    assert at.analyst_cluster(acts, d) == (["F1", "F3"], True)


def test_analyst_upgrade_clusters_fire_on_breakout_then_cool_down():
    closes = ramp(100, 0.1, 80) + [107.0, 107.5, 109.0, 110.0, 111.0]
    bars = bars_from(closes)
    acts = [AnalystAction(bars[80].day, "F1", "Hold", "Buy"), AnalystAction(bars[81].day, "F2", None, "Buy")]
    signals = at.analyst_upgrade_clusters(bars, acts)
    assert [(s.index, s.kind, s.note) for s in signals] == [(82, "close-above-20-day-high", "firms=2")]
    veto = acts + [AnalystAction(bars[81].day, "F3", "Buy", "Sell")]
    assert at.analyst_upgrade_clusters(bars, veto) == []


def test_analyst_volume_surge_on_up_day():
    closes = ramp(100, 0.1, 80) + [107.0, 107.1]
    vols = [3e6] * 81 + [5e6]
    bars = bars_from(closes, vols, highs={60: 120.0})
    acts = [AnalystAction(bars[80].day, "F1", "Hold", "Buy"), AnalystAction(bars[80].day, "F2", None, "Buy")]
    assert [s.kind for s in at.analyst_upgrade_clusters(bars, acts)] == ["volume-surge-up-day"]


# --- 12. Dividend growth buy zones ------------------------------------------------------------------------

def dividend_fixture(final_closes: list[float]) -> tuple[list[DailyBar], list[Dividend]]:
    # Quarterly payments (first session of Mar, Jun, Sep, Dec), raised by 0.05 every year from 2020.
    # Price 100 for ~6.2 years, then 140 for 200 sessions (the yield falls below its 5-year zone).
    n = 252 * 7
    bars = bars_from([100.0] * (n - 200) + [140.0] * 200 + final_closes, start=date(2020, 1, 1))
    divs, seen = [], set()
    for bar in bars:
        key = (bar.day.year, bar.day.month)
        if bar.day.month in (3, 6, 9, 12) and key not in seen:
            seen.add(key)
            divs.append(Dividend(bar.day, round(0.50 + 0.05 * (bar.day.year - 2020), 2)))
    return bars, divs


def test_dividend_growth_years_counts_consecutive_raises():
    bars, divs = dividend_fixture([100.0])
    assert at.dividend_growth_years(divs, bars[-1].day) == 5
    assert at.dividend_growth_years(divs[:4], bars[-1].day) == 0


def test_dividend_buy_zone_price_level_alert():
    bars, divs = dividend_fixture([140.0] * 10 + [110.0])
    s = at.prepare(bars)
    state, level = at.dividend_buy_zone_state(s, divs, len(bars) - 2)
    assert state == "price-level" and level is not None and 110.0 < level < 140.0
    signals = at.dividend_growth_buy_zones(bars, divs)
    assert [s.kind for s in signals] == ["reaches-buy-zone-yield"]
    assert signals[-1].index == len(bars) - 1


def test_dividend_buy_zone_requires_growth_and_yield():
    bars, divs = dividend_fixture([100.0])
    s = at.prepare(bars)
    cut = divs + [Dividend(bars[-1].day, 0.10)]
    assert at.dividend_buy_zone_state(s, cut, len(bars) - 1) == ("none", None)
    assert at.dividend_buy_zone_state(s, [], len(bars) - 1) == ("none", None)
    tiny = [Dividend(d.ex_day, d.amount / 100) for d in divs]
    assert at.dividend_buy_zone_state(s, tiny, len(bars) - 1) == ("none", None)


# --- fundamentals -------------------------------------------------------------------------------------

def test_fundamental_screens_report_missing_and_failed():
    good = Fundamentals(market_cap=60e9, free_cash_flow_ttm=1e9, net_margin_ttm=0.1, revenue_growth_fy=0.05,
                        net_debt_to_ebitda=1.0, profitable_last_3_fy=True, last_eps_surprise=0.02,
                        financial_sector=False, payout_ratio_earnings=0.5)
    for slug in ("quality-breakout-radar", "quality-compounders-on-pullback", "leader-pullback-and-reclaim",
                 "dividend-growth-buy-zones"):
        assert at.fundamental_screen(slug, good).passed, slug
    assert not at.fundamental_screen("under-the-radar-breakouts", good).passed  # 60B is not a mid-cap
    assert at.fundamental_screen("200-day-comeback-watchlist", good).passed
    assert at.fundamental_screen("quality-breakout-radar", None).missing == ("fundamentals",)
    partial = at.fundamental_screen("quality-breakout-radar", Fundamentals(market_cap=6e9))
    assert "fcf_ttm>0" in partial.missing and not partial.passed
    bank = Fundamentals(market_cap=6e9, free_cash_flow_ttm=1.0, revenue_growth_fy=-0.1, net_income_growth_fy=0.1,
                        financial_sector=True)
    assert at.fundamental_screen("quality-breakout-radar", bank).passed
    assert at.fundamental_screen("quality-compounders-on-pullback", bank).failed[0] == "market_cap>=20B"
    with pytest.raises(KeyError):
        at.fundamental_screen("sector-leadership-radar", good)
