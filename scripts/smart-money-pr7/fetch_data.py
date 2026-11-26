"""Offline rig data collector for smart-money PR 7 backtests.

Runs on the rig (not imported by services/research or CI). Resumable and rate-limited:
1. Streams SEC quarterly Form 3/4/5 ZIPs (2016q1..2026q1) -> form4_purchases.jsonl.
2. Exports 2026 Congress trades/filings + flow_market_premium complete sessions from
   QuantVPS Postgres (read-only over SSH) -> market_premium.jsonl + congress_2026.json.
3. Parses 2022..2025 House & Senate electronic PTRs via the existing services/openbb
   venv (vertex_openbb.jobs.congress, monthly chunks, generous local deadline) ->
   congress_trades.jsonl + metadata.json.
4. Caches daily OHLCV bars (2015-06-01..2026-11-24) for SPY + 146 STOCKS + event
   tickers (capped at 600) from Yahoo Finance chart API -> bars/<SYM>.csv.
5. Caches daily bars (from 2025-06-01) for every other ticker that passes the frozen
   premium tests on a complete session -> bars_premium/<SYM>.csv (study 3 only).
6. Caches daily bars for every other ticker with a cluster event or a Congress purchase
   -> bars_events/<SYM>.csv (post-hoc full-universe check of studies 1 and 2 only).

Research only. Zero paid data sources. Never prints credentials or emails.
"""
from __future__ import annotations

import argparse
import calendar
import csv
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "services" / "research"))
sys.path.insert(0, str(REPO_ROOT / "research" / "backtests" / "freestockalerts"))

from strategies.smart_money.__main__ import load_form4_jsonl  # noqa: E402
from strategies.smart_money.engine import raw_closes_from_splits  # noqa: E402
from strategies.smart_money.signals import (  # noqa: E402
    CLUSTER_MIN_OWNERS,
    CLUSTER_WINDOW_DAYS,
    PREMIUM_BULLISH_RATIO_MIN,
    PREMIUM_FLOOR_USD,
    PREMIUM_MIN_TRADES,
    SYMBOL_RE,
    _detect_insider_clusters,
    Form4Purchase,
    parse_sec_form4_zip,
)

SEC_ZIP_URL = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{year}q{q}_form345.zip"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={p1}&period2={p2}&interval=1d&events=div%2Csplits"
OPENBB_VENV_PYTHON = Path.home() / ".local" / "share" / "vertex-openbb" / "venv" / "bin" / "python"
OPENBB_ENV_FILE = Path.home() / ".config" / "vertex" / "openbb.env"
MAX_UNIVERSE_TICKERS = 600
BAR_COLUMNS = ("date", "open", "high", "low", "close", "adj_close", "volume", "raw_close")
YAHOO_ATTEMPTS = 4
YAHOO_RETRY_SECONDS = 5.0


def _load_contact_email() -> str:
    email = os.environ.get("VERTEX_RESEARCH_CONTACT_EMAIL", "").strip()
    if email:
        return email
    if OPENBB_ENV_FILE.exists():
        for line in OPENBB_ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("VERTEX_RESEARCH_CONTACT_EMAIL="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    raise RuntimeError("VERTEX_RESEARCH_CONTACT_EMAIL not set in env or ~/.config/vertex/openbb.env")


def _sec_user_agent(email: str) -> str:
    return f"vertex-research smart-money-pr7 (personal research; {email})"


def _sec_quarters() -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for yr in range(2016, 2026):
        for q in (1, 2, 3, 4):
            out.append((yr, q))
    out.append((2026, 1))
    return out


def fetch_sec_form4(out_dir: Path, email: str) -> Path:
    zips_dir = out_dir / "sec_zips"
    zips_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = out_dir / "form4_purchases.jsonl"
    ua = _sec_user_agent(email)

    total_rows = 0
    with jsonl_path.open("w", encoding="utf-8") as out_fh:
        for year, q in _sec_quarters():
            zpath = zips_dir / f"{year}q{q}_form345.zip"
            if not zpath.exists() or zpath.stat().st_size < 1000:
                url = SEC_ZIP_URL.format(year=year, q=q)
                req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Encoding": "identity"})
                for attempt in range(3):
                    try:
                        with urllib.request.urlopen(req, timeout=120) as resp:
                            data = resp.read()
                        zpath.write_bytes(data)
                        time.sleep(0.25)  # <= 4 req/s, well under SEC 8/s cap
                        break
                    except (urllib.error.URLError, TimeoutError) as exc:
                        if attempt == 2:
                            raise RuntimeError(f"Failed downloading {url}: {exc}") from exc
                        time.sleep(2.0 * (attempt + 1))

            rows: list[Form4Purchase] = parse_sec_form4_zip(zpath)
            for r in rows:
                out_fh.write(
                    json.dumps(
                        {
                            "accession_number": r.accession_number,
                            "filing_date": r.filing_date.isoformat(),
                            "transaction_date": r.transaction_date.isoformat() if r.transaction_date else None,
                            "issuer_cik": r.issuer_cik,
                            "ticker": r.ticker,
                            "owner_group_key": r.owner_group_key,
                            "role_text": r.role_text,
                            "security": r.security,
                            "shares": r.shares,
                            "price": r.price,
                            "holding_before": r.holding_before,
                            "is_10b5_1": r.is_10b5_1,
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            total_rows += len(rows)
            print(f"[sec] {year}q{q}: {len(rows)} code-P common/ordinary rows (cum {total_rows})", flush=True)
    return jsonl_path


def _ssh_psql_jsonl(sql: str, what: str) -> list[dict[str, Any]]:
    """Rows of one read-only query on QuantVPS Postgres. An SQL error or an empty result stops the run."""
    wrapped = f"SELECT row_to_json(t) FROM ({sql}) t;"
    cmd = [
        "ssh",
        "quantvps",
        # ON_ERROR_STOP: without it psql exits 0 after an SQL error and the export would be empty.
        "sudo docker exec -i vertex-postgres psql -v ON_ERROR_STOP=1 -U postgres -d vertex_research_development -tAq",
    ]
    proc = subprocess.run(cmd, input=wrapped, capture_output=True, text=True, check=True)
    rows: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    if not rows:
        raise RuntimeError(f"QuantVPS export returned no rows: {what}")
    return rows


def export_quantvps_postgres(out_dir: Path) -> tuple[Path, Path, dict[str, Any]]:
    # 1. flow_market_premium joined with complete sessions
    prem_sql = """
        SELECT
            p.session_date::text AS session_date,
            p.ticker AS ticker,
            p.bullish_premium::float8 AS bullish_premium,
            p.bearish_premium::float8 AS bearish_premium,
            p.trade_count::int AS trade_count,
            s.status AS session_status
        FROM flow_market_premium p
        JOIN flow_market_premium_sessions s ON s.session_date = p.session_date
        WHERE s.status = 'complete'
        ORDER BY p.session_date, p.ticker
    """
    prem_rows = _ssh_psql_jsonl(prem_sql, "flow_market_premium complete sessions")
    prem_path = out_dir / "market_premium.jsonl"
    with prem_path.open("w", encoding="utf-8") as fh:
        for r in prem_rows:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")
    print(f"[pg] exported {len(prem_rows)} flow_market_premium rows", flush=True)

    # 2. 2026 Congress parsed purchases + filing ledger counts
    cong_sql = """
        SELECT
            t.chamber AS chamber,
            t.doc_id AS doc_id,
            t.member AS member,
            t.holder AS holder,
            t.ticker AS ticker,
            t.transaction_type AS transaction_type,
            t.transaction_date::text AS transaction_date,
            t.filed_on::text AS filed_on,
            t.amount_low::float8 AS amount_low,
            t.amount_high::float8 AS amount_high,
            f.amends AS amends
        FROM openbb_congress_trades t
        JOIN openbb_congress_filings f ON f.chamber = t.chamber AND f.doc_id = t.doc_id
        WHERE f.status = 'parsed'
          AND t.row_number <= f.row_count
          AND t.transaction_type = 'purchase'
          AND t.ticker IS NOT NULL
          AND t.filed_on >= '2026-01-01'
        ORDER BY t.filed_on, t.chamber, t.doc_id, t.row_number
    """
    cong_2026 = _ssh_psql_jsonl(cong_sql, "2026 Congress purchases")
    cong_2026_path = out_dir / "congress_2026.json"
    cong_2026_path.write_text(json.dumps(cong_2026, indent=1), encoding="utf-8")

    ledger_sql = """
        SELECT chamber, status, COALESCE(reason, '') AS reason, count(*)::int AS cnt
        FROM openbb_congress_filings
        WHERE filed_on >= '2026-01-01'
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
    """
    ledger_2026 = _ssh_psql_jsonl(ledger_sql, "2026 Congress filing ledger")
    print(f"[pg] exported {len(cong_2026)} 2026 Congress purchases; ledger groups={len(ledger_2026)}", flush=True)
    return prem_path, cong_2026_path, {"ledger_2026": ledger_2026}


def _month_windows(start_year: int, end_year: int) -> list[tuple[str, str]]:
    windows: list[tuple[str, str]] = []
    for y in range(start_year, end_year + 1):
        for m in range(1, 13):
            last_day = calendar.monthrange(y, m)[1]
            windows.append((f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last_day:02d}"))
    return windows


def _require_complete_chunk(payload: dict[str, Any], label: str) -> None:
    """Stop when a monthly Congress chunk is not complete.

    The job reports a filing whose download failed, a deadline cut or a refused host only as a
    warning or a ``blocked`` entry, and leaves the filing out of both tables. Such a month would
    lose trades without a trace in the ledger, so it is never cached or used.
    """
    if "blocked" in payload:
        raise RuntimeError(f"{label}: blocked upstream ({payload['blocked']})")
    warnings = [str(w) for w in payload.get("warnings") or []]
    if warnings:
        raise RuntimeError(f"{label}: {len(warnings)} warning(s), first: {warnings[0][:300]}")


def _fetch_chamber_history(
    job: str,
    chamber: str,
    windows: list[tuple[str, str]],
    chunks_dir: Path,
    env: dict[str, str],
) -> tuple[list[dict[str, Any]], Counter[tuple[str, str, str, str]]]:
    purchases: list[dict[str, Any]] = []
    counts: Counter[tuple[str, str, str, str]] = Counter()  # (chamber, filing year, status, reason)
    for since_s, until_s in windows:
        cpath = chunks_dir / f"{job}_{since_s}_{until_s}.json"
        if cpath.exists() and cpath.stat().st_size > 20:
            payload = json.loads(cpath.read_text(encoding="utf-8"))
            _require_complete_chunk(payload, f"{job} {since_s}..{until_s} (cached {cpath.name})")
        else:
            cmd = [
                str(OPENBB_VENV_PYTHON),
                "-m",
                "vertex_openbb",
                job,
                "--since",
                since_s,
                "--until",
                until_s,
            ]
            proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=660)
            if proc.returncode != 0:
                raise RuntimeError(f"{job} {since_s}..{until_s} exited {proc.returncode}: {proc.stderr[-500:]}")
            payload = json.loads(proc.stdout)
            _require_complete_chunk(payload, f"{job} {since_s}..{until_s}")
            cpath.write_text(json.dumps(payload), encoding="utf-8")

        raw_tables = payload.get("tables") or []
        if isinstance(raw_tables, dict):
            tables_by_name = raw_tables
        else:
            tables_by_name = {t["table"]: t.get("rows") or [] for t in raw_tables if isinstance(t, dict) and "table" in t}

        filings = tables_by_name.get("congress_filings", [])
        amends_by_doc: dict[str, bool] = {}
        parsed_docs: dict[str, int] = {}
        for f in filings:
            st = str(f.get("status") or "")
            rs = str(f.get("reason") or "")
            counts[(chamber, since_s[:4], st, rs)] += 1
            doc_id = str(f.get("docId") or "")
            amends_by_doc[doc_id] = bool(f.get("amends", False))
            if st == "parsed":
                parsed_docs[doc_id] = int(f.get("rowCount") or 0)

        trades = tables_by_name.get("congress_trades", [])
        month_buys = 0
        for t in trades:
            if t.get("transactionType") != "purchase" or not t.get("ticker"):
                continue
            doc_id = str(t.get("docId") or "")
            if doc_id not in parsed_docs or int(t.get("rowNumber") or 0) > parsed_docs[doc_id]:
                continue
            purchases.append(
                {
                    "chamber": chamber,
                    "doc_id": doc_id,
                    "member": t.get("member") or "",
                    "holder": t.get("holder"),
                    "ticker": str(t["ticker"]).upper(),
                    "transaction_type": "purchase",
                    "transaction_date": t.get("transactionDate"),
                    "filed_on": t["filedOn"],
                    "amount_low": t.get("amountLow"),
                    "amount_high": t.get("amountHigh"),
                    "amends": amends_by_doc.get(doc_id, False),
                }
            )
            month_buys += 1
        print(f"[{job}] {since_s}..{until_s}: {len(filings)} filings, {month_buys} buys", flush=True)
    return purchases, counts


def fetch_congress_history(out_dir: Path, email: str, ledger_2026: list[dict[str, Any]]) -> tuple[Path, dict[str, Any]]:
    from concurrent.futures import ThreadPoolExecutor

    chunks_dir = out_dir / "congress_chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["VERTEX_RESEARCH_CONTACT_EMAIL"] = email
    env["OPENBB_DEADLINE_S"] = "600"
    env["PYTHONPATH"] = str(REPO_ROOT / "services" / "openbb")

    if not OPENBB_VENV_PYTHON.exists():
        raise RuntimeError(f"OpenBB venv python not found at {OPENBB_VENV_PYTHON}")

    # 2022-2025: House 2020-2021 PDFs use legacy Wingdings/small-caps fonts (layout_unknown in house.v1).
    windows = _month_windows(2022, 2025)
    ledger_counts: Counter[tuple[str, str, str, str]] = Counter()
    for row in ledger_2026:
        ledger_counts[(row["chamber"], "2026", row["status"], row["reason"])] += int(row["cnt"])

    all_purchases: list[dict[str, Any]] = []
    cong_2026_path = out_dir / "congress_2026.json"
    if cong_2026_path.exists():
        all_purchases.extend(json.loads(cong_2026_path.read_text(encoding="utf-8")))

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_house = pool.submit(_fetch_chamber_history, "congress-house", "house", windows, chunks_dir, env)
        f_senate = pool.submit(_fetch_chamber_history, "congress-senate", "senate", windows, chunks_dir, env)
        for fut in (f_house, f_senate):
            p_rows, c_map = fut.result()
            all_purchases.extend(p_rows)
            ledger_counts.update(c_map)

    out_path = out_dir / "congress_trades.jsonl"
    with out_path.open("w", encoding="utf-8") as fh:
        for r in all_purchases:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")

    print(f"[congress] total purchase rows={len(all_purchases)}", flush=True)
    # The runner turns these counts into the study's coverage gaps (scanned paper, unknown layout).
    return out_path, {
        "congress_ledger": {f"{c}:{y}:{s}:{r}": v for (c, y, s, r), v in sorted(ledger_counts.items())},
    }


def _select_universe_tickers(out_dir: Path) -> list[str]:
    """The pre-registered universe of studies 1 and 2 (at most 600 tickers, SPY and the 146 stocks first).

    The list is part of the pre-registered method: do not change the counting rules or the order
    of ties here, or the recorded studies no longer describe this universe.
    """
    import universe as fsa_universe  # type: ignore[import-not-found]

    base_stocks: set[str] = {s.upper() for s in fsa_universe.STOCKS}
    counts: Counter[str] = Counter()

    # 1. Congress purchase tickers
    cong_path = out_dir / "congress_trades.jsonl"
    if cong_path.exists():
        with cong_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    r = json.loads(line)
                    counts[str(r["ticker"]).upper()] += 1

    # 2. Form 4 cluster tickers (>= 3 distinct owners in 10d)
    f4_path = out_dir / "form4_purchases.jsonl"
    if f4_path.exists():
        by_issuer: dict[str, list[tuple[date, str, str]]] = defaultdict(list)
        with f4_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                by_issuer[r["issuer_cik"]].append(
                    (date.fromisoformat(r["filing_date"]), r["owner_group_key"], str(r["ticker"]).upper())
                )
        for rows in by_issuer.values():
            rows.sort()
            for i, (d, _, sym) in enumerate(rows):
                owners = {o for d2, o, _ in rows[: i + 1] if 0 <= (d - d2).days <= CLUSTER_WINDOW_DAYS}
                if len(owners) >= CLUSTER_MIN_OWNERS:
                    counts[sym] += 1

    # 3. Top-10 market_premium tickers per session
    prem_path = out_dir / "market_premium.jsonl"
    if prem_path.exists():
        by_day: dict[str, list[tuple[float, str]]] = defaultdict(list)
        with prem_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                r = json.loads(line)
                bp = float(r["bullish_premium"])
                tot = bp + float(r["bearish_premium"])
                if bp >= 500_000 and tot > 0 and bp / tot >= 0.70 and int(r["trade_count"]) >= 3:
                    by_day[r["session_date"]].append((bp - float(r["bearish_premium"]), str(r["ticker"]).upper()))
        for items in by_day.values():
            items.sort(reverse=True)
            for _, sym in items[:10]:
                counts[sym] += 1

    selected: list[str] = ["SPY"] + sorted(base_stocks)
    seen = set(selected)
    for sym, _ in counts.most_common():
        if sym in seen:
            continue
        selected.append(sym)
        seen.add(sym)
        if len(selected) >= MAX_UNIVERSE_TICKERS:
            break
    return selected


class YahooFetchError(RuntimeError):
    """Yahoo did not answer after every retry (rate limit, server or network error)."""


BarRow = tuple[str, float, float, float, float, float, float, float]


def _yahoo_chart(symbol: str, p1: int, p2: int) -> dict[str, Any] | None:
    """The chart result of one symbol, or None when Yahoo does not know the symbol."""
    yahoo_sym = symbol.replace(".", "-")
    url = YAHOO_CHART_URL.format(symbol=urllib.parse.quote(yahoo_sym), p1=p1, p2=p2)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            "Accept": "application/json",
        },
    )
    last_error = "no attempt"
    for attempt in range(YAHOO_ATTEMPTS):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code in (400, 404, 422):
                return None
            last_error = f"HTTP {exc.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = type(exc).__name__
        else:
            result = (data.get("chart") or {}).get("result")
            return result[0] if result else None
        time.sleep(YAHOO_RETRY_SECONDS * (attempt + 1))
    raise YahooFetchError(f"{symbol}: {last_error} after {YAHOO_ATTEMPTS} attempts")


def _chart_rows(chart: dict[str, Any]) -> list[BarRow]:
    timestamps = chart.get("timestamp") or []
    indicators = chart.get("indicators") or {}
    quote = (indicators.get("quote") or [{}])[0]
    adj = (indicators.get("adjclose") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    vols = quote.get("volume") or []
    adjcloses = adj.get("adjclose") or closes

    kept: list[tuple[date, float, float, float, float, float, float]] = []
    seen_days: set[date] = set()
    for i, ts in enumerate(timestamps):
        if i >= len(closes):
            break
        o, h, lo, c = (
            opens[i] if i < len(opens) else None,
            highs[i] if i < len(highs) else None,
            lows[i] if i < len(lows) else None,
            closes[i],
        )
        ac = adjcloses[i] if i < len(adjcloses) else c
        v = vols[i] if i < len(vols) else 0
        if None in (o, h, lo, c, ac) or o <= 0 or c <= 0 or ac <= 0:
            continue
        day = datetime.fromtimestamp(int(ts), tz=timezone.utc).date()
        if day in seen_days:
            continue
        seen_days.add(day)
        kept.append((day, float(o), float(h), float(lo), float(c), float(ac), float(v or 0.0)))

    splits = [
        (
            datetime.fromtimestamp(int(ev["date"]), tz=timezone.utc).date(),
            float(ev["numerator"]) / float(ev["denominator"]),
        )
        for ev in ((chart.get("events") or {}).get("splits") or {}).values()
        if float(ev.get("denominator") or 0) > 0 and float(ev.get("numerator") or 0) > 0
    ]
    raw = raw_closes_from_splits([r[0] for r in kept], [r[4] for r in kept], splits)
    return [(r[0].isoformat(), *r[1:], rc) for r, rc in zip(kept, raw, strict=True)]


def _bars_csv_is_current(csv_path: Path) -> bool:
    """True when the cached file has the current columns (older files lack raw_close)."""
    if not csv_path.exists():
        return False
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        header = fh.readline().strip().split(",")
        return header == list(BAR_COLUMNS) and bool(fh.readline().strip())


def _fetch_bars(tickers: list[str], bars_dir: Path, first_day: datetime, label: str) -> tuple[int, list[str]]:
    """Cache one CSV per ticker; returns (tickers with bars, tickers Yahoo has no history for)."""
    bars_dir.mkdir(parents=True, exist_ok=True)
    p1 = int(first_day.timestamp())
    p2 = int(datetime(2026, 11, 25, tzinfo=timezone.utc).timestamp())

    cached = 0
    not_found: list[str] = []
    failed: list[str] = []
    for idx, sym in enumerate(tickers, 1):
        csv_path = bars_dir / f"{sym}.csv"
        if _bars_csv_is_current(csv_path):
            cached += 1
        else:
            try:
                chart = _yahoo_chart(sym, p1, p2)
            except YahooFetchError as exc:
                print(f"[{label}] {exc}", flush=True)
                failed.append(sym)
                chart = None
            rows = _chart_rows(chart) if chart else []
            if rows:
                with csv_path.open("w", encoding="utf-8", newline="") as fh:
                    w = csv.writer(fh)
                    w.writerow(BAR_COLUMNS)
                    w.writerows(rows)
                cached += 1
            elif sym not in failed:
                csv_path.unlink(missing_ok=True)
                not_found.append(sym)
            time.sleep(0.12)
        if idx % 50 == 0 or idx == len(tickers):
            print(
                f"[{label}] {idx}/{len(tickers)} done (ok={cached}, not_found={len(not_found)}, failed={len(failed)})",
                flush=True,
            )
    if failed:
        # A ticker that Yahoo knows must not drop out of the universe because of a rate limit.
        raise YahooFetchError(
            f"{len(failed)} tickers failed after retries: {' '.join(failed)}. Run the step again; "
            "tickers that are already cached are kept."
        )
    return cached, sorted(not_found)


def fetch_daily_bars(out_dir: Path) -> dict[str, Any]:
    """Bars of the pre-registered universe (studies 1 and 2, and the benchmark)."""
    tickers = _select_universe_tickers(out_dir)
    cached, not_found = _fetch_bars(tickers, out_dir / "bars", datetime(2015, 6, 1, tzinfo=timezone.utc), "bars")
    return {"universe_requested": len(tickers), "bars_cached": cached, "bars_not_found": not_found}


def _premium_candidate_tickers(out_dir: Path) -> list[str]:
    """Every ticker that passes the frozen premium tests on at least one complete session."""
    tickers: set[str] = set()
    with (out_dir / "market_premium.jsonl").open("r", encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            r = json.loads(line)
            bullish = float(r["bullish_premium"])
            total = bullish + float(r["bearish_premium"])
            if (
                str(r.get("session_status") or "complete") == "complete"
                and bullish >= PREMIUM_FLOOR_USD
                and total > 0
                and bullish / total >= PREMIUM_BULLISH_RATIO_MIN
                and int(r["trade_count"]) >= PREMIUM_MIN_TRADES
                and SYMBOL_RE.match(str(r["ticker"]).strip().upper())
            ):
                tickers.add(str(r["ticker"]).strip().upper())
    return sorted(tickers)


def fetch_premium_bars(out_dir: Path) -> dict[str, Any]:
    """Bars for the large-bullish-premium study only, in their own folder.

    The frozen rule ranks every ticker that passes the premium tests, so its bars must not depend
    on the 600-ticker cap of the other two studies. Tickers of that cap are already in ``bars/``.
    """
    in_universe = set(_select_universe_tickers(out_dir))
    candidates = _premium_candidate_tickers(out_dir)
    extra = [t for t in candidates if t not in in_universe]
    cached, not_found = _fetch_bars(
        extra, out_dir / "bars_premium", datetime(2025, 6, 1, tzinfo=timezone.utc), "premium-bars"
    )
    return {
        "premium_tickers_candidates": len(candidates),
        "premium_bars_extra_requested": len(extra),
        "premium_bars_extra_cached": cached,
        "premium_bars_extra_not_found": not_found,
    }


def _event_tickers(out_dir: Path) -> list[str]:
    """Every ticker with a cluster event (any issuer) or a Congress purchase."""
    tickers: set[str] = set()
    clusters = _detect_insider_clusters(load_form4_jsonl(out_dir / "form4_purchases.jsonl"))
    tickers.update(event.symbol for event in clusters)
    with (out_dir / "congress_trades.jsonl").open("r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                symbol = str(json.loads(line)["ticker"]).strip().upper()
                if SYMBOL_RE.match(symbol):
                    tickers.add(symbol)
    return sorted(tickers)


def fetch_event_bars(out_dir: Path) -> dict[str, Any]:
    """Bars for the post-hoc full-universe check of studies 1 and 2, in their own folder.

    The pre-registered universe (``bars/``) is capped at 600 tickers chosen by whole-sample event
    counts. This step fetches every other ticker that has a cluster event or a Congress purchase,
    so the runner can report the primary trials without the cap beside the pre-registered result.
    """
    in_universe = set(_select_universe_tickers(out_dir))
    candidates = _event_tickers(out_dir)
    extra = [t for t in candidates if t not in in_universe]
    cached, not_found = _fetch_bars(
        extra, out_dir / "bars_events", datetime(2015, 6, 1, tzinfo=timezone.utc), "event-bars"
    )
    return {
        "event_tickers_candidates": len(candidates),
        "event_bars_extra_requested": len(extra),
        "event_bars_extra_cached": cached,
        "event_bars_extra_not_found": not_found,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch and normalize smart-money PR 7 backtest data on the rig.")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path.home() / "Documents" / "reports" / "web" / "vertex-smart-money-pr7" / "data",
    )
    parser.add_argument(
        "--only",
        choices=["all", "sec", "postgres", "congress", "bars", "premium-bars", "event-bars"],
        default="all",
    )
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    email = _load_contact_email()

    meta_path = args.out_dir / "metadata.json"
    meta: dict[str, Any] = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}

    if args.only in ("all", "sec"):
        fetch_sec_form4(args.out_dir, email)
    if args.only in ("all", "postgres"):
        _, _, pg_meta = export_quantvps_postgres(args.out_dir)
        meta.update(pg_meta)
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    if args.only in ("all", "congress"):
        _, cong_meta = fetch_congress_history(args.out_dir, email, meta.get("ledger_2026", []))
        meta.pop("congress_scanned_summary", None)  # written by an older version of this script
        meta.update(cong_meta)
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    if args.only in ("all", "bars"):
        meta.update(fetch_daily_bars(args.out_dir))
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    if args.only in ("all", "premium-bars"):
        meta.update(fetch_premium_bars(args.out_dir))
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    if args.only in ("all", "event-bars"):
        meta.update(fetch_event_bars(args.out_dir))
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
