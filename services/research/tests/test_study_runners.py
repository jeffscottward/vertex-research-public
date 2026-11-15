"""End-to-end runs of the ADX and RVOL study runners on synthetic local files."""
from __future__ import annotations

import json
import random
import sys
from datetime import date, timedelta

from strategies import adx_filter_run, filter_study_summary, rvol_intraday
from tests.test_rvol_intraday import minute_rows


def write_daily(folder, symbol, seed, days=700):
    rng = random.Random(seed)
    price = 100.0
    day = date(2004, 6, 1)
    lines = ["date,open,high,low,close,adj_close,volume"]
    for _ in range(days):
        day += timedelta(days=1 if day.weekday() < 4 else 3)
        open_ = price
        price = max(5.0, price * (1 + rng.gauss(0.0004, 0.015)))
        high, low = max(open_, price) * 1.004, min(open_, price) * 0.996
        lines.append(f"{day.isoformat()},{open_:.4f},{high:.4f},{low:.4f},{price:.4f},{price * 0.9:.4f},{rng.randint(1, 9) * 1000}")
    (folder / f"{symbol}.csv").write_text("\n".join(lines) + "\n")


def test_adx_filter_runner_end_to_end(tmp_path, monkeypatch, capsys):
    for index, symbol in enumerate(adx_filter_run.UNIVERSE):
        write_daily(tmp_path, symbol, index)
    (tmp_path / "manifest.json").write_text('{"files": []}')
    out = tmp_path / "results.json"
    monkeypatch.setattr(sys, "argv", ["run", "--data", str(tmp_path), "--out", str(out)])
    adx_filter_run.main()
    result = json.loads(out.read_text())
    assert result["trials"] == 13 and len(result["variants"]) == 13 and len(result["decisions"]) == 8
    assert result["window"]["start"] >= "2005-01-03" and result["data"]["manifest"] == {"files": []}
    for variant in result["variants"]:
        assert len(variant["halves"]) == 2 and len(variant["perSymbol"]) == 14
        assert variant["full"]["trades"] == sum(item["trades"] for item in variant["perSymbol"].values())
    assert len(capsys.readouterr().out.splitlines()) == 8
    (tmp_path / "manifest.json").unlink()
    adx_filter_run.main()
    assert json.loads(out.read_text())["data"]["manifest"] is None


def test_rvol_runner_end_to_end(tmp_path, monkeypatch, capsys):
    rng = random.Random(3)
    rows = []
    day = date(2019, 1, 1)
    for _ in range(60):
        day += timedelta(days=1)
        drift = rng.uniform(-0.002, 0.002)
        rows += minute_rows(day.isoformat(), price=lambda m, d=drift: 100.0 * (1 + d * m / 10),
                            volume=lambda m: rng.randint(1, 100))
    rows += minute_rows("2019-12-31", skip=3)
    bars = tmp_path / "spy.csv"
    header = "date,open,high,low,close,volume"
    bars.write_text(header + "\n" + "\n".join(",".join(r[k] for k in header.split(",")) for r in rows) + "\n")
    out = tmp_path / "rvol.json"
    monkeypatch.setattr(sys, "argv", ["run", "--bars", str(bars), "--out", str(out)])
    rvol_intraday.main()
    result = json.loads(out.read_text())
    assert result["data"]["sessionsUsed"] == 60 and result["data"]["sessionsDroppedIncomplete"] == ["2019-12-31"]
    assert result["sessions"] == 40
    assert len(capsys.readouterr().out.splitlines()) == 2


def test_summary_keeps_display_values(tmp_path, monkeypatch, capsys):
    for index, symbol in enumerate(adx_filter_run.UNIVERSE):
        write_daily(tmp_path, symbol, index)
    daily = tmp_path / "results.json"
    monkeypatch.setattr(sys, "argv", ["run", "--data", str(tmp_path), "--out", str(daily)])
    adx_filter_run.main()
    raw = json.loads(daily.read_text())
    raw["variants"][0]["deflated"] = None
    daily.write_text(json.dumps(raw))
    half = {"sharpe": 0.123456, "cagr": 0.01, "max_drawdown": 0.2, "trades": 10, "days": 100}
    block = {name: {"full": half, "firstHalf": half, "secondHalf": half, "tradesPerYear": 40.0}
             for name in ("none", "rvol_above_1")}
    intraday = {
        "firstSession": "2008-02-20", "lastSession": "2021-05-06", "sessions": 3325, "secondHalfStart": "2014-09-30",
        "primary1bp": {**block, "verdict": "KEEP"}, "sensitivity5bp": {**block, "verdict": "DROP (trade floor)"},
        "spearmanRvolVsAbsMove": {"full": 0.1, "firstHalf": 0.11111, "secondHalf": None},
    }
    intraday_path = tmp_path / "rvol.json"
    intraday_path.write_text(json.dumps(intraday))
    capsys.readouterr()
    argv = ["run", "--daily", str(daily), "--intraday", str(intraday_path), "--ran", "2026-10-31"]
    monkeypatch.setattr(sys, "argv", argv)
    filter_study_summary.main()
    printed = capsys.readouterr().out
    summary = json.loads(printed)
    out = tmp_path / "summary.json"
    monkeypatch.setattr(sys, "argv", [*argv, "--out", str(out)])
    filter_study_summary.main()
    assert out.read_text() == printed == capsys.readouterr().out
    assert summary["ran"] == "2026-10-31" and len(summary["daily"]["variants"]) == 13
    assert summary["daily"]["variants"][0]["deflatedProbability"] is None
    assert summary["daily"]["variants"][0]["verdict"] is None and summary["daily"]["variants"][1]["verdict"]
    assert summary["intraday"]["variants"][0]["sharpe"] == 0.1235
    assert summary["intraday"]["spearman"] == {"firstHalf": 0.1111, "secondHalf": None}
    assert summary["intraday"]["sensitivity"] == {"costBpsPerSide": 5, "verdict": "DROP (trade floor)"}
