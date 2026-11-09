"""Run the four frozen tests of the analog and seasonal regime flags.

Research only. Reads local CSV files written by fetch_data.py; places no orders.
Spec with the rules and the pass rules: docs/specs/research/analog-regime-flags.md.
Run (rig, from the repository root):
  PYTHONPATH=services/research uv run --no-project --python 3.12 \
      python research/backtests/analog-regime-flags/run.py \
      --data ~/Documents/reports/vertex-analog-regime/data \
      --out ~/Documents/reports/vertex-analog-regime/results.json \
      --markdown ~/Documents/reports/vertex-analog-regime/results.md

`--out` gets every number; `--markdown` gets the tables of the spec's "Results" section. Both are
written outside the repository (the repository takes no JSON data files).
"""
from __future__ import annotations

import argparse
import bisect
import csv
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

from strategies.regime_flags import analog, liquidity, seasonal, stretched, study
from strategies.regime_flags.events import HIT, HORIZON, Group, benjamini_hochberg, binomial_tail, outcome

HOLDOUT_END = date(1999, 3, 9)  # rule A1: the last event day of the ^NDX holdout
CLAIM_CUT = date(2026, 10, 6)  # rule A10
CLAIM_ANALOG = (date(2026, 11, 3), date(2025, 2, 25))  # rule B12: the query day and the source's match
ERAS = (("before 2008-09", date(1900, 1, 1), date(2008, 8, 31)),
        ("2008-09 to 2019", date(2008, 9, 1), date(2019, 12, 31)),
        ("from 2020", date(2020, 1, 1), date(2100, 1, 1)))
VARIANTS = tuple((length, reversal) for length in (42, 63, 126) for reversal in (0.10, 0.15))
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
PHASES = {0: "election", 1: "post-election", 2: "midterm", 3: "pre-election"}


@dataclass(frozen=True, slots=True)
class Bars:
    days: list[date]
    closes: list[float]
    adjusted: list[float]
    dropped: int

    def at(self, day: date) -> int:
        """Index of the last bar on or before ``day``."""
        return bisect.bisect_right(self.days, day) - 1


def load_bars(path: Path, positive: bool = True) -> Bars:
    days, closes, adjusted, dropped = [], [], [], 0
    with path.open() as fh:
        for row in csv.DictReader(fh):
            close, adj = float(row["close"]), float(row["adj_close"])
            if positive and (close <= 0.0 or adj <= 0.0):  # rule G4
                dropped += 1
                continue
            days.append(date.fromisoformat(row["date"]))
            closes.append(close)
            adjusted.append(adj)
    return Bars(days, closes, adjusted, dropped)


def load_fred(path: Path) -> dict[date, float]:
    with path.open() as fh:
        return {date.fromisoformat(row["date"]): float(row["value"]) for row in csv.DictReader(fh) if row["value"]}


def cash_returns(days: Sequence[date], irx: Bars) -> list[float]:
    """Rule C6: the 13-week bill yield of the day before, per trading day; 0 before the first yield."""
    out = [0.0]
    for d in range(1, len(days)):
        index = irx.at(days[d - 1])
        out.append(irx.closes[index] / 100.0 / 252.0 if index >= 0 else 0.0)
    return out


# Formatting ---------------------------------------------------------------------------------------

def pct(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value * 100:.{digits}f}%".replace("-", "−")


def num(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}".replace("-", "−")


def p_text(value: float | None) -> str:
    if value is None:
        return "n/a"
    return "< 0.0001" if value < 0.0001 else f"{value:.4f}"


def rate(found: Group | None) -> str:
    return "n/a" if found is None else f"{found.hits}/{found.n} ({pct(found.hit_rate, 0)})"


def table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> list[str]:
    return ["|" + "|".join(header) + "|", "|" + "|".join("---" for _ in header) + "|",
            *("|" + "|".join(row) + "|" for row in rows), ""]


# Test A -------------------------------------------------------------------------------------------

def fall_so_far(bars: Bars, index: int) -> float:
    """The lowest close after day ``index`` against its close, up to the last bar; 0 when none is lower."""
    return min(0.0, min(bars.closes[index + 1 :], default=bars.closes[index]) / bars.closes[index] - 1.0)


def episode_outcome(bars: Bars, item: study.Episode) -> list[str]:
    if item.outcome is None:
        return [f"open ({pct(fall_so_far(bars, item.index))} to {bars.days[-1]})", "open", "open"]
    return [pct(item.outcome.mdd), pct(item.outcome.fwd), "yes" if item.outcome.hit else "no"]


def definition_text(definition: stretched.Definition) -> str:
    high = "record" if definition.high_days is None else f"{definition.high_days}-day high"
    return f"{high}, run ≥ {pct(definition.run, 0)}, stretch ≥ {pct(definition.stretch, 0)}, vol ≤ {pct(definition.vol, 0)}"

def stretched_section(qqq: Bars, ndx: Bars) -> tuple[dict, list[str]]:
    sample = study.stretched_study(qqq.closes)
    holdout = study.stretched_study(ndx.closes, last=ndx.at(HOLDOUT_END))
    verdict = study.stretched_verdict(sample, holdout)
    cut = qqq.at(CLAIM_CUT)
    claim = study.stretched_study(qqq.closes[: cut + 1])
    ten = [cell.definition for cell in claim.cells if cell.result and (cell.result.n, cell.result.hits) == (10, 10)]
    recent = [qqq.days[t].isoformat()
              for t in stretched.signal_days(stretched.features(qqq.closes[: cut + 1]))
              if t > cut - 5]
    lines = ["### Test A: stretched + calm", ""]
    rows = []
    for label, bars, found in (("QQQ 1999-03-10 to 2026-11-06", qqq, sample), ("`^NDX` holdout to 1999-03-09", ndx, holdout)):
        cell = found.primary
        rows.append([label, str(cell.signal_days), f"{len(cell.episodes)} ({cell.complete})", rate(cell.result),
                     rate(cell.base), rate(found.base_all), p_text(cell.p_value),
                     pct(cell.result.mean_fwd if cell.result else None), pct(found.base_all.mean_fwd if found.base_all else None)])
    lines += table(["Sample (rule A6)", "Signal days", "Episodes (complete)", "Hits", "Near-record days", "All days",
                    "p against near-record", "Mean `fwd`, episodes", "Mean `fwd`, all days"], rows)
    for label, bars, found in (("QQQ", qqq, sample), ("`^NDX` holdout", ndx, holdout)):
        if found.primary.episodes:
            lines += [f"Episodes of rule A6, {label}:", ""]
            lines += table(["Start", "Run", "Stretch", "Vol", "`mdd`", "`fwd`", "Hit"],
                           [[bars.days[item.index].isoformat(), pct(item.run), pct(item.stretch), pct(item.vol),
                             *episode_outcome(bars, item)] for item in found.primary.episodes])
    wide = [cell for cell in sample.cells if cell.complete >= study.MIN_EVENTS]
    tested = [cell for cell in sample.cells if cell.p_value is not None]
    lines += [f"Grid (rule A9), QQQ: {len(wide)} of 54 cells have {study.MIN_EVENTS} or more complete episodes; "
              f"{sum(1 for cell in wide if cell.above_base)} of them have a hit rate above their base rate. "
              f"{sum(1 for cell in tested if cell.p_value <= study.ALPHA)} of the {len(tested)} cells with an episode have "
              f"p ≤ 0.05 before a correction; "
              f"{benjamini_hochberg([cell.p_value for cell in tested])} remain after Benjamini-Hochberg at q = 0.05.", ""]
    grid_rows = []
    for high_days in (None, stretched.YEAR):
        for run in (0.15, 0.20, 0.25):
            for stretch in (0.08, 0.10, 0.12):
                cells = [cell for cell in sample.cells
                         if (cell.definition.high_days, cell.definition.run, cell.definition.stretch) == (high_days, run, stretch)]
                grid_rows.append(["record" if high_days is None else "252-day", pct(run, 0), pct(stretch, 0),
                                  *(rate(cell.result) for cell in sorted(cells, key=lambda cell: cell.definition.vol))])
    base_record, base_year = sample.cells[0].base, sample.cells[-1].base
    lines += table(["High", "Run ≥", "Stretch ≥", "Vol ≤ 12%", "Vol ≤ 15%", "Vol ≤ 18%"], grid_rows)
    lines += [f"Hits / complete episodes per cell. Base rates: near-record days {rate(base_record)}, "
              f"near-252-day-high days {rate(base_year)}.", ""]
    kept = benjamini_hochberg([cell.p_value for cell in tested])
    best = sorted(range(len(sample.cells)), key=lambda i: (sample.cells[i].p_value is None, sample.cells[i].p_value))[:kept]
    if best:
        lines += ["After the run (not a frozen rule): the cells that remain after Benjamini-Hochberg, and the same cells "
                  "on the `^NDX` holdout.", ""]
        lines += table(["Cell", "QQQ hits", "QQQ p", "QQQ mean `fwd`", "Holdout hits", "Holdout near-high days", "Holdout mean `fwd`"],
                       [[definition_text(sample.cells[i].definition), rate(sample.cells[i].result), p_text(sample.cells[i].p_value),
                         pct(sample.cells[i].result.mean_fwd), rate(holdout.cells[i].result), rate(holdout.cells[i].base),
                         pct(holdout.cells[i].result.mean_fwd if holdout.cells[i].result else None)] for i in best])
    still_open = [item for item in sample.primary.episodes if item.outcome is None]
    if still_open and sample.primary.result and sample.primary.base and all(fall_so_far(qqq, item.index) <= HIT for item in still_open):
        hits, n = sample.primary.result.hits + len(still_open), sample.primary.complete + len(still_open)
        lines += [f"After the run (not a frozen rule): the open episode is a hit already. When its window is complete, rule A6 "
                  f"has {hits} hits in {n} episodes; the p-value against the near-record base rate of today is "
                  f"{p_text(binomial_tail(hits, n, sample.primary.base.hit_rate))}.", ""]
    lines += [f"Claim check (rule A10), data cut at {CLAIM_CUT}: rule A6 gives {len(claim.primary.episodes)} episodes, "
              f"{claim.primary.complete} complete, {claim.primary.result.hits if claim.primary.result else 0} hits. "
              f"Cells with exactly ten complete episodes that are all hits: {len(ten)} of 54. "
              f"Signal days of rule A6 from 2026-09-30 to {CLAIM_CUT}: {', '.join(recent) if recent else 'none'}.", "",
              f"Verdict A: **{verdict}**", ""]
    data = {"verdict": verdict, "sample": asdict(sample), "holdout": asdict(holdout), "claim_cut": asdict(claim),
            "cells_ten_of_ten": [asdict(item) for item in ten], "recent_signal_days": recent,
            "episode_dates": {"sample": [qqq.days[item.index].isoformat() for item in sample.primary.episodes],
                              "holdout": [ndx.days[item.index].isoformat() for item in holdout.primary.episodes]}}
    return data, lines


# Test B -------------------------------------------------------------------------------------------

def analog_row(label: str, found: study.AnalogStudy) -> list[str]:
    classified = sum(1 for day in found.days if day.top_like is not None and day.outcome is not None)
    return [label, str(found.tops), f"{len(found.days)} ({classified})", rate(found.top_like), rate(found.others),
            p_text(found.p_value), pct(found.top_like.mean_fwd if found.top_like else None),
            pct(found.others.mean_fwd if found.others else None), num(found.rho), p_text(found.rho_p)]


def analog_section(qqq: Bars, ndx: Bars) -> tuple[dict, list[str]]:
    variants = {key: study.analog_study(qqq.closes, *key) for key in VARIANTS}
    primary = variants[(analog.PATH, analog.REVERSAL)]
    holdout = study.analog_study(ndx.closes, last=ndx.at(HOLDOUT_END))
    verdict = study.analog_verdict(primary, list(variants.values()), holdout)
    header = ["Sample", "Tops", "Sample days (counted)", "Top-like hits", "Other days hits", "p (Test 1)",
              "Mean `fwd`, top-like", "Mean `fwd`, others", "ρ (Test 2)", "p (Test 2)"]
    lines = ["### Test B: nearest analog of a past top", ""]
    lines += table(header, [analog_row("QQQ, path 63, zigzag 10%", primary),
                            analog_row("`^NDX` holdout to 1999-03-09", holdout)])
    lines += ["The distance to the nearest analog falls as the library of tops grows, so rule B8 marks more than 20% of the "
              "later days as top-like.", "", "Variants (rule B11), QQQ:", ""]
    lines += table(header, [analog_row(f"path {length}, zigzag {pct(reversal, 0)}", found)
                            for (length, reversal), found in variants.items()])
    query_day, claimed_day = CLAIM_ANALOG
    query, claimed = qqq.at(query_day), qqq.at(claimed_day)
    tops = analog.zigzag_tops(qqq.closes)
    order = analog.ranked(qqq.closes, query, tops)
    rank = next((i for i, item in enumerate(order, start=1) if item.day == claimed), None)
    nearest: list[analog.Analog] = []
    for item in order:
        if item.top not in {found.top for found in nearest}:
            nearest.append(item)
        if len(nearest) == 3:
            break
    lines += [f"Claim check (rule B12): nearest analogs of {query_day}, one per top:", ""]
    lines += table(["Analog day", "Top", "Days after the top", "Distance", "`fwd` after the analog day", "`mdd` after it"],
                   [[qqq.days[item.day].isoformat(), qqq.days[item.top].isoformat(), str(item.offset), num(item.distance, 4),
                     pct(outcome(qqq.closes, item.day).fwd), pct(outcome(qqq.closes, item.day).mdd)] for item in nearest])
    top_2025 = next((top for top in tops if qqq.days[top.index].year == 2025 and top.index <= claimed <= top.index + analog.MAX_OFFSET), None)
    lines += [f"{claimed_day} has rank {rank} of {len(order)} candidates"
              + (f" (distance {num(order[rank - 1].distance, 4)}; its top is {qqq.days[top_2025.index]}, "
                 f"{claimed - top_2025.index} trading days earlier)." if rank and top_2025 else
                 "." if rank else " (it is not a candidate: no confirmed 10% top within 10 days before it)."), "",
              f"Verdict B: **{verdict}**", ""]
    data = {"verdict": verdict, "variants": {f"{length}/{reversal}": asdict(found) for (length, reversal), found in variants.items()},
            "holdout": asdict(holdout), "claim": {"rank": rank, "candidates": len(order), "nearest": [asdict(item) for item in nearest]},
            "top_dates": [qqq.days[top.index].isoformat() for top in tops]}
    return data, lines


# Test C -------------------------------------------------------------------------------------------

def period_row(asset: str, threshold: float, period: study.Period) -> list[str]:
    rule, hold = period.rule, period.hold
    return [asset, "Δ4 < 0" if threshold == 0.0 else f"Δ4 ≤ {pct(threshold)}", f"{period.label} ({period.start} to {period.end})",
            f"{num(rule.sharpe)} / {num(hold.sharpe)}", f"{pct(rule.max_drawdown)} / {pct(hold.max_drawdown)}",
            f"{pct(rule.cagr)} / {pct(hold.cagr)}", str(rule.trades), pct(rule.fraction_out, 0), "yes" if period.better else "no"]


def liquidity_section(assets: dict[str, Bars], irx: Bars, walcl: dict, tga: dict, rrp: dict) -> tuple[dict, list[str]]:
    weeks, dropped = liquidity.net_liquidity(walcl, tga, rrp)
    studies = {(name, threshold): study.liquidity_study(bars.days, bars.closes, bars.adjusted, cash_returns(bars.days, irx),
                                                        weeks, threshold, ERAS)
               for name, bars in assets.items() for threshold in liquidity.THRESHOLDS}
    primary = studies[("QQQ", 0.0)]
    verdict = study.liquidity_verdict(primary)
    changes = [week for week in weeks if week.change is not None]
    lines = ["### Test C: Fed net liquidity drain", "",
             f"{len(weeks)} weeks from {weeks[0].day} to {weeks[-1].day}; {len(dropped)} dropped (no `WDTGAL` value). "
             f"`Δ4 < 0` in {sum(1 for week in changes if week.change < 0.0)} of {len(changes)} weeks.", ""]
    header = ["Asset", "Flag", "Period", "Sharpe, rule / hold", "Max DD, rule / hold", "CAGR, rule / hold", "Trades",
              "Days out", "Better on both"]
    lines += ["Primary rule (C4, cost 0.05% per switch):", ""]
    lines += table(header, [period_row("QQQ", 0.0, period) for period in (primary.full, *primary.halves, *primary.eras)])
    lines += ["Other thresholds and SPY (robustness only):", ""]
    lines += table(header, [period_row(name, threshold, period)
                            for (name, threshold), found in studies.items() if (name, threshold) != ("QQQ", 0.0)
                            for period in (found.full, *found.halves)])
    lines += ["Event comparison (rule C10), QQQ `close`, four-week returns:", ""]
    lines += table(["Flag", "Weeks on", "Weeks off", "Mean, flag on", "Mean, flag off", "p (on below off)"],
                   [["Δ4 < 0" if threshold == 0.0 else f"Δ4 ≤ {pct(threshold)}", str(found.weeks_on), str(found.weeks_off),
                     pct(found.mean_on, 2), pct(found.mean_off, 2), p_text(found.p_value)]
                    for (name, threshold), found in studies.items() if name == "QQQ"])
    lines += [f"Verdict C: **{verdict}**", ""]
    data = {"verdict": verdict, "weeks": len(weeks), "dropped": [day.isoformat() for day in dropped],
            "studies": {f"{name}/{threshold}": asdict(found) for (name, threshold), found in studies.items()}}
    return data, lines


# Test D -------------------------------------------------------------------------------------------

def seasonal_section(gspc: Bars) -> tuple[dict, list[str]]:
    found = study.seasonal_study(gspc.days, gspc.closes)
    verdict = study.seasonal_verdict(found)
    mean = lambda items: sum(item.change for item in items) / len(items)
    other_positives = sum(1 for item in found.others if item.change > 0.0)
    holdout_positives = sum(1 for item in found.holdout if item.change > 0.0)
    lines = ["### Test D: midterm election seasonal", "",
             f"Claim (rule D3): {found.positives} of {len(found.midterm)} midterm windows are positive; mean {pct(mean(found.midterm))}. "
             f"Non-midterm windows 1950 to 2025: {other_positives} of {len(found.others)} positive "
             f"({pct(found.base_rate, 0)}); mean {pct(mean(found.others))}. "
             f"Binomial p = {p_text(found.p_value)}; times 48 = {p_text(found.adjusted_p)}.", ""]
    lines += table(["Start years", "Midterm mean", "Non-midterm mean"],
                   [[label, pct(midterm), pct(other)] for label, midterm, other in found.halves])
    lines += table(["Sample", "Start", "End", "Return", "Largest fall inside"],
                   [["holdout" if item in found.holdout else "claim", item.start.isoformat(), item.end.isoformat(),
                     pct(item.change), pct(item.drawdown)] for item in (*found.holdout, *found.midterm)])
    perfect = [cell for cell in found.cells if cell.positives == cell.n]
    order = sorted(found.cells, key=lambda cell: (-cell.positives / cell.n, -cell.mean))
    claim_cell = next(cell for cell in found.cells if (cell.month, cell.phase) == (found.month, seasonal.MIDTERM))
    lines += [f"Scan (rule D6): {len(perfect)} of {len(found.cells)} cells have only positive windows. "
              f"The claim's cell (October, midterm) has rank {order.index(claim_cell) + 1} by share positive, then by mean. "
              f"Holdout (rule D8): {holdout_positives} of {len(found.holdout)} positive. The ten best cells:", ""]
    lines += table(["Start month end", "Cycle year of the start", "Positive", "Mean"],
                   [[MONTHS[cell.month - 1], PHASES[cell.phase], f"{cell.positives}/{cell.n}", pct(cell.mean)] for cell in order[:10]])
    lines += [f"Verdict D: **{verdict}**", ""]
    return {"verdict": verdict, "study": asdict(found)}, lines


# Readings -----------------------------------------------------------------------------------------

def readings_section(qqq: Bars, gspc: Bars, walcl: dict, tga: dict, rrp: dict) -> tuple[dict, list[str]]:
    """The state of each flag at the last bar. Descriptive: it decides no verdict."""
    last = len(qqq.days) - 1
    found = stretched.features(qqq.closes)
    signals = stretched.signal_days(found)
    tops = analog.zigzag_tops(qqq.closes)
    nearest = analog.ranked(qqq.closes, last, tops)[0]
    sample = study.analog_study(qqq.closes)
    smaller = sum(1 for day in sample.days if day.nearest.distance < nearest.distance) / len(sample.days)
    weeks, _ = liquidity.net_liquidity(walcl, tga, rrp)
    known = [week for week in weeks if liquidity.known_at(qqq.days, week.day) is not None and week.change is not None]
    week = known[-1]
    earlier = weeks[weeks.index(week) - liquidity.WEEKS]
    start = seasonal.anchor(gspc.days, 2026, 10)
    rows = [
        ["A stretched + calm", f"run {pct(found.run[last])}, stretch {pct(found.stretch[last])}, vol {pct(found.vol[last])}, "
                               f"{int(found.since_high[last])} trading days since the record close",
         "on" if last in signals else f"off (last signal day: {qqq.days[signals[-1]] if signals else 'none'})"],
        ["B nearest analog", f"{qqq.days[nearest.day]}, {nearest.offset} trading days after the top of {qqq.days[nearest.top]}; "
                             f"distance {num(nearest.distance, 4)}",
         f"{pct(smaller, 0)} of the sample days had a smaller distance (top-like needs under 20%)"],
        ["C net liquidity", f"week {week.day}: USD {week.net / 1e6:.3f} trillion, Δ4 {pct(week.change, 2)} "
                            f"(USD {num((week.net - earlier.net) / 1e3, 0)} billion)",
         "on (drain)" if liquidity.drain(week) else "off"],
        ["D midterm window", f"opened at the {gspc.days[start]} close ({num(gspc.closes[start])}); "
                             f"{pct(gspc.closes[-1] / gspc.closes[start] - 1)} to {gspc.days[-1]}" if start is not None else "not open",
         "open until the last close on or before 2027-10-31" if start is not None else "not open"],
    ]
    lines = [f"### Readings at the last bar ({qqq.days[last]})", "",
             "Descriptive only. A reading is not a signal: see the verdicts.", ""]
    lines += table(["Flag", "Reading", "State"], rows)
    return {"rows": rows}, lines


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    args = parser.parse_args()
    data: Path = args.data.expanduser()
    bars = {name: load_bars(data / f"{name}.csv") for name in ("QQQ", "SPY", "NDX", "GSPC")}
    irx = load_bars(data / "IRX.csv", positive=False)
    walcl, tga, rrp = (load_fred(data / f"{series}.csv") for series in ("WALCL", "WDTGAL", "RRPONTSYD"))
    manifest = json.loads((data / "manifest.json").read_text())

    a_data, a_lines = stretched_section(bars["QQQ"], bars["NDX"])
    b_data, b_lines = analog_section(bars["QQQ"], bars["NDX"])
    c_data, c_lines = liquidity_section({"QQQ": bars["QQQ"], "SPY": bars["SPY"]}, irx, walcl, tga, rrp)
    d_data, d_lines = seasonal_section(bars["GSPC"])
    r_data, r_lines = readings_section(bars["QQQ"], bars["GSPC"], walcl, tga, rrp)
    verdicts = {"A": a_data["verdict"], "B": b_data["verdict"], "C": c_data["verdict"], "D": d_data["verdict"]}

    lines = ["### Data", ""]
    lines += table(["File", "Rows", "First", "Last", "Dropped bars (rule G4)"],
                   [[name, str(entry["rows"]), entry["first"], entry["last"],
                     str(bars[name.removesuffix(".csv")].dropped) if name.removesuffix(".csv") in bars else "n/a"]
                    for name, entry in manifest.items()])
    lines += a_lines + b_lines + c_lines + d_lines + r_lines
    result = {"horizon": HORIZON, "verdicts": verdicts, "data_manifest": manifest, "stretched": a_data, "analog": b_data,
              "liquidity": c_data, "seasonal": d_data, "readings": r_data}
    args.out.expanduser().write_text(json.dumps(result, indent=1, default=str) + "\n")
    args.markdown.expanduser().write_text("\n".join(lines))
    print(json.dumps(verdicts))


if __name__ == "__main__":
    main()
