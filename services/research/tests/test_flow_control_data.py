"""Net drift history loader: file layout, parsing, derived totals, skip reasons, usable days and the manifest."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from strategies.flow_control import data
from strategies.imom.data import ms_at

DAY = "2025-06-03"


def bucket(call=100.0, put=50.0, price: float | None = 500.0) -> dict:
    return {"netCallPremium": call, "netPutPremium": put, "netCallVolume": 1, "netPutVolume": 2,
            "stockPrice": price, "midMarketCallPremium": 0}


def write_part(root: Path, ticker: str, part: str, day: str, minutes=range(390), **kw) -> Path:
    path = data.bucket_path(root, ticker, part, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {str(int(ms_at(day, 570 + m))): bucket(**kw) for m in minutes}
    path.write_text(json.dumps(payload))
    return path


def write_day(root: Path, day: str = DAY, part: str = "total", tickers=data.TICKERS) -> None:
    for ticker in tickers:
        if part == "total":
            write_part(root, ticker, "total", day)
        else:
            write_part(root, ticker, "zero_dte", day, call=60.0, put=10.0)
            write_part(root, ticker, "longer", day, call=40.0, put=40.0, price=None)


def test_bucket_path_layout(tmp_path):
    assert data.bucket_path(tmp_path, "SPY", "total", DAY) == tmp_path / "net-drift" / "SPY" / "total" / f"{DAY}.json"


def test_parse_part_reads_the_five_fields():
    parsed = data.parse_part(json.dumps({"1748957400000": bucket(price=None)}))
    assert parsed == {1748957400000: (100.0, 50.0, 1.0, 2.0, None)}
    assert data.parse_part("{}") == {}


@pytest.mark.parametrize("payload", [
    {"1748957400000": {"netCallPremium": 1, "netPutPremium": 1, "netCallVolume": 1, "netPutVolume": 1}},
    {"1748957400000": {**bucket(), "netCallPremium": float("nan")}},
    {"1748957400001": bucket()},
    {"abc": bucket()},
])
def test_parse_part_rejects_a_missing_field_a_non_finite_value_and_a_bad_key(payload):
    with pytest.raises(data.DataError):
        data.parse_part(json.dumps(payload))
    with pytest.raises(data.DataError):
        data.parse_part("[1]")


def test_total_file_is_used_when_present(tmp_path):
    write_part(tmp_path, "SPY", "total", DAY, call=7.0, put=3.0)
    write_part(tmp_path, "SPY", "zero_dte", DAY, call=1.0, put=1.0)
    write_part(tmp_path, "SPY", "longer", DAY, call=1.0, put=1.0)
    session = data.read_ticker(tmp_path, "SPY", DAY)
    assert isinstance(session, data.TickerSession) and not session.derived_total
    assert session.minutes[0].net_call_premium == 7.0 and len(session.files) == 1


def test_total_is_derived_from_zero_dte_and_longer_and_counted(tmp_path):
    write_day(tmp_path, part="fallback")
    session = data.read_ticker(tmp_path, "SPY", DAY)
    assert isinstance(session, data.TickerSession) and session.derived_total
    first = session.minutes[0]
    assert (first.net_call_premium, first.net_put_premium) == (100.0, 50.0)
    assert session.price[0] == 500.0
    loaded = data.load_all(tmp_path)
    assert loaded.days == (DAY,) and loaded.derived_total_days == 1


@pytest.mark.parametrize("reason", data.SKIP_REASONS)
def test_each_skip_reason(tmp_path, reason):
    if reason == "missing":
        write_part(tmp_path, "SPY", "zero_dte", DAY)
    elif reason == "empty":
        path = data.bucket_path(tmp_path, "SPY", "total", DAY)
        path.parent.mkdir(parents=True)
        path.write_text("{}")
    elif reason == "thin":
        write_part(tmp_path, "SPY", "total", DAY, minutes=range(299))
    elif reason == "no_open_price":
        write_part(tmp_path, "SPY", "total", DAY, minutes=range(1, 390))
    else:
        write_part(tmp_path, "SPY", "total", DAY, minutes=[*range(0, 100), *range(106, 390)])
    assert data.read_ticker(tmp_path, "SPY", DAY) == reason
    assert data.load_ticker(tmp_path, "SPY", DAY) is None


def test_price_is_carried_at_most_five_minutes(tmp_path):
    write_part(tmp_path, "SPY", "total", DAY, minutes=[*range(0, 100), *range(105, 390)])
    session = data.read_ticker(tmp_path, "SPY", DAY)
    assert isinstance(session, data.TickerSession)
    assert session.price[104] == session.price[99] == 500.0
    assert len(session.price) == 386


def test_minutes_outside_the_session_are_dropped(tmp_path):
    write_part(tmp_path, "SPY", "total", DAY, minutes=range(-30, 420))
    session = data.read_ticker(tmp_path, "SPY", DAY)
    assert isinstance(session, data.TickerSession)
    assert session.minutes[0].minute == 0 and session.minutes[-1].minute == 389


def test_day_is_usable_only_when_all_four_tickers_load(tmp_path):
    write_day(tmp_path)
    write_day(tmp_path, "2025-06-04", tickers=("SPX", "SPY", "QQQ"))
    loaded = data.load_all(tmp_path)
    assert loaded.days == (DAY,)
    assert loaded.skipped == ({"day": "2025-06-04", "ticker": "NDX", "reason": "missing"},)
    assert len(loaded.files) == 4 and set(loaded.sessions[DAY]) == set(data.TICKERS)


def test_closed_days_are_left_out_and_early_close_days_are_counted(tmp_path):
    write_day(tmp_path, "2025-07-04")  # Independence Day: closed
    write_day(tmp_path, "2025-07-03")  # early close
    write_day(tmp_path, "2025-07-05")  # Saturday
    write_day(tmp_path, "2024-12-31")  # before the first study day
    write_day(tmp_path)
    loaded = data.load_all(tmp_path)
    assert loaded.days == (DAY,) and loaded.early_close_days == 1


def test_manifest_and_hash_are_stable(tmp_path):
    a = write_part(tmp_path, "SPY", "total", DAY)
    manifest = data.data_manifest([a])
    assert manifest[0]["bytes"] == a.stat().st_size and len(manifest[0]["sha256"]) == 64
    assert data.data_hash(manifest) == data.data_hash(data.data_manifest([a]))
    assert data.data_hash(manifest) != data.data_hash([])


def test_data_root_reads_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv(data.DATA_ENV, str(tmp_path))
    assert data.data_root() == tmp_path
    assert data.data_root("/x") == Path("/x")
