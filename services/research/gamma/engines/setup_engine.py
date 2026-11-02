"""Trade setup scoring from research and feature snapshots."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from importlib.resources import files
from typing import Literal
from zoneinfo import ZoneInfo

from gamma.features.fundamental_catalyst_features import (
    FundamentalCatalystFeatureSnapshot,
)
from gamma.features.liquidity_features import LiquidityFeatureSnapshot
from gamma.schemas import (
    CandidateCompany,
    MarketRegime,
    MarketStructureSnapshot,
    OptionFlowSnapshot,
    ResearchBrief,
    TradeSetup,
    VolatilitySnapshot,
    artifact_hash,
)
from gamma.schemas.options import StrategyType

Direction = Literal[
    "bullish",
    "bearish",
    "neutral",
    "vol_expansion",
    "vol_contraction",
]

REJECTION_NO_OPTIONS_LIQUIDITY = "no options liquidity"
REJECTION_FLOW_CONTRADICTS_THESIS = "flow contradicts thesis"
REJECTION_IV_TOO_HIGH = "IV too high for long premium"
REJECTION_STRUCTURE_UNCLEAR = "structure unclear"
REJECTION_MARKET_REGIME_CONFLICT = "market regime conflict"
REJECTION_TOO_CLOSE_TO_EARNINGS = "too close to earnings"
REJECTION_SPREAD_TOO_WIDE = "spread too wide"
REJECTION_STALE_DATA = "stale data"
REJECTION_MISSING_CHAIN = "missing chain"
# Use the locally pinned tzdata distribution, never mutable host timezone data.
with files("tzdata").joinpath("zoneinfo/America/New_York").open("rb") as _zone_file:
    MARKET_TIME_ZONE = ZoneInfo.from_file(_zone_file, key="America/New_York")
DAILY_BAR_AVAILABLE_AFTER = time(16, 15)


SCORE_WEIGHTS = {
    "research_theme_score": 0.25,
    "flow_confirmation": 0.20,
    "amt_breakout_pre_breakout_score": 0.20,
    "volatility_suitability": 0.15,
    "liquidity_score": 0.15,
    "catalyst_timing": 0.03,
    "fundamental_confirmation": 0.02,
}


class SetupEngine:
    """Convert candidate research and confirmations into a trade setup."""

    def __init__(
        self,
        *,
        high_iv_threshold: float = 0.85,
        max_spread_pct: float = 0.20,
        stale_after: timedelta = timedelta(days=2),
        earnings_rejection_window: timedelta = timedelta(days=7),
    ) -> None:
        self._high_iv_threshold = high_iv_threshold
        self._max_spread_pct = max_spread_pct
        self._stale_after = stale_after
        self._earnings_rejection_window = earnings_rejection_window

    def identify_setup(
        self,
        *,
        candidate: CandidateCompany,
        research_brief: ResearchBrief,
        flow_snapshot: OptionFlowSnapshot | None,
        market_structure: MarketStructureSnapshot | None,
        volatility: VolatilitySnapshot | None,
        liquidity: LiquidityFeatureSnapshot | None = None,
        fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None = None,
        market_regime: MarketRegime | None = None,
        as_of: datetime | None = None,
    ) -> TradeSetup:
        """Return an explainable setup, including rejected setups with reasons."""

        ticker = candidate.ticker.upper()
        direction = _direction(flow_snapshot, market_structure, volatility)
        reference_time = _reference_time(
            explicit=as_of,
            flow_snapshot=flow_snapshot,
            market_structure=market_structure,
            volatility=volatility,
        )
        score_components = {
            "research_theme_score": _research_theme_score(candidate, research_brief),
            "flow_confirmation": _flow_score(direction, flow_snapshot),
            "amt_breakout_pre_breakout_score": _market_structure_score(
                market_structure,
            ),
            "volatility_suitability": _volatility_score(direction, volatility),
            "liquidity_score": _liquidity_score(
                candidate,
                liquidity,
                max_spread_pct=self._max_spread_pct,
            ),
            "catalyst_timing": _catalyst_timing_score(
                research_brief,
                fundamental_catalyst,
                reference_time,
                self._earnings_rejection_window,
            ),
            "fundamental_confirmation": _fundamental_score(fundamental_catalyst),
        }
        rejection_reasons = _rejection_reasons(
            direction=direction,
            candidate=candidate,
            flow_snapshot=flow_snapshot,
            market_structure=market_structure,
            volatility=volatility,
            liquidity=liquidity,
            fundamental_catalyst=fundamental_catalyst,
            market_regime=market_regime,
            reference_time=reference_time,
            high_iv_threshold=self._high_iv_threshold,
            max_spread_pct=self._max_spread_pct,
            stale_after=self._stale_after,
            earnings_rejection_window=self._earnings_rejection_window,
        )
        setup_score = _setup_score(score_components, rejection_reasons)
        return TradeSetup(
            setup_id=_setup_id(
                ticker=ticker,
                candidate=candidate,
                research_brief=research_brief,
                flow_snapshot=flow_snapshot,
                market_structure=market_structure,
                volatility=volatility,
                liquidity=liquidity,
                fundamental_catalyst=fundamental_catalyst,
                market_regime=market_regime,
            ),
            ticker=ticker,
            direction=direction,
            thesis=_thesis(candidate, research_brief),
            research_brief=research_brief,
            flow_snapshot=flow_snapshot,
            market_structure=market_structure,
            volatility=volatility,
            setup_score=setup_score,
            score_components=score_components,
            confidence=round(setup_score / 100, 4),
            invalidation=_invalidation(direction, market_structure),
            target_window=_target_window(fundamental_catalyst, reference_time),
            preferred_strategy_types=_preferred_strategy_types(direction, volatility),
            rejection_reasons=rejection_reasons,
        )


def _direction(
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
    volatility: VolatilitySnapshot | None,
) -> Direction:
    flow_direction = _flow_direction(flow_snapshot)
    if flow_direction in {"bullish", "bearish"}:
        return flow_direction
    structure_direction = _structure_direction(market_structure)
    if structure_direction in {"bullish", "bearish"}:
        return structure_direction
    if volatility and volatility.iv_change_label == "expanding":
        return "vol_expansion"
    if volatility and volatility.iv_change_label == "contracting":
        return "vol_contraction"
    return "neutral"


def _flow_direction(flow_snapshot: OptionFlowSnapshot | None) -> Direction:
    if flow_snapshot is None:
        return "neutral"
    call_premium = flow_snapshot.total_call_premium
    put_premium = flow_snapshot.total_put_premium
    if call_premium is None:
        call_premium = sum(
            contract.premium
            for contract in flow_snapshot.notable_contracts
            if contract.right == "call"
        )
    if put_premium is None:
        put_premium = sum(
            contract.premium
            for contract in flow_snapshot.notable_contracts
            if contract.right == "put"
        )
    if call_premium > put_premium * 1.25:
        return "bullish"
    if put_premium > call_premium * 1.25:
        return "bearish"
    return "neutral"


def _structure_direction(
    market_structure: MarketStructureSnapshot | None,
) -> Direction:
    if market_structure is None:
        return "neutral"
    if (
        market_structure.trend_label == "uptrend"
        and market_structure.breakout_status in {"breakout", "pre_breakout", "retest"}
    ):
        return "bullish"
    if market_structure.trend_label == "downtrend":
        return "bearish"
    return "neutral"


def _research_theme_score(
    candidate: CandidateCompany,
    research_brief: ResearchBrief,
) -> float:
    scores = [
        _normalize_score(candidate.discovery_score),
        _normalize_score(research_brief.confidence),
    ]
    if candidate.score_signals and "theme_fit" in candidate.score_signals:
        scores.append(_normalize_score(candidate.score_signals["theme_fit"]))
    candidate_themes = {theme.lower() for theme in candidate.theme_ids}
    brief_themes = {theme.lower() for theme in research_brief.themes}
    if candidate_themes and brief_themes:
        scores.append(1.0 if candidate_themes & brief_themes else 0.25)
    return _rounded_average(scores)


def _flow_score(
    direction: Direction,
    flow_snapshot: OptionFlowSnapshot | None,
) -> float:
    flow_direction = _flow_direction(flow_snapshot)
    if flow_snapshot is None:
        return 0.0
    if direction in {"bullish", "bearish"}:
        if flow_direction == direction:
            return 1.0
        if flow_direction == "neutral":
            return 0.5
        return 0.0
    return 0.7 if flow_snapshot.notable_contracts else 0.3


def _market_structure_score(
    market_structure: MarketStructureSnapshot | None,
) -> float:
    if market_structure is None:
        return 0.0
    score = 0.0
    if market_structure.trend_label in {"uptrend", "downtrend"}:
        score += 0.35
    elif market_structure.trend_label == "range":
        score += 0.15
    if market_structure.breakout_status == "breakout":
        score += 0.35
    elif market_structure.breakout_status in {"pre_breakout", "retest"}:
        score += 0.25
    if market_structure.vwap_relation in {"above_vwap", "below_vwap"}:
        score += 0.15
    if market_structure.value_area_relation != "unknown":
        score += 0.10
    if market_structure.relative_volume and market_structure.relative_volume >= 1.2:
        score += 0.05
    return round(min(score, 1.0), 4)


def _volatility_score(
    direction: Direction,
    volatility: VolatilitySnapshot | None,
) -> float:
    if volatility is None:
        return 0.0
    iv_rank = _volatility_rank(volatility)
    score = 0.55 if iv_rank is None else max(0.0, 1.0 - iv_rank)
    if volatility.term_structure_label != "unknown":
        score += 0.15
    if direction == "bullish" and volatility.skew_label in {"call_skew", "balanced"}:
        score += 0.15
    elif direction == "bearish" and volatility.skew_label in {"put_skew", "balanced"}:
        score += 0.15
    elif direction in {"vol_expansion", "vol_contraction"}:
        score += 0.15
    if volatility.iv_change_label in {"stable", "expanding"}:
        score += 0.15
    return round(min(score, 1.0), 4)


def _liquidity_score(
    candidate: CandidateCompany,
    liquidity: LiquidityFeatureSnapshot | None,
    *,
    max_spread_pct: float,
) -> float:
    if liquidity is not None:
        if liquidity.option_contract_count == 0:
            return 0.0
        viable_score = min(liquidity.minimum_viable_contract_count / 3, 1.0)
        volume_score = min(liquidity.option_total_volume / 1_000, 1.0)
        oi_score = min(liquidity.option_total_open_interest / 5_000, 1.0)
        if liquidity.median_bid_ask_spread_pct is None:
            spread_score = 0.5
        else:
            spread_score = max(
                0.0,
                1.0 - liquidity.median_bid_ask_spread_pct / max_spread_pct,
            )
        return _rounded_average([viable_score, volume_score, oi_score, spread_score])

    scores: list[float] = []
    if candidate.liquidity_score is not None:
        scores.append(_normalize_score(candidate.liquidity_score))
    if candidate.options_available is not None:
        scores.append(1.0 if candidate.options_available else 0.0)
    if candidate.options_volume is not None:
        scores.append(min(candidate.options_volume / 1_000, 1.0))
    if candidate.options_open_interest is not None:
        scores.append(min(candidate.options_open_interest / 5_000, 1.0))
    return _rounded_average(scores) if scores else 0.0


def _catalyst_timing_score(
    research_brief: ResearchBrief,
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
    reference_time: datetime | None,
    earnings_rejection_window: timedelta,
) -> float:
    if _earnings_too_close(
        fundamental_catalyst,
        reference_time,
        earnings_rejection_window,
    ):
        return 0.2
    if research_brief.key_catalysts:
        return 0.8
    if fundamental_catalyst and fundamental_catalyst.earnings_dates:
        return 0.6
    return 0.5


def _fundamental_score(
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
) -> float:
    if fundamental_catalyst is None:
        return 0.5
    signals = [
        bool(fundamental_catalyst.financial_metric_changes),
        bool(fundamental_catalyst.earnings_surprise_flags),
        bool(fundamental_catalyst.filing_sections),
        bool(fundamental_catalyst.insider_trade_summary),
        bool(fundamental_catalyst.institutional_holding_summary),
        bool(fundamental_catalyst.index_fund_exposure),
    ]
    return round(sum(signals) / len(signals), 4)


def _rejection_reasons(
    *,
    direction: Direction,
    candidate: CandidateCompany,
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
    volatility: VolatilitySnapshot | None,
    liquidity: LiquidityFeatureSnapshot | None,
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
    market_regime: MarketRegime | None,
    reference_time: datetime | None,
    high_iv_threshold: float,
    max_spread_pct: float,
    stale_after: timedelta,
    earnings_rejection_window: timedelta,
) -> list[str]:
    reasons: list[str] = []
    if _missing_chain(flow_snapshot, liquidity):
        reasons.append(REJECTION_MISSING_CHAIN)
    if _no_options_liquidity(candidate, liquidity):
        reasons.append(REJECTION_NO_OPTIONS_LIQUIDITY)
    if _flow_contradicts_thesis(direction, flow_snapshot, market_structure):
        reasons.append(REJECTION_FLOW_CONTRADICTS_THESIS)
    if _iv_too_high(direction, volatility, high_iv_threshold):
        reasons.append(REJECTION_IV_TOO_HIGH)
    if _structure_unclear(market_structure):
        reasons.append(REJECTION_STRUCTURE_UNCLEAR)
    if _market_regime_conflict(direction, market_regime):
        reasons.append(REJECTION_MARKET_REGIME_CONFLICT)
    if _earnings_too_close(
        fundamental_catalyst,
        reference_time,
        earnings_rejection_window,
    ):
        reasons.append(REJECTION_TOO_CLOSE_TO_EARNINGS)
    if _spread_too_wide(liquidity, max_spread_pct):
        reasons.append(REJECTION_SPREAD_TOO_WIDE)
    if _has_stale_data(
        reference_time=reference_time,
        stale_after=stale_after,
        flow_snapshot=flow_snapshot,
        market_structure=market_structure,
        volatility=volatility,
    ):
        reasons.append(REJECTION_STALE_DATA)
    return reasons


def _missing_chain(
    flow_snapshot: OptionFlowSnapshot | None,
    liquidity: LiquidityFeatureSnapshot | None,
) -> bool:
    return flow_snapshot is None and (
        liquidity is None or liquidity.option_contract_count == 0
    )


def _no_options_liquidity(
    candidate: CandidateCompany,
    liquidity: LiquidityFeatureSnapshot | None,
) -> bool:
    if candidate.options_available is False:
        return True
    if liquidity is not None:
        return (
            liquidity.option_contract_count == 0
            or liquidity.minimum_viable_contract_count == 0
            or liquidity.option_total_volume == 0
            or liquidity.option_total_open_interest == 0
        )
    if candidate.options_volume == 0 or candidate.options_open_interest == 0:
        return True
    return False


def _flow_contradicts_thesis(
    direction: Direction,
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
) -> bool:
    flow_direction = _flow_direction(flow_snapshot)
    structure_direction = _structure_direction(market_structure)
    if flow_direction not in {"bullish", "bearish"}:
        return False
    if structure_direction in {"bullish", "bearish"}:
        return flow_direction != structure_direction
    return direction in {"bullish", "bearish"} and flow_direction != direction


def _iv_too_high(
    direction: Direction,
    volatility: VolatilitySnapshot | None,
    high_iv_threshold: float,
) -> bool:
    if direction not in {"bullish", "bearish"} or volatility is None:
        return False
    iv_rank = _volatility_rank(volatility)
    return iv_rank is not None and iv_rank >= high_iv_threshold


def _structure_unclear(
    market_structure: MarketStructureSnapshot | None,
) -> bool:
    if market_structure is None:
        return True
    return market_structure.trend_label in {"unknown", "transition"} or (
        market_structure.trend_label == "range"
        and market_structure.breakout_status in {"none", "failed_breakout"}
    )


def _market_regime_conflict(
    direction: Direction,
    market_regime: MarketRegime | None,
) -> bool:
    if market_regime is None:
        return False
    label = market_regime.regime_label.lower()
    bearish_regime = any(
        token in label for token in ("bear", "risk_off", "recession", "crash")
    )
    bullish_regime = any(
        token in label for token in ("bull", "risk_on", "expansion", "growth")
    )
    return (direction == "bullish" and bearish_regime) or (
        direction == "bearish" and bullish_regime
    )


def _earnings_too_close(
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
    reference_time: datetime | None,
    earnings_rejection_window: timedelta,
) -> bool:
    if fundamental_catalyst is None or reference_time is None:
        return False
    reference_date = reference_time.date()
    for earnings_date in fundamental_catalyst.earnings_dates:
        parsed = _parse_date(earnings_date)
        if parsed is None:
            continue
        days_until = (parsed - reference_date).days
        if 0 <= days_until <= earnings_rejection_window.days:
            return True
    return False


def _spread_too_wide(
    liquidity: LiquidityFeatureSnapshot | None,
    max_spread_pct: float,
) -> bool:
    return (
        liquidity is not None
        and liquidity.median_bid_ask_spread_pct is not None
        and liquidity.median_bid_ask_spread_pct > max_spread_pct
    )


def _has_stale_data(
    *,
    reference_time: datetime | None,
    stale_after: timedelta,
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
    volatility: VolatilitySnapshot | None,
) -> bool:
    if reference_time is None:
        return False
    reference_time = _coerce_datetime(reference_time)
    return any(
        (
            _is_snapshot_stale(
                reference_time=reference_time,
                snapshot_time=_coerce_datetime(flow_snapshot.as_of),
                stale_after=stale_after,
                allow_last_session_grace=False,
            )
            if flow_snapshot is not None
            else False,
            _is_snapshot_stale(
                reference_time=reference_time,
                snapshot_time=_coerce_datetime(market_structure.as_of),
                stale_after=stale_after,
                allow_last_session_grace=_is_daily_market_structure(market_structure),
            )
            if market_structure is not None
            else False,
            _is_snapshot_stale(
                reference_time=reference_time,
                snapshot_time=_coerce_datetime(volatility.as_of),
                stale_after=stale_after,
                allow_last_session_grace=False,
            )
            if volatility is not None
            else False,
        )
    )


def _is_snapshot_stale(
    *,
    reference_time: datetime,
    snapshot_time: datetime,
    stale_after: timedelta,
    allow_last_session_grace: bool,
) -> bool:
    if reference_time - snapshot_time <= stale_after:
        return False
    if allow_last_session_grace and _is_latest_daily_session(
        snapshot_time.date(),
        reference_time,
    ):
        return False
    return True


def _is_daily_market_structure(
    market_structure: MarketStructureSnapshot | None,
) -> bool:
    if market_structure is None:
        return False
    return market_structure.timeframe.lower() in {"1d", "1day", "day", "daily"}


def _is_latest_daily_session(
    snapshot_date: date,
    reference_time: datetime,
) -> bool:
    latest_session = _latest_complete_trading_session(reference_time)
    return snapshot_date >= latest_session


def _latest_complete_trading_session(reference_time: datetime) -> date:
    local_reference = reference_time.astimezone(MARKET_TIME_ZONE)
    reference_date = local_reference.date()
    if (
        _is_trading_day(reference_date)
        and local_reference.time() >= DAILY_BAR_AVAILABLE_AFTER
    ):
        return reference_date
    current = reference_date - timedelta(days=1)
    while not _is_trading_day(current):
        current -= timedelta(days=1)
    return current


def _is_trading_day(day: date) -> bool:
    return day.weekday() < 5 and day not in _market_holidays(day.year)


def _market_holidays(year: int) -> set[date]:
    holidays: set[date] = set()
    for holiday_year in (year - 1, year, year + 1):
        holidays.update(
            {
                _observed_date(date(holiday_year, 1, 1)),
                _nth_weekday(holiday_year, 1, 0, 3),
                _nth_weekday(holiday_year, 2, 0, 3),
                _easter_date(holiday_year) - timedelta(days=2),
                _last_weekday(holiday_year, 5, 0),
                _observed_date(date(holiday_year, 6, 19)),
                _observed_date(date(holiday_year, 7, 4)),
                _nth_weekday(holiday_year, 9, 0, 1),
                _nth_weekday(holiday_year, 11, 3, 4),
                _observed_date(date(holiday_year, 12, 25)),
            }
        )
    return holidays


def _observed_date(day: date) -> date:
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    day = date(year, month, 1)
    while day.weekday() != weekday:
        day += timedelta(days=1)
    return day + timedelta(days=7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> date:
    day = date(year, month + 1, 1) - timedelta(days=1)
    while day.weekday() != weekday:
        day -= timedelta(days=1)
    return day


def _easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l_value = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_value) // 451
    month = (h + l_value - 7 * m + 114) // 31
    day = ((h + l_value - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _setup_score(
    score_components: dict[str, float],
    rejection_reasons: list[str],
) -> float:
    weighted = sum(
        score_components[component] * weight
        for component, weight in SCORE_WEIGHTS.items()
    )
    score = round(weighted * 100, 2)
    return min(score, 49.0) if rejection_reasons else score


def _setup_id(
    *,
    ticker: str,
    candidate: CandidateCompany,
    research_brief: ResearchBrief,
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
    volatility: VolatilitySnapshot | None,
    liquidity: LiquidityFeatureSnapshot | None,
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
    market_regime: MarketRegime | None,
) -> str:
    payload = {
        "candidate": candidate.to_json_dict(),
        "research_brief": research_brief.to_json_dict(),
        "flow_snapshot": flow_snapshot.to_json_dict() if flow_snapshot else None,
        "market_structure": market_structure.to_json_dict()
        if market_structure
        else None,
        "volatility": volatility.to_json_dict() if volatility else None,
        "liquidity": liquidity.to_json_dict() if liquidity else None,
        "fundamental_catalyst": fundamental_catalyst.to_json_dict()
        if fundamental_catalyst
        else None,
        "market_regime": market_regime.to_json_dict() if market_regime else None,
    }
    return f"setup-{ticker.lower()}-{artifact_hash(payload)[:12]}"


def _thesis(
    candidate: CandidateCompany,
    research_brief: ResearchBrief,
) -> str:
    catalyst = (
        f" Key catalyst: {research_brief.key_catalysts[0]}."
        if research_brief.key_catalysts
        else ""
    )
    return f"{candidate.why_it_fits} Bull case: {research_brief.bull_case}.{catalyst}"


def _invalidation(
    direction: Direction,
    market_structure: MarketStructureSnapshot | None,
) -> str:
    if market_structure is None:
        return "Setup invalidated if required market structure confirmation is missing."
    if direction == "bullish" and market_structure.support_levels:
        return f"Daily close below {max(market_structure.support_levels):.2f} support."
    if direction == "bearish" and market_structure.resistance_levels:
        return (
            f"Daily close above {min(market_structure.resistance_levels):.2f} "
            "resistance."
        )
    return "Setup invalidated if flow, structure, or volatility confirmation fails."


def _target_window(
    fundamental_catalyst: FundamentalCatalystFeatureSnapshot | None,
    reference_time: datetime | None,
) -> str:
    if fundamental_catalyst is None or reference_time is None:
        return "2-6 weeks"
    future_dates = [
        parsed
        for earnings_date in fundamental_catalyst.earnings_dates
        if (parsed := _parse_date(earnings_date)) is not None
        and parsed >= reference_time.date()
    ]
    if not future_dates:
        return "2-6 weeks"
    days_until = min(
        (earnings_date - reference_time.date()).days
        for earnings_date in future_dates
    )
    return f"{days_until} days to next earnings catalyst"


def _preferred_strategy_types(
    direction: Direction,
    volatility: VolatilitySnapshot | None,
) -> list[StrategyType]:
    iv_rank = _volatility_rank(volatility)
    high_iv = iv_rank is not None and iv_rank >= 0.60
    if direction == "bullish":
        return ["call_debit_spread"] if high_iv else ["long_call", "call_debit_spread"]
    if direction == "bearish":
        return ["put_debit_spread"] if high_iv else ["long_put", "put_debit_spread"]
    if direction == "vol_expansion":
        return ["straddle", "strangle"]
    if direction == "vol_contraction":
        return ["iron_condor", "calendar"]
    return ["calendar", "iron_condor"]


def _reference_time(
    *,
    explicit: datetime | None,
    flow_snapshot: OptionFlowSnapshot | None,
    market_structure: MarketStructureSnapshot | None,
    volatility: VolatilitySnapshot | None,
) -> datetime | None:
    if explicit is not None:
        return _coerce_datetime(explicit)
    timestamps = [
        _coerce_datetime(snapshot.as_of)
        for snapshot in (flow_snapshot, market_structure, volatility)
        if snapshot is not None
    ]
    return max(timestamps) if timestamps else None


def _volatility_rank(volatility: VolatilitySnapshot | None) -> float | None:
    if volatility is None:
        return None
    value = (
        volatility.iv_rank
        if volatility.iv_rank is not None
        else volatility.iv_percentile
    )
    return _normalize_score(value) if value is not None else None


def _normalize_score(value: float) -> float:
    normalized = float(value)
    if normalized > 1.0:
        normalized = normalized / 100
    return max(0.0, min(normalized, 1.0))


def _rounded_average(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 4)


def _coerce_datetime(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


__all__ = [
    "REJECTION_FLOW_CONTRADICTS_THESIS",
    "REJECTION_IV_TOO_HIGH",
    "REJECTION_MARKET_REGIME_CONFLICT",
    "REJECTION_MISSING_CHAIN",
    "REJECTION_NO_OPTIONS_LIQUIDITY",
    "REJECTION_SPREAD_TOO_WIDE",
    "REJECTION_STALE_DATA",
    "REJECTION_STRUCTURE_UNCLEAR",
    "REJECTION_TOO_CLOSE_TO_EARNINGS",
    "SCORE_WEIGHTS",
    "SetupEngine",
]
