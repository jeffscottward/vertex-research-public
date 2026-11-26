"""CLI runner for smart-money PR 7 backtests.

Reads the collector's event files and daily-bar CSVs from --data-dir, runs the three
pre-registered studies with the deflated Sharpe gate, and writes into --out-dir one document
per study, the JSON-lines bundle for the study importer, the trial log and a summary.
Pure stdlib. Research only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import statistics
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import date
from pathlib import Path
from typing import Any

from .document import build_study_document, make_run_entry, write_study_bundle
from .engine import (
    DEFAULT_COST_BPS,
    DSR_PASS_BAR,
    MIN_OOS_EVENTS,
    MIN_OOS_SESSIONS,
    SESSIONS_PER_YEAR,
    DailyBar,
    PortfolioConfig,
    PortfolioResult,
    SignalEvent,
    TrialRecord,
    compute_study_dsr,
    evaluate_verdict,
    simulate_event_portfolio,
)
from .signals import (
    CongressPurchase,
    Form4Purchase,
    MarketPremiumRow,
    build_signal1_variants,
    build_signal2_variants,
    build_signal3_events,
)

HOLDING_DAYS: tuple[int, ...] = (5, 20, 60)
SIGNAL1_VARIANTS: tuple[str, ...] = (
    "confirmation-baseline",
    "cluster-3p-10d",
    "cluster-3p-10d-100k",
    "cluster-3p-10d-confirm",
)
SIGNAL2_VARIANTS: tuple[str, ...] = (
    "all-buys",
    "large-50k",
    "fast-filed-15d",
    "multi-member-30d",
)


def load_bars_dir(bars_dir: Path) -> dict[str, list[DailyBar]]:
    bars_by_sym: dict[str, list[DailyBar]] = {}
    if not bars_dir.exists():
        return bars_by_sym
    for csv_path in sorted(bars_dir.glob("*.csv")):
        sym = csv_path.stem.upper()
        rows: list[DailyBar] = []
        with csv_path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            if "raw_close" not in (reader.fieldnames or ()):
                raise ValueError(
                    f"{csv_path} has no raw_close column; fetch the bars again with "
                    "scripts/smart-money-pr7/fetch_data.py --only bars"
                )
            for r in reader:
                try:
                    d = date.fromisoformat(r["date"].strip())
                    o = float(r["open"])
                    h = float(r["high"])
                    lo = float(r["low"])
                    c = float(r["close"])
                    ac = float(r.get("adj_close") or c)
                    v = float(r["volume"])
                    rc = float(r["raw_close"])
                except (KeyError, TypeError, ValueError):  # TypeError: a row cut short has None cells
                    continue
                values = (o, h, lo, c, ac, v, rc)
                if all(math.isfinite(x) for x in values) and min(o, h, lo, c, ac, rc) > 0 and v >= 0:
                    rows.append(DailyBar(d, o, h, lo, c, ac, v, rc))
        if rows:
            rows.sort(key=lambda b: b.day)
            bars_by_sym[sym] = rows
    return bars_by_sym


def load_form4_jsonl(path: Path) -> list[Form4Purchase]:
    out: list[Form4Purchase] = []
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out.append(
                Form4Purchase(
                    accession_number=str(r["accession_number"]),
                    filing_date=date.fromisoformat(r["filing_date"]),
                    transaction_date=date.fromisoformat(r["transaction_date"]) if r.get("transaction_date") else None,
                    issuer_cik=str(r["issuer_cik"]),
                    ticker=str(r["ticker"]).upper(),
                    owner_group_key=str(r["owner_group_key"]),
                    role_text=str(r.get("role_text") or ""),
                    security=str(r["security"]),
                    shares=float(r["shares"]),
                    price=float(r["price"]),
                    holding_before=float(r["holding_before"]) if r.get("holding_before") is not None else None,
                    is_10b5_1=bool(r.get("is_10b5_1", False)),
                )
            )
    return out


def load_congress_jsonl(path: Path) -> list[CongressPurchase]:
    out: list[CongressPurchase] = []
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out.append(
                CongressPurchase(
                    chamber=str(r["chamber"]),
                    doc_id=str(r["doc_id"]),
                    member=str(r["member"]),
                    holder=str(r["holder"]) if r.get("holder") else None,
                    ticker=str(r["ticker"]).upper(),
                    transaction_type=str(r["transaction_type"]),
                    transaction_date=date.fromisoformat(r["transaction_date"]) if r.get("transaction_date") else None,
                    filed_on=date.fromisoformat(r["filed_on"]),
                    amount_low=float(r["amount_low"]) if r.get("amount_low") is not None else None,
                    amount_high=float(r["amount_high"]) if r.get("amount_high") is not None else None,
                    amends=bool(r.get("amends", False)),
                )
            )
    return out


def load_premium_jsonl(path: Path) -> list[MarketPremiumRow]:
    out: list[MarketPremiumRow] = []
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out.append(
                MarketPremiumRow(
                    session_date=date.fromisoformat(r["session_date"]),
                    ticker=str(r["ticker"]).upper(),
                    bullish_premium=float(r["bullish_premium"]),
                    bearish_premium=float(r["bearish_premium"]),
                    trade_count=int(r["trade_count"]),
                    session_status=str(r.get("session_status") or "complete"),
                )
            )
    return out


def _spy_benchmark_stats(
    spy_bars: Sequence[DailyBar], start_day: date, end_day: date
) -> tuple[float, float, float]:
    sub = [b for b in sorted(spy_bars, key=lambda x: x.day) if start_day <= b.day <= end_day]
    if len(sub) < 2:
        return 0.0, 0.0, 0.0
    rets = [sub[i].adj_close / sub[i - 1].adj_close - 1.0 for i in range(1, len(sub)) if sub[i - 1].adj_close > 0]
    years = max((sub[-1].day - sub[0].day).days / 365.25, 1.0 / SESSIONS_PER_YEAR)
    total_ratio = sub[-1].adj_close / sub[0].adj_close
    cagr = max(-1.0, total_ratio ** (1.0 / years) - 1.0)
    mean = statistics.fmean(rets) if rets else 0.0
    std = statistics.stdev(rets) if len(rets) >= 2 else 0.0
    sharpe = (mean / std) * math.sqrt(SESSIONS_PER_YEAR) if std > 0 else 0.0
    peak = sub[0].adj_close
    worst_dd = 0.0
    for b in sub:
        peak = max(peak, b.adj_close)
        worst_dd = min(worst_dd, b.adj_close / peak - 1.0)
    return cagr, sharpe, max(-1.0, min(0.0, worst_dd))


def _hash_files(paths: Sequence[Path]) -> str:
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(p.name.encode("utf-8"))
        if p.exists():
            h.update(str(p.stat().st_size).encode("utf-8"))
            with p.open("rb") as fh:
                while chunk := fh.read(65_536):
                    h.update(chunk)
    return f"sha256:{h.hexdigest()[:24]}"


def _add_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # 29 February
        return day.replace(year=day.year + years, day=28)


def _universe_note(meta: Mapping[str, Any], bars: Mapping[str, Sequence[DailyBar]]) -> str:
    """How many pre-registered tickers have bars, for the survivorship gap of a study."""
    requested = meta.get("universe_requested")
    not_found = meta.get("bars_not_found")
    with_bars = len(bars)
    if not isinstance(requested, int) or not isinstance(not_found, list):
        return f"Daily bars cover {with_bars} tickers (SPY included)."
    return (
        f"Daily bars cover {with_bars} of the {requested} pre-registered tickers (SPY included; event tickers chosen "
        f"by whole-sample event count). Yahoo Finance has no history for {len(not_found)} of them (delisted, acquired "
        "or renamed issuers), so the result has survivorship bias."
    )


def _congress_coverage_gaps(meta: Mapping[str, Any]) -> list[tuple[str, str]]:
    """Gap rows for the PTR filings the parser could not read, from the collector's filing ledger.

    The ledger maps ``chamber:year:status:reason`` to a filing count.
    """
    ledger = meta.get("congress_ledger")
    totals: Counter[str] = Counter()
    year_totals: Counter[tuple[str, str]] = Counter()
    unparsed: Counter[tuple[str, str]] = Counter()
    unparsed_by_year: Counter[tuple[str, str, str]] = Counter()
    for key, count in ledger.items() if isinstance(ledger, Mapping) else ():
        parts = str(key).split(":")
        if len(parts) != 4:
            continue
        chamber, year, status, reason = parts
        totals[chamber] += int(count)
        year_totals[(chamber, year)] += int(count)
        if status != "parsed":
            unparsed[(chamber, reason)] += int(count)
            unparsed_by_year[(chamber, reason, year)] += int(count)
    if not totals:
        return [
            (
                "Unparsed PTRs excluded",
                "Scanned paper PTRs and PTRs with an unknown layout are excluded; the collector's filing ledger "
                "is not available for this run.",
            )
        ]

    years = sorted({year for _chamber, year in year_totals})
    span = years[0] if len(years) == 1 else f"{years[0]}–{years[-1]}"

    def share(chamber: str, reason: str) -> str:
        count, total = unparsed[(chamber, reason)], totals[chamber]
        return f"{count}/{total} ({100.0 * count / total:.1f}%)" if total else "0/0"

    rows = [
        (
            "Scanned paper PTRs excluded",
            f"Filings {span}: House {share('house', 'scanned_image')} and Senate {share('senate', 'scanned_image')} "
            "are scanned paper PTRs that the parser cannot read.",
        )
    ]
    if unparsed[("house", "layout_unknown")]:
        count, year = max(
            (count, year)
            for (chamber, reason, year), count in unparsed_by_year.items()
            if chamber == "house" and reason == "layout_unknown"
        )
        rows.append(
            (
                "House PTRs with an unknown PDF layout excluded",
                f"Filings {span}: House {share('house', 'layout_unknown')} electronic PTRs have a PDF layout that "
                f"house.v1 does not read; {count} of them were filed in {year} "
                f"({100.0 * count / year_totals[('house', year)]:.1f}% of the House PTRs of that year).",
            )
        )
    other = sum(
        count
        for (chamber, reason), count in unparsed.items()
        if reason != "scanned_image" and (chamber, reason) != ("house", "layout_unknown")
    )
    if other:
        rows.append(("Other unparsed PTRs excluded", f"Filings {span}: {other} more filings were not parsed."))
    return rows


def _to_trial(
    study_id: str, variant: str, holding: int, cost_bps: float, is_primary: bool, res: PortfolioResult
) -> TrialRecord:
    return TrialRecord(
        study_id=study_id,
        variant=variant,
        holding_days=holding,
        cost_bps=cost_bps,
        is_primary=is_primary,
        oos_events=res.oos.trades,
        oos_days=res.oos.days,
        oos_per_obs_sharpe=res.oos.per_obs_sharpe,
        oos_annual_sharpe=res.oos.sharpe,
        oos_cagr=res.oos.cagr,
        whole_cagr=res.whole.cagr,
        whole_sharpe=res.whole.sharpe,
        whole_max_drawdown=res.whole.max_drawdown,
        whole_trades=res.whole.trades,
        whole_win_rate=res.whole.win_rate,
    )


def run_all_studies(
    *,
    data_dir: Path,
    out_dir: Path,
    ran: date,
    commit: str,
) -> dict[str, Any]:
    bars = load_bars_dir(data_dir / "bars")
    spy_bars = bars.get("SPY")
    if not spy_bars:
        raise ValueError(f"Missing SPY daily bars in {data_dir / 'bars'}")

    meta_path = data_dir / "metadata.json"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    meta: Mapping[str, Any] = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}

    form4_path = data_dir / "form4_purchases.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    congress_path = data_dir / "congress_trades.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    premium_path = data_dir / "market_premium.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it

    bar_paths = sorted((data_dir / "bars").glob("*.csv"))
    universe_note = _universe_note(meta, bars)

    all_trials: list[TrialRecord] = []
    documents: list[dict[str, Any]] = []
    summaries: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Study 1: insider-purchase-confirmation
    # ------------------------------------------------------------------
    s1_id = "insider-purchase-confirmation"
    s1_start, s1_end, s1_oos = date(2016, 1, 1), date(2026, 3, 31), date(2024, 4, 1)
    form4_rows = load_form4_jsonl(form4_path)
    s1_variants, s1_diag = build_signal1_variants(form4_rows, bars)
    s1_results: dict[tuple[str, int], PortfolioResult] = {}
    s1_trials: list[TrialRecord] = []
    for var in SIGNAL1_VARIANTS:
        for h in HOLDING_DAYS:
            res = simulate_event_portfolio(
                s1_variants[var],
                bars,
                spy_bars,
                PortfolioConfig(holding_days=h, cost_bps=DEFAULT_COST_BPS),
                start_day=s1_start,
                end_day=s1_end,
                oos_start=s1_oos,
            )
            s1_results[(var, h)] = res
            tr = _to_trial(s1_id, var, h, DEFAULT_COST_BPS, (var == "cluster-3p-10d" and h == 20), res)
            s1_trials.append(tr)
            all_trials.append(tr)

    s1_primary = s1_results[("cluster-3p-10d", 20)]
    s1_stress0 = simulate_event_portfolio(
        s1_variants["cluster-3p-10d"],
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=0.0),
        start_day=s1_start,
        end_day=s1_end,
        oos_start=s1_oos,
    )
    s1_stress20 = simulate_event_portfolio(
        s1_variants["cluster-3p-10d"],
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=20.0),
        start_day=s1_start,
        end_day=s1_end,
        oos_start=s1_oos,
    )
    s1_no10b5 = simulate_event_portfolio(
        s1_variants["cluster-3p-10d-no-10b5-1"],
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=DEFAULT_COST_BPS),
        start_day=s1_start,
        end_day=s1_end,
        oos_start=s1_oos,
    )
    s1_dsr = compute_study_dsr(
        s1_primary.oos_excess_returns,
        [t.oos_per_obs_sharpe for t in s1_trials],
        len(s1_trials),
    )
    s1_verdict, s1_reason = evaluate_verdict(
        oos_sessions=s1_primary.oos.days,
        oos_events=s1_primary.oos.trades,
        oos_sharpe=s1_primary.oos.sharpe,
        dsr_probability=s1_dsr.probability if s1_dsr else None,
        stress_oos_sharpe=s1_stress20.oos.sharpe,
        n_trials=len(s1_trials),
    )
    spy1_cagr, spy1_sharpe, spy1_dd = _spy_benchmark_stats(spy_bars, s1_start, s1_end)
    s1_runs = [
        make_run_entry(
            symbol="Cluster 3p/10d (Primary, H=20)",
            market="Excess vs SPY, 10 bps/side",
            result=s1_primary,
            include_oos=True,
            spy_whole_cagr=spy1_cagr,
            spy_whole_sharpe=spy1_sharpe,
        ),
        make_run_entry(
            symbol="Confirmation Baseline (H=20)",
            market="alert_templates, 10 bps/side",
            result=s1_results[("confirmation-baseline", 20)],
            include_oos=True,
        ),
        make_run_entry(
            symbol="Cluster 3p/10d $100k+ (H=20)",
            market="Excess vs SPY, 10 bps/side",
            result=s1_results[("cluster-3p-10d-100k", 20)],
            include_oos=True,
        ),
        make_run_entry(
            symbol="Cluster + Confirm (H=20)",
            market="Excess vs SPY, 10 bps/side",
            result=s1_results[("cluster-3p-10d-confirm", 20)],
            include_oos=True,
        ),
        make_run_entry(
            symbol="Cluster 3p/10d (Stress 20 bps)",
            market="Excess vs SPY, 20 bps/side",
            result=s1_stress20,
            include_oos=True,
        ),
    ]
    s1_doc = build_study_document(
        study_id=s1_id,
        title="Insider Purchase Confirmation & SEC Form 4 Cluster Buys (2016–2026)",
        source_label="SEC EDGAR quarterly Form 3/4/5 datasets (2016Q1–2026Q1); alert_templates + PR 3 cluster rule",
        source_url="https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets",
        equity_label="Primary cluster-3p-10d (H=20) equal-weight 10-slot portfolio excess over SPY, 10 bps/side",
        verdict=s1_verdict,
        verdict_reason=s1_reason,
        ran=ran,
        commit=commit,
        data_hash=_hash_files([form4_path, *bar_paths]),
        primary_result=s1_primary,
        form_description=(
            "Equal-weight 10-slot event portfolio in excess of SPY entering at next trading day open after "
            "SEC Form 4 FILING_DATE (or confirmation close + 1 for confirmation-baseline). 10 bps/side base cost. "
            "Research only; no live or paper orders."
        ),
        form_label="Underlying equity excess over SPY (10-slot equal weight)",
        runs=s1_runs,
        comparison=[
            {
                "name": "Primary cluster-3p-10d (H=20, excess)",
                "kind": "strategy",
                "cagr": s1_primary.whole.cagr,
                "sharpe": s1_primary.whole.sharpe,
                "maxDrawdown": s1_primary.whole.max_drawdown,
            },
            {
                "name": "Confirmation baseline (H=20, excess)",
                "kind": "library",
                "cagr": s1_results[("confirmation-baseline", 20)].whole.cagr,
                "sharpe": s1_results[("confirmation-baseline", 20)].whole.sharpe,
                "maxDrawdown": s1_results[("confirmation-baseline", 20)].whole.max_drawdown,
            },
            {
                "name": "SPY buy-and-hold (total return)",
                "kind": "buy-and-hold",
                "cagr": spy1_cagr,
                "sharpe": spy1_sharpe,
                "maxDrawdown": spy1_dd,
            },
        ],
        sensitivity=[
            {
                "param": f"{var} | H={h}",
                "value": f"OOS {s1_results[(var, h)].oos.trades} ev",
                "cagr": s1_results[(var, h)].whole.cagr,
                "sharpe": s1_results[(var, h)].oos.sharpe,
                "maxDrawdown": s1_results[(var, h)].whole.max_drawdown,
                "trades": s1_results[(var, h)].whole.trades,
            }
            for var in SIGNAL1_VARIANTS
            for h in HOLDING_DAYS
        ],
        robustness=[
            {
                "check": f"Deflated Sharpe Ratio (N={len(s1_trials)}, bar >= {DSR_PASS_BAR:.2f})",
                "pass": bool(s1_dsr and s1_dsr.probability >= DSR_PASS_BAR),
                "result": (
                    f"DSR={s1_dsr.probability:.4f}, z={s1_dsr.z:.3f}, bench={s1_dsr.expected_max_sharpe:.4f}"
                    if s1_dsr
                    else "DSR unavailable (zero variance or insufficient observations)"
                ),
            },
            {
                "check": f"OOS Event Count (bar >= {MIN_OOS_EVENTS})",
                "pass": s1_primary.oos.trades >= MIN_OOS_EVENTS,
                "result": f"{s1_primary.oos.trades} OOS entries over {s1_primary.oos.days} sessions ({s1_oos}..{s1_end})",
            },
            {
                "check": "Cost Stress (0 / 10 / 20 bps per side)",
                "pass": s1_stress20.oos.sharpe > 0.0,
                "result": (
                    f"OOS Sharpe: 0bps={s1_stress0.oos.sharpe:.3f}, "
                    f"10bps={s1_primary.oos.sharpe:.3f}, 20bps={s1_stress20.oos.sharpe:.3f}"
                ),
            },
            {
                "check": "Post-2023 Rule 10b5-1 Exclusion Sensitivity",
                "pass": None,
                "result": (
                    f"Excluding {s1_diag['post_2023_10b5_1_flagged']} 10b5-1 rows: "
                    f"OOS Sharpe={s1_no10b5.oos.sharpe:.3f} ({s1_no10b5.oos.trades} OOS events)"
                ),
            },
            {
                "check": "Slot Overlap & Capacity Skips",
                "pass": None,
                "result": (
                    f"skipped_overlap={s1_primary.skipped_overlap}, skipped_capacity={s1_primary.skipped_capacity}, "
                    f"skipped_illiquid={s1_primary.skipped_illiquid}, missing_bars={s1_primary.skipped_missing_bars}, "
                    f"outside_window={s1_primary.skipped_outside_window}"
                ),
            },
        ],
        rules=[
            ("Universe", "146 liquid stocks + event tickers (capped at 600); point-in-time as-traded close >= $5 (later splits undone) and 20d median dollar vol >= $10M.", "plan-pr7.md"),
            ("Signal (Primary)", "cluster-3p-10d: >= 3 distinct reporting-owner groups filing Form 4 code P (common/ordinary) on same issuer within 10 calendar days on FILING_DATE; 14d cooldown.", "design.md PR 3"),
            ("Signal (Baseline)", "insider-purchase-confirmation: alert_templates.py fed with FILING_DATE (officer/director, >= $100k, close > SMA50, breakout or near-high on 1.5x vol).", "docs/specs/strategies/insider-purchase-confirmation.md"),
            ("Execution", "Next trading day open after trigger; equal-weight 10 slots; H in {5, 20, 60} (primary H=20); 10 bps/side; excess return over SPY.", "plan-pr7.md"),
            ("Verdict Gate", "OOS >= 24m (2024-04-01..2026-03-31), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N=12.", "plan-pr7.md"),
        ],
        gaps=[
            ("Universe cap & survivorship", universe_note),
            (
                "Form 4 rows outside the bar universe",
                f"{s1_diag['ticker_without_bars']} of {s1_diag['raw_purchases']} code-P Form 4 rows are in tickers without "
                f"bars and {s1_diag['no_bar_by_filing_day']} were filed before the first bar of their ticker; "
                f"{s1_primary.truncated_exits} exits were truncated.",
            ),
            (
                "SEC decimal typos / ticker reuse",
                f"Rejected {s1_diag['price_sanity_rejected']} Form 4 rows whose reported price fell outside [0.25x, 4.0x] of "
                "the as-traded close on the filing date (later splits undone).",
            ),
            (
                "SEC Rule 10b5-1 checkbox regime break (2023-04-01)",
                f"AFF10B5ONE did not exist before Q2 2023 ({s1_diag['post_2023_10b5_1_flagged']} post-2023 rows flagged); sensitivity check included in robustness.",
            ),
            (
                "Reporting delay & options translation",
                "Form 4 is due within 2 business days; backtest enters next open after FILING_DATE. Underlying equity study only; live Vertex rules require defined-risk options.",
            ),
        ],
        notes=(
            f"Raw code-P Form 4 purchases loaded: {s1_diag['raw_purchases']}; cleaned: {s1_diag['cleaned_purchases']}. "
            f"Primary trial (cluster-3p-10d, H=20): whole trades={s1_primary.whole.trades}, OOS trades={s1_primary.oos.trades}. "
            f"Confirmation baseline (H=20): whole trades={s1_results[('confirmation-baseline', 20)].whole.trades}, "
            f"OOS trades={s1_results[('confirmation-baseline', 20)].oos.trades}."
        ),
    )
    documents.append(s1_doc)
    summaries[s1_id] = {
        "verdict": s1_verdict,
        "reason": s1_reason,
        "oos_events": s1_primary.oos.trades,
        "oos_sharpe": round(s1_primary.oos.sharpe, 4),
        "dsr": round(s1_dsr.probability, 4) if s1_dsr else None,
        "n_trials": len(s1_trials),
        "baseline_oos_events": s1_results[("confirmation-baseline", 20)].oos.trades,
        "baseline_oos_sharpe": round(s1_results[("confirmation-baseline", 20)].oos.sharpe, 4),
    }

    # ------------------------------------------------------------------
    # Study 2: smart-money-congress-buys
    # ------------------------------------------------------------------
    s2_id = "smart-money-congress-buys"
    s2_start, s2_end, s2_oos = date(2022, 1, 1), date(2026, 11, 23), date(2024, 11, 23)
    congress_rows = load_congress_jsonl(congress_path)
    s2_variants, s2_diag = build_signal2_variants(congress_rows)
    s2_results: dict[tuple[str, int], PortfolioResult] = {}
    s2_trials: list[TrialRecord] = []
    for var in SIGNAL2_VARIANTS:
        for h in HOLDING_DAYS:
            res = simulate_event_portfolio(
                s2_variants[var],
                bars,
                spy_bars,
                PortfolioConfig(holding_days=h, cost_bps=DEFAULT_COST_BPS),
                start_day=s2_start,
                end_day=s2_end,
                oos_start=s2_oos,
            )
            s2_results[(var, h)] = res
            tr = _to_trial(s2_id, var, h, DEFAULT_COST_BPS, (var == "all-buys" and h == 20), res)
            s2_trials.append(tr)
            all_trials.append(tr)

    s2_primary = s2_results[("all-buys", 20)]
    s2_stress0 = simulate_event_portfolio(
        s2_variants["all-buys"],
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=0.0),
        start_day=s2_start,
        end_day=s2_end,
        oos_start=s2_oos,
    )
    s2_stress20 = simulate_event_portfolio(
        s2_variants["all-buys"],
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=20.0),
        start_day=s2_start,
        end_day=s2_end,
        oos_start=s2_oos,
    )
    s2_dsr = compute_study_dsr(
        s2_primary.oos_excess_returns,
        [t.oos_per_obs_sharpe for t in s2_trials],
        len(s2_trials),
    )
    s2_verdict, s2_reason = evaluate_verdict(
        oos_sessions=s2_primary.oos.days,
        oos_events=s2_primary.oos.trades,
        oos_sharpe=s2_primary.oos.sharpe,
        dsr_probability=s2_dsr.probability if s2_dsr else None,
        stress_oos_sharpe=s2_stress20.oos.sharpe,
        n_trials=len(s2_trials),
    )
    spy2_cagr, spy2_sharpe, spy2_dd = _spy_benchmark_stats(spy_bars, s2_start, s2_end)
    s2_doc = build_study_document(
        study_id=s2_id,
        title="Congress Electronic PTR Purchases by Filing Date (2022–2026)",
        source_label="U.S. House Clerk PTR PDFs & Senate eFD PTR HTML (2022–2025 offline + 2026 Postgres)",
        source_url="https://disclosures-clerk.house.gov/FinancialDisclosure",
        equity_label="Primary all-buys (H=20) equal-weight 10-slot portfolio excess over SPY, 10 bps/side",
        verdict=s2_verdict,
        verdict_reason=s2_reason,
        ran=ran,
        commit=commit,
        data_hash=_hash_files([congress_path, *bar_paths]),
        primary_result=s2_primary,
        form_description=(
            "Equal-weight 10-slot event portfolio in excess of SPY entering at next trading day open strictly "
            "after first PTR filed_on date (zero look-ahead; STOCK Act allows up to 45-day reporting delay). "
            "10 bps/side base cost. Research only; no live or paper orders."
        ),
        form_label="Underlying equity excess over SPY (10-slot equal weight)",
        runs=[
            make_run_entry(
                symbol="All PTR Buys (Primary, H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=s2_primary,
                include_oos=True,
                spy_whole_cagr=spy2_cagr,
                spy_whole_sharpe=spy2_sharpe,
            ),
            make_run_entry(
                symbol="Large Buys >= $50k (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=s2_results[("large-50k", 20)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="Fast-Filed <= 15d (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=s2_results[("fast-filed-15d", 20)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="Multi-Member 30d (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=s2_results[("multi-member-30d", 20)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="All PTR Buys (Stress 20 bps)",
                market="Excess vs SPY, 20 bps/side",
                result=s2_stress20,
                include_oos=True,
            ),
        ],
        comparison=[
            {
                "name": "Primary all-buys (H=20, excess)",
                "kind": "strategy",
                "cagr": s2_primary.whole.cagr,
                "sharpe": s2_primary.whole.sharpe,
                "maxDrawdown": s2_primary.whole.max_drawdown,
            },
            {
                "name": "Large >= $50k (H=20, excess)",
                "kind": "library",
                "cagr": s2_results[("large-50k", 20)].whole.cagr,
                "sharpe": s2_results[("large-50k", 20)].whole.sharpe,
                "maxDrawdown": s2_results[("large-50k", 20)].whole.max_drawdown,
            },
            {
                "name": "SPY buy-and-hold (total return)",
                "kind": "buy-and-hold",
                "cagr": spy2_cagr,
                "sharpe": spy2_sharpe,
                "maxDrawdown": spy2_dd,
            },
        ],
        sensitivity=[
            {
                "param": f"{var} | H={h}",
                "value": f"OOS {s2_results[(var, h)].oos.trades} ev",
                "cagr": s2_results[(var, h)].whole.cagr,
                "sharpe": s2_results[(var, h)].oos.sharpe,
                "maxDrawdown": s2_results[(var, h)].whole.max_drawdown,
                "trades": s2_results[(var, h)].whole.trades,
            }
            for var in SIGNAL2_VARIANTS
            for h in HOLDING_DAYS
        ],
        robustness=[
            {
                "check": f"Deflated Sharpe Ratio (N={len(s2_trials)}, bar >= {DSR_PASS_BAR:.2f})",
                "pass": bool(s2_dsr and s2_dsr.probability >= DSR_PASS_BAR),
                "result": (
                    f"DSR={s2_dsr.probability:.4f}, z={s2_dsr.z:.3f}, bench={s2_dsr.expected_max_sharpe:.4f}"
                    if s2_dsr
                    else "DSR unavailable (zero variance or insufficient observations)"
                ),
            },
            {
                "check": f"OOS Event Count (bar >= {MIN_OOS_EVENTS})",
                "pass": s2_primary.oos.trades >= MIN_OOS_EVENTS,
                "result": f"{s2_primary.oos.trades} OOS entries over {s2_primary.oos.days} sessions ({s2_oos}..{s2_end})",
            },
            {
                "check": "Cost Stress (0 / 10 / 20 bps per side)",
                "pass": s2_stress20.oos.sharpe > 0.0,
                "result": (
                    f"OOS Sharpe: 0bps={s2_stress0.oos.sharpe:.3f}, "
                    f"10bps={s2_primary.oos.sharpe:.3f}, 20bps={s2_stress20.oos.sharpe:.3f}"
                ),
            },
            {
                "check": "Deduplication & Capacity Skips",
                "pass": None,
                "result": (
                    f"deduped={s2_diag['deduped_purchases']} (removed {s2_diag['duplicates_removed']} dupes); "
                    f"overlap={s2_primary.skipped_overlap}, capacity={s2_primary.skipped_capacity}, "
                    f"illiquid={s2_primary.skipped_illiquid}, missing_bars={s2_primary.skipped_missing_bars}, "
                    f"outside_window={s2_primary.skipped_outside_window}"
                ),
            },
        ],
        rules=[
            ("Source", "House Clerk electronic PTR PDFs and Senate eFD electronic PTR HTML (2022–2026); parsed via vertex_openbb.jobs.congress. Pre-2022 House PDFs use legacy Wingdings/small-caps fonts.", "plan-pr7.md"),
            ("First-Filing Dedupe", "Retain earliest filed_on per (chamber, normalized_member, holder, ticker, tx_date_or_doc_id, purchase) so amendments never leak earlier.", "design.md PR 1"),
            ("Signal (Primary)", "all-buys: any deduplicated electronic PTR purchase with amount_low >= $1,001 on liquid equity (close >= $5, 20d median $vol >= $10M).", "plan-pr7.md"),
            ("Execution", "Next trading day open after filed_on; equal-weight 10 slots; H in {5, 20, 60} (primary H=20); 10 bps/side; excess return over SPY.", "plan-pr7.md"),
            ("Verdict Gate", "OOS >= 24m (2024-11-23..2026-11-23), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N=12.", "plan-pr7.md"),
        ],
        gaps=[
            ("STOCK Act reporting delay", "Members may disclose up to 45 days after execution; entry strictly follows filed_on."),
            *_congress_coverage_gaps(meta),
            ("Universe cap & survivorship", universe_note),
            (
                "Events outside the bar universe",
                f"{s2_primary.skipped_missing_bars} primary events had no bar on the entry day (ticker outside the bar "
                f"universe or not trading); {s2_primary.truncated_exits} exits were truncated.",
            ),
            ("House amendments", "House Clerk yearly index does not flag amendments; earliest filed_on deduplication mitigates re-disclosures."),
        ],
        notes=(
            f"Raw Congress purchase rows: {s2_diag['raw_rows']}; deduplicated: {s2_diag['deduped_purchases']}. "
            f"Primary trial (all-buys, H=20): whole trades={s2_primary.whole.trades}, OOS trades={s2_primary.oos.trades}."
        ),
    )
    documents.append(s2_doc)
    summaries[s2_id] = {
        "verdict": s2_verdict,
        "reason": s2_reason,
        "oos_events": s2_primary.oos.trades,
        "oos_sharpe": round(s2_primary.oos.sharpe, 4),
        "dsr": round(s2_dsr.probability, 4) if s2_dsr else None,
        "n_trials": len(s2_trials),
    }

    # ------------------------------------------------------------------
    # Study 3: smart-money-large-bullish-premium (needs-more-data, N = 1)
    # ------------------------------------------------------------------
    s3_id = "smart-money-large-bullish-premium"
    premium_rows = load_premium_jsonl(premium_path)
    s3_events, s3_diag = build_signal3_events(premium_rows, bars)
    s3_dates = sorted({r.session_date for r in premium_rows if r.session_status == "complete"})
    s3_start = s3_dates[0] if s3_dates else date(2025, 10, 16)
    s3_end = s3_dates[-1] if s3_dates else date(2026, 11, 20)
    s3_primary = simulate_event_portfolio(
        s3_events,
        bars,
        spy_bars,
        PortfolioConfig(holding_days=20, cost_bps=DEFAULT_COST_BPS, require_liquidity=False),
        start_day=s3_start,
        end_day=s3_end,
        oos_start=None,
    )
    s3_trial = _to_trial(s3_id, "top10-500k", 20, DEFAULT_COST_BPS, True, s3_primary)
    all_trials.append(s3_trial)
    if s3_primary.whole.days >= MIN_OOS_SESSIONS:
        # The frozen baseline is only valid while the history is shorter than the holdout. With a
        # full holdout the study needs a pre-registered in-sample/out-of-sample split and the gate.
        raise ValueError(
            f"{s3_id}: {s3_primary.whole.days} sessions reach the {MIN_OOS_SESSIONS}-session holdout; "
            "pre-register the out-of-sample split and evaluate the verdict gate (plan-pr7.md section 1.2)"
        )
    s3_verdict = "needs-more-data"
    s3_months = (s3_end - s3_start).days / 30.4375
    s3_unlock = _add_years(s3_start, 2).isoformat()
    s3_reason = (
        f"Insufficient history: {s3_diag['complete_sessions']} complete QuantData sessions "
        f"({s3_start.isoformat()} to {s3_end.isoformat()}, ~{s3_months:.1f} months < 24-month holdout required). "
        f"Rule top10-500k (H=20) is frozen at N = 1 with zero parameter sweep; full evaluation unlocks on {s3_unlock}. "
        f"Descriptive baseline over observed window: {s3_primary.whole.trades} entries, excess Sharpe {s3_primary.whole.sharpe:.3f}."
    )
    spy3_cagr, spy3_sharpe, spy3_dd = _spy_benchmark_stats(spy_bars, s3_start, s3_end)
    s3_doc = build_study_document(
        study_id=s3_id,
        title="Large Bullish Options Premium Flow (>= $100k Trades, Frozen Baseline)",
        source_label="QuantData gainers-losers (flow_market_premium, >= $100k/trade; bullish includes sold puts)",
        source_url="https://quantdata.us/llms-full.txt",
        equity_label="Frozen top10-500k (H=20) descriptive baseline excess over SPY, 10 bps/side (insufficient history)",
        verdict=s3_verdict,
        verdict_reason=s3_reason,
        ran=ran,
        commit=commit,
        data_hash=_hash_files([premium_path, *bar_paths]),
        primary_result=s3_primary,
        form_description=(
            "Frozen descriptive baseline only (verdict: needs-more-data). QuantData bullish class includes sold puts, "
            "so the signal is named large bullish premium (not call flow). Zero parameter sweep performed so future "
            f"out-of-sample evaluation after {s3_unlock} remains uncontaminated. Research only."
        ),
        form_label="Underlying equity excess over SPY (frozen baseline, < 2y history)",
        runs=[
            make_run_entry(
                symbol="Top 10 >= $500k (Frozen, H=20)",
                market="Excess vs SPY, 10 bps/side (<2y)",
                result=s3_primary,
                include_oos=False,
                spy_whole_cagr=spy3_cagr,
                spy_whole_sharpe=spy3_sharpe,
            ),
        ],
        comparison=[
            {
                "name": "Frozen top10-500k baseline (excess, <2y)",
                "kind": "strategy",
                "cagr": s3_primary.whole.cagr,
                "sharpe": s3_primary.whole.sharpe,
                "maxDrawdown": s3_primary.whole.max_drawdown,
            },
            {
                "name": "SPY buy-and-hold (same window)",
                "kind": "buy-and-hold",
                "cagr": spy3_cagr,
                "sharpe": spy3_sharpe,
                "maxDrawdown": spy3_dd,
            },
        ],
        sensitivity=[],
        robustness=[
            {
                "check": f"24-Month OOS History Requirement (>= {MIN_OOS_SESSIONS} sessions)",
                "pass": False,
                "result": f"{s3_diag['complete_sessions']} complete sessions ({s3_start}..{s3_end}); unlocks {s3_unlock}.",
            },
            {
                "check": "Zero OOS Parameter Sweep (Frozen Rule N = 1)",
                "pass": True,
                "result": "Single pre-registered rule top10-500k (H=20) evaluated descriptively; no threshold tuning.",
            },
            {
                "check": "Forward Event Collection Baseline",
                "pass": None,
                "result": (
                    f"qualifying_ticker_sessions={s3_diag['qualifying_ticker_sessions']}, "
                    f"top10_events={s3_diag['selected_top10_events']}, entries={s3_primary.whole.trades}"
                ),
            },
            {
                "check": "Slot Overlap, Capacity & Missing-Bar Skips",
                "pass": None,
                "result": (
                    f"events: overlap={s3_primary.skipped_overlap}, capacity={s3_primary.skipped_capacity}, "
                    f"missing_bars={s3_primary.skipped_missing_bars}, outside_window={s3_primary.skipped_outside_window}; "
                    f"ticker-sessions before ranking: without_bars={s3_diag['premium_rows_without_bars']}, "
                    f"illiquid={s3_diag['premium_rows_illiquid']}"
                ),
            },
        ],
        rules=[
            ("Source", "QuantVPS flow_market_premium complete sessions (QuantData gainers-losers, filter premium >= $100,000, isCancelled = false).", "design.md PR 2"),
            ("Bullish Class", "QuantData bullish class includes long calls and sold puts; signal is named large bullish premium, never call flow.", "design.md PR 7"),
            ("Frozen Rule", "On each complete session: close >= $5, 20d median $vol >= $10M, bullish_premium >= $500k, bullish share >= 70%, trade_count >= 3; top 10 by net premium.", "plan-pr7.md"),
            ("Execution", f"Next trading day open; equal-weight 10 slots; H=20; 10 bps/side; excess return over SPY. Unlocks for full verdict on {s3_unlock}.", "plan-pr7.md"),
        ],
        gaps=[
            ("History below 2-year holdout", f"QuantData exposes ~1 year of history ({s3_start}..{s3_end}, {s3_diag['complete_sessions']} complete sessions). Verdict stays needs-more-data until {s3_unlock}."),
            ("Trade-side taxonomy", "QuantData bullish premium aggregates calls bought at ask and puts sold at bid; option-side decomposition is not present in gainers-losers."),
            ("Intraday vs EOD capture", "Complete sessions settle after midnight; entries occur at next session open (zero look-ahead)."),
            ("Universe cap & survivorship", universe_note),
            (
                "Slot capacity",
                f"The 10 slots stay full for 20 sessions, so {s3_primary.skipped_capacity} of "
                f"{s3_diag['selected_top10_events']} top-10 events were skipped for capacity and "
                f"{s3_primary.skipped_overlap} because the ticker was already held.",
            ),
        ],
        notes=(
            f"Complete sessions: {s3_diag['complete_sessions']} ({s3_start}..{s3_end}). "
            f"Rule frozen at N = 1 (top10-500k, H=20); full evaluation unlocks {s3_unlock}."
        ),
    )
    documents.append(s3_doc)
    summaries[s3_id] = {
        "verdict": s3_verdict,
        "reason": s3_reason,
        "complete_sessions": s3_diag["complete_sessions"],
        "baseline_entries": s3_primary.whole.trades,
        "baseline_sharpe": round(s3_primary.whole.sharpe, 4),
        "n_trials": 1,
    }

    jsonl_path, trials_path = write_study_bundle(out_dir, documents, all_trials)
    summary_path = out_dir / "summary.json"  # json-data-ignore: report artifact under ~/Documents, outside the repo; studies reach Postgres through the importer and the app never reads the file
    summary_path.write_text(json.dumps(summaries, indent=2) + "\n", encoding="utf-8")
    return {
        "summaries": summaries,
        "studies_jsonl": str(jsonl_path),
        "trials_json": str(trials_path),
        "summary_json": str(summary_path),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run smart-money PR 7 backtests and emit study JSONs.")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--ran", default=date.today().isoformat())
    parser.add_argument("--commit", required=True)
    args = parser.parse_args(argv)
    result = run_all_studies(
        data_dir=args.data_dir,
        out_dir=args.out_dir,
        ran=date.fromisoformat(args.ran),
        commit=args.commit,
    )
    print(json.dumps(result["summaries"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
