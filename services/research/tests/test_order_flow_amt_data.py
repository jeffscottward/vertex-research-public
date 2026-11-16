"""Order flow / AMT auction study: loaders of bars, ex-dividend dates and order-flow minutes (synthetic files)."""
from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from strategies.noise_band import Bar, Session
from strategies.order_flow_amt import data

ET = ZoneInfo("America/New_York")


def _write_month(path, day: date, close: float = 100.0) -> None:
    rows = []
    for k in range(78):
        t = datetime(day.year, day.month, day.day, 9, 30, tzinfo=ET).timestamp() + 300 * k
        rows.append(f"{int(t)},{close},{close + 0.1},{close - 0.1},{close},1000")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write("\n".join(rows) + "\n")


def test_load_symbol_extends_ib_sessions_with_later_yahoo_sessions(tmp_path):
    _write_month(tmp_path / "ib" / "QQQ" / "2026-11.csv", date(2026, 11, 5))
    _write_month(tmp_path / "ib" / "QQQ" / "2026-11.csv", date(2026, 11, 6))
    _write_month(tmp_path / "yahoo" / "QQQ" / "2026.csv", date(2026, 11, 6), 200.0)
    _write_month(tmp_path / "yahoo" / "QQQ" / "2026.csv", date(2026, 11, 9), 200.0)
    sources = data.Sources(ib=tmp_path / "ib", yahoo=tmp_path / "yahoo")
    sessions, info = data.load_symbol("QQQ", sources)
    assert [s.day.isoformat() for s in sessions] == ["2026-11-05", "2026-11-06", "2026-11-09"]
    assert sessions[1].bars[0].close == 100.0 and sessions[2].bars[0].close == 200.0
    assert info["yahoo"] == {"added": 1, "first": "2026-11-09"} and info["sessions"] == 3


def test_extend_and_hash(tmp_path):
    a = Session(date(2026, 1, 2), (Bar(0, 1, 1, 1, 1, 1),))
    b = Session(date(2026, 1, 5), (Bar(0, 2, 2, 2, 2, 1),))
    assert data.extend([], [a]) == [a] and data.extend([a], [a, b]) == [a, b]
    f = tmp_path / "x.csv"
    f.write_text("1")
    first = data.data_hash([f])
    f.write_text("2")
    assert data.data_hash([f]) != first


def test_ex_dates_and_input_files(tmp_path):
    (tmp_path / "div").mkdir()
    (tmp_path / "div" / "SPY.csv").write_text("ex_date,amount\n2026-09-18,1.889\n")
    sources = data.Sources(ib=tmp_path / "ib", dividends=tmp_path / "div")
    assert data.ex_dates_of(sources) == {"SPY": frozenset({"2026-09-18"}), "QQQ": frozenset()}
    assert data.input_files(sources) == [tmp_path / "div" / "SPY.csv"]


def test_read_flow_minutes_checks_columns(tmp_path):
    path = tmp_path / "flow.csv"
    path.write_text("symbol,minute_ms,delta,buy_volume,sell_volume,volume,covered_seconds,trades,close\n"
                    "ES,60000,-5,1,6,7,60,3,7000\nSPY,60000,,,,,,,\n")
    rows = data.read_flow_minutes(path)
    assert rows[0] == data.FlowMinute("ES", 60000, -5.0, 7.0, 60)
    assert rows[1].delta == 0.0
    assert data.by_symbol(rows)["ES"][60000].delta == -5.0
    path.write_text("symbol,minute_ms\nES,1\n")
    with pytest.raises(ValueError, match="missing columns"):
        data.read_flow_minutes(path)


def test_spy_minutes_are_aggregated_and_used_only_before_the_first_ibkr_day(tmp_path):
    minutes = tmp_path / "spy_1min.csv"
    rows = ["date,open,high,low,close,volume,barCount,average"]
    for day in ("2020-02-13", "2020-02-14", "2020-02-18"):
        for m in range(390):
            hour, minute = divmod(7 * 60 + 30 + m, 60)  # ibkr-mt file times are 2 hours behind New York
            rows.append(f"{day} {hour:02d}:{minute:02d}:00,100,100.1,99.9,100,10,1,100")
    for m in range(389):  # one minute missing: the loader drops this day
        hour, minute = divmod(7 * 60 + 30 + m, 60)
        rows.append(f"2020-02-12 {hour:02d}:{minute:02d}:00,100,100.1,99.9,100,10,1,100")
    minutes.write_text("\n".join(rows) + "\n")
    _write_month(tmp_path / "ib" / "SPY" / "2020-02.csv", date(2020, 2, 18), 300.0)
    sessions, info = data.load_symbol("SPY", data.Sources(ib=tmp_path / "ib", spy_minutes=minutes))
    assert [s.day.isoformat() for s in sessions] == ["2020-02-13", "2020-02-14", "2020-02-18"]
    assert len(sessions[0].bars) == 78 and sessions[0].bars[0].volume == 50
    assert sessions[2].bars[0].close == 300.0
    assert info["minutes"]["droppedIncomplete"] == 1
