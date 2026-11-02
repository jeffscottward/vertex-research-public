"""Fixed research universes for the alert-template backtests (Vertex default, basis A).

STOCKS is a fixed list of large US companies (S&P 100 names as of 2026, written from memory and
NOT point-in-time) plus the tickers the template pages listed on 2026-10-24. Using today's names
for 2005-2026 adds survivorship bias: companies that failed or were delisted are missing.
"""
from __future__ import annotations

SP100 = (
    "AAPL ABBV ABT ACN ADBE AIG AMD AMGN AMT AMZN AVGO AXP BA BAC BK BKNG BLK BMY BRK-B C CAT "
    "CHTR CL CMCSA COF COP COST CRM CSCO CVS CVX DE DHR DIS DUK EMR F FDX GD GE GILD GM GOOGL "
    "GS HD HON IBM INTC INTU ISRG JNJ JPM KO LIN LLY LMT LOW MA MCD MDLZ MDT MET META MMM MO MRK "
    "MS MSFT NEE NFLX NKE NVDA ORCL PEP PFE PG PM QCOM RTX SBUX SCHW SO SPG T TGT TMO TMUS TSLA "
    "TXN UNH UNP UPS USB V VZ WFC WMT XOM"
).split()

TEMPLATE_LISTED = (
    "CLF EFX WCN LW NDAQ CSX BOX DOCU BRZE TECH HAS CDW BBY PR LNG CTAS FRSH TENB DXC OGN DV DBX "
    "OVV TREX EXEL DAL EXPE ZM FCX FTI HPE APH DXCM RBLX OTIS CCL LUV SYK LEN TSN KR AES SYY "
    "WTRG WM ELV ROL TSCO"
).split()

STOCKS = tuple(dict.fromkeys(SP100 + TEMPLATE_LISTED))
SECTOR_ETFS = ("XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC")
STRESS = ("^VIX", "SPY", "QQQ", "IWM", "TLT", "HYG")
ALL_SYMBOLS = tuple(dict.fromkeys(STOCKS + SECTOR_ETFS + STRESS))
