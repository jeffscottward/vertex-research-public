"""Build research/backtests/quantjourney/library.json, the QuantJourney strategy inventory.

Research only. Reads local files only; places no orders.
Inputs:
* the quants.md page data snapshot (``<script id="lib-data">`` of https://quants.md, saved
  2026-10-31): names, universes, periods and the published metrics of each dashboard;
* the pinned quantjourney-bt clone: strategy file docstrings and cost settings.
The rule summaries, DSL mappings and re-run status below are written by Vertex.

Run (rig):
  python3 research/backtests/quantjourney/build_library.py \
      --site ~/Documents/reports/vertex-quantsmd/assets/quants.md-lib-data-2026-10-31.json \
      --clone ~/Github/tools/quantjourney-bt
  bunx --bun --no-install biome format --write research/backtests/quantjourney/library.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

PIN = "4f403d853833e1daa6de01c5b6c6cb3983dc0044"
SITE_SNAPSHOT_SHA256_NOTE = "SHA-256 of the saved snapshot file"

# Vertex's own short rule summaries (paraphrased from each strategy file; check the file before use).
RULES: dict[str, str] = {
    "O01": "Per ETF: buy about 18% of equity at market when SMA 20 moves above SMA 50; sell all at market when it moves back below.",
    "O02": "Per ETF: buy about 12% of equity at market while RSI 14 is below 35; sell all when RSI 14 rises above 60.",
    "O03": "Per ETF: when RSI 14 is below 40, place a buy limit 1.5% under the close (valid 3 bars); once long, place a sell limit 3% over the average entry (valid 3 bars).",
    "O04": "Per ETF: when the close is above SMA 50, place a buy limit 1% under the close (valid 2 bars); take profit with a sell limit 4% over entry; sell at market if the close falls under SMA 50.",
    "O05": "Per ETF: place a buy stop 0.2% over the highest close of the prior 20 bars (valid 5 bars); sell at market 10 bars after the fill.",
    "O06": "Per ETF: buy about 15% of equity at market when SMA 20 moves above SMA 50; attach a stop 5% under entry; sell at market when SMA 20 moves back below SMA 50.",
    "O07": "Per ETF: buy stop 0.2% over the prior 20-bar high with a limit 0.4% over the stop (valid 5 bars), so a gap can leave it unfilled; sell at market 12 bars after the fill.",
    "O08": "As O06, but the protective exit is a stop-limit (stop 4% under entry, limit 4.5% under entry), which can stay unfilled after a gap.",
    "O09": "Per ETF: SMA 20/50 trend entry at market; exit with a 4% trailing stop or at market on the reverse cross.",
    "O10": "Per ETF: buy at market when RSI 14 is below 38; exit with a 5% trailing stop or at market when RSI 14 is above 65.",
    "O11": "As O09, but the trailing exit is a trailing stop-limit (trail 4% of the close, limit 0.5% under the stop).",
    "O12": "Per ETF: on the SMA 20/50 up-cross, buy at market with a bracket: take profit 6% and stop 3% from the signal close; sell at market on the reverse cross.",
    "O13": "Per ETF: buy when RSI 14 is below 35 with a bracket: take profit 4% and stop 2% from the signal close; sell at market when RSI 14 is above 70.",
    "O14": "Per ETF, every 5th bar while flat: a one-cancels-other pair of a buy limit 2% under and a buy stop 2% over the close (valid 5 bars); sell at market 10 bars after the fill.",
    "O15": "5-minute bars: buy when RSI 14 is below 30 with a bracket of +0.6% take profit and -0.4% stop.",
    "O16": "30-minute bars: buy stop over the prior 12-bar high (valid 3 bars); sell at market after a fixed number of bars.",
    "O17": "On the first bar of each month, rank 8 multi-asset ETFs by 6-month return; sell names that left the top set and buy new entrants at market, equal value per name.",
    "O18": "Per ETF: trade only on SMA 20/50 signal changes: buy at market on a flat-to-long change, sell on a long-to-flat change; no calendar rebalance.",
    "O19": "Four USD-quoted FX pairs: long or short in the direction of the 126-bar return, in whole 100,000-unit lots sized by 0.5% equity risk per ATR 20 and a 20% notional cap per pair.",
    "O20": "Four continuous futures: long above the prior 55-bar high, short below the prior 55-bar low, otherwise keep the side; whole contracts sized by 0.5% equity risk per ATR 20 and a 25% notional cap.",
    "W01": "Daily: hold each sector ETF while SMA 50 is above SMA 200, equal weight across the active names, at most 25% each; otherwise cash.",
    "W02": "Hold each multi-asset ETF while SMA 50 is above SMA 200 (at most 30% each); rebalance at month end or when a weight drifts more than 5 percentage points.",
    "W03": "Per sector ETF: become long when RSI 14 is below 35 and stay long until RSI 14 is above 60; equal weight across long names (at most 25%); rebalance on Fridays.",
    "W04": "At each quarter end, rank 8 multi-asset ETFs by 252-bar return and hold the top 2 that have a positive return, equal weight; otherwise cash.",
    "W05": "At each month end, weight 8 multi-asset ETFs by the inverse of their 63-bar volatility (at most 35% each).",
    "W06": "When SPY closes above its SMA 200 hold the risk ETFs, otherwise the defensive ETFs; trade only when the regime changes.",
    "W07": "15-minute bars: equal weight in names whose RSI 14 is below 35 until RSI 14 is above 55; trade on signal changes.",
    "W08": "1-minute bars: hold each name while EMA 9 is above EMA 21; trade on signal changes.",
    "W09": "Hourly bars: hold each name while SMA 10 is above SMA 30, equal weight across active names (at most 25%); trade on signal changes.",
    "W10": "Monthly SMA 50/200 trend on 8 multi-asset ETFs; if the portfolio draws down 15% go to cash for a 10-day cooldown.",
    "W11": "Quarterly momentum rotation on 8 multi-asset ETFs; rebalance early when the 63-day tracking error to SPY exceeds 6%; skip trades once a rolling 252-day turnover budget of 4x is spent.",
    "W12": "Daily momentum tilt across the sector ETFs; trade only the names whose weight drifted more than 10% from target (partial rebalance).",
    "W13": "KO/PEP pair: z-score of log(KO) - log(PEP) over 60 bars; short the rich leg and long the cheap leg at |z| > 2 (0.5 each); flat at |z| < 0.5.",
    "W14": "EWA/EWC pair: spread from a rolling hedge ratio (covariance over variance of the logs); same z-score entry 2 and exit 0.5; legs 0.5 each.",
    "W15": "Month end: rank sector ETFs by 252-bar return; long the top 3 (+0.5 total) and short the bottom 3 (-0.5 total).",
    "W16": "Fridays: rank sector ETFs by 21-bar return; long the 3 biggest losers and short the 3 biggest winners (0.5 gross each side).",
    "W17": "SMA 50/200 trend basket on 8 multi-asset ETFs, scaled to 10% annual volatility (63-bar estimate, at most 1.5x); month-end rebalance.",
    "W18": "Top names by 126-bar return among 8 multi-asset ETFs, scaled to 15% annual volatility (42-bar estimate, at most 2x); month-end rebalance.",
    "W19": "All 8 multi-asset ETFs with equal risk contribution from a 63-bar covariance; month-end rebalance.",
    "W20": "Equal risk contribution across the sector ETFs from a 126-bar covariance, then each weight capped at 25% and renormalized; month-end rebalance.",
    "W21": "Per sector ETF: buy when the close is under the lower Bollinger band (SMA 20 - 2 standard deviations); exit when the close is over SMA 20; equal weight, at most 25%.",
    "W22": "Per sector ETF: hold while the MACD line (EMA 12 - EMA 26) is above its EMA 9 signal line; equal weight, at most 25%.",
    "W23": "Four USD-quoted FX pairs: long or short in the direction of the 126-bar return, weighted by inverse 63-bar volatility; month-end rebalance; price return only.",
    "W24": "Month end: rank four USD-quoted FX pairs by 63-bar return; long the strongest and short the weakest (gross 1, net 0); price return only.",
    "W25": "Six continuous futures: long or short by trend direction with inverse-volatility weights; month-end rebalance; price-return proxy, no multipliers or roll costs.",
    "WF01": "Validation of the W01-style SMA 50/200 sector trend (month-end rebalance) with a rolling walk-forward: fixed-length train and test windows and a purge gap before each test window.",
    "WF02": "The same SMA 50/200 sector trend validated with an expanding walk-forward: the train window grows from a fixed start.",
    "WF03": "Weekly RSI sector reversion validated with an anchored walk-forward and a fixed plus percentage purge before each test window.",
    "WF04": "Grid search of SMA fast/slow windows (3 x 3 = 9 candidates) for the sector trend, each scored by its backtest Sharpe.",
    "WF05": "Optuna TPE search of SMA fast/slow windows (fast < slow), then a rolling walk-forward of the best pair.",
}


def sma(length: int) -> dict:
    return {"type": "indicator", "name": "sma", "length": length}


def rsi(length: int = 14) -> dict:
    return {"type": "indicator", "name": "rsi", "length": length}


def const(value: float) -> dict:
    return {"type": "const", "value": value}


def cond(left: dict, op: str, right: dict) -> dict:
    return {"left": left, "op": op, "right": right}


def dsl(name: str, description: str, entry: list[dict], exit_: list[dict], *,
        stop: float | None = None, target: float | None = None) -> dict:
    definition: dict = {"version": 1, "name": name, "description": description,
                        "entry": {"all": entry}, "exit": {"any": exit_}}
    if stop is not None:
        definition["stopLoss"] = {"kind": "pct", "pct": stop}
    if target is not None:
        definition["takeProfit"] = {"kind": "pct", "pct": target}
    return definition


# Vertex DSL version 1 mappings. One long-only definition runs per instrument; the instrument
# sleeves get equal starting capital and are not rebalanced (see the inventory doc for the gaps).
DSL: dict[str, dict] = {
    "O01": dsl("QJ O01 SMA 20/50 cross", "SMA 20 above SMA 50 = long.",
               [cond(sma(20), ">", sma(50))], [cond(sma(20), "<", sma(50))]),
    "O02": dsl("QJ O02 RSI reversion 35/60", "Long while RSI 14 < 35 until RSI 14 > 60.",
               [cond(rsi(), "<", const(35))], [cond(rsi(), ">", const(60))]),
    "O06": dsl("QJ O06 SMA cross with 5% stop", "Up-cross entry, down-cross or 5% stop exit.",
               [cond(sma(20), "crossesAbove", sma(50))], [cond(sma(20), "crossesBelow", sma(50))], stop=5),
    "O12": dsl("QJ O12 SMA cross bracket 6/3", "Up-cross entry; 6% target, 3% stop, down-cross exit.",
               [cond(sma(20), "crossesAbove", sma(50))], [cond(sma(20), "crossesBelow", sma(50))],
               stop=3, target=6),
    "O13": dsl("QJ O13 RSI bracket 4/2", "RSI 14 < 35 entry; 4% target, 2% stop, RSI 14 > 70 exit.",
               [cond(rsi(), "<", const(35))], [cond(rsi(), ">", const(70))], stop=2, target=4),
    "O18": dsl("QJ O18 SMA 20/50 signal change", "Long on the SMA 20/50 up-cross, flat on the down-cross.",
               [cond(sma(20), "crossesAbove", sma(50))], [cond(sma(20), "crossesBelow", sma(50))]),
    "W01": dsl("QJ W01 SMA 50/200 trend", "Long while SMA 50 > SMA 200.",
               [cond(sma(50), ">", sma(200))], [cond(sma(50), "<", sma(200))]),
    "W03": dsl("QJ W03 RSI reversion 35/60", "Long from RSI 14 < 35 until RSI 14 > 60 (daily, not weekly).",
               [cond(rsi(), "<", const(35))], [cond(rsi(), ">", const(60))]),
    "W09": dsl("QJ W09 hourly SMA 10/30 trend", "Long while SMA 10 > SMA 30 on hourly bars.",
               [cond(sma(10), ">", sma(30))], [cond(sma(10), "<", sma(30))]),
}

NO_INTRADAY = ("Yahoo serves {gran} bars only for the last {days} days (checked 2026-10-31); the "
               "published window {start} to {end} is outside it, and Vertex stores no intraday history.")
INTRADAY_LIMIT_DAYS = {"1m": 30, "5m": 60, "15m": 60, "30m": 60}

SECTION = {"orders": "QuantJourney orders", "weights": "QuantJourney weights", "wf": "QuantJourney walk-forward"}
CATEGORY = {"orders": "orders", "weights": "weights", "wf": "walk-forward"}


def costs(text: str, mode: str) -> str:
    parts = []
    slip = re.search(r"FixedBpsSlippage\(bps=([0-9.]+)\)", text)
    if slip:
        parts.append(f"{slip.group(1)} bp slippage")
    per_share = re.search(r"PerShareCommission\(cost_per_share=([0-9.]+), min_per_order=([0-9.]+)\)", text)
    if per_share:
        parts.append(f"${per_share.group(1)}/share commission (min ${per_share.group(2)})")
    bps = re.search(r"FixedBpsCommission\(bps=([0-9.]+)\)", text)
    if bps:
        parts.append(f"{bps.group(1)} bp commission")
    if not parts and mode != "orders":
        parts.append("engine default 1 bp per traded notional")
    return "; ".join(parts) if parts else "not stated"


def slug(entry: dict) -> str:
    tail = entry["slug"].removeprefix("example-")
    tail = re.sub(r"^(orders|weights|wf)-\d+-", "", tail)
    return f"quantjourney-{entry['id'].lower()}-{tail}"[:80].rstrip("-")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--clone", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("library.json"))
    args = parser.parse_args()
    head = subprocess.run(["git", "-C", str(args.clone), "rev-parse", "HEAD"], check=True,
                          capture_output=True, text=True).stdout.strip()
    if head != PIN:
        raise SystemExit(f"clone is at {head}, expected pin {PIN}")
    site = json.loads(args.site.read_text())
    strategies = []
    for entry in site:
        text = (args.clone / "strategies" / entry["file"]).read_text()
        mode, gran = entry["mode"], entry["gran"]
        if gran in INTRADAY_LIMIT_DAYS:
            rerun = {"status": "no-data", "reason": NO_INTRADAY.format(
                gran=gran.replace("m", "-minute"), days=INTRADAY_LIMIT_DAYS[gran],
                start=entry["start"], end=entry["end"])}
        else:
            rerun = {"status": "run", "reason": None}
        published = entry.get("m")
        strategies.append({
            "id": entry["id"],
            "slug": slug(entry),
            "name": entry["longName"],
            "shortName": entry["name"],
            "category": CATEGORY[mode],
            "mode": mode,
            "section": SECTION[mode],
            "granularity": gran,
            "assetClass": entry["asset"],
            "styles": entry["styles"],
            "universe": entry["universe"],
            "period": {"start": entry["start"], "end": entry["end"]},
            "benchmark": entry["bench"],
            "rebalance": entry.get("rebalance") or None,
            "orderType": entry.get("orderType") or None,
            "strategyType": entry.get("type"),
            "summary": entry["summary"],
            "rules": RULES[entry["id"]],
            "costs": costs(text, mode),
            "file": entry["file"],
            # Pinned to the commit Vertex re-ran (the site links to blob/main, which can change).
            "github": entry["github"].replace("/blob/main/", f"/blob/{PIN}/"),
            "dashboard": entry["dashboard"],
            "published": None if published is None else {
                "totalReturnPct": published["ret"], "cagrPct": published["cagr"],
                "sharpe": published["sharpe"], "maxDrawdownPct": published["mdd"],
                "volatilityPct": published["vol"], "sortino": published["sortino"],
                "calmar": published["calmar"], "winRatePct": published["win"],
                "profitFactor": published["pf"], "profitFactorInfinite": published["pfInf"],
                "trades": published["trades"], "beta": published["beta"],
                "benchmarkReturnPct": published["bench"],
            },
            "dsl": DSL.get(entry["id"]),
            "rerun": rerun,
        })
    snapshot = hashlib.sha256(args.site.read_bytes()).hexdigest()
    doc = {
        "source": {
            "name": "QuantJourney Backtester example strategies",
            "repository": "https://github.com/QuantJourneyOrg/quantjourney-bt",
            "commit": head,
            "license": "Apache-2.0 (LICENSE in the repository; the repository has no NOTICE file)",
            "site": "https://quants.md",
            "siteSnapshot": "quants.md-lib-data-2026-10-31.json",
            "siteSnapshotSha256": snapshot,
            "dashboards": "https://backtester.quantjourney.cloud/strategies",
            "fetched": "2026-10-31",
            "framing": "The X post that linked quants.md called it a leaked Jane Street library. That is false: it is QuantJourney's public Apache-2.0 example collection.",
        },
        "count": len(strategies),
        "strategies": strategies,
    }
    args.out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(strategies)} strategies to {args.out}")


if __name__ == "__main__":
    main()
