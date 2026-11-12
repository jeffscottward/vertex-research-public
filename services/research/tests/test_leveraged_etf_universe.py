"""Leveraged ETF universe: the name classifier, the unleveraged reference, the option gate, the chain measure,
the universe document and the fetcher of research/backtests/leveraged-etf (fakes only, no network).

The names are real listed names from the Nasdaq Trader symbol directory of 2026-11-11, with their spelling
(double spaces, "?" for a multiplication sign that the directory cannot encode)."""

import gzip
import importlib.util
import io
import json
import urllib.error
from datetime import UTC, date, datetime, timedelta
from email.message import Message
from pathlib import Path

import pytest

from strategies.leveraged_etf import liquidity, universe
from strategies.leveraged_etf.liquidity import GATE, OptionsMeasure
from strategies.leveraged_etf.universe import Leverage, ListedFund

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "universe.py"


def _load():
    spec = importlib.util.spec_from_file_location("leveraged_etf_universe_cli", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = _load()

# (listed name, signed multiple)  # symbol
LEVERAGED = [
    ("ProShares UltraPro QQQ", 3),  # TQQQ
    ("ProShares UltraPro Short QQQ", -3),  # SQQQ
    ("ProShares Ultra QQQ", 2),  # QLD
    ("ProShares UltraShort QQQ", -2),  # QID
    ("ProShares Short QQQ", -1),  # PSQ
    ("ProShares Ultra S&P500", 2),  # SSO
    ("ProShares Short S&P500", -1),  # SH
    ("ProShares UltraPro S&P 500", 3),  # UPRO
    ("ProShares UltraPro Short S&P500", -3),  # SPXU
    ("UltraPro Short Dow30", -3),  # SDOW
    ("UltraPro MidCap400", 3),  # UMDD
    ("ProShares Ultra Gold", 2),  # UGL
    ("ProShares UltraShort Gold", -2),  # GLL
    ("ProShares Ultra Silver", 2),  # AGQ
    ("ProShares Ultra Bloomberg Crude Oil", 2),  # UCO
    ("ProShares UltraShort Bloomberg Crude Oil", -2),  # SCO
    ("ProShares Ultra Bloomberg Natural Gas", 2),  # BOIL
    ("ProShares UltraShort Lehman 20  Year Treasury", -2),  # TBT
    ("ProShares Short 20+ Year Treasury", -1),  # TBF
    ("ProShares UltraPro Short 20 Year Treasury", -3),  # TTT
    ("ProShares Ultra VIX Short Term Futures ETF", 1.5),  # UVXY
    ("ProShares Short VIX Short Term Futures ETF", -0.5),  # SVXY
    ("ProShares Short Bitcoin ETF", -1),  # BITI
    ("ProShares Ultra NVDA", 2),  # NVDB
    ("ProShares UltraShort Yen New", -2),  # YCS
    ("Direxion Daily Semiconductor Bull 3X ETF", 3),  # SOXL
    ("Direxion Daily Semiconductor Bear 3X ETF", -3),  # SOXS
    ("Direxion Daily S&P 500 Bull 3X ETF", 3),  # SPXL
    ("Direxion Daily S&P 500 Bear 1X ETF", -1),  # SPDN
    ("Direxion Daily S&P 500 Bull 2X ETF", 2),  # SPUU
    ("Direxion Daily TSLA Bull 2X ETF", 2),  # TSLL
    ("Direxion Small Cap Bull 3X ETF", 3),  # TNA
    ("Direxion Small Cap Bear 3X ETF", -3),  # TZA
    ("Direxion Daily 20-Yr Treasury Bull 3x Shrs", 3),  # TMF
    ("Direxion Daily 20-Year Treasury Bear 3X", -3),  # TMV
    ("Direxion Daily Gold Miners Index Bear 2X ETF", -2),  # DUST
    ("Direxion Daily AAPL Bear 1X ETF", -1),  # AAPD
    ("Direxion Energy Bull 2X ETF", 2),  # ERX
    ("Direxion Daily BRKB Bull 2X ETF", 2),  # BRKU
    ("GraniteShares 2x Long NVDA Daily ETF", 2),  # NVDL
    ("GraniteShares 2x Short NVDA Daily ETF", -2),  # NVD
    ("GraniteShares 1.25x Long TSLA Daily ETF", 1.25),  # TSL
    ("T-Rex 2X Long NVIDIA Daily Target ETF", 2),  # NVDX
    ("T-Rex 2X Inverse NVIDIA Daily Target ETF", -2),  # NVDQ
    ("T-REX 2X Long Tesla Daily Target ETF", 2),  # TSLT
    ("T-Rex 2X Inverse Tesla Daily Target ETF", -2),  # TSLZ
    ("Defiance Daily Target 2x Long MSTR ETF", 2),  # MSTX
    ("Defiance Daily Target 2x Short IONQ ETF", -2),  # IONZ
    ("Tradr 2X Short TSLA Daily ETF", -2),  # TSLQ
    ("Tradr 1.5X Short NVDA Daily ETF", -1.5),  # NVDS
    ("Tradr 1X Short Innovation Daily ETF", -1),  # SARK
    ("Tradr 2X Long AAOI Daily ETF", 2),  # AAOX
    ("Leverage Shares 2X Long AAL Daily ETF", 2),  # AALG
    ("Leverage Shares 1X Short SK Hynix Daily ETF", -1),  # SKHZ
    ("Leverage Shares 2X Long ETN Daily ETF", 2),  # ETNG
    ("Roundhill Daily 2X Long Magnificent Seven ETF", 2),  # MAGX
    ("Roundhill T-REX 2X Long DRAM Daily Target ETF", 2),  # RAM
    ("Corgi ACHR 2x Daily ETF", 2),  # ACHX
    ("Tradr 2X Long SPY Quarterly ETF", 2),  # SPYQ
    ("AdvisorShares MSOS Daily Leveraged ETF", 2),  # MSOX
    ("MAX S&P 500 4X Leveraged ETNs due October 30, 2043", 4),  # SPYU
    ("MicroSectors FANG+ 3X Leveraged ETNs", 3),  # FNGU
    ("MicroSectors FANG  Index -3X Inverse Leveraged ETNs due January 8, 2038", -3),  # FNGD
    ("MicroSectors FANG  Index 2X Leveraged ETNs due January 8, 2038", 2),  # FNGO
    ("MicroSectors -3? Short Artificial Intelligence (AI) ETNs", -3),  # AIQD
    ("MicroSectors 3? Long Artificial Intelligence (AI) ETNs", 3),  # AIQU
    ("MicroSectors U.S. Big Banks 3 Leveraged ETNs due February 17, 2045", 3),  # BNKU
    ("MicroSectors U.S. Big Banks -3 Inverse Leveraged ETNs due February 17, 2045", -3),  # BNKD
    ("MicroSectors Energy 3X Inverse Leveraged ETNs", -3),  # WTID
    ("DB Gold Double Long ETN due February 15, 2038", 2),  # DGP
    ("DB Gold Double Short ETN due February 15, 2038", -2),  # DZZ
    ("DB Gold Short ETN due February 15, 2038", -1),  # DGZ
    ("ETRACS Quarterly Pay 1.5x Leveraged MarketVector BDC Liquid Index ETN due June 10, 2050", 1.5),  # BDCX
    ("ETRACS Monthly Pay 2xLeveraged US High Dividend Low Volatility ETN Series B due September 30, 2044", 2),  # HDLB
    ("ETRACS 2xMonthly Pay Leveraged Preferred Stock Index ETN due September 25, 2048", 2),  # PFFL
    ("MicroSectors -3x Short High Yield Corporate Bond (HYG) ETNs", -3),  # HYGD
    ("MicroSectors Gold 3X Leveraged ETNs due January 29, 2043", 3),  # SHNY
    ("ETRACS Monthly Pay 1.5X Leveraged Closed-End Fund Index ETN", 1.5),  # CEFD
    ("2x Bitcoin ETF", 2),  # BITX
    ("-1x Short VIX Futures ETF", -1),  # SVIX
    ("2x Long VIX Futures ETF", 2),  # UVIX
    ("Rareview 2x Bull Cryptocurrency & Precious Metals ETF", 2),  # BEGS
    ("Tuttle Capital Daily 2X Inverse Regional Banks ETF", -2),  # SKRE
    ("Yorkville America 2X Inverse MANGOS Plus Daily Target ETF", -2),  # MNGB
    ("Teucrium 2x Daily Corn ETF", 2),  # CXRN
    ("Volatility Shares Trust XRP 2X ETF", 2),  # XRPT
    ("21Shares 2x Long Dogecoin ETF", 2),  # TXXD
    ("Founder-Led 2X Daily ETF", 2),  # FDRX
    ("USCF Daily Target 2X Copper Index ETF", 2),  # CPXR
]

# Listed names that look like leverage and are not in the universe.
NOT_IN_UNIVERSE = [
    "PIMCO Ultra Short Government Active Exchange-Traded Fund",  # BILZ
    "Vanguard Ultra-Short Bond ETF",  # VUSB
    "JPMorgan Ultra-Short Income ETF",  # JPST
    "Dimensional Ultrashort Fixed Income ETF",  # DUSB
    "State Street SPDR Portfolio Ultra Short T-Bill Index ETF",  # SPTU
    "iShares Ultra Short Duration Bond Active ETF",  # ICSH
    "Vanguard Short-Term Bond ETF",  # BSV
    "Vanguard Long-Term Bond ETF",  # BLV
    "iShares 0-1 Year Treasury Bond ETF",  # SHV
    "Convergence Long/Short Equity ETF",  # CLSE
    "First Trust Long/Short Equity",  # FTLS
    "VanEck Long/Flat Trend ETF",  # LFEQ
    "Innovator U.S. Equity Ultra Buffer ETF - January",  # UJAN
    "Innovator U.S. Equity Accelerated 9 Buffer ETF - January",  # XBJA
    "ETRACS Gold Shares Covered Call ETNs due February 2, 2033",  # GLDI
    "Global X NASDAQ 100 Covered Call ETF",  # QYLD
    "YieldMax Ultra Option Income Strategy ETF",  # ULTY
    "YieldMax Short NVDA Option Income Strategy ETF",  # DIPS
    "YieldMax U.S. Stocks Target Double Distribution ETF",  # DDDD
    "IncomeSTKd 1x Bitcoin & 1x Gold Premium ETF",  # ISBG
    "State Street SPDR S&P Leveraged Loan ETF",  # LVLN
    "EA Bridgeway Ultra-Small Company Market ETF",  # BUSM
    "Invesco S&P Ultra Dividend Revenue ETF",  # RDIV
    "UPAR Ultra Risk Parity ETF",  # UPAR
    "VIX Short-Term Futures ETF",  # VIXY
    "iPath Series B S&P 500 VIX Short-Term Futures ETN",  # VXX
    "MicroSectors FANG  ETNs due January 8, 2038",  # FNGS
    "Invesco QQQ Trust, Series 1",  # QQQ
    "AdvisorShares Dorsey Wright Short ETF",  # DWSH
    "Gotham Short Strategies ETF",  # SHRT
    "Leverage Shares MANGOS ETF",  # MGOL
    "Leverage Shares 100% TSLA AND 100% SPCX Daily ETF",  # ELOL
    "Ranger Equity Bear Bear ETF",  # HDGE
    "Simplify Bond Bull ETF",  # RFIX
    "Miller Value Partners Leverage ETF",  # MVPL
    "Defiance Leveraged Long + Income MSTR ETF",  # MST
    "Inverse VIX Short-Term Futures ETNs due March 22, 2045",  # VYLD
    "TrueShares Quarterly Bear Hedge ETF",  # QBER
    "State Street SPDR S&P 500 ETF Trust",  # SPY
    "iShares Bitcoin Trust ETF",  # IBIT
]

# (listed name, unleveraged reference or None)  # symbol
REFERENCES = [
    ("ProShares UltraPro QQQ", 'QQQ'),  # TQQQ
    ("ProShares UltraPro Short QQQ", 'QQQ'),  # SQQQ
    ("Direxion Daily Semiconductor Bull 3X ETF", 'SOXX'),  # SOXL
    ("Direxion Daily Semiconductor Bear 3X ETF", 'SOXX'),  # SOXS
    ("Direxion Daily TSLA Bull 2X ETF", 'TSLA'),  # TSLL
    ("GraniteShares 2x Long NVDA Daily ETF", 'NVDA'),  # NVDL
    ("T-Rex 2X Long NVIDIA Daily Target ETF", 'NVDA'),  # NVDX
    ("T-REX 2X Long Tesla Daily Target ETF", 'TSLA'),  # TSLT
    ("Defiance Daily Target 2x Long MSTR ETF", 'MSTR'),  # MSTX
    ("ProShares Ultra Gold", 'GLD'),  # UGL
    ("ProShares Ultra Silver", 'SLV'),  # AGQ
    ("ProShares Ultra Bloomberg Crude Oil", 'USO'),  # UCO
    ("ProShares Ultra Bloomberg Natural Gas", 'UNG'),  # BOIL
    ("MAX S&P 500 4X Leveraged ETNs due October 30, 2043", 'SPY'),  # SPYU
    ("ProShares Short S&P500", 'SPY'),  # SH
    ("ProShares UltraPro S&P 500", 'SPY'),  # UPRO
    ("Direxion Daily S&P 500 Bull 3X ETF", 'SPY'),  # SPXL
    ("Direxion Small Cap Bull 3X ETF", 'IWM'),  # TNA
    ("UltraPro Short Dow30", 'DIA'),  # SDOW
    ("Direxion Daily 20-Yr Treasury Bull 3x Shrs", 'TLT'),  # TMF
    ("ProShares UltraShort Lehman 20  Year Treasury", 'TLT'),  # TBT
    ("ProShares UltraPro Short 20 Year Treasury", 'TLT'),  # TTT
    ("ProShares Ultra 7-10 Year Treasury", 'IEF'),  # UST
    ("2x Bitcoin ETF", 'IBIT'),  # BITX
    ("ProShares Short Bitcoin ETF", 'IBIT'),  # BITI
    ("2x Ether ETF", 'ETHA'),  # ETHU
    ("Direxion Daily Gold Miners Index Bull 2X ETF", 'GDX'),  # NUGT
    ("Direxion Daily Junior Gold Miners Index Bull 2X ETF", 'GDXJ'),  # JNUG
    ("Direxion Daily Regional Banks Bull 3X ETF", 'KRE'),  # DPST
    ("Direxion Daily Real Estate Bull 3X ETF", 'XLRE'),  # DRN
    ("Direxion Energy Bull 2X ETF", 'XLE'),  # ERX
    ("Direxion Daily FTSE China Bull 3X ETF", 'FXI'),  # YINN
    ("Direxion Emerging Markets Bull 3X ETF", 'EEM'),  # EDC
    ("Direxion Financial Bull 3X ETF", 'XLF'),  # FAS
    ("Direxion Daily S&P Biotech Bull 3X ETF", 'XBI'),  # LABU
    ("ProShares Ultra Technology", 'XLK'),  # ROM
    ("MicroSectors 3x Long High Yield Corporate Bond (HYG) ETNs", 'HYG'),  # HYGU
    ("MicroSectors FANG+ 3X Leveraged ETNs", 'FNGS'),  # FNGU
    ("Direxion Daily BRKB Bull 2X ETF", 'BRK.B'),  # BRKU
    ("Leverage Shares 2X Long ETN Daily ETF", 'ETN'),  # ETNG
    ("ProShares Ultra SK hynix", 'SKHY'),  # SKHU
    ("Direxion Daily SpaceX Bull 2X ETF", 'SPCX'),  # LOFF
    ("Tradr 1X Short Innovation Daily ETF", 'ARKK'),  # SARK
    ("AdvisorShares MSOS Daily Leveraged ETF", 'MSOS'),  # MSOX
    ("Roundhill T-REX 2X Long DRAM Daily Target ETF", 'DRAM'),  # RAM
    ("DB Gold Double Long ETN due February 15, 2038", 'GLD'),  # DGP
    ("Direxion Daily S&P 500 High Beta Bull 3X ETF", 'SPHB'),  # HIBL
    ("ProShares Ultra S&P 500 Equal Weight", 'RSP'),  # URSP
    ("ProShares Ultra VIX Short Term Futures ETF", None),  # UVXY
    ("-1x Short VIX Futures ETF", None),  # SVIX
    ("MicroSectors 3? Long Artificial Intelligence (AI) ETNs", None),  # AIQU
    ("MicroSectors 3x Long Semiconductor ETNs", None),  # SMHU
    ("Direxion Daily Semiconductors Top 5 Bull 2X ETF", None),  # TSXU
    ("ProShares Ultra QQQ Mega", None),  # QQUP
    ("ProShares Ultra QQQ Equal Weight", None),  # EQQQ
    ("ProShares Ultra XRP ETF", None),  # UXRP
    ("ProShares Ultra Solana ETF", None),  # SLON
    ("21Shares 2x Long HYPE ETF", None),  # TXXH
    ("Tradr 2X Long Innovation 100 Monthly ETF", None),  # MQQQ
    ("Direxion Daily AI and Big Data Bull 2X ETF", None),  # AIBU
    ("MicroSectors U.S. Big Banks 3 Leveraged ETNs due February 17, 2045", None),  # BNKU
    ("Corgi U.S. Large-Cap 2x Daily ETF", None),  # USLX
    ("Corgi Lithography & Semiconductor Photonics 2x Daily ETF", None),  # EUVX
    ("Founder-Led 2X Daily ETF", None),  # FDRX
]
SYMBOLS = frozenset(['AI', 'ARKK', 'BRK.B', 'DIA', 'DRAM', 'EEM', 'ETHA', 'ETN', 'FNGS', 'FXI', 'GDX', 'GDXJ', 'GLD', 'HYG', 'IBIT', 'IEF', 'IWM', 'KRE', 'LINK', 'MSOS', 'MSTR', 'NVDA', 'QQQ', 'RSP', 'SKHY', 'SLV', 'SOL', 'SOXX', 'SPCX', 'SPHB', 'SPY', 'SUI', 'TLT', 'TSLA', 'UNG', 'USO', 'XBI', 'XLE', 'XLF', 'XLK', 'XLRE', 'XRP'])

HEADER = "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares"
LISTING = "\n".join([HEADER, *[
    "Y|TQQQ|ProShares UltraPro QQQ|Q|G|Y|100|N|N||TQQQ|N",
    "Y|FNGD|MicroSectors FANG  Index -3X Inverse Leveraged ETNs due January 8, 2038|P| |N|100|N||FNGD|FNGD|N",
    "Y|BBW|Build-A-Bear Workshop, Inc. Common Stock|N| |N|100|N||BBW|BBW|N",
    "Y|CPZ|Calamos Long/Short Equity & Dynamic Income Trust - Closed End Fund|Q|Q|N|100|N|N||CPZ|N",
    "Y|QQQ|Invesco QQQ Trust, Series 1|Q|G|Y|40|N|N||QQQ|N",
    "Y|SPYU|MAX S&P 500 4X Leveraged ETNs due October 30, 2043|P| |Y|100|N||SPYU|SPYU|N",
    "Y|SH|ProShares Short S&P500|P| |Y|100|N||SH|SH|N",
    "Y|VXX|iPath Series B S&P 500 VIX Short-Term Futures ETN|Z| |N|100|N||VXX|VXX|N",
    "Y|ETNG|Leverage Shares 2X Long ETN Daily ETF|Z| |Y|100|N||ETNG|ETNG|N",
    "Y|ETN|Eaton Corporation, PLC Ordinary Shares|N| |N|40|N||ETN|ETN|N",
    "Y|NVDL|GraniteShares 2x Long NVDA Daily ETF|Q|G|Y|100|N|N||NVDL|N",
    "Y|NVDA|NVIDIA Corporation - Common Stock|Q|Q|N|100|N|N||NVDA|N",
    "Y|QTUP|Defiance Long Pure Quantum ETF|Z| |Y|100|N||QTUP|QTUP|N",
    "Y|BSV|Vanguard Short-Term Bond ETF|P| |Y|100|N||BSV|BSV|N",
    "Y|AIQD|MicroSectors -3? Short Artificial Intelligence (AI) ETNs|P| |Y|100|N||AIQD|AIQD|N",
    "Y|SPY|State Street SPDR S&P 500 ETF Trust|P| |Y|40|N||SPY|SPY|N",
    "Y|ZZZTX|TXSE Test Stk 5 Common Stock|F| |N|40|Y||ZZZTX|ZZZTX|N",
], "File Creation Time: 1111202618:02|||||", ""])


# --- classify ------------------------------------------------------------------------------------------------

def test_the_table_is_large_enough_to_cover_every_family():
    assert len(LEVERAGED) >= 60 and len(NOT_IN_UNIVERSE) >= 15
    assert len({name for name, _ in LEVERAGED}) == len(LEVERAGED)
    assert {multiple for _, multiple in LEVERAGED} == {-3, -2, -1.5, -1, -0.5, 1.25, 1.5, 2, 3, 4}


@pytest.mark.parametrize(("name", "multiple"), LEVERAGED)
def test_classify_reads_the_signed_multiple_from_the_listed_name(name, multiple):
    leverage = universe.classify(name)
    assert leverage is not None and leverage.multiple == multiple
    assert not universe.signals_leverage(name)


@pytest.mark.parametrize("name", NOT_IN_UNIVERSE)
def test_classify_leaves_look_alikes_out(name):
    assert universe.classify(name) is None
    assert not universe.signals_leverage(name)  # a known look-alike is not reported for review either


def test_classify_names_the_rule_that_read_the_multiple():
    assert universe.classify("Direxion Daily Semiconductor Bull 3X ETF") == Leverage(3.0, "explicit")
    assert universe.classify("DB Gold Double Short ETN due February 15, 2038") == Leverage(-2.0, "word")
    assert universe.classify("ProShares UltraPro Short QQQ") == Leverage(-3.0, "family")
    assert universe.classify("DB Gold Short ETN due February 15, 2038") == Leverage(-1.0, "family")
    assert universe.classify("ProShares Ultra VIX Short Term Futures ETF") == Leverage(1.5, "prospectus")


def test_the_multiplication_sign_reads_as_x_also_when_the_directory_sends_a_question_mark():
    assert universe.classify("MicroSectors -3? Short Artificial Intelligence (AI) ETNs").multiple == -3
    assert universe.classify("MicroSectors 3\u00d7 Long Artificial Intelligence (AI) ETNs").multiple == 3
    assert universe.classify("MicroSectors -3\u00d7 Short Artificial Intelligence (AI) ETNs").multiple == -3
    # a question mark that does not follow a digit, or that is inside a word, is not a multiple
    assert universe.classify("State Street SPDR Bloomberg 1a??10 Year TIPS ETF") is None


@pytest.mark.parametrize("name", [
    "Vanguard Ultra-Short Bond ETF", "PIMCO Ultra Short Government Active Exchange-Traded Fund",
    "Dimensional Ultrashort Fixed Income ETF", "Vanguard Short-Term Bond ETF", "BNY Mellon Municipal Short Duration ETF",
    "iShares Short Maturity Municipal Bond Active ETF", "Vanguard Long-Term Bond ETF", "VanEck Short Muni ETF",
])
def test_bond_maturity_words_are_not_direction_words(name):
    assert universe.classify(name) is None and not universe.signals_leverage(name)


def test_one_times_long_is_not_leveraged_and_one_times_inverse_is():
    assert universe.classify("IncomeSTKd 1x Bitcoin & 1x Gold Premium ETF") is None
    assert universe.classify("Example 1X Long NVDA Daily ETF") is None
    assert universe.classify("Direxion Daily S&P 500 Bear 1X ETF").multiple == -1
    assert universe.classify("Tradr 1X Short Innovation Daily ETF").multiple == -1
    assert universe.classify("-1x Short VIX Futures ETF").multiple == -1


@pytest.mark.parametrize("name", [
    "Defiance Long Pure Quantum ETF",  # QTUP, listed: a direction word and no multiple
    "Example Daily Leveraged Growth ETF",  # invented: "Leveraged" and no multiple
    "Example Inverse Cannabis ETF",  # invented: "Inverse" is not read as -1 (VYLD shows why)
    "Example Semiconductor Bull ETF",  # invented
    "Example 2X Long TSLA 3X Long NVDA ETF",  # invented: two multiples
    "Example 2X Long Bear Market ETF",  # invented: the long word and the bear word disagree
    "Example 7X Long QQQ Daily ETF",  # invented: outside the range of the document contract
    "Example Short Tesla ETF",  # invented
])
def test_a_name_that_signals_leverage_without_a_readable_multiple_is_reported_not_guessed(name):
    assert universe.classify(name) is None
    assert universe.signals_leverage(name)


def test_a_multiple_needs_its_own_token():
    assert universe.classify("Example S3X Growth ETF") is None  # part of a word
    assert universe.classify("Example 10X Genomics ETF") is None  # two digits
    assert universe.classify("Example 2xy ETF") is None  # a lower-case letter follows
    assert universe.classify("ETRACS Monthly Pay 2xLeveraged US High Dividend Low Volatility ETN Series B due September 30, 2044").multiple == 2
    assert universe.classify("MAX S&P 500 4X Leveraged ETNs due October 30, 2043").multiple == 4  # not 500


# --- underlying_of -------------------------------------------------------------------------------------------

@pytest.mark.parametrize(("name", "reference"), REFERENCES)
def test_underlying_of_maps_the_name_to_the_unleveraged_reference(name, reference):
    assert universe.underlying_of(name, SYMBOLS) == reference


def test_a_ticker_in_the_name_counts_only_when_it_is_listed():
    name = "Direxion Daily TSLA Bull 2X ETF"
    assert universe.underlying_of(name, SYMBOLS) == "TSLA"
    assert universe.underlying_of(name, SYMBOLS - {"TSLA"}) is None
    assert universe.underlying_of(name) is None  # without a directory the ticker cannot be checked


def test_a_twin_from_the_tables_counts_only_when_it_is_listed():
    assert universe.underlying_of("ProShares UltraPro QQQ") == "QQQ"
    assert universe.underlying_of("ProShares UltraPro QQQ", SYMBOLS - {"QQQ"}) is None
    assert universe.underlying_of("T-Rex 2X Long NVIDIA Daily Target ETF") == "NVDA"
    assert universe.underlying_of("T-Rex 2X Long NVIDIA Daily Target ETF", SYMBOLS - {"NVDA"}) is None


def test_a_token_that_is_also_a_listed_symbol_is_not_taken_for_the_reference():
    assert {"AI", "SOL", "LINK", "SUI", "XRP"} <= SYMBOLS
    assert universe.underlying_of("MicroSectors 3? Long Artificial Intelligence (AI) ETNs", SYMBOLS) is None  # not C3.ai
    assert universe.underlying_of("Direxion Daily AI and Big Data Bull 2X ETF", SYMBOLS) is None
    assert universe.underlying_of("ProShares Ultra XRP ETF", SYMBOLS) is None
    assert universe.underlying_of("21Shares 2x Long Sui ETF", SYMBOLS) is None  # not Sun Communities
    assert universe.underlying_of("2x Chainlink ETF", SYMBOLS) is None


def test_subject_of_strips_issuer_multiple_direction_and_product_words():
    assert universe.subject_of("Direxion Daily Semiconductor Bull 3X ETF") == "Semiconductor"
    assert universe.subject_of("ProShares UltraShort Lehman 20  Year Treasury") == "Lehman 20 Year Treasury"
    assert universe.subject_of("Leverage Shares 2X Long ETN Daily ETF") == "ETN"
    assert universe.subject_of("MAX S&P 500 4X Leveraged ETNs due October 30, 2043") == "S&P 500"
    assert universe.subject_of("Corgi U.S. Technology 2x Daily ETF") == "Technology"
    assert universe.subject_of("ProShares Ultra Copper K-1 Free ETF") == "Copper"


# --- the directory -------------------------------------------------------------------------------------------

def test_parse_listing_reads_the_rows_and_skips_the_file_creation_line():
    rows = universe.parse_listing(LISTING)
    assert len(rows) == 17
    assert rows[0]["Symbol"] == "TQQQ" and rows[0]["Security Name"] == "ProShares UltraPro QQQ" and rows[0]["ETF"] == "Y"
    assert universe.parse_listing("") == []


def test_listed_funds_keeps_the_leveraged_products_sorted_by_symbol():
    funds = universe.listed_funds(universe.parse_listing(LISTING))
    assert [fund.symbol for fund in funds] == ["AIQD", "ETNG", "FNGD", "NVDL", "SH", "SPYU", "TQQQ"]
    by_symbol = {fund.symbol: fund for fund in funds}
    assert by_symbol["TQQQ"] == ListedFund("TQQQ", "ProShares UltraPro QQQ", "etf", 3.0, "QQQ", "NASDAQ")
    assert by_symbol["SH"] == ListedFund("SH", "ProShares Short S&P500", "etf", -1.0, "SPY", "NYSE Arca")
    assert by_symbol["NVDL"].underlying == "NVDA" and by_symbol["NVDL"].leverage == 2
    # a note that the directory marks ETF = N is in the universe, as an ETN
    assert by_symbol["FNGD"].product_type == "etn" and by_symbol["FNGD"].leverage == -3
    assert (by_symbol["SPYU"].product_type, by_symbol["SPYU"].leverage, by_symbol["SPYU"].underlying) == ("etn", 4, "SPY")
    # a fund on the stock ETN (Eaton) is a fund, not a note
    assert (by_symbol["ETNG"].product_type, by_symbol["ETNG"].underlying, by_symbol["ETNG"].listing_exchange) == ("etf", "ETN", "Cboe BZX")
    assert by_symbol["AIQD"].underlying is None


def test_listed_funds_ignores_stocks_closed_end_funds_unleveraged_notes_and_test_issues():
    rows = universe.parse_listing(LISTING)
    symbols = {fund.symbol for fund in universe.listed_funds(rows)}
    assert not symbols & {"BBW", "CPZ", "QQQ", "SPY", "VXX", "ETN", "NVDA", "BSV", "QTUP", "ZZZTX"}
    as_test_issue = [{**row, "Test Issue": "Y"} if row["Symbol"] == "TQQQ" else row for row in rows]
    assert "TQQQ" not in {fund.symbol for fund in universe.listed_funds(as_test_issue)}


def test_unclassified_reports_products_only():
    rows = universe.parse_listing(LISTING)
    # Build-A-Bear (a stock) has the word "Bear"; it is not a product, so it is not reported
    assert universe.unclassified(rows) == [("QTUP", "Defiance Long Pure Quantum ETF")]


def test_product_type():
    assert universe.product_type("MicroSectors FANG+ 3X Leveraged ETNs") == "etn"
    assert universe.product_type("MicroSectors Gold Miners 3X Leveraged ETN") == "etn"
    assert universe.product_type("iPath Series B Carbon Exchange-Traded Notes") == "etn"
    assert universe.product_type("Leverage Shares 2X Long ETN Daily ETF") == "etf"
    assert universe.product_type("ProShares UltraPro QQQ") == "etf"


# --- gate ----------------------------------------------------------------------------------------------------

QUOTED = datetime(2026, 11, 12, 15, 30, tzinfo=UTC)  # Thursday 10:30 New York


def measured(**changes) -> OptionsMeasure:
    base = {"quoted_at": QUOTED, "session": "regular", "spot": 58.65, "nearest_expiries": ("2026-11-13", "2026-11-18"),
            "window_expiry": "2026-11-18", "total_open_interest": 123456, "band_open_interest": 23456, "half_spread_pct": 1.2}
    return OptionsMeasure(**{**base, **changes})


NO_WINDOW = {"window_expiry": None, "band_open_interest": None, "half_spread_pct": None}


@pytest.mark.parametrize(("changes", "label", "reasons"), [
    ({}, "pass", []),
    ({"band_open_interest": 1000, "half_spread_pct": 4.0}, "pass", []),  # both limits are inclusive
    ({"band_open_interest": 999}, "fail", ["open-interest-below-minimum"]),
    ({"half_spread_pct": 4.0001}, "fail", ["spread-above-maximum"]),
    ({"half_spread_pct": None}, "fail", ["no-two-sided-quote"]),
    ({"band_open_interest": 0, "half_spread_pct": None}, "fail", ["open-interest-below-minimum", "no-two-sided-quote"]),
    ({"band_open_interest": 10, "half_spread_pct": 9.5}, "fail", ["open-interest-below-minimum", "spread-above-maximum"]),
    (NO_WINDOW, "fail", ["no-window-expiry", "no-two-sided-quote"]),
    # closed session: the spread is not judged
    ({"session": "closed"}, "spread-not-measured", ["market-closed-at-quote"]),
    ({"session": "closed", "half_spread_pct": 40.0}, "spread-not-measured", ["market-closed-at-quote"]),
    ({"session": "closed", "half_spread_pct": None}, "spread-not-measured", ["market-closed-at-quote"]),
    ({"session": "closed", "band_open_interest": 999, "half_spread_pct": 40.0}, "fail", ["open-interest-below-minimum"]),
    ({"session": "closed", **NO_WINDOW}, "fail", ["no-window-expiry"]),
])
def test_gate_truth_table(changes, label, reasons):
    assert liquidity.gate(measured(**changes)) == (label, reasons)


def test_gate_without_listed_options():
    assert liquidity.gate(None) == ("fail", ["no-listed-options"])


def test_gate_constants_and_reasons_are_the_contract():
    assert GATE == {"version": 1, "minWindowDays": 5, "maxWindowDays": 21, "bandPct": 10, "minBandOpenInterest": 1000,
                    "maxHalfSpreadPct": 4}
    assert list(GATE) == ["version", "minWindowDays", "maxWindowDays", "bandPct", "minBandOpenInterest", "maxHalfSpreadPct"]
    assert liquidity.REASONS == ("no-listed-options", "no-window-expiry", "open-interest-below-minimum",
                                 "no-two-sided-quote", "spread-above-maximum", "market-closed-at-quote")


# --- measure -------------------------------------------------------------------------------------------------

TODAY = date(2026, 11, 12)


def option(expiry: date, kind: str, strike: float, bid: float = 0.0, ask: float = 0.0, oi: int = 0, root: str = "TQQQ") -> dict:
    return {"option": f"{root}{expiry:%y%m%d}{kind}{round(strike * 1000):08d}", "bid": bid, "ask": ask,
            "open_interest": float(oi), "volume": 0.0, "iv": 0.5, "last_trade_time": None}


def chain(options: list, spot: float = 100.0, timestamp: str = "2026-11-12 15:30:00",
          last_trade: str | None = "2026-11-12T10:29:30", symbol: str = "TQQQ") -> dict:
    return {"timestamp": timestamp, "symbol": symbol,
            "data": {"symbol": symbol, "current_price": spot, "close": spot, "last_trade_time": last_trade, "options": options}}


def day(offset: int) -> date:
    return TODAY + timedelta(days=offset)


@pytest.mark.parametrize(("offsets", "window"), [
    ((1, 4, 5, 8, 21, 22), 5),  # the 5-day edge is inside, 4 days is not
    ((1, 4, 21, 22), 21),  # the 21-day edge is inside
    ((0, 4, 22, 50), None),  # nothing between 5 and 21 days
    ((6, 7, 14), 6),  # the nearest one inside the window
])
def test_measure_picks_the_nearest_expiry_inside_the_window(offsets, window):
    result = liquidity.measure(chain([option(day(offset), "C", 100, 1.0, 1.1, 10) for offset in offsets]), TODAY)
    assert result.window_expiry == (day(window).isoformat() if window is not None else None)
    assert result.nearest_expiries == tuple(day(offset).isoformat() for offset in offsets[:4])
    assert result.total_open_interest == 10 * len(offsets)
    if window is None:
        assert result.band_open_interest is None and result.half_spread_pct is None


def test_measure_band_open_interest_counts_calls_and_puts_within_ten_percent_of_spot_at_the_window_expiry():
    window, other = day(7), day(14)
    options = [
        option(window, "C", 89, oi=1), option(window, "P", 89.99, oi=2),  # outside the band
        option(window, "C", 90, oi=4), option(window, "P", 90, oi=8),  # the lower edge is inside
        option(window, "C", 100, oi=16), option(window, "P", 105, oi=32),
        option(window, "C", 110, oi=64), option(window, "P", 110, oi=128),  # the upper edge is inside
        option(window, "C", 110.01, oi=256), option(window, "P", 111, oi=512),  # outside the band
        option(other, "C", 100, oi=1024),  # another expiry
        option(window, "C", 100, oi=2048, root="TQQQ1"),  # an adjusted contract after a split
    ]
    result = liquidity.measure(chain(options), TODAY)
    assert result.window_expiry == window.isoformat()
    assert result.band_open_interest == 4 + 8 + 16 + 32 + 64 + 128
    assert result.total_open_interest == 1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 512 + 1024


def test_measure_half_spread_is_the_median_over_the_two_sided_quotes_of_the_four_strikes_nearest_spot():
    window = day(7)
    options = [
        # the four strikes nearest to spot 100: 100, 95, 105 and, of the two at distance 10, the lower one (90)
        option(window, "C", 100, 9.9, 10.1), option(window, "P", 100, 9.8, 10.2),  # 1% and 2%
        option(window, "C", 95, 9.7, 10.3), option(window, "P", 95, 0.0, 5.0),  # 3%; no bid: ignored
        option(window, "C", 105, 9.0, 11.0), option(window, "P", 105, 2.0, 2.0),  # 10%; ask = bid: ignored
        option(window, "C", 90, 0.0, 0.0), option(window, "P", 90, 3.0, 2.5),  # no quote and a crossed quote: ignored
        option(window, "C", 110, 4.99, 5.01), option(window, "P", 110, 4.99, 5.01),  # the fifth strike: not read
        option(day(14), "C", 100, 1.0, 3.0),  # another expiry
        option(window, "C", 100, 1.0, 9.0, root="TQQQ2"),  # an adjusted contract
    ]
    result = liquidity.measure(chain(options), TODAY)
    assert result.half_spread_pct == pytest.approx(2.5)  # median of 1, 2, 3 and 10


def test_measure_half_spread_is_none_without_a_two_sided_quote():
    window = day(7)
    result = liquidity.measure(chain([option(window, "C", 100, 0.0, 1.0, 5000), option(window, "P", 100, 0.0, 0.0, 5000)]), TODAY)
    assert result.half_spread_pct is None and result.band_open_interest == 10000
    assert liquidity.gate(result) == ("fail", ["no-two-sided-quote"])


def test_measure_reads_the_chain_time_the_spot_and_the_quote_day():
    result = liquidity.measure(chain([option(day(0), "C", 60), option(day(6), "P", 60, 1.0, 1.02, 1500)], spot=58.6501))
    assert result.quoted_at == QUOTED and result.spot == 58.6501 and result.session == "regular"
    assert result.nearest_expiries == ("2026-11-12", "2026-11-18")  # an expiry on the quote day counts
    assert liquidity.gate(result) == ("pass", [])
    # 01:05 UTC is 20:05 New York of the day before: that day is the quote day
    late = liquidity.measure(chain([option(day(-1), "C", 60), option(day(4), "C", 60)], timestamp="2026-11-12 01:05:00",
                                   last_trade="2026-11-11T15:59:59"))
    assert late.session == "closed" and late.nearest_expiries == ("2026-11-11", "2026-11-16")
    assert late.window_expiry == "2026-11-16"  # 5 days after 2026-11-11


def test_measure_is_none_without_a_standard_contract_on_or_after_the_quote_day():
    assert liquidity.measure(chain([]), TODAY) is None
    assert liquidity.measure(chain([option(day(-1), "C", 100, oi=5)]), TODAY) is None
    assert liquidity.measure(chain([option(day(7), "C", 100, oi=5, root="TQQQ1")]), TODAY) is None


def test_measure_reads_a_share_class_symbol_and_falls_back_to_the_close_price():
    options = [option(day(7), "C", 500, 1.0, 1.1, 7, root="BRKB")]
    result = liquidity.measure(chain(options, spot=500.0, symbol="BRK.B"), TODAY)
    assert result.total_open_interest == 7
    no_price = chain([option(day(7), "C", 100, oi=3)])
    no_price["data"]["current_price"] = 0.0
    assert liquidity.measure(no_price, TODAY).spot == 100.0  # the close
    no_price["data"]["close"] = None
    with pytest.raises(ValueError, match="no positive price"):
        liquidity.measure(no_price, TODAY)


def new_york(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=liquidity.NEW_YORK)


@pytest.mark.parametrize(("quoted", "last_trade", "session"), [
    ("2026-11-12T10:30:00", "2026-11-12T10:29:00", "regular"),
    ("2026-11-12T09:44:59", "2026-11-12T09:44:00", "closed"),  # before 09:45
    ("2026-11-12T09:45:00", "2026-11-12T09:44:00", "regular"),
    ("2026-11-12T15:59:59", "2026-11-12T15:59:00", "regular"),
    ("2026-11-12T16:00:00", "2026-11-12T15:59:59", "closed"),  # the close
    ("2026-11-12T20:05:00", "2026-11-12T15:59:59", "closed"),
    ("2026-11-14T10:30:00", "2026-11-14T10:29:00", "closed"),  # Saturday
    ("2026-11-12T10:30:00", "2026-11-12T10:10:00", "regular"),  # 20 minutes old
    ("2026-11-12T10:30:00", "2026-11-12T10:09:59", "closed"),  # older: a holiday, a half day or a halt
    ("2026-11-26T10:30:00", "2026-11-25T15:59:59", "closed"),  # Thanksgiving: a weekday without trades
    ("2026-07-15T10:00:00", "2026-07-15T09:59:00", "regular"),  # summer time
    ("2026-11-12T10:30:00", None, "closed"),
])
def test_session_rule(quoted, last_trade, session):
    assert liquidity.session_of(new_york(quoted).astimezone(UTC), new_york(last_trade) if last_trade else None) == session


def test_session_from_the_chain_fields():
    assert liquidity.measure(chain([option(day(7), "C", 100)], last_trade="2026-11-12T10:05:00"), TODAY).session == "closed"
    assert liquidity.measure(chain([option(day(7), "C", 100)], last_trade=None), TODAY).session == "closed"
    assert liquidity.last_trade_time(chain([])) == new_york("2026-11-12T10:29:30")
    assert liquidity.quote_time(chain([])) == QUOTED


# --- document ------------------------------------------------------------------------------------------------

TQQQ = ListedFund("TQQQ", "ProShares UltraPro QQQ", "etf", 3.0, "QQQ", "NASDAQ")
SPYU = ListedFund("SPYU", "MAX S&P 500 4X Leveraged ETNs due October 30, 2043", "etn", 4.0, "SPY", "NYSE Arca")
NVDS = ListedFund("NVDS", "Tradr 1.5X Short NVDA Daily ETF", "etf", -1.5, "NVDA", "NASDAQ")
UVXY = ListedFund("UVXY", "ProShares Ultra VIX Short Term Futures ETF", "etf", 1.5, None, "Cboe BZX")
GENERATED = datetime(2026, 11, 12, 1, 40, 11, 530460, tzinfo=UTC)


def test_document_matches_the_contract():
    document = liquidity.document([(UVXY, measured(session="closed")), (TQQQ, measured()), (SPYU, None), (NVDS, measured(**NO_WINDOW))],
                                  GENERATED)
    assert list(document) == ["schema", "generatedAt", "gate", "funds"]
    assert document["schema"] == "leveraged-etf-universe-v1" and document["generatedAt"] == "2026-11-12T01:40:11Z"
    assert document["gate"] == GATE and document["gate"] is not GATE
    assert [fund["symbol"] for fund in document["funds"]] == ["NVDS", "SPYU", "TQQQ", "UVXY"]
    for fund in document["funds"]:
        assert list(fund) == ["symbol", "name", "productType", "leverage", "underlying", "listingExchange", "optionsListed",
                              "options", "optionGate", "optionGateReasons"]
        assert fund["productType"] in ("etf", "etn") and fund["optionGate"] in ("pass", "fail", "spread-not-measured")
        assert set(fund["optionGateReasons"]) <= set(liquidity.REASONS)
        assert (fund["options"] is None) == (fund["optionsListed"] is False)
        if fund["options"] is not None:
            assert list(fund["options"]) == ["quotedAt", "session", "spot", "nearestExpiries", "windowExpiry", "totalOpenInterest",
                                             "bandOpenInterest", "halfSpreadPct"]
            assert fund["options"]["session"] in ("regular", "closed")
            assert (fund["options"]["bandOpenInterest"] is None) == (fund["options"]["windowExpiry"] is None)
    nvds, spyu, tqqq, uvxy = document["funds"]
    assert tqqq == {
        "symbol": "TQQQ", "name": "ProShares UltraPro QQQ", "productType": "etf", "leverage": 3, "underlying": "QQQ",
        "listingExchange": "NASDAQ", "optionsListed": True,
        "options": {"quotedAt": "2026-11-12T15:30:00Z", "session": "regular", "spot": 58.65,
                    "nearestExpiries": ["2026-11-13", "2026-11-18"], "windowExpiry": "2026-11-18", "totalOpenInterest": 123456,
                    "bandOpenInterest": 23456, "halfSpreadPct": 1.2},
        "optionGate": "pass", "optionGateReasons": []}
    assert (spyu["productType"], spyu["leverage"], spyu["optionsListed"], spyu["options"]) == ("etn", 4, False, None)
    assert (spyu["optionGate"], spyu["optionGateReasons"]) == ("fail", ["no-listed-options"])
    assert (nvds["leverage"], nvds["optionGate"], nvds["optionGateReasons"]) == (-1.5, "fail", ["no-window-expiry", "no-two-sided-quote"])
    assert (uvxy["underlying"], uvxy["optionGate"], uvxy["optionGateReasons"]) == (None, "spread-not-measured", ["market-closed-at-quote"])
    # whole multiples are written as integers, as in the contract example
    assert '"leverage": 3,' in json.dumps(document) and '"leverage": -1.5,' in json.dumps(document)


def test_document_refuses_what_the_contract_forbids():
    with pytest.raises(ValueError, match="1 to 2000 funds"):
        liquidity.document([], GENERATED)
    with pytest.raises(ValueError, match="listed twice: TQQQ"):
        liquidity.document([(TQQQ, None), (SPYU, None), (TQQQ, measured())], GENERATED)
    with pytest.raises(ValueError, match="without a time zone"):
        liquidity.document([(TQQQ, None)], datetime(2026, 11, 12, 1, 40))
    for wrong in (ListedFund("tqqq", "x", "etf", 3.0, None, "NASDAQ"), ListedFund("TQQQ$", "x", "etf", 3.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "", "etf", 3.0, None, "NASDAQ"), ListedFund("TQQQ", "x" * 201, "etf", 3.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "fund", 3.0, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 1.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "etf", 0.0, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 6.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "etf", -5.5, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 3.0, None, "")):
        with pytest.raises(ValueError):
            liquidity.fund_entry(wrong, None)
    assert liquidity.fund_entry(ListedFund("BRK.B", "x", "etf", -5.0, None, "NYSE"), None)["leverage"] == -5


# --- the fetcher (research/backtests/leveraged-etf/universe.py) -----------------------------------------------

def url_of(symbol: str) -> str:
    return cli.CHAIN_URL.format(symbol=symbol)


def body_of(symbol: str, spot: float = 100.0, oi: int = 5000) -> bytes:
    window = day(7)
    options = [option(window, "C", spot, 1.0, 1.02, oi, root=symbol), option(window, "P", spot, 1.0, 1.02, oi, root=symbol)]
    return json.dumps(chain(options, spot=spot, symbol=symbol)).encode()


class FakeCboe:
    """`fetch(url)` of the fetcher: a chain per symbol, NoFile for a symbol without one, or a planned error."""

    def __init__(self, chains: dict, errors: dict | None = None):
        self.chains, self.errors, self.calls = chains, errors or {}, []

    def __call__(self, url: str) -> bytes:
        symbol = url.rsplit("/", 1)[1].removesuffix(".json")
        self.calls.append(symbol)
        if symbol in self.errors:
            raise self.errors[symbol]
        if symbol not in self.chains:
            raise cli.NoFile(url)
        return self.chains[symbol]


WITH_OPTIONS = ("SPY", "QQQ", "NVDA", "ETN", "TQQQ", "NVDL", "SH", "ETNG")  # AIQD, FNGD and SPYU have no chain file


def run(fetch, **options):
    out, log = io.StringIO(), []
    code = cli.collect(fetch, GENERATED, LISTING, out=out, log=lambda *parts: log.append(" ".join(map(str, parts))),
                       delay=0, **options)
    return code, out.getvalue(), log


def test_collect_prints_the_document_and_a_summary():
    fetch = FakeCboe({symbol: body_of(symbol) for symbol in WITH_OPTIONS} | {"SH": body_of("SH", oi=10)})
    code, out, log = run(fetch)
    assert code == 0
    document = json.loads(out)
    assert document["generatedAt"] == "2026-11-12T01:40:11Z" and document["gate"] == GATE
    funds = {fund["symbol"]: fund for fund in document["funds"]}
    assert list(funds) == ["AIQD", "ETNG", "FNGD", "NVDL", "SH", "SPYU", "TQQQ"]
    assert funds["TQQQ"]["optionGate"] == "pass" and funds["TQQQ"]["options"]["bandOpenInterest"] == 10000
    assert (funds["SH"]["optionGate"], funds["SH"]["optionGateReasons"]) == ("fail", ["open-interest-below-minimum"])
    assert (funds["SPYU"]["optionsListed"], funds["SPYU"]["optionGateReasons"]) == (False, ["no-listed-options"])
    # the control symbol is read before and after the funds; without --save-chains no reference chain is read
    assert fetch.calls[0] == "SPY" and fetch.calls[-1] == "SPY"
    assert sorted(fetch.calls[1:-1]) == ["AIQD", "ETNG", "FNGD", "NVDL", "SH", "SPYU", "TQQQ"]
    text = "\n".join(log)
    assert "directory: 17 rows, 7 leveraged or inverse products (etf: 4, etn: 3)" in text
    assert "by leverage: -3: 2, -1: 1, 2: 2, 3: 1, 4: 1" in text
    assert "unclassified names (the name signals leverage, no rule reads a multiple): 1" in text
    assert "  QTUP  Defiance Long Pure Quantum ETF" in text
    assert "fetch failures of funds: 0" in text and "options listed: yes 4, no 3" in text
    assert "by gate label: fail: 4, pass: 3" in text
    assert "by gate reason: no-listed-options: 3, open-interest-below-minimum: 1" in text


def test_collect_writes_nothing_when_a_fund_chain_fails():
    fetch = FakeCboe({symbol: body_of(symbol) for symbol in WITH_OPTIONS}, {"NVDL": TimeoutError("timed out")})
    code, out, log = run(fetch)
    assert code == 1 and out == ""
    assert "  NVDL  TimeoutError: timed out" in log and any("would be partial" in line for line in log)


def test_collect_writes_nothing_when_a_chain_cannot_be_measured():
    broken = {"TQQQ": b"<html>not json</html>", "NVDL": json.dumps({"timestamp": "2026-11-12 15:30:00", "data": {}}).encode()}
    code, out, log = run(FakeCboe({symbol: body_of(symbol) for symbol in WITH_OPTIONS} | broken))
    assert code == 1 and out == ""
    assert any(line.startswith("  TQQQ  JSONDecodeError") for line in log)


def test_collect_allow_missing_leaves_the_fund_out_and_names_it():
    fetch = FakeCboe({symbol: body_of(symbol) for symbol in WITH_OPTIONS}, {"NVDL": TimeoutError("timed out")})
    code, out, log = run(fetch, allow_missing=True)
    assert code == 0
    assert [fund["symbol"] for fund in json.loads(out)["funds"]] == ["AIQD", "ETNG", "FNGD", "SH", "SPYU", "TQQQ"]
    assert "  NVDL  TimeoutError: timed out" in log and "funds in the document: 6 (1 left out)" in log


@pytest.mark.parametrize("control", [None, b'{"data": {"options": []}}', TimeoutError("timed out")])
def test_collect_stops_when_the_control_chain_cannot_be_read(control):
    chains = {symbol: body_of(symbol) for symbol in WITH_OPTIONS if symbol != "SPY"}
    errors = {"SPY": control} if isinstance(control, Exception) else {}
    if isinstance(control, bytes):
        chains["SPY"] = control
    fetch = FakeCboe(chains, errors)
    code, out, log = run(fetch)
    assert code == 1 and out == "" and fetch.calls == ["SPY"]  # no fund was read
    assert any(line.startswith("error:") and "SPY" in line for line in log)


def test_collect_stops_when_the_control_chain_is_refused_after_the_funds():
    class Blocked(FakeCboe):
        def __call__(self, url: str) -> bytes:
            if len(self.calls) >= 1:  # after the first control read, the store refuses every file
                self.calls.append("refused")
                raise cli.NoFile(url)
            return super().__call__(url)

    code, out, log = run(Blocked({symbol: body_of(symbol) for symbol in WITH_OPTIONS}))
    assert code == 1 and out == ""  # else every fund would read as "no listed options"


def test_collect_saves_the_raw_chains_of_the_funds_and_of_their_references(tmp_path):
    fetch = FakeCboe({symbol: body_of(symbol) for symbol in WITH_OPTIONS}, {"NVDA": TimeoutError("timed out")})
    code, out, log = run(fetch, save_chains=tmp_path / "chains")
    assert code == 0 and len(json.loads(out)["funds"]) == 7  # a reference chain that fails does not stop the run
    saved = sorted(path.name for path in (tmp_path / "chains").iterdir())
    assert saved == ["ETN.json", "ETNG.json", "NVDL.json", "QQQ.json", "SH.json", "SPY.json", "TQQQ.json"]
    assert (tmp_path / "chains" / "TQQQ.json").read_bytes() == body_of("TQQQ")
    assert "reference chains not saved: 1" in log and "  NVDA  TimeoutError: timed out" in log
    assert f"chains saved: 7 in {tmp_path / 'chains'}" in log


def http_error(code: int, body: bytes, **headers: str) -> urllib.error.HTTPError:
    message = Message()
    for name, value in headers.items():
        message[name.replace("_", "-")] = value
    return urllib.error.HTTPError("https://example.invalid/x.json", code, "error", message, io.BytesIO(body))


def test_http_get_reads_access_denied_as_no_file_and_tries_other_errors_three_times(monkeypatch):
    waits, replies = [], []
    monkeypatch.setattr(cli.clock, "sleep", waits.append)

    def urlopen(request, timeout):
        assert request.get_header("User-agent") == cli.USER_AGENT and timeout == cli.TIMEOUT
        raise replies.pop(0)

    monkeypatch.setattr(cli, "urlopen", urlopen)
    replies[:] = [http_error(403, b"<Error><Code>AccessDenied</Code></Error>")]
    with pytest.raises(cli.NoFile):
        cli.http_get("https://example.invalid/x.json")
    assert waits == []  # "no file" is an answer: it is not tried again
    replies[:] = [http_error(403, b"<html>blocked</html>"), http_error(503, b""), TimeoutError("timed out")]
    with pytest.raises(TimeoutError):
        cli.http_get("https://example.invalid/x.json")
    assert replies == [] and waits == [2, 4]


def test_http_get_reads_a_gzip_packed_access_denied_and_waits_longer_after_a_rate_limit(monkeypatch):
    # The real run of 2026-11-12 failed on both: Cboe packs the AccessDenied document when gzip is asked for,
    # and it answers HTTP 429 when the requests come too fast.
    waits, replies = [], []
    monkeypatch.setattr(cli.clock, "sleep", waits.append)

    def urlopen(request, timeout):
        raise replies.pop(0)

    monkeypatch.setattr(cli, "urlopen", urlopen)
    replies[:] = [http_error(403, gzip.compress(b"<Error><Code>AccessDenied</Code></Error>"), Content_Encoding="gzip")]
    with pytest.raises(cli.NoFile):
        cli.http_get("https://example.invalid/x.json")
    assert waits == []
    replies[:] = [http_error(429, b"", Retry_After="7"), http_error(429, b""), http_error(429, b"")]
    with pytest.raises(urllib.error.HTTPError):
        cli.http_get("https://example.invalid/x.json")
    assert replies == [] and waits == [7, 60]
    assert cli.rate_limit_wait({"Retry-After": "900"}, 0) == cli.MAX_RETRY_AFTER == 120
    assert cli.rate_limit_wait({}, 0) == 30 and cli.rate_limit_wait({"Retry-After": "Wed, 21 Oct 2026"}, 1) == 60
    assert cli.unpacked(b"not gzip", {"Content-Encoding": "gzip"}) == b"not gzip"
    assert cli.unpacked(b"plain", {}) == b"plain"


def test_http_get_returns_the_body_and_unpacks_gzip(monkeypatch):

    class Reply:
        def __init__(self, body, encoding):
            self.body, self.headers = body, {"Content-Encoding": encoding} if encoding else {}

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return self.body

    monkeypatch.setattr(cli, "urlopen", lambda request, timeout: Reply(gzip.compress(b'{"a": 1}'), "gzip"))
    assert cli.http_get("https://example.invalid/x.json") == b'{"a": 1}'
    monkeypatch.setattr(cli, "urlopen", lambda request, timeout: Reply(b"plain", None))
    assert cli.http_get("https://example.invalid/x.json") == b"plain"
