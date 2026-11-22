"""Leveraged-ETF share test: signal S1 on SOXX, TSLA and NVDA, traded as shares (research only).

Places no orders and writes nothing to Postgres. Design: docs/specs/research/leveraged-etf-share-test.md. Table:
services/research/strategies/leveraged_etf/share_test.py. Reads the daily files of fetch_data.py --share-test
(--data), the VIX and VIX3M files of the qc-ports folder (calm regime) and the IBKR 5-minute bars of SOXX, TSLA
and NVDA (VERTEX_IMOM_IBKR_DATA or its default folder). Writes one JSON document to --out and `results.md` next
to it, outside the repository.

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  ~/.local/share/vertex/nautilus-venv/bin/python research/backtests/leveraged-etf/share_test.py \
      --data ~/Documents/reports/vertex-leveraged-etf-shares/data \
      --out ~/Documents/reports/vertex-leveraged-etf-shares/results.json
`--no-nautilus` (ledger only) makes the run a diagnostic: `complete` is false.

Per book (share_test.BOOKS) and row: the S1 signals of the book's underlying from the book's start, in the
regime, taken by signals.take, priced in the row's form, booked alone (ledger and NautilusTrader with parity).
The control rows (`always-long`: one long trade in U at every session open, entry price = the day's open, the
same regime filter and window) are the baseline of the `etf-shares` rows; they are not tested rows. Every
tested row gets the study's gate checks (allocation.gate_checks) with N_TRIALS = 40 + the tested rows, the
stricter deflated Sharpe of two trial variances (`stricter`; the measured one includes the 40 study rows of
--prior-results), and a verdict `pass`, `fail` or `underpowered`.
A book that cannot be loaded stops the run (no silent drop).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from backtesting.optimizer import deflated_sharpe_ratio  # noqa: E402
from golive import generator as golive  # noqa: E402
from strategies.imom import data as idata  # noqa: E402
from strategies.leveraged_etf import forms, metrics, prices, runner, share_test as table, signals  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import data as qd  # noqa: E402

CONTROL_ENTRY_MINUTE = idata.OPEN_MINUTE + 5  # the close of the first 5-minute bar
PRIOR_RESULTS = Path.home() / "Documents" / "reports" / "vertex-leveraged-etf" / "results.json"
WARM_UP_DAYS = 30
NEW_YORK = ZoneInfo("America/New_York")
COST_RATE = forms.SHARE_COST_RATE
UNDERPOWERED_CHECKS = ("G3 trades >= 30", "G5 deflated Sharpe >= 0.95", "G4 out-of-sample Sharpe >= 0.5")


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def control_signals(data: forms.PairData, start: str, daily: qd.Bars) -> list[signals.Signal]:
    """One long signal at every session open of U from `start` (price = the day's open)."""
    return [signals.Signal(table.CONTROL_FORM, data.pair.underlying, 1, day, idata.ms_at(day, CONTROL_ENTRY_MINUTE),
                           opening)
            for day, opening in zip(daily.dates, daily.open) if day >= start]


def minimum_detectable_sharpe(days: int, n_trials: int, threshold: float = 0.95) -> float | None:
    """The smallest annual Sharpe whose deflated Sharpe reaches `threshold` with `days` daily returns,
    `n_trials` trials, no skew and normal kurtosis (3), and the Sharpe variance of one estimate
    ((1 + SR^2 / 2) / (days - 1)) as the trial variance. Pre-registered per book before any result."""
    if days < 3:
        return None
    low, high = 0.0, 10.0
    for _ in range(80):
        mid = (low + high) / 2
        daily = mid / math.sqrt(al.TRADING_DAYS)
        variance = (1 + daily ** 2 / 2) / (days - 1)
        probability = deflated_sharpe_ratio(daily, n_trials, variance, days, 0.0, 3.0).probability
        low, high = (low, mid) if probability >= threshold else (mid, high)
    return high


def prior_daily_sharpes(path: Path) -> tuple[list[float], str]:
    """The per-day Sharpes of the 40 rows of the 7-pair study result (annual Sharpe / sqrt(trading days)) and
    the file's sha256. They join the trial variance, because those rows are trials of the same signal family."""
    raw = path.read_bytes()
    document = json.loads(raw)
    if not document.get("complete") or len(document.get("rows", [])) != table.PRIOR_TRIALS:
        raise SystemExit(f"{path}: not a complete 7-pair study result with {table.PRIOR_TRIALS} rows")
    sharpes = [row["stats"]["sharpe"] for row in document["rows"]]
    if any(value is None for value in sharpes):
        raise SystemExit(f"{path}: a study row has no Sharpe")
    return [value / math.sqrt(al.TRADING_DAYS) for value in sharpes], f"sha256:{hashlib.sha256(raw).hexdigest()}"


def stricter(measured: dict, null: dict) -> dict:
    """The row statistics with the lower deflated Sharpe of two trial variances: the variance of the per-day
    Sharpes of the 40 study rows and the tested share rows (`measured`) and the Sharpe variance of one estimate (`null`). A short
    run with few trials can make the measured variance small; the stricter value guards against that."""
    values = [item["deflatedSharpe"] for item in (measured, null)]
    if None in values:
        return {**measured, "deflatedSharpe": None, "deflatedSharpeRule": "undefined"}
    chosen = measured if values[0] <= values[1] else null
    return {**chosen, "deflatedSharpeRule": "measured variance" if chosen is measured else "null variance"}


def verdict_word(verdict: dict, sharpe: float | None, minimum: float | None) -> str:
    """`pass`; `underpowered` when the gate fails only on checks a short sample fails (trades, deflated
    Sharpe, out-of-sample Sharpe), the Sharpe is above 0 and below the book's minimum detectable Sharpe;
    else `fail`."""
    if verdict["passes"]:
        return "pass"
    failed = verdict["gate"]["failed"]
    if (sharpe is not None and sharpe > 0 and minimum is not None and sharpe < minimum
            and all(check in UNDERPOWERED_CHECKS for check in failed)):
        return "underpowered"
    return "fail"


def instrument_verdicts(rows: list[dict]) -> dict[str, str]:
    """One verdict per underlying from its primary book's tested rows: `pass` when any row passes, else
    `underpowered` when any row is underpowered, else `fail`. Supporting books never decide it."""
    out: dict[str, str] = {}
    for book in table.BOOKS:
        if not book.primary or not any(row["book"] == book.name for row in rows):
            continue
        words = {row["word"] for row in rows if row["book"] == book.name and not row["control"]}
        out[book.pair.underlying] = next(word for word in ("pass", "underpowered", "fail") if word in words or word == "fail")
    return out


def bars_day(bars: idata.SessionBars, index: int) -> str | None:
    """The New York day of a 5-minute bar (0 = first, -1 = last; None without bars)."""
    if not bars.t:
        return None
    return datetime.fromtimestamp(bars.t[index] / 1000, NEW_YORK).date().isoformat()


def pick_books(text: str | None) -> list[table.ShareBook]:
    """The books of the run in table order: every book, or the named books plus the primary book of each
    named underlying (its `etf-shares` rows are the baseline of a supporting book)."""
    if not text:
        return list(table.BOOKS)
    names = [name.strip() for name in text.split(",") if name.strip()]
    unknown = [name for name in names if name not in table.BY_NAME]
    if unknown or not names:
        raise SystemExit(f"--books: unknown {', '.join(unknown) or '(none named)'}; books: {', '.join(table.BY_NAME)}")
    wanted = {table.BY_NAME[name].pair.underlying for name in names}
    return [book for book in table.BOOKS if book.name in names or (book.primary and book.pair.underlying in wanted)]


def check_coverage(name: str, start: str, first_bar_day: str | None, last_bar_day: str | None = None,
                   last_daily_day: str | None = None) -> None:
    """Stops the run when the IBKR 5-minute bars of the book's underlying do not cover the book: they must
    start at least WARM_UP_DAYS calendar days before the book start (the S1 noise band reads the sessions
    before a signal) and reach the last day of the daily file."""
    need = (date.fromisoformat(start) - timedelta(days=WARM_UP_DAYS)).isoformat()
    if first_bar_day is None or first_bar_day > need:
        raise SystemExit(f"{name}: IBKR 5-minute bars start {first_bar_day}, after {need} (book start {start} less "
                         f"{WARM_UP_DAYS} days); finish the fetch (research/backtests/imom/fetch_ibkr.py) first")
    if last_daily_day is not None and (last_bar_day is None or last_bar_day < last_daily_day):
        raise SystemExit(f"{name}: IBKR 5-minute bars end {last_bar_day}, before the last daily bar {last_daily_day}")


def tracking(data: forms.PairData, start: str, seen: set[str] | None = None) -> list[dict]:
    """Per fund of a book: the error of the synthetic entry-price formula at the close (prices.tracking_error),
    from the book start only (before it a fund can have had another multiple)."""
    out: list[dict] = []
    seen = set() if seen is None else seen
    kept = [index for index, day in enumerate(data.market.dates) if day >= start]
    dates = tuple(data.market.dates[index] for index in kept)
    closes = tuple(data.market.close[index] for index in kept)
    for fund in (data.long_fund, data.inverse_fund):
        if fund.symbol in seen:
            continue
        seen.add(fund.symbol)
        row = prices.tracking_error(fund, table.signed_leverage(fund.symbol), dates, closes, data.u_splits,
                                    data.u_dividends)
        if row is not None:
            out.append({"underlying": data.pair.underlying, **row})
    return out


def data_hash(root: Path) -> str:
    """sha256 over the checksum file of the daily fetch and name, size and modification time of every IBKR
    5-minute file of the table."""
    digest = hashlib.sha256()
    sums = root / "LEVERAGED_ETF_SHA256SUMS"
    digest.update(sums.read_bytes() if sums.exists() else b"missing")
    for name in table.underlyings():
        path = idata.ibkr_files(name)[0]
        stat = path.stat()
        digest.update(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return f"sha256:{digest.hexdigest()}"


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True, type=Path, help="data folder of fetch_data.py --share-test")
    parser.add_argument("--out", required=True, type=Path, help="results JSON (results.md goes next to it)")
    parser.add_argument("--qc-data", type=Path, default=None, help="qc-ports folder (VIX, VIX3M)")
    parser.add_argument("--prior-results", type=Path, default=PRIOR_RESULTS,
                        help="results.json of the 7-pair study (its 40 rows join the trial variance)")
    parser.add_argument("--capital", type=float, default=runner.CAPITAL)
    parser.add_argument("--no-nautilus", action="store_true", help="ledger only (diagnostic)")
    parser.add_argument("--books", default=None, help="comma list of book names (diagnostic; default: every book)")
    parser.add_argument("--share-cost-rate", type=float, default=forms.SHARE_COST_RATE,
                        help=f"cost per side as a fraction of the price (default {forms.SHARE_COST_RATE}); "
                             "another value makes a cost-sensitivity run, not the result")
    return parser.parse_args(argv)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=False).stdout.strip()


def main(argv: list[str] | None = None) -> None:
    args = arguments(argv)
    began = time.monotonic()
    root = args.data.expanduser()
    nautilus = not args.no_nautilus
    forms.SHARE_COST_RATE = args.share_cost_rate  # read by forms._shares at pricing time
    sensitivity = args.share_cost_rate != COST_RATE
    vix, vix3m = qd.load_series("VIX", args.qc_data), qd.load_series("VIX3M", args.qc_data)

    loaded: dict[str, tuple] = {}
    picked = pick_books(args.books)
    prior, prior_hash = prior_daily_sharpes(args.prior_results.expanduser())
    for book in picked:
        data = forms.load_share_pair(book.pair, root)
        found = runner.load_pair_signals(book.pair, data, vix, vix3m, with_s2=False)
        bars = idata.load_bars(book.pair.underlying, source=idata.IBKR)
        check_coverage(book.name, book.start, bars_day(bars, 0), bars_day(bars, -1), data.market.dates[-1])
        allowed = signals.calm_days(data.market.dates, data.market.close, vix, vix3m)
        start = max(book.start, runner._next_day(found.inputs_from))
        control = [item for item in control_signals(data, start, qd.load_bars(book.pair.underlying, root))]
        regimes = {regime: [item for item in found.signals[signals.S1][regime] if item.day >= start]
                   for regime in signals.REGIMES}
        controls = {regime: signals.in_regime(control, regime, data.market.dates, allowed) for regime in signals.REGIMES}
        loaded[book.name] = (book, data, start, regimes, controls)
        log(f"{book.name}: inputs from {found.inputs_from}, start {start}, "
            f"S1 {{{', '.join(f'{r}: {len(v)}' for r, v in regimes.items())}}}")

    with forms.fund_models(()):
        rows: dict[str, dict] = {}
        for name, (book, data, start, regimes, controls) in loaded.items():
            dates = {book.pair.underlying: data.market.dates}
            plan = [(key, regimes) for key in table.row_keys(book)]
            if book.primary:
                plan += [(table.book_key(name, metrics.row_key(signals.S1, regime, window, table.CONTROL_FORM)), controls)
                         for regime in signals.REGIMES for window in table.WINDOWS]
            for key, source in plan:
                _, row = table.split_book_key(key)
                _, regime, window, _ = metrics.split_key(row)
                taken, counts = signals.take(source[regime], window, dates)
                result = runner.run_row(row, taken, {book.pair.underlying: data}, {book.pair.underlying: start},
                                        args.capital, nautilus=nautilus)
                rows[key] = {"key": key, "book": name, "taken": len(taken), "skipped": counts, "result": result,
                             "control": key.endswith(table.CONTROL_FORM)}
                gap = "ledger only" if result["gap"] is None else f"gap {result['gap']:.2g}"
                log(f"{key}: {len(taken)} taken, {result['priced']} priced, {len(result['daily'].trades)} booked, {gap}")

    tested = [key for key, row in rows.items() if not row["control"]]
    variance = metrics.trial_variance(prior + [metrics.daily_sharpe(rows[key]["result"]["daily"]) for key in tested])
    stats = {key: stricter(metrics.row_stats(row["result"]["daily"], row["result"]["returns"], table.N_TRIALS, variance),
                           metrics.row_stats(row["result"]["daily"], row["result"]["returns"], table.N_TRIALS, None))
             for key, row in rows.items()}
    funded_pie = golive.funded_pie()
    verdicts = metrics.verdicts(stats, al.gate_checks, funded_pie.lower_bar, baseline_of=table.baseline_key,
                                twin_of=table.twin_key)
    books_out = []
    for name, (book, data, start, regimes, _) in loaded.items():
        days = len([day for day in data.market.dates if day >= start])
        books_out.append({"book": name, "underlying": book.pair.underlying, "longFund": book.pair.long_fund,
                          "inverseFund": book.pair.inverse_fund, "leverage": book.pair.leverage, "primary": book.primary,
                          "start": start, "end": data.market.dates[-1], "sessions": days,
                          "minimumDetectableSharpe": minimum_detectable_sharpe(days, table.N_TRIALS),
                          "s1Signals": {regime: len(items) for regime, items in regimes.items()}})
    minimum = {item["book"]: item["minimumDetectableSharpe"] for item in books_out}
    out_rows = []
    for key, row in rows.items():
        result, row_stats = row["result"], stats[key]
        word = None if row["control"] else verdict_word(verdicts[key], row_stats.get("sharpe"), minimum[row["book"]])
        out_rows.append({"key": key, "book": row["book"], "control": row["control"], "taken": row["taken"],
                         "skipped": row["skipped"], "priced": result["priced"], "notPriced": result["notPriced"],
                         "nautilusGap": result["gap"], "stats": row_stats, "verdict": verdicts[key], "word": word,
                         "monthly": metrics.monthly_points(result["daily"])})
    dirty = bool(git("status", "--porcelain", "--", "services/research/strategies", "research/backtests/leveraged-etf"))
    document = {
        "schema": table.SCHEMA, "complete": nautilus and not dirty and not sensitivity and not args.books,
        "partial": [reason for reason, on in (("ledger only", not nautilus), ("uncommitted study code", dirty),
                                              (f"cost rate {args.share_cost_rate}", sensitivity),
                                              ("only books " + str(args.books), bool(args.books))) if on],
        "capital": args.capital, "shareCostRate": args.share_cost_rate,
        "instrumentVerdicts": instrument_verdicts(out_rows), "nautilusParity": nautilus, "gate": dict(al.GATE),
        "trials": {"count": table.N_TRIALS, "prior": table.PRIOR_TRIALS, "tested": len(tested),
                   "dailySharpeVariance": variance, "priorResults": str(args.prior_results), "priorHash": prior_hash},
        "books": books_out, "trackingError": [row for seen in [set()] for _, data, start, *_ in loaded.values()
                          for row in tracking(data, start, seen)],
        "rows": out_rows,
        "provenance": {"commit": git("rev-parse", "HEAD"), "dirty": dirty, "data": str(root), "dataHash": data_hash(root)},
        "wallSeconds": time.monotonic() - began,
    }
    out = args.out.expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=1, default=str) + "\n", encoding="utf-8")
    out.with_name("results.md").write_text(markdown(document), encoding="utf-8")
    log(f"wrote {out}")


def _number(value, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def markdown(document: dict) -> str:
    """The results tables: books, then one line per row with its verdict and failed checks."""
    lines = ["# Leveraged-ETF share test results", ""]
    if not document["complete"]:
        lines += [f"PARTIAL run ({'; '.join(document['partial'])}): a diagnostic, not the result.", ""]
    lines += ["Instrument verdicts: " + ", ".join(f"{name} {word}" for name, word in document["instrumentVerdicts"].items()),
              f"Share cost per side: {document['shareCostRate']:.4f}", ""]
    lines += [f"Trials: {document['trials']['count']} (40 study rows + {document['trials']['tested']} share-test rows).",
              "", "|Book|Funds|Start|End|Sessions|Minimum detectable Sharpe|", "|---|---|---|---|---|---|"]
    for book in document["books"]:
        lines.append(f"|{book['book']}|{book['longFund']}/{book['inverseFund']} {book['leverage']}x|{book['start']}|"
                     f"{book['end']}|{book['sessions']}|{_number(book['minimumDetectableSharpe'])}|")
    lines += ["", "|Row|Verdict|Trades|Sharpe|OOS Sharpe|Deflated|Max DD|Baseline Sharpe|Failed checks|",
              "|---|---|---|---|---|---|---|---|---|"]
    for row in document["rows"]:
        stats, gate = row["stats"], row["verdict"]["gate"]
        word = "control" if row["control"] else row["word"]
        lines.append(f"|{row['key']}|{word}|{stats['trades']}|{_number(stats['sharpe'])}|{_number(stats['oosSharpe'])}|"
                     f"{_number(stats['deflatedSharpe'])}|{_number(stats['maxDrawdown'])}|"
                     f"{_number(gate['baselineSharpe'])}|{'; '.join(gate['failed']) or '-'}|")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
