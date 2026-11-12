"""Markdown tables of the leveraged-ETF short-window study results (research only; pure functions).

`results_markdown(document)` gives the text of results.md: the 40 form rows with their verdicts, the
data start per pair and signal, the tracking error of the synthetic fund price, the measured IV ratio
(when a chain file was given) and every row per pair. `verdict_table` is the 40-row table alone (the
README shows it). A value that does not exist is printed as `n/a`, never as 0.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

__all__ = ["compact_table", "counts_table", "results_markdown", "verdict_table"]

SHORT = {"session-open-momentum": "S1", "volume-spike-breakout": "S2"}


def _num(value, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _pct(value, digits: int = 1) -> str:
    """A fraction as a percent."""
    return "n/a" if value is None else f"{value * 100:.{digits}f}%"


def _yes(value) -> str:
    return "n/a" if value is None else ("pass" if value else "fail")


def short_key(key: str) -> str:
    signal, rest = key.split("/", 1)
    return f"{SHORT.get(signal, signal)}/{rest}"


def _table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> list[str]:
    return ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |",
            *("| " + " | ".join(row) + " |" for row in rows)]


def _helps(verdict: Mapping) -> str:
    helps = verdict["leverageHelps"]
    if helps is None:
        return "-"
    return f"{'yes' if helps['helps'] else 'no'} ({_num(helps['sharpe'])} vs {_num(helps['twinSharpe'])})"


def _row_cells(row: Mapping) -> list[str]:
    stats, verdict = row["stats"], row["verdict"]
    carlo = stats["monteCarlo"] or {}
    worst = stats["worst48hLoss"]
    failed = verdict["gate"]["failed"]
    return [
        short_key(row["key"]), f"{stats['firstTrade'] or 'n/a'} .. {stats['lastTrade'] or 'n/a'}", str(stats["trades"]),
        str(stats["refused"]), str(row["skipped"]["overlap"]), _pct(stats["winRate"]),
        _num(stats["meanTradePct"], 3), _num(stats["medianTradePct"], 3), _num(stats["sharpe"]),
        _num(stats["oosSharpe"]), _num(stats["deflatedSharpe"]), _pct(stats["maxDrawdown"]), _pct(stats["cagr"]),
        _pct(carlo.get("probabilityOfProfit"), 0), _pct(carlo.get("drawdownP5")), _pct(carlo.get("worstDrawdown")),
        _num(stats["worstTradePct"]), _num(None if worst is None else worst["pct"]),
        "pass" if verdict["gate"]["pass"] else f"fail ({len(failed)} of {len(verdict['gate']['checks'])} checks)",
        _yes(verdict["lowerBar"]["pass"]), _helps(verdict),
    ]


HEADER = ["Row", "First .. last trade", "Trades", "Refused", "Skipped", "Win", "Mean %", "Median %", "Sharpe", "OOS",
          "DSR", "Max DD", "CAGR", "MC P(profit)", "MC DD p5", "MC worst run", "Worst trade %", "worst48hLoss %",
          "gate", "lowerBar", "leverageHelps"]


def verdict_table(rows: Sequence[Mapping]) -> str:
    """The form rows, one line each. Percent columns of a trade are in percent of the equity before it."""
    return "\n".join(_table(HEADER, [_row_cells(row) for row in rows]))


def compact_table(rows: Sequence[Mapping]) -> str:
    """The compact table of the report to the lead."""
    lines = []
    for row in rows:
        stats, verdict = row["stats"], row["verdict"]
        worst = stats["worst48hLoss"]
        lines.append([short_key(row["key"]), str(stats["trades"]), _num(stats["sharpe"]), _num(stats["oosSharpe"]),
                      _num(stats["deflatedSharpe"]), _pct(stats["maxDrawdown"]),
                      _num(None if worst is None else worst["pct"]), _yes(verdict["gate"]["pass"]),
                      _yes(verdict["lowerBar"]["pass"]), _helps(verdict)])
    return "\n".join(_table(["key", "trades", "Sharpe", "OOS", "DSR", "maxDD", "worst48hLoss %", "gate", "lowerBar",
                             "leverageHelps"], lines))


def counts_table(rows: Sequence[Mapping]) -> str:
    """Per form row: what happened to the signals. Signals = signals of the regime over all pairs; taken =
    after the overlap rule; not priced = taken signals without a price, by reason; refused = priced trades
    with 0 units; stale days = mark or exit closes priced with a carried IV index or rate."""
    lines = []
    for row in rows:
        reasons = "; ".join(f"{reason}: {count}" for reason, count in sorted(row["notPriced"].items())) or "none"
        lines.append([short_key(row["key"]), str(row["signals"]), str(row["skipped"]["overlap"]),
                      str(row["skipped"]["noExit"]), str(row["taken"]), str(row["priced"]), reasons,
                      str(row["stats"]["refused"]), str(row["stats"]["trades"]), str(row["staleDays"])])
    return "\n".join(_table(["Row", "Signals", "Skipped (overlap)", "No exit session", "Taken", "Priced", "Not priced",
                             "Refused (size)", "Booked", "Stale days"], lines))


def _failed_checks(rows: Sequence[Mapping]) -> list[str]:
    out = []
    for row in rows:
        failed = row["verdict"]["gate"]["failed"]
        verdict = "gate passes." if not failed else "gate fails: " + "; ".join(failed) + "."
        out.append(f"- `{short_key(row['key'])}`: {verdict}")
    return out


def results_markdown(document: Mapping) -> str:
    rows = document["rows"]
    lines = ["# Leveraged ETF short-window study: results", "",
             f"Data to {document['generatedFor']}. Start capital {document['capital']:,.0f} USD per book. "
             f"Engine: {document['engine']}. "
             + ("Every form row was booked on NautilusTrader and matches the ledger "
                f"(relative tolerance {document['parityTolerance']:g})." if document["nautilusParity"]
                else "Ledger only: this run did NOT book on NautilusTrader."),
             "" if document["complete"] else ("This is a PARTIAL run (not all 40 rows or not all pairs): a diagnostic, "
                                              "not the study result."),
             f"Rows that pass the gate: {len(document['passGate'])} of {len(rows)}. "
             f"Rows that pass the owner's lower bar: {len(document['passLowerBar'])} of {len(rows)}. "
             f"`lev-*` rows where leverage helps: {len(document['leverageHelps'])} of "
             f"{sum(1 for row in rows if row['verdict']['leverageHelps'] is not None)}.",
             "", "## Form rows (all pairs pooled, one book per row)", "",
             "Row = signal/regime/window/form. S1 = session-open-momentum, S2 = volume-spike-breakout. Skipped = "
             "signals skipped because a position of the same pair and direction was open. Refused = trades with 0 "
             "units at 2% of equity. Mean, median and worst trade are in percent of the equity before the trade. "
             "worst48hLoss = most negative change of the daily equity over 2 consecutive sessions, in percent.",
             "", verdict_table(rows), "", "### Failed gate checks per row", "", *_failed_checks(rows), "",
             "### Signals, skips and refusals per row", "", counts_table(rows), "",
             "## Data start per pair and signal", "",
             *_table(["U", "Long fund", "Inverse fund", "Leverage", "IV index", "Inputs from", "S1 first signal",
                      "S2 first signal", "S1 signals (all / calm)", "S2 signals (all / calm)"],
                     [[pair["underlying"], pair["longFund"], pair["inverseFund"], str(pair["leverage"]), pair["ivIndex"],
                       pair["inputsFrom"],
                       *(pair["firstSignal"][name] or "n/a" for name in ("session-open-momentum", "volume-spike-breakout")),
                       *(f"{pair['signals'][name]['all']} / {pair['signals'][name]['calm']}"
                         for name in ("session-open-momentum", "volume-spike-breakout"))]
                      for pair in document["pairs"]]), ""]
    if document["droppedPairs"]:
        lines += ["Dropped pairs: " + "; ".join(f"{item['underlying']} ({item['reason']})"
                                                for item in document["droppedPairs"]) + ".", ""]
    lines += ["## Tracking error of the synthetic fund price", "",
              "Synthetic close (previous close x (1 + leverage x move of U)) against the real close, absolute error "
              "in percent of the real close. This is how far the modeled intraday entry price of a fund can be off.",
              "", *_table(["Fund", "U", "Leverage", "Days", "From", "Median %", "95th percentile %", "Max %"],
                          [[item["fund"], item["underlying"], str(item["leverage"]), str(item["days"]), item["from"],
                            _num(item["medianAbsErrorPct"], 3), _num(item["p95AbsErrorPct"], 3),
                            _num(item["maxAbsErrorPct"], 1)] for item in document["trackingError"]]), ""]
    ratio = document.get("ivRatio")
    if ratio:
        lines += ["## Measured IV ratio (not used by the model)", "",
                  f"Fund ATM IV / (|leverage| x U ATM IV). {ratio.get('measured', '')}", "",
                  *_table(["U", "Long fund", "Leverage", "Expiry", "DTE", "U ATM IV", "Long fund ATM IV", "Ratio long fund",
                           "Ratio inverse fund"],
                          [[name, pair["longFund"], str(pair["leverage"]), str(row[0]), str(row[1]), _num(row[2], 3),
                            _num(row[3], 3), _num(row[4]), _num(row[5])]
                           for name, pair in ratio["pairs"].items() for row in pair["rows"]]), ""]
    lines += ["## Every row per pair (own book of the same capital, ledger only, not a verdict)", "",
              *_table(["Row", "U", "Trades", "Refused", "Win", "Mean %", "Sharpe", "OOS", "Max DD", "CAGR", "worst48hLoss %"],
                      [[short_key(row["key"]), item["underlying"], str(item["stats"]["trades"]),
                        str(item["stats"]["refused"]), _pct(item["stats"]["winRate"]), _num(item["stats"]["meanTradePct"], 3),
                        _num(item["stats"]["sharpe"]), _num(item["stats"]["oosSharpe"]), _pct(item["stats"]["maxDrawdown"]),
                        _pct(item["stats"]["cagr"]),
                        _num(None if item["stats"]["worst48hLoss"] is None else item["stats"]["worst48hLoss"]["pct"])]
                       for row in rows for item in row["perPair"]]), ""]
    return "\n".join(lines)
