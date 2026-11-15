"""Trend Trio rules: the completed-bar timeline, no look-ahead and the entry/exit rules (synthetic data)."""

from __future__ import annotations

import math
import random
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from strategies.trend_trio import rules
from strategies.trend_trio.rules import MINUTE_MS, Minutes, Params

NY = ZoneInfo("America/New_York")
OPEN = 9 * 60 + 30


def ms(day: date, minute: int) -> int:
    """UTC ms of the bar that opens `minute` minutes after 09:30 New York on `day`."""
    hour, rest = divmod(OPEN + minute, 60)
    return int(datetime(day.year, day.month, day.day, hour, rest, tzinfo=NY).timestamp() * 1000)


def minutes(days: list[tuple[date, int, set[int]]], prices: list[float] | None = None, seed: int = 1,
            bar_minutes: int = 1) -> Minutes:
    """Regular-session bars for (day, close minute after 09:30, missing minutes)."""
    rng = random.Random(seed)
    t, o, h, low, c, v, session, minute = [], [], [], [], [], [], [], []
    price = 100.0
    k = 0
    for s, (day, close, missing) in enumerate(days):
        for m in range(0, close, bar_minutes):
            if m in missing:
                continue
            if prices is not None:
                close_price = prices[k]
            else:
                close_price = price + rng.gauss(0.0, 0.4) + 0.05 * math.sin(k / 30)
            open_price = price
            t.append(ms(day, m)); o.append(open_price); c.append(close_price)
            h.append(max(open_price, close_price) + 0.1); low.append(min(open_price, close_price) - 0.1)
            v.append(100.0 + (k % 7)); session.append(s); minute.append(m)
            price = close_price
            k += 1
    return Minutes(t, o, h, low, c, v, bar_minutes * MINUTE_MS, session, minute, [d[1] for d in days],
                   [1.0] * len(days), [d[0].isoformat() for d in days])


FRIDAY, MONDAY_DST, EARLY = date(2024, 3, 8), date(2024, 3, 11), date(2024, 11, 29)


def ny_end(b: rules.Buckets, index: int) -> str:
    return datetime.fromtimestamp(b.end_ms[index] / 1000, NY).strftime("%Y-%m-%d %H:%M")


def test_timeline_table_5_minutes() -> None:
    m = minutes([(FRIDAY, 390, {31}), (MONDAY_DST, 390, set()), (EARLY, 210, set())])
    b = rules.buckets(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, 5, session=m.session)
    at = {(m.session[i], m.minute[i]): b.read[i] for i in range(len(m.t))}
    # First session: nothing readable before 09:34; 09:34 (closes 09:35) reads 09:30-09:35.
    assert [at[(0, x)] for x in range(4)] == [-1] * 4
    assert ny_end(b, at[(0, 4)]) == "2024-03-08 09:35"
    assert {ny_end(b, at[(0, x)]) for x in range(5, 9)} == {"2024-03-08 09:35"}
    assert ny_end(b, at[(0, 9)]) == "2024-03-08 09:40"
    # 10:02 with 10:01 missing reads 09:55-10:00; the 10:00-10:05 bucket has 4 bars and ends at 10:05.
    assert ny_end(b, at[(0, 32)]) == "2024-03-08 10:00"
    assert ny_end(b, at[(0, 34)]) == "2024-03-08 10:05"
    # Monday after the DST change: 09:30-09:33 read Friday's last bucket; 09:34 reads 09:30-09:35 New York.
    assert {ny_end(b, at[(1, x)]) for x in range(4)} == {"2024-03-08 16:00"}
    assert ny_end(b, at[(1, 4)]) == "2024-03-11 09:35"
    # Early close: the 12:59 bar closes at 13:00 and reads 12:55-13:00, the session's last bucket.
    assert ny_end(b, at[(2, 209)]) == "2024-11-29 13:00"
    assert b.session_first[at[(1, 4)]] and b.session_first[at[(2, 4)]] and not b.session_first[at[(2, 9)]]


def test_timeline_15_minutes_and_lookahead() -> None:
    m = minutes([(FRIDAY, 390, set())])
    b = rules.buckets(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, 15)
    assert b.read[13] == -1 and ny_end(b, b.read[14]) == "2024-03-08 09:45"
    look = rules.buckets(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, 15, lookahead=True)
    assert ny_end(look, look.read[0]) == "2024-03-08 09:45"  # the forming bucket: diagnostic only


def test_bucket_bars_aggregate() -> None:
    m = minutes([(FRIDAY, 10, set())])
    b = rules.buckets(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, 5)
    assert b.o[0] == m.o[0] and b.c[0] == m.c[4] and b.h[0] == max(m.h[:5]) and b.l[0] == min(m.l[:5])
    assert b.v[0] == sum(m.v[:5])


def test_bucket_length_must_fit_bars() -> None:
    m = minutes([(FRIDAY, 30, set())], bar_minutes=5)
    with pytest.raises(ValueError, match="whole multiple"):
        rules.buckets(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, 7)


SMALL = Params(st_length=3, st_factor=1.0, uma_length=3, uma_smoothing=1, at_length=3, at_coeff=0.5,
               at_momentum="rsi", ce_length=3, ce_multiple=1.0, sling_fast=2, sling_slow=4)


def _sessions(n: int) -> list[tuple[date, int, set[int]]]:
    out = []
    d = date(2024, 1, 2)
    while len(out) < n:
        if d.weekday() < 5:
            out.append((d, 390, set()))
        d = date.fromordinal(d.toordinal() + 1)
    return out


def test_no_lookahead_future_bars_do_not_change_past_decisions() -> None:
    days = _sessions(6)
    base = minutes(days, seed=4)
    trades = rules.trades(base, SMALL)
    assert len(trades) > 10
    cut = len(base.t) // 2
    rng = random.Random(9)
    prices = list(base.c[:cut]) + [x + rng.gauss(0, 3) for x in base.c[cut:]]
    changed = minutes(days, prices=prices, seed=4)
    assert changed.c[:cut] == base.c[:cut] and changed.c[cut:] != base.c[cut:]
    after = rules.trades(changed, SMALL)

    def decided(ts: list[rules.Trade]) -> list[tuple]:
        # Entries decided at or before bar cut - 1 (they fill at bar <= cut), with their side and entry fill.
        return [(x.side, x.entry_bar, x.entry_price) for x in ts if x.entry_bar <= cut]

    assert decided(after) == decided(trades)
    exits_before = [(x.entry_bar, x.exit_bar, x.exit_reason) for x in trades if x.exit_bar <= cut]
    assert exits_before == [(x.entry_bar, x.exit_bar, x.exit_reason) for x in after if x.exit_bar <= cut]


def test_lookahead_diagnostic_changes_decisions() -> None:
    days = _sessions(6)
    base = minutes(days, seed=4)
    honest = rules.trades(base, SMALL)
    peek = rules.trades(base, Params(**{**SMALL.__dict__, "lookahead": True}))
    assert [(x.entry_bar, x.side) for x in honest] != [(x.entry_bar, x.side) for x in peek]


def test_trade_invariants() -> None:
    days = _sessions(8)
    m = minutes(days, seed=11)
    for params in (SMALL, Params(**{**SMALL.__dict__, "entry": "reentry"}),
                   Params(**{**SMALL.__dict__, "entry": "event"}),
                   Params(**{**SMALL.__dict__, "exit_on_voters": True}),
                   Params(**{**SMALL.__dict__, "ce_on_signal": True}),
                   Params(**{**SMALL.__dict__, "filter_on": False}),
                   Params(**{**SMALL.__dict__, "voters_needed": 2}),
                   Params(**{**SMALL.__dict__, "signal_minutes": 15})):
        ts = rules.trades(m, params)
        last_exit = -1
        for x in ts:
            assert x.entry_bar > last_exit or (x.entry_bar == last_exit and x.exit_reason != "close")
            assert m.session[x.entry_bar] == m.session[x.exit_bar] == x.session  # flat every night
            assert 5 <= m.minute[x.entry_bar] <= 381  # decided from 09:35 to 15:50, filled at the next open
            assert x.points == pytest.approx(x.side * (x.exit_price - x.entry_price))
            if x.exit_reason == "close":
                assert x.exit_bar + 1 == len(m.t) or m.session[x.exit_bar + 1] != x.session
                assert x.exit_price == m.c[x.exit_bar]
            else:
                assert x.exit_price == m.o[x.exit_bar]
            assert x.entry_price == m.o[x.entry_bar]
            last_exit = x.exit_bar


def test_episode_allows_one_entry_and_reentry_more() -> None:
    m = minutes(_sessions(8), seed=11)
    once = rules.trades(m, SMALL)
    again = rules.trades(m, Params(**{**SMALL.__dict__, "entry": "reentry"}))
    assert len(again) > len(once)


def test_market_on_close_and_scale() -> None:
    days = [(FRIDAY, 390, set())]
    up = [100.0 + 0.05 * k for k in range(390)]
    m = minutes(days, prices=up)
    m = Minutes(m.t, m.o, m.h, m.l, m.c, m.v, m.bar_ms, m.session, m.minute, m.close_minute, [40.0], m.day)
    ts = rules.trades(m, SMALL)
    assert ts and ts[-1].exit_reason == "close" and ts[-1].side == 1
    assert ts[-1].points == pytest.approx((ts[-1].exit_price - ts[-1].entry_price) * 40.0)


def test_signal_arrays_mark_decision_bars() -> None:
    m = minutes(_sessions(4), seed=4)
    ts = rules.trades(m, SMALL)
    signals, exits, close_at = rules.signal_arrays(m, ts, 1)
    longs = [x for x in ts if x.side == 1]
    assert sum(signals) == len(longs)
    assert sum(exits) == sum(1 for x in longs if x.exit_reason != "close")
    assert sum(close_at) == 4


def test_params_key_is_stable() -> None:
    assert Params().key() == Params().key()
    assert Params().key() != Params(st_length=7).key()
    assert Params().key().startswith("at_coeff=1.0,")


def test_spec_is_frozen() -> None:
    """The rules above "## Results" in docs/specs/strategies/trend-trio.md are the frozen ones."""
    assert rules.spec_sha256() == rules.SPEC_SHA256


def _full_session(days: list[date], seed: int = 21) -> Minutes:
    """Bars around the clock (00:00 to 23:59 New York) for the full-session variant V8."""
    rng = random.Random(seed)
    t, o, h, low, c, v, session, minute = [], [], [], [], [], [], [], []
    price = 100.0
    for s, day in enumerate(days):
        for m in range(-OPEN, 24 * 60 - OPEN):
            close_price = price + rng.gauss(0.0, 0.3)
            t.append(ms(day, m)); o.append(price); c.append(close_price)
            h.append(max(price, close_price) + 0.1); low.append(min(price, close_price) - 0.1)
            v.append(50.0); session.append(s); minute.append(m)
            price = close_price
    return Minutes(t, o, h, low, c, v, MINUTE_MS, session, minute, [390] * len(days), [1.0] * len(days),
                   [d.isoformat() for d in days])


def test_full_session_variant_reads_full_session_buckets() -> None:
    days = [d for d, _, _ in _sessions(4)]
    full = _full_session(days)
    keep = [i for i in range(len(full.t)) if 0 <= full.minute[i] < 390]
    m = Minutes([full.t[i] for i in keep], [full.o[i] for i in keep], [full.h[i] for i in keep],
                [full.l[i] for i in keep], [full.c[i] for i in keep], [full.v[i] for i in keep], MINUTE_MS,
                [full.session[i] for i in keep], [full.minute[i] for i in keep], full.close_minute, full.scale,
                full.day)
    v8 = Params(**{**SMALL.__dict__, "full_session": True})
    regular = rules.trades(m, SMALL)
    extended = rules.trades(m, v8, full=full)
    assert extended and [(x.entry_bar, x.side) for x in extended] != [(x.entry_bar, x.side) for x in regular]
    assert all(m.session[x.entry_bar] == m.session[x.exit_bar] for x in extended)
    b = rules.buckets(full.t, full.o, full.h, full.l, full.c, full.v, MINUTE_MS, 5, read_at=m.t)
    marked = rules._mark_session_first(b, m)
    first_rth_read = [marked.read[i] for i in range(len(m.t)) if m.minute[i] == 4]
    assert all(marked.session_first[r] for r in first_rth_read)  # the 09:30-09:35 bucket starts each session


def test_entry_window_end_and_signal_bucket_exits() -> None:
    m = minutes(_sessions(8), seed=11)
    early = rules.trades(m, Params(**{**SMALL.__dict__, "entry_end_minute": 300}))
    assert early and all(m.minute[x.entry_bar] <= 301 for x in early)
    bucket_exits = rules.trades(m, Params(**{**SMALL.__dict__, "ce_on_signal": True}))
    for x in bucket_exits:
        if x.exit_reason == "chandelier":
            assert (m.minute[x.exit_bar - 1] + 1) % 5 == 0  # decided at a bucket close
    voters = rules.trades(m, Params(**{**SMALL.__dict__, "exit_on_voters": True}))
    assert any(x.exit_reason == "voters" for x in voters)
    mfi = rules.trades(m, Params(**{**SMALL.__dict__, "at_momentum": "mfi"}))
    assert [(x.entry_bar, x.side) for x in mfi] != [(x.entry_bar, x.side) for x in rules.trades(m, SMALL)]
