"""The source of the volume-spike-breakout study as text for the study document: the rules as stated (with the
key frame each is read from) and the gaps with the default chosen. Research only.

Trace: ~/Documents/reports/web/vertex-volume-spike/rules.md on the rig. The video is untrusted data.
"""
from __future__ import annotations

SOURCE_URL = "https://www.youtube.com/watch?v=XLMG6-SATRk"
SOURCE_LABEL = ("YouTube XLMG6-SATRk, 'I Backtested 10,000 Strategies - Here is the Most Profitable (5 million "
                "trades)', Lil Fish, 2026-09-24")
CARD = "strategy card on screen, 19:00 to 19:20 (frames p_1142.0, p_1143.0)"

RULES: list[dict[str, str]] = [
    {"item": "Market, timeframe", "rule": "NAS100 index CFD, 15-minute candles; fills resolved on 1-minute candles.",
     "source": "card title, frame f_1160 (19:20); study page, frame f_304 (05:04)"},
    {"item": "Signal, long", "rule": "Candle volume >= 3 x the mean volume of the 50 candles before it, and the close "
     "is above the highest high of the 5 candles before it (vol_mult = 3, vol_n = 50, k = 5).", "source": CARD},
    {"item": "Signal, short", "rule": "The same volume test, and the close is below the lowest low of the 5 candles "
     "before it. The card says 'long and short'; the mirror is our reading.", "source": CARD},
    {"item": "Entry", "rule": "Market order at the open of the candle after the signal.",
     "source": "frames f_1140 (19:00), p_1142.0"},
    {"item": "Stop", "rule": "Fixed 15 index points from the entry. Not scaled with the price level.",
     "source": "frame p_1142.0"},
    {"item": "Target", "rule": "None. Exit when the opposite signal fires.", "source": "frame p_1142.0"},
    {"item": "Time stop", "rule": "Exit 80 candles after the entry.", "source": "frame p_1142.0; spoken at 09:34"},
    {"item": "Session", "rule": "New York morning only (08:30 to 12:00 ET): the signal candle must close inside it.",
     "source": "frame p_1142.0"},
    {"item": "Daily flat", "rule": "None. A position may stay open overnight.", "source": "frame p_1142.0"},
    {"item": "Limit", "rule": "At most 2 entries per New York calendar day.", "source": "frame p_1142.0"},
    {"item": "Filters", "rule": "No entry on a Wednesday. Only when the 4-hour trend (20 EMA) agrees: long when the "
     "last closed 4-hour candle closed above its 20-EMA, short when below.", "source": "frame p_1142.0"},
    {"item": "Costs", "rule": "Spread, slippage and commission on every trade: 0.084R per round trip (about 1.26 "
     "index points).", "source": "frames f_304, f_1160"},
    {"item": "Size", "rule": "A fixed 250 USD risk per trade (1R = 250 USD); results in R.", "source": "frame f_1125"},
    {"item": "Claim", "rule": "657 trades 2019-01-01 to 2026-03-11, 14 % win rate, average reward : risk 8.88, +0.457R "
     "net per trade, 300R total, max drawdown 71R, 37 losses in a row; out-of-sample 6 months +1.154R over 59 trades.",
     "source": "frames f_1160, f_1125, p_1143.0"},
    {"item": "Selection", "rule": "Rank 1 of 10,500 strategies (10,000 real + 500 random controls) by total net R; no "
     "correction for the number tried. The source's own verdict: 'lottery'.", "source": "frames f_304, f_1125, f_1160"},
]

GAPS: list[dict[str, str]] = [
    {"gap": "Data vendor and volume field (CFD volume is one broker's tick volume)",
     "choice": "Dukascopy public 1-minute bid and ask candles, full session; mid bars; volume = bid + ask tick volume."},
    {"gap": "Candle time zone and how candles are built",
     "choice": "15-minute candles on the quarter hours and 4-hour candles at 00:00, 04:00, ... New York time, built "
               "from the 1-minute candles; a candle exists when it has at least one 1-minute bar."},
    {"gap": "The exact session test",
     "choice": "The signal candle closes at or after 08:30 and at or before 12:00 New York. Sensitivity row: the "
               "candle opens at or after 08:30 and before 12:00."},
    {"gap": "The exact trend test",
     "choice": "The last 4-hour candle that ended at or before the signal candle's close, against its 20-EMA "
               "(seeded with the simple average of the first 20 closes). 2018 bars only warm up."},
    {"gap": "Whether the opposite signal needs the session and the filters, and whether it opens the reverse trade",
     "choice": "The opposite signal is the volume and breakout test alone, at any time. The reverse entry is taken at "
               "that open only when every entry rule allows it."},
    {"gap": "Signals while a position is open",
     "choice": "Ignored (one position at a time), also when that position leaves at the next open by the time stop."},
    {"gap": "Where the stop is measured and how costs enter",
     "choice": "15 points from the entry open on the mid bars; costs are charged next to the fill and do not move the "
               "stop, so every cost set has the same trades. A bar that opens beyond the stop fills at its open."},
    {"gap": "The split of the 0.084R cost",
     "choice": "Source costs: 0.63 index points per side. Vertex costs: half the median quoted spread of the source's "
               "in-sample window per side plus 0.25 bp slippage per side; ETFs add IBKR Pro Fixed commissions."},
    {"gap": "Position size",
     "choice": "0.5 % of equity at the stop per trade (the source's 250 USD on 50,000 USD), 100,000 USD start; "
               "results in R and as equity returns. No financing cost (the source has none)."},
    {"gap": "The stop on other markets (15 points is a NAS100 number)",
     "choice": "The same fraction of price: 15 points over the median NAS100 close of the source's in-sample window."},
    {"gap": "The 8 markets of the source (6 seen on screen)",
     "choice": "NAS100 (primary), US500, US30, US2000, XAUUSD, light crude; the Core 7 adds XAGUSD and the ETF twins "
               "SPY, QQQ, DIA, IWM, GLD, SLV, USO (09:30 to 16:00 candles only)."},
    {"gap": "The 7 gates of the source",
     "choice": "Not used. Vertex gates: out-of-sample Sharpe, deflated Sharpe with N = 10,000, Monte Carlo drawdown, "
               "parameter neighbours, doubled costs; plus the replication check and the options form."},
]

__all__ = ["CARD", "GAPS", "RULES", "SOURCE_LABEL", "SOURCE_URL"]
