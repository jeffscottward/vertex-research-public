"""The reel's stated rules and the defaults chosen for its gaps, as stored in the study document.

Traceable to the reel transcript and key frames (~/Documents/reports/web/vertex-reel-dffcosd/rules.md
on the rig; summary in docs/specs/strategies/ld34-nested-donchian-breakout.md).
"""
from __future__ import annotations

RULES: list[dict[str, str]] = [
    {"item": "Direction", "rule": "Long only; never short.", "source": "frame 1.5 s, frame 5 s"},
    {"item": "Markets (sheet)", "rule": "SPX500, NAS100, BTCUSD.", "source": "frame 1.5 s (chips)"},
    {"item": "Markets (results shown)", "rule": "USDJPY, GBPJPY, AUDJPY, CHFJPY, EURJPY, XAUUSD, NDX in an MT5 optimisation.",
     "source": "frames 61 s, 75 s; transcript 51-64 s"},
    {"item": "Signal timeframe", "rule": "H1 (each one-hour bar).", "source": "frame 33 s; transcript 18-23 s"},
    {"item": "Levels", "rule": "Nested Donchian 20 / 50 / 100 / 200-bar highs and lows on the Daily; keep the nearest 4 each side of price.",
     "source": "frames 33 s, 36 s; transcript 18-29 s"},
    {"item": "Entry", "rule": "An H1 candle closes above one of the upper levels (a breakout to new relative highs); market order long.",
     "source": "frames 33 s, 38 s; transcript 28-40 s"},
    {"item": "Each level", "rule": "Each level fires once.", "source": "frame 38 s"},
    {"item": "Stop", "rule": "Stop = 2 x ATR(14).", "source": "frame 38 s; transcript 34-40 s"},
    {"item": "Sizing", "rule": "Risk 1 % per trade.", "source": "frame 38 s; transcript 34-40 s"},
    {"item": "Target", "rule": "No fixed take profit.", "source": "frames 36 s, 41 s; transcript 40-46 s"},
    {"item": "Trail", "rule": "At +1R a 2 x ATR trail ratchets behind price.", "source": "frames 41 s, 45 s; transcript 40-46 s"},
    {"item": "Breakeven", "rule": "Breakeven backstop at +2R.", "source": "frame 45 s; transcript 46-52 s"},
    {"item": "Claimed results", "rule": ("MT5 optimisation, 100k USD start: PF 1.12-1.47, 188-268 trades, drawdown 8-30 %; "
                                         "window and costs not shown. The 450 % is the whole multi-system account."),
     "source": "frames 61 s, 75 s, 88 s"},
]

GAPS: list[dict[str, str]] = [
    {"gap": "Does a daily level include the forming day?", "choice": "No: completed days only (no look-ahead)."},
    {"gap": "When does a trading day start?", "choice": "17:00 New York (FX/CFD/futures convention); US ETF hours keep their date."},
    {"gap": "Which levels are upper levels?", "choice": "All 8 highs and lows; any level above the previous close can be broken. With 8 levels the 'nearest 4' cap never binds."},
    {"gap": "What counts as a close above?", "choice": "Previous H1 close at or below the current level and this H1 close above it (DSL breaksAbove)."},
    {"gap": "What identifies a level for 'fires once'?", "choice": "Its value: a level value triggers once; a new Donchian value is a new level (DSL oncePerLevel)."},
    {"gap": "Several open positions?", "choice": "One position per market (the engines hold one position)."},
    {"gap": "ATR timeframe", "choice": "ATR(14) of the H1 bars (the chart the EA runs on)."},
    {"gap": "Trail anchor", "choice": "Highest H1 close since entry minus 2 x ATR(14), moved at each H1 close, never lowered; armed once the high reaches +1R."},
    {"gap": "Stop fill", "choice": "Stop-market: the stop price, or the bar open when the bar gaps through it."},
    {"gap": "Leverage", "choice": "1 % risk needs leverage on tight hourly stops: capped at ESMA retail CFD limits (major index 20, Russell 10, FX 20-30, gold 20, other commodities 10, crypto 2) and 2 for ETFs."},
    {"gap": "Costs", "choice": "Measured median Dukascopy spread + 0.5-5 bps slippage; IBKR Pro Fixed for ETFs; interest on the borrowed part at T-bill + 1.5 %."},
    {"gap": "Data", "choice": "Dukascopy public H1 bid/ask (the reel's NDX row is Dukascopy data): indices 2012/2013+, FX and metals 2003+, BTC 2017+, ETFs 2017+."},
    {"gap": "Options form (Vertex)", "choice": "45-DTE call debit vertical on the Core 7 ETF twin per signal, 2 % max loss, exits with the underlying or at 7 DTE; no BTC options form."},
]
