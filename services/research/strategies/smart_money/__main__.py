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
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from backtesting.optimizer import DeflatedSharpe

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
PRIMARY_HOLDING_DAYS = 20
STRESS_COST_BPS = 20.0
SIGNAL1_VARIANTS: tuple[str, ...] = (
    "confirmation-baseline",
    "cluster-3p-10d",
    "cluster-3p-10d-100k",
    "cluster-3p-10d-confirm",
)
SIGNAL1_PRIMARY = "cluster-3p-10d"
SIGNAL2_VARIANTS: tuple[str, ...] = (
    "all-buys",
    "large-50k",
    "fast-filed-15d",
    "multi-member-30d",
)
SIGNAL2_PRIMARY = "all-buys"
SIGNAL3_VARIANT = "top10-500k"


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


def _read_event_rows(path: Path) -> list[dict[str, Any]]:
    """Rows of one collector event file. A missing or empty file stops the run.

    An empty input would otherwise end as a recorded ``no-edge`` verdict with zero events.
    """
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing; run scripts/smart-money-pr7/fetch_data.py")
    with path.open("r", encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    if not rows:
        raise ValueError(f"{path} has no rows; run scripts/smart-money-pr7/fetch_data.py again")
    return rows


def load_form4_jsonl(path: Path) -> list[Form4Purchase]:
    return [
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
        for r in _read_event_rows(path)
    ]


def load_congress_jsonl(path: Path) -> list[CongressPurchase]:
    rows = _read_event_rows(path)
    if any("asset_type" not in r for r in rows):
        # A file from an older collector has no asset type, and option rows would count as stock buys.
        raise ValueError(f"{path} has rows without asset_type; run scripts/smart-money-pr7/fetch_data.py again")
    return [
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
            asset_type=str(r["asset_type"]) if r.get("asset_type") else None,
        )
        for r in rows
    ]


def load_premium_jsonl(path: Path) -> list[MarketPremiumRow]:
    return [
        MarketPremiumRow(
            session_date=date.fromisoformat(r["session_date"]),
            ticker=str(r["ticker"]).upper(),
            bullish_premium=float(r["bullish_premium"]),
            bearish_premium=float(r["bearish_premium"]),
            trade_count=int(r["trade_count"]),
            session_status=str(r.get("session_status") or "complete"),
        )
        for r in _read_event_rows(path)
    ]


MAX_EVENT_FILE_LAG_DAYS = 14


def _require_events_through(newest: date, window_end: date, path: Path) -> None:
    """Stop when an event file ends well before the study window does.

    The verdict gate counts out-of-sample sessions on the benchmark, so a file that ends early
    (a collector run that stopped) would still show a full holdout with too few events.
    """
    if (window_end - newest).days > MAX_EVENT_FILE_LAG_DAYS:
        raise ValueError(
            f"{path} ends on {newest.isoformat()}, more than {MAX_EVENT_FILE_LAG_DAYS} days before the window end "
            f"{window_end.isoformat()}; run scripts/smart-money-pr7/fetch_data.py again"
        )


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


@dataclass(frozen=True, slots=True)
class StudyWindow:
    start: date
    end: date
    oos_start: date


@dataclass(frozen=True, slots=True)
class GatedStudy:
    """One pre-registered study with a full out-of-sample window, after the verdict gate."""

    study_id: str
    window: StudyWindow
    variant_names: tuple[str, ...]
    results: Mapping[tuple[str, int], PortfolioResult]  # every counted trial at the base cost
    trials: tuple[TrialRecord, ...]
    primary: PortfolioResult
    stress0: PortfolioResult  # primary trial at 0 bps per side
    stress20: PortfolioResult  # primary trial at 20 bps per side
    dsr: DeflatedSharpe | None
    verdict: str
    reason: str


def run_gated_study(
    *,
    study_id: str,
    variants: Mapping[str, Sequence[SignalEvent]],
    variant_names: Sequence[str],
    primary_variant: str,
    bars: Mapping[str, Sequence[DailyBar]],
    spy_bars: Sequence[DailyBar],
    window: StudyWindow,
) -> GatedStudy:
    """Run every counted trial of a study and apply the verdict gate to its primary trial.

    The counted trials are ``variant_names`` x ``HOLDING_DAYS`` at the base cost. The gate reads
    only the primary trial (``primary_variant``, ``PRIMARY_HOLDING_DAYS``): its out-of-sample
    events, sessions and Sharpe, its 20 bps stress run, and the deflated Sharpe ratio of its
    out-of-sample returns against the per-observation Sharpes of all counted trials.
    """

    def simulate(variant: str, holding: int, cost_bps: float) -> PortfolioResult:
        return simulate_event_portfolio(
            variants[variant],
            bars,
            spy_bars,
            PortfolioConfig(holding_days=holding, cost_bps=cost_bps),
            start_day=window.start,
            end_day=window.end,
            oos_start=window.oos_start,
        )

    results: dict[tuple[str, int], PortfolioResult] = {}
    trials: list[TrialRecord] = []
    for variant in variant_names:
        for holding in HOLDING_DAYS:
            result = simulate(variant, holding, DEFAULT_COST_BPS)
            results[(variant, holding)] = result
            is_primary = variant == primary_variant and holding == PRIMARY_HOLDING_DAYS
            trials.append(_to_trial(study_id, variant, holding, DEFAULT_COST_BPS, is_primary, result))

    primary = results[(primary_variant, PRIMARY_HOLDING_DAYS)]
    stress0 = simulate(primary_variant, PRIMARY_HOLDING_DAYS, 0.0)
    stress20 = simulate(primary_variant, PRIMARY_HOLDING_DAYS, STRESS_COST_BPS)
    dsr = compute_study_dsr(
        primary.oos_excess_returns,
        [trial.oos_per_obs_sharpe for trial in trials],
        len(trials),
    )
    verdict, reason = evaluate_verdict(
        oos_sessions=primary.oos.days,
        oos_events=primary.oos.trades,
        oos_sharpe=primary.oos.sharpe,
        dsr_probability=dsr.probability if dsr else None,
        stress_oos_sharpe=stress20.oos.sharpe,
        n_trials=len(trials),
    )
    return GatedStudy(
        study_id=study_id,
        window=window,
        variant_names=tuple(variant_names),
        results=results,
        trials=tuple(trials),
        primary=primary,
        stress0=stress0,
        stress20=stress20,
        dsr=dsr,
        verdict=verdict,
        reason=reason,
    )


def _gate_robustness_rows(study: GatedStudy) -> list[dict[str, Any]]:
    """The three robustness rows that restate the verdict gate of a study."""
    dsr, primary, window = study.dsr, study.primary, study.window
    return [
        {
            "check": f"Deflated Sharpe Ratio (N={len(study.trials)}, bar >= {DSR_PASS_BAR:.2f})",
            "pass": bool(dsr and dsr.probability >= DSR_PASS_BAR),
            "result": (
                f"DSR={dsr.probability:.4f}, z={dsr.z:.3f}, bench={dsr.expected_max_sharpe:.4f}"
                if dsr
                else "DSR unavailable (zero variance or insufficient observations)"
            ),
        },
        {
            "check": f"OOS Event Count (bar >= {MIN_OOS_EVENTS})",
            "pass": primary.oos.trades >= MIN_OOS_EVENTS,
            "result": (
                f"{primary.oos.trades} OOS entries over {primary.oos.days} sessions "
                f"({window.oos_start}..{window.end})"
            ),
        },
        {
            "check": "Cost Stress (0 / 10 / 20 bps per side)",
            "pass": study.stress20.oos.sharpe > 0.0,
            "result": (
                f"OOS Sharpe: 0bps={study.stress0.oos.sharpe:.3f}, "
                f"10bps={primary.oos.sharpe:.3f}, 20bps={study.stress20.oos.sharpe:.3f}"
            ),
        },
    ]


def _sensitivity_rows(study: GatedStudy) -> list[dict[str, Any]]:
    """One row per counted trial: whole-sample metrics, with the out-of-sample result in ``value``."""
    rows: list[dict[str, Any]] = []
    for variant in study.variant_names:
        for holding in HOLDING_DAYS:
            result = study.results[(variant, holding)]
            rows.append(
                {
                    "param": f"{variant} | H={holding}",
                    "value": f"OOS {result.oos.trades} ev, Sharpe {result.oos.sharpe:+.3f}",
                    "cagr": result.whole.cagr,
                    "sharpe": result.whole.sharpe,
                    "maxDrawdown": result.whole.max_drawdown,
                    "trades": result.whole.trades,
                }
            )
    return rows


def _comparison_row(name: str, kind: str, result: PortfolioResult) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "cagr": result.whole.cagr,
        "sharpe": result.whole.sharpe,
        "maxDrawdown": result.whole.max_drawdown,
    }


def _spy_comparison_row(name: str, cagr: float, sharpe: float, max_drawdown: float) -> dict[str, Any]:
    return {"name": name, "kind": "buy-and-hold", "cagr": cagr, "sharpe": sharpe, "maxDrawdown": max_drawdown}


@dataclass(frozen=True, slots=True)
class RunContext:
    data_dir: Path
    ran: date
    commit: str
    bars: Mapping[str, Sequence[DailyBar]]
    spy_bars: Sequence[DailyBar]
    bar_paths: tuple[Path, ...]
    meta: Mapping[str, Any]
    universe_note: str
    # Bars of the cap plus every other ticker with an event, or None when the collector's
    # bars_events folder is absent. Only the post-hoc full-universe check reads them.
    full_bars: Mapping[str, Sequence[DailyBar]] | None
    full_bar_paths: tuple[Path, ...]


POST_HOC_CHECK = "Post-hoc: full event universe (not in the verdict)"
POST_HOC_VARIANT = "post-hoc-full-universe"
POST_HOC_GAP_NAME = "Post-hoc full-universe check"
POST_HOC_GAP_RUN = (
    "The 600-ticker cap was chosen by whole-sample event counts. After the first look at the out-of-sample window, "
    "the primary trial was also run on every ticker with an event. That result is in the robustness rows. It is not "
    "the verdict: it counts as one more trial, and a pass there would need a new holdout."
)
POST_HOC_GAP_NOT_RUN = (
    "The 600-ticker cap was chosen by whole-sample event counts. The primary trial was not run on a wider universe "
    "in this run, because the collector's bars_events folder has no bars."
)


@dataclass(frozen=True, slots=True)
class PostHocRun:
    robustness_row: dict[str, Any]
    gap: tuple[str, str]
    summary: dict[str, Any] | None  # None when the run did not happen
    trial: TrialRecord | None  # logged with the counted trials, marked by its variant name

    def trials_after(self, gated: Sequence[TrialRecord]) -> tuple[TrialRecord, ...]:
        return (*gated, self.trial) if self.trial is not None else tuple(gated)


def _post_hoc_full_universe(
    ctx: RunContext, study: GatedStudy, events: Sequence[SignalEvent] | None
) -> PostHocRun:
    """The primary trial without the 600-ticker cap: a robustness row, a gap row, a summary and a trial.

    The trading knowledge base advised (2026-11-25) to keep the pre-registered capped result as the
    verdict and to report this run as a post-hoc deviation that counts as one more trial.
    """
    if ctx.full_bars is None or events is None:
        row = {"check": POST_HOC_CHECK, "pass": None, "result": "Not run: the collector's bars_events folder has no bars."}
        return PostHocRun(row, (POST_HOC_GAP_NAME, POST_HOC_GAP_NOT_RUN), None, None)
    window = study.window
    result = simulate_event_portfolio(
        events,
        ctx.full_bars,
        ctx.spy_bars,
        PortfolioConfig(holding_days=PRIMARY_HOLDING_DAYS, cost_bps=DEFAULT_COST_BPS),
        start_day=window.start,
        end_day=window.end,
        oos_start=window.oos_start,
    )
    n_trials = len(study.trials) + 1
    dsr = compute_study_dsr(
        result.oos_excess_returns,
        [*(trial.oos_per_obs_sharpe for trial in study.trials), result.oos.per_obs_sharpe],
        n_trials,
    )
    dsr_text = f"{dsr.probability:.3f}" if dsr else "unavailable"
    requested = ctx.meta.get("event_bars_extra_requested")
    cached = ctx.meta.get("event_bars_extra_cached")
    history = (
        f" ({cached} of {requested} further tickers have history)"
        if isinstance(requested, int) and isinstance(cached, int)
        else ""
    )
    row = {
        "check": POST_HOC_CHECK,
        "pass": None,
        "result": (
            f"Bars for {len(ctx.full_bars)} tickers{history}: {result.oos.trades} OOS events, "
            f"OOS Sharpe {result.oos.sharpe:.3f}, DSR {dsr_text} at N={n_trials}; whole-sample trades "
            f"{result.whole.trades}, Sharpe {result.whole.sharpe:.3f}. No 20 bps stress run. A pass here would need "
            "a new holdout."
        ),
    }
    summary = {
        "tickers_with_bars": len(ctx.full_bars),
        "oos_events": result.oos.trades,
        "oos_sharpe": round(result.oos.sharpe, 4),
        "dsr": round(dsr.probability, 4) if dsr else None,
        "n_trials": n_trials,
        "whole_trades": result.whole.trades,
        "whole_sharpe": round(result.whole.sharpe, 4),
    }
    trial = _to_trial(study.study_id, POST_HOC_VARIANT, PRIMARY_HOLDING_DAYS, DEFAULT_COST_BPS, False, result)
    return PostHocRun(row, (POST_HOC_GAP_NAME, POST_HOC_GAP_RUN), summary, trial)


@dataclass(frozen=True, slots=True)
class StudyOutput:
    document: dict[str, Any]
    summary: dict[str, Any]
    trials: tuple[TrialRecord, ...]


def _insider_study(ctx: RunContext) -> StudyOutput:
    study_id = "insider-purchase-confirmation"
    window = StudyWindow(start=date(2016, 1, 1), end=date(2026, 3, 31), oos_start=date(2024, 4, 1))
    form4_path = ctx.data_dir / "form4_purchases.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    purchases = load_form4_jsonl(form4_path)
    _require_events_through(max(p.filing_date for p in purchases), window.end, form4_path)
    variants, diag = build_signal1_variants(purchases, ctx.bars)
    study = run_gated_study(
        study_id=study_id,
        variants=variants,
        variant_names=SIGNAL1_VARIANTS,
        primary_variant=SIGNAL1_PRIMARY,
        bars=ctx.bars,
        spy_bars=ctx.spy_bars,
        window=window,
    )
    primary = study.primary
    baseline = study.results[("confirmation-baseline", PRIMARY_HOLDING_DAYS)]
    no_10b5_1 = simulate_event_portfolio(
        variants["cluster-3p-10d-no-10b5-1"],
        ctx.bars,
        ctx.spy_bars,
        PortfolioConfig(holding_days=PRIMARY_HOLDING_DAYS, cost_bps=DEFAULT_COST_BPS),
        start_day=window.start,
        end_day=window.end,
        oos_start=window.oos_start,
    )

    post_hoc = _post_hoc_full_universe(
        ctx,
        study,
        build_signal1_variants(purchases, ctx.full_bars)[0][SIGNAL1_PRIMARY] if ctx.full_bars is not None else None,
    )

    # Coverage of the pre-registered bar universe: the cluster rule on every issuer against the
    # cluster events that the study can trade.
    in_window = [e for e in variants["cluster-3p-10d-all-issuers"] if window.start <= e.trigger_day <= window.end]
    tradable = [e for e in variants[SIGNAL1_PRIMARY] if window.start <= e.trigger_day <= window.end]
    coverage = (
        f"{len(tradable)} of {len(in_window)} cluster events in the window "
        f"({len({e.symbol for e in tradable})} of {len({e.symbol for e in in_window})} tickers) remain after the "
        f"bar universe and the price guard; out of sample {sum(e.trigger_day >= window.oos_start for e in tradable)} "
        f"of {sum(e.trigger_day >= window.oos_start for e in in_window)}. The out-of-sample event count therefore "
        "also reflects the 600-ticker cap."
    )

    spy_cagr, spy_sharpe, spy_dd = _spy_benchmark_stats(ctx.spy_bars, window.start, window.end)
    document = build_study_document(
        study_id=study_id,
        title="Insider Purchase Confirmation & SEC Form 4 Cluster Buys (2016–2026)",
        source_label="SEC EDGAR quarterly Form 3/4/5 datasets (2016Q1–2026Q1); alert_templates + PR 3 cluster rule",
        source_url="https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets",
        equity_label="Primary cluster-3p-10d (H=20) equal-weight 10-slot portfolio excess over SPY, 10 bps/side",
        verdict=study.verdict,
        verdict_reason=study.reason,
        ran=ctx.ran,
        commit=ctx.commit,
        data_hash=_hash_files([form4_path, *ctx.bar_paths, *ctx.full_bar_paths]),
        primary_result=primary,
        form_description=(
            "Equal-weight 10-slot event portfolio in excess of SPY entering at next trading day open after "
            "SEC Form 4 FILING_DATE (or confirmation close + 1 for confirmation-baseline). 10 bps/side base cost. "
            "Research only; no live or paper orders."
        ),
        form_label="Underlying equity excess over SPY (10-slot equal weight)",
        runs=[
            make_run_entry(
                symbol="Cluster 3p/10d (Primary, H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=primary,
                include_oos=True,
                spy_whole_cagr=spy_cagr,
                spy_whole_sharpe=spy_sharpe,
            ),
            make_run_entry(
                symbol="Confirmation Baseline (H=20)",
                market="alert_templates, 10 bps/side",
                result=baseline,
                include_oos=True,
            ),
            make_run_entry(
                symbol="Cluster 3p/10d $100k+ (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=study.results[("cluster-3p-10d-100k", PRIMARY_HOLDING_DAYS)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="Cluster + Confirm (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=study.results[("cluster-3p-10d-confirm", PRIMARY_HOLDING_DAYS)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="Cluster 3p/10d (Stress 20 bps)",
                market="Excess vs SPY, 20 bps/side",
                result=study.stress20,
                include_oos=True,
            ),
        ],
        comparison=[
            _comparison_row("Primary cluster-3p-10d (H=20, excess)", "strategy", primary),
            _comparison_row("Confirmation baseline (H=20, excess)", "library", baseline),
            _spy_comparison_row("SPY buy-and-hold (total return)", spy_cagr, spy_sharpe, spy_dd),
        ],
        sensitivity=_sensitivity_rows(study),
        robustness=[
            *_gate_robustness_rows(study),
            {
                "check": "Post-2023 Rule 10b5-1 Exclusion Sensitivity",
                "pass": None,
                "result": (
                    f"Excluding {diag['post_2023_10b5_1_flagged']} 10b5-1 rows: "
                    f"OOS Sharpe={no_10b5_1.oos.sharpe:.3f} ({no_10b5_1.oos.trades} OOS events)"
                ),
            },
            {
                "check": "Slot Overlap & Capacity Skips",
                "pass": None,
                "result": (
                    f"skipped_overlap={primary.skipped_overlap}, skipped_capacity={primary.skipped_capacity}, "
                    f"skipped_illiquid={primary.skipped_illiquid}, missing_bars={primary.skipped_missing_bars}, "
                    f"outside_window={primary.skipped_outside_window}"
                ),
            },
            post_hoc.robustness_row,
        ],
        rules=[
            ("Universe", "146 liquid stocks + event tickers (capped at 600); point-in-time as-traded close >= $5 (later splits undone) and 20d median dollar vol >= $10M.", "plan-pr7.md"),
            ("Signal (Primary)", "cluster-3p-10d: >= 3 distinct reporting-owner groups filing Form 4 code P (common/ordinary) on same issuer within 10 calendar days on FILING_DATE; 14d cooldown.", "design.md PR 3"),
            ("Signal (Baseline)", "insider-purchase-confirmation: alert_templates.py fed with FILING_DATE (officer/director, >= $100k, close > SMA50, breakout or near-high on 1.5x vol).", "docs/specs/strategies/insider-purchase-confirmation.md"),
            ("Execution", "Next trading day open after trigger; equal-weight 10 slots; H in {5, 20, 60} (primary H=20); 10 bps/side; excess return over SPY.", "plan-pr7.md"),
            ("Verdict Gate", f"OOS >= 24m ({window.oos_start}..{window.end}), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N={len(study.trials)}.", "plan-pr7.md"),
        ],
        gaps=[
            ("Universe cap & survivorship", ctx.universe_note),
            ("Cluster events outside the bar universe", coverage),
            post_hoc.gap,
            (
                "Form 4 rows outside the bar universe",
                f"{diag['ticker_without_bars']} of {diag['raw_purchases']} code-P Form 4 rows are in tickers without "
                f"bars and {diag['no_bar_by_filing_day']} were filed before the first bar of their ticker; "
                f"{primary.truncated_exits} exits were truncated.",
            ),
            (
                "SEC decimal typos / ticker reuse",
                f"Rejected {diag['price_sanity_rejected']} Form 4 rows whose reported price fell outside [0.25x, 4.0x] of "
                "the as-traded close on the filing date (later splits undone).",
            ),
            (
                "Share-volume floor of the confirmation baseline",
                "The template's 1,000,000-share average-volume floor reads Yahoo volumes that are restated for later "
                "splits, so a few confirmation-baseline events differ from a point-in-time evaluation. The cluster "
                "variants do not use this floor.",
            ),
            (
                "SEC Rule 10b5-1 checkbox regime break (2023-04-01)",
                f"AFF10B5ONE did not exist before Q2 2023 ({diag['post_2023_10b5_1_flagged']} post-2023 rows flagged); sensitivity check included in robustness.",
            ),
            (
                "Reporting delay & options translation",
                "Form 4 is due within 2 business days; backtest enters next open after FILING_DATE. Underlying equity study only; live Vertex rules require defined-risk options.",
            ),
        ],
        notes=(
            f"Raw code-P Form 4 purchases loaded: {diag['raw_purchases']}; cleaned: {diag['cleaned_purchases']}. "
            f"Primary trial (cluster-3p-10d, H=20): whole trades={primary.whole.trades}, OOS trades={primary.oos.trades}. "
            f"Confirmation baseline (H=20): whole trades={baseline.whole.trades}, OOS trades={baseline.oos.trades}."
        ),
    )
    summary = {
        "verdict": study.verdict,
        "reason": study.reason,
        "oos_events": primary.oos.trades,
        "oos_sharpe": round(primary.oos.sharpe, 4),
        "dsr": round(study.dsr.probability, 4) if study.dsr else None,
        "n_trials": len(study.trials),
        "baseline_oos_events": baseline.oos.trades,
        "baseline_oos_sharpe": round(baseline.oos.sharpe, 4),
        "post_hoc_full_universe": post_hoc.summary,
    }
    return StudyOutput(document, summary, post_hoc.trials_after(study.trials))


def _congress_study(ctx: RunContext) -> StudyOutput:
    study_id = "smart-money-congress-buys"
    window = StudyWindow(start=date(2022, 1, 1), end=date(2026, 11, 23), oos_start=date(2024, 11, 23))
    congress_path = ctx.data_dir / "congress_trades.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    congress_rows = load_congress_jsonl(congress_path)
    _require_events_through(max(r.filed_on for r in congress_rows), window.end, congress_path)
    variants, diag = build_signal2_variants(congress_rows)
    study = run_gated_study(
        study_id=study_id,
        variants=variants,
        variant_names=SIGNAL2_VARIANTS,
        primary_variant=SIGNAL2_PRIMARY,
        bars=ctx.bars,
        spy_bars=ctx.spy_bars,
        window=window,
    )
    primary = study.primary
    large = study.results[("large-50k", PRIMARY_HOLDING_DAYS)]
    post_hoc = _post_hoc_full_universe(ctx, study, variants[SIGNAL2_PRIMARY])

    spy_cagr, spy_sharpe, spy_dd = _spy_benchmark_stats(ctx.spy_bars, window.start, window.end)
    document = build_study_document(
        study_id=study_id,
        title="Congress Electronic PTR Purchases by Filing Date (2022–2026)",
        source_label="U.S. House Clerk PTR PDFs & Senate eFD PTR HTML (2022–2025 offline + 2026 Postgres)",
        source_url="https://disclosures-clerk.house.gov/FinancialDisclosure",
        equity_label="Primary all-buys (H=20) equal-weight 10-slot portfolio excess over SPY, 10 bps/side",
        verdict=study.verdict,
        verdict_reason=study.reason,
        ran=ctx.ran,
        commit=ctx.commit,
        data_hash=_hash_files([congress_path, *ctx.bar_paths, *ctx.full_bar_paths]),
        primary_result=primary,
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
                result=primary,
                include_oos=True,
                spy_whole_cagr=spy_cagr,
                spy_whole_sharpe=spy_sharpe,
            ),
            make_run_entry(
                symbol="Large Buys >= $50k (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=large,
                include_oos=True,
            ),
            make_run_entry(
                symbol="Fast-Filed <= 15d (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=study.results[("fast-filed-15d", PRIMARY_HOLDING_DAYS)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="Multi-Member 30d (H=20)",
                market="Excess vs SPY, 10 bps/side",
                result=study.results[("multi-member-30d", PRIMARY_HOLDING_DAYS)],
                include_oos=True,
            ),
            make_run_entry(
                symbol="All PTR Buys (Stress 20 bps)",
                market="Excess vs SPY, 20 bps/side",
                result=study.stress20,
                include_oos=True,
            ),
        ],
        comparison=[
            _comparison_row("Primary all-buys (H=20, excess)", "strategy", primary),
            _comparison_row("Large >= $50k (H=20, excess)", "library", large),
            _spy_comparison_row("SPY buy-and-hold (total return)", spy_cagr, spy_sharpe, spy_dd),
        ],
        sensitivity=_sensitivity_rows(study),
        robustness=[
            *_gate_robustness_rows(study),
            {
                "check": "Deduplication & Capacity Skips",
                "pass": None,
                "result": (
                    f"trades={diag['deduped_purchases']} (dropped {diag['option_rows_dropped']} option rows, merged "
                    f"{diag['same_filing_lots_merged']} same-filing lots, dropped {diag['later_filings_dropped']} later filings); "
                    f"overlap={primary.skipped_overlap}, capacity={primary.skipped_capacity}, "
                    f"illiquid={primary.skipped_illiquid}, missing_bars={primary.skipped_missing_bars}, "
                    f"outside_window={primary.skipped_outside_window}"
                ),
            },
            post_hoc.robustness_row,
        ],
        rules=[
            ("Source", "House Clerk electronic PTR PDFs and Senate eFD electronic PTR HTML (2022–2026); parsed via vertex_openbb.jobs.congress. Pre-2022 House PDFs use legacy Wingdings/small-caps fonts.", "plan-pr7.md"),
            ("One event per trade", "Key: chamber, normalized member, holder, ticker, transaction date (or filing when the date is missing). Lots inside one filing are summed; of several filings the earliest filed_on is kept, so amendments never move the public-at date.", "design.md PR 1"),
            ("Signal (Primary)", "all-buys: any deduplicated electronic PTR purchase with amount_low >= $1,001 on liquid equity (close >= $5, 20d median $vol >= $10M).", "plan-pr7.md"),
            ("Execution", "Next trading day open after filed_on; equal-weight 10 slots; H in {5, 20, 60} (primary H=20); 10 bps/side; excess return over SPY.", "plan-pr7.md"),
            ("Verdict Gate", f"OOS >= 24m ({window.oos_start}..{window.end}), >= 100 OOS events, OOS Sharpe > 0 at 10 & 20 bps, DSR >= 0.95 at N={len(study.trials)}.", "plan-pr7.md"),
        ],
        gaps=[
            ("STOCK Act reporting delay", "Members may disclose up to 45 days after execution; entry strictly follows filed_on."),
            *_congress_coverage_gaps(ctx.meta),
            ("Universe cap & survivorship", ctx.universe_note),
            post_hoc.gap,
            (
                "Events outside the bar universe",
                f"{primary.skipped_missing_bars} primary events had no bar on the entry day (ticker outside the bar "
                f"universe or not trading); {primary.truncated_exits} exits were truncated.",
            ),
            ("House amendments", "House Clerk yearly index does not flag amendments; earliest filed_on deduplication mitigates re-disclosures."),
            (
                "Option rows excluded",
                f"{diag['option_rows_dropped']} purchase rows report an option (House OP, Senate Stock Option), puts "
                "included. They carry the ticker of the underlying stock and are not stock purchases, so they are dropped.",
            ),
        ],
        notes=(
            f"Raw Congress purchase rows: {diag['raw_rows']}; trades after dropping option rows, merging lots and dropping later filings: "
            f"{diag['deduped_purchases']}. "
            f"Primary trial (all-buys, H=20): whole trades={primary.whole.trades}, OOS trades={primary.oos.trades}."
        ),
    )
    summary = {
        "verdict": study.verdict,
        "reason": study.reason,
        "oos_events": primary.oos.trades,
        "oos_sharpe": round(primary.oos.sharpe, 4),
        "dsr": round(study.dsr.probability, 4) if study.dsr else None,
        "n_trials": len(study.trials),
        "post_hoc_full_universe": post_hoc.summary,
    }
    return StudyOutput(document, summary, post_hoc.trials_after(study.trials))


def _premium_study(ctx: RunContext) -> StudyOutput:
    """The frozen descriptive baseline of large bullish premium (verdict: needs-more-data, N = 1)."""
    study_id = "smart-money-large-bullish-premium"
    premium_path = ctx.data_dir / "market_premium.jsonl"  # json-data-ignore: collector output on the research machine, outside the repository; the app never reads it
    premium_rows = load_premium_jsonl(premium_path)
    # The frozen rule ranks every ticker that passes the premium tests, so this study also reads
    # the bars that the collector fetched for premium tickers outside the 600-ticker cap.
    premium_bars_dir = ctx.data_dir / "bars_premium"
    bars: dict[str, Sequence[DailyBar]] = {**load_bars_dir(premium_bars_dir), **ctx.bars}
    premium_bar_paths = sorted(premium_bars_dir.glob("*.csv"))

    events, diag = build_signal3_events(premium_rows, bars)
    sessions = sorted({r.session_date for r in premium_rows if r.session_status == "complete"})
    if not sessions:
        raise ValueError(f"{premium_path} has no complete session")
    start, end = sessions[0], sessions[-1]
    primary = simulate_event_portfolio(
        events,
        bars,
        ctx.spy_bars,
        # The liquidity check repeats the one of the ranking for tickers with bars. It also stops a
        # ticker whose first bar is the entry day: its liquidity was unknown when it was ranked.
        PortfolioConfig(holding_days=PRIMARY_HOLDING_DAYS, cost_bps=DEFAULT_COST_BPS),
        start_day=start,
        end_day=end,
        oos_start=None,
    )
    if primary.whole.days >= MIN_OOS_SESSIONS:
        # The frozen baseline is only valid while the history is shorter than the holdout. With a
        # full holdout the study needs a pre-registered in-sample/out-of-sample split and the gate.
        raise ValueError(
            f"{study_id}: {primary.whole.days} sessions reach the {MIN_OOS_SESSIONS}-session holdout; "
            "pre-register the out-of-sample split and evaluate the verdict gate (plan-pr7.md section 1.2)"
        )
    verdict = "needs-more-data"
    months = (end - start).days / 30.4375
    unlock = _add_years(start, 2).isoformat()
    reason = (
        f"Insufficient history: {primary.whole.days} trading sessions ({diag['complete_sessions']} complete QuantData "
        f"sessions in the source, {start.isoformat()} to {end.isoformat()}, ~{months:.1f} months < 24-month holdout "
        f"of {MIN_OOS_SESSIONS} sessions). "
        f"Rule {SIGNAL3_VARIANT} (H=20) is frozen at N = 1 with zero parameter sweep; full evaluation unlocks on {unlock}. "
        f"Descriptive baseline over observed window: {primary.whole.trades} entries, excess Sharpe {primary.whole.sharpe:.3f}."
    )
    trial = _to_trial(study_id, SIGNAL3_VARIANT, PRIMARY_HOLDING_DAYS, DEFAULT_COST_BPS, True, primary)

    spy_cagr, spy_sharpe, spy_dd = _spy_benchmark_stats(ctx.spy_bars, start, end)
    document = build_study_document(
        study_id=study_id,
        title="Large Bullish Options Premium Flow (>= $100k Trades, Frozen Baseline)",
        source_label="QuantData gainers-losers (flow_market_premium, >= $100k/trade; bullish includes sold puts)",
        source_url="https://quantdata.us/llms-full.txt",
        equity_label="Frozen top10-500k (H=20) descriptive baseline excess over SPY, 10 bps/side (insufficient history)",
        verdict=verdict,
        verdict_reason=reason,
        ran=ctx.ran,
        commit=ctx.commit,
        data_hash=_hash_files([premium_path, *ctx.bar_paths, *premium_bar_paths]),
        primary_result=primary,
        form_description=(
            "Frozen descriptive baseline only (verdict: needs-more-data). QuantData bullish class includes sold puts, "
            "so the signal is named large bullish premium (not call flow). Zero parameter sweep performed so future "
            f"out-of-sample evaluation after {unlock} remains uncontaminated. Research only."
        ),
        form_label="Underlying equity excess over SPY (frozen baseline, < 2y history)",
        runs=[
            make_run_entry(
                symbol="Top 10 >= $500k (Frozen, H=20)",
                market="Excess vs SPY, 10 bps/side (<2y)",
                result=primary,
                include_oos=False,
                spy_whole_cagr=spy_cagr,
                spy_whole_sharpe=spy_sharpe,
            ),
        ],
        comparison=[
            _comparison_row("Frozen top10-500k baseline (excess, <2y)", "strategy", primary),
            _spy_comparison_row("SPY buy-and-hold (same window)", spy_cagr, spy_sharpe, spy_dd),
        ],
        sensitivity=[],
        robustness=[
            {
                "check": f"24-Month OOS History Requirement (>= {MIN_OOS_SESSIONS} sessions)",
                "pass": False,
                "result": (
                    f"{primary.whole.days} trading sessions ({diag['complete_sessions']} complete sessions in the source, "
                    f"{start}..{end}); unlocks {unlock}."
                ),
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
                    f"qualifying_ticker_sessions={diag['qualifying_ticker_sessions']}, "
                    f"top10_events={diag['selected_top10_events']}, entries={primary.whole.trades}"
                ),
            },
            {
                "check": "Slot Overlap, Capacity & Missing-Bar Skips",
                "pass": None,
                "result": (
                    f"events: overlap={primary.skipped_overlap}, capacity={primary.skipped_capacity}, "
                    f"missing_bars={primary.skipped_missing_bars}, no_bar_before_entry={primary.skipped_illiquid}, "
                    f"outside_window={primary.skipped_outside_window}; "
                    f"ticker-sessions before ranking: without_bars={diag['premium_rows_without_bars']}, "
                    f"illiquid={diag['premium_rows_illiquid']}"
                ),
            },
        ],
        rules=[
            ("Source", "QuantVPS flow_market_premium complete sessions (QuantData gainers-losers, filter premium >= $100,000, isCancelled = false).", "design.md PR 2"),
            ("Bullish Class", "QuantData bullish class includes long calls and sold puts; signal is named large bullish premium, never call flow.", "design.md PR 7"),
            ("Frozen Rule", "On each complete session: bullish_premium >= $500k, bullish share >= 70%, trade_count >= 3; a ticker with bars must also have close >= $5 and 20d median $vol >= $10M; top 10 by net premium. A ticker without bars keeps its rank and is not traded.", "plan-pr7.md"),
            ("Execution", f"Next trading day open; equal-weight 10 slots; H=20; 10 bps/side; excess return over SPY. Unlocks for full verdict on {unlock}.", "plan-pr7.md"),
        ],
        gaps=[
            ("History below 2-year holdout", f"QuantData exposes ~1 year of history ({start}..{end}: {primary.whole.days} trading sessions; the source marks {diag['complete_sessions']} sessions complete, exchange holidays with index rows included). Verdict stays needs-more-data until {unlock}."),
            ("Trade-side taxonomy", "QuantData bullish premium aggregates calls bought at ask and puts sold at bid; option-side decomposition is not present in gainers-losers."),
            ("Intraday vs EOD capture", "Complete sessions settle after midnight; entries occur at next session open (zero look-ahead)."),
            (
                "Top-10 tickers without bars",
                f"{diag['top10_events_without_bars']} of {diag['selected_top10_events']} top-10 events are in tickers "
                "without a daily bar on or before the session (index options and tickers Yahoo Finance has no history "
                "for). They keep their rank and are not traded.",
            ),
            (
                "Slot capacity",
                f"The 10 slots stay full for 20 sessions, so {primary.skipped_capacity} of "
                f"{diag['selected_top10_events']} top-10 events were skipped for capacity and "
                f"{primary.skipped_overlap} because the ticker was already held.",
            ),
        ],
        notes=(
            f"Trading sessions: {primary.whole.days}; complete sessions in the source: {diag['complete_sessions']} ({start}..{end}). "
            f"Rule frozen at N = 1 (top10-500k, H=20); full evaluation unlocks {unlock}."
        ),
    )
    summary = {
        "verdict": verdict,
        "reason": reason,
        "complete_sessions": diag["complete_sessions"],
        "trading_sessions": primary.whole.days,
        "baseline_entries": primary.whole.trades,
        "baseline_sharpe": round(primary.whole.sharpe, 4),
        "n_trials": 1,
    }
    return StudyOutput(document, summary, (trial,))


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
    event_bars_dir = data_dir / "bars_events"
    event_bars = load_bars_dir(event_bars_dir)
    ctx = RunContext(
        full_bars={**event_bars, **bars} if event_bars else None,
        full_bar_paths=tuple(sorted(event_bars_dir.glob("*.csv"))) if event_bars else (),
        data_dir=data_dir,
        ran=ran,
        commit=commit,
        bars=bars,
        spy_bars=spy_bars,
        bar_paths=tuple(sorted((data_dir / "bars").glob("*.csv"))),
        meta=meta,
        universe_note=_universe_note(meta, bars),
    )
    outputs = [_insider_study(ctx), _congress_study(ctx), _premium_study(ctx)]

    documents = [output.document for output in outputs]
    all_trials = [trial for output in outputs for trial in output.trials]
    summaries = {str(output.document["id"]): output.summary for output in outputs}

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
