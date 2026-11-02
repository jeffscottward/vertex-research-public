"""Completed-bar swing/momentum plus native session-study research.

Gamma breakout/volume/gap/relative-strength ideas are adapted to exact decimal
inputs, complete lookbacks and matched timestamps. Session/reel/dual-zone guards
are new implementations of report requirements, not copies of rights-blocked
Vertex Quant or Optical code. A research stop is not a protective broker order.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR

from .core import (ONE, ZERO, ResearchDecision, count, deterministic, digest_text,
                   fraction, identity, instant, ratio, require_decimal)


@dataclass(frozen=True)
class Bar:
    instrument_id: str
    start_at: datetime
    end_at: datetime
    available_at: datetime
    session_id: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal | None
    complete: bool
    source_id: str
    adjustment_basis: str

    def __post_init__(self):
        for value in (self.instrument_id, self.session_id, self.source_id, self.adjustment_basis):
            identity(value)
        for value in (self.start_at, self.end_at, self.available_at):
            instant(value)
        if not self.start_at < self.end_at <= self.available_at:
            raise ValueError("Bar start/end/availability ordering invalid")
        if type(self.complete) is not bool:
            raise ValueError("Explicit completed-bar flag required")
        for value in (self.open, self.high, self.low, self.close):
            require_decimal(value, positive=True)
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close) or self.low > self.high:
            raise ValueError("Inconsistent OHLC")
        if self.volume is not None:
            require_decimal(self.volume, nonnegative=True)


def completed_bars(bars: tuple[Bar, ...], *, as_of: datetime, instrument_id: str) -> tuple[Bar, ...]:
    instant(as_of)
    identity(instrument_id)
    selected = []
    seen = set()
    basis = set()
    for bar in bars:
        if bar.instrument_id != instrument_id:
            raise ValueError("Mixed-instrument bars")
        if bar.end_at in seen:
            raise ValueError("Duplicate bar interval")
        seen.add(bar.end_at)
        if bar.complete and bar.end_at <= as_of and bar.available_at <= as_of:
            selected.append(bar)
            basis.add(bar.adjustment_basis)
    if len(basis) > 1:
        raise ValueError("Mixed price adjustment basis")
    selected.sort(key=lambda bar: bar.end_at)
    if any(left.end_at > right.start_at for left, right in zip(selected, selected[1:])):
        raise ValueError("Overlapping completed bars")
    return tuple(selected)


@dataclass(frozen=True)
class MomentumSnapshot:
    instrument_id: str
    as_of: datetime
    bar_end_at: datetime | None
    completed_count: int
    features: tuple[tuple[str, Decimal | None], ...]
    missing: tuple[str, ...]
    source_ids: tuple[str, ...]

    def feature(self, key: str) -> Decimal | None:
        return dict(self.features).get(key)


@deterministic
def momentum(bars: tuple[Bar, ...], *, instrument_id: str, as_of: datetime,
             benchmark_bars: tuple[Bar, ...] = (), benchmark_id: str | None = None) -> MomentumSnapshot:
    rows = completed_bars(bars, as_of=as_of, instrument_id=instrument_id)
    names = ("close", "sma20", "sma50", "momentum20", "momentum50", "relative-strength20",
             "breakout20", "breakout50", "relative-volume", "gap-and-hold", "atr14", "atr-fraction",
             "support20", "resistance20", "trend-acceleration")
    values = dict.fromkeys(names)
    missing = []
    if not rows:
        return MomentumSnapshot(instrument_id, as_of, None, 0, tuple(values.items()),
                                ("completed-bars-unavailable",), ())
    latest = rows[-1]
    values["close"] = latest.close
    if len(rows) >= 20:
        values["sma20"] = ratio(sum((row.close for row in rows[-20:]), ZERO), Decimal(20))
    if len(rows) >= 50:
        values["sma50"] = ratio(sum((row.close for row in rows[-50:]), ZERO), Decimal(50))
    for window in (20, 50):
        if len(rows) >= window + 1:
            values[f"momentum{window}"] = ratio(latest.close - rows[-window - 1].close, rows[-window - 1].close)
            prior_high = max(row.high for row in rows[-window - 1:-1])
            values[f"breakout{window}"] = ONE if latest.close > prior_high else ZERO
        else:
            missing.append(f"requires-{window + 1}-completed-bars")
    if values["momentum20"] is not None and values["momentum50"] is not None:
        values["trend-acceleration"] = values["momentum20"] - values["momentum50"]
    if len(rows) >= 21:
        prior = rows[-21:-1]
        values["support20"] = min(row.low for row in prior)
        values["resistance20"] = max(row.high for row in prior)
        if latest.volume is not None and all(row.volume is not None for row in prior):
            total = sum((row.volume for row in prior), ZERO)
            if total > ZERO:
                values["relative-volume"] = ratio(latest.volume * 20, total)
        if values["relative-volume"] is None:
            missing.append("volume-unavailable-or-zero-baseline")
    if len(rows) >= 2:
        values["gap-and-hold"] = ONE if latest.open > rows[-2].close * Decimal("1.02") and latest.close >= latest.open else ZERO
    if len(rows) >= 15:
        true_ranges = [max(row.high - row.low, abs(row.high - previous.close), abs(row.low - previous.close))
                       for previous, row in zip(rows[-15:-1], rows[-14:])]
        values["atr14"] = ratio(sum(true_ranges, ZERO), Decimal(14))
        values["atr-fraction"] = ratio(values["atr14"], latest.close)
    if benchmark_id is not None and len(rows) >= 21:
        benchmark = {row.end_at: row for row in completed_bars(benchmark_bars, as_of=as_of, instrument_id=benchmark_id)}
        window = rows[-21:]
        if all(row.end_at in benchmark for row in window):
            first, last = benchmark[window[0].end_at], benchmark[window[-1].end_at]
            values["relative-strength20"] = values["momentum20"] - ratio(last.close - first.close, first.close)
        else:
            missing.append("benchmark-date-alignment-incomplete")
    if values["relative-strength20"] is None:
        missing.append("relative-strength-unavailable")
    return MomentumSnapshot(instrument_id, as_of, latest.end_at, len(rows), tuple(values.items()),
                            tuple(missing), tuple(sorted({row.source_id for row in rows})))


@dataclass(frozen=True)
class RegimeObservation:
    regime: str
    available_at: datetime
    observed_at: datetime
    source_id: str
    complete: bool

    def __post_init__(self):
        identity(self.regime)
        identity(self.source_id)
        instant(self.available_at)
        instant(self.observed_at)
        if self.available_at < self.observed_at or type(self.complete) is not bool:
            raise ValueError("Invalid regime provenance")


@dataclass(frozen=True)
class SwingPolicy:
    allowed_regimes: tuple[str, ...]
    maximum_age_seconds: int
    minimum_relative_strength: Decimal
    minimum_relative_volume: Decimal
    maximum_atr_fraction: Decimal
    stop_atr_multiple: Decimal
    target_risk_multiple: Decimal
    tick_size: Decimal

    def __post_init__(self):
        if not self.allowed_regimes:
            raise ValueError("Explicit permitted regimes required")
        count(self.maximum_age_seconds)
        require_decimal(self.minimum_relative_strength)
        require_decimal(self.minimum_relative_volume, positive=True)
        fraction(self.maximum_atr_fraction)
        for value in (self.stop_atr_multiple, self.target_risk_multiple, self.tick_size):
            require_decimal(value, positive=True)


@dataclass(frozen=True)
class ProtectionLevels:
    reference: Decimal
    stop_review: Decimal
    target_review: Decimal
    active_order: bool = False


@deterministic
def protection_levels(reference: Decimal, atr: Decimal, policy: SwingPolicy) -> ProtectionLevels:
    require_decimal(reference, positive=True)
    require_decimal(atr, positive=True)
    raw_stop = reference - policy.stop_atr_multiple * atr
    stop = (raw_stop / policy.tick_size).to_integral_value(rounding=ROUND_FLOOR) * policy.tick_size
    if stop <= ZERO or stop >= reference:
        raise ValueError("Protection outside positive-price range")
    target = reference + (reference - stop) * policy.target_risk_multiple
    target = (target / policy.tick_size).to_integral_value(rounding=ROUND_CEILING) * policy.tick_size
    return ProtectionLevels(reference, stop, target)


@deterministic
def swing_decision(snapshot: MomentumSnapshot, regime: RegimeObservation | None, *,
                   as_of: datetime, policy: SwingPolicy,
                   held_protection: ProtectionLevels | None = None) -> ResearchDecision:
    instant(as_of)
    if snapshot.as_of > as_of or snapshot.bar_end_at is None or snapshot.bar_end_at > as_of:
        return ResearchDecision("unavailable", ("completed-bar-not-known-at-decision",))
    if (as_of - snapshot.bar_end_at).total_seconds() > policy.maximum_age_seconds:
        return ResearchDecision("unavailable", ("completed-bar-stale",))
    values = dict(snapshot.features)
    close = values.get("close")
    if close is None:
        return ResearchDecision("unavailable", ("close-unavailable",))
    if held_protection is not None:
        if close <= held_protection.stop_review:
            return ResearchDecision("exit", ("completed-close-below-stop-review", "not-a-confirmed-stop-fill"))
        if close >= held_protection.target_review:
            return ResearchDecision("exit", ("completed-close-above-target-review", "not-a-confirmed-target-fill"))
    if regime is None or not regime.complete or regime.available_at > as_of or regime.observed_at > as_of:
        return ResearchDecision("unavailable", ("regime-unavailable",))
    if (as_of - regime.observed_at).total_seconds() > policy.maximum_age_seconds:
        return ResearchDecision("unavailable", ("regime-stale",))
    if regime.regime not in policy.allowed_regimes:
        return ResearchDecision("exit" if held_protection else "hold", ("regime-not-permitted",))
    required = ("sma20", "sma50", "relative-strength20", "relative-volume", "atr-fraction", "atr14", "breakout20")
    absent = tuple(key for key in required if values.get(key) is None)
    if absent:
        return ResearchDecision("unavailable", ("required-feature-unavailable", *absent))
    if held_protection:
        return ResearchDecision("exit" if close < values["sma20"] else "hold", ("completed-bar-trend-review",))
    blockers = []
    if not close > values["sma20"] > values["sma50"]:
        blockers.append("trend-not-confirmed")
    if values["breakout20"] != ONE:
        blockers.append("breakout-not-confirmed")
    if values["relative-strength20"] < policy.minimum_relative_strength:
        blockers.append("relative-strength-below-policy")
    if values["relative-volume"] < policy.minimum_relative_volume:
        blockers.append("volume-not-confirmed")
    if values["atr-fraction"] > policy.maximum_atr_fraction or values["atr14"] <= ZERO:
        blockers.append("volatility-outside-policy")
    if blockers:
        return ResearchDecision("hold", tuple(blockers))
    try:
        protection = protection_levels(close, values["atr14"], policy)
    except ValueError:
        return ResearchDecision("unavailable", ("positive-tick-aligned-protection-unavailable",))
    return ResearchDecision("proposal", ("completed-bar-breakout", "next-permitted-bar-only", "protection-is-research-not-an-order"),
                            (("reference", close), ("stop-review", protection.stop_review),
                             ("target-review", protection.target_review)), snapshot.source_ids)


@dataclass(frozen=True)
class SessionWindow:
    session_id: str
    calendar_id: str
    open_at: datetime
    opening_range_end_at: datetime
    entry_cutoff_at: datetime
    close_at: datetime
    bar_seconds: int

    def __post_init__(self):
        identity(self.session_id)
        identity(self.calendar_id)
        for value in (self.open_at, self.opening_range_end_at, self.entry_cutoff_at, self.close_at):
            instant(value)
        if not self.open_at < self.opening_range_end_at < self.entry_cutoff_at <= self.close_at:
            raise ValueError("Explicit calendar session ordering invalid")
        count(self.bar_seconds, positive=True)
        if (self.opening_range_end_at - self.open_at).total_seconds() % self.bar_seconds:
            raise ValueError("Opening range must contain whole bars")


@dataclass(frozen=True)
class SessionStudyEvidence:
    protocol_version: str
    exact_contract_id: str
    source_receipts: tuple[str, ...]
    implementation_digest: str
    continuous_contract: bool
    historical_contamination: bool

    def __post_init__(self):
        identity(self.protocol_version)
        identity(self.exact_contract_id)
        digest_text(self.implementation_digest)
        for value in self.source_receipts:
            digest_text(value)
        if type(self.continuous_contract) is not bool or type(self.historical_contamination) is not bool:
            raise ValueError("Explicit study caveats required")


@deterministic
def session_breakout(bars: tuple[Bar, ...], *, session: SessionWindow,
                     evidence: SessionStudyEvidence, as_of: datetime,
                     minimum_relative_volume: Decimal) -> ResearchDecision:
    instant(as_of)
    require_decimal(minimum_relative_volume, positive=True)
    if not evidence.source_receipts or evidence.continuous_contract:
        return ResearchDecision("unavailable", ("exact-contract-and-source-receipts-required",))
    if as_of < session.opening_range_end_at or as_of >= session.entry_cutoff_at:
        return ResearchDecision("hold", ("outside-session-entry-window",))
    rows = completed_bars(bars, as_of=as_of, instrument_id=evidence.exact_contract_id)
    scoped = tuple(row for row in rows if row.session_id == session.session_id and
                   session.open_at <= row.start_at and row.end_at <= session.close_at)
    opening = tuple(row for row in scoped if row.end_at <= session.opening_range_end_at)
    expected = int((session.opening_range_end_at - session.open_at).total_seconds()) // session.bar_seconds
    if len(opening) != expected or any(row.start_at != session.open_at + timedelta(seconds=i * session.bar_seconds)
                                      or row.end_at != row.start_at + timedelta(seconds=session.bar_seconds)
                                      for i, row in enumerate(opening)):
        return ResearchDecision("unavailable", ("opening-range-has-missing-or-irregular-bars",))
    post = tuple(row for row in scoped if row.start_at >= session.opening_range_end_at)
    if not post:
        return ResearchDecision("hold", ("no-completed-post-range-bar",))
    if any(row.start_at != session.opening_range_end_at + timedelta(seconds=i * session.bar_seconds)
           or row.end_at != row.start_at + timedelta(seconds=session.bar_seconds)
           for i, row in enumerate(post)):
        return ResearchDecision("unavailable", ("post-range-bars-not-contiguous",))
    latest = post[-1]
    if (as_of - latest.end_at).total_seconds() > session.bar_seconds:
        return ResearchDecision("unavailable", ("latest-session-bar-stale",))
    if latest.volume is None or any(row.volume is None for row in opening):
        return ResearchDecision("unavailable", ("session-volume-unavailable",))
    baseline = sum((row.volume for row in opening), ZERO)
    if baseline <= ZERO:
        return ResearchDecision("unavailable", ("session-volume-baseline-zero",))
    high, low = max(row.high for row in opening), min(row.low for row in opening)
    volume = ratio(latest.volume * len(opening), baseline)
    if latest.close <= high or volume < minimum_relative_volume:
        return ResearchDecision("hold", ("opening-range-continuation-not-confirmed",))
    caveats = ("descriptive-contaminated-study",) if evidence.historical_contamination else ("unqualified-forward-research",)
    return ResearchDecision("proposal", ("session-range-breakout", *caveats, "not-paper-or-live-approval"),
                            (("range-high", high), ("range-low", low), ("relative-volume", volume)),
                            evidence.source_receipts)


@dataclass(frozen=True)
class SessionLowSource:
    """Caller-supplied receipt binding for all bars bearing this source ID.

    OHLC is currency per one instrument unit; no FX or adjustment conversion is
    inferred. The receipt must identify the supplied bar content and its units,
    not merely a provider name. Receipt possession does not grant data rights.
    """

    source_id: str
    instrument_id: str
    currency: str
    adjustment_basis: str
    content_digest: str

    def __post_init__(self):
        for value in (self.source_id, self.instrument_id, self.adjustment_basis):
            identity(value)
        if not isinstance(self.currency, str) or len(self.currency) != 3 or any(
                character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" for character in self.currency):
            raise ValueError("Explicit three-letter quote currency required")
        digest_text(self.content_digest)


@dataclass(frozen=True)
class RegularSessionEvidence:
    """Supplied calendar-source evidence, not a quote's market-open flag.

    The caller is responsible for resolving an authoritative calendar receipt
    for this exact regular-session window, including closures/early closes.
    No calendar authority, provider entitlement or source rights are inferred.
    """

    session: SessionWindow
    source_id: str
    content_digest: str
    observed_at: datetime
    available_at: datetime
    session_kind: str

    def __post_init__(self):
        if not isinstance(self.session, SessionWindow):
            raise ValueError("Exact calendar session window required")
        identity(self.source_id)
        digest_text(self.content_digest)
        identity(self.session_kind)
        if instant(self.available_at) < instant(self.observed_at):
            raise ValueError("Calendar evidence availability precedes observation")


@deterministic
def near_session_low_review(
        bars: tuple[Bar, ...], *, session: SessionWindow | None,
        evidence: SessionStudyEvidence | None,
        regular_session: RegularSessionEvidence | None,
        sources: tuple[SessionLowSource, ...], as_of: datetime,
        maximum_age_seconds: int, maximum_percent_above_low: Decimal,
        maximum_range_position: Decimal) -> ResearchDecision:
    """Independent ASTS report-requirement arithmetic; no ASTS code copied.

    This is a completed-bar session-to-date adaptation, NOT a live tick/day-range
    snapshot or a profitable-entry claim. Unknown original code/provider rights
    remain excluded. All inputs, calendar provenance and freshness are supplied;
    there is no clock, acquisition, notification, cooldown or execution boundary.

    P is the last completed close, L/H the completed-session low/high. Percentage
    above low is 100*(P-L)/L in percentage points; range position is (P-L)/(H-L)
    as a fraction. Inclusive thresholds must lie in [0,100] and [0,1]. A flat
    H=L=P has range position zero. Qualification compares before ratio rounding.
    Freshness measures cutoff minus bar END, not fetch/availability time, and
    must be explicitly bounded to 0..86400 seconds. At most 100000 bars and 4096
    source bindings are accepted; no supplied future/incomplete bars are dropped.

    Every source binding must match the exact study contract and common currency
    and adjustment basis. Calendar and bar content digests must occur in study
    receipts. These are supplied provenance assertions, not verified permissions.
    The caller must verify original references, current data rights and calendar
    authority before authoritative consumption. This pure helper does not do
    that verification or establish the real current market session. Review/hold
    is only a source-supplied advisory candidate, never evidence acceptance.
    """
    labels = ("completed-bar-session-to-date-adaptation", "not-live-snapshot-parity",
              "not-a-profitable-entry-claim", "source-supplied-advisory",
              "provenance-not-verified-here")
    try:
        cutoff = instant(as_of)
        count(maximum_age_seconds)
        require_decimal(maximum_percent_above_low, nonnegative=True)
        fraction(maximum_range_position)
        if maximum_age_seconds > 86_400 or maximum_percent_above_low > Decimal(100):
            raise ValueError("Session-low policy outside bounded domain")
    except (TypeError, ValueError):
        return ResearchDecision("unavailable", ("invalid-session-low-policy-or-cutoff", *labels))
    if (not isinstance(session, SessionWindow) or
            not isinstance(evidence, SessionStudyEvidence) or
            not isinstance(regular_session, RegularSessionEvidence)):
        return ResearchDecision("unavailable", ("regular-session-and-study-evidence-required", *labels))
    if (type(evidence.source_receipts) is not tuple or not evidence.source_receipts or
            len(evidence.source_receipts) > 4097 or evidence.continuous_contract):
        return ResearchDecision("unavailable", ("exact-contract-and-bounded-source-receipts-required", *labels))
    receipts = evidence.source_receipts
    if (regular_session.session != session or regular_session.session_kind != "regular" or
            regular_session.content_digest not in receipts or
            instant(regular_session.observed_at) > cutoff or
            instant(regular_session.available_at) > cutoff):
        return ResearchDecision("unavailable", ("regular-session-authority-unavailable-at-cutoff", *labels))
    open_at, close_at = instant(session.open_at), instant(session.close_at)
    if not open_at <= cutoff < close_at:
        return ResearchDecision("hold", ("outside-regular-session", *labels), evidence_ids=receipts)
    if (type(bars) is not tuple or not 1 <= len(bars) <= 100_000 or
            type(sources) is not tuple or not 1 <= len(sources) <= 4096):
        return ResearchDecision("unavailable", ("bounded-immutable-bars-and-source-bindings-required", *labels),
                                evidence_ids=receipts)
    if session.bar_seconds > 86_400:
        return ResearchDecision("unavailable", ("session-bar-interval-outside-bounds", *labels),
                                evidence_ids=receipts)
    if any(not isinstance(source, SessionLowSource) for source in sources):
        return ResearchDecision("unavailable", ("typed-bar-source-bindings-required", *labels),
                                evidence_ids=receipts)
    by_source = {source.source_id: source for source in sources}
    if (len(by_source) != len(sources) or
            len({source.currency for source in sources}) != 1 or
            len({source.adjustment_basis for source in sources}) != 1 or
            any(source.instrument_id != evidence.exact_contract_id or
                source.content_digest not in receipts for source in sources)):
        return ResearchDecision("unavailable", ("mixed-or-unbound-bar-source-identity-units", *labels),
                                evidence_ids=receipts)
    interval = timedelta(seconds=session.bar_seconds)
    expected_start = open_at
    for bar in bars:
        if not isinstance(bar, Bar):
            return ResearchDecision("unavailable", ("typed-completed-bars-required", *labels),
                                    evidence_ids=receipts)
        source = by_source.get(bar.source_id)
        if (source is None or bar.instrument_id != evidence.exact_contract_id or
                bar.session_id != session.session_id or
                bar.adjustment_basis != source.adjustment_basis):
            return ResearchDecision("unavailable", ("bar-session-identity-or-source-mismatch", *labels),
                                    evidence_ids=receipts)
        start, end, available = (instant(value) for value in
                                 (bar.start_at, bar.end_at, bar.available_at))
        if (not bar.complete or end > cutoff or available > cutoff or
                not start < end <= available):
            return ResearchDecision("unavailable", ("incomplete-or-future-bar-input", *labels),
                                    evidence_ids=receipts)
        # Validate input order before completed_bars can sort or filter it.
        if start != expected_start or end - start != interval or end > close_at:
            return ResearchDecision("unavailable", ("session-bars-not-ordered-contiguous-from-open", *labels),
                                    evidence_ids=receipts)
        expected_start = end
    if set(by_source) != {bar.source_id for bar in bars}:
        return ResearchDecision("unavailable", ("unused-bar-source-binding", *labels), evidence_ids=receipts)
    if cutoff - expected_start > timedelta(seconds=maximum_age_seconds):
        return ResearchDecision("unavailable", ("latest-completed-session-bar-stale", *labels),
                                evidence_ids=receipts)
    try:
        rows = completed_bars(bars, as_of=cutoff, instrument_id=evidence.exact_contract_id)
        if rows != bars:
            raise ValueError("Completed-bar helper changed validated input order or membership")
        price, low, high = rows[-1].close, min(row.low for row in rows), max(row.high for row in rows)
        for value in (price, low, high):
            require_decimal(value, positive=True)
        if not low <= price <= high:
            raise ValueError("Inconsistent completed-session range")
        distance, width = price - low, high - low
        percent_above_low = ratio(Decimal(100) * distance, low)
        range_position = ZERO if width == ZERO else ratio(distance, width)
        qualifies = (Decimal(100) * distance <= maximum_percent_above_low * low and
                     distance <= maximum_range_position * width)
    except (TypeError, ValueError, ArithmeticError):
        return ResearchDecision("unavailable", ("completed-session-range-or-arithmetic-unavailable", *labels),
                                evidence_ids=receipts)
    caveat = ("descriptive-contaminated-study" if evidence.historical_contamination
              else "unqualified-forward-research")
    reasons = ("within-inclusive-session-low-thresholds" if qualifies
               else "outside-session-low-thresholds", *labels, caveat,
               f"price-units:{sources[0].currency}-per-instrument-unit")
    return ResearchDecision(
        "review" if qualifies else "hold", reasons,
        (("last-completed-close", price), ("completed-session-low", low),
         ("completed-session-high", high), ("percent-above-low-percentage-points", percent_above_low),
         ("range-position-fraction", range_position),
         ("maximum-percent-above-low-percentage-points", maximum_percent_above_low),
         ("maximum-range-position-fraction", maximum_range_position)), receipts)


@deterministic
def dual_zone_review(snapshot: MomentumSnapshot, *, prior_close: Decimal | None,
                     volume_trigger: Decimal) -> ResearchDecision:
    """Advisory trend/trade invalidation and refresh escalation, never a notifier."""
    require_decimal(volume_trigger, positive=True)
    if prior_close is not None:
        require_decimal(prior_close, positive=True)
    close, support, resistance, atr = (snapshot.feature(key) for key in ("close", "support20", "resistance20", "atr14"))
    if any(value is None for value in (close, support, resistance, atr, prior_close)):
        return ResearchDecision("unavailable", ("dual-zone-inputs-missing",))
    volume = snapshot.feature("relative-volume")
    triggers = []
    if close <= support + atr or close >= resistance - atr:
        triggers.append("price-in-review-zone")
    if volume is not None and volume >= volume_trigger:
        triggers.append("volume-escalation")
    if (prior_close <= resistance < close) or (prior_close >= support > close):
        triggers.append("directional-level-crossing")
    return ResearchDecision("review" if triggers else "hold", tuple(triggers) or ("base-research-cadence",),
                            (("trade-invalidation", support), ("trend-invalidation", max(ZERO, support - atr)),
                             ("breakout-review", resistance)), snapshot.source_ids)
