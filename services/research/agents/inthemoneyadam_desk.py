"""In The Money Adam stock-picking desk for the Vertex research council.

Research only. The desk reads one local knowledge base (the "In The Money Adam" video
corpus: ``scripts/extractions/*.json`` plus ``raw/<video_id>.md`` transcripts) and returns
a typed, cited research opinion for one ticker. It is deterministic and extractive: it
calls no model, places no order, selects no contract, reads no account data and never
sizes a position. Every citation quote is checked to occur verbatim in the raw
transcript; an unverified quote is dropped. Without a verified citation the verdict is
always ``insufficient_evidence``.

KB text is untrusted data. It is copied into quotes and rule text only, never executed or
followed as an instruction.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

DESK_ID = "inthemoneyadam"
DESK_NAME = "In The Money Adam stock-picking desk"
RESEARCH_ONLY_NOTICE = (
    "Research only. This desk output is an opinion summary of public videos. "
    "It can never authorize, create or size a trade."
)

Ticker = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Z][A-Z0-9.\-]{0,9}$")
]
Verdict = Literal["favorable", "neutral", "unfavorable", "insufficient_evidence"]
Category = Literal[
    "stock-picking-criteria", "valuation", "catalysts", "risk", "entries-exits", "sizing", "market-view", "key-idea"
]
CATEGORIES = frozenset(get_args(Category))
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
TIMESTAMP = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")


class DeskError(RuntimeError):
    """The knowledge base is missing or malformed."""


class _Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Citation(_Schema):
    video_id: Annotated[str, StringConstraints(pattern=VIDEO_ID.pattern)]
    title: Annotated[str, StringConstraints(max_length=300)]
    url: Annotated[str, StringConstraints(pattern=r"^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}&t=\d+s$")]
    timestamp: Annotated[str, StringConstraints(pattern=TIMESTAMP.pattern)]
    quote: Annotated[str, StringConstraints(min_length=1, max_length=600)]


class DeskFinding(_Schema):
    category: Category
    rule: Annotated[str, StringConstraints(min_length=1, max_length=600)]
    ticker_specific: bool
    stance: Literal["positive", "negative", "neutral"] | None
    citation: Citation


class DeskOutput(_Schema):
    desk: Literal["inthemoneyadam"] = DESK_ID
    ticker: Ticker
    thesis: Annotated[str, StringConstraints(max_length=1000)] | None = None
    verdict: Verdict
    verdict_method: Literal["lexical_stance_count"] = "lexical_stance_count"
    # Generic rules and rules from videos about the ticker that do not name it: no stance.
    criteria_checked: list[DeskFinding]
    # Findings whose own text or quote names the ticker; only these set the verdict.
    ticker_findings: list[DeskFinding]
    risks: list[DeskFinding]
    citations: list[Citation]
    research_only: Literal[True] = True
    can_authorize_trade: Literal[False] = False
    notice: Literal[
        "Research only. This desk output is an opinion summary of public videos. "
        "It can never authorize, create or size a trade."
    ] = RESEARCH_ONLY_NOTICE
    kb_commit: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{7,40}$")] | None = None

    @model_validator(mode="after")
    def _cited(self) -> "DeskOutput":
        findings = [*self.criteria_checked, *self.ticker_findings, *self.risks]
        directional = [f for f in self.ticker_findings if f.stance in ("positive", "negative")]
        if self.verdict != "insufficient_evidence" and not (directional or any(r.ticker_specific for r in self.risks)):
            raise ValueError("a verdict other than insufficient_evidence needs a ticker-naming directional citation")
        if any(not f.ticker_specific or f.stance is None for f in self.ticker_findings):
            raise ValueError("ticker findings must name the ticker and carry a stance")
        if any(f.stance is not None for f in [*self.criteria_checked, *self.risks]):
            raise ValueError("criteria and risks carry no stance")
        cited = set(self.citations)
        if any(f.citation not in cited for f in findings):
            raise ValueError("every finding citation must appear in citations")
        if self.citations and not findings:
            raise ValueError("citations without findings")
        return self


@dataclass(frozen=True)
class KbRule:
    video_id: str
    title: str
    tickers: frozenset[str]
    video_summary: str
    category: str
    rule: str
    timestamp: str
    quote: str


@dataclass(frozen=True)
class KbCorpus:
    rules: tuple[KbRule, ...]
    transcripts: dict[str, str]
    commit: str | None = None


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _seconds(timestamp: str) -> int:
    total = 0
    for part in timestamp.split(":"):
        total = total * 60 + int(part)
    return total


def _transcript_body(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4 :]
    return text


def load_corpus(root: Path, commit: str | None = None) -> KbCorpus:
    """Load rules and transcripts. Raises DeskError when the KB layout is absent."""
    extractions = root / "scripts" / "extractions"
    if not extractions.is_dir():
        raise DeskError(f"knowledge base extractions not found under {root}")
    rules: list[KbRule] = []
    transcripts: dict[str, str] = {}
    for path in sorted(extractions.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise DeskError(f"unreadable extraction {path.name}") from error
        video_id = str(data.get("video_id") or path.stem)
        if not VIDEO_ID.match(video_id):
            continue
        raw = root / "raw" / f"{video_id}.md"
        if raw.is_file():
            transcripts[video_id] = _normalize(_transcript_body(raw.read_text(encoding="utf-8")))
        title = str(data.get("title") or video_id)[:300]
        tickers = frozenset(str(t).upper() for t in data.get("tickers") or [] if isinstance(t, str))
        summary = f"{title} {data.get('one_line') or ''}"
        for idea in data.get("key_ideas") or []:
            if not isinstance(idea, dict):
                continue
            name, explanation = idea.get("name"), idea.get("explanation")
            for evidence in idea.get("evidence") or []:
                if not (isinstance(evidence, dict) and isinstance(name, str) and isinstance(explanation, str)):
                    continue
                ts, quote = evidence.get("timestamp"), evidence.get("quote")
                if isinstance(ts, str) and TIMESTAMP.match(ts) and isinstance(quote, str) and quote:
                    rules.append(KbRule(video_id, title, tickers, summary, "key-idea", f"{name}: {explanation}", ts, quote))
        for item in data.get("rules") or []:
            if not isinstance(item, dict):
                continue
            category, rule = item.get("category"), item.get("rule")
            timestamp, quote = item.get("timestamp"), item.get("quote")
            if not all(isinstance(v, str) and v for v in (category, rule, timestamp, quote)):
                continue
            if not TIMESTAMP.match(timestamp):
                continue
            rules.append(KbRule(video_id, title, tickers, summary, category, rule, timestamp, quote))
    return KbCorpus(tuple(rules), transcripts, commit)


def quote_is_verbatim(corpus: KbCorpus, video_id: str, quote: str) -> bool:
    """True when the quote occurs in that video's raw transcript (case and punctuation folded)."""
    body = corpus.transcripts.get(video_id)
    needle = _normalize(quote)
    return bool(body and needle and needle in body)


_POSITIVE = ("buy", "bullish", "undervalued", "cheap", "accumulate", "add to", "upside", "favorite", "outperform", "right about", "correct", "winner")
_NEGATIVE = ("avoid", "sell", "bearish", "overvalued", "expensive", "short", "downside", "bubble", "trim", "exit", "red flag", "don't buy", "do not buy")


def _stance(rule: str) -> Literal["positive", "negative", "neutral"]:
    text = f" {_normalize(rule)} "
    neg = sum(f" {_normalize(w)} " in text for w in _NEGATIVE)
    pos = sum(f" {_normalize(w)} " in text for w in _POSITIVE)
    if pos > neg:
        return "positive"
    if neg > pos:
        return "negative"
    return "neutral"


def _pattern(ticker: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(ticker)}(?![A-Za-z0-9])")


def _names(rule: KbRule, ticker: str) -> bool:
    """The item's own rule text or quote names the ticker."""
    pattern = _pattern(ticker)
    return bool(pattern.search(rule.rule) or pattern.search(rule.quote))


def _about(rule: KbRule, ticker: str) -> bool:
    """The item comes from a video whose title or one-line summary names the ticker."""
    return ticker in rule.tickers and bool(_pattern(ticker).search(rule.video_summary))


def _terms(thesis: str | None) -> set[str]:
    return {w for w in _normalize(thesis or "").split() if len(w) > 3}


def _finding(rule: KbRule, ticker_specific: bool, *, directional: bool = True) -> DeskFinding:
    """Only ticker-naming findings carry a stance; generic rules carry none."""
    url = f"https://www.youtube.com/watch?v={rule.video_id}&t={_seconds(rule.timestamp)}s"
    citation = Citation(video_id=rule.video_id, title=rule.title, url=url, timestamp=rule.timestamp, quote=rule.quote[:600])
    return DeskFinding.model_validate(
        {"category": rule.category, "rule": rule.rule[:600], "ticker_specific": ticker_specific,
         "stance": _stance(rule.rule) if ticker_specific and directional else None, "citation": citation}
    )


def _unique(rules: Iterable[KbRule]) -> list[KbRule]:
    seen: set[tuple[str, str]] = set()
    out: list[KbRule] = []
    for r in rules:
        key = (r.video_id, _normalize(r.quote))
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def run_desk(corpus: KbCorpus, ticker: str, thesis: str | None = None, *, limit: int = 8) -> DeskOutput:
    """Return the desk's cited research opinion on one ticker. Never raises on no evidence."""
    ticker = ticker.strip().upper()
    verified = [r for r in corpus.rules if r.category in CATEGORIES and quote_is_verbatim(corpus, r.video_id, r.quote)]
    named = _unique(r for r in verified if _names(r, ticker))
    context = _unique(r for r in verified if r not in named and _about(r, ticker) and r.category != "sizing")
    terms = _terms(thesis)

    def score(rule: KbRule) -> int:
        return len(terms & set(_normalize(rule.rule).split()))

    ticker_rules = sorted((r for r in named if r.category not in ("risk", "sizing")), key=score, reverse=True)[:limit]
    named_risks = [r for r in named if r.category == "risk"]
    risk_rules = _unique([*named_risks, *(r for r in context if r.category == "risk")])[:limit]
    context_rules = sorted((r for r in context if r.category != "risk"), key=score, reverse=True)[:limit]
    general = [r for r in verified if r.category in ("stock-picking-criteria", "valuation", "catalysts") and r not in context and r not in named]
    criteria_rules = [*context_rules, *sorted(_unique(general), key=score, reverse=True)][:limit]

    ticker_findings = [_finding(r, True) for r in ticker_rules]
    risks = [_finding(r, r in named_risks, directional=False) for r in risk_rules]
    criteria = [_finding(r, False) for r in criteria_rules]
    positive = sum(f.stance == "positive" for f in ticker_findings)
    negative = sum(f.stance == "negative" for f in ticker_findings) + sum(f.ticker_specific for f in risks)
    verdict: Verdict
    if not ticker_findings:
        verdict, risks, criteria = "insufficient_evidence", [], []
    elif positive == 0 and negative == 0:
        verdict = "insufficient_evidence"
    else:
        verdict = "favorable" if positive > negative else "unfavorable" if negative > positive else "neutral"
    citations = list(dict.fromkeys(f.citation for f in [*ticker_findings, *risks, *criteria]))
    return DeskOutput(
        ticker=ticker,
        thesis=thesis,
        verdict=verdict,
        criteria_checked=criteria,
        ticker_findings=ticker_findings,
        risks=risks,
        citations=citations,
        kb_commit=corpus.commit,
    )


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=DESK_NAME)
    parser.add_argument("--kb", required=True, type=Path)
    parser.add_argument("--kb-commit")
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--thesis")
    args = parser.parse_args(argv)
    output = run_desk(load_corpus(args.kb, args.kb_commit), args.ticker, args.thesis)
    print(output.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
