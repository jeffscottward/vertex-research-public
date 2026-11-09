"""Macro series metadata (macro_points rows carry it; the server upserts openbb_macro_series)."""

from __future__ import annotations

from typing import Any

from ..values import iso_date, num, rounded

# series id -> (source, name, unit, frequency)
SERIES: dict[str, tuple[str, str, str, str]] = {
    # fed-rates (H.15 / New York Fed reference rates; OpenBB decimals x 100)
    "EFFR": ("federal_reserve", "Effective federal funds rate", "percent", "daily"),
    "SOFR": ("federal_reserve", "Secured overnight financing rate", "percent", "daily"),
    "OBFR": ("federal_reserve", "Overnight bank funding rate", "percent", "daily"),
    "UST1M": ("federal_reserve", "Treasury constant maturity 1 month", "percent", "daily"),
    "UST3M": ("federal_reserve", "Treasury constant maturity 3 months", "percent", "daily"),
    "UST6M": ("federal_reserve", "Treasury constant maturity 6 months", "percent", "daily"),
    "UST1Y": ("federal_reserve", "Treasury constant maturity 1 year", "percent", "daily"),
    "UST2Y": ("federal_reserve", "Treasury constant maturity 2 years", "percent", "daily"),
    "UST5Y": ("federal_reserve", "Treasury constant maturity 5 years", "percent", "daily"),
    "UST10Y": ("federal_reserve", "Treasury constant maturity 10 years", "percent", "daily"),
    "UST30Y": ("federal_reserve", "Treasury constant maturity 30 years", "percent", "daily"),
    # fed-regime
    "NFCI": ("fred", "Chicago Fed National Financial Conditions Index (FRED NFCI)", "index", "weekly"),
    "ANFCI": ("fred", "Chicago Fed Adjusted National Financial Conditions Index (FRED ANFCI)", "index", "weekly"),
    "KCFSI": ("federal_reserve", "Kansas City Fed Financial Stress Index", "index", "monthly"),
    "GSCPI": ("federal_reserve", "New York Fed Global Supply Chain Pressure Index", "index", "monthly"),
    "CBDI": ("federal_reserve", "New York Fed Corporate Bond Market Distress Index", "index", "weekly"),
    "CBDI_IG": ("federal_reserve", "New York Fed Corporate Bond Distress Index, investment grade", "index", "weekly"),
    "CBDI_HY": ("federal_reserve", "New York Fed Corporate Bond Distress Index, high yield", "index", "weekly"),
    "NY_GDP_NOWCAST": ("federal_reserve", "New York Fed Staff Nowcast, real GDP growth (current quarter, SAAR)", "percent", "weekly"),
    "CLEV_CPI_NOWCAST": ("federal_reserve", "Cleveland Fed inflation nowcast, CPI (month over month)", "percent", "monthly"),
    "CLEV_CORE_CPI_NOWCAST": ("federal_reserve", "Cleveland Fed inflation nowcast, core CPI (month over month)", "percent", "monthly"),
    "SOMA_TOTAL": ("federal_reserve", "System Open Market Account holdings, total par value", "usd", "weekly"),
    # treasury-tga
    "TGA": ("us_treasury", "Treasury General Account closing balance (Daily Treasury Statement)", "usd", "daily"),
    # oecd-cli
    "OECD_CLI_USA": ("oecd", "OECD composite leading indicator, United States (amplitude adjusted)", "index", "monthly"),
    # fred-keyless (units as FRED reports them)
    "HY_OAS": ("fred", "ICE BofA US High Yield Index option-adjusted spread (BAMLH0A0HYM2)", "percent", "daily"),
    "IG_OAS": ("fred", "ICE BofA US Corporate Index option-adjusted spread (BAMLC0A0CM)", "percent", "daily"),
    "T10Y3M": ("fred", "10-year minus 3-month Treasury constant maturity (T10Y3M)", "percent", "daily"),
    "T10Y2Y": ("fred", "10-year minus 2-year Treasury constant maturity (T10Y2Y)", "percent", "daily"),
    "RRP": ("fred", "Overnight reverse repurchase agreements, Treasury securities sold (RRPONTSYD)", "billions of usd", "daily"),
    "WALCL": ("fred", "Federal Reserve total assets, Wednesday level (WALCL)", "millions of usd", "weekly"),
    "DTWEXBGS": ("fred", "Nominal broad U.S. dollar index (DTWEXBGS)", "index", "daily"),
    "ICSA": ("fred", "Initial jobless claims, seasonally adjusted (ICSA)", "number", "weekly"),
    "STLFSI4": ("fred", "St. Louis Fed Financial Stress Index (STLFSI4)", "index", "weekly"),
}


def point(series_id: str, day: Any, value: Any, digits: int = 6) -> dict[str, Any]:
    source, name, unit, frequency = SERIES[series_id]
    return {
        "date": iso_date(day),
        "frequency": frequency,
        "name": name,
        "seriesId": series_id,
        "source": source,
        "unit": unit,
        "value": rounded(value, digits),
    }


def percent_point(series_id: str, day: Any, decimal_value: Any) -> dict[str, Any]:
    """A rate OpenBB returns as a decimal (0.0388), stored in percent (3.88)."""
    value = num(decimal_value)
    return point(series_id, day, None if value is None else rounded(value * 100, 6))
