"""Signal loaders, normalization, cleaning, and event generation for smart-money PR 7.

Pure Python stdlib + existing services/research modules only (no third-party imports,
no cross-service vertex_openbb imports). Research only.
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime
from pathlib import Path

from strategies import alert_templates as at

from .engine import DailyBar, SignalEvent, check_point_in_time_liquidity

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
SECURITY_INCLUDE_RE = re.compile(r"\b(common|ordinary)\b", re.IGNORECASE)
SECURITY_EXCLUDE_RE = re.compile(
    r"\b(preferred|warrant|option|unit|note|debenture|depositary|adr|ads|"
    r"phantom|restricted\s+stock|rsu|psu|deferred)\b",
    re.IGNORECASE,
)
MEMBER_PREFIX_RE = re.compile(r"^(?:hon\.?|rep\.?|sen\.?|mr\.?|mrs\.?|ms\.?|dr\.?)\s+", re.IGNORECASE)
MEMBER_SUFFIX_RE = re.compile(r"\s+(?:jr\.?|sr\.?|ii|iii|iv|md|phd|esq\.?)$", re.IGNORECASE)
PUNCT_RE = re.compile(r"[^a-z0-9\s]")

PRICE_SANITY_LOW = 0.25
PRICE_SANITY_HIGH = 4.0
CLUSTER_MIN_OWNERS = 3
CLUSTER_WINDOW_DAYS = 10
COOLDOWN_DAYS = 14
CONGRESS_MULTI_MEMBER_WINDOW_DAYS = 30
PREMIUM_FLOOR_USD = 500_000.0
PREMIUM_BULLISH_RATIO_MIN = 0.70
PREMIUM_MIN_TRADES = 3
PREMIUM_TOP_N = 10


@dataclass(frozen=True, slots=True)
class Form4Purchase:
    accession_number: str
    filing_date: date
    transaction_date: date | None
    issuer_cik: str
    ticker: str
    owner_group_key: str  # canonical sorted joint owner CIKs (joint filers count as 1)
    role_text: str
    security: str  # "common" or "ordinary"
    shares: float
    price: float
    holding_before: float | None
    is_10b5_1: bool = False

    @property
    def dollar_value(self) -> float:
        return self.shares * self.price


@dataclass(frozen=True, slots=True)
class CongressPurchase:
    chamber: str  # "house" or "senate"
    doc_id: str
    member: str
    holder: str | None
    ticker: str
    transaction_type: str
    transaction_date: date | None
    filed_on: date
    amount_low: float | None
    amount_high: float | None
    amends: bool = False
    asset_type: str | None = None  # the filing's own code: House "ST"/"OP"/..., Senate "Stock"/"Stock Option"/...


@dataclass(frozen=True, slots=True)
class MarketPremiumRow:
    session_date: date
    ticker: str
    bullish_premium: float
    bearish_premium: float
    trade_count: int
    session_status: str = "complete"

    @property
    def total_premium(self) -> float:
        return self.bullish_premium + self.bearish_premium

    @property
    def net_premium(self) -> float:
        return self.bullish_premium - self.bearish_premium


def normalize_security_title(title: str | None) -> str | None:
    """Return 'common' or 'ordinary' for plain equity shares, else None."""
    if not title:
        return None
    text = title.strip()
    if not text or SECURITY_EXCLUDE_RE.search(text):
        return None
    match = SECURITY_INCLUDE_RE.search(text)
    if not match:
        return None
    return match.group(1).lower()


def _parse_sec_date(raw: str | None) -> date | None:
    if not raw:
        return None
    text = raw.strip()
    if not text:
        return None
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _parse_float(raw: str | None) -> float | None:
    if raw is None:
        return None
    text = raw.strip().replace(",", "").replace("$", "")
    if not text:
        return None
    try:
        val = float(text)
    except ValueError:
        return None
    return val if val == val and abs(val) != float("inf") else None


def _clean_ticker(raw: str | None) -> str | None:
    if not raw:
        return None
    sym = raw.strip().upper()
    if sym in ("NONE", "N/A", "NA", "--", "-"):
        return None
    return sym if SYMBOL_RE.match(sym) else None


def _read_tsv_from_zip(zf: zipfile.ZipFile, member_name: str) -> csv.DictReader[str]:
    csv.field_size_limit(10_000_000)
    raw = zf.open(member_name, "r")
    wrapper = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
    return csv.DictReader(wrapper, delimiter="\t")


def _find_zip_member(zf: zipfile.ZipFile, suffix: str) -> str | None:
    target = suffix.upper()
    for name in zf.namelist():
        if name.upper().endswith(target):
            return name
    return None


def parse_sec_form4_zip(zip_path: Path) -> list[Form4Purchase]:
    """Stream one SEC quarterly Form 3/4/5 ZIP and return cleaned code-P common/ordinary buys."""
    purchases: list[Form4Purchase] = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        sub_name = _find_zip_member(zf, "SUBMISSION.TSV")
        own_name = _find_zip_member(zf, "REPORTINGOWNER.TSV")
        tx_name = _find_zip_member(zf, "NONDERIV_TRANS.TSV")
        if not (sub_name and own_name and tx_name):
            return purchases

        # 1. Load non-amendment Form 4 submissions (DOCUMENT_TYPE == '4').
        submissions: dict[str, tuple[date, str, str, bool]] = {}
        for row in _read_tsv_from_zip(zf, sub_name):
            if (row.get("DOCUMENT_TYPE") or "").strip().upper() != "4":
                continue
            acc = (row.get("ACCESSION_NUMBER") or "").strip()
            fdate = _parse_sec_date(row.get("FILING_DATE"))
            ticker = _clean_ticker(row.get("ISSUERTRADINGSYMBOL"))
            issuer_cik = (row.get("ISSUERCIK") or "").strip().lstrip("0") or "0"
            if not acc or fdate is None or not ticker:
                continue
            aff = (row.get("AFF10B5ONE") or "").strip().lower()
            is_10b5_1 = aff in ("1", "true", "y", "yes")
            submissions[acc] = (fdate, issuer_cik, ticker, is_10b5_1)

        if not submissions:
            return purchases

        # 2. Group reporting owners per accession (joint filers count as one owner group).
        owner_ciks_by_acc: dict[str, set[str]] = defaultdict(set)
        roles_by_acc: dict[str, list[str]] = defaultdict(list)
        for row in _read_tsv_from_zip(zf, own_name):
            acc = (row.get("ACCESSION_NUMBER") or "").strip()
            if acc not in submissions:
                continue
            ocik = (row.get("RPTOWNERCIK") or "").strip().lstrip("0")
            if ocik:
                owner_ciks_by_acc[acc].add(ocik)
            rel = (row.get("RPTOWNER_RELATIONSHIP") or "").strip()
            title = (row.get("RPTOWNER_TITLE") or "").strip()
            combined = " ".join(part for part in (rel, title) if part)
            if combined:
                roles_by_acc[acc].append(combined)

        # 3. Stream NONDERIV_TRANS.tsv and keep code P open-market common/ordinary buys.
        for row in _read_tsv_from_zip(zf, tx_name):
            acc = (row.get("ACCESSION_NUMBER") or "").strip()
            sub = submissions.get(acc)
            if sub is None:
                continue
            if (row.get("TRANS_CODE") or "").strip().upper() != "P":
                continue
            security = normalize_security_title(row.get("SECURITY_TITLE"))
            if security is None:
                continue
            shares = _parse_float(row.get("TRANS_SHARES"))
            price = _parse_float(row.get("TRANS_PRICEPERSHARE"))
            if shares is None or price is None or shares <= 0 or price <= 0:
                continue
            ciks = owner_ciks_by_acc.get(acc)
            if not ciks:
                continue
            owner_group_key = "|".join(sorted(ciks))
            role_text = " ; ".join(roles_by_acc.get(acc, ()))
            after = _parse_float(row.get("SHRS_OWND_FOLLOWING_TRANS"))
            holding_before = max(0.0, after - shares) if after is not None else None
            tx_date = _parse_sec_date(row.get("TRANS_DATE"))
            fdate, issuer_cik, ticker, is_10b5_1 = sub
            purchases.append(
                Form4Purchase(
                    accession_number=acc,
                    filing_date=fdate,
                    transaction_date=tx_date,
                    issuer_cik=issuer_cik,
                    ticker=ticker,
                    owner_group_key=owner_group_key,
                    role_text=role_text,
                    security=security,
                    shares=shares,
                    price=price,
                    holding_before=holding_before,
                    is_10b5_1=is_10b5_1,
                )
            )
    return purchases


def _filing_raw_close(bars: Sequence[DailyBar], filing_day: date) -> float | None:
    """The as-printed close on the last session on or before the filing day."""
    days = [b.day for b in bars]
    pos = bisect_right(days, filing_day) - 1
    if pos < 0:
        return None
    return bars[pos].raw_close if bars[pos].raw_close > 0 else None


def _to_alert_bars(bars: Sequence[DailyBar]) -> list[at.DailyBar]:
    out: list[at.DailyBar] = []
    for b in bars:
        if b.open <= 0 or b.close <= 0 or b.low <= 0 or b.high <= 0 or b.volume < 0:
            continue
        low = min(b.low, b.open, b.close)
        high = max(b.high, b.open, b.close)
        out.append(at.DailyBar(b.day, b.open, high, low, b.close, b.volume))
    return out


def count_owner_groups(owner_group_keys: Iterable[str]) -> int:
    """Distinct persons or entities among reporting-owner CIK sets (union-find).

    Owner CIKs that report on one filing are one group, and a CIK that also files alone or with
    others joins those filings into the same group. This is the rule of the live cluster list
    (``personsIn`` in packages/api/src/insider-clusters.ts).
    """
    parent: dict[str, str] = {}

    def root(cik: str) -> str:
        while parent[cik] != cik:
            parent[cik] = parent[parent[cik]]
            cik = parent[cik]
        return cik

    for key in owner_group_keys:
        ciks = key.split("|")
        for cik in ciks:
            parent.setdefault(cik, cik)
        first = root(ciks[0])
        for cik in ciks[1:]:
            parent[root(cik)] = first
    return len({root(cik) for cik in parent})


def _detect_insider_clusters(
    purchases: Sequence[Form4Purchase],
    *,
    min_owners: int = CLUSTER_MIN_OWNERS,
    window_days: int = CLUSTER_WINDOW_DAYS,
    min_cluster_value: float = 0.0,
    cooldown_days: int = COOLDOWN_DAYS,
    exclude_10b5_1: bool = False,
) -> list[SignalEvent]:
    by_issuer: dict[str, list[Form4Purchase]] = defaultdict(list)
    for p in purchases:
        if exclude_10b5_1 and p.is_10b5_1:
            continue
        by_issuer[p.issuer_cik].append(p)

    events: list[SignalEvent] = []
    for _issuer_cik, rows in by_issuer.items():
        rows.sort(key=lambda r: (r.filing_date, r.accession_number))
        by_day: dict[date, list[Form4Purchase]] = defaultdict(list)
        for r in rows:
            by_day[r.filing_date].append(r)

        last_trigger: date | None = None
        for d in sorted(by_day):
            if last_trigger is not None and (d - last_trigger).days < cooldown_days:
                continue
            window_rows = [r for r in rows if 0 <= (d - r.filing_date).days <= window_days]
            if count_owner_groups(r.owner_group_key for r in window_rows) < min_owners:
                continue
            total_value = sum(r.dollar_value for r in window_rows)
            if total_value < min_cluster_value:
                continue
            # Use the ticker on the triggering day's latest filing.
            ticker = by_day[d][-1].ticker
            events.append(SignalEvent(symbol=ticker, trigger_day=d, rank_value=total_value))
            last_trigger = d

    events.sort(key=lambda e: (e.trigger_day, -e.rank_value, e.symbol))
    return events


def _apply_price_confirmation(
    cluster_events: Sequence[SignalEvent],
    bars_by_symbol: Mapping[str, Sequence[DailyBar]],
) -> list[SignalEvent]:
    """Confirm cluster trigger within 30 calendar days: close > SMA50 and close > post-trigger high."""
    by_sym: dict[str, list[SignalEvent]] = defaultdict(list)
    for ev in cluster_events:
        by_sym[ev.symbol].append(ev)

    confirmed: list[SignalEvent] = []
    for sym, evs in by_sym.items():
        raw_bars = bars_by_symbol.get(sym)
        if not raw_bars:
            continue
        abars = _to_alert_bars(sorted(raw_bars, key=lambda b: b.day))
        if len(abars) < 55:
            continue
        series = at.prepare(abars)
        series_days = [b.day for b in series.bars]
        evs_sorted = sorted(evs, key=lambda e: e.trigger_day)
        used: set[int] = set()
        last_alert: date | None = None
        for t in range(1, len(series.bars)):
            day = series.bars[t].day
            if last_alert is not None and (day - last_alert).days < COOLDOWN_DAYS:
                continue
            m50 = series.sma50[t]
            if m50 is None or series.close[t] <= m50:
                continue
            for idx, ev in enumerate(evs_sorted):
                if idx in used or not (0 <= (day - ev.trigger_day).days <= 30):
                    continue
                start = bisect_right(series_days, ev.trigger_day) - 1
                if start < 0 or series_days[start] < ev.trigger_day:
                    start = bisect_right(series_days, ev.trigger_day)
                if start >= t:
                    continue
                prior_high = max(series.close[start:t])
                if series.close[t] > prior_high:
                    confirmed.append(SignalEvent(symbol=sym, trigger_day=day, rank_value=ev.rank_value))
                    used.add(idx)
                    last_alert = day
                    break
    confirmed.sort(key=lambda e: (e.trigger_day, -e.rank_value, e.symbol))
    return confirmed


def build_signal1_variants(
    purchases: Sequence[Form4Purchase],
    bars_by_symbol: Mapping[str, Sequence[DailyBar]],
) -> tuple[dict[str, list[SignalEvent]], dict[str, int]]:
    """Clean Form 4 purchases with price-sanity guard and generate all 4 Signal 1 variants."""
    sorted_bars = {sym: sorted(seq, key=lambda b: b.day) for sym, seq in bars_by_symbol.items()}
    cleaned: list[Form4Purchase] = []
    ticker_without_bars = 0
    no_bar_by_filing_day = 0
    price_sanity_rejected = 0

    for p in purchases:
        bars = sorted_bars.get(p.ticker)
        if not bars:
            ticker_without_bars += 1
            continue
        ref_close = _filing_raw_close(bars, p.filing_date)
        if ref_close is None:
            no_bar_by_filing_day += 1
            continue
        ratio = p.price / ref_close
        if ratio < PRICE_SANITY_LOW or ratio > PRICE_SANITY_HIGH:
            price_sanity_rejected += 1
            continue
        cleaned.append(p)

    # Variant 1: confirmation-baseline via alert_templates.insider_purchase_confirmation.
    by_sym: dict[str, list[Form4Purchase]] = defaultdict(list)
    for p in cleaned:
        by_sym[p.ticker].append(p)

    baseline_events: list[SignalEvent] = []
    for sym, rows in by_sym.items():
        abars = _to_alert_bars(sorted_bars[sym])
        if len(abars) < 55:
            continue
        trades = [
            at.InsiderTrade(
                trade_day=r.filing_date,  # public-at filing date (zero look-ahead)
                insider=r.owner_group_key,
                role=r.role_text,
                code="P",
                security=r.security,
                shares=r.shares,
                price=r.price,
                holding_before=r.holding_before,
                filing_id=r.accession_number,
            )
            for r in rows
        ]
        signals = at.insider_purchase_confirmation(abars, trades)
        for sig in signals:
            day_val = sum(
                r.dollar_value for r in rows if 0 <= (sig.day - r.filing_date).days <= 30
            )
            baseline_events.append(SignalEvent(symbol=sym, trigger_day=sig.day, rank_value=day_val))
    baseline_events.sort(key=lambda e: (e.trigger_day, -e.rank_value, e.symbol))

    # Variants 2-4: insider cluster buys.
    cluster_3p = _detect_insider_clusters(cleaned, min_cluster_value=0.0)
    cluster_3p_100k = _detect_insider_clusters(cleaned, min_cluster_value=100_000.0)
    cluster_confirm = _apply_price_confirmation(cluster_3p, sorted_bars)
    cluster_no_10b5_1 = _detect_insider_clusters(cleaned, min_cluster_value=0.0, exclude_10b5_1=True)

    diagnostics = {
        "raw_purchases": len(purchases),
        "cleaned_purchases": len(cleaned),
        "ticker_without_bars": ticker_without_bars,
        "no_bar_by_filing_day": no_bar_by_filing_day,
        "price_sanity_rejected": price_sanity_rejected,
        "post_2023_10b5_1_flagged": sum(1 for p in cleaned if p.is_10b5_1),
    }
    variants = {
        "confirmation-baseline": baseline_events,
        "cluster-3p-10d": cluster_3p,
        "cluster-3p-10d-100k": cluster_3p_100k,
        "cluster-3p-10d-confirm": cluster_confirm,
        "cluster-3p-10d-no-10b5-1": cluster_no_10b5_1,
        # Diagnostic only: the same rule on every issuer, with or without bars (coverage of the cap).
        "cluster-3p-10d-all-issuers": _detect_insider_clusters(purchases, min_cluster_value=0.0),
    }
    return variants, diagnostics


def normalize_congress_member(name: str) -> str:
    """Normalize Congress member names across House/Senate formatting variations."""
    text = name.strip()
    while True:
        updated = MEMBER_PREFIX_RE.sub("", text).strip()
        if updated == text:
            break
        text = updated
    while True:
        updated = MEMBER_SUFFIX_RE.sub("", text).strip()
        if updated == text:
            break
        text = updated
    text = PUNCT_RE.sub(" ", text.lower())
    return " ".join(text.split())


def is_option_asset(asset_type: str | None) -> bool:
    """True for a PTR row that reports an option (House code ``OP``, Senate ``Stock Option``).

    An option row carries the ticker of its underlying stock, and a bought put is a bearish
    position, so option rows are never stock-purchase events.
    """
    if not asset_type:
        return False
    text = asset_type.strip().lower()
    return text == "op" or "option" in text


def _sum_optional(left: float | None, right: float | None) -> float | None:
    if left is None and right is None:
        return None
    return (left or 0.0) + (right or 0.0)


def dedupe_congress_purchases(rows: Sequence[CongressPurchase]) -> tuple[list[CongressPurchase], dict[str, int]]:
    """One event per trade: lots of one filing are summed, and the first filing wins.

    The trade key is (chamber, normalized member, holder, ticker, transaction date or doc id,
    purchase). Rows with the same key inside one filing are separate lots bought on the same day:
    their amount bounds are summed. The same key in another filing is a re-disclosure or an
    amendment: the filing with the earliest ``filed_on`` is kept, so a later filing never moves
    the public-at date. A row without a transaction date is keyed by its filing, so it never
    collides with another filing.
    """
    by_filing: dict[tuple[tuple[str, str, str, str, str, str], str], CongressPurchase] = {}
    lots_merged = 0
    option_rows_dropped = 0
    for row in rows:
        if row.transaction_type != "purchase":
            continue
        if is_option_asset(row.asset_type):
            option_rows_dropped += 1
            continue
        ticker = _clean_ticker(row.ticker)
        if ticker is None:
            continue
        chamber = row.chamber.lower().strip()
        tx_key = row.transaction_date.isoformat() if row.transaction_date is not None else row.doc_id
        key = (
            chamber,
            normalize_congress_member(row.member),
            (row.holder or "").lower().strip(),
            ticker,
            tx_key,
            row.transaction_type,
        )
        lot = by_filing.get((key, row.doc_id))
        if lot is None:
            by_filing[(key, row.doc_id)] = replace(row, chamber=chamber, ticker=ticker)
        else:
            lots_merged += 1
            by_filing[(key, row.doc_id)] = replace(
                lot,
                amount_low=_sum_optional(lot.amount_low, row.amount_low),
                amount_high=_sum_optional(lot.amount_high, row.amount_high),
            )

    best: dict[tuple[str, str, str, str, str, str], CongressPurchase] = {}
    later_filings_dropped = 0
    for (key, _doc_id), trade in by_filing.items():
        prev = best.get(key)
        if prev is None:
            best[key] = trade
            continue
        later_filings_dropped += 1
        if (trade.filed_on, trade.amends, trade.doc_id) < (prev.filed_on, prev.amends, prev.doc_id):
            best[key] = trade
    deduped = sorted(best.values(), key=lambda r: (r.filed_on, r.chamber, r.ticker, r.doc_id))
    return deduped, {
        "option_rows_dropped": option_rows_dropped,
        "same_filing_lots_merged": lots_merged,
        "later_filings_dropped": later_filings_dropped,
    }


def build_signal2_variants(
    rows: Sequence[CongressPurchase],
) -> tuple[dict[str, list[SignalEvent]], dict[str, int]]:
    """Build all 4 pre-registered Congress purchase variants using first filed_on."""
    deduped, dedupe_counts = dedupe_congress_purchases(rows)

    all_buys: list[SignalEvent] = []
    large_50k: list[SignalEvent] = []
    fast_15d: list[SignalEvent] = []
    by_ticker: dict[str, list[CongressPurchase]] = defaultdict(list)

    for r in deduped:
        amt = float(r.amount_low or 0.0)
        delay = (
            (r.filed_on - r.transaction_date).days
            if r.transaction_date is not None and r.filed_on >= r.transaction_date
            else None
        )
        if amt >= 1_001.0:
            all_buys.append(SignalEvent(r.ticker, r.filed_on, amt))
        if amt >= 50_001.0:
            large_50k.append(SignalEvent(r.ticker, r.filed_on, amt))
        if delay is not None and 0 <= delay <= 15:
            fast_15d.append(SignalEvent(r.ticker, r.filed_on, amt))
        by_ticker[r.ticker].append(r)

    multi_member: list[SignalEvent] = []
    for ticker, trows in by_ticker.items():
        trows.sort(key=lambda r: r.filed_on)
        by_day: dict[date, list[CongressPurchase]] = defaultdict(list)
        for r in trows:
            by_day[r.filed_on].append(r)
        last_trigger: date | None = None
        for d in sorted(by_day):
            if last_trigger is not None and (d - last_trigger).days < COOLDOWN_DAYS:
                continue
            window = [r for r in trows if 0 <= (d - r.filed_on).days <= CONGRESS_MULTI_MEMBER_WINDOW_DAYS]
            members = {normalize_congress_member(r.member) for r in window}
            if len(members) >= 2:
                total_amt = sum(float(r.amount_low or 0.0) for r in window)
                multi_member.append(SignalEvent(ticker, d, total_amt))
                last_trigger = d

    for seq in (all_buys, large_50k, fast_15d, multi_member):
        seq.sort(key=lambda e: (e.trigger_day, -e.rank_value, e.symbol))

    diagnostics = {
        "raw_rows": len(rows),
        "deduped_purchases": len(deduped),
        **dedupe_counts,
    }
    return {
        "all-buys": all_buys,
        "large-50k": large_50k,
        "fast-filed-15d": fast_15d,
        "multi-member-30d": multi_member,
    }, diagnostics


def build_signal3_events(
    rows: Sequence[MarketPremiumRow],
    bars_by_symbol: Mapping[str, Sequence[DailyBar]],
) -> tuple[list[SignalEvent], dict[str, int]]:
    """Build frozen Signal 3 (large bullish options premium, N = 1) events on complete sessions."""
    sorted_bars = {sym: sorted(seq, key=lambda b: b.day) for sym, seq in bars_by_symbol.items()}
    day_indices = {sym: {b.day: i for i, b in enumerate(seq)} for sym, seq in sorted_bars.items()}

    by_session: dict[date, list[MarketPremiumRow]] = defaultdict(list)
    non_complete = 0
    for r in rows:
        if r.session_status != "complete":
            non_complete += 1
            continue
        sym = _clean_ticker(r.ticker)
        if sym is None:
            continue
        by_session[r.session_date].append(
            MarketPremiumRow(
                r.session_date,
                sym,
                r.bullish_premium,
                r.bearish_premium,
                r.trade_count,
                r.session_status,
            )
        )

    events: list[SignalEvent] = []
    passed_filter = 0
    without_bars = 0
    unknown_liquidity: set[tuple[date, str]] = set()
    top10_without_bars = 0
    illiquid = 0
    for session_day in sorted(by_session):
        qualifying: list[MarketPremiumRow] = []
        for r in by_session[session_day]:
            total = r.total_premium
            if r.bullish_premium < PREMIUM_FLOOR_USD or total <= 0:
                continue
            if r.bullish_premium / total < PREMIUM_BULLISH_RATIO_MIN:
                continue
            if r.trade_count < PREMIUM_MIN_TRADES:
                continue
            bars = sorted_bars.get(r.ticker)
            if not bars or bars[0].day > session_day:
                # No bar on or before the session: liquidity is unknown. The ticker keeps its rank,
                # and the portfolio counts it as a missing-bar event unless a bar exists on the
                # entry day, so the top 10 never depends on which tickers happen to have bars.
                without_bars += 1
                unknown_liquidity.add((session_day, r.ticker))
            elif not check_point_in_time_liquidity(bars, day_indices[r.ticker], session_day):
                illiquid += 1
                continue
            qualifying.append(r)
        passed_filter += len(qualifying)
        qualifying.sort(key=lambda r: (-r.net_premium, r.ticker))
        for r in qualifying[:PREMIUM_TOP_N]:
            events.append(SignalEvent(symbol=r.ticker, trigger_day=session_day, rank_value=r.net_premium))
            if (session_day, r.ticker) in unknown_liquidity:
                top10_without_bars += 1

    diagnostics = {
        "complete_sessions": len(by_session),
        "non_complete_rows_skipped": non_complete,
        "qualifying_ticker_sessions": passed_filter,
        "premium_rows_without_bars": without_bars,
        "top10_events_without_bars": top10_without_bars,
        "premium_rows_illiquid": illiquid,
        "selected_top10_events": len(events),
    }
    return events, diagnostics
