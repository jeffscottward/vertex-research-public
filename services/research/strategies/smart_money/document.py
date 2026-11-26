"""StrategyBacktestStudySchema document emitter for smart-money PR 7 studies.

Emits strict JSON documents matching StrategyBacktestStudySchema
(packages/api/src/contracts/research-studies.ts) plus the JSON-lines bundle and the trial log.
Pure stdlib; research only.
"""
from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from datetime import date
from pathlib import Path
from typing import Any

from .engine import PortfolioResult, TrialRecord

STUDY_IDS: tuple[str, str, str] = (
    "insider-purchase-confirmation",
    "smart-money-congress-buys",
    "smart-money-large-bullish-premium",
)
ENGINE_VERSION = "vertex-smart-money-event-study 1.0.0"
NOTES_MAX_CHARS = 4_000  # STRATEGY_BACKTEST_NOTES_MAX in the research-studies contract
MAX_DOC_BYTES = 262_144
MAX_BATCH_BYTES = 1_048_576


def _cut(text: str, limit: int) -> str:
    cleaned = " ".join(text.split()).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _finite(val: float, default: float = 0.0) -> float:
    return round(val, 6) if math.isfinite(val) else default


def _clamp_cagr(val: float) -> float:
    return round(max(-1.0, val if math.isfinite(val) else 0.0), 6)


def _clamp_dd(val: float) -> float:
    return round(max(-1.0, min(0.0, val if math.isfinite(val) else 0.0)), 6)


def _clamp_frac(val: float) -> float:
    return round(max(0.0, min(1.0, val if math.isfinite(val) else 0.0)), 6)


def make_run_entry(
    *,
    symbol: str,
    market: str,
    result: PortfolioResult,
    include_oos: bool,
    spy_whole_cagr: float | None = None,
    spy_whole_sharpe: float | None = None,
) -> dict[str, Any]:
    first = result.first_day.isoformat() if result.first_day else "2020-01-01"
    last = result.last_day.isoformat() if result.last_day else first
    pf = result.whole.profit_factor
    return {
        "buyHoldCagr": _clamp_cagr(spy_whole_cagr) if spy_whole_cagr is not None else None,
        "buyHoldSharpe": _finite(spy_whole_sharpe) if spy_whole_sharpe is not None else None,
        "cagr": _clamp_cagr(result.whole.cagr),
        "exposure": _clamp_frac(result.whole.exposure),
        "from": first,
        "market": _cut(market, 60),
        "maxDrawdown": _clamp_dd(result.whole.max_drawdown),
        "oosCagr": _clamp_cagr(result.oos.cagr) if include_oos and result.oos.days > 0 else None,
        "oosSharpe": _finite(result.oos.sharpe) if include_oos and result.oos.days > 0 else None,
        "profitFactor": round(max(0.0, pf), 6) if pf is not None and math.isfinite(pf) else None,
        "sharpe": _finite(result.whole.sharpe),
        "symbol": _cut(symbol, 40),
        "to": last,
        "trades": int(result.whole.trades),
        "winRate": _clamp_frac(result.whole.win_rate),
    }


def _ensure_min_two_months(points: Sequence[Mapping[str, Any]], fallback_start: str) -> list[dict[str, Any]]:
    out = [
        {
            "drawdown": _clamp_dd(float(p["drawdown"])),
            "month": str(p["month"]),
            "value": round(max(-1.0, float(p["value"])), 6),
        }
        for p in points
    ]
    if len(out) >= 2:
        return out
    if len(out) == 1:
        y, m = map(int, out[0]["month"].split("-"))
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        out.append({"drawdown": out[0]["drawdown"], "month": f"{ny:04d}-{nm:02d}", "value": out[0]["value"]})
        return out
    y, m = map(int, fallback_start[:7].split("-"))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return [
        {"drawdown": 0.0, "month": f"{y:04d}-{m:02d}", "value": 0.0},
        {"drawdown": 0.0, "month": f"{ny:04d}-{nm:02d}", "value": 0.0},
    ]


def build_study_document(
    *,
    study_id: str,
    title: str,
    source_label: str,
    source_url: str,
    equity_label: str,
    verdict: str,
    verdict_reason: str,
    ran: date,
    commit: str,
    data_hash: str,
    primary_result: PortfolioResult,
    form_description: str,
    form_label: str,
    runs: Sequence[dict[str, Any]],
    comparison: Sequence[dict[str, Any]],
    sensitivity: Sequence[dict[str, Any]],
    robustness: Sequence[dict[str, Any]],
    rules: Sequence[tuple[str, str, str]],
    gaps: Sequence[tuple[str, str]],
    notes: str,
) -> dict[str, Any]:
    """Assemble one StrategyBacktestStudySchema-compliant JSON dict."""
    if study_id not in STUDY_IDS:
        raise ValueError(f"Unknown smart-money study_id: {study_id}")
    if verdict not in ("edge", "no-edge", "needs-more-data"):
        raise ValueError(f"Invalid verdict: {verdict}")
    fallback_start = primary_result.first_day.isoformat() if primary_result.first_day else ran.isoformat()
    doc: dict[str, Any] = {
        "comparison": [
            {
                "cagr": _clamp_cagr(float(c["cagr"])),
                "kind": str(c["kind"]),
                "maxDrawdown": _clamp_dd(float(c["maxDrawdown"])),
                "name": _cut(str(c["name"]), 80),
                "sharpe": _finite(float(c["sharpe"])),
            }
            for c in comparison
        ],
        "equity": _ensure_min_two_months(primary_result.monthly_equity, fallback_start),
        "equityLabel": _cut(equity_label, 200),
        "forms": [
            {
                "description": _cut(form_description, 600),
                "key": "underlying",
                "label": _cut(form_label, 120),
                "runs": list(runs),
            }
        ],
        "gaps": [{"choice": _cut(choice, 400), "gap": _cut(gap, 300)} for gap, choice in gaps],
        "id": study_id,
        "kind": "strategy-backtest",
        "notes": notes[:NOTES_MAX_CHARS].strip(),
        "provenance": {
            "commit": commit[:40],
            "dataHash": _cut(data_hash, 80),
            "engine": _cut(ENGINE_VERSION, 80),
            "runId": _cut(f"{study_id}-{ran.isoformat()}", 80),
        },
        "ran": ran.isoformat(),
        "robustness": [
            {
                "check": _cut(str(r["check"]), 80),
                "pass": r["pass"],
                "result": _cut(str(r["result"]), 300),
            }
            for r in robustness
        ],
        "rules": [
            {"item": _cut(item, 60), "rule": _cut(rule, 400), "source": _cut(src, 200)}
            for item, rule, src in rules
        ],
        "sensitivity": [
            {
                "cagr": _clamp_cagr(float(s["cagr"])),
                "maxDrawdown": _clamp_dd(float(s["maxDrawdown"])),
                "param": _cut(str(s["param"]), 60),
                "sharpe": _finite(float(s["sharpe"])),
                "trades": max(0, int(s["trades"])),
                "value": _cut(str(s["value"]), 40),
            }
            for s in sensitivity
        ],
        "source": {
            "label": _cut(source_label, 200),
            "url": source_url,
        },
        "spec": f"docs/specs/strategies/{study_id}.md",
        "title": _cut(title, 200),
        "verdict": verdict,
        "verdictReason": _cut(verdict_reason, 1000),
    }
    raw = json.dumps(doc, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(raw) > MAX_DOC_BYTES:
        raise ValueError(f"Study document {study_id} exceeds {MAX_DOC_BYTES} bytes ({len(raw)})")
    return doc


def write_study_bundle(
    out_dir: Path,
    documents: Sequence[Mapping[str, Any]],
    trials: Sequence[TrialRecord],
) -> tuple[Path, Path]:
    """Write one document per study, the JSON-lines bundle for the importer, and the trial log.

    Every size limit is checked before the first write, so a rejected bundle leaves no file.
    """
    jsonl_lines: list[str] = []
    for doc in documents:
        compact = json.dumps(doc, separators=(",", ":"), sort_keys=True)
        if len(compact.encode("utf-8")) > MAX_DOC_BYTES:
            raise ValueError(f"{doc['id']} exceeds {MAX_DOC_BYTES} bytes")
        jsonl_lines.append(compact)
    jsonl_payload = "\n".join(jsonl_lines) + "\n"
    if len(jsonl_payload.encode("utf-8")) > MAX_BATCH_BYTES:
        raise ValueError(f"study bundle exceeds {MAX_BATCH_BYTES} bytes")

    out_dir.mkdir(parents=True, exist_ok=True)
    for doc in documents:
        pretty = json.dumps(doc, indent=2, sort_keys=True) + "\n"
        (out_dir / f"{doc['id']}.json").write_text(pretty, encoding="utf-8")  # json-data-ignore: report artifact under ~/Documents, outside the repo; studies reach Postgres through the importer and the app never reads the file
    jsonl_path = out_dir / "studies.jsonl"  # json-data-ignore: report artifact under ~/Documents, outside the repo; studies reach Postgres through the importer and the app never reads the file
    jsonl_path.write_text(jsonl_payload, encoding="utf-8")

    trials_path = out_dir / "trials.json"  # json-data-ignore: report artifact under ~/Documents, outside the repo; studies reach Postgres through the importer and the app never reads the file
    trials_data = [
        {
            "study_id": t.study_id,
            "variant": t.variant,
            "holding_days": t.holding_days,
            "cost_bps": t.cost_bps,
            "is_primary": t.is_primary,
            "oos_events": t.oos_events,
            "oos_days": t.oos_days,
            "oos_per_obs_sharpe": round(t.oos_per_obs_sharpe, 6),
            "oos_annual_sharpe": round(t.oos_annual_sharpe, 6),
            "oos_cagr": round(t.oos_cagr, 6),
            "whole_cagr": round(t.whole_cagr, 6),
            "whole_sharpe": round(t.whole_sharpe, 6),
            "whole_max_drawdown": round(t.whole_max_drawdown, 6),
            "whole_trades": t.whole_trades,
            "whole_win_rate": round(t.whole_win_rate, 6),
        }
        for t in trials
    ]
    trials_path.write_text(json.dumps(trials_data, indent=2) + "\n", encoding="utf-8")
    return jsonl_path, trials_path
