"""The reel's rules (and the papers it relies on) and the defaults chosen for its gaps, as stored in the study.

Traceable to the reel transcript and key frames (~/Documents/reports/web/vertex-reel-dffkn31/rules.md on the
rig; summary in docs/specs/strategies/market-intraday-momentum.md).
"""
from __future__ import annotations

RULES: list[dict[str, str]] = [
    {"item": "Reel claim", "rule": "The first half hour of the session predicts the last half hour (intraday momentum); "
     "the reel states no entry, exit, stop, target or sizing of its own.",
     "source": "transcript 0-15 s; frames k01, k02 (paper on screen)"},
    {"item": "GHLZ signal", "rule": "r1 = return from the previous trading day's 16:00 close to today's 10:00 price "
     "(overnight + first half hour).", "source": "Gao, Han, Li & Zhou (JFE 2018), frame k02"},
    {"item": "GHLZ entry", "rule": "At 15:30 New York long if r1 > 0, short if r1 < 0, flat if r1 = 0.",
     "source": "Gao, Han, Li & Zhou (JFE 2018), frame k02"},
    {"item": "GHLZ exit", "rule": "Flat at the 16:00 close the same day; no stop, no target; 100 % of equity, no leverage.",
     "source": "Gao, Han, Li & Zhou (JFE 2018)"},
    {"item": "GHLZ r1+r12 variant", "rule": "Long only if r1 > 0 and the 15:00-15:30 return r12 > 0, short only if both "
     "< 0, else flat.", "source": "Gao, Han, Li & Zhou (JFE 2018)"},
    {"item": "ZAB noise band", "rule": "sigma(t) = mean over the previous 14 sessions of |close(t) / open - 1| at that "
     "time of day; upper = max(open, previous close) x (1 + sigma), lower = min(open, previous close) x (1 - sigma).",
     "source": "Zarattini, Aziz & Barbon (2024), SSRN 4824172 (task note)"},
    {"item": "ZAB entry", "rule": "At every HH:00 and HH:30 from 10:00 to 15:30 long when the close is above the upper "
     "band, short when below the lower band; a flat position may re-enter later that day.",
     "source": "Zarattini, Aziz & Barbon (2024)"},
    {"item": "ZAB exit", "rule": "Checked at the decision times: long exits below max(upper band, session VWAP), short "
     "exits above min(lower band, VWAP); everything closes at 16:00.", "source": "Zarattini, Aziz & Barbon (2024)"},
    {"item": "ZAB sizing", "rule": "Volatility target: leverage = min(4, 2 % / 14-day daily volatility).",
     "source": "Zarattini, Aziz & Barbon (2024)"},
    {"item": "Bias tracker panel", "rule": "Eight factors, each Long / Neutral / Short: Initial Move, VWAP, Daily Candle, "
     "Initial Hour HL, Session Delta, Value Area Shift, ORB, Gap; read-out BIAS 50.00, STATE Bullish.",
     "source": "frames k06, k07; transcript 26-50 s"},
    {"item": "Bias score", "rule": "Reconstructed: BIAS = 100 x (#Long - #Short) / 8 (fits the shown 5 Long, 1 Short = "
     "50.00); Bullish above 0, Bearish below.", "source": "frames k06, k07 (numbers shown)"},
    {"item": "Instrument", "rule": "S&P 500 E-mini futures (price axis 7695-7730 on a 0.25 grid); SPY is its ETF twin "
     "and the papers' instrument.", "source": "frame k06"},
    {"item": "Levels", "rule": "Green and red reference levels are drawn for the author's own trading; not defined.",
     "source": "transcript 38-50 s"},
]

GAPS: list[dict[str, str]] = [
    {"gap": "No rules of its own in the reel", "choice": "Test the paper on screen (GHLZ), the best-known tradable "
     "intraday-momentum rule (ZAB, named in the task) and a reconstruction of the shown bias panel (BIAS)."},
    {"gap": "Intraday history (Vertex has none stored)", "choice": "Dukascopy public 1-minute bid/ask candles, mid "
     "aggregated to 5 minutes, 09:30-16:00 New York; US500 CFD from 2012, ETF twins from 2017. An IBKR 5-minute "
     "backfill is a follow-up."},
    {"gap": "Instrument", "choice": "Primary: the US500 index CFD as the ES proxy (instrument on screen, longest "
     "history). Also the Core 7 futures proxies and the Core 7 ETF twins (SPY, QQQ, DIA, IWM, GLD, SLV, USO)."},
    {"gap": "Holidays and half days", "choice": "NYSE holidays and closures dropped; early closes (13:00) keep bars to "
     "13:00, so GHLZ and BIAS do not trade them (the paper drops half days); sessions with < 30 bars dropped."},
    {"gap": "Fills", "choice": "Signals at a bar close fill at the next 5-minute bar open; the 16:00 exit is a "
     "market-on-close fill at the last regular bar's close."},
    {"gap": "Costs (underlying)", "choice": "Measured median Dukascopy spread (half per side) + 1 bp slippage per side; "
     "ETFs add IBKR Pro Fixed commission and fees. No financing (never held overnight)."},
    {"gap": "Short side", "choice": "Each strategy is a long and a short DSL leg run separately on 100,000 USD; the "
     "daily returns of the two legs are summed (they never hold at the same time)."},
    {"gap": "Bias factor definitions (not shown)", "choice": "Initial Move = sign of 09:30-10:00 return; VWAP = price vs "
     "session VWAP; Daily Candle = price vs 09:30 open; Initial Hour HL = price beyond the 09:30-10:30 range; Session "
     "Delta = sign of sum(volume x sign(close - open)) of 5-minute bars (no tick delta)."},
    {"gap": "Bias factor definitions (cont.)", "choice": "Value Area Shift = today's 70 % volume value-area midpoint vs "
     "yesterday's (0.1 % band); ORB = price beyond the 09:30-10:00 range; Gap = open vs previous close (0.1 % band)."},
    {"gap": "Bias trading rule (not stated)", "choice": "Evaluate at 15:30 (the GHLZ clock): long if BIAS >= 50, short "
     "if <= -50, flat at 16:00. Sensitivity: thresholds 25 / 75, decision 10:30 / 12:00. Research-only signal, not "
     "a DSL definition."},
    {"gap": "Options form (Vertex rule)", "choice": "Debit vertical on the ETF twin in the signal direction (long 0.50 "
     "delta, short 1 sigma away), nearest Friday weekly with >= 1 trading day left, opened at the entry, closed at "
     "16:00; max loss 2 % of equity; one spread per market and day."},
    {"gap": "Option prices (no intraday option or IV history)", "choice": "Black-Scholes with the qc_ports smile on the "
     "IV-index proxy and T-bill rate of the previous close; $0.65 per contract + modeled half spread per leg; "
     "booked by Nautilus with a ledger cross-check."},
    {"gap": "Leverage", "choice": "GHLZ and BIAS 1x notional; ZAB volatility target capped at 4x as published, plus a "
     "1x variant."},
    {"gap": "Out-of-sample", "choice": "Pre-registered (commit 3131469c): first 60 % of the time in-sample, last 40 % "
     "out-of-sample; walk-forward 3 years train / 1 year test over GHLZ signal end x entry time."},
    {"gap": "Green / red levels", "choice": "Not reproducible (no definition, no prices); documented, not tested."},
]
