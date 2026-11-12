"""Leveraged ETF universe: the name classifier, the unleveraged reference, the option gate, the chain measure,
the universe document and the fetcher of research/backtests/leveraged-etf (fakes only, no network).

The names are real listed names from the Nasdaq Trader symbol directory of 2026-11-11, with their spelling
(double spaces, "?" for a multiplication sign that the directory cannot encode).

tests/fixtures/leveraged_etf/universe-document.json is the document that `fixture_document` below builds.
scripts/leveraged-etf-universe/document.test.ts passes the same file through the Zod schema of the import,
so the Python rule and the TypeScript rule cannot drift apart. Write it again after a rule change:
    cd services/research && python -m tests.test_leveraged_etf_universe
    bunx --bun --no-install biome format --write services/research/tests/fixtures/leveraged_etf
"""

import gzip
import importlib.util
import io
import json
import subprocess
import sys
import threading
import time
import urllib.error
from datetime import UTC, date, datetime, timedelta
from email.message import Message
from pathlib import Path

import pytest

from strategies.leveraged_etf import liquidity, universe
from strategies.leveraged_etf.liquidity import GATE, OptionsMeasure
from strategies.leveraged_etf.universe import Leverage, ListedFund

SCRIPT = Path(__file__).resolve().parents[3] / "research" / "backtests" / "leveraged-etf" / "universe.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "leveraged_etf"


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
    ("Roundhill NVDA WeeklyPay ETF", 1.2),  # NVDW
    ("Roundhill BRKB WeeklyPay ETF", 1.2),  # BRKW
    ("Roundhill GOOGL WeeklyPay ETF", 1.2),  # GOOW
    ("Roundhill Gold WeeklyPay ETF", 1.2),  # GLDW
    ("Roundhill Gold Miners WeeklyPay ETF", 1.2),  # GDXW
    ("Roundhill Treasury Bond WeeklyPay ETF", 1.2),  # TSYW
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
    "Corgi U.S. Equities 100% Structured Buffer ETF - August Series",  # HAUG: one percentage, a buffer fund
    "KraneShares 100% KWEB Defined Outcome January 2027 ETF",  # KPRO: one percentage
    "JPMorgan 100% U.S. Treasury Securities Money Market ETF",  # JMMF
    "CYBER HORNET S&P 500 and Bitcoin 75/25 Strategy ETF",  # BBB: two parts of 100% in total
    "Tuttle Capital Memory Stack Income Blast ETF",  # DRMP: a "stack" of memory chips
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
    "Ranger Equity Bear Bear ETF",  # HDGE
    "Simplify Bond Bull ETF",  # RFIX
    "Miller Value Partners Leverage ETF",  # MVPL
    "Defiance Leveraged Long + Income MSTR ETF",  # MST
    "Inverse VIX Short-Term Futures ETNs due March 22, 2045",  # VYLD
    "TrueShares Quarterly Bear Hedge ETF",  # QBER
    "State Street SPDR S&P 500 ETF Trust",  # SPY
    "iShares Bitcoin Trust ETF",  # IBIT
]

# (listed name, why it is in the `unclassified` report and not in the universe)  # symbol
REPORTED = [
    ("Leverage Shares 100% TSLA AND 100% SPCX Daily ETF", universe.STACKED_EXPOSURES),  # ELOL
    ("STKd 100% Bitcoin & 100% Gold ETF", universe.STACKED_EXPOSURES),  # BTGD
    ("IncomeSTKd 1x Bitcoin & 1x Gold Premium ETF", universe.STACKED_EXPOSURES),  # ISBG
    ("IncomeSTKd 1x US Stocks & 1x Bitcoin Premium ETF", universe.STACKED_EXPOSURES),  # ISSB
    ("Return Stacked U.S. Stocks & Managed Futures ETF", universe.STACKED_EXPOSURES),  # RSST
    ("Return Stacked Global Stocks & Bonds ETF", universe.STACKED_EXPOSURES),  # RSSB
    ("Return Stacked U.S. Stocks & Gold/Bitcoin ETF", universe.STACKED_EXPOSURES),  # RSSX
    ("Roundhill Top WeeklyPay ETF", universe.WEEKLY_PAY_BASKET),  # TOPW
    ("Defiance Long Pure Quantum ETF", universe.NO_READABLE_MULTIPLE),  # QTUP
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
    ("Roundhill NVDA WeeklyPay ETF", 'NVDA'),  # NVDW
    ("Roundhill BRKB WeeklyPay ETF", 'BRK.B'),  # BRKW
    ("Roundhill Gold WeeklyPay ETF", 'GLD'),  # GLDW
    ("Roundhill Gold Miners WeeklyPay ETF", 'GDX'),  # GDXW
    ("Roundhill Treasury Bond WeeklyPay ETF", 'TLT'),  # TSYW
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
    assert {multiple for _, multiple in LEVERAGED} == {-3, -2, -1.5, -1, -0.5, 1.2, 1.25, 1.5, 2, 3, 4}


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
    assert universe.classify("Roundhill NVDA WeeklyPay ETF") == Leverage(1.2, "weekly-pay")


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
    assert universe.unclassified_reason(name) == universe.NO_READABLE_MULTIPLE


@pytest.mark.parametrize(("name", "reason"), REPORTED)
def test_a_leveraged_fund_without_one_multiple_of_one_reference_is_reported_with_the_reason(name, reason):
    assert universe.classify(name) is None  # not in the universe
    assert universe.unclassified_reason(name) == reason and universe.signals_leverage(name)


def test_a_fund_that_is_classified_or_not_leveraged_has_no_report_reason():
    assert universe.unclassified_reason("ProShares UltraPro QQQ") is None
    assert universe.unclassified_reason("Invesco QQQ Trust, Series 1") is None


def test_the_weekly_pay_family_is_one_rule_and_another_weekly_pay_name_is_reported():
    # 23 funds are listed as "Roundhill <reference> WeeklyPay ETF"; the name states no multiple
    assert universe.classify("Roundhill TSLA WeeklyPay ETF ") == Leverage(universe.WEEKLY_PAY_MULTIPLE, "weekly-pay")
    assert universe.WEEKLY_PAY_MULTIPLE == 1.2
    # a WeeklyPay name that the family rule does not read is reported; it is not dropped
    assert universe.classify("Roundhill WeeklyPay Universe ETF") is None  # invented
    assert universe.unclassified_reason("Roundhill WeeklyPay Universe ETF") == universe.NO_READABLE_MULTIPLE
    assert universe.unclassified_reason("Roundhill Top WeeklyPay ETF ") == universe.WEEKLY_PAY_BASKET  # as listed


def test_two_stacked_exposures_need_two_amounts_or_a_family_word():
    # one multiple and an "&" in the subject is one exposure
    assert universe.classify("Rareview 2x Bull Cryptocurrency & Precious Metals ETF").multiple == 2
    assert universe.unclassified_reason("Example 150% Stocks and 50% Gold ETF") == universe.STACKED_EXPOSURES  # invented
    # two multiples without "&" or "and" stay "no readable multiple"
    assert universe.unclassified_reason("Example 2X Long TSLA 3X Long NVDA ETF") == universe.NO_READABLE_MULTIPLE


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

def rows_of(listing: str) -> list:
    """The rows of a test listing. The row minimum of a whole directory has its own test."""
    return universe.parse_listing(listing, min_rows=1)


def padded(listing: str, rows: int = universe.MIN_LISTING_ROWS) -> str:
    """The listing with `rows` more rows of common stock: the size of a whole directory."""
    filler = "\n".join(f"Y|F{index:05d}|Filler {index} Common Stock|N| |N|100|N||F{index:05d}|F{index:05d}|N"
                       for index in range(rows))
    return listing.replace("File Creation Time", f"{filler}\nFile Creation Time")


ROWS = rows_of(LISTING)


def test_parse_listing_reads_the_rows_and_skips_the_file_creation_line():
    assert len(ROWS) == 17
    assert ROWS[0]["Symbol"] == "TQQQ" and ROWS[0]["Security Name"] == "ProShares UltraPro QQQ" and ROWS[0]["ETF"] == "Y"
    assert ROWS[-1]["Symbol"] == "ZZZTX"  # the line before the file creation line is a row
    # a line with another number of cells is not a row
    assert len(rows_of(LISTING.replace("Y|BBW|", "Y|BBW|extra cell|"))) == 16


def test_parse_listing_refuses_a_listing_that_was_cut():
    cut = LISTING[:LISTING.index("File Creation Time")]  # every row, without the last line
    with pytest.raises(ValueError, match="does not end with the 'File Creation Time' line: the download was cut"):
        universe.parse_listing(cut, min_rows=1)
    with pytest.raises(ValueError, match="does not end with"):
        universe.parse_listing(HEADER, min_rows=0)


def test_parse_listing_refuses_a_file_that_is_not_the_directory():
    with pytest.raises(ValueError, match="has no column Symbol, Security Name, Listing Exchange, ETF, Test Issue"):
        universe.parse_listing("")
    with pytest.raises(ValueError, match="has no column ETF$"):
        universe.parse_listing(LISTING.replace("|ETF|", "|Fund|"), min_rows=1)
    with pytest.raises(ValueError, match="has no column"):
        universe.parse_listing("<html>503 Service Unavailable</html>\nFile Creation Time: 1111202618:02|||||")


def test_parse_listing_refuses_a_short_listing():
    # the import deletes every fund that is not in the document: half a directory would delete half the table
    assert universe.MIN_LISTING_ROWS == 10_000  # the directory of 2026-11-11 has 13,282 rows
    with pytest.raises(ValueError, match="has 17 rows; a whole directory has at least 10000"):
        universe.parse_listing(LISTING)
    with pytest.raises(ValueError, match="has 17 rows; a whole directory has at least 18"):
        universe.parse_listing(LISTING, min_rows=18)
    assert len(universe.parse_listing(LISTING, min_rows=17)) == 17
    assert len(universe.parse_listing(padded(LISTING))) == 10_017


def test_listed_funds_keeps_the_leveraged_products_sorted_by_symbol():
    funds = universe.listed_funds(ROWS)
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
    symbols = {fund.symbol for fund in universe.listed_funds(ROWS)}
    assert not symbols & {"BBW", "CPZ", "QQQ", "SPY", "VXX", "ETN", "NVDA", "BSV", "QTUP", "ZZZTX"}
    as_test_issue = [{**row, "Test Issue": "Y"} if row["Symbol"] == "TQQQ" else row for row in ROWS]
    assert "TQQQ" not in {fund.symbol for fund in universe.listed_funds(as_test_issue)}


def test_unclassified_reports_products_only_with_the_reason():
    # Build-A-Bear (a stock) has the word "Bear"; it is not a product, so it is not reported
    assert universe.unclassified(ROWS) == [("QTUP", "Defiance Long Pure Quantum ETF", universe.NO_READABLE_MULTIPLE)]


# Rows of the directory of 2026-11-11, as listed.
WEEKLY_PAY_AND_STACKED = "\n".join([HEADER, *[
    "Y|AAPL|Apple Inc. - Common Stock|Q|Q|N|40|N|N||AAPL|N",
    "Y|AAPW|Roundhill AAPL WeeklyPay ETF|Z| |Y|100|N||AAPW|AAPW|N",
    "Y|BTGD|STKd 100% Bitcoin & 100% Gold ETF|Q|G|Y|100|N|N||BTGD|N",
    "Y|ELOL|Leverage Shares 100% TSLA AND 100% SPCX Daily ETF|Q|G|Y|100|N|N||ELOL|N",
    "Y|TOPW|Roundhill Top WeeklyPay ETF|Z| |Y|100|N||TOPW|TOPW|N",
], "File Creation Time: 1111202618:02|||||", ""])


def test_no_leveraged_fund_of_the_directory_is_dropped_without_a_report():
    rows = rows_of(WEEKLY_PAY_AND_STACKED)
    # the weekly reset of a WeeklyPay fund is not in the row: a ListedFund has no reset period
    assert universe.listed_funds(rows) == [ListedFund("AAPW", "Roundhill AAPL WeeklyPay ETF", "etf", 1.2, "AAPL", "Cboe BZX")]
    assert universe.unclassified(rows) == [
        ("BTGD", "STKd 100% Bitcoin & 100% Gold ETF", universe.STACKED_EXPOSURES),
        ("ELOL", "Leverage Shares 100% TSLA AND 100% SPCX Daily ETF", universe.STACKED_EXPOSURES),
        ("TOPW", "Roundhill Top WeeklyPay ETF", universe.WEEKLY_PAY_BASKET),
    ]


def test_product_type():
    assert universe.product_type("MicroSectors FANG+ 3X Leveraged ETNs") == "etn"
    assert universe.product_type("MicroSectors Gold Miners 3X Leveraged ETN") == "etn"
    assert universe.product_type("iPath Series B Carbon Exchange-Traded Notes") == "etn"
    assert universe.product_type("Leverage Shares 2X Long ETN Daily ETF") == "etf"
    assert universe.product_type("ProShares UltraPro QQQ") == "etf"


# --- gate ----------------------------------------------------------------------------------------------------

QUOTED = datetime(2026, 11, 12, 15, 30, tzinfo=UTC)  # Thursday, chain time 10:30 New York: the quotes of 10:15
GENERATED = datetime(2026, 11, 12, 15, 40, 11, 530460, tzinfo=UTC)  # 10:40 New York of the same day
EVENING = datetime(2026, 11, 12, 1, 5, tzinfo=UTC)  # chain time 20:05 New York of the day before


def measured(**changes) -> OptionsMeasure:
    base = {"quoted_at": QUOTED, "spot": 58.65, "nearest_expiries": ("2026-11-13", "2026-11-18"),
            "window_expiry": "2026-11-18", "total_open_interest": 123456, "band_open_interest": 23456, "half_spread_pct": 1.2,
            "two_sided_quotes": 8}
    return OptionsMeasure(**{**base, **changes})


NO_WINDOW = {"window_expiry": None, "band_open_interest": None, "half_spread_pct": None, "two_sided_quotes": None}
NO_QUOTE = {"half_spread_pct": None, "two_sided_quotes": 0}
CLOSED = {"quoted_at": EVENING}
NOT_MEASURED = ("spread-not-measured", ["market-closed-at-quote"])


@pytest.mark.parametrize(("changes", "label", "reasons"), [
    ({}, "pass", []),
    ({"band_open_interest": 1000, "half_spread_pct": 4.0, "two_sided_quotes": 3}, "pass", []),  # the limits are inclusive
    ({"band_open_interest": 999}, "fail", ["open-interest-below-minimum"]),
    ({"half_spread_pct": 4.0001}, "fail", ["spread-above-maximum"]),
    (NO_QUOTE, "fail", ["no-two-sided-quote"]),
    ({"two_sided_quotes": 2}, "fail", ["too-few-two-sided-quotes"]),
    ({"two_sided_quotes": 1, "half_spread_pct": 0.1}, "fail", ["too-few-two-sided-quotes"]),  # one tight quote does not pass
    ({"two_sided_quotes": 2, "half_spread_pct": 40.0}, "fail", ["too-few-two-sided-quotes"]),  # their spread is not judged
    ({"band_open_interest": 0, **NO_QUOTE}, "fail", ["open-interest-below-minimum", "no-two-sided-quote"]),
    ({"band_open_interest": 10, "half_spread_pct": 9.5}, "fail", ["open-interest-below-minimum", "spread-above-maximum"]),
    (NO_WINDOW, "fail", ["no-window-expiry", "no-two-sided-quote"]),
    # closed session: the spread is not judged
    (CLOSED, *NOT_MEASURED),
    ({**CLOSED, "half_spread_pct": 40.0}, *NOT_MEASURED),
    ({**CLOSED, **NO_QUOTE}, *NOT_MEASURED),
    ({**CLOSED, "two_sided_quotes": 1}, *NOT_MEASURED),
    ({**CLOSED, "band_open_interest": 999, "half_spread_pct": 40.0}, "fail", ["open-interest-below-minimum"]),
    ({**CLOSED, **NO_WINDOW}, "fail", ["no-window-expiry"]),
])
def test_gate_truth_table(changes, label, reasons):
    assert liquidity.gate(measured(**changes), GENERATED) == (label, reasons)


def test_gate_without_option_facts():
    assert liquidity.gate(liquidity.NOT_LISTED, GENERATED) == ("fail", ["no-listed-options"])
    # the fund has a chain file, so this is not "no listed options"
    assert liquidity.gate(liquidity.NO_STANDARD_CONTRACT, GENERATED) == ("fail", ["no-standard-contract"])


def new_york(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=liquidity.NEW_YORK)


@pytest.mark.parametrize(("chain_time", "age", "label", "reasons"), [
    ("2026-11-12T10:30:00", 0, "pass", []),
    ("2026-11-11T20:05:00", 1, *NOT_MEASURED),
    ("2026-11-08T00:00:00", 4, *NOT_MEASURED),  # 4 calendar days: the chain is still read
    ("2026-11-07T23:59:59", 5, "fail", ["stale-chain"]),  # the New York day decides, not 120 hours
    ("2026-09-30T15:09:46", 43, "fail", ["stale-chain"]),  # the time of the real chain of PUR
])
def test_gate_does_not_judge_a_chain_of_more_than_four_days_before_the_document(chain_time, age, label, reasons):
    quoted_at = new_york(chain_time).astimezone(UTC)
    assert liquidity.chain_age_days(quoted_at, GENERATED) == age
    assert liquidity.gate(measured(quoted_at=quoted_at), GENERATED) == (label, reasons)


def test_stale_chain_is_the_only_reason_of_an_old_chain():
    old = new_york("2026-09-30T15:09:46").astimezone(UTC)
    assert liquidity.gate(measured(quoted_at=old, **NO_WINDOW), GENERATED) == ("fail", ["stale-chain"])
    assert liquidity.gate(measured(quoted_at=old, band_open_interest=0, half_spread_pct=40.0), GENERATED) == ("fail", ["stale-chain"])


def test_a_regular_session_chain_of_an_earlier_day_cannot_pass():
    # the quotes of yesterday 10:15, with good numbers: pass needs quotes of the day of the document
    yesterday = QUOTED - timedelta(days=1)
    assert liquidity.session_of(yesterday, yesterday + timedelta(minutes=10)) == "regular"
    assert liquidity.session_of(yesterday, GENERATED) == "closed"
    assert liquidity.gate(measured(quoted_at=yesterday), GENERATED) == NOT_MEASURED


def test_gate_constants_and_reasons_are_the_contract():
    assert GATE == {"version": 1, "minWindowDays": 5, "maxWindowDays": 21, "bandPct": 10, "minBandOpenInterest": 1000,
                    "maxHalfSpreadPct": 4, "minTwoSidedQuotes": 3}
    assert list(GATE) == ["version", "minWindowDays", "maxWindowDays", "bandPct", "minBandOpenInterest", "maxHalfSpreadPct",
                          "minTwoSidedQuotes"]
    assert liquidity.REASONS == ("no-listed-options", "no-standard-contract", "stale-chain", "no-window-expiry",
                                 "open-interest-below-minimum", "no-two-sided-quote", "too-few-two-sided-quotes",
                                 "spread-above-maximum", "market-closed-at-quote")
    assert liquidity.MAX_CHAIN_AGE_DAYS == 4 and liquidity.MAX_CLOCK_SKEW == timedelta(minutes=5)
    assert liquidity.QUOTE_DELAY == timedelta(minutes=15)


# --- session -------------------------------------------------------------------------------------------------

@pytest.mark.parametrize(("chain_time", "generated", "session"), [
    ("2026-11-12T10:30:00", "2026-11-12T10:40:00", "regular"),  # the quotes of 10:15
    ("2026-11-12T09:59:59", "2026-11-12T10:40:00", "closed"),  # the quotes of 09:44:59, before 09:45
    ("2026-11-12T10:00:00", "2026-11-12T10:40:00", "regular"),
    ("2026-11-12T16:14:59", "2026-11-12T16:20:00", "regular"),  # the quotes of 15:59:59
    ("2026-11-12T16:15:00", "2026-11-12T16:20:00", "closed"),  # the quotes of the close
    ("2026-11-12T20:05:00", "2026-11-12T20:10:00", "closed"),
    ("2026-11-12T14:47:36", "2026-11-12T21:14:00", "regular"),  # read after the close of the same day
    ("2026-11-12T14:47:36", "2026-11-13T10:40:00", "closed"),  # read on the next day
    ("2026-11-14T10:30:00", "2026-11-14T10:40:00", "closed"),  # Saturday
    ("2026-11-26T10:30:00", "2026-11-26T10:40:00", "closed"),  # Thanksgiving: the calendar says so, not a missing trade
    ("2026-11-27T13:14:59", "2026-11-27T13:20:00", "regular"),  # half day: the quotes of 12:59:59
    ("2026-11-27T13:15:00", "2026-11-27T13:20:00", "closed"),  # half day: the close is 13:00
    ("2026-12-24T13:15:00", "2026-12-24T13:20:00", "closed"),  # half day
    ("2026-07-03T10:30:00", "2026-07-03T10:40:00", "closed"),  # 4 July is a Saturday: the holiday is the Friday
    ("2026-07-15T10:00:00", "2026-07-15T10:10:00", "regular"),  # summer time
])
def test_session_rule_reads_the_clock_and_the_exchange_calendar(chain_time, generated, session):
    assert liquidity.session_of(new_york(chain_time).astimezone(UTC), new_york(generated).astimezone(UTC)) == session


def test_session_close_of_a_day():
    assert liquidity.session_close(date(2026, 11, 12)) == liquidity.SESSION_CLOSE
    assert liquidity.session_close(date(2026, 11, 27)) == liquidity.EARLY_CLOSE
    assert liquidity.session_close(date(2026, 11, 26)) is None and liquidity.session_close(date(2026, 11, 14)) is None
    assert liquidity.session_close(date(2026, 11, 11)) == liquidity.SESSION_CLOSE  # Veterans Day: the exchange is open


def test_the_calendar_rules_are_the_rules_of_the_repository():
    from strategies.imom.data import is_early_close
    from strategies.qc_ports.calendar import is_nyse_holiday

    day_ = date(2000, 1, 1)
    while day_ < date(2041, 1, 1):
        assert liquidity.is_nyse_holiday(day_) == is_nyse_holiday(day_), day_
        assert liquidity.closes_early(day_) == is_early_close(day_), day_
        day_ += timedelta(days=1)


def test_the_fetcher_loads_without_pydantic():
    # the fetcher runs as `python3 research/backtests/leveraged-etf/universe.py` on the standard library alone
    code = ("import importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('fetcher', {str(SCRIPT)!r})\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(module)\n"
            "loaded = [name for name in ('pydantic', 'strategies.qc_ports', 'strategies.imom') if name in sys.modules]\n"
            "assert not loaded, loaded\n")
    subprocess.run([sys.executable, "-c", code], check=True)


# --- measure -------------------------------------------------------------------------------------------------

TODAY = date(2026, 11, 12)


def option(expiry: date, kind: str, strike: float, bid: float = 0.0, ask: float = 0.0, oi: int = 0, root: str = "TQQQ") -> dict:
    return {"option": f"{root}{expiry:%y%m%d}{kind}{round(strike * 1000):08d}", "bid": bid, "ask": ask,
            "open_interest": float(oi), "volume": 0.0, "iv": 0.5, "last_trade_time": None}


def chain(options: list, spot: float = 100.0, timestamp: str = "2026-11-12 15:30:00",
          last_trade: str | None = "2026-11-12T10:14:30", symbol: str = "TQQQ") -> dict:
    return {"timestamp": timestamp, "symbol": symbol,
            "data": {"symbol": symbol, "current_price": spot, "close": spot, "last_trade_time": last_trade, "options": options}}


def day(offset: int) -> date:
    return TODAY + timedelta(days=offset)


def quotes(expiry: date, strikes=(100, 99), two_sided: int = 4, oi: int = 600, bid: float = 1.0, ask: float = 1.02,
           root: str = "TQQQ") -> list:
    """A call and a put at each strike; the first `two_sided` contracts have a bid and an ask, the others no bid."""
    contracts = [(kind, strike) for strike in strikes for kind in "CP"]
    return [option(expiry, kind, strike, bid if index < two_sided else 0.0, ask, oi, root)
            for index, (kind, strike) in enumerate(contracts)]


@pytest.mark.parametrize(("offsets", "window"), [
    ((1, 4, 5, 8, 21, 22), 5),  # the 5-day edge is inside, 4 days is not
    ((1, 4, 21, 22), 21),  # the 21-day edge is inside
    ((0, 4, 22, 50), None),  # nothing between 5 and 21 days
    ((6, 7, 14), 6),  # the nearest one inside the window
])
def test_measure_picks_the_nearest_expiry_inside_the_window(offsets, window):
    result = liquidity.measure(chain([option(day(offset), "C", 100, 1.0, 1.1, 10) for offset in offsets]), "TQQQ", TODAY)
    assert result.window_expiry == (day(window).isoformat() if window is not None else None)
    assert result.nearest_expiries == tuple(day(offset).isoformat() for offset in offsets[:4])
    assert result.total_open_interest == 10 * len(offsets)
    if window is None:
        assert result.band_open_interest is None and result.half_spread_pct is None and result.two_sided_quotes is None
    else:
        assert result.two_sided_quotes == 1


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
    result = liquidity.measure(chain(options), "TQQQ", TODAY)
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
    result = liquidity.measure(chain(options), "TQQQ", TODAY)
    assert result.half_spread_pct == pytest.approx(2.5)  # median of 1, 2, 3 and 10
    assert result.two_sided_quotes == 4


def test_measure_half_spread_is_none_without_a_two_sided_quote():
    window = day(7)
    result = liquidity.measure(chain([option(window, "C", 100, 0.0, 1.0, 5000), option(window, "P", 100, 0.0, 0.0, 5000)]), "TQQQ", TODAY)
    assert result.half_spread_pct is None and result.two_sided_quotes == 0 and result.band_open_interest == 10000
    assert liquidity.gate(result, GENERATED) == ("fail", ["no-two-sided-quote"])


@pytest.mark.parametrize(("two_sided", "label", "reasons"), [
    (4, "pass", []), (3, "pass", []), (2, "fail", ["too-few-two-sided-quotes"]), (1, "fail", ["too-few-two-sided-quotes"]),
])
def test_the_spread_rule_needs_three_two_sided_quotes(two_sided, label, reasons):
    result = liquidity.measure(chain(quotes(day(7), two_sided=two_sided)), "TQQQ")
    assert result.two_sided_quotes == two_sided and result.half_spread_pct == pytest.approx(0.9901)
    assert liquidity.gate(result, GENERATED) == (label, reasons)


def test_measure_reads_the_chain_time_the_spot_and_the_quote_day():
    result = liquidity.measure(chain([option(day(0), "C", 60), *quotes(day(6), strikes=(59, 60))], spot=58.6501), "TQQQ")
    assert result.quoted_at == QUOTED and result.spot == 58.6501
    assert result.nearest_expiries == ("2026-11-12", "2026-11-18")  # an expiry on the quote day counts
    assert liquidity.gate(result, GENERATED) == ("pass", [])
    # 01:05 UTC is 20:05 New York of the day before: that day is the quote day
    late = liquidity.measure(chain([option(day(-1), "C", 60), option(day(4), "C", 60)], timestamp="2026-11-12 01:05:00"), "TQQQ")
    assert late.quoted_at == EVENING and late.nearest_expiries == ("2026-11-11", "2026-11-16")
    assert late.window_expiry == "2026-11-16"  # 5 days after 2026-11-11
    assert liquidity.quote_time(chain([])) == QUOTED


@pytest.mark.parametrize("last_trade", ["2026-11-12T10:14:30", "2026-11-12T09:31:00", "2026-11-11T15:59:59", None])
def test_a_fund_without_a_recent_trade_is_judged_by_its_option_quotes(last_trade):
    result = liquidity.measure(chain(quotes(day(7)), last_trade=last_trade), "TQQQ")
    assert liquidity.session_of(result.quoted_at, GENERATED) == "regular"
    assert liquidity.gate(result, GENERATED) == ("pass", [])


def test_measure_finds_no_standard_contract_on_or_after_the_quote_day():
    for options in ([], [option(day(-1), "C", 100, oi=5)], [option(day(7), "C", 100, oi=5, root="TQQQ1")]):
        assert liquidity.measure(chain(options), "TQQQ", TODAY) is liquidity.NO_STANDARD_CONTRACT


def test_measure_uses_the_requested_symbol_as_the_occ_root():
    options = [option(day(7), "C", 500, 1.0, 1.1, 7, root="BRKB")]
    assert liquidity.measure(chain(options, spot=500.0, symbol="BRK.B"), "BRK.B", TODAY).total_open_interest == 7
    only_inner = chain([option(day(7), "C", 100, oi=3)])
    del only_inner["symbol"]  # one symbol field is enough when it is the requested symbol
    assert liquidity.measure(only_inner, "TQQQ", TODAY).total_open_interest == 3


@pytest.mark.parametrize(("top", "inner", "named"), [
    ("QQQ", "QQQ", "QQQ"), ("TQQQ", "QQQ", "QQQ, TQQQ"), ("QQQ", "TQQQ", "QQQ, TQQQ"), (None, None, "no symbol"),
])
def test_measure_refuses_the_chain_of_another_symbol(top, inner, named):
    wrong = chain([option(day(7), "C", 100, oi=5)])
    wrong["symbol"], wrong["data"]["symbol"] = top, inner
    with pytest.raises(ValueError, match=f"the chain is of {named}, not of TQQQ"):
        liquidity.measure(wrong, "TQQQ", TODAY)


def test_measure_falls_back_to_the_close_price_and_refuses_a_chain_without_a_price():
    no_price = chain([option(day(7), "C", 100, oi=3)])
    no_price["data"]["current_price"] = 0.0
    assert liquidity.measure(no_price, "TQQQ", TODAY).spot == 100.0  # the close
    no_price["data"]["close"] = None
    with pytest.raises(ValueError, match="no positive price"):
        liquidity.measure(no_price, "TQQQ", TODAY)


# --- document ------------------------------------------------------------------------------------------------

TQQQ = ListedFund("TQQQ", "ProShares UltraPro QQQ", "etf", 3.0, "QQQ", "NASDAQ")
SPYU = ListedFund("SPYU", "MAX S&P 500 4X Leveraged ETNs due October 30, 2043", "etn", 4.0, "SPY", "NYSE Arca")
NVDS = ListedFund("NVDS", "Tradr 1.5X Short NVDA Daily ETF", "etf", -1.5, "NVDA", "NASDAQ")
UVXY = ListedFund("UVXY", "ProShares Ultra VIX Short Term Futures ETF", "etf", 1.5, None, "Cboe BZX")


def test_document_matches_the_contract():
    document = liquidity.document([(UVXY, measured(**CLOSED)), (TQQQ, measured()), (SPYU, liquidity.NOT_LISTED),
                                   (NVDS, measured(**NO_WINDOW))], GENERATED)
    assert list(document) == ["schema", "generatedAt", "gate", "funds"]
    assert document["schema"] == "leveraged-etf-universe-v1" and document["generatedAt"] == "2026-11-12T15:40:11Z"
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
                                             "bandOpenInterest", "halfSpreadPct", "twoSidedQuotes"]
            assert fund["options"]["session"] in ("regular", "closed")
            assert (fund["options"]["bandOpenInterest"] is None) == (fund["options"]["windowExpiry"] is None)
            assert (fund["options"]["twoSidedQuotes"] is None) == (fund["options"]["windowExpiry"] is None)
    nvds, spyu, tqqq, uvxy = document["funds"]
    assert tqqq == {
        "symbol": "TQQQ", "name": "ProShares UltraPro QQQ", "productType": "etf", "leverage": 3, "underlying": "QQQ",
        "listingExchange": "NASDAQ", "optionsListed": True,
        "options": {"quotedAt": "2026-11-12T15:30:00Z", "session": "regular", "spot": 58.65,
                    "nearestExpiries": ["2026-11-13", "2026-11-18"], "windowExpiry": "2026-11-18", "totalOpenInterest": 123456,
                    "bandOpenInterest": 23456, "halfSpreadPct": 1.2, "twoSidedQuotes": 8},
        "optionGate": "pass", "optionGateReasons": []}
    assert (spyu["productType"], spyu["leverage"], spyu["optionsListed"], spyu["options"]) == ("etn", 4, False, None)
    assert (spyu["optionGate"], spyu["optionGateReasons"]) == ("fail", ["no-listed-options"])
    assert (nvds["leverage"], nvds["optionGate"], nvds["optionGateReasons"]) == (-1.5, "fail", ["no-window-expiry", "no-two-sided-quote"])
    assert (uvxy["underlying"], uvxy["options"]["session"]) == (None, "closed")
    assert (uvxy["optionGate"], uvxy["optionGateReasons"]) == NOT_MEASURED
    # whole multiples are written as integers, as in the contract example
    assert '"leverage": 3,' in json.dumps(document) and '"leverage": -1.5,' in json.dumps(document)


def test_a_fund_without_a_standard_contract_has_no_option_facts_and_its_own_reason():
    entry = liquidity.fund_entry(TQQQ, liquidity.NO_STANDARD_CONTRACT, GENERATED)
    assert (entry["optionsListed"], entry["options"]) == (False, None)
    assert (entry["optionGate"], entry["optionGateReasons"]) == ("fail", ["no-standard-contract"])


def test_document_refuses_what_the_contract_forbids():
    with pytest.raises(ValueError, match="1 to 2000 funds"):
        liquidity.document([], GENERATED)
    with pytest.raises(ValueError, match="listed twice: TQQQ"):
        liquidity.document([(TQQQ, liquidity.NOT_LISTED), (SPYU, liquidity.NOT_LISTED), (TQQQ, measured())], GENERATED)
    with pytest.raises(ValueError, match="without a time zone"):
        liquidity.document([(TQQQ, liquidity.NOT_LISTED)], datetime(2026, 11, 12, 15, 40))
    for wrong in (ListedFund("tqqq", "x", "etf", 3.0, None, "NASDAQ"), ListedFund("TQQQ$", "x", "etf", 3.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "", "etf", 3.0, None, "NASDAQ"), ListedFund("TQQQ", "x" * 201, "etf", 3.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "fund", 3.0, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 1.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "etf", 0.0, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 6.0, None, "NASDAQ"),
                  ListedFund("TQQQ", "x", "etf", -5.5, None, "NASDAQ"), ListedFund("TQQQ", "x", "etf", 3.0, None, "")):
        with pytest.raises(ValueError):
            liquidity.fund_entry(wrong, liquidity.NOT_LISTED, GENERATED)
    assert liquidity.fund_entry(ListedFund("BRK.B", "x", "etf", -5.0, None, "NYSE"), liquidity.NOT_LISTED, GENERATED)["leverage"] == -5
    assert liquidity.fund_entry(ListedFund("NVDW", "x", "etf", 1.2, None, "NYSE"), liquidity.NOT_LISTED, GENERATED)["leverage"] == 1.2


def test_document_refuses_a_chain_that_is_newer_than_the_document():
    with pytest.raises(ValueError, match="TQQQ: the chain time 2026-11-12T15:30:00Z is after the document time 2026-11-12T15:24:59Z"):
        liquidity.document([(TQQQ, measured())], QUOTED - timedelta(minutes=5, seconds=1))
    # the clock of Cboe and the clock of the fetcher may differ by 5 minutes
    assert liquidity.document([(TQQQ, measured())], QUOTED - timedelta(minutes=5))["funds"][0]["optionGate"] == "pass"
    # the document holds whole seconds, and the import sees only them: 15:24:59.5 is judged as 15:24:59
    with pytest.raises(ValueError, match="is after the document time 2026-11-12T15:24:59Z"):
        liquidity.document([(TQQQ, measured())], QUOTED - timedelta(minutes=5, microseconds=500_000))
    assert liquidity.document([(TQQQ, measured())], QUOTED - timedelta(minutes=4, seconds=59, microseconds=500_000))


# --- the document that both rules read (tests/fixtures/leveraged_etf) ----------------------------------------

FIXTURE_AT = datetime(2026, 11, 12, 2, 39, 56, tzinfo=UTC)  # 21:39 New York on Wednesday 2026-11-11, after the close


def fixture_document() -> dict:
    """One fund for every gate label and every gate reason, built by the code that builds the real document.

    The chain of PUR is real: Cboe wrote it on 2026-09-30, and the run of 2026-11-12 read it (the file keeps
    the fields that the measure reads). The other chains are made here; the fund names are real."""
    session, evening = "2026-11-11 19:47:36", "2026-11-12 01:55:07"  # chain time 14:47:36 and 20:55:07 New York
    near, friday, far = date(2026, 11, 13), date(2026, 11, 20), date(2026, 12, 18)

    def with_quotes(symbol: str, timestamp: str = session, **changes) -> dict:
        return chain(quotes(changes.pop("expiry", friday), root=symbol, **changes), timestamp=timestamp, symbol=symbol)

    def no_window(symbol: str, timestamp: str) -> dict:  # 2 days and 37 days after the quote day
        return chain([*quotes(near, root=symbol), *quotes(far, root=symbol)], timestamp=timestamp, symbol=symbol)

    funds = [
        (TQQQ, with_quotes("TQQQ")),
        (ListedFund("SQQQ", "ProShares UltraPro Short QQQ", "etf", -3.0, "QQQ", "NASDAQ"), with_quotes("SQQQ", oi=100)),
        (ListedFund("NVDL", "GraniteShares 2x Long NVDA Daily ETF", "etf", 2.0, "NVDA", "NASDAQ"), with_quotes("NVDL", ask=1.2)),
        (NVDS, with_quotes("NVDS", two_sided=2)),
        (ListedFund("TSLL", "Direxion Daily TSLA Bull 2X ETF", "etf", 2.0, "TSLA", "NASDAQ"), with_quotes("TSLL", two_sided=0)),
        (ListedFund("SOXL", "Direxion Daily Semiconductor Bull 3X ETF", "etf", 3.0, "SOXX", "NYSE Arca"), with_quotes("SOXL", evening)),
        (ListedFund("SOXS", "Direxion Daily Semiconductor Bear 3X ETF", "etf", -3.0, "SOXX", "NYSE Arca"), no_window("SOXS", evening)),
        (UVXY, no_window("UVXY", session)),
        (SPYU, None),  # Cboe has no chain file
        # only an adjusted contract (root NVDW1)
        (ListedFund("NVDW", "Roundhill NVDA WeeklyPay ETF", "etf", 1.2, "NVDA", "Cboe BZX"),
         chain(quotes(friday, root="NVDW1"), timestamp=session, symbol="NVDW")),
        (ListedFund("PUR", "Defiance Daily Target 2X Long PURR ETF", "etf", 2.0, "PURR", "NASDAQ"),
         json.loads((FIXTURES / "pur-chain-20260930.json").read_text(encoding="utf-8"))),
        # Saturday 2026-11-07 16:00 New York: 4 days before the document, the oldest chain that is still read
        (ListedFund("TSLQ", "Tradr 2X Short TSLA Daily ETF", "etf", -2.0, "TSLA", "NASDAQ"),
         with_quotes("TSLQ", "2026-11-07 21:00:00", expiry=near)),
        # Friday 2026-11-06 16:30 New York: 5 days before the document
        (ListedFund("TSLZ", "T-Rex 2X Inverse Tesla Daily Target ETF", "etf", -2.0, "TSLA", "Cboe BZX"),
         with_quotes("TSLZ", "2026-11-06 21:30:00", expiry=near)),
    ]
    return liquidity.document(((fund, liquidity.NOT_LISTED if body is None else liquidity.measure(body, fund.symbol))
                               for fund, body in funds), FIXTURE_AT)


def test_the_committed_document_is_the_document_that_python_builds():
    committed = json.loads((FIXTURES / "universe-document.json").read_text(encoding="utf-8"))
    assert committed == fixture_document()  # after a rule change: see the first lines of this file


def test_the_fixture_document_holds_every_label_and_every_reason():
    funds = {fund["symbol"]: fund for fund in fixture_document()["funds"]}
    assert {symbol: (fund["optionGate"], fund["optionGateReasons"]) for symbol, fund in funds.items()} == {
        "NVDL": ("fail", ["spread-above-maximum"]),
        "NVDS": ("fail", ["too-few-two-sided-quotes"]),
        "NVDW": ("fail", ["no-standard-contract"]),
        "PUR": ("fail", ["stale-chain"]),
        "SOXL": NOT_MEASURED,
        "SOXS": ("fail", ["no-window-expiry"]),
        "SPYU": ("fail", ["no-listed-options"]),
        "SQQQ": ("fail", ["open-interest-below-minimum"]),
        "TQQQ": ("pass", []),
        "TSLL": ("fail", ["no-two-sided-quote"]),
        "TSLQ": NOT_MEASURED,
        "TSLZ": ("fail", ["stale-chain"]),
        "UVXY": ("fail", ["no-window-expiry", "no-two-sided-quote"]),
    }
    assert {reason for fund in funds.values() for reason in fund["optionGateReasons"]} == set(liquidity.REASONS)
    assert {symbol for symbol, fund in funds.items() if fund["options"] and fund["options"]["session"] == "regular"} == {
        "NVDL", "NVDS", "SQQQ", "TQQQ", "TSLL", "UVXY"}


def test_the_real_chain_of_pur_is_stale_in_the_run_that_read_it():
    result = liquidity.measure(json.loads((FIXTURES / "pur-chain-20260930.json").read_text(encoding="utf-8")), "PUR")
    assert result == OptionsMeasure(
        quoted_at=datetime(2026, 9, 30, 19, 9, 46, tzinfo=UTC),  # 15:09:46 New York on a Wednesday: session hours
        spot=33.3, nearest_expiries=("2026-10-16", "2026-11-20", "2027-02-19", "2027-05-21"), window_expiry="2026-10-16",
        total_open_interest=29, band_open_interest=2, half_spread_pct=35.8101, two_sided_quotes=8)
    assert liquidity.chain_age_days(result.quoted_at, FIXTURE_AT) == 42
    assert liquidity.gate(result, FIXTURE_AT) == ("fail", ["stale-chain"])
    assert liquidity.session_of(result.quoted_at, FIXTURE_AT) == "closed"
    # read on the day when Cboe wrote it, the same chain is judged by its numbers
    same_day = result.quoted_at + timedelta(minutes=10)
    assert liquidity.gate(result, same_day) == ("fail", ["open-interest-below-minimum", "spread-above-maximum"])


# --- the fetcher (research/backtests/leveraged-etf/universe.py) -----------------------------------------------

def body_of(symbol: str, spot: float = 100.0, oi: int = 5000, timestamp: str = "2026-11-12 15:30:00") -> bytes:
    """A chain that passes the gate at GENERATED: 4 two-sided quotes, and `oi` contracts on the call and on the
    put at the spot strike."""
    options = [*quotes(day(7), strikes=(spot,), oi=oi, root=symbol), *quotes(day(7), strikes=(spot + 1,), oi=0, root=symbol)]
    return json.dumps(chain(options, spot=spot, timestamp=timestamp, symbol=symbol)).encode()


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
FUNDS = ["AIQD", "ETNG", "FNGD", "NVDL", "SH", "SPYU", "TQQQ"]


def all_chains() -> dict:
    return {symbol: body_of(symbol) for symbol in WITH_OPTIONS}


def run(fetch, rows=None, **options):
    out, log = io.StringIO(), []
    code = cli.collect(fetch, lambda: GENERATED, ROWS if rows is None else rows, out=out,
                       log=lambda *parts: log.append(" ".join(map(str, parts))), delay=0, **options)
    return code, out.getvalue(), log


def test_collect_prints_the_document_and_a_summary():
    fetch = FakeCboe(all_chains() | {"SH": body_of("SH", oi=10)})
    code, out, log = run(fetch)
    assert code == 0
    document = json.loads(out)
    assert document["generatedAt"] == "2026-11-12T15:40:11Z" and document["gate"] == GATE
    funds = {fund["symbol"]: fund for fund in document["funds"]}
    assert list(funds) == FUNDS
    assert funds["TQQQ"]["optionGate"] == "pass" and funds["TQQQ"]["options"]["bandOpenInterest"] == 10000
    assert (funds["TQQQ"]["options"]["session"], funds["TQQQ"]["options"]["twoSidedQuotes"]) == ("regular", 4)
    assert (funds["SH"]["optionGate"], funds["SH"]["optionGateReasons"]) == ("fail", ["open-interest-below-minimum"])
    assert (funds["SPYU"]["optionsListed"], funds["SPYU"]["optionGateReasons"]) == (False, ["no-listed-options"])
    # the control symbol is read before and after the funds; without --save-chains no reference chain is read
    assert fetch.calls[0] == "SPY" and fetch.calls[-1] == "SPY"
    assert sorted(fetch.calls[1:-1]) == FUNDS
    text = "\n".join(log)
    assert "directory: 17 rows, 7 leveraged or inverse products (etf: 4, etn: 3)" in text
    assert "by leverage: -3: 2, -1: 1, 2: 2, 3: 1, 4: 1" in text
    assert "unclassified names (the name signals leverage, the fund is not in the document): 1" in text
    assert "  QTUP  Defiance Long Pure Quantum ETF  (the name signals leverage, no rule reads a multiple)" in text
    assert "fetch failures of funds: 0" in text and "options listed: yes 4, no 3" in text
    assert "by gate label: fail: 4, pass: 3" in text
    assert "by gate reason: no-listed-options: 3, open-interest-below-minimum: 1" in text
    assert "chains by session: regular: 4" in text


def test_collect_stamps_the_document_after_the_last_chain_was_read():
    fetch, seen = FakeCboe(all_chains()), []

    def now() -> datetime:
        seen.append(len(fetch.calls))
        return GENERATED

    assert cli.collect(fetch, now, ROWS, out=io.StringIO(), log=lambda *parts: None, delay=0) == 0
    assert seen == [9]  # one reading of the clock, after the 7 funds and the two control reads


def test_collect_ends_without_a_request_when_the_directory_lists_no_leveraged_product():
    rows = rows_of("\n".join([HEADER, "Y|QQQ|Invesco QQQ Trust, Series 1|Q|G|Y|40|N|N||QQQ|N",
                              "File Creation Time: 1111202618:02|||||"]))
    fetch, out, log = FakeCboe(all_chains()), io.StringIO(), []
    assert cli.collect(fetch, lambda: GENERATED, rows, out=out, log=log.append, delay=0) == 1
    assert out.getvalue() == "" and fetch.calls == []
    assert log[-1] == "error: the directory lists no leveraged product; nothing to write"


def test_the_first_fund_that_fails_stops_the_run_and_nothing_is_written():
    fetch = FakeCboe(all_chains(), {"FNGD": TimeoutError("timed out")})
    code, out, log = run(fetch, workers=1)
    assert code == 1 and out == ""
    # one worker reads the funds in order: no request after FNGD, and no second control read
    assert fetch.calls == ["SPY", "AIQD", "ETNG", "FNGD"]
    assert "  FNGD  TimeoutError: timed out" in log and "fetch failures of funds: 1" in log
    assert "requests not sent after the first failure: 4" in log
    assert log[-1] == "error: the document is not written, because it would be partial"


def test_collect_writes_nothing_when_a_fund_chain_fails_with_four_workers(tmp_path):
    fetch = FakeCboe(all_chains(), {"NVDL": TimeoutError("timed out")})
    code, out, log = run(fetch, save_chains=tmp_path / "chains")
    assert code == 1 and out == ""
    assert "  NVDL  TimeoutError: timed out" in log and fetch.calls.count("SPY") == 1
    assert not (tmp_path / "chains" / "_run.json").exists()  # the folder is not the folder of a complete run


@pytest.mark.parametrize(("body", "failure"), [
    (b"<html>not json</html>", "JSONDecodeError"),
    (b"[]", "TypeError"),
    (json.dumps({"timestamp": "2026-11-12 15:30:00", "data": {}}).encode(), "ValueError: the chain is of no symbol, not of TQQQ"),
    (body_of("QQQ"), "ValueError: the chain is of QQQ, not of TQQQ"),
    (json.dumps(chain([{**option(day(7), "C", 100), "open_interest": float("inf")}])).encode(), "OverflowError"),
    (json.dumps(chain([option(day(7), "C", 100)])).replace('"open_interest": 0.0', '"open_interest": 1e999').encode(),
     "OverflowError"),
])
def test_collect_writes_nothing_when_a_chain_cannot_be_measured(body, failure):
    code, out, log = run(FakeCboe(all_chains() | {"TQQQ": body}))
    assert code == 1 and out == ""
    assert any(line.startswith(f"  TQQQ  {failure}") for line in log)


def test_a_negative_open_interest_ends_the_run_at_that_fund():
    # ETNG is the second fund. Its chain has one standard contract with a negative open interest.
    negative = chain([*quotes(day(7), root="ETNG"), option(day(7), "C", 105, oi=-1, root="ETNG")], symbol="ETNG")
    fetch = FakeCboe(all_chains() | {"ETNG": json.dumps(negative).encode()})
    code, out, log = run(fetch, workers=1)
    assert code == 1 and out == ""
    assert fetch.calls == ["SPY", "AIQD", "ETNG"]  # not after all chains were fetched
    assert f"  ETNG  ValueError: the contract ETNG{day(7):%y%m%d}C00105000 has a negative open interest" in log


def test_measure_refuses_a_negative_open_interest_of_a_standard_contract_only():
    with pytest.raises(ValueError, match="the contract TQQQ26111[0-9]P00099000 has a negative open interest"):
        liquidity.measure(chain([*quotes(day(7)), option(day(7), "P", 99, oi=-3)]), "TQQQ")
    with pytest.raises(ValueError, match="has a negative open interest"):
        liquidity.measure(chain([*quotes(day(7)), option(day(7), "P", 99, oi=-0.5)]), "TQQQ")  # not rounded to 0
    # an adjusted contract is not read at all
    adjusted = liquidity.measure(chain([*quotes(day(7)), option(day(7), "P", 99, oi=-3, root="TQQQ1")]), "TQQQ")
    assert adjusted.total_open_interest == 2400


@pytest.mark.parametrize(("row", "message"), [
    ("Y|TQQQ$|ProShares UltraPro QQQ|Q|G|Y|100|N|N||TQQQ$|N", "error: symbol 'TQQQ$' is outside the document contract"),
    ("Y|TQQQ-A|ProShares UltraPro QQQ|Q|G|Y|100|N|N||TQQQ-A|N", "error: symbol 'TQQQ-A' is outside the document contract"),
    (f"Y|LONG|ProShares UltraPro {'Q' * 200}|Q|G|Y|100|N|N||LONG|N", "error: LONG: name or listing exchange is outside"),
])
def test_a_fund_that_the_document_cannot_hold_ends_the_run_before_any_chain_is_read(row, message):
    rows = rows_of(LISTING.replace("File Creation Time", f"{row}\nFile Creation Time"))
    fetch = FakeCboe(all_chains())
    code, out, log = run(fetch, rows=rows)
    assert code == 1 and out == "" and fetch.calls == []  # not even the control chain
    assert log[-1].startswith(message) and log[-1].endswith("; no chain was read")


def test_collect_writes_nothing_when_a_number_of_the_document_is_not_finite():
    infinite = chain(quotes(day(7)))
    infinite["data"]["current_price"] = float("inf")
    code, out, log = run(FakeCboe(all_chains() | {"TQQQ": json.dumps(infinite).encode()}))
    assert code == 1 and out == ""
    assert log[-1].startswith("error: Out of range float values are not JSON compliant")


def test_a_chain_without_a_standard_contract_is_a_row_with_its_own_reason(tmp_path):
    adjusted = json.dumps(chain(quotes(day(7), root="TQQQ1"))).encode()  # only contracts that a split adjusted
    code, out, log = run(FakeCboe(all_chains() | {"TQQQ": adjusted}), save_chains=tmp_path)
    assert code == 0
    tqqq = json.loads(out)["funds"][-1]
    assert (tqqq["symbol"], tqqq["optionsListed"], tqqq["options"]) == ("TQQQ", False, None)
    assert (tqqq["optionGate"], tqqq["optionGateReasons"]) == ("fail", ["no-standard-contract"])
    # Cboe has a chain file for the fund: the file is saved and the fund is not in the "no chain file" list
    assert (tmp_path / "TQQQ.json").read_bytes() == adjusted
    assert json.loads((tmp_path / "_run.json").read_text())["noChainFile"] == ["AIQD", "FNGD", "SPYU"]
    assert "by gate reason: no-listed-options: 3, no-standard-contract: 1" in log


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

    code, out, log = run(Blocked(all_chains()))
    assert code == 1 and out == ""  # else every fund would read as "no listed options"


def test_collect_saves_the_raw_chains_of_the_funds_and_of_their_references(tmp_path):
    fetch = FakeCboe(all_chains(), {"NVDA": TimeoutError("timed out")})
    code, out, log = run(fetch, save_chains=tmp_path / "chains")
    assert code == 0 and len(json.loads(out)["funds"]) == 7  # a reference chain that fails does not stop the run
    saved = sorted(path.name for path in (tmp_path / "chains").iterdir())
    assert saved == ["ETN.json", "ETNG.json", "NVDL.json", "QQQ.json", "SH.json", "SPY.json", "TQQQ.json", "_run.json"]
    assert (tmp_path / "chains" / "TQQQ.json").read_bytes() == body_of("TQQQ")
    assert "reference chains not saved: 1" in log and "  NVDA  TimeoutError: timed out" in log
    assert f"chains saved: 7 in {tmp_path / 'chains'}" in log
    # the record of a complete run: its time, its funds, and the funds for which Cboe had no chain file
    assert json.loads((tmp_path / "chains" / "_run.json").read_text()) == {
        "generatedAt": "2026-11-12T15:40:11Z", "funds": FUNDS, "noChainFile": ["AIQD", "FNGD", "SPYU"]}


@pytest.mark.parametrize("failing", ["_listing.txt", "_run.json"])
def test_collect_writes_nothing_when_a_record_of_the_run_cannot_be_saved(tmp_path, monkeypatch, failing):
    def save(directory, name, body, real=cli.save):
        if name == failing:
            raise OSError("disk full")
        real(directory, name, body)

    monkeypatch.setattr(cli, "save", save)
    code, out, log = run(FakeCboe(all_chains()), save_chains=tmp_path, listing=LISTING)
    assert code == 1 and out == ""
    assert log[-1] == f"error: {tmp_path / failing} could not be written: OSError: disk full"
    assert not (tmp_path / "_run.json").exists()  # the folder is not the folder of a complete run


def test_a_complete_run_keeps_the_listing_that_it_read_and_names_it_in_the_record(tmp_path):
    code, _, _ = run(FakeCboe(all_chains()), save_chains=tmp_path, listing=LISTING)
    assert code == 0
    assert (tmp_path / "_listing.txt").read_text(encoding="utf-8") == LISTING
    record = json.loads((tmp_path / "_run.json").read_text())
    assert list(record) == ["generatedAt", "funds", "noChainFile", "listing"] and record["listing"] == "_listing.txt"
    assert cli.saved_run(tmp_path)[3] == tmp_path / "_listing.txt"


def test_a_failed_run_keeps_no_listing(tmp_path):
    code, _, _ = run(FakeCboe(all_chains(), {"NVDL": TimeoutError("timed out")}), save_chains=tmp_path, listing=LISTING)
    assert code == 1 and not (tmp_path / "_listing.txt").exists() and not (tmp_path / "_run.json").exists()


# --- a saved run (--chains-from) -----------------------------------------------------------------------------

def saved_run(tmp_path: Path) -> tuple[Path, str]:
    """The --save-chains folder of one complete run that kept no listing (as the runs before the listing was
    kept) and the document of that run."""
    folder = tmp_path / "chains"
    code, out, _ = run(FakeCboe(all_chains() | {"SH": body_of("SH", oi=10)}), save_chains=folder)
    assert code == 0
    return folder, out


def test_a_saved_run_gives_its_document_again_and_needs_no_control_chain(tmp_path):
    folder, document = saved_run(tmp_path)
    (folder / "SPY.json").unlink()  # the control chain is a question to Cboe; a saved run has its answers
    before = {path.name: path.read_bytes() for path in folder.iterdir()}
    generated_at, funds, fetch, listing = cli.saved_run(folder)
    assert generated_at == GENERATED.replace(microsecond=0) and funds == frozenset(FUNDS) and listing is None
    out, log = io.StringIO(), []
    code = cli.collect(fetch, lambda: generated_at, ROWS, saved_funds=funds, out=out, log=log.append, delay=0)
    assert code == 0 and out.getvalue() == document
    assert {path.name: path.read_bytes() for path in folder.iterdir()} == before  # nothing is written there


def test_a_saved_run_that_did_not_request_a_fund_of_the_directory_gives_no_document(tmp_path):
    # the import deletes every fund that is not in the document: a document without SPYU and TQQQ is partial
    folder, _ = saved_run(tmp_path)
    _, funds, fetch, _ = cli.saved_run(folder)
    calls = []
    code, out, log = run(lambda url: calls.append(url) or fetch(url), saved_funds=funds - {"SPYU", "TQQQ"})
    assert code == 1 and out == "" and calls == []  # no chain is read for a document that cannot be written
    assert log[-2:] == ["error: the saved run did not request the chains of 2 funds of this directory; "
                        "the document is not written, because it would be partial", "  SPYU TQQQ"]


def test_a_saved_run_may_hold_a_fund_that_the_directory_does_not_list_any_more(tmp_path):
    folder, document = saved_run(tmp_path)
    _, funds, fetch, _ = cli.saved_run(folder)
    code, out, _ = run(fetch, saved_funds=funds | {"GONE"})
    assert code == 0 and json.loads(out) == json.loads(document)  # every fund of the directory is in it


def test_main_gives_no_document_when_the_listing_has_a_fund_that_the_saved_run_did_not_request(tmp_path, monkeypatch, capsys):
    folder, _ = saved_run(tmp_path)
    listing = tmp_path / "nasdaqtraded.txt"
    newer = LISTING.replace("File Creation Time", "Y|SQQQ|ProShares UltraPro Short QQQ|Q|G|Y|100|N|N||SQQQ|N\nFile Creation Time")
    listing.write_text(padded(newer), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", str(listing), "--chains-from", str(folder)])
    assert cli.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "error: the saved run did not request the chains of 1 funds of this directory" in captured.err
    assert captured.err.rstrip().endswith("\n  SQQQ")


def test_a_saved_run_with_a_missing_chain_file_ends_without_a_document(tmp_path):
    folder, _ = saved_run(tmp_path)
    (folder / "NVDL.json").unlink()  # the saved run read this chain: "no file" now is not "no listed options"
    _, funds, fetch, _ = cli.saved_run(folder)
    code, out, log = run(fetch, saved_funds=funds)
    assert code == 1 and out == ""
    assert any(line.startswith("  NVDL  FileNotFoundError") for line in log)


def test_main_measures_a_saved_run_again_without_the_network(tmp_path, monkeypatch, capsys):
    folder, document = saved_run(tmp_path)
    listing = tmp_path / "nasdaqtraded.txt"
    listing.write_text(padded(LISTING), encoding="utf-8")
    monkeypatch.setattr(cli, "urlopen", lambda *args, **kwargs: pytest.fail("the network was used"))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", str(listing), "--chains-from", str(folder)])
    assert cli.main() == 0
    captured = capsys.readouterr()
    assert captured.out == document  # also the generatedAt of the saved run
    assert "directory: 10017 rows, 7 leveraged or inverse products" in captured.err


@pytest.mark.parametrize(("record", "failure"), [
    (None, "FileNotFoundError"),
    ("not json", "JSONDecodeError"),
    ('{"generatedAt": "2026-11-12T15:40:11Z", "funds": []}', "KeyError: 'noChainFile'"),
    ('{"generatedAt": "2026-11-12 15:40", "funds": [], "noChainFile": []}', "ValueError"),
    ('{"generatedAt": "2026-11-12T15:40:11Z", "funds": 7, "noChainFile": []}', "TypeError"),
    ('{"generatedAt": "2026-11-12T15:40:11Z", "funds": [], "noChainFile": [], "listing": "../nasdaqtraded.txt"}',
     "ValueError: the listing '../nasdaqtraded.txt' is not the name of a file in the folder"),
    ('{"generatedAt": "2026-11-12T15:40:11Z", "funds": [], "noChainFile": [], "listing": 7}',
     "ValueError: the listing 7 is not the name of a file in the folder"),
])
def test_main_refuses_a_folder_that_is_not_the_folder_of_a_complete_run(tmp_path, monkeypatch, capsys, record, failure):
    listing = tmp_path / "nasdaqtraded.txt"
    listing.write_text(padded(LISTING), encoding="utf-8")
    if record is not None:
        (tmp_path / "_run.json").write_text(record, encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", str(listing), "--chains-from", str(tmp_path)])
    assert cli.main() == 1
    captured = capsys.readouterr()
    assert captured.out == "" and f"error: {tmp_path} is not the folder of a complete run: {failure}" in captured.err


def test_main_needs_a_listing_for_a_saved_run_that_kept_none(tmp_path, monkeypatch, capsys):
    folder, _ = saved_run(tmp_path)
    monkeypatch.setattr(cli, "urlopen", lambda *args, **kwargs: pytest.fail("the network was used"))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--chains-from", str(folder)])
    with pytest.raises(SystemExit) as stopped:
        cli.main()
    captured = capsys.readouterr()
    assert stopped.value.code == 2 and captured.out == ""
    assert f"--chains-from needs --listing: the run of {folder} kept no listing" in captured.err


def test_main_refuses_to_read_and_to_write_a_chain_folder_in_one_run(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", "nasdaqtraded.txt", "--chains-from", "chains",
                                      "--save-chains", "other"])
    with pytest.raises(SystemExit) as stopped:
        cli.main()
    assert stopped.value.code == 2 and capsys.readouterr().out == ""


@pytest.mark.parametrize(("text", "message"), [
    (LISTING, "error: the symbol directory has 17 rows; a whole directory has at least 10000"),
    (padded(LISTING).split("File Creation Time")[0], "error: the symbol directory does not end with the 'File Creation Time' line"),
    (None, "error: the symbol directory could not be read: FileNotFoundError"),
])
def test_main_ends_without_a_document_when_the_listing_is_short_or_cannot_be_read(tmp_path, monkeypatch, capsys, text, message):
    listing = tmp_path / "nasdaqtraded.txt"
    if text is not None:
        listing.write_text(text, encoding="utf-8")
    monkeypatch.setattr(cli, "urlopen", lambda *args, **kwargs: pytest.fail("the network was used"))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", str(listing)])
    assert cli.main() == 1
    captured = capsys.readouterr()
    assert captured.out == "" and message in captured.err


# --- the network -----------------------------------------------------------------------------------------------

class Reply:
    def __init__(self, body: bytes, encoding: str | None = None):
        self.body, self.headers = body, {"Content-Encoding": encoding} if encoding else {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self) -> bytes:
        return self.body


class FakeClock:
    """The clock of a Pace: `sleep` keeps the wait and moves the time."""

    def __init__(self):
        self.time, self.waits = 0.0, []

    def now(self) -> float:
        return self.time

    def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.time += seconds


def paced() -> tuple:
    fake = FakeClock()
    return cli.Pace(now=fake.now, sleep=fake.sleep), fake


def http_error(code: int, body: bytes, **headers: str) -> urllib.error.HTTPError:
    message = Message()
    for name, value in headers.items():
        message[name.replace("_", "-")] = value
    return urllib.error.HTTPError("https://example.invalid/x.json", code, "error", message, io.BytesIO(body))


def replying(monkeypatch, replies: list) -> None:
    """`urlopen` of the fetcher raises the next planned reply."""
    def urlopen(request, timeout):
        assert request.get_header("User-agent") == cli.USER_AGENT and timeout == cli.TIMEOUT
        raise replies.pop(0)

    monkeypatch.setattr(cli, "urlopen", urlopen)


def fake_network(monkeypatch, listing: str) -> None:
    """`urlopen` of the fetcher: the symbol directory and one chain per symbol of WITH_OPTIONS. The chains are
    of 10 days before any clock that can run a test: no test may depend on the time of day."""
    bodies = {symbol: body_of(symbol, timestamp="2026-11-02 15:30:00") for symbol in WITH_OPTIONS}

    def urlopen(request, timeout):
        if request.full_url == universe.LISTING_URL:
            return Reply(gzip.compress(listing.encode()), "gzip")
        symbol = request.full_url.rsplit("/", 1)[1].removesuffix(".json")
        if symbol not in bodies:
            raise http_error(403, b"<Error><Code>AccessDenied</Code></Error>")
        return Reply(bodies[symbol])

    monkeypatch.setattr(cli, "urlopen", urlopen)
    monkeypatch.setattr(cli, "DELAY", 0)


def test_main_reads_the_listing_and_the_chains_with_one_shared_pace(tmp_path, monkeypatch, capsys):
    paces = []
    fake_network(monkeypatch, padded(LISTING))
    monkeypatch.setattr(cli, "http_get", lambda url, pace, real=cli.http_get: paces.append(pace) or real(url, pace))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--save-chains", str(tmp_path / "chains")])
    assert cli.main() == 0
    document = json.loads(capsys.readouterr().out)
    assert [fund["symbol"] for fund in document["funds"]] == FUNDS
    assert {fund["optionGateReasons"][0] for fund in document["funds"]} == {"no-listed-options", "stale-chain"}
    assert json.loads((tmp_path / "chains" / "_run.json").read_text())["generatedAt"] == document["generatedAt"]
    # the listing, the two control reads, 7 funds and 4 references: every request waits on the same Pace
    assert len(paces) == 14 and len(set(map(id, paces))) == 1


def test_main_measures_its_own_saved_run_again_from_the_folder_alone(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "chains"
    fake_network(monkeypatch, padded(LISTING))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--save-chains", str(folder)])
    assert cli.main() == 0
    document = capsys.readouterr().out
    assert (folder / "_listing.txt").read_text(encoding="utf-8") == padded(LISTING)  # the directory that the run read
    before = {path.name: path.read_bytes() for path in folder.iterdir()}

    # the same folder, no --listing and no network: the document of the run, with its generatedAt
    monkeypatch.setattr(cli, "urlopen", lambda *args, **kwargs: pytest.fail("the network was used"))
    monkeypatch.setattr(sys, "argv", ["universe.py", "--chains-from", str(folder)])
    assert cli.main() == 0
    assert capsys.readouterr().out == document
    assert {path.name: path.read_bytes() for path in folder.iterdir()} == before  # nothing is written there

    # --listing names another directory: that one is read, and its new fund makes the document partial
    newer = tmp_path / "nasdaqtraded.txt"
    newer.write_text(padded(LISTING.replace("File Creation Time", "Y|SQQQ|ProShares UltraPro Short QQQ|Q|G|Y|100|N|N||SQQQ|N\n"
                                            "File Creation Time")), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["universe.py", "--listing", str(newer), "--chains-from", str(folder)])
    assert cli.main() == 1
    assert capsys.readouterr().err.rstrip().endswith("\n  SQQQ")

    # the listing that the record names is gone: the run ends, it does not read the network
    (folder / "_listing.txt").unlink()
    monkeypatch.setattr(sys, "argv", ["universe.py", "--chains-from", str(folder)])
    assert cli.main() == 1
    assert "error: the symbol directory could not be read: FileNotFoundError" in capsys.readouterr().err


def test_http_get_reads_access_denied_as_no_file_and_tries_other_errors_three_times(monkeypatch):
    pace, fake = paced()
    replies = [http_error(403, b"<Error><Code>AccessDenied</Code></Error>")]
    replying(monkeypatch, replies)
    with pytest.raises(cli.NoFile):
        cli.http_get("https://example.invalid/x.json", pace)
    assert fake.waits == []  # "no file" is an answer: it is not tried again
    replies[:] = [http_error(403, b"<html>blocked</html>"), http_error(503, b""), TimeoutError("timed out")]
    with pytest.raises(TimeoutError):
        cli.http_get("https://example.invalid/x.json", pace)
    assert replies == [] and fake.waits == [2, 4]


def test_http_get_reads_a_gzip_packed_access_denied(monkeypatch):
    # The real run of 2026-11-12 failed on this: Cboe packs the AccessDenied document when gzip is asked for.
    pace, fake = paced()
    replying(monkeypatch, [http_error(403, gzip.compress(b"<Error><Code>AccessDenied</Code></Error>"), Content_Encoding="gzip")])
    with pytest.raises(cli.NoFile):
        cli.http_get("https://example.invalid/x.json", pace)
    assert fake.waits == []
    assert cli.unpacked(b"not gzip", {"Content-Encoding": "gzip"}) == b"not gzip"
    assert cli.unpacked(b"plain", {}) == b"plain"


def test_a_rate_limit_slows_every_worker(monkeypatch):
    # The real run of 2026-11-12 got HTTP 429 when the requests came too fast.
    pace, fake = paced()
    replies = [http_error(429, b"", Retry_After="7"), http_error(429, b""), http_error(429, b"")]
    replying(monkeypatch, replies)
    with pytest.raises(urllib.error.HTTPError):
        cli.http_get("https://example.invalid/x.json", pace)
    assert replies == [] and fake.waits == [7, 60]
    # the third 429 asks for 90 seconds: a worker that is due in 1 second waits for them before its request
    assert pace.wait(1.0) is True and fake.waits == [7, 60, 90]
    assert cli.rate_limit_wait({"Retry-After": "900"}, 0) == cli.MAX_RETRY_AFTER == 120
    assert cli.rate_limit_wait({}, 0) == 30 and cli.rate_limit_wait({"Retry-After": "Wed, 21 Oct 2026"}, 1) == 60


def test_a_back_off_is_shared_and_a_shorter_one_does_not_shorten_it():
    pace, fake = paced()
    pace.back_off(30)
    assert pace.wait(1.0) and fake.waits == [30]
    assert pace.wait(1.0) and fake.waits == [30, 1.0]  # the back-off is over: the wait of the worker alone
    pace.back_off(5)
    pace.back_off(2)
    assert pace.wait() and fake.waits == [30, 1.0, 5]
    assert pace.wait() and fake.waits == [30, 1.0, 5]  # nothing to wait for


def test_a_stopped_run_sends_no_request(monkeypatch):
    pace, fake = paced()
    pace.stop()
    assert pace.wait(1.0) is False and fake.waits == []
    fetch = FakeCboe(all_chains())
    assert cli.read_chain(fetch, "TQQQ", None, True, 0, pace) == ("skipped", None) and fetch.calls == []
    # a request that is between two tries when the run stops is not tried again
    replies = [http_error(503, b""), http_error(503, b""), http_error(503, b"")]
    replying(monkeypatch, replies)
    with pytest.raises(cli.Stopped):
        cli.http_get("https://example.invalid/x.json", pace)
    assert len(replies) == 2
    assert cli.answer(lambda url: cli.http_get(url, pace), "TQQQ", None, True) == ("skipped", None)


def test_only_a_fund_that_fails_stops_the_run():
    failing = FakeCboe({}, {"NVDA": TimeoutError("timed out"), "TQQQ": TimeoutError("timed out")})
    pace, _ = paced()
    assert cli.read_chain(failing, "NVDA", None, False, 0, pace)[0] == "failed" and pace.wait() is True  # a reference
    assert cli.read_chain(failing, "TQQQ", None, True, 0, pace)[0] == "failed" and pace.wait() is False


def test_stopping_ends_the_wait_of_a_worker_at_once():
    pace = cli.Pace()  # the real clock: the worker would wait 60 seconds
    stopper = threading.Timer(0.05, pace.stop)
    stopper.start()
    started = time.monotonic()
    assert pace.wait(60) is False and time.monotonic() - started < 30
    stopper.join()


def test_http_get_returns_the_body_and_unpacks_gzip(monkeypatch):
    pace, _ = paced()
    monkeypatch.setattr(cli, "urlopen", lambda request, timeout: Reply(gzip.compress(b'{"a": 1}'), "gzip"))
    assert cli.http_get("https://example.invalid/x.json", pace) == b'{"a": 1}'
    monkeypatch.setattr(cli, "urlopen", lambda request, timeout: Reply(b"plain"))
    assert cli.http_get("https://example.invalid/x.json", pace) == b"plain"


if __name__ == "__main__":
    FIXTURES.joinpath("universe-document.json").write_text(json.dumps(fixture_document(), indent=2) + "\n", encoding="utf-8")
