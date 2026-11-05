"""Analytics CLI. Run from services/research: python -m analytics <command>.

Commands
  report  --data DIR [--out FILE.html] [--json FILE.json]   Core 7 risk table (gs-quant 2.2.4, offline)

The default output is <repo>/private/analytics/core7-risk.html. Research only:
no orders, no broker, no Marquee and no network access. Exit code 2 means the
pinned gs-quant is not installed or a GsSession is set.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .gs_quant_backend import GsQuantAnalytics, GsQuantSessionActive, GsQuantUnavailable
from .report import build_report, load_core7, render_html

REPO = Path(__file__).resolve().parents[3]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="analytics")
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("report")
    r.add_argument("--data", required=True, help="directory with <SYMBOL>.csv Core 7 daily files")
    r.add_argument("--out", default=str(REPO / "private" / "analytics" / "core7-risk.html"))
    r.add_argument("--json", dest="json_out")
    args = parser.parse_args(argv)

    series = load_core7(Path(args.data))
    if not series:
        print(json.dumps({"error": f"no Core 7 CSV files in {args.data}"}), file=sys.stderr)
        return 1
    try:
        report = build_report(series, GsQuantAnalytics())
    except (GsQuantUnavailable, GsQuantSessionActive) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_html(report))
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"written": str(out), "engine": report["engine"], "missing": report["missing"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
