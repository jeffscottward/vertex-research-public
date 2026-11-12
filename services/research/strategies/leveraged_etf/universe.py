"""Which US-listed products are leveraged or inverse, read from the listed name (pure, no I/O).

Input: the rows of the Nasdaq Trader symbol directory (nasdaqtraded.txt, one row per listed security).
Output: the leveraged and inverse exchange-traded funds and notes, each with its signed target multiple and,
when it is known, the ticker of the unleveraged reference (the stock of a single-stock fund, the ETF twin of
an index, sector or commodity fund).

The multiple comes from the name only. A name that signals leverage but does not state a multiple that these
rules can read is left out and returned by `unclassified`, so a person can extend the rules. No rule guesses.
A product with multiple 1 and long direction is not leveraged and is not in the universe; an inverse product
with multiple -1 is.
"""
from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass

LISTING_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt"
MAX_MULTIPLE = 5  # the document contract allows -5..5

# Listing Exchange codes of the directory.
EXCHANGES = {"Q": "NASDAQ", "N": "NYSE", "A": "NYSE American", "P": "NYSE Arca", "Z": "Cboe BZX", "V": "IEX",
             "M": "NYSE Chicago"}


@dataclass(frozen=True)
class Leverage:
    multiple: float  # signed target multiple, for example 3, -2, 1.5, -0.5
    rule: str  # the rule that read it: "explicit", "word", "family" or "prospectus"


@dataclass(frozen=True)
class ListedFund:
    symbol: str
    name: str  # as listed
    product_type: str  # "etf" or "etn"
    leverage: float
    underlying: str | None
    listing_exchange: str


# --- text that looks like leverage but is not ---------------------------------------------------------------

# Removed before the direction words are read. "UltraShort" (one word, capital S) is the ProShares -2x
# family and stays; "Ultra Short", "Ultra-Short" and "Ultrashort" are bond and cash funds.
_NOT_DIRECTION = (
    re.compile(r"Ultra[- ][Ss]hort|Ultrashort|ULTRA SHORT"),
    re.compile(r"\b(?:Short|Long|Longer|Intermediate)[- ](?:Term|Duration|Maturity|Dated|Horizon)\b", re.I),
    re.compile(r"\bLong\s?[/-]\s?(?:Short|Flat)\b|\bLong Short\b", re.I),
    re.compile(r"\bLeveraged Loans?\b", re.I),
    re.compile(r"^Leverage Shares\b|^Long Pond\b"),  # issuer names, not statements about the fund
)
# Funds that are never in the universe, also when the name has a multiple: option-income, outcome and hedge
# funds. Their return is not a fixed multiple of the reference. YieldMax funds sell options; they are not
# leveraged (also "YieldMax Short NVDA Option Income").
_NEVER = re.compile(r"\bYieldMax\b|\bBuffer(?:ed)?\b|\bCovered Call\b|\bOption Income\b|\bPremium Income\b"
                    r"|\bAutocallable\b|\bHedged?\b|\bFloor\b", re.I)
# Names that signal leverage or direction and were checked by hand: the fund has no fixed multiple.
_NO_FIXED_MULTIPLE = (
    re.compile(r"^Ranger Equity Bear\b"),  # active short selling, no target multiple
    re.compile(r"^AdvisorShares Dorsey Wright Short\b"),  # active short selling, no target multiple
    re.compile(r"^Gotham Short Strategies\b"),  # active long and short positions, no target multiple
    re.compile(r"^Simplify Bond Bull\b"),  # interest-rate options, no target multiple
    re.compile(r"^Miller Value Partners Leverage\b"),  # changes between 1x and 2x on a signal
    re.compile(r"^Defiance Leveraged Long \+ Income\b"),  # a 1.5x to 2x range plus option income
    # JPMorgan VYLD follows a points-change inverse index; its percent multiple changes with the VIX level
    re.compile(r"^Inverse VIX Short-Term Futures ETNs\b"),
)

# --- the multiple ------------------------------------------------------------------------------------------

# "2X", "3x", "1.5X", "1.25x", "-3X", "2xLeveraged". A following lower-case letter or digit is not a multiple.
_MULTIPLE = re.compile(r"(?<![\w.])(-?)(\d(?:\.\d{1,2})?)\s?[xX](?![a-z0-9])")
# MicroSectors writes "3 Leveraged ETNs" and "-3 Inverse Leveraged ETNs".
_BARE_MULTIPLE = re.compile(r"(?<![\w.])(-?)(\d(?:\.\d{1,2})?)\s(?:Inverse\s)?Leveraged\b")
_WORD_MULTIPLE = re.compile(r"\b(Double|Triple)\s(?:Long|Short|Inverse|Leveraged|Bull|Bear)\b")
_WORDS = {"Double": 2.0, "Triple": 3.0}
_NEGATIVE = re.compile(r"\b(?:Short|Bear|Inverse)\b")
_POSITIVE = re.compile(r"\b(?:Long|Bull)\b")
# ProShares families. Some listed names drop the issuer ("UltraPro Short Dow30").
_FAMILY = re.compile(r"^(?:ProShares (UltraPro Short|UltraPro|UltraShort|Ultra|Short)|(UltraPro Short|UltraPro))\s")
_FAMILIES = {"UltraPro Short": -3.0, "UltraPro": 3.0, "UltraShort": -2.0, "Ultra": 2.0, "Short": -1.0}
# Names whose multiple is stated by the issuer and not by the name. The two ProShares VIX futures funds keep
# the family word, but the target is not the family multiple (changed on 2018-02-27): Ultra VIX Short-Term
# Futures is 1.5x, Short VIX Short-Term Futures is -0.5x. AdvisorShares states two times MSOS per day for
# MSOX (advisorshares.com/etfs/msox; the fund was listed as "MSOS 2x Daily ETF").
_PROSPECTUS = (
    (re.compile(r"^ProShares Ultra VIX Short[- ]Term Futures\b"), 1.5),
    (re.compile(r"^ProShares Short VIX Short[- ]Term Futures\b"), -0.5),
    (re.compile(r"^AdvisorShares MSOS Daily Leveraged ETF$"), 2.0),
)
_DB_SHORT = re.compile(r"^DB \w+ Short ETN\b")  # "DB Gold Short ETN": the -1x member of the DB family
_SIGNAL = re.compile(r"\bLeveraged?\b|\bInverse\b|\bBull\b|\bBear\b|\b(?:Double|Triple)\b|\bDaily Target\b")
# "Short" or "Long" alone is a signal too ("Example Short Tesla ETF"), but not in the name of a debt fund
# ("VanEck Short Muni ETF"), where it is the maturity.
_DIRECTION = re.compile(r"\b(?:Short|Long)\b")
_DEBT = re.compile(r"\b(?:Bond|Muni|Municipal|Treasury|T-Bill|Credit|Corporate|Income|Loans?)\b", re.I)

_UNREADABLE = "unreadable"  # the name signals leverage, no rule reads a multiple


def _clean(name: str) -> str:
    """The name with the multiplication sign as "x". The directory sends "×" as "?" ("-3? Short")."""
    text = name.replace("\u00d7", "x")
    return re.sub(r"(?<=\d)\?(?=\s|$)", "x", text)


def _read(name: str) -> Leverage | str | None:
    """Leverage, None (not leveraged) or _UNREADABLE."""
    text = _clean(name)
    if _NEVER.search(text) or any(pattern.search(text) for pattern in _NO_FIXED_MULTIPLE):
        return None
    for pattern, multiple in _PROSPECTUS:
        if pattern.search(text):
            return Leverage(multiple, "prospectus")
    for pattern in _NOT_DIRECTION:
        text = pattern.sub(" ", text)
    family = _FAMILY.match(text)
    found = [(sign, float(digits)) for sign, digits in _MULTIPLE.findall(text) + _BARE_MULTIPLE.findall(text)]
    rule = "explicit"
    if not found:
        found = [("", _WORDS[word]) for word in _WORD_MULTIPLE.findall(text)]
        rule = "word"
    if found:
        sizes = {size for _, size in found}
        minus = any(sign for sign, _ in found)
        negative = minus or bool(_NEGATIVE.search(text))
        if len(sizes) != 1 or (negative and _POSITIVE.search(text)):
            return _UNREADABLE  # two multiples, or two directions
        size = sizes.pop()
        if not 0 < size <= MAX_MULTIPLE:
            return _UNREADABLE
        if size == 1 and not negative:
            return None  # 1x long is not leveraged
        return Leverage(-size if negative else size, rule)
    if family:
        return Leverage(_FAMILIES[family.group(1) or family.group(2)], "family")
    if _DB_SHORT.match(text):
        return Leverage(-1.0, "family")
    if _SIGNAL.search(text) or (_DIRECTION.search(text) and not _DEBT.search(text)):
        return _UNREADABLE
    return None


def classify(name: str) -> Leverage | None:
    """The signed multiple that the listed name states; None when the product is not leveraged or inverse,
    or when the name does not state a multiple that the rules can read (see `signals_leverage`)."""
    result = _read(name)
    return result if isinstance(result, Leverage) else None


def signals_leverage(name: str) -> bool:
    """True when the name signals leverage or direction but no rule reads a multiple from it."""
    return _read(name) is _UNREADABLE


# --- the unleveraged reference -----------------------------------------------------------------------------

_ISSUERS = re.compile(
    r"^(?:ProShares|Direxion|GraniteShares|Tradr|T-R[Ee][Xx]|Roundhill T-REX|Roundhill|Defiance|Leverage Shares|Corgi"
    r"|MicroSectors|MAX|ETRACS|Teucrium|21Shares|Volatility Shares Trust|Tuttle Capital|Yorkville America|USCF"
    r"|Rareview|AdvisorShares|DB)\s")
_TAIL = re.compile(r"\s(?:due\s.*|Series [A-Z]\b.*)$")
_PRODUCT_WORD = re.compile(r"(?:\sK-1 Free)?\s(?:ETF|ETNs?|Fund|Shares|Shrs)$")
_BOILERPLATE = re.compile(
    r"(?<![\w.])-?\d(?:\.\d{1,2})?\s?[xX](?![a-z0-9])|\b(?:UltraPro Short|UltraPro|UltraShort|Ultra)\b"
    r"|\b(?:Daily Target|Daily|Target|Monthly Pay|Quarterly Pay|Weekly|Monthly|Quarterly|Long|Short|Bull|Bear"
    r"|Inverse|Leveraged|Double|Index|New)\b")

# Company names that single-stock issuers write instead of the ticker.
_COMPANIES = {
    "nvidia": "NVDA", "tesla": "TSLA", "apple": "AAPL", "microsoft": "MSFT", "amazon": "AMZN", "alphabet": "GOOGL",
    "google": "GOOGL", "meta": "META", "microstrategy": "MSTR", "strategy": "MSTR", "coinbase": "COIN",
    "palantir": "PLTR", "amd": "AMD", "advanced micro devices": "AMD", "broadcom": "AVGO", "netflix": "NFLX",
    "spacex": "SPCX", "sk hynix": "SKHY",
}
# Subject of an index, sector, commodity or currency fund -> the unleveraged ETF twin. The whole subject
# must match (case is ignored), so "Semiconductors Top 5" does not become SOXX. None = the subject is known and has no twin
# here; it also stops the ticker route ("XRP" and "HYPE" are tokens, not the listed symbols of that name).
_TWINS: tuple[tuple[str, str | None], ...] = (
    (r".*\bVIX\b.*", None),
    (r".*\bTop \d+", None),
    (r"QQQ (?:Equal Weight|Mega)", None),
    (r"XRP|HYPE|Solana|Sui|Dogecoin|Avalanche|Chainlink|Cardano|Stellar", None),
    (r"QQQ|Nasdaq[- ]?100", "QQQ"),
    (r"S&P ?500 High Beta", "SPHB"),
    (r"S&P ?500 Equal Weight", "RSP"),
    (r"S&P ?500|SPY", "SPY"),
    (r"Russell ?2000|Small Cap", "IWM"),
    (r"Dow ?30", "DIA"),
    (r"Mid ?Cap ?400|Mid Cap", "MDY"),
    (r"SmallCap ?600", "IJR"),
    (r"Semiconductors?", "SOXX"),
    (r"Technology", "XLK"),
    (r"Financials?", "XLF"),
    (r"Energy", "XLE"),
    (r"Health ?[Cc]are", "XLV"),
    (r"Utilities", "XLU"),
    (r"Industrials", "XLI"),
    (r"Materials", "XLB"),
    (r"Consumer Discretionary", "XLY"),
    (r"Consumer Staples", "XLP"),
    (r"Communication Services", "XLC"),
    (r"Real Estate", "XLRE"),
    (r"(?:S&P )?Biotech", "XBI"),
    (r"Nasdaq Biotechnology", "IBB"),
    (r"Regional Banks", "KRE"),
    (r"Junior Gold Miners", "GDXJ"),
    (r"Gold Miners", "GDX"),
    (r"Gold", "GLD"),
    (r"Silver", "SLV"),
    (r"Platinum", "PPLT"),
    (r"Palladium", "PALL"),
    (r"Copper", "CPER"),
    (r"(?:Bloomberg )?Crude Oil", "USO"),
    (r"(?:Bloomberg )?Natural Gas", "UNG"),
    (r"Corn", "CORN"),
    (r"Wheat", "WEAT"),
    (r"(?:Lehman )?20\W*(?:Year|Yr) Treasury", "TLT"),
    (r"(?:Lehman )?7\W*10 Year Treasury|10-Yr Treasury", "IEF"),
    (r"High Yield", "HYG"),
    (r"Bitcoin", "IBIT"),
    (r"Ether", "ETHA"),
    (r"Euro", "FXE"),
    (r"Yen", "FXY"),
    (r"(?:MSCI )?Emerging Markets", "EEM"),
    (r"MSCI EAFE", "EFA"),
    (r"MSCI Japan", "EWJ"),
    (r"(?:MSCI )?Brazil(?: Capped)?", "EWZ"),
    (r"(?:FTSE )?China(?: 50)?", "FXI"),
    (r"CSI 300 China A Share", "ASHR"),
    (r"CSI China Internet", "KWEB"),
    (r"FTSE Europe", "VGK"),
    (r"South Korea", "EWY"),
    (r"MSCI Mexico", "EWW"),
    (r"MSCI India", "INDA"),
    (r"Dow Jones Internet", "FDN"),
    (r"Aerospace & Defense", "ITA"),
    (r"Homebuilders & Supplies", "ITB"),
    (r"Retail", "XRT"),
    (r"Transportation", "XTN"),
    (r"Pharmaceutical & Medical", "XPH"),
    (r"S&P Oil & Gas Exp\. & Prod\.", "XOP"),
    (r"Robotics, Artificial Intelligence & Automation", "BOTZ"),
    (r"Cloud Computing", "SKYY"),
    (r"NYSE FANG\+", "FNGS"),
    (r"Innovation", "ARKK"),
    (r"Magnificent (?:7|Seven)", "MAGS"),
)
_TWIN_PATTERNS = tuple((re.compile(pattern, re.I), twin) for pattern, twin in _TWINS)
# MicroSectors and MAX notes follow their own indices. Only these subjects have an exchange-traded twin; a
# ticker in brackets in the name ("(HYG)") is read for every issuer.
_NOTE_TWINS = {"gold": "GLD", "fang+": "FNGS", "fang": "FNGS", "s&p 500": "SPY"}
_OWN_INDEX_ISSUERS = ("MicroSectors", "MAX ", "ETRACS")
_BRACKET_TICKER = re.compile(r"\(([A-Z]{2,5})\)")
_NOT_TICKERS = frozenset({"AI"})  # "Artificial Intelligence (AI)" is not C3.ai
_TICKER = re.compile(r"[A-Z][A-Z0-9]{0,5}")


def subject_of(name: str) -> str:
    """What the fund follows, as the name writes it: the name without issuer, multiple, direction and
    product words. "Direxion Daily Semiconductor Bull 3X ETF" -> "Semiconductor"."""
    text = _TAIL.sub("", _clean(name).strip())
    text = _PRODUCT_WORD.sub("", text)
    text = _ISSUERS.sub("", text)
    text = _BRACKET_TICKER.sub(" ", text)
    text = _BOILERPLATE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip(" -,")
    return re.sub(r"^U\.S\. ", "", text)


def _listed(ticker: str | None, symbols: Collection[str] | None) -> str | None:
    return ticker if ticker is not None and (symbols is None or ticker in symbols) else None


def underlying_of(name: str, symbols: Collection[str] | None = None) -> str | None:
    """Ticker of the unleveraged reference of a leveraged product, or None when it is not known.

    `symbols` is the set of listed symbols of the same directory. With it, a ticker written in the name
    counts only when it is listed, and a twin from the tables counts only when it is listed. Without it the
    tables alone answer (a ticker in the name cannot be checked, so it is not used)."""
    bracket = _BRACKET_TICKER.search(name)
    if bracket and bracket.group(1) not in _NOT_TICKERS and symbols is not None and bracket.group(1) in symbols:
        return bracket.group(1)
    subject = subject_of(name)
    if name.startswith(_OWN_INDEX_ISSUERS):
        return _listed(_NOTE_TWINS.get(re.sub(r"\s+", " ", subject).lower()), symbols)
    for pattern, twin in _TWIN_PATTERNS:
        if pattern.fullmatch(subject):
            return _listed(twin, symbols)
    if subject.lower() in _COMPANIES:
        return _listed(_COMPANIES[subject.lower()], symbols)
    if symbols is not None and _TICKER.fullmatch(subject):
        if subject in symbols:
            return subject
        share_class = f"{subject[:-1]}.{subject[-1]}"  # "BRKB" is listed as "BRK.B"
        if len(subject) > 1 and share_class in symbols:
            return share_class
    return None


# --- the directory -----------------------------------------------------------------------------------------

_NOTE = re.compile(r"\bETNs?\b|\bExchange[- ]Traded Notes?\b")
_FUND_WORD = re.compile(r"\bETF\b")


def parse_listing(text: str) -> list[dict[str, str]]:
    """Rows of nasdaqtraded.txt (pipe-delimited, first line = header, last line = file creation time)."""
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split("|")
    rows = []
    for line in lines[1:]:
        cells = line.split("|")
        if len(cells) == len(header) and not line.startswith("File Creation Time"):
            rows.append(dict(zip(header, cells)))
    return rows


def product_type(name: str) -> str:
    """"etn" for an exchange-traded note. "Leverage Shares 2X Long ETN Daily ETF" is a fund on the stock ETN."""
    return "etn" if _NOTE.search(name) and not _FUND_WORD.search(name) else "etf"


def _products(rows: Iterable[Mapping[str, str]]) -> list[Mapping[str, str]]:
    """The exchange-traded funds and notes of the directory. The directory marks some notes as ETF = N."""
    return [row for row in rows if row.get("Test Issue") == "N"
            and (row.get("ETF") == "Y" or product_type(row.get("Security Name", "")) == "etn")]


def listed_funds(rows: Iterable[Mapping[str, str]]) -> list[ListedFund]:
    """The leveraged and inverse products of the directory rows, sorted by symbol."""
    rows = list(rows)
    symbols = frozenset(row["Symbol"] for row in rows if row.get("Test Issue") == "N")
    funds = {}
    for row in _products(rows):
        name = row["Security Name"].strip()
        leverage = classify(name)
        if leverage is None:
            continue
        underlying = underlying_of(name, symbols)
        funds[row["Symbol"]] = ListedFund(
            symbol=row["Symbol"], name=name, product_type=product_type(name), leverage=leverage.multiple,
            underlying=None if underlying == row["Symbol"] else underlying,
            listing_exchange=EXCHANGES.get(row["Listing Exchange"], row["Listing Exchange"]))
    return [funds[symbol] for symbol in sorted(funds)]


def unclassified(rows: Iterable[Mapping[str, str]]) -> list[tuple[str, str]]:
    """(symbol, name) of the products whose name signals leverage without a readable multiple."""
    return sorted((row["Symbol"], row["Security Name"].strip()) for row in _products(rows)
                  if signals_leverage(row["Security Name"]))
