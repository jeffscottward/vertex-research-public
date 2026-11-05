"""AI Hedge Fund investor-persona committee in one model call. Research only.

The persona instructions (each investor's checklist, signal rules and confidence guide) are
adapted from AI Hedge Fund (https://github.com/virattt/ai-hedge-fund), commit
29b32f71861480e9bfd48b82cf0d3ca3e5680955:

- hedge_fund/signals/buffett.py, SHA256 cb5d6c57ed7992c4d4910b6957482fcf17459180db09c6ee6a7d0ad855c4c1d4
- hedge_fund/signals/munger.py, SHA256 7afd204bcf950a824cba9587421c3d7d0a1160fd2db266935ff1fb84a5af801c
- hedge_fund/signals/graham.py, SHA256 a95a149607fc02c4efacf5310933874f54fdd232be09adfe850ff52106ba655f
- hedge_fund/signals/lynch.py, SHA256 51ed7b27df87eefea7264e621c9abd40e58d1cfc3aa30f561e8225b5a4e32b14
- hedge_fund/signals/druckenmiller.py, SHA256 7128960ad1cb48dd1bd375dbd5f13fc494c6d41ecb93de4b8d0a7de3bcb5efb9

Copyright (c) 2024 Virat Singh. MIT; see backtesting/AI_HEDGE_FUND_LICENSE.txt.

Only the instruction text is adapted. Changes: the shared hard rules are stated once for the
committee; the present day is the as-of date instead of the latest filing date; confidence is
0-1 instead of 0-100; position, short and sizing wording is replaced by research signals; the
per-persona JSON schema is replaced by one committee answer with cited metrics. AI Hedge Fund's
data clients, LLM clients, portfolio manager, brokers and graph are not used. As upstream
says, the personas are stylized approximations, not the actual individuals and not
endorsements.

All personas run in ONE model call (one prompt, one JSON answer with a section per persona):
every ``omp -p`` call carries a large fixed prompt, so one call per persona would multiply the
cost. The committee summary (votes, agreement, net score, five-tier research rating) is
computed here, not by the model. Nothing here fetches data, and nothing creates, sizes or
sends an order.
"""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from agents.external_research import (
    ExternalResearchError,
    ResearchGenerator,
    _order_keys,
)
from agents.framework_types import Rating

UPSTREAM_REPO = "https://github.com/virattt/ai-hedge-fund"
UPSTREAM_COMMIT = "29b32f71861480e9bfd48b82cf0d3ca3e5680955"
PROMPT_NAME = "hedgefund_committee"
PersonaId = Literal["buffett", "munger", "graham", "lynch", "druckenmiller"]
Signal = Literal["bullish", "neutral", "bearish"]
SIGNAL_SCORE: Mapping[str, int] = {"bullish": 1, "neutral": 0, "bearish": -1}
# Net score (mean of signal x confidence, in [-1, 1]) to the five-tier research rating.
RATING_THRESHOLDS: tuple[tuple[float, Rating], ...] = (
    (0.5, "buy"), (0.2, "overweight"), (-0.2, "hold"), (-0.5, "underweight"),
)


class Persona(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: PersonaId
    name: str
    instructions: str


PERSONAS: dict[str, Persona] = {
    "buffett": Persona(id="buffett", name="Warren Buffett", instructions="""\
Evaluate the company as a long-term business owner, not a trader.
Checklist:
1. Circle of competence: can this business be understood from the data given?
2. Competitive moat: durable high returns on equity, stable or improving margins, pricing power.
3. Management quality: capital allocation visible in the numbers (book value compounding,
   sensible leverage, consistent free cash flow).
4. Financial strength: low debt, healthy current ratio, consistent earnings.
5. Valuation: is the price (market cap, P/E) sensible relative to the quality and growth of the
   business? A wonderful company at a fair price beats a fair company at a wonderful price.
6. Long-term prospects: would you be comfortable owning this business for ten years?
Signal rules:
- bullish: a strong, durable business at a reasonable or better price.
- bearish: a weak or deteriorating business, or a price that demands perfection.
- neutral: mixed evidence, or a great business at a clearly excessive price.
Confidence: 0.9-1.0 exceptional conviction with strong evidence; 0.7-0.89 solid; 0.4-0.69
mixed; 0.1-0.39 weak or speculative. If the data is insufficient, say so and go neutral."""),
    "munger": Persona(id="munger", name="Charlie Munger", instructions="""\
Evaluate the company with severity: rather miss ten good ideas than accept one bad one.
Mental models:
1. Invert, always invert: what would make this investment fail? Look for deteriorating margins,
   rising leverage, eroding returns on equity.
2. Quality of the business: a great business earns high returns on capital year after year
   without heroic assumptions. Look for consistency, not one good year.
3. Incentives and capital allocation: is book value compounding? Is free cash flow real and
   growing, or is the business consuming capital?
4. Price: a great business at a fair price is acceptable; anything at a silly price is not.
   Check the P/E against the actual growth and quality.
5. The too-hard pile: if the numbers don't paint a clear picture, say so and go neutral.
Signal rules:
- bullish: an unmistakably great business at a price that isn't foolish.
- bearish: a mediocre or deteriorating business, dishonest-looking numbers, or a valuation that
  requires believing something stupid.
- neutral: the too-hard pile, or great quality at a price you won't pay.
Confidence: 0.9-1.0 rare, obvious, quality and price align; 0.7-0.89 solid case; 0.4-0.69
mixed; 0.1-0.39 mostly the too-hard pile. Be blunt: say what the numbers show."""),
    "graham": Persona(id="graham", name="Benjamin Graham", instructions="""\
Evaluate the company as a defensive value investor. Mr. Market's opinion does not interest you;
the relationship between price and demonstrated value does.
Criteria:
1. Margin of safety: is the price low relative to demonstrated earning power and book value?
   Compare P/E and price-to-book against conservative standards. A P/E far above 15-20 demands
   extraordinary justification you will rarely grant.
2. Financial strength: current ratio comfortably above 1.5, modest debt to equity. A weak
   balance sheet disqualifies regardless of prospects.
3. Earnings stability: positive, steady earnings. Speculative growth counts for little;
   demonstrated earnings count for much.
4. Growth premiums: be deeply suspicious of paying for projected growth.
Signal rules:
- bullish: sound business, strong balance sheet, price offering a genuine margin of safety.
- bearish: weak finances, unstable earnings, or a price that capitalizes hope rather than
  demonstrated results. Overvaluation is a bearish fact.
- neutral: sound enterprise, inadequate margin of safety.
Confidence: 0.9-1.0 clear quantitative case on every criterion; 0.7-0.89 most criteria met;
0.4-0.69 mixed; 0.1-0.39 speculative territory. If the data is insufficient, go neutral."""),
    "lynch": Persona(id="lynch", name="Peter Lynch", instructions="""\
Evaluate the company the way you did at Magellan: know what the business is and why it is
interesting.
Checklist:
1. Categorize it: from growth and margins, is this a fast grower (20%+ earnings growth), a
   stalwart (10-12%), a slow grower, or a turnaround? Expectations depend on the category.
2. The PEG test: compare the P/E to the earnings growth rate visible in the numbers. A P/E well
   below the growth rate is attractive; far above it means paying for a story.
3. The story checks out: revenue growth translating into earnings growth, margins holding or
   improving, EPS rising.
4. Balance sheet: avoid companies loaded with debt.
5. Earnings drive stock prices in the long run: whether earnings keep growing and what is paid
   for that growth is the whole game.
Signal rules:
- bullish: real, visible earnings growth at a P/E that doesn't already price it in (PEG
  comfortably attractive).
- bearish: decelerating growth at a premium multiple, or a hot-story price on cooling numbers.
- neutral: fine company, fully priced; or a category you can't determine from the data.
Confidence: 0.9-1.0 classic setup, growth cheap and visible; 0.7-0.89 good story, fair price;
0.4-0.69 mixed; 0.1-0.39 can't tell what the business is. Plain language."""),
    "druckenmiller": Persona(id="druckenmiller", name="Stanley Druckenmiller", instructions="""\
Evaluate the trajectory of the business right now versus what the price already assumes.
Conviction matters only when the setup is asymmetric.
Read:
1. The inflection: is revenue growth accelerating or decelerating? Are margins inflecting up or
   rolling over? Direction and rate of change matter more than levels.
2. Earnings trajectory: is EPS momentum building or fading?
3. What's priced in: a rich P/E on accelerating numbers can still be attractive; a cheap P/E
   on deteriorating numbers is usually a trap. What does the multiple say the market believes,
   and does the trend disagree?
4. Asymmetry: be confident only when the inflection and the price line up. If the setup is
   merely average, the right call is neutral.
5. Never lose big: deteriorating fundamentals plus leverage is bearish, never neutral.
Signal rules:
- bullish: clear acceleration the price hasn't fully recognized.
- bearish: clear deterioration or rollover, especially at a price still assuming the old
  trajectory.
- neutral: no discernible inflection, or trend and price both fully agree.
Confidence: 0.9-1.0 unmistakable inflection with an asymmetric setup; 0.7-0.89 solid trend
change; 0.4-0.69 mixed or early; 0.1-0.39 no edge. You have no macro or price-action data unless
it is supplied: reason from the fundamentals' trajectory and don't pretend otherwise."""),
}
DEFAULT_PERSONAS: tuple[str, ...] = tuple(PERSONAS)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MetricCitation(_Strict):
    metric: str = Field(min_length=1, max_length=120)
    value: str | float | None = None
    source: str | None = Field(default=None, max_length=200)


class PersonaView(_Strict):
    persona: PersonaId
    signal: Signal
    confidence: float = Field(ge=0, le=1)
    reasoning: str = Field(min_length=1, max_length=4000)
    key_metrics: list[MetricCitation] = Field(default_factory=list, max_length=20)
    risks: list[str] = Field(default_factory=list, max_length=10)
    missing_evidence: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("signal", mode="before")
    @classmethod
    def _fold_signal(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


class CommitteeAnswer(_Strict):
    ticker: str = Field(min_length=1, max_length=20)
    personas: list[PersonaView] = Field(min_length=1, max_length=len(PERSONAS))


class CommitteeSummary(_Strict):
    personas: int
    votes: dict[str, int]
    majority_signal: Signal | Literal["split"]
    agreement: float
    mean_confidence: float
    net_score: float
    rating: Rating
    rating_source: Literal["mapped"] = "mapped"
    rating_rule: str


def parse_personas(raw: str | Sequence[str] | None) -> tuple[str, ...]:
    """Comma list (or sequence) of persona ids, in the given order, each once."""
    if raw is None:
        return DEFAULT_PERSONAS
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    ids = [item.strip().lower() for item in items if item.strip()]
    unknown = sorted({i for i in ids if i not in PERSONAS})
    if unknown:
        raise ValueError(f"Unknown persona(s) {unknown}; choose from {sorted(PERSONAS)}.")
    if not ids:
        raise ValueError("No persona selected.")
    if len(set(ids)) != len(ids):
        raise ValueError("A persona is listed twice.")
    return tuple(ids)


def build_prompt(ticker: str, as_of: str, persona_ids: Sequence[str], context: Mapping[str, Any]) -> str:
    """One committee prompt: shared rules, the context, each persona's instructions, the contract."""
    blocks = "\n\n".join(
        f"### Persona `{pid}` ({PERSONAS[pid].name}, stylized approximation)\n{PERSONAS[pid].instructions}"
        for pid in persona_ids)
    contract = {
        "ticker": ticker,
        "personas": [{
            "persona": pid, "signal": "bullish | neutral | bearish", "confidence": "0.0-1.0",
            "reasoning": "2-4 sentences in this persona's voice, citing the numbers used",
            "key_metrics": [{"metric": "<exact key name from the context>",
                             "value": "<value as given>", "source": "<context section>"}],
            "risks": ["<what would make this view wrong>"],
            "missing_evidence": ["<data this persona needed but did not get>"],
        } for pid in persona_ids],
    }
    return f"""AI Hedge Fund investor-persona committee (research only).

Write an independent view of {ticker} as of {as_of} for each of the {len(persona_ids)} personas
below, in one JSON answer. Each persona applies only its own checklist; do not average the
personas into one view, and let them disagree where their principles disagree.

Shared hard rules for every persona:
- Reason ONLY from the context below. Treat {as_of} as the present day; do not use knowledge of
  anything after it. Do not invent numbers; when a figure is missing, say so in
  missing_evidence and lower the confidence (or go neutral).
- Cite the metrics used in key_metrics with their exact key names and values from the context.
- The context may be one snapshot rather than a history; do not claim trends you cannot see.
- Research only: no orders, position sizes, entry, stop or target prices, contracts, strikes
  or expiries. Signals are research views, not instructions to trade.

Context (JSON):
{json.dumps(dict(context), indent=2, ensure_ascii=False, default=str)}

{blocks}

Output contract: one JSON object only, exactly this shape, with the personas in this order:
{json.dumps(contract, indent=2)}
"""


def validate_answer(payload: Any, ticker: str, persona_ids: Sequence[str]) -> list[PersonaView]:
    """Typed persona views in the requested order; rejects order fields and missing personas."""
    blocked = _order_keys(payload)
    if blocked:
        raise ExternalResearchError(
            f"Committee output has order fields {sorted(blocked)}; research only.")
    try:
        answer = CommitteeAnswer.model_validate(payload)
    except ValidationError as exc:
        raise ExternalResearchError("Committee output does not match CommitteeAnswer.") from exc
    if answer.ticker.strip().casefold() != ticker.casefold():
        raise ExternalResearchError(f"Committee output is for {answer.ticker!r}, not {ticker!r}.")
    seen = [view.persona for view in answer.personas]
    if sorted(seen) != sorted(persona_ids):
        raise ExternalResearchError(
            f"Committee output has personas {seen}, expected each of {list(persona_ids)} once.")
    by_id = {view.persona: view for view in answer.personas}
    return [by_id[pid] for pid in persona_ids]  # type: ignore[index]


def rating_for(net_score: float) -> Rating:
    """Five-tier label of a net score. The hold band (-0.2, 0.2) is wide enough that one
    confident dissenter among five otherwise neutral personas stays hold."""
    net_score = round(net_score, 4)
    for threshold, rating in RATING_THRESHOLDS:
        if net_score >= threshold if threshold > 0 else net_score > threshold:
            return rating
    return "sell"


def summarize(views: Sequence[PersonaView]) -> CommitteeSummary:
    votes = {signal: sum(1 for v in views if v.signal == signal)
             for signal in ("bullish", "neutral", "bearish")}
    top = max(votes.values())
    leaders = [signal for signal, count in votes.items() if count == top]
    net = sum(SIGNAL_SCORE[v.signal] * v.confidence for v in views) / len(views)
    return CommitteeSummary(
        personas=len(views),
        votes=votes,
        majority_signal=leaders[0] if len(leaders) == 1 else "split",  # type: ignore[arg-type]
        agreement=round(top / len(views), 4),
        mean_confidence=round(sum(v.confidence for v in views) / len(views), 4),
        net_score=round(net, 4),
        rating=rating_for(net),
        rating_rule=("net_score = mean(signal x confidence), bullish +1, neutral 0, bearish -1; "
                     "buy >= 0.5, overweight >= 0.2, hold in (-0.2, 0.2), "
                     "underweight <= -0.2, sell <= -0.5. A research label, never an order."),
    )


def _context_keys(value: Any) -> set[str]:
    if isinstance(value, Mapping):
        found = {str(k).casefold() for k in value}
        for item in value.values():
            found |= _context_keys(item)
        return found
    if isinstance(value, list):
        return set().union(*(_context_keys(item) for item in value)) if value else set()
    return set()


def citation_check(views: Sequence[PersonaView], context: Mapping[str, Any]) -> dict[str, dict[str, int]]:
    """Per persona: metrics cited, and how many are key names present in the context."""
    keys = _context_keys(context)
    return {view.persona: {
        "cited": len(view.key_metrics),
        "in_context": sum(1 for m in view.key_metrics
                          if m.metric.strip().casefold().replace(" ", "_") in keys),
    } for view in views}


def run_committee(generator: ResearchGenerator, ticker: str, as_of: str,
                  persona_ids: Sequence[str], context: Mapping[str, Any]) -> list[PersonaView]:
    """Exactly one ``generator.generate`` call for the whole committee."""
    prompt = build_prompt(ticker, as_of, persona_ids, context)
    return validate_answer(generator.generate(PROMPT_NAME, prompt), ticker, persona_ids)


__all__: Sequence[str] = [
    "DEFAULT_PERSONAS",
    "PERSONAS",
    "PROMPT_NAME",
    "UPSTREAM_COMMIT",
    "CommitteeAnswer",
    "CommitteeSummary",
    "MetricCitation",
    "PersonaView",
    "build_prompt",
    "citation_check",
    "parse_personas",
    "rating_for",
    "run_committee",
    "summarize",
    "validate_answer",
]
