"""Analytics package without gs-quant: the report through the port, the CSV loader, the import boundary and
the missing-package errors. A fake SeriesAnalytics built on the pure indicator kernels stands in for gs-quant.
No network, Marquee, broker or model access.
"""
from __future__ import annotations

import ast
import csv
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

import indicators
from analytics import __main__ as cli
from analytics import gs_quant_backend
from analytics.ports import SeriesAnalytics
from analytics.report import CORE7, build_report, load_core7, load_daily_csv, render_html

RESEARCH = Path(__file__).resolve().parents[1]
REPO = RESEARCH.parents[1]


class KernelAnalytics:
    """Port implementation over the pure indicator kernels (no gs-quant)."""

    engine_id = "kernel-test"

    def realized_volatility(self, dates, closes, window):
        return indicators.realized_volatility(closes, window)

    def exponential_volatility(self, dates, closes, beta):
        return [None] + [1.0] * (len(closes) - 1)

    def zscore(self, dates, values, window):
        return indicators.zscore(values, window)

    def beta(self, dates, closes, benchmark_dates, benchmark_closes, window):
        return [None] * (len(closes) - 1) + [1.0]

    def correlation(self, dates, closes, benchmark_dates, benchmark_closes, window):
        return [None] * (len(closes) - 1) + [0.5]

    def max_drawdown(self, dates, closes, window):
        peak, out = closes[0], []
        for value in closes:
            peak = max(peak, value)
            out.append(value / peak - 1)
        return out


def business_days(n: int) -> list[str]:
    out, day = [], date(2024, 1, 1)
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def write_csv(path: Path, rows) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "open", "high", "low", "close", "adj_close", "volume"])
        writer.writerows(rows)


def series(n: int, start: float) -> tuple[list[str], list[float]]:
    return business_days(n), [start * (1 + 0.01 * ((index * 7) % 5 - 2)) ** (index % 3) for index in range(n)]


def test_kernel_fake_satisfies_the_port():
    assert isinstance(KernelAnalytics(), SeriesAnalytics)
    assert isinstance(gs_quant_backend.GsQuantAnalytics(), SeriesAnalytics)


def test_core7_matches_the_shared_universe():
    source = (REPO / "packages/shared/src/universes/index.ts").read_text()
    block = source[source.index("export const CORE7_MARKETS") :].split("] as const", 1)[0]
    entries = re.findall(r'etf: "([^"]+)", future: "([^"]+)", market: "([^"]+)"', block)
    assert [(market, future, etf) for etf, future, market in entries] == list(CORE7)


def test_loader_sorts_and_drops_non_positive_prices(tmp_path):
    path = tmp_path / "CL=F.csv"
    write_csv(path, [
        ["2020-04-21", -14.0, 13.86, -16.74, 10.01, 10.01, 1],
        ["2020-04-17", 20.0, 20.22, 17.31, 18.27, 18.27, 1],
        ["2020-04-20", 17.73, 17.85, -40.32, -37.63, -37.63, 1],
        ["2020-04-22", 13.12, 16.18, 10.26, 13.78, 13.78, 1],
        ["2020-04-23", "", 1, 1, 1, 1, 1],
    ])
    assert load_daily_csv(path) == (["2020-04-17", "2020-04-22"], [18.27, 13.78])


def test_report_through_the_port_and_html(tmp_path):
    data = {}
    for index, (_, future, twin) in enumerate(CORE7[:6]):
        data[future] = series(300, 100 + index)
        data[twin] = series(300, 50 + index)
    report = build_report(data, KernelAnalytics())
    assert report["engine"] == "kernel-test"
    assert report["missing"] == ["CL=F", "USO"]
    first = report["markets"][0]
    assert first["future"]["symbol"] == "ES=F" and first["etf"]["symbol"] == "SPY"
    assert first["future"]["beta60"] is None and first["etf"]["beta60"] is None  # benchmarks
    assert first["future"]["twin60"] == 0.5 and first["etf"]["twin60"] is None
    assert report["markets"][1]["future"]["beta60"] == 1.0
    assert first["future"]["vol20"] == indicators.realized_volatility(data["ES=F"][1], 20)[-1]
    assert report["markets"][6]["future"] is None and report["markets"][6]["etf"] is None
    page = render_html(report)
    assert "No data for: CL=F, USO." in page
    assert page.count("<svg") == 12 and "<script" not in page
    assert "Research data only" in page
    json.dumps(report)  # the report record is plain JSON


def test_only_the_adapter_imports_gs_quant():
    importers = []
    for path in RESEARCH.rglob("*.py"):
        relative = path.relative_to(RESEARCH)
        skipped = {"tests", "__pycache__", "build", "dist", "node_modules"}
        if any(part in skipped or part.startswith(".") for part in relative.parts):
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.startswith("gs_quant"):
                names = [node.value]
            if any(name == "gs_quant" or name.startswith("gs_quant.") for name in names):
                importers.append(str(relative))
    assert sorted(set(importers)) == ["analytics/gs_quant_backend.py"]


def test_missing_or_wrong_gs_quant_is_a_clear_error(monkeypatch, tmp_path):
    real_import = gs_quant_backend.importlib.import_module

    def missing(name, *args):
        if name == "gs_quant":
            raise ImportError("No module named 'gs_quant'")
        return real_import(name, *args)

    monkeypatch.setattr(gs_quant_backend.importlib, "import_module", missing)
    with pytest.raises(gs_quant_backend.GsQuantUnavailable, match="requirements-gsquant-linux-py312.lock"):
        gs_quant_backend.require()
    data_dir = tmp_path / "daily"
    data_dir.mkdir()
    write_csv(data_dir / "SPY.csv", [[day, 1, 1, 1, 1, 1, 1] for day in business_days(5)])
    assert cli.main(["report", "--data", str(data_dir), "--out", str(tmp_path / "x.html")]) == 2
    assert not (tmp_path / "x.html").exists()

    monkeypatch.setattr(gs_quant_backend.importlib, "import_module",
                        lambda name, *args: type(sys)("gs_quant") if name == "gs_quant" else real_import(name, *args))
    with pytest.raises(gs_quant_backend.GsQuantUnavailable, match="unknown found, 2.2.4 is pinned"):
        gs_quant_backend.require()


def test_cli_without_data_files(tmp_path, capsys):
    assert cli.main(["report", "--data", str(tmp_path)]) == 1
    assert "no Core 7 CSV files" in capsys.readouterr().err
    write_csv(tmp_path / "SPY.csv", [])  # header only: skipped, not a crash
    assert load_core7(tmp_path) == {}
    assert cli.main(["report", "--data", str(tmp_path)]) == 1


def test_report_shows_no_stale_relative_value():
    class LastMissing(KernelAnalytics):
        def beta(self, dates, closes, benchmark_dates, benchmark_closes, window):
            return [1.0] * (len(closes) - 1) + [None]

    data = {"ES=F": series(100, 100), "NQ=F": series(100, 90)}
    row = build_report(data, LastMissing())["markets"][1]["future"]
    assert row["beta60"] is None and row["corr60"] == 0.5
