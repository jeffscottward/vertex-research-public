"""QuantMind strategy mining over Quant Lab paper captures.

Research only. This module reads captured paper metadata (Quant Lab
``private/quantlab/captures/*.json``) and optional retained text, ranks the
papers for a topic with the QuantMind knowledge boundary
(``QuantMindKnowledgeAdapter``), and writes Quant Lab DRAFT spec inputs for the
papers whose title or abstract names a rule the engine supports
(``price_above_sma`` or ``momentum``, one instrument, long or cash).

Rules:
- Deterministic. No model, no network, no clock: the same captures give the
  same bytes.
- ``paper_claims`` are verbatim sentences from the captured title or abstract.
  ``our_reading`` holds every choice we made. The two never mix.
- Each draft names the capture it came from (``capture_id`` and the canonical
  SHA-256 of the capture record).
- Each draft goes through ``quantlab.spec.build_spec``. A draft that fails is
  rejected with the reason; nothing is guessed to make it pass.
- No order fields: drafts carry no order, price, size or broker keys.

No QuantMind (LLMQuant, MIT) code is copied; only the idea of a knowledge base
of paper cards searched by a query is used (see services/research/NOTICE.txt).
Paper text is untrusted data. It is matched with fixed patterns and quoted,
never executed or followed.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quantlab.spec import SIGNAL_TYPES, SpecError, build_spec, canonical

from .external_research import QuantMindKnowledgeAdapter, _order_keys

TOOL = "agents.quantmind_cli mine"
MAX_TEXT_BYTES = 2_000_000
MAX_QUOTE_CHARS = 1000
MAX_CLAIMS = 4

# --- local QuantMind client over Quant Lab captures ---------------------------------


@dataclass(frozen=True)
class CaptureRecord:
    capture_id: str
    capture_sha256: str
    capture_file: str
    capture: dict
    retained_text: str | None = None
    retained_text_sha256: str | None = None


def capture_sha256(capture: dict) -> str:
    return hashlib.sha256(canonical(capture)).hexdigest()


def _is_capture(value: Any) -> bool:
    return (isinstance(value, dict) and isinstance(value.get("doi"), str)
            and isinstance(value.get("version"), str) and isinstance(value.get("title"), str)
            and isinstance(value.get("captured_at"), str) and isinstance(value.get("pdf_status"), str))


def _ssrn_id(capture: dict) -> str:
    raw = str(capture.get("ssrn_id") or capture["doi"].rsplit(".", 1)[-1])
    return re.sub(r"[^0-9A-Za-z]+", "-", raw).strip("-") or "unknown"


class LocalCaptureClient:
    """QuantMind client (``fetch(source) -> (title, text, source_url)``) over local captures.

    Reads ``<captures>/*.json``: one capture per file (``quantlab paper``) or a
    search bundle ``{"captures": [...]}`` (``quantlab search``). A capture is
    unique by DOI and version; when several files hold the same one, the
    earliest ``captured_at`` (then the smallest hash) wins. Retained text is a
    ``.txt`` file next to the retained PDF in ``papers`` with the same stem
    (for example made by ``pdftotext``); it is read only from that folder.
    """

    def __init__(self, captures: Path, papers: Path | None = None) -> None:
        self.captures_dir = Path(captures)
        self.papers_dir = Path(papers) if papers else self.captures_dir.parent / "papers"
        self.skipped: list[dict[str, str]] = []
        self._records: dict[str, CaptureRecord] = {}
        self._load()

    def _load(self) -> None:
        best: dict[tuple[str, str], tuple[str, str, dict, str]] = {}
        if not self.captures_dir.is_dir():
            raise FileNotFoundError(f"captures folder not found: {self.captures_dir}")
        for path in sorted(self.captures_dir.glob("*.json")):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                self.skipped.append({"file": path.name, "reason": f"unreadable: {type(error).__name__}"})
                continue
            items = value.get("captures") if isinstance(value, dict) and "captures" in value else [value]
            if not isinstance(items, list):
                self.skipped.append({"file": path.name, "reason": "captures is not a list"})
                continue
            for index, item in enumerate(items):
                if not _is_capture(item):
                    self.skipped.append({"file": path.name, "reason": f"item {index} is not a paper capture"})
                    continue
                digest = capture_sha256(item)
                key = (item["doi"].lower(), item["version"])
                candidate = (item["captured_at"], digest, item, path.name)
                if key not in best or candidate[:2] < best[key][:2]:
                    best[key] = candidate
        for _, digest, item, name in best.values():
            capture_id = f"ssrn-{_ssrn_id(item)}-{digest[:12]}"
            text, text_sha = self._retained_text(item)
            self._records[capture_id] = CaptureRecord(capture_id, digest, name, item, text, text_sha)

    def _retained_text(self, capture: dict) -> tuple[str | None, str | None]:
        pdf_path = capture.get("pdf_path")
        if capture.get("pdf_status") != "retained" or not capture.get("pdf_sha256") or not pdf_path:
            return None, None
        sidecar = self.papers_dir / (Path(str(pdf_path)).stem + ".txt")
        try:
            if sidecar.resolve().parent != self.papers_dir.resolve() or not sidecar.is_file():
                return None, None
            body = sidecar.read_bytes()
        except OSError:
            return None, None
        if len(body) > MAX_TEXT_BYTES:
            return None, None
        text = body.decode("utf-8", errors="replace").strip()
        return (text, hashlib.sha256(body).hexdigest()) if text else (None, None)

    def sources(self) -> list[str]:
        return sorted(self._records)

    def record(self, source: str) -> CaptureRecord:
        return self._records[source]

    def fetch(self, source: str) -> tuple[str | None, str, str | None]:
        record = self._records[source]
        capture = record.capture
        parts = [f"# {capture['title']}", f"DOI {capture['doi']}"]  # same title, other paper: keep both
        if capture.get("abstract"):
            parts.append(str(capture["abstract"]))
        if record.retained_text:
            parts.append(record.retained_text)
        return capture["title"], "\n\n".join(parts), capture.get("url") or f"https://doi.org/{capture['doi']}"


def build_knowledge(client: LocalCaptureClient) -> tuple[QuantMindKnowledgeAdapter, dict[str, str], list[dict]]:
    """Ingest every capture. Returns the knowledge base, source_id -> capture_id, and skipped duplicates."""
    knowledge = QuantMindKnowledgeAdapter(client)
    by_source: dict[str, str] = {}
    duplicates: list[dict] = []
    for capture_id in client.sources():
        source_id = knowledge.ingest(capture_id)
        if source_id in by_source:
            duplicates.append({"capture_id": capture_id, "reason": f"same text as {by_source[source_id]}"})
            continue
        by_source[source_id] = capture_id
    return knowledge, by_source, duplicates


# --- deterministic rule detection ---------------------------------------------------

_SMA = (r"\bmoving[- ]averages?\b", r"\bsmas?\b")
_TS_MOMENTUM = (r"\btime[- ]series momentum\b", r"\babsolute momentum\b", r"\btrend[- ]following\b",
                r"\btsmom\b")
_ANY_MOMENTUM = (r"\bmomentum\b",)
_CROSS_SECTIONAL = r"\bcross[- ]sectional\b|\brelative momentum\b|\bwinners?\b.{0,40}\blosers?\b"
# "Moving average" inside a model name is not a trading rule.
_MODEL_TERMS = (r"\bauto[- ]?regressive integrated moving averages?\b|\barima\b|\barma\b|\bmoving averages? models?\b"
                r"|\bmoving average convergence[- ]divergence\b|\bmacd\b")
# Rules built from several averages; the engine compares the price with one simple moving average.
_MULTI_AVERAGE = (r"\b(?:triple|dual|double) moving averages?\b|\bcombination of (?:simple )?moving averages?\b"
                  r"|\bmoving averages? (?:distance|cross-?overs?)\b|\bcross-?overs?\b"
                  r"|\bdistance between (?:the )?short[- ]\S*\s+and long[- ]\S*\s+moving averages?\b")
_UNSUPPORTED = {
    "cross-sectional ranking": _CROSS_SECTIONAL,
    "long-short positions": r"\blong[- /]short\b|\bshort[- ]selling\b|\bshort positions?\b",
    "pairs trading": r"\bpairs? trading\b|\bcointegrat",
    "options": r"\boptions? (?:pricing|strateg|writing|overlay|premium|market)|\b(?:put|call) options?\b|\bimplied volatility\b",
    "leverage": r"\blever(?:age|aged)\b",
    "intraday data": r"\bintraday\b|\bhigh[- ]frequency\b",
    "multi-asset portfolio": r"\bportfolio of\b|\bmulti[- ]asset\b|\basset classes\b",
    "rules that combine several moving averages": _MULTI_AVERAGE,
    "exponential or weighted moving averages": r"\bexponential moving averages?\b|\bweighted moving averages?\b"
                                               r"|\bweighting schemes?\b",
    "many portfolios or stocks": r"\bdecile portfolios\b|\bindividual (?:us )?stocks\b",
}
_PERFORMANCE = r"\b(?:outperform\w*|sharpe|drawdown|returns?|volatility|risk[- ]adjusted|transaction costs?)\b"
_NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                 "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
_LOOKBACK = re.compile(
    r"\b(\d{1,3}|" + "|".join(_NUMBER_WORDS) + r")[- ]?(day|month)s?[- ](?:simple |exponential )?"
    r"(moving[- ]averages?|sma|momentum|returns?|lookback)", re.IGNORECASE)
DEFAULTS = {
    "price_above_sma": {"months": (10, list(range(2, 13))), "days": (200, [50, 100, 150, 200, 250])},
    "momentum": {"months": (12, list(range(1, 13))), "days": (252, [21, 63, 126, 189, 252])},
}
_DESCRIPTION = {
    "price_above_sma": "price above its simple moving average",
    "momentum": "positive time-series momentum",
}


def _any(patterns: tuple[str, ...] | str, text: str) -> str | None:
    for pattern in (patterns,) if isinstance(patterns, str) else patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(0)
    return None


def sentences(text: str) -> list[str]:
    """Split on sentence ends. Each part is a verbatim substring of ``text``."""
    return [part for part in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", text.strip()) if part]


@dataclass(frozen=True)
class Detection:
    signal: str | None
    matched: str | None
    unsupported: tuple[str, ...]
    reason: str | None


def detect(title: str, abstract: str) -> Detection:
    """Choose the supported rule named in the title or abstract, or a rejection reason."""
    text = f"{title}\n{abstract}"
    unsupported = tuple(name for name, pattern in _UNSUPPORTED.items() if re.search(pattern, text, re.IGNORECASE))
    rule_text = re.sub(_MODEL_TERMS, " ", text, flags=re.IGNORECASE)
    multi = _any(_MULTI_AVERAGE, title)
    if multi:
        return Detection(None, multi, unsupported,
                         f"the title names a rule built from several moving averages (\"{multi}\"); the engine "
                         "compares the price with one simple moving average")
    sma = _any(_SMA, rule_text)
    if sma:
        return Detection("price_above_sma", sma, unsupported, None)
    ts = _any(_TS_MOMENTUM, rule_text)
    if ts:
        return Detection("momentum", ts, unsupported, None)
    if _any(_SMA, text):
        return Detection(None, None, unsupported,
                         "\"moving average\" appears only inside a model or indicator name (ARIMA, MACD); no supported signal")
    generic = _any(_ANY_MOMENTUM, text)
    if generic and "cross-sectional ranking" in unsupported:
        return Detection(None, generic, unsupported,
                         "cross-sectional momentum ranks many instruments; the engine supports one instrument, "
                         "long or cash")
    if generic and "long-short positions" in unsupported:
        return Detection(None, generic, unsupported,
                         "long-short momentum needs short positions; the engine supports long or cash only")
    if generic:
        return Detection("momentum", generic, unsupported, None)
    return Detection(None, None, unsupported,
                     f"no supported signal ({', '.join(sorted(SIGNAL_TYPES))}) named in the title or abstract")


def lookback_from_text(text: str, signal: str) -> tuple[int, str, str] | None:
    """Return (lookback, unit, matched text) when the abstract states one for this signal family."""
    for match in _LOOKBACK.finditer(text):
        raw, unit, kind = match.group(1).lower(), match.group(2).lower() + "s", match.group(3).lower()
        family = "price_above_sma" if kind.startswith(("moving", "sma")) else "momentum"
        if family != signal:
            continue
        value = int(raw) if raw.isdigit() else _NUMBER_WORDS[raw]
        if 1 <= value <= 400:
            return value, unit, match.group(0)
    return None


def _claims(title: str, abstract: str, signal_hit: str) -> list[dict]:
    claims: list[dict] = []
    keyword = re.compile(re.escape(signal_hit), re.IGNORECASE)
    performance = re.compile(_PERFORMANCE, re.IGNORECASE)
    for sentence in sentences(abstract):
        if len(sentence) > MAX_QUOTE_CHARS:
            continue
        if keyword.search(sentence) or performance.search(sentence):
            claims.append({"locator": "abstract", "quote": sentence})
    claims.sort(key=lambda c: 0 if keyword.search(c["quote"]) else 1)  # stable: abstract order inside groups
    claims = claims[:MAX_CLAIMS]
    if not claims or (not any(keyword.search(c["quote"]) for c in claims) and keyword.search(title)):
        claims.insert(0, {"locator": "title", "quote": title})
    for claim in claims:  # verbatim guard: a quote is always a substring of the captured text
        source = title if claim["locator"] == "title" else abstract
        if claim["quote"] not in source:
            raise SpecError("claim is not verbatim captured text")
    return claims[:MAX_CLAIMS]


def topic_folder_name(topic: str) -> str:
    """Slug plus a short hash of the exact topic, so topics with the same slug never share a folder."""
    return f"{_slug(topic)}-{hashlib.sha256(topic.encode('utf-8')).hexdigest()[:8]}"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "topic"


# --- drafts --------------------------------------------------------------------------


@dataclass(frozen=True)
class MineOptions:
    instrument: str = "SPY"
    in_sample_end: str = "2009-12-31"
    preregistered_at: str | None = None  # None: the capture time, so reruns are byte-identical
    top: int = 10
    min_confidence: float = 0.5


def draft_for(record: CaptureRecord, detection: Detection, *, topic: str, rank: int, confidence: float,
              knowledge_source_id: str, options: MineOptions) -> dict:
    capture = record.capture
    title, abstract = capture["title"], capture.get("abstract") or ""
    signal = detection.signal
    if signal is None or detection.matched is None:
        raise SpecError(detection.reason or "no supported signal")
    stated = lookback_from_text(f"{title}\n{abstract}", signal)
    if stated:
        lookback, unit, stated_text = stated
        default, grid = DEFAULTS[signal][unit]
        grid = sorted(set(grid) | {lookback})
        lookback_note = f"Lookback {lookback} {unit} as stated in the captured text (\"{stated_text}\")."
    else:
        unit = "months"
        lookback, grid = DEFAULTS[signal][unit]
        lookback_note = f"Lookback {lookback} months is our default; the captured text states none."
    full_text = bool(capture.get("pdf_sha256"))
    unit_word = unit[:-1]
    gaps = [
        "Draft made by fixed keyword rules from the title and abstract; no model read the paper.",
        "The paper's exact instrument, sample period, parameter grid, selection rule and cost level are unknown.",
        "Reported metrics are not extracted, so no paper number can be compared with ours.",
    ]
    if not abstract:
        gaps.insert(0, "No abstract was captured; the only paper claim is the title.")
    if not full_text:
        gaps.insert(0, "Full text is not retained; claims cite the title and abstract only.")
    elif record.retained_text is None:
        gaps.insert(0, "A PDF is retained but no text file is next to it; claims cite the title and abstract only.")
    if not stated:
        gaps.append("The captured text states no lookback.")
    deviations = [f"Single instrument {options.instrument}; the paper may use another market or several."]
    deviations += [f"The captured text also mentions {name}; that part is not tested." for name in detection.unsupported]
    entry = (f"At a month-end close, if the {unit_word} rule is true ({_DESCRIPTION[signal]}, lookback "
             f"{lookback} {unit}), hold {options.instrument} from the next open.")
    exit_rule = (f"At a month-end close, if the rule is false, move out of {options.instrument} at the next "
                 "open and hold T-bills.")
    draft = {
        "id": f"qm-{_ssrn_id(capture)}-{signal.replace('_', '-')}-{record.capture_sha256[:8]}",
        "name": f"SSRN {_ssrn_id(capture)} {_DESCRIPTION[signal]}, {options.instrument} vs T-bills (QuantMind mined)",
        "hypothesis": (f"A monthly rule that holds {options.instrument} while its {_DESCRIPTION[signal]} "
                       f"({lookback} {unit}) and T-bills otherwise has a higher Sharpe ratio and a smaller "
                       "drawdown than buy-and-hold in out-of-sample, walk-forward tests with costs. The paper is "
                       "cited for the rule only; no paper result is assumed."),
        "drafted_by": f"{TOOL} (deterministic keyword rules, no model)",
        "paper_claims": _claims(title, abstract, detection.matched),
        "our_reading": {
            "interpretation": (f"The title or abstract names a {signal} rule (matched \"{detection.matched}\"). "
                               f"We test it as one-instrument, long-or-cash timing of {options.instrument}."),
            "gaps": gaps,
            "assumptions": [
                lookback_note,
                f"Instrument {options.instrument}; signals use adjusted closes (total return).",
                "Cash earns the 13-week T-bill yield (^IRX), forward-filled, accrued per trading day.",
                "Decision at the last trading day close of each month; fill at the next session open.",
                f"Walk-forward grid {grid[0]}..{grid[-1]} {unit}, selected by Sharpe on a rolling 10-year train "
                "window, applied to the next 2 years.",
                "Costs per side: commission 0.5 bp, half-spread 0.5 bp, slippage 1 bp; stress test at 5x.",
            ],
            "deviations": deviations,
        },
        "universe": {"instruments": [options.instrument], "cash": {"type": "t_bill", "symbol": "^IRX"}},
        "signal": {"type": signal, "lookback": lookback, "lookback_unit": unit},
        "entry": {"rule": entry},
        "exit": {"rule": exit_rule},
        "rebalance": {"frequency": "monthly", "execution": "next_open"},
        "sizing": {"type": "fixed_weight", "weight": 1.0},
        "costs": {"commission_bps": 0.5, "half_spread_bps": 0.5, "slippage_bps": 1.0},
        "validation": {
            "in_sample_end": options.in_sample_end,
            "walk_forward": {"train_years": 10, "test_years": 2, "lookback_grid": grid, "objective": "sharpe"},
            "rejection_criteria": [
                {"check": "walk_forward_sharpe_gt_benchmark"},
                {"check": "walk_forward_drawdown_better"},
                {"check": "oos_sharpe_gt_benchmark"},
                {"check": "survives_cost_stress"},
            ],
            "preregistered_at": options.preregistered_at or capture["captured_at"],
        },
        "mining": {
            "tool": TOOL,
            "topic": topic,
            "rank": rank,
            "search_confidence": confidence,
            "knowledge_source_id": knowledge_source_id,
            "capture_id": record.capture_id,
            "capture_sha256": record.capture_sha256,
            "capture_file": record.capture_file,
            "doi": capture["doi"],
            "version": capture["version"],
            "retained_text_sha256": record.retained_text_sha256,
        },
    }
    return draft


def mine(client: LocalCaptureClient, topic: str, options: MineOptions = MineOptions()) -> dict:
    """Rank captured papers for ``topic`` and draft or reject each candidate. Pure: no file writes."""
    knowledge, by_source, duplicates = build_knowledge(client)
    refs = knowledge.search(topic, top_k=max(len(by_source), 1))
    candidates: list[dict] = []
    drafts: dict[str, dict] = {}
    captures: dict[str, dict] = {}
    eligible = [ref for ref in refs if float(ref.confidence or 0.0) >= options.min_confidence]
    below = len(refs) - len(eligible)
    for ref in eligible[: max(options.top, 0)]:
        confidence = float(ref.confidence or 0.0)
        source_id = (ref.raw or {})["source_id"]
        record = client.record(by_source[source_id])
        capture = record.capture
        row: dict[str, Any] = {"rank": len(candidates) + 1, "capture_id": record.capture_id,
                               "doi": capture["doi"], "title": capture["title"], "search_confidence": confidence}
        detection = detect(capture["title"], capture.get("abstract") or "")
        reason = detection.reason
        draft = None
        if reason is None:
            try:
                draft = draft_for(record, detection, topic=topic, rank=row["rank"], confidence=confidence,
                                  knowledge_source_id=source_id, options=options)
                found = _order_keys(draft)
                if found:
                    raise SpecError(f"order fields in draft: {sorted(found)}")
                spec = build_spec(capture, draft)
                row["validated_spec_sha256"] = spec["spec_sha256"]
            except SpecError as error:
                reason, draft = f"spec validation failed: {error}", None
        if draft is None:
            row.update(status="rejected", reason=reason)
        else:
            row.update(status="drafted", draft_id=draft["id"], signal=draft["signal"])
            drafts[draft["id"]] = draft
            captures[record.capture_id] = capture
        candidates.append(row)
    drafted = sum(1 for c in candidates if c["status"] == "drafted")
    report = {
        "tool": TOOL,
        "mode": "deterministic",
        "topic": topic,
        "options": {"instrument": options.instrument, "in_sample_end": options.in_sample_end,
                    "preregistered_at": options.preregistered_at, "top": options.top,
                    "min_confidence": options.min_confidence},
        "knowledge": {"captures_loaded": len(client.sources()), "sources_ingested": len(by_source),
                      "skipped_files": client.skipped, "duplicate_text": duplicates},
        "counts": {"matched": len(refs), "below_min_confidence": below, "candidates": len(candidates),
                   "drafted": drafted, "rejected": len(candidates) - drafted},
        "candidates": candidates,
    }
    return {"report": report, "drafts": drafts, "captures": captures}


def write_outputs(result: dict, out: Path) -> tuple[Path, dict]:
    """Write drafts, single-capture copies and the report under ``out/<topic-slug>-<sha8>/``.

    Drafts and capture copies from an earlier run of the same topic are removed
    first, so the folder always matches its report. File names in the report are
    relative to the topic folder. Returns (topic folder, report).
    """
    report = json.loads(json.dumps(result["report"]))
    folder = out / topic_folder_name(report["topic"])
    for stale in [*folder.glob("drafts/qm-*.json"), *folder.glob("captures/ssrn-*.json")]:
        stale.unlink()
    for capture_id, capture in sorted(result["captures"].items()):
        _write(folder / "captures" / f"{capture_id}.json", capture)
    for row in report["candidates"]:
        if row["status"] != "drafted":
            continue
        draft = result["drafts"][row["draft_id"]]
        _write(folder / "drafts" / f"{draft['id']}.json", draft)
        row["draft_file"] = f"drafts/{draft['id']}.json"
        row["capture_file"] = f"captures/{row['capture_id']}.json"
    _write(folder / "report.json", report)
    return folder, report


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


__all__ = ["CaptureRecord", "Detection", "LocalCaptureClient", "MineOptions", "build_knowledge",
           "capture_sha256", "detect", "draft_for", "lookback_from_text", "mine", "sentences", "topic_folder_name",
           "write_outputs"]
