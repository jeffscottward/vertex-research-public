"""Rule module of the leveraged ETF option gate version 2 (strategies/leveraged_etf/spread_gate.py).
Made-up observations only: no network, no file of a run, no clock."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from strategies.leveraged_etf import liquidity, spread_gate as gate
from strategies.leveraged_etf.liquidity import Contract, ExpiryMeasure

NEW_YORK = ZoneInfo("America/New_York")
MONDAY = date(2026, 11, 16)
EXPIRY = date(2026, 11, 20)


def ny(day: date, hour: int, minute: int) -> datetime:
    """A New York wall time as a UTC datetime."""
    return datetime.combine(day, time(hour, minute), NEW_YORK).astimezone(timezone.utc)


def measure_of(quotes: int = 8, spread: float | None = 2.0, mid: float | None = 2.0) -> ExpiryMeasure:
    return ExpiryMeasure(band_open_interest=5000, two_sided_quotes=quotes,
                         half_spread_pct=spread if quotes else None, median_mid=mid if quotes else None)


def cboe(run: str, quoted: datetime, fetched: datetime | None = None, **measure) -> gate.CboeObservation:
    """A Cboe observation whose quotes are of `quoted`: the file timestamp is 15 minutes later."""
    stamp = quoted + timedelta(minutes=15)
    return gate.CboeObservation(run_id=run, fetched_at=fetched or stamp + timedelta(minutes=5), file_timestamp=stamp,
                                spot=50.0, has_expiry=True, measure=measure_of(**measure))


def yahoo(run: str, fetched: datetime, price_age: int = 1, bid: float = 1.9, price_time: datetime | None = None,
          **measure) -> gate.YahooObservation:
    return gate.YahooObservation(
        run_id=run, fetched_at=fetched, fund_price_time=price_time or fetched - timedelta(minutes=price_age),
        spot=50.0, quotes=((50.0, True, bid, 2.1), (50.0, False, 1.9, 2.1)), measure=measure_of(**measure))


def read(source: str, spread: float | None, mid: float | None = 2.0, quotes: int = 8, minute: int = 0) -> gate.Read:
    fetched = ny(MONDAY, 11, minute)
    return gate.Read(run_id=f"2026-11-16/{minute:02d}", source=source, fetched_at=fetched,
                     quote_time=fetched if source == "cboe" else None, two_sided_quotes=quotes,
                     half_spread_pct=spread, median_mid=mid)


def session(day: date, result: str = "inside-limit", expiry: date = EXPIRY) -> gate.SessionResult:
    judged = result != "not-judged"
    return gate.SessionResult(
        day=day, expiry=expiry, source="yahoo", reads=(), value_pct=2.0 if judged else None,
        limit_pct=4 if judged else None, cheap=False if judged else None, in_cheap_band=False if judged else None,
        median_mid=2.0 if judged else None, result=result, other_source=None, other_counted_reads=0,
        other_value_pct=None)


def facts(**changes) -> gate.FundFacts:
    values = dict(file_timestamp=ny(date(2026, 11, 17), 12, 40), fetched_at=ny(date(2026, 11, 17), 12, 46),
                  session_expiry=EXPIRY, has_expiry=True, band_open_interest=5000, spot=50.0,
                  no_standard_contract=False)
    return gate.FundFacts(**{**values, **changes})


def test_constants_come_from_version_1():
    assert gate.REASONS_V2 == (
        "no-listed-options", "no-standard-contract", "no-chain-in-store", "no-recent-chain", "stale-chain",
        "no-window-expiry", "open-interest-below-minimum", "no-two-sided-quote", "too-few-two-sided-quotes",
        "spread-above-maximum", "fewer-than-2-judged-sessions")
    assert gate.GATE_V2 == {
        "version": 2, "minExpirySessions": 3, "entryStart": "10:00", "entryEnd": "15:30",
        "halfDayEndBeforeCloseMinutes": 30, "cboeQuoteDelayMinutes": 15, "yahooMarginMinutes": 15,
        "yahooMaxFundPriceAgeMinutes": 30, "bandPct": 10, "minBandOpenInterest": 1000, "spreadStrikes": 4,
        "minTwoSidedQuotes": 3, "maxHalfSpreadPct": 4, "cheapMaxMidUsd": 1, "cheapBandMaxHalfSpreadPct": 8,
        "minReadsPerSession": 2, "minSessions": 2, "sessionLookback": 25, "freshSessions": 5,
        "maxChainAgeDays": 4}
    assert (gate.ENTRY_START, gate.ENTRY_END) == (time(10, 0), time(15, 30))


@pytest.mark.parametrize("day, expiry", [
    ("2026-11-12", "2026-11-20"), ("2026-11-16", "2026-11-20"), ("2026-11-17", "2026-11-20"),
    ("2026-11-18", "2026-11-27"), ("2026-11-19", "2026-11-27"), ("2026-11-20", "2026-11-27"),
    ("2026-11-23", "2026-11-27"), ("2026-11-24", "2026-12-04"),
    ("2027-03-22", "2027-03-25"),  # Good Friday 2027-03-26 is closed: the Thursday before it
])
def test_session_expiry(day, expiry):
    assert gate.session_expiry(date.fromisoformat(day)) == date.fromisoformat(expiry)


def test_entry_hours():
    assert gate.entry_hours(MONDAY) == (time(10, 0), time(15, 30))
    assert gate.entry_hours(date(2026, 11, 27)) == (time(10, 0), time(12, 30))  # half day, close 13:00
    assert gate.entry_hours(date(2026, 11, 14)) is None  # Saturday
    assert gate.entry_hours(date(2026, 11, 26)) is None  # Thanksgiving


def test_sessions_back_skips_closed_days():
    assert gate.sessions_back(date(2026, 11, 30), 4) == [
        date(2026, 11, 30), date(2026, 11, 27), date(2026, 11, 25), date(2026, 11, 24)]
    assert gate.sessions_back(date(2026, 11, 15), 2) == [date(2026, 11, 13), date(2026, 11, 12)]  # from a Sunday


def contract(strike: float, call: bool, bid: float, ask: float, open_interest: int = 100) -> Contract:
    return Contract(expiry=EXPIRY, strike=strike, call=call, bid=bid, ask=ask, open_interest=open_interest)


def test_expiry_measure_of_8_two_sided_contracts():
    rows = [contract(strike, call, *((1.9, 2.1) if call else (0.95, 1.05)))
            for strike in (48.0, 49.0, 50.0, 51.0) for call in (True, False)]
    rows.append(contract(60.0, True, 0.1, 0.2, open_interest=7))  # outside the band, not a near strike
    rows.append(Contract(date(2026, 11, 27), 50.0, True, 1.0, 3.0, 9))  # another expiry
    assert liquidity.expiry_measure(rows, 50.0, EXPIRY) == ExpiryMeasure(
        band_open_interest=800, two_sided_quotes=8, half_spread_pct=5.0, median_mid=1.5,
        median_width=0.15)


def test_expiry_measure_of_2_two_sided_contracts():
    rows = [contract(50.0, True, 1.9, 2.1), contract(50.0, False, 0.98, 1.02), contract(51.0, True, 0.0, 0.5),
            contract(49.0, False, 1.0, 1.0)]
    assert liquidity.expiry_measure(rows, 50.0, EXPIRY) == ExpiryMeasure(
        band_open_interest=400, two_sided_quotes=2, half_spread_pct=3.5, median_mid=1.5,
        median_width=0.12)


def test_expiry_measure_without_a_two_sided_contract():
    rows = [contract(50.0, True, 0.0, 0.5), contract(50.0, False, 0.0, 0.0)]
    assert liquidity.expiry_measure(rows, 50.0, EXPIRY) == ExpiryMeasure(
        band_open_interest=200, two_sided_quotes=0, half_spread_pct=None, median_mid=None)


def chain(symbol: str = "TQQQ", options=None) -> dict:
    options = options if options is not None else [
        {"option": "TQQQ261120C00050000", "bid": 1.9, "ask": 2.1, "open_interest": 600},
        {"option": "TQQQ261120P00050000", "bid": 1.9, "ask": 2.1, "open_interest": 500},
        {"option": "TQQQ261127C00050000", "bid": 2.0, "ask": 3.0, "open_interest": 50},
        {"option": "TQQQ1261120C00050000", "bid": 1.0, "ask": 3.0, "open_interest": 9000}]
    return {"timestamp": "2026-11-16 17:40:12", "symbol": symbol,
            "data": {"symbol": symbol, "current_price": 50.0, "options": options}}


def test_cboe_observation_measures_the_given_expiry():
    fetched = datetime(2026, 11, 16, 17, 45, tzinfo=timezone.utc)
    seen = gate.cboe_observation(chain(), "TQQQ", EXPIRY, "2026-11-16/174501Z", fetched)
    assert seen == gate.CboeObservation(
        run_id="2026-11-16/174501Z", fetched_at=fetched,
        file_timestamp=datetime(2026, 11, 16, 17, 40, 12, tzinfo=timezone.utc), spot=50.0, has_expiry=True,
        measure=ExpiryMeasure(band_open_interest=1100, two_sided_quotes=2, half_spread_pct=5.0, median_mid=2.0,
                              median_width=0.2))


def test_cboe_observation_without_the_expiry_and_without_a_standard_contract():
    fetched = datetime(2026, 11, 16, 17, 45, tzinfo=timezone.utc)
    other = gate.cboe_observation(chain(), "TQQQ", date(2026, 12, 4), "run", fetched)
    assert (other.has_expiry, other.measure) == (False, None)
    expired = [{"option": "TQQQ261113C00050000", "bid": 1.0, "ask": 1.1, "open_interest": 5}]
    assert gate.cboe_observation(chain(options=expired), "TQQQ", EXPIRY, "run", fetched) \
        is liquidity.NO_STANDARD_CONTRACT
    with pytest.raises(ValueError, match="not of TQQQ"):
        gate.cboe_observation(chain("SQQQ"), "TQQQ", EXPIRY, "run", fetched)


def snapshot(rows: list[dict]) -> dict:
    return {"fetchedAt": "2026-11-16T15:47:02Z", "expiry": "2026-11-20", "fundPrice": 50.0,
            "fundPriceTime": "2026-11-16T15:46:55Z", "rows": rows}


def test_yahoo_observation_with_quotes():
    rows = [{"strike": 50.0, "call": True, "bid": 1.9, "ask": 2.1, "lastTradeAt": "2026-11-16T15:40:03Z"},
            {"strike": 50.0, "call": False, "bid": 0.98, "ask": 1.02, "lastTradeAt": None},
            {"strike": 51.0, "call": True, "bid": None, "ask": 0.5, "lastTradeAt": None}]
    seen = gate.yahoo_observation(snapshot(rows), "2026-11-16/154501Z")
    assert seen == gate.YahooObservation(
        run_id="2026-11-16/154501Z", fetched_at=datetime(2026, 11, 16, 15, 47, 2, tzinfo=timezone.utc),
        fund_price_time=datetime(2026, 11, 16, 15, 46, 55, tzinfo=timezone.utc), spot=50.0,
        quotes=((50.0, False, 0.98, 1.02), (50.0, True, 1.9, 2.1), (51.0, True, 0.0, 0.5)),
        measure=ExpiryMeasure(band_open_interest=0, two_sided_quotes=2, half_spread_pct=3.5, median_mid=1.5,
        median_width=0.12))


def test_yahoo_observation_without_quotes_is_none():
    rows = [{"strike": 50.0, "call": True, "bid": 0.0, "ask": 0.0, "lastTradeAt": None},
            {"strike": 50.0, "call": False, "bid": None, "ask": None, "lastTradeAt": None}]
    assert gate.yahoo_observation(snapshot(rows), "run") is None
    assert gate.yahoo_observation(snapshot([]), "run") is None


def counted(cboe_seen=(), yahoo_seen=(), before=frozenset()):
    cboe_reads, yahoo_reads = gate.counted_reads(MONDAY, cboe_seen, yahoo_seen, before)
    return [item.run_id for item in cboe_reads], [item.run_id for item in yahoo_reads]


def test_a_cboe_file_counts_inside_the_entry_hours_and_once_per_file_timestamp():
    reads, _ = gate.counted_reads(MONDAY, [cboe("a", ny(MONDAY, 10, 30), spread=2.5, mid=1.2)], [], frozenset())
    assert reads == [gate.Read(run_id="a", source="cboe", fetched_at=ny(MONDAY, 10, 50),
                               quote_time=ny(MONDAY, 10, 30), two_sided_quotes=8, half_spread_pct=2.5, median_mid=1.2)]
    same = [cboe(run, ny(MONDAY, 10, 30), fetched=ny(MONDAY, hour, 45)) for run, hour in (("c", 14), ("a", 10), ("b", 12))]
    assert counted(same) == (["a"], [])
    assert counted([cboe("a", ny(MONDAY, 10, 30)), cboe("b", ny(MONDAY, 12, 30))]) == (["a", "b"], [])


def test_a_cboe_file_of_an_earlier_run_or_outside_the_entry_hours_does_not_count():
    again = cboe("a", ny(MONDAY, 10, 30))
    assert counted([again], before=frozenset({again.file_timestamp})) == ([], [])  # a run of the day before had it
    friday = cboe("a", ny(date(2026, 11, 13), 15, 20), fetched=ny(MONDAY, 10, 45))
    assert counted([friday]) == ([], [])  # its quotes are of another day
    assert counted([cboe("a", ny(MONDAY, 9, 50))]) == ([], [])
    assert counted([cboe("a", ny(MONDAY, 15, 30)), cboe("b", ny(MONDAY, 15, 31))]) == (["a"], [])
    assert counted([cboe("a", ny(date(2026, 11, 14), 10, 30))]) == ([], [])  # Saturday is no session
    assert gate.counted_reads(date(2026, 11, 14), [cboe("a", ny(date(2026, 11, 14), 10, 30))], [], frozenset()) \
        == ([], [])


def test_a_yahoo_observation_counts_from_15_minutes_after_the_start_of_the_entry_hours():
    assert counted(yahoo_seen=[yahoo("a", ny(MONDAY, 10, 10))]) == ([], [])
    assert counted(yahoo_seen=[yahoo("a", ny(MONDAY, 10, 15))]) == ([], ["a"])
    assert counted(yahoo_seen=[yahoo("a", ny(MONDAY, 15, 30))]) == ([], ["a"])
    assert counted(yahoo_seen=[yahoo("a", ny(MONDAY, 15, 31))]) == ([], [])
    _, reads = gate.counted_reads(MONDAY, [], [yahoo("a", ny(MONDAY, 10, 45), spread=2.6, mid=2.9)], frozenset())
    assert reads == [gate.Read(run_id="a", source="yahoo", fetched_at=ny(MONDAY, 10, 45), quote_time=None,
                               two_sided_quotes=8, half_spread_pct=2.6, median_mid=2.9)]


def test_a_yahoo_observation_needs_a_fund_price_of_the_session_at_most_30_minutes_old():
    at = ny(MONDAY, 10, 20)
    assert counted(yahoo_seen=[yahoo("a", at, price_time=ny(date(2026, 11, 13), 15, 59))]) == ([], [])
    assert counted(yahoo_seen=[yahoo("a", at, price_age=31)]) == ([], [])
    assert counted(yahoo_seen=[yahoo("a", at, price_age=30)]) == ([], ["a"])
    no_time = gate.YahooObservation("a", at, None, 50.0, yahoo("a", at).quotes, measure_of())
    assert counted(yahoo_seen=[no_time]) == ([], [])


def test_a_fund_price_time_after_the_fetch_time_counts_only_inside_the_clock_skew():
    at = ny(MONDAY, 10, 20)
    assert counted(yahoo_seen=[yahoo("a", at, price_age=-5)]) == ([], ["a"])  # two clocks: up to 5 minutes
    assert counted(yahoo_seen=[yahoo("a", at, price_age=-6)]) == ([], [])


def test_the_entry_hours_start_at_10_00_for_a_cboe_quote_time():
    assert counted([cboe("a", ny(MONDAY, 10, 0)), cboe("b", ny(MONDAY, 9, 59))]) == (["a"], [])


def test_counted_reads_on_a_half_day_end_at_12_30():
    half_day = date(2026, 11, 27)  # close 13:00
    cboe_reads, yahoo_reads = gate.counted_reads(
        half_day, [cboe("a", ny(half_day, 12, 30)), cboe("b", ny(half_day, 12, 31))],
        [yahoo("c", ny(half_day, 10, 45)), yahoo("d", ny(half_day, 12, 45), bid=1.8)], frozenset())
    assert [item.run_id for item in cboe_reads] == ["a"]
    assert [item.run_id for item in yahoo_reads] == ["c"]  # the run of 12:45 is after the entry hours


def test_an_unchanged_yahoo_quote_set_counts_once():
    first, same = yahoo("a", ny(MONDAY, 10, 45)), yahoo("b", ny(MONDAY, 12, 45))
    changed = yahoo("c", ny(MONDAY, 14, 45), bid=1.95)
    assert counted(yahoo_seen=[same, first]) == ([], ["a"])
    assert counted(yahoo_seen=[first, same, changed]) == ([], ["a", "c"])
    early = yahoo("e", ny(MONDAY, 10, 5))  # not counted, so it is not "the last counted one"
    assert counted(yahoo_seen=[early, first]) == ([], ["a"])


def result_of(cboe_reads, yahoo_reads) -> gate.SessionResult:
    return gate.session_result(MONDAY, EXPIRY, cboe_reads, yahoo_reads)


def test_two_counted_cboe_reads_make_cboe_the_session_source():
    cboe_reads = [read("cboe", 3.0, minute=1), read("cboe", 5.0, minute=2)]
    yahoo_reads = [read("yahoo", 1.0, minute=3), read("yahoo", 2.0, minute=4), read("yahoo", 6.0, minute=5)]
    assert result_of(cboe_reads, yahoo_reads) == gate.SessionResult(
        day=MONDAY, expiry=EXPIRY, source="cboe", reads=tuple(cboe_reads), value_pct=4.0, limit_pct=4, cheap=False,
        in_cheap_band=False, median_mid=2.0, result="inside-limit", other_source="yahoo", other_counted_reads=3,
        other_value_pct=2.0, expiry_type="monthly", worst_read_pct=5.0, read_range_pct=2.0, median_width=None)


def test_one_counted_cboe_read_leaves_yahoo_as_the_session_source():
    seen = result_of([read("cboe", 5.09)], [read("yahoo", 2.0, minute=3), read("yahoo", 3.0, minute=4)])
    assert (seen.source, seen.value_pct, seen.result) == ("yahoo", 2.5, "inside-limit")
    assert (seen.other_source, seen.other_counted_reads, seen.other_value_pct) == ("cboe", 1, 5.09)


def test_one_counted_read_is_not_judged():
    seen = result_of([], [read("yahoo", 2.0)])
    assert (seen.source, seen.result, seen.other_source, seen.other_counted_reads) == ("yahoo", "not-judged", None, 0)
    assert (seen.value_pct, seen.limit_pct, seen.cheap, seen.in_cheap_band, seen.median_mid) == (None,) * 5
    assert len(seen.reads) == 1
    nothing = result_of([], [])
    assert (nothing.source, nothing.result, nothing.reads) == (None, "not-judged", ())


def test_two_counted_reads_without_a_two_sided_quote():
    seen = result_of([], [read("yahoo", None, None, quotes=0), read("yahoo", None, None, quotes=0, minute=1)])
    assert (seen.result, seen.value_pct, seen.limit_pct, seen.cheap, seen.in_cheap_band, seen.median_mid) == (
        "no-two-sided-quote", None, 4, None, None, None)


def test_two_counted_reads_of_which_one_is_quotable():
    seen = result_of([], [read("yahoo", 2.0, quotes=3), read("yahoo", 1.0, quotes=2, minute=1)])
    assert (seen.result, seen.value_pct, seen.cheap) == ("too-few-two-sided-quotes", None, None)
    assert len(seen.reads) == 2  # the read that is not quotable is kept


@pytest.mark.parametrize("spreads, mid, value, result, cheap, in_cheap_band", [
    ((3.0, 5.0), 2.0, 4.0, "inside-limit", False, False),  # a value equal to the limit is inside it
    ((4.0, 5.0), 2.0, 4.5, "spread-above-maximum", False, False),
    ((7.0, 9.0), 0.99, 8.0, "spread-above-maximum", True, True),
    ((7.0, 9.0), 1.00, 8.0, "spread-above-maximum", False, False),  # exactly 1 USD is not cheap
    ((8.0, 9.0), 0.5, 8.5, "spread-above-maximum", True, False),
    ((3.0, 4.0), 0.5, 3.5, "inside-limit", True, False),
])
def test_session_value_limit_and_cheap_band(spreads, mid, value, result, cheap, in_cheap_band):
    seen = result_of([], [read("yahoo", spread, mid, minute=index) for index, spread in enumerate(spreads)])
    assert (seen.value_pct, seen.limit_pct, seen.result, seen.cheap, seen.in_cheap_band, seen.median_mid) == (
        value, 4, result, cheap, in_cheap_band, mid)


def test_the_session_value_is_rounded_before_it_is_compared():
    seen = result_of([], [read("yahoo", 4.0), read("yahoo", 4.00008, minute=1)])
    assert (seen.value_pct, seen.result) == (4.0, "inside-limit")


BUILD_DAY = date(2026, 11, 18)
TWO_SESSIONS = [session(date(2026, 11, 17)), session(date(2026, 11, 18))]  # both of the monthly expiry


def label(sessions=TWO_SESSIONS, listed=True, universe_reasons=(), fund_facts="default", build_day=BUILD_DAY,
          kind="monthly", newest="same"):
    """`newest` (the newest Cboe fact of any type) is `fund_facts` unless given."""
    fund_facts = facts() if fund_facts == "default" else fund_facts
    return gate.fund_label(listed, universe_reasons, fund_facts if newest == "same" else newest, fund_facts,
                           sessions, build_day, kind)


def test_a_fund_without_listed_options_fails_with_the_reason_of_the_universe_file():
    assert label(listed=False, universe_reasons=["no-listed-options"], fund_facts=None) == (
        "fail", ["no-listed-options"])
    assert label(listed=False, universe_reasons=["no-standard-contract"], fund_facts=None) == (
        "fail", ["no-standard-contract"])


def test_a_fund_without_a_cboe_fact_in_the_lookback_is_not_measured():
    assert label(fund_facts=None) == ("spread-not-measured", ["no-chain-in-store"])
    old = facts(file_timestamp=ny(date(2026, 10, 13), 12, 40), fetched_at=ny(date(2026, 10, 13), 12, 46))
    # a fresh newest fact, but the fact of the type is before the 25 sessions of the lookback
    assert label(fund_facts=old, newest=facts()) == ("spread-not-measured", ["no-chain-in-store"])


def test_stale_chain_is_more_than_4_new_york_days_before_the_fetch():
    stale = facts(file_timestamp=ny(date(2026, 11, 12), 23, 30))  # 5 days before 2026-11-17
    assert label(fund_facts=stale) == ("fail", ["stale-chain"])
    assert label(fund_facts=facts(file_timestamp=ny(date(2026, 11, 13), 0, 30))) == ("pass", [])  # 4 days


def test_fail_reasons_of_the_newest_cboe_fact():
    assert label(fund_facts=facts(no_standard_contract=True, has_expiry=False, band_open_interest=None)) == (
        "fail", ["no-standard-contract"])
    assert label(fund_facts=facts(has_expiry=False, band_open_interest=None)) == ("fail", ["no-window-expiry"])
    assert label(fund_facts=facts(band_open_interest=999)) == ("fail", ["open-interest-below-minimum"])
    assert label(fund_facts=facts(band_open_interest=1000)) == ("pass", [])


def test_a_spread_label_needs_2_judged_sessions():
    reason = ("spread-not-measured", ["fewer-than-2-judged-sessions"])
    assert label(sessions=[]) == reason
    assert label(sessions=[session(date(2026, 11, 17)), session(date(2026, 11, 18), "not-judged")]) == reason
    assert label(sessions=[session(date(2026, 11, 18), "spread-above-maximum")]) == reason
    out_of_lookback = [session(date(2026, 10, 13)), session(date(2026, 11, 18))]  # 2026-10-13: before the lookback
    assert label(sessions=out_of_lookback) == reason


def test_pass_with_2_sessions_of_the_type_and_fail_on_the_older_session():
    assert label() == ("pass", [])
    older_fails = [session(date(2026, 11, 18)), session(date(2026, 11, 17), "spread-above-maximum")]
    assert label(sessions=older_fails) == ("fail", ["spread-above-maximum"])


def test_only_the_2_newest_judged_sessions_decide():
    sessions = [session(date(2026, 11, 16), "spread-above-maximum"), session(date(2026, 11, 18)),
                session(date(2026, 11, 17))]
    assert label(sessions=sessions) == ("pass", [])
    skipped = [session(date(2026, 11, 16), "spread-above-maximum"), session(date(2026, 11, 17), "not-judged"),
               session(date(2026, 11, 18))]
    assert label(sessions=skipped) == ("fail", ["spread-above-maximum"])


def test_fail_reasons_are_in_the_order_of_the_reason_list_each_one_once():
    both_few = [session(date(2026, 11, 17), "too-few-two-sided-quotes"),
                session(date(2026, 11, 18), "too-few-two-sided-quotes")]
    assert label(sessions=both_few) == ("fail", ["too-few-two-sided-quotes"])
    mixed = [session(date(2026, 11, 17), "spread-above-maximum"),
             session(date(2026, 11, 18), "too-few-two-sided-quotes")]
    assert label(sessions=mixed) == ("fail", ["too-few-two-sided-quotes", "spread-above-maximum"])
    no_quote = [session(date(2026, 11, 17), "no-two-sided-quote"), session(date(2026, 11, 18))]
    assert label(sessions=no_quote) == ("fail", ["no-two-sided-quote"])


def test_the_module_loads_with_the_standard_library_alone():
    root = Path(__file__).resolve().parents[1]
    done = subprocess.run(
        [sys.executable, "-S", "-c", "import strategies.leveraged_etf.spread_gate"],
        env={**os.environ, "PYTHONPATH": str(root)}, cwd=root, capture_output=True, text=True, check=False)
    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize(("expiry", "kind"), [
    (date(2026, 11, 20), "monthly"), (date(2026, 11, 27), "weekly"),
    (date(2026, 6, 18), "monthly"),  # Juneteenth (Friday 2026-06-19) moves the June 2026 monthly to Thursday
    (date(2025, 4, 17), "monthly"),  # Good Friday 2025-04-18
])
def test_expiry_type_of_the_monthly_and_weekly_expiries(expiry, kind):
    assert gate.expiry_type(expiry) == kind


def test_juneteenth_2026_is_no_session():
    assert not gate.is_session(date(2026, 6, 19))


_READS = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "spread_reads.py"
_reads_spec = importlib.util.spec_from_file_location("leveraged_etf_spread_reads", _READS)
spread_reads = importlib.util.module_from_spec(_reads_spec)
_reads_spec.loader.exec_module(spread_reads)


def test_the_lookback_holds_2_sessions_of_each_type_and_fits_the_retention():
    """Every calendar day of 2026 and 2027 as the build day (sessions_back starts at the newest session)."""
    lookback = gate.GATE_V2["sessionLookback"]
    day = date(2026, 1, 1)
    while day <= date(2027, 12, 31):
        sessions = gate.sessions_back(day, lookback)
        types = [gate.expiry_type(gate.session_expiry(item)) for item in sessions]
        assert types.count("weekly") >= 2 and types.count("monthly") >= 2, day
        loaded = gate.sessions_back(day, lookback + 1)
        assert (day - loaded[-1]).days <= spread_reads.RETENTION_DAYS, day
        day += timedelta(days=1)


WEEKLY = date(2026, 11, 27)


def test_each_type_label_reads_the_fact_of_its_type():
    weekly_fact = facts(session_expiry=WEEKLY, has_expiry=False, band_open_interest=None)
    assert label(kind="monthly") == ("pass", [])
    assert label(kind="weekly", fund_facts=weekly_fact) == ("fail", ["no-window-expiry"])


def test_a_fact_of_the_other_type_is_no_chain_in_store():
    assert label(kind="weekly") == ("spread-not-measured", ["no-chain-in-store"])
    weekly_fact = facts(session_expiry=WEEKLY)
    assert label(kind="monthly", fund_facts=weekly_fact) == ("spread-not-measured", ["no-chain-in-store"])


def test_a_monthly_fact_20_sessions_old_is_inside_the_lookback():
    old_day = gate.sessions_back(BUILD_DAY, 21)[-1]  # 20 sessions before the build day
    old = facts(file_timestamp=ny(old_day, 12, 40), fetched_at=ny(old_day, 12, 46))
    assert label(fund_facts=old, newest=facts()) == ("pass", [])


def test_a_type_label_reads_only_the_sessions_of_its_type():
    weekly_sessions = [session(date(2026, 11, 23), expiry=WEEKLY), session(date(2026, 11, 24), expiry=WEEKLY)]
    weekly_fact = facts(session_expiry=WEEKLY, fetched_at=ny(date(2026, 11, 24), 12, 46),
                        file_timestamp=ny(date(2026, 11, 24), 12, 40))
    build = date(2026, 11, 24)
    assert label(sessions=TWO_SESSIONS + weekly_sessions, kind="weekly", fund_facts=weekly_fact,
                 build_day=build) == ("pass", [])
    assert [item.day for item in gate.judged_sessions(TWO_SESSIONS + weekly_sessions, build, "monthly")] == [
        date(2026, 11, 18), date(2026, 11, 17)]
    assert label(sessions=weekly_sessions, build_day=build, newest=weekly_fact) == (
        "spread-not-measured", ["fewer-than-2-judged-sessions"])


def test_session_diagnostics():
    reads = [replace(read("cboe", 3.0, minute=1), median_width=0.1),
             replace(read("cboe", 5.5, minute=2), median_width=0.3),
             replace(read("cboe", 4.0, minute=3), median_width=None)]
    seen = result_of(reads, [])
    assert (seen.expiry_type, seen.worst_read_pct, seen.read_range_pct, seen.median_width) == (
        "monthly", 5.5, 2.5, 0.2)
    one = result_of([read("cboe", 3.0, minute=1), read("cboe", None, quotes=0, minute=2)], [])
    assert (one.worst_read_pct, one.read_range_pct, one.median_width) == (3.0, None, None)


def test_expiry_measure_median_width_is_the_median_of_ask_minus_bid():
    rows = [contract(50.0, True, 1.9, 2.1), contract(50.0, False, 0.9, 1.3), contract(51.0, True, 1.0, 1.1)]
    assert liquidity.expiry_measure(rows, 50.0, EXPIRY).median_width == 0.2


def test_a_newest_fact_older_than_5_sessions_is_no_recent_chain_for_both_types():
    old_day = gate.sessions_back(BUILD_DAY, 6)[-1]  # 5 sessions before the build day: outside the 5 fresh sessions
    old = facts(file_timestamp=ny(old_day, 12, 40), fetched_at=ny(old_day, 12, 46))
    for kind in gate.EXPIRY_TYPES:
        assert label(fund_facts=old, kind=kind) == ("spread-not-measured", ["no-recent-chain"])
    fresh_day = gate.sessions_back(BUILD_DAY, 5)[-1]
    fresh = facts(file_timestamp=ny(fresh_day, 12, 40), fetched_at=ny(fresh_day, 12, 46))
    assert label(fund_facts=fresh) == ("pass", [])


def test_stale_chain_and_no_standard_contract_come_from_the_newest_fact_of_any_type():
    weekly_newest = dict(session_expiry=WEEKLY, fetched_at=ny(BUILD_DAY, 12, 46))
    stale = facts(file_timestamp=ny(date(2026, 11, 13), 12, 0), **weekly_newest)
    assert label(newest=stale) == ("fail", ["stale-chain"])
    no_standard = facts(file_timestamp=ny(BUILD_DAY, 12, 40), no_standard_contract=True, **weekly_newest)
    assert label(newest=no_standard) == ("fail", ["no-standard-contract"])
