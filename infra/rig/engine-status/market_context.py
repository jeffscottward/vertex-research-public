#!/usr/bin/env python3
"""Market context collector (card vertex-markets-gex-macro-news, 2026-11-03).

Runs on the rig as a step of `vertex-rig-push` (tick-runner). It reads the market-watch-bot state files
(gex.json, macro.json, news.json), keeps only public market data and copies one JSON document to QuantVPS
with the engine-status key (`collect.push`). The QuantVPS forced command stores it as markets.json.

Public data only. Not copied: positions, stops, account values, the held/watchlist/re-entry symbol
universe, per-symbol news aggregates, theme symbol lists, scorer costs and request counts.
  - gex: index rows only (SPY, QQQ), from QuantData OI+IV (an estimate).
  - macro: FRED/EIA/BLS series, regime labels and the next BLS release dates.
  - news: themes of kind "macro" and headlines tagged macro (title, publisher, link, time, sentiment).

Output schema `vertex-market-context-v1` (times in unix seconds; `date` fields stay YYYY-MM-DD):
  {"schema", "generatedAt", "host", "gex": {...}|null, "macro": {...}|null, "news": {...}|null,
   "missing": ["gex"|"macro"|"news", ...]}

Exit status: 0 when all three sections were read and the push worked. When a section is missing the
document is still pushed (with that section null), then the script exits 1 so tick-runner counts a failure.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import collect

SCHEMA = "vertex-market-context-v1"
STATE_DIR = os.environ.get(
    "MW_STATE_DIR", os.path.expanduser("~/Github/trading/market-watch-bot/state")
)
INDEX_SYMBOLS = ("SPY", "QQQ")
MAX_SERIES = 40
MAX_REGIMES = 12
MAX_EVENTS = 8
MAX_THEMES = 12
MAX_HEADLINES = 25
MAX_NOTES = 6
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
SLUG = re.compile(r"[A-Za-z0-9_.-]{1,40}")
TIME_OF_DAY = re.compile(r"\d{2}:\d{2}( ET)?")
HOST = re.compile(r"[A-Za-z0-9.-]{1,253}")
MATERIALITY_RANK = {"low": 0, "medium": 1, "high": 2}


def text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    # Cap in UTF-16 code units, the unit of the API's zod max() checks.
    cleaned = cleaned.encode("utf-16-le")[: limit * 2].decode("utf-16-le", "ignore").strip()
    return cleaned or None


def number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def epoch(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    seconds = int(parsed.timestamp())
    return seconds if seconds > 0 else None


def day(value: Any) -> str | None:
    if not isinstance(value, str) or not DATE.fullmatch(value):
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        return None
    return value


def link(value: Any) -> str | None:
    if not isinstance(value, str) or len(value.encode("utf-16-le")) > 4000 or any(c.isspace() for c in value):
        return None
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises ValueError for a port outside 0-65535 or not a number
    except ValueError:
        return None
    if parts.scheme not in ("https", "http") or not parts.hostname:
        return None
    return value if HOST.fullmatch(parts.hostname) else None


def gex_row(symbol: str, row: Any) -> dict | None:
    if not isinstance(row, dict):
        return None
    zero = row.get("zeroDte")
    concentration = row.get("concentration")
    notes = row.get("regimeText") if isinstance(row.get("regimeText"), list) else []
    return {
        "symbol": symbol,
        "status": text(row.get("status"), 20) or "unknown",
        "spot": number(row.get("spot")),
        "netGex": number(row.get("netGex")),
        "regime": text(row.get("regime"), 20),
        "flip": number(row.get("flip")),
        "spotVsFlip": text(row.get("spotVsFlip"), 10),
        "callWall": number(row.get("callWall")),
        "putWall": number(row.get("putWall")),
        "netVex": number(row.get("netVex")),
        "netChex": number(row.get("netChex")),
        "netDex": number(row.get("netDex")),
        "fadeNote": text(concentration.get("text"), 200)
        if isinstance(concentration, dict)
        else None,
        "zeroDte": {
            "expiry": day(zero.get("expiry")),
            "netGex": number(zero.get("netGex")),
            "flip": number(zero.get("flip")),
            "callWall": number(zero.get("callWall")),
            "putWall": number(zero.get("putWall")),
        }
        if isinstance(zero, dict) and zero.get("status") == "ok"
        else None,
        "notes": list(dict.fromkeys(n for n in (text(x, 300) for x in notes) if n))[:MAX_NOTES],
    }


def build_gex(raw: dict) -> dict:
    index = raw.get("index")
    if not isinstance(index, dict):
        raise ValueError("gex.json has no index section")
    rows = [gex_row(s, index.get(s)) for s in INDEX_SYMBOLS]
    return {
        "asOf": epoch(raw.get("updatedAt")),
        "oiSession": day(raw.get("oiSession")),
        "label": text(raw.get("label"), 300),
        "index": [r for r in rows if r is not None],
    }


def series_row(row: dict) -> dict | None:
    sid = row.get("id")
    if not isinstance(sid, str) or not SLUG.fullmatch(sid):
        return None
    return {
        "id": sid,
        "label": text(row.get("label"), 120) or sid,
        "group": text(row.get("group"), 30) or "other",
        "units": text(row.get("units"), 20) or "",
        "status": text(row.get("status"), 20) or "unknown",
        "stale": row.get("stale") is True,
        "value": number(row.get("value")),
        "date": day(row.get("date")),
        "change1d": number(row.get("change1d")),
        "change1w": number(row.get("change1w")),
        "change1m": number(row.get("change1m")),
        "change1y": number(row.get("change1y")),
        "pct1y": number(row.get("pct1y")),
        "source": text(row.get("source"), 40),
        "sourceUrl": link(row.get("sourceUrl")),
    }


def build_macro(raw: dict) -> dict:
    series = raw.get("series")
    order = raw.get("seriesOrder")
    if not isinstance(series, dict):
        raise ValueError("macro.json has no series section")
    ids = list(dict.fromkeys(i for i in order if isinstance(i, str))) if isinstance(order, list) else list(series)
    rows = [series_row(series[i]) for i in ids if isinstance(series.get(i), dict)]
    regimes = []
    for rid, regime in (raw.get("regimes") or {}).items():
        if isinstance(regime, dict) and SLUG.fullmatch(str(rid)) and text(regime.get("label"), 120):
            regimes.append(
                {
                    "id": rid,
                    "label": text(regime.get("label"), 120),
                    "rule": text(regime.get("rule"), 300),
                }
            )
    events: list[dict] = []
    calendar = raw.get("events") if isinstance(raw.get("events"), dict) else {}
    for event in calendar.get("upcoming") or []:
        if isinstance(event, dict) and day(event.get("date")) and text(event.get("summary"), 80):
            if any(e["date"] == event["date"] and e["name"] == text(event.get("summary"), 80) for e in events):
                continue  # the page keys rows by date and name
            clock = event.get("time")
            events.append(
                {
                    "date": event["date"],
                    "time": clock if isinstance(clock, str) and TIME_OF_DAY.fullmatch(clock) else None,
                    "name": text(event.get("summary"), 80),
                }
            )
    return {
        "asOf": epoch(raw.get("updatedAt")),
        "series": [r for r in rows if r is not None][:MAX_SERIES],
        "regimes": regimes[:MAX_REGIMES],
        "events": events[:MAX_EVENTS],
    }


def headline(item: dict, theme_labels: dict[str, str]) -> dict | None:
    title = text(item.get("title"), 300)
    url = link(item.get("url"))
    published = epoch(item.get("published"))
    if title is None or url is None or published is None:
        return None
    scores = [s for s in (item.get("scores") or {}).values() if isinstance(s, dict)]
    macro_scores = [s for s in scores if s.get("relation") == "macro"]
    themes = [t for t in item.get("themes") or [] if t in theme_labels]
    if not macro_scores and not themes:
        return None
    used = macro_scores or scores
    sentiments = [v for v in (number(s.get("sentiment")) for s in used) if v is not None]
    ranks = [MATERIALITY_RANK[s["materiality"]] for s in used if s.get("materiality") in MATERIALITY_RANK]
    return {
        "title": title,
        "publisher": text(item.get("publisher"), 80),
        "url": url,
        "publishedAt": published,
        "theme": theme_labels[themes[0]] if themes else None,
        "sentiment": round(sum(sentiments) / len(sentiments), 2) if sentiments else None,
        "materiality": next(
            (k for k, v in MATERIALITY_RANK.items() if ranks and v == max(ranks)), None
        ),
    }


def build_news(raw: dict) -> dict:
    items = raw.get("items")
    if not isinstance(items, list):
        raise ValueError("news.json has no items section")
    themes = []
    labels: dict[str, str] = {}
    for theme in raw.get("themes") or []:
        if not isinstance(theme, dict) or theme.get("kind") != "macro":
            continue
        tid, label = theme.get("id"), text(theme.get("label"), 80)
        if not isinstance(tid, str) or not SLUG.fullmatch(tid) or label is None or tid in labels:
            continue
        labels[tid] = label
        themes.append(
            {
                "id": tid,
                "label": label,
                "count24h": int(number(theme.get("count24h")) or 0),
                "count72h": int(number(theme.get("count72h")) or 0),
                "sentiment24h": number(theme.get("sentiment24h")),
                "shock": theme.get("shock") is True,
            }
        )
    rows = [h for h in (headline(i, labels) for i in items if isinstance(i, dict)) if h]
    rows.sort(key=lambda h: h["publishedAt"], reverse=True)
    newest: dict[str, dict] = {}
    for row in rows:
        newest.setdefault(row["url"], row)  # one row per link (the page key), the newest copy
    rows = list(newest.values())
    return {
        "asOf": epoch(raw.get("updatedAt")),
        "themes": themes[:MAX_THEMES],
        "headlines": rows[:MAX_HEADLINES],
    }


BUILDERS = {"gex": build_gex, "macro": build_macro, "news": build_news}


def read_state(name: str, state_dir: str) -> dict:
    with open(os.path.join(state_dir, f"{name}.json"), encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise ValueError(f"{name}.json is not an object")
    return raw


def collect_document(state_dir: str = STATE_DIR, now: int | None = None) -> dict:
    document: dict[str, Any] = {
        "schema": SCHEMA,
        "generatedAt": int(time.time()) if now is None else now,
        "host": "dev-rig",
        "missing": [],
    }
    for name, builder in BUILDERS.items():
        try:
            document[name] = builder(read_state(name, state_dir))
        except (OSError, ValueError, TypeError, AttributeError) as error:
            # json.JSONDecodeError is a ValueError. Only the section name is pushed, never the error text.
            print(f"{name}: unreadable ({type(error).__name__}: {error})", file=sys.stderr)
            document[name] = None
            document["missing"].append(name)
    return document


def main(argv: list[str]) -> int:
    document = collect_document(STATE_DIR)
    if "--print" in argv:
        print(json.dumps(document, indent=2))
        return 0
    collect.push(document, os.environ.get("VERTEX_MARKET_CONTEXT_HOST", "quantvps"))
    if document["missing"]:
        print(f"pushed without: {', '.join(document['missing'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
