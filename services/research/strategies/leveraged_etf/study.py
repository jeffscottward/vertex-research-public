"""The `research_studies` document of the leveraged-ETF short-window study (research only).

`document(results, ran)` turns the results document of research/backtests/leveraged-etf/run.py into ONE
`strategy-backtest` study document (packages/api/src/contracts/research-studies.ts) with id
`leveraged-etf-short-window`. It only builds the document: nothing here imports it anywhere.

Mapping (the contract knows two form keys):
- form `options`: the 32 option form rows (etf-option, etf-vertical, lev-option, lev-vertical x signal x
  regime x window), all pairs pooled; one run per row, `symbol` = the form key, `market` = signal /
  regime / window.
- form `underlying`: the 8 `lev-shares` rows (the owner's share fallback).
- A run without a booked trade has no Sharpe, win rate or CAGR; the contract needs numbers there, so
  they are 0 and the run shows 0 trades.
- Verdict (set before the first run): `edge` when at least one `lev-*` form row passes the allocation
  gate, else `no-edge`. A partial run (not all 40 rows, a dropped pair, or no NautilusTrader parity)
  gives no document.
- Equity curve: the monthly points of the row runner.EQUITY_ROW (fixed before the first run).
`validate(document)` checks it against the Python mirror of the contract (volspike.study.validate_document).
"""
from __future__ import annotations

from collections.abc import Mapping

from . import metrics

__all__ = ["GAPS", "RULES", "SLUG", "SOURCE", "SPEC_PATH", "TITLE", "document", "validate", "verdict_of"]

SLUG = "leveraged-etf-short-window"
SPEC_PATH = f"docs/specs/strategies/{SLUG}.md"
TITLE = "Leveraged ETF options against unleveraged ETF options, 24 and 48 hour windows"
SOURCE = {
    "label": "FINRA Regulatory Notice 09-31: leveraged and inverse ETFs reset daily; over more than one day "
             "their return can differ from the multiple",
    "url": "https://www.finra.org/rules-guidance/notices/09-31",
}
DESIGN = "Pre-registered design, research/backtests/leveraged-etf/README.md"
SHORT = {"session-open-momentum": "S1", "volume-spike-breakout": "S2"}
SHARES_FORM = "lev-shares"
RESULT_MAX = 300

RULES = [
    {"item": "Question", "source": DESIGN,
     "rule": "Do the short-window signals, held for 24 or 48 hours, do better as options on a leveraged ETF than "
             "as options on the unleveraged ETF, with decay, gap risk and costs included?"},
    {"item": "Pairs", "source": DESIGN,
     "rule": "QQQ with TQQQ and SQQQ, SPY with UPRO and SPXU, IWM with TNA and TZA, DIA with UDOW and SDOW (3x); "
             "GLD with UGL and GLL, SLV with AGQ and ZSL, USO with UCO and SCO (2x). Each pair from the first day "
             "all its inputs exist."},
    {"item": "Signal S1 session-open-momentum", "source": "strategies/noise_band.py",
     "rule": "First entry of the noise-band kernel in a session of the unleveraged ETF (5-minute bars, decisions "
             "every 30 minutes from 10:00 to 15:30 New York). Direction = side of the break. Entry = the close of "
             "the decision bar. At most one signal per session and pair."},
    {"item": "Signal S2 volume-spike-breakout", "source": "strategies/volspike/rules.py",
     "rule": "Entries of the volume spike breakout rule on the Dukascopy index of the pair, default parameters "
             "without the 15-point stop, from 2018. Entry on the ETF at the signal time, at 09:35 New York when the "
             "signal is before the open."},
    {"item": "Regime", "source": "GATES['volRegime'] in strategies/qc_ports/ideas.py",
     "rule": "all = every signal. calm = at the previous close VIX <= 25 and VIX / VIX3M <= 1.0, and the signal "
             "agrees with the 200-day trend of the ETF (long above the simple average, short below)."},
    {"item": "Window", "source": DESIGN,
     "rule": "24h = exit at the close of the next session after the entry session. 48h = exit at the close of the "
             "second session. No stop inside the window. A new signal of the same pair and direction while a "
             "window is open is skipped."},
    {"item": "Forms", "source": DESIGN,
     "rule": "etf-option and etf-vertical on the ETF; lev-option and lev-vertical on the long fund (call for a long "
             "signal, put for a short one); lev-shares = shares of the long fund (long) or of the inverse fund "
             "(short). Long leg 0.50 delta; the short leg of a vertical 1 sigma further out of the money."},
    {"item": "Expiry", "source": DESIGN,
     "rule": "The first Friday weekly with at least 3 sessions after the entry session (the last session of that "
             "week when the Friday is a holiday). The same rule for the ETF and the fund."},
    {"item": "Size", "source": "Owner rule: 2% maximum loss per position",
     "rule": "Whole contracts; premium plus entry costs at most 2% of the current equity. Shares: whole shares, "
             "notional plus entry cost at most 2% of equity. 0 units = the trade is refused. Start capital "
             "100,000 USD per book."},
    {"item": "Option prices", "source": "strategies/qc_ports/options.py",
     "rule": "Black-Scholes with the qc-ports smile. ETF IV = ATM factor x its Cboe index (previous close for the "
             "entry, the session's close for marks and the exit). Fund IV = |leverage| x the ETF IV at the same "
             "standardized moneyness (model assumption). Fund dividend yield 0."},
    {"item": "Fund prices", "source": DESIGN,
     "rule": "Daily closes from Yahoo at as-traded prices (later splits undone). Intraday entry price = previous "
             "close x (1 + leverage x (ETF entry price / ETF previous close - 1)). A trade with a split of its "
             "instrument in the window is not priced."},
    {"item": "Costs", "source": "strategies/qc_ports/options.py; liquidity gate maximum",
     "rule": "0.65 USD per contract and half the spread per leg and side: the model's class for the ETF, 4% of mid "
             "for a fund. A position worth less than its closing cost is left to expire. Shares: 10 basis points "
             "per side."},
    {"item": "Verdict per form row", "source": "allocation.gate_checks; funded_pie.LOWER_BAR",
     "rule": "Form row = signal x regime x window x form, all pairs in one book (40 rows). A row passes only when "
             "every check of the allocation gate passes; its baseline is the etf-option row of the same signal, "
             "regime and window. Deflated Sharpe with 40 trials."},
]

GAPS = [
    {"gap": "A leveraged fund has no intraday price history in the study data.",
     "choice": "Its entry price is the daily-reset formula from the previous closes. The error of the formula at "
               "the close is reported per fund (robustness row)."},
    {"gap": "There are no historical option quotes for the funds or the ETFs.",
     "choice": "Every option price is the model. Weekly expiries did not exist for every fund before about 2014, "
               "so earlier fund option prices are the model only."},
    {"gap": "The implied volatility of a fund option is not in the data.",
     "choice": "|leverage| x the IV of the ETF at the same standardized moneyness. One measured chain ratio is "
               "reported next to the result and is not used to fit."},
    {"gap": "The volume spike rule has a 15-point stop stated in NAS100 points.",
     "choice": "The rule runs without the stop (its defined-risk form): the option premium is the maximum loss and "
               "the window is the exit."},
    {"gap": "A row can refuse or skip trades, so 'a position is open' could differ by form.",
     "choice": "Overlap is decided on the signals before pricing: every form of a row sees the same signals."},
    {"gap": "The spread of a fund option is not measured over the history.",
     "choice": "4% of mid per leg and side, the maximum the liquidity gate allows, for the whole history."},
]


def _market(signal: str, regime: str, window: str) -> str:
    return f"{signal} / {regime} / {window}"


def _run(row: Mapping) -> dict:
    stats = row["stats"]
    signal, regime, window, form = metrics.split_key(row["key"])

    def number(value, floor: float | None = None) -> float:
        value = 0.0 if value is None else float(value)
        return value if floor is None else max(floor, value)

    def nullable(value, floor: float | None = None) -> float | None:
        return None if value is None else number(value, floor)

    return {
        "symbol": form, "market": _market(signal, regime, window), "from": stats["start"], "to": stats["end"],
        "trades": int(stats["trades"]), "winRate": number(stats["winRate"]), "sharpe": number(stats["sharpe"]),
        "oosSharpe": nullable(stats["oosSharpe"]), "cagr": number(stats["cagr"], -1.0),
        "oosCagr": nullable(stats["oosCagr"], -1.0), "maxDrawdown": min(0.0, number(stats["maxDrawdown"], -1.0)),
        "exposure": min(1.0, number(stats["exposure"], 0.0)), "profitFactor": nullable(stats["profitFactor"], 0.0),
        "buyHoldCagr": None, "buyHoldSharpe": None,
    }


def _zero(value) -> float:
    return 0.0 if value is None else float(value)


def _two(value) -> str:
    return "none" if value is None else f"{value:.2f}"


def _clip(text: str, limit: int = RESULT_MAX) -> str:
    return text if len(text) <= limit else text[:limit - 3].rstrip() + "..."


def _short(key: str) -> str:
    signal, rest = key.split(metrics.KEY_SEPARATOR, 1)
    return f"{SHORT.get(signal, signal)}/{rest}"


def verdict_of(results: Mapping) -> tuple[str, str]:
    """(verdict, reason): `edge` when at least one `lev-*` form row passes the allocation gate."""
    rows = results["rows"]
    leveraged = [row for row in rows if row["verdict"]["leverageHelps"] is not None]
    passing = [row["key"] for row in leveraged if row["verdict"]["passes"]]
    helped = [row["key"] for row in leveraged if row["verdict"]["leverageHelps"]["helps"]]
    best = max(leveraged, key=lambda row: _zero(row["stats"]["sharpe"]))
    options = [row for row in leveraged if metrics.split_key(row["key"])[3] != SHARES_FORM]
    best_option = max(options, key=lambda row: _zero(row["stats"]["sharpe"]))

    def named(row: Mapping) -> str:
        helps = row["verdict"]["leverageHelps"]
        sharpe, twin = row["stats"]["sharpe"], helps["twinSharpe"]
        return (f"{_short(row['key'])} (Sharpe {_two(sharpe)}, twin {helps['twin']} {_two(twin)}, "
                f"max drawdown {row['stats']['maxDrawdown']:.1%})")

    reason = (
        f"{len(results['passGate'])} of {len(rows)} form rows pass the allocation gate ({len(passing)} of "
        f"{len(leveraged)} lev rows). {len(results['passLowerBar'])} of {len(rows)} pass the owner's lower bar. "
        f"Leverage helps (Sharpe above the unleveraged twin row) in {len(helped)} of {len(leveraged)} lev rows. "
        f"Best lev row: {named(best)}. Best lev option row: {named(best_option)}. "
        "Model prices, not quotes: fund IV = leverage x ETF IV and a 4% half spread per fund leg are assumptions."
    )
    if passing:
        reason = f"Rows that pass: {', '.join(_short(key) for key in passing[:6])}. " + reason
    return ("edge" if passing else "no-edge"), reason[:1000].strip()


def _robustness(results: Mapping) -> list[dict]:
    rows = results["rows"]
    leveraged = [row for row in rows if row["verdict"]["leverageHelps"] is not None]
    gaps = [row["nautilusGap"] for row in rows if row["nautilusGap"] is not None]
    worst = min(rows, key=lambda row: row["stats"]["worst48hLoss"]["pct"] if row["stats"]["worst48hLoss"] else 0.0)
    shares = [row for row in rows if metrics.split_key(row["key"])[3] == SHARES_FORM]
    worst_shares = min(shares, key=lambda row: row["stats"]["worst48hLoss"]["pct"] if row["stats"]["worst48hLoss"] else 0.0)
    errors = results["trackingError"]
    worst_run = min((row["stats"]["monteCarlo"]["worstDrawdown"], row["key"]) for row in rows if row["stats"]["monteCarlo"])

    def loss(row: Mapping) -> str:
        found = row["stats"]["worst48hLoss"]
        return "n/a" if found is None else f"{found['pct']:.2f}% ({found['from']} to {found['to']})"

    out = [
        {"check": "NautilusTrader books every form row like the ledger", "pass": bool(results["nautilusParity"]),
         "result": f"{len(gaps)} rows with trades booked on NautilusTrader; largest relative equity gap "
                   f"{max(gaps, default=0.0):.1e} (tolerance {results['parityTolerance']:g})."},
        {"check": "Allocation gate, per form row", "pass": bool(results["passGate"]),
         "result": f"{len(results['passGate'])} of {len(rows)} rows pass every check; "
                   f"{sum(1 for row in leveraged if row['verdict']['passes'])} of {len(leveraged)} lev rows."},
        {"check": "Owner's lower bar, per form row", "pass": bool(results["passLowerBar"]),
         "result": f"{len(results['passLowerBar'])} of {len(rows)} rows pass (Sharpe >= 0.3, positive out of sample, "
                   "Monte Carlo profit >= 80%, max drawdown <= 25%, >= 30 trades)."},
        {"check": "Leverage helps: lev row Sharpe above its unleveraged twin row", "pass": None,
         "result": f"{len(results['leverageHelps'])} of {len(leveraged)} lev rows: "
                   + (", ".join(_short(key) for key in results["leverageHelps"][:6]) or "none")
                   + (" and more." if len(results["leverageHelps"]) > 6 else ".")},
        {"check": "Worst 48 hour loss (2 consecutive sessions, % of equity)", "pass": None,
         "result": f"Worst row {_short(worst['key'])}: {loss(worst)}. Worst lev-shares row "
                   f"{_short(worst_shares['key'])}: {loss(worst_shares)}."},
        {"check": "Monte Carlo worst run (drawdown of the worst bootstrap path)", "pass": None,
         "result": f"Deepest: {worst_run[0]:.1%} in {_short(worst_run[1])}."},
        {"check": "Refused and skipped", "pass": None,
         "result": f"Trades refused for size (0 units at 2% of equity): {sum(row['stats']['refused'] for row in rows)}. "
                   f"Signals skipped for overlap: {sum(row['skipped']['overlap'] for row in rows)}. Signals not priced "
                   f"(split in the window, no IV, no fund close): "
                   f"{sum(sum(row['notPriced'].values()) for row in rows)}. Sums over the {len(rows)} rows."},
    ]
    if errors:
        medians = [item["medianAbsErrorPct"] for item in errors]
        widest = max(errors, key=lambda item: item["p95AbsErrorPct"])
        out.append({"check": "Synthetic fund entry price: error of the formula at the close", "pass": None,
                    "result": f"Median absolute error {min(medians):.2f}% to {max(medians):.2f}% per fund; largest "
                              f"95th percentile {widest['p95AbsErrorPct']:.2f}% ({widest['fund']})."})
    ratio = results.get("ivRatio")
    if ratio:
        found = [(row[4], name) for name, pair in ratio["pairs"].items() for row in pair["rows"] if row[4] is not None]
        out.append({"check": "Measured fund ATM IV / (leverage x ETF ATM IV), one chain read", "pass": None,
                    "result": f"Long funds: {min(found)[0]:.2f} ({min(found)[1]}) to {max(found)[0]:.2f} "
                              f"({max(found)[1]}). The model uses 1.00. Not fitted."})
    return [{**row, "result": _clip(row["result"])} for row in out]


def _notes(results: Mapping) -> str:
    starts = "; ".join(f"{pair['underlying']} {pair['start']['session-open-momentum']}" for pair in results["pairs"])
    lines = [
        f"Data to {results['generatedFor']}. Start per pair for S1 (first day all inputs exist): {starts}. S2 starts "
        "2018-01-01 (Dukascopy data) or the pair start when that is later.",
        "Each form row pools all pairs in one book of 100,000 USD. Out of sample = last 40% of the days. Deflated "
        f"Sharpe: {results['trials']['count']} trials (the form rows), variance of their per-day Sharpes "
        f"{results['trials']['dailySharpeVariance']:.3g}.",
        "Assumptions: option prices are the qc-ports model, not quotes; fund IV = |leverage| x ETF IV at the same "
        "standardized moneyness; fund half spread 4% of mid per leg and side for the whole history; the fund entry "
        "price is modeled from the previous closes; marks and exits use daily closes.",
        "Limits: weekly expiries did not exist for every fund before about 2014; the model does not see the "
        "borrow and financing state of a fund beyond what its daily close carries; the USO pair funds (UCO, SCO) "
        "changed their benchmark in 2020 and track USO loosely; inverse funds are used for shares only.",
        "A run without a booked trade shows 0 for Sharpe, win rate and CAGR (the contract needs numbers).",
        "Research only. The result grants no trading authority and changes no engine setting.",
    ]
    return "\n".join(lines)[:4000]


def document(results: Mapping, ran: str) -> dict:
    """The `strategy-backtest` study document of a complete run."""
    if not results.get("complete") or not results.get("nautilusParity"):
        raise ValueError("The study document needs a complete run with NautilusTrader parity (all 40 form rows, "
                         "every pair, no --no-nautilus)")
    rows = results["rows"]
    by_key = {row["key"]: row for row in rows}
    option_rows = [row for row in rows if metrics.split_key(row["key"])[3] != SHARES_FORM]
    share_rows = [row for row in rows if metrics.split_key(row["key"])[3] == SHARES_FORM]
    verdict, reason = verdict_of(results)
    equity_row = by_key[results["equityRow"]]
    equity = [{"month": point["month"], "value": max(-1.0, point["value"]),
               "drawdown": min(0.0, max(-1.0, point["drawdown"]))} for point in equity_row["monthly"]][-400:]
    commit = str(results["provenance"].get("commit") or "")
    return {
        "kind": "strategy-backtest", "id": SLUG, "title": TITLE, "ran": ran, "spec": SPEC_PATH, "source": dict(SOURCE),
        "verdict": verdict, "verdictReason": reason, "rules": [dict(rule) for rule in RULES],
        "gaps": [dict(gap) for gap in GAPS],
        "forms": [
            {"key": "options",
             "label": "Option forms: etf-option, etf-vertical, lev-option, lev-vertical; all pairs in one book",
             "description": ("One run per form row = signal / regime / window (market) x form (symbol): 7 pairs pooled "
                             "in one book of 100,000 USD, 2% of equity at risk per trade. etf-* = long option or "
                             "debit vertical on the unleveraged ETF; lev-* = the same on the long leveraged fund "
                             "(put for a short signal). Model prices with costs; booked by NautilusTrader with a "
                             "ledger cross-check. OOS = last 40% of the days."),
             "runs": [_run(row) for row in option_rows][:80]},
            {"key": "underlying",
             "label": "Share fallback: lev-shares (long fund for a long signal, inverse fund for a short one)",
             "description": ("One run per signal / regime / window: shares of the leveraged fund, notional at most 2% "
                             "of equity, 10 basis points per side, real daily closes for the exit. This is the "
                             "owner's fallback for a fund whose options fail the liquidity gate."),
             "runs": [_run(row) for row in share_rows][:80]},
        ],
        "robustness": _robustness(results), "sensitivity": [], "comparison": [],
        "equity": equity,
        "equityLabel": f"Form row {_short(equity_row['key'])}: all pairs in one book, month-end equity (chosen before "
                       "the first run)",
        "provenance": {"commit": commit[:40] if commit else "0000000", "dataHash": str(results["provenance"]["dataHash"])[:80],
                       "engine": f"qc-ports ledger + {results['engine']} (parity checked)"[:80],
                       "runId": f"leveraged-etf-{ran}"},
        "notes": _notes(results),
    }


def validate(doc: Mapping) -> list[str]:
    """Problems of the document against the contract limits (empty when it fits). Uses the Python mirror
    of the contract in the volspike study (needs numpy and pandas, as that module does)."""
    from strategies.volspike.study import validate_document

    return validate_document(doc)
