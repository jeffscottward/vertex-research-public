"""Stopping-premium backtests A-H (Kaminski and Lo 2014 plan, card stoploss-stopping-premium-backtests).

Research only: places no orders, reads no account, changes no live rule, writes nothing to Postgres.
Reads a qc-ports / options-forms daily-bar directory (--data) and, for test E, counts of the stored Crown
history (--crown-dir; read only, nothing of it is written except the counts). Writes to --out (outside the
repository): results.json (every number, with the code commit and the SHA-256 of every input file), one PNG
chart per test and index.html (the dark report).

Run (rig):
  uv run --no-project --python 3.12 --with pydantic==2.13.4 --with matplotlib==3.10.7 \
      python research/backtests/stoploss-premium/run.py \
      --data ~/Documents/reports/web/vertex-calendar-spread-nautilus/data \
      --out ~/Documents/reports/web/stoploss-premium-backtests
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.stoploss_premium import premium, report, study  # noqa: E402

WATCHED = ("services/research/strategies/stoploss_premium", "services/research/strategies/qc_ports",
           "services/research/indicators", "research/backtests/stoploss-premium")
COLORS = {premium.ADDS_RETURN: "#22c55e", premium.PAID_INSURANCE: "#3b82f6", premium.FAIL: "#ef4444",
          premium.NOT_ENOUGH: "#6b7280", premium.INCONCLUSIVE: "#f59e0b"}


def log(text: str) -> None:
    print(f"{datetime.now(UTC):%H:%M:%SZ} {text}", file=sys.stderr, flush=True)


def git_state() -> dict:
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False).stdout.strip()
    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--", *WATCHED))}


def manifest(data: Path, extra: list[Path]) -> dict[str, str]:
    """SHA-256 of every input file: the bar and index CSVs and the extra inputs that exist (Crown files)."""
    files = sorted(data.glob("*.csv")) + [p for p in extra if p.exists()]
    return {(p.name if p.parent == data else str(p)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def crown_counts(crown_dir: Path | None) -> tuple[int, int, int, str, str]:
    """(closed trades, notes with a 'close below' level, notes, first date, last date); zeros if absent."""
    if crown_dir is None or not (crown_dir / "desk-notes.json").exists():
        return 0, 0, 0, "–", "–"
    import re
    notes = json.loads((crown_dir / "desk-notes.json").read_text())
    dates = sorted(str(n.get("date", ""))[:10] for n in notes if n.get("date"))
    level = sum(1 for n in notes if re.search(r"close[sd]? (?:below|under)", json.dumps(n), re.I))
    closed = 0
    blotter = crown_dir / "blotter.jsonl"
    if blotter.exists():
        lines = [x for x in blotter.read_text().splitlines() if x.strip()]
        if lines:
            closed = len(json.loads(lines[-1]).get("closed", []))
    return closed, level, len(notes), dates[0] if dates else "–", dates[-1] if dates else "–"


def charts(t: dict, out: Path) -> list[str]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("dark_background")
    names, files = [], []
    rows = [v for v in t["variants"] if "premium" in v["summary"]]
    if not rows:
        return []
    fig, ax = plt.subplots(figsize=(11, 0.55 * len(rows) + 1.6))
    for j, v in enumerate(rows):
        s = v["summary"]
        lo, hi = s["interval"]
        ax.barh(j, s["premium"] * 100, color=COLORS.get(v["verdict"], "#6b7280"))
        ax.plot([lo * 100, hi * 100], [j, j], color="#e5e7eb", lw=2)
        names.append(v["name"].replace("📅 ", "")[:70])
    ax.axvline(0, color="#9ca3af", lw=1)
    ax.set_yticks(range(len(rows)), names, fontsize=8)
    ax.invert_yaxis()
    ax.set_xlabel("stopping premium Δμ, % per year after costs (bar) and 90% block-bootstrap interval (line)")
    label = " (MODEL PRICE)" if t["prices"] == "model price" else ""
    ax.set_title(f"Test {t['id']}: {t['title'].replace('📅 ', '')}{label}", loc="left")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in COLORS.values()]
    ax.legend(handles, list(COLORS), fontsize=7, loc="lower right")
    fig.tight_layout()
    name = f"test-{t['id'].lower()}-premium.png"
    fig.savefig(out / name, dpi=110, facecolor="#0e1116")
    plt.close(fig)
    files.append(name)
    with_curves = [v for v in rows if v.get("curve")][:6]
    if with_curves:
        fig, axes = plt.subplots(len(with_curves), 1, figsize=(11, 2.3 * len(with_curves)), squeeze=False)
        for ax, v in zip(axes[:, 0], with_curves):
            c = v["curve"]
            x = [datetime.fromisoformat(d) for d in c["dates"]]
            ax.plot(x, c["without"], color="#9ca3af", lw=1.2, label="without the rule")
            ax.plot(x, c["with"], color=COLORS.get(v["verdict"], "#fbbf24"), lw=1.4, label="with the rule")
            ax.set_yscale("log")
            ax.set_title(v["name"].replace("📅 ", "")[:100], fontsize=9, loc="left")
            ax.legend(fontsize=7, loc="upper left")
        fig.suptitle(f"Test {t['id']}: growth of 1 (log scale){label}", x=0.01, ha="left")
        fig.tight_layout()
        name = f"test-{t['id'].lower()}-curves.png"
        fig.savefig(out / name, dpi=100, facecolor="#0e1116")
        plt.close(fig)
        files.append(name)
    return files


def summary_chart(tests: list[dict], out: Path) -> str | None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("dark_background")
    rows = [(t, v) for t in tests for v in t["variants"] if "premium" in v["summary"]]
    if not rows:
        return None
    fig, ax = plt.subplots(figsize=(12, 0.42 * len(rows) + 1.8))
    for j, (t, v) in enumerate(rows):
        s = v["summary"]
        ax.barh(j, s["premium"] * 100, color=COLORS.get(v["verdict"], "#6b7280"))
        tag = " (MODEL PRICE)" if t["prices"] == "model price" else ""
        ax.text(0.2 if s["premium"] < 0 else -0.2, j, f"{v['verdict']}{tag}", va="center",
                ha="left" if s["premium"] < 0 else "right", fontsize=7, color="#e5e7eb")
    ax.set_yticks(range(len(rows)), [f"{t['id']} · {v['name'].replace('📅 ', '')[:62]}" for t, v in rows], fontsize=7)
    ax.invert_yaxis()
    ax.axvline(0, color="#9ca3af", lw=1)
    ax.set_xlabel("stopping premium Δμ, % per year after costs (with the rule minus without it)")
    ax.set_title("Does the exit rule add return? Every test variant", loc="left")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in COLORS.values()]
    ax.legend(handles, list(COLORS), fontsize=7, loc="lower left")
    fig.tight_layout()
    fig.savefig(out / "summary.png", dpi=110, facecolor="#0e1116")
    plt.close(fig)
    return "summary.png"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--crown-dir", type=Path, default=Path.home() / ".local/share/crown-cli")
    ap.add_argument("--tests", default="B,A,C,D,G,H,F,E", help="comma list, plan order by default")
    ap.add_argument("--allow-dirty", action="store_true")
    a = ap.parse_args(argv)
    state = git_state()
    if state["dirty"] and not a.allow_dirty:
        log("uncommitted study code; commit first or pass --allow-dirty")
        return 2
    if a.out.resolve().is_relative_to(ROOT):
        log("--out must be outside the repository")
        return 2
    a.out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    data = study.load(a.data)
    log(f"loaded {len(data.names)} names, {data.calendar[0]} to {data.calendar[-1]}")
    wanted = [x.strip().upper() for x in a.tests.split(",") if x.strip()]
    results: dict[str, dict] = {}
    option_trades: dict[str, list] = {}

    def trades() -> dict[str, list]:
        if not option_trades:
            option_trades.update(study.option_sets(data, log))
        return option_trades

    for tid in wanted:
        log(f"test {tid}")
        if tid == "A":
            results[tid] = study.test_a(data, progress=log)
        elif tid == "B":
            results[tid] = study.test_b(data, trades(), progress=log)
        elif tid == "C":
            results[tid] = study.test_c(data, trades(), progress=log)
        elif tid == "D":
            results[tid] = study.test_d(data, trades(), progress=log)
        elif tid == "F":
            results[tid] = study.test_f(data, progress=log)
        elif tid == "G":
            results[tid] = study.test_g(data, progress=log)
        elif tid == "H":
            results[tid] = study.test_h(data, progress=log)
        elif tid == "E":
            results[tid] = study.test_e(*crown_counts(a.crown_dir))
    chart_files = {tid: charts(t, a.out) for tid, t in results.items()}
    doc = {"generatedAt": datetime.now(UTC).isoformat(timespec="seconds"), "code": state,
           "dataDir": str(a.data), "dataEnd": data.calendar[-1], "portedFrom": study.PORTED_FROM,
           "inputs": manifest(a.data, [a.crown_dir / "desk-notes.json", a.crown_dir / "blotter.jsonl",
                                       a.out / "intro.html"]),
           "seconds": round(time.time() - t0, 1), "tests": results}
    (a.out / "results.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    ordered = [results[t] for t in wanted if t in results]
    intro = (a.out / "intro.html").read_text() if (a.out / "intro.html").exists() else ""
    intro += report.overview(ordered, summary_chart(ordered, a.out))
    method = report.METHOD_HTML
    (a.out / "index.html").write_text(report.page("Stop-loss rules: stopping-premium backtests (tests A-H)", intro,
                                                   ordered, chart_files, method))
    log(f"done in {time.time() - t0:.0f} s -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
