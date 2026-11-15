"""qc-ports calendar: monthly expirations, holidays and the DSL calendar windows."""
from datetime import date

import pytest

from strategies.qc_ports.calendar import (
    TradingCalendar,
    easter,
    expirations_after,
    in_months,
    is_nyse_holiday,
    month_offsets,
    monthly_expiration,
    opex_window,
    turn_of_month,
)
from tests.qc_ports_synthetic import trading_days


def test_easter_and_holidays():
    assert easter(2024) == date(2024, 3, 31)
    assert easter(2025) == date(2025, 4, 20)
    assert is_nyse_holiday(date(2025, 4, 18))  # Good Friday
    assert is_nyse_holiday(date(2026, 6, 19))  # Juneteenth (since 2022)
    assert not is_nyse_holiday(date(2021, 6, 18))
    assert is_nyse_holiday(date(2021, 7, 5))  # July 4 on a Sunday -> Monday
    assert is_nyse_holiday(date(2022, 12, 26))  # Christmas on a Sunday -> Monday
    assert is_nyse_holiday(date(2024, 1, 15))  # MLK
    assert is_nyse_holiday(date(2024, 11, 28))  # Thanksgiving
    assert is_nyse_holiday(date(2024, 5, 27))  # Memorial Day
    assert is_nyse_holiday(date(2024, 9, 2))  # Labor Day
    assert is_nyse_holiday(date(2024, 2, 19))  # Presidents Day
    assert is_nyse_holiday(date(2024, 1, 1))
    assert not is_nyse_holiday(date(2021, 12, 31))  # Saturday New Year is not observed on Friday
    assert not is_nyse_holiday(date(2024, 3, 15))


def test_monthly_expiration_is_third_friday_or_prior_trading_day():
    assert monthly_expiration(2024, 2) == date(2024, 2, 16)
    assert monthly_expiration(2024, 3) == date(2024, 3, 15)
    assert monthly_expiration(2025, 4) == date(2025, 4, 17)  # Good Friday
    assert monthly_expiration(2026, 6) == date(2026, 6, 18)  # Juneteenth
    calendar = TradingCalendar(trading_days("2025-04-01", 20))
    assert monthly_expiration(2025, 4, calendar) == date(2025, 4, 17)
    # Inside the bar dates a missing Friday is a holiday; after them the rules apply.
    gappy = TradingCalendar(["2024-02-14", "2024-02-15", "2024-02-20"])
    assert monthly_expiration(2024, 2, gappy) == date(2024, 2, 15)
    assert monthly_expiration(2026, 6, gappy) == date(2026, 6, 18)
    with pytest.raises(ValueError):
        TradingCalendar([])


def test_expirations_after():
    assert expirations_after("2024-01-03", 2) == [date(2024, 1, 19), date(2024, 2, 16), date(2024, 3, 15)]
    assert expirations_after("2024-01-20", 1) == [date(2024, 2, 16)]
    assert expirations_after(date(2024, 1, 19), 0) == [date(2024, 1, 19)]


def test_month_offsets_and_turn_of_month():
    dates = trading_days("2024-01-25", 10)  # Jan 25..31 (5 days), Feb 1..7 (5 days)
    offsets = month_offsets(dates)
    # January before the data is completed with the rules: Jan 2..24 hold 16 trading days.
    assert offsets[0] == (17, -5)
    assert offsets[4] == (21, -1)  # Jan 31 = last trading day
    assert offsets[5][0] == 1  # Feb 1
    # Feb is completed with the NYSE rules: Feb 2024 has 20 trading days.
    assert offsets[5] == (1, -20)
    assert offsets[9] == (5, -16)
    window = turn_of_month(dates, -2, 3)
    assert window == [False, False, False, True, True, True, True, True, False, False]
    assert month_offsets([]) == []
    with pytest.raises(ValueError, match="fromDay"):
        turn_of_month(dates, 0, 3)
    with pytest.raises(ValueError, match="fromDay"):
        turn_of_month(dates, -1, 11)


def test_opex_window():
    dates = trading_days("2024-02-05", 15)  # Feb 5 .. Feb 26 (Feb 19 holiday)
    window = dict(zip(dates, opex_window(dates)))
    # Opex Fri Feb 16; its week starts Mon Feb 12; the prior trading day is Fri Feb 9.
    assert [day for day, hit in window.items() if hit] == [
        "2024-02-09", "2024-02-12", "2024-02-13", "2024-02-14", "2024-02-15", "2024-02-16"]
    assert opex_window([]) == []
    # Good Friday 2025: expiration Thu Apr 17, window from Fri Apr 11.
    april = trading_days("2025-04-07", 12)
    assert [d for d, hit in zip(april, opex_window(april)) if hit] == [
        "2025-04-11", "2025-04-14", "2025-04-15", "2025-04-16", "2025-04-17"]


def test_in_months():
    assert in_months(["2024-01-31", "2024-02-01", "2024-12-02"], [1, 12]) == [True, False, True]
    with pytest.raises(ValueError, match="months"):
        in_months(["2024-01-31"], [13])
    with pytest.raises(ValueError, match="months"):
        in_months(["2024-01-31"], [])
