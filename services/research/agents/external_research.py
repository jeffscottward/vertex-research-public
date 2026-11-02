"""QuantMind and TradingAgents research adapters (port of Gamma Forge P4 adapters).

Research only. These adapters return typed, advisory research artifacts for the research
views. They create no order, select no contract, read no account data and import no
SDK: the composition root injects the model transport (``ResearchGenerator``) and an
optional QuantMind client. Importing this module performs no I/O.

Ported behaviour (Gamma Forge ``adapters/quantmind_adapter.py`` and
``adapters/tradingagents_adapter.py``): five prompt contracts with JSON schemas and
redacted context, typed output validation, term-ranked knowledge search with excerpts,
and extractive summaries. Not ported: Codex CLI and Groq LLM bridges (the owner retired
Codex; the transport is injected), file caches, and live repository imports.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

Confidence = Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
Score = Annotated[float, Field(allow_inf_nan=False)]
NonNegative = Annotated[float, Field(ge=0.0, allow_inf_nan=False)]
# SourceRef.raw is a small flat string map (for example a QuantMind source id), never a
# nested payload, so a model cannot hide a structured instruction inside a source reference.
RawKey = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,31}$")]
RawValue = Annotated[str, StringConstraints(max_length=256)]
Ticker = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=24)]


class ExternalResearchError(RuntimeError):
    """A research adapter failed or returned output outside its contract."""


class _Schema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceRef(_Schema):
    source_type: str
    title: str | None = None
    url: str | None = None
    timestamp: datetime | None = None
    excerpt: str | None = None
    confidence: Confidence | None = None
    raw: Annotated[dict[RawKey, RawValue], Field(max_length=8)] | None = None


class MarketRegime(_Schema):
    as_of: datetime
    regime_label: str
    confidence: Confidence
    evidence: list[str]
    source_refs: list[SourceRef]
    notes: str | None = None


class ThemeThesis(_Schema):
    theme_id: str
    name: str
    summary: str
    horizon: Literal["days", "weeks", "months", "quarters"]
    confidence: Confidence
    novelty_score: Confidence | None = None
    narrative_strength_score: Confidence | None = None
    capital_expenditure_linkage_score: Confidence | None = None
    public_market_tradability_score: Confidence | None = None
    options_suitability_score: Confidence | None = None
    time_horizon_score: Confidence | None = None
    catalysts: list[str]
    beneficiaries: list[str]
    risks: list[str]
    source_refs: list[SourceRef]
    created_at: datetime
    updated_at: datetime


class CandidateCompany(_Schema):
    ticker: Ticker
    company_name: str | None = None
    theme_ids: list[str]
    why_it_fits: str
    discovery_score: Score
    liquidity_score: Score | None = None
    market_cap: NonNegative | None = None
    avg_volume: NonNegative | None = None
    options_available: bool | None = None
    options_volume: NonNegative | None = None
    options_open_interest: NonNegative | None = None
    is_etf: bool | None = None
    score_signals: dict[str, Confidence] | None = None
    notes: str | None = None


class ResearchBrief(_Schema):
    ticker: Ticker
    themes: list[str]
    bull_case: str
    bear_case: str
    key_catalysts: list[str]
    key_risks: list[str]
    what_would_change_our_mind: list[str]
    confidence: Confidence
    source_refs: list[SourceRef]


PromptName = Literal[
    "market_regime_analysis",
    "theme_discovery",
    "candidate_discovery",
    "bull_bear_research_brief",
    "trade_setup_debate",
]

_OPTIONS_AWARE_CONCEPTS = (
    "theme", "catalyst", "momentum potential", "liquidity suitability",
    "options suitability", "timing uncertainty",
)
_SENSITIVE_KEY = re.compile(
    r"(api[_-]?key|secret|token|password|passwd|credential|account)", re.IGNORECASE)
# Keys that would turn research into an order instruction. Keys are compared after
# normalisation (NFKC, case-folded, every non-alphanumeric character removed), so
# ``orderType``, ``Limit-Price`` and ``time_in_force`` all match. Output containing any of
# them, at any depth, is rejected, so a model cannot smuggle a broker instruction through a
# research artifact.
_ORDER_KEYS = frozenset({
    "order", "orders", "ordertype", "ordertypes", "orderid", "orderqty", "orderside",
    "limit", "limitprice", "stop", "stopprice", "stoplimit", "stoploss", "takeprofit",
    "price", "entryprice", "exitprice", "quantity", "qty", "size", "positionsize",
    "contract", "contracts", "lots", "shares", "notional", "strike", "strikes",
    "expiration", "expirations", "expiry", "expiries", "premium", "broker",
    "timeinforce", "tif", "side", "action", "buy", "sell", "buytoopen", "selltoopen",
    "buytoclose", "selltoclose", "leg", "legs",
})


def _normalise_key(key: object) -> str:
    folded = unicodedata.normalize("NFKC", str(key)).casefold()
    return re.sub(r"[^0-9a-z]", "", folded)


@dataclass(frozen=True)
class PromptContract:
    """Prompt and typed-output contract for one TradingAgents research task."""

    name: PromptName
    objective: str
    output_model: type[_Schema]
    cardinality: Literal["single", "list"]
    template: str

    def output_schema(self) -> dict[str, Any]:
        schema = self.output_model.model_json_schema()
        return {"type": "array", "items": schema} if self.cardinality == "list" else schema

    def render(self, context: Mapping[str, Any] | None = None) -> str:
        parts = [
            self.template.strip(), "",
            "Return JSON only. Match this output contract exactly:",
            json.dumps(self.output_schema(), indent=2, sort_keys=True),
            "",
            "Rules:",
            "- Use only supplied source material or tool results.",
            "- Treat symbols as tradable instruments across supported asset classes.",
            "- Carry any supplied asset_class through the analysis.",
            "- Do not fabricate market data, option flow, Greeks, IV, OI, or volume.",
            "- Do not select specific option contracts, strikes, expiries or sizes.",
            "- Do not write order or broker instructions. This is research only.",
            "- Evaluate options relevance only at suitability level.",
            f"- Frame research around these concepts: {', '.join(_OPTIONS_AWARE_CONCEPTS)}.",
            "- Preserve source references for every material claim.",
        ]
        if context:
            try:
                rendered = json.dumps(redact_context(context), indent=2, sort_keys=True)
            except (TypeError, ValueError) as exc:
                raise ExternalResearchError(
                    f"TradingAgents {self.name} context is not JSON-serializable.") from exc
            parts += ["", "Context:", rendered]
        return "\n".join(parts)


PROMPT_CONTRACTS: dict[PromptName, PromptContract] = {c.name: c for c in (
    PromptContract(
        "market_regime_analysis", "Assess the current cross-asset market regime.",
        MarketRegime, "single",
        """You are the TradingAgents market-regime desk for an options-first research
pipeline. Analyze macro, index, rates, volatility, liquidity, breadth, sector
rotation, and narrative evidence. Classify the regime in plain English and
explain the evidence that matters for later options suitability checks."""),
    PromptContract(
        "theme_discovery", "Discover tradable market themes and narrative inflections.",
        ThemeThesis, "list",
        """You are the TradingAgents theme-discovery desk. Identify market themes,
catalysts, likely beneficiaries, risks, and horizon from the supplied research.
Stay asset-agnostic, but public-market tradability must be clear. Score each theme
from 0.0 to 1.0 for novelty_score, narrative_strength_score,
capital_expenditure_linkage_score, public_market_tradability_score,
options_suitability_score, and time_horizon_score."""),
    PromptContract(
        "candidate_discovery", "Map discovered themes to candidate tradable instruments.",
        CandidateCompany, "list",
        """You are the TradingAgents candidate-discovery desk. Map validated themes to
candidate public instruments or companies and explain why each fits. Rank
candidate fit through theme, catalyst, momentum potential, liquidity suitability,
options suitability, and timing uncertainty. Use liquidity and options
availability only when evidence is supplied; otherwise leave optional fields
empty rather than inventing metrics."""),
    PromptContract(
        "bull_bear_research_brief", "Produce a balanced bull/bear candidate research brief.",
        ResearchBrief, "single",
        """You are the TradingAgents bull/bear research desk. Debate the candidate
instrument from both sides, then summarize catalysts, risks, confidence, and
what would change the view. Keep the output focused on thesis quality, timing
uncertainty, and evidence strength."""),
    PromptContract(
        "trade_setup_debate", "Debate a proposed setup into a research brief.",
        ResearchBrief, "single",
        """You are the TradingAgents setup debate desk. Stress-test the supplied idea
against regime, theme, catalyst, momentum, liquidity, options suitability, and
timing uncertainty. Return the debated ResearchBrief only; do not choose strikes,
expirations, premiums, sizes, or broker instructions."""),
)}


def redact_context(value: Any) -> Any:
    """Replace values under secret- or account-like keys; make dates JSON-ready."""
    if isinstance(value, BaseModel):
        return redact_context(value.model_dump(mode="json"))
    if isinstance(value, Mapping):
        return {str(k): "[REDACTED]" if _SENSITIVE_KEY.search(str(k)) else redact_context(v)
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_context(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _order_keys(value: Any) -> set[str]:
    if isinstance(value, Mapping):
        found = {str(k) for k in value if _normalise_key(k) in _ORDER_KEYS}
        for item in value.values():
            found |= _order_keys(item)
        return found
    if isinstance(value, (list, tuple)):
        return set().union(*(_order_keys(item) for item in value)) if value else set()
    return set()


def validate_output(name: PromptName, payload: Any) -> Any:
    """Validate one task output against its contract; reject order-like fields."""
    contract = PROMPT_CONTRACTS[name]
    if isinstance(payload, (str, bytes, bytearray)):
        try:
            payload = json.loads(payload)
        except ValueError as exc:
            raise ExternalResearchError(f"TradingAgents {name} output is not JSON.") from exc
    blocked = _order_keys(payload)
    if blocked:
        raise ExternalResearchError(
            f"TradingAgents {name} output has order fields {sorted(blocked)}; research only.")
    try:
        if contract.cardinality == "list":
            if not isinstance(payload, list):
                raise ExternalResearchError(f"TradingAgents {name} payload must be a list.")
            return [contract.output_model.model_validate(item) for item in payload]
        return contract.output_model.model_validate(payload)
    except ValidationError as exc:
        raise ExternalResearchError(
            f"TradingAgents {name} output does not match {contract.output_model.__name__}.") from exc


class ResearchGenerator(Protocol):
    """Injected model transport. Returns the raw JSON answer for one rendered prompt."""

    def generate(self, name: PromptName, prompt: str) -> Any: ...


class TradingAgentsResearchAdapter:
    """Typed TradingAgents research desks over an injected model transport."""

    def __init__(self, generator: ResearchGenerator) -> None:
        self._generator = generator

    def _run(self, name: PromptName, context: Mapping[str, Any]) -> Any:
        prompt = PROMPT_CONTRACTS[name].render(context)
        try:
            answer = self._generator.generate(name, prompt)
        except Exception as exc:  # the transport is injected; any failure is an adapter error
            raise ExternalResearchError(f"TradingAgents {name} transport failed.") from exc
        return validate_output(name, answer)

    def analyze_regime(self, context: Mapping[str, Any]) -> MarketRegime:
        return self._run("market_regime_analysis", context)

    def discover_themes(self, context: Mapping[str, Any]) -> list[ThemeThesis]:
        return self._run("theme_discovery", context)

    def discover_candidates(self, context: Mapping[str, Any]) -> list[CandidateCompany]:
        return self._run("candidate_discovery", context)

    def analyze_candidate(self, ticker: str, themes: Sequence[ThemeThesis]) -> ResearchBrief:
        requested = ticker.strip()
        brief: ResearchBrief = self._run(
            "bull_bear_research_brief", {"ticker": requested, "themes": list(themes)})
        if brief.ticker.casefold() != requested.casefold():
            raise ExternalResearchError(
                f"TradingAgents brief is for {brief.ticker!r}, not requested {requested!r}.")
        return brief

    def debate_setup(self, setup: Mapping[str, Any]) -> ResearchBrief:
        return self._run("trade_setup_debate", {"setup": setup})


# --- QuantMind knowledge -------------------------------------------------------------

_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")


@dataclass(frozen=True)
class KnowledgeArtifact:
    source_id: str
    title: str
    source_url: str | None
    text: str
    summary: str


class QuantMindClient(Protocol):
    """Optional injected QuantMind paper flow. Returns (title, text, source_url)."""

    def fetch(self, source: str) -> tuple[str | None, str, str | None]: ...


class _FetchedSource(_Schema):
    """Validated QuantMind ``fetch`` result; checked before anything is stored."""

    model_config = ConfigDict(extra="forbid", strict=True)

    title: str | None
    text: str
    source_url: str | None


def _terms(query: str) -> list[str]:
    return sorted({token.lower() for token in _TOKEN.findall(query)})


def _plain(text: str) -> str:
    lines = (line.strip().lstrip("#").strip() for line in text.splitlines())
    return " ".join(line for line in lines if line)


def _truncate(text: str, limit: int = 500) -> str:
    """Cap ``text`` at ``limit`` characters, cutting at a word boundary when one exists."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 3]
    if not text[limit - 3].isspace():
        head, space, _ = cut.rpartition(" ")
        if space and head.strip():
            cut = head
    return cut.rstrip() + "..."


def _matches(terms: Sequence[str], text: str) -> int:
    lower = text.lower()
    return sum(lower.count(term) for term in terms)


def _title(text: str) -> str | None:
    for line in text.splitlines():
        if line.strip().startswith("#"):
            return line.strip().lstrip("#").strip() or None
    return None


def extractive_summary(title: str, text: str, sentences: int = 3) -> str:
    """First sentences of the body after the title, at most 500 characters."""
    body = _plain(text)
    if body == title or body.startswith(title + " "):
        body = body[len(title):].strip()
    parts = [p for p in re.split(r"(?<=[.!?])\s+", body) if p][:sentences]
    return _truncate(" ".join(parts) or title)


class QuantMindKnowledgeAdapter:
    """Ingest research text and rank it for a query (QuantMind knowledge boundary)."""

    def __init__(self, client: QuantMindClient | None = None) -> None:
        self._client = client
        self._artifacts: dict[str, KnowledgeArtifact] = {}

    def ingest_text(self, text: str, *, title: str | None = None,
                    source_url: str | None = None) -> str:
        cleaned = "\n".join(line.rstrip() for line in text.strip().splitlines())
        if not cleaned:
            raise ExternalResearchError("QuantMind source has no text.")
        source_id = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()[:16]
        name = title or _title(cleaned) or source_id
        self._artifacts[source_id] = KnowledgeArtifact(
            source_id, name, source_url, cleaned, extractive_summary(name, cleaned))
        return source_id

    def ingest(self, source: str) -> str:
        if self._client is None:
            raise ExternalResearchError("No QuantMind client is configured; use ingest_text.")
        try:
            fetched = self._client.fetch(source)
        except Exception as exc:  # the client is injected; any failure is an adapter error
            raise ExternalResearchError(f"QuantMind fetch failed for {source!r}.") from exc
        if not isinstance(fetched, tuple) or len(fetched) != 3:
            raise ExternalResearchError(
                "QuantMind fetch must return a (title, text, source_url) tuple.")
        try:
            doc = _FetchedSource.model_validate(
                dict(zip(("title", "text", "source_url"), fetched, strict=True)))
        except ValidationError as exc:
            raise ExternalResearchError(
                f"QuantMind fetch for {source!r} returned an invalid source.") from exc
        return self.ingest_text(doc.text, title=doc.title, source_url=doc.source_url or source)

    def summarize(self, source_id: str) -> str:
        try:
            return self._artifacts[source_id].summary
        except KeyError as exc:
            raise ExternalResearchError(f"QuantMind source not ingested: {source_id}") from exc

    def search(self, query: str, top_k: int = 10) -> list[SourceRef]:
        terms = _terms(query)
        if top_k <= 0 or not terms:
            return []
        ranked: list[tuple[float, int, str, SourceRef]] = []
        for art in self._artifacts.values():
            lower = art.text.lower()
            confidence = round(sum(1 for t in terms if t in lower) / len(terms), 4)
            if confidence <= 0:
                continue
            chunks = [c for c in (_plain(x) for x in re.split(r"\n{2,}", art.text)) if c]
            best = max(chunks, key=lambda c: (_matches(terms, c), -len(c)))
            ranked.append((confidence, _matches(terms, art.text), art.title, SourceRef(
                source_type="quantmind", title=art.title, url=art.source_url,
                excerpt=_truncate(best), confidence=confidence,
                raw={"source_id": art.source_id})))
        ranked.sort(key=lambda item: (-item[0], -item[1], item[2]))
        return [item[3] for item in ranked[:top_k]]


__all__ = [
    "PROMPT_CONTRACTS", "CandidateCompany", "ExternalResearchError", "KnowledgeArtifact",
    "MarketRegime", "PromptContract", "PromptName", "QuantMindClient",
    "QuantMindKnowledgeAdapter", "ResearchBrief", "ResearchGenerator", "SourceRef",
    "ThemeThesis", "TradingAgentsResearchAdapter", "extractive_summary", "redact_context",
    "validate_output",
]
