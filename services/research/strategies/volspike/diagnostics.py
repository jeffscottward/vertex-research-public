"""Data diagnostics of the volume-spike-breakout study (research only): what the Dukascopy tick volume and
the quoted spread look like, so the report can show what the "volume spike" measures. Nothing here changes
the rule or a result.
"""
from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from . import data, rules

OVERNIGHT_FROM = 20 * 60  # candles that open from 20:00 ...
OVERNIGHT_TO = 4 * 60  # ... to before 04:00 New York
OPEN_FROM = 9 * 60 + 30
OPEN_TO = 10 * 60


def _median(values: np.ndarray) -> float | None:
    return float(np.median(values)) if values.shape[0] else None


def _month_text(month_index: int) -> str:
    return f"{1970 + month_index // 12:04d}-{month_index % 12 + 1:02d}"


def month_index(day_number: np.ndarray) -> np.ndarray:
    """Months since 1970-01 of day numbers (days since 1970-01-01)."""
    dates = day_number.astype("datetime64[D]").astype("datetime64[M]")
    return dates.astype(np.int64)


def volume_regime(fr: rules.Frame, params: rules.Params) -> dict:
    """Per New York month: 15-minute candles, candles that pass the volume test (all hours and inside the
    signal session), raw signals (volume + breakout), and the median candle volume overnight (20:00 to 04:00)
    and in the first half hour of the cash session (09:30 to 10:00). `noSessionSpikeFrom` is the first month
    from which no candle of the signal session passes the volume test until the end of the data, and
    `sessionDaysAfterLastSessionSpike` the number of New York days with session candles after the last one."""
    cd = fr.cd
    if len(cd) == 0:
        return {"months": [], "lastSpike": None, "lastSessionSpike": None, "lastRawSignal": None,
                "noSessionSpikeFrom": None, "sessionDaysAfterLastSessionSpike": 0, "lastDay": None}
    spike = rules.volume_spike(cd.v, params.vol_mult, params.vol_n)
    session = rules.session_mask(cd, params)
    raw_long, raw_short = rules.raw_signals(cd, params)
    raw = raw_long | raw_short
    minute = cd.open_minute
    overnight = (minute >= OVERNIGHT_FROM) | (minute < OVERNIGHT_TO)
    opening = (minute >= OPEN_FROM) & (minute < OPEN_TO)
    month = month_index(cd.day)
    rows = []
    for value in np.unique(month):
        inside = month == value
        night = _median(cd.v[inside & overnight])
        first = _median(cd.v[inside & opening])
        rows.append({
            "month": _month_text(int(value)), "candles": int(inside.sum()), "spikes": int((inside & spike).sum()),
            "sessionSpikes": int((inside & spike & session).sum()), "rawSignals": int((inside & raw).sum()),
            "sessionRawSignals": int((inside & raw & session).sum()),
            "medianVolumeOvernight": night, "medianVolumeOpen": first,
            "openToOvernight": first / night if first is not None and night else None,
        })

    def last_day(mask: np.ndarray) -> str | None:
        hits = np.flatnonzero(mask)
        return rules.day_text(cd.day[hits[-1]]) if hits.shape[0] else None

    silent_from = None
    for row in reversed(rows):
        if row["sessionSpikes"] > 0:
            break
        silent_from = row["month"]
    if silent_from == rows[0]["month"]:
        silent_from = None  # never any spike: not a regime change
    hits = np.flatnonzero(spike & session)
    after = np.unique(cd.day[session & (cd.day > cd.day[hits[-1]])]).shape[0] if hits.shape[0] else 0
    return {"months": rows, "lastSpike": last_day(spike), "lastSessionSpike": last_day(spike & session),
            "lastRawSignal": last_day(raw & session), "noSessionSpikeFrom": silent_from,
            "sessionDaysAfterLastSessionSpike": int(after), "lastDay": rules.day_text(cd.day[-1])}


def session_spikes_by_year(fr: rules.Frame, params: rules.Params) -> list[dict]:
    """Per New York calendar year: signal-session candles, those that pass the volume test, and raw signals
    (volume + breakout) in the session. Shows whether the rule fires at all on a volume series."""
    cd = fr.cd
    if len(cd) == 0:
        return []
    session = rules.session_mask(cd, params)
    spike = rules.volume_spike(cd.v, params.vol_mult, params.vol_n) & session
    raw_long, raw_short = rules.raw_signals(cd, params)
    raw = (raw_long | raw_short) & session
    year = cd.day.astype("datetime64[D]").astype("datetime64[Y]").astype(np.int64) + 1970
    return [{"year": int(value), "sessionCandles": int((session & (year == value)).sum()),
             "sessionSpikes": int((spike & (year == value)).sum()),
             "sessionRawSignals": int((raw & (year == value)).sum())} for value in np.unique(year)]


def spike_times(fr: rules.Frame, params: rules.Params, start_ms: int, end_ms: int) -> list[dict]:
    """Share of the signal-session candles that pass the volume test, by New York open time of the candle,
    inside [start_ms, end_ms): where in the morning the "volume spike" happens."""
    cd = fr.cd
    inside = (cd.start >= start_ms) & (cd.start < end_ms) & rules.session_mask(cd, params)
    spike = rules.volume_spike(cd.v, params.vol_mult, params.vol_n) & inside
    raw_long, raw_short = rules.raw_signals(cd, params)
    raw = (raw_long | raw_short) & inside
    total_spikes = int(spike.sum())
    total_raw = int(raw.sum())
    rows = []
    for minute in np.unique(cd.open_minute[inside]):
        slot = cd.open_minute == minute
        spikes = int((spike & slot).sum())
        signals = int((raw & slot).sum())
        rows.append({
            "time": f"{int(minute) // 60:02d}:{int(minute) % 60:02d}", "candles": int((inside & slot).sum()),
            "spikes": spikes, "spikeShare": spikes / total_spikes if total_spikes else None,
            "rawSignals": signals, "rawSignalShare": signals / total_raw if total_raw else None,
        })
    return rows


def median_close_by_year(m: rules.Minutes, stop_points: float | None = None) -> list[dict]:
    """Median 1-minute close per New York calendar year, and `stop_points` as a percent of it."""
    if len(m) == 0:
        return []
    day = rules.ny_local_ms(m.t) // rules.DAY_MS
    year = day.astype("datetime64[D]").astype("datetime64[Y]").astype(np.int64) + 1970
    rows = []
    for value in np.unique(year):
        median = float(np.median(m.c[year == value]))
        row = {"year": int(value), "medianClose": median}
        if stop_points is not None and median > 0:
            row["stopPctOfPrice"] = stop_points / median * 100
        rows.append(row)
    return rows


def median_close(m: rules.Minutes, start_ms: int, end_ms: int) -> float | None:
    part = data.window_slice(m.t, start_ms, end_ms)
    closes = m.c[part]
    return float(np.median(closes)) if closes.shape[0] else None


def session_spread(bars: data.MarketBars, params: rules.Params, start_ms: int, end_ms: int) -> dict:
    """Median quoted spread of the 1-minute bars inside the signal session (information only)."""
    part = data.window_slice(bars.minutes.t, start_ms, end_ms)
    t = bars.minutes.t[part]
    minute = (rules.ny_local_ms(t) // rules.MINUTE_MS) % 1440
    index = np.flatnonzero((minute >= params.session_from) & (minute < params.session_to)) + part.start
    return data.spread_at(bars, index)


def spread_by_year(bars: data.MarketBars) -> list[dict]:
    """Median quoted spread per New York calendar year, in basis points of the mid and in price units."""
    m = bars.minutes
    if len(m) == 0:
        return []
    day = rules.ny_local_ms(m.t) // rules.DAY_MS
    year = day.astype("datetime64[D]").astype("datetime64[Y]").astype(np.int64) + 1970
    rows = []
    for value in np.unique(year):
        stats = data.spread_at(bars, np.flatnonzero(year == value))
        rows.append({"year": int(value), **stats})
    return rows


def fill_spread(bars: data.MarketBars, trades: Sequence[rules.Trade]) -> dict:
    """Median quoted spread at the entry and exit minutes of a trade list (information only)."""
    index = [t.entry_index for t in trades] + [t.exit_index for t in trades]
    return data.spread_at(bars, index)


__all__ = ["fill_spread", "median_close", "median_close_by_year", "month_index", "session_spikes_by_year",
           "session_spread", "spread_by_year", "spike_times", "volume_regime"]
