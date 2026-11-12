"""Regenerate qc_ports/quantjourney-orders-reference.json from the upstream QuantJourney fill engine.

Not a test and not a runtime dependency. It needs a checkout of quantjourney-bt (commit 4f403d8) and its
dependencies, for example the venv of the qc-ports Nautilus lane:

    cd services/research && python tests/fixtures/make_quantjourney_orders_reference.py ~/Github/tools/quantjourney-bt
    bunx --bun --no-install biome format --write tests/fixtures/qc_ports/quantjourney-orders-reference.json

It checks the fill semantics of the upstream FillEngine, not the upstream example files: it drives the FillEngine
with the order logic of example_orders_15_intraday_5m_bracket_reversion.py and
example_orders_16_intraday_30m_stop_breakout.py, restated here (one share, one symbol, the RSI of
strategies.qc_ports.forms), on seeded random-walk bars (tests/qc_ports_synthetic.random_walk_bars). It writes
the upstream stance per bar: the shares held, and on a bar with a market order the side of that order.
test_qc_ports_forms_intraday.py compares forms_orders.run with these stances. No market data, no provider.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

RESEARCH = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RESEARCH))

from strategies.qc_ports.forms import rsi  # noqa: E402
from tests.qc_ports_synthetic import random_walk_bars  # noqa: E402

OUT = Path(__file__).with_name("qc_ports") / "quantjourney-orders-reference.json"
BARS = 900  # every seed has an O15 entry at this length
SEEDS = range(8)
VOLS = (0.002, 0.008)  # RSI is scale-free: the volatility changes the stop and take-profit hits, not the entries


def upstream(bars, key: str) -> list[int]:
    from backtester.execution.fill_engine import FillEngine
    from backtester.execution.order_types import BarData, BracketSpec, Order, OrderSide, OrderType

    engine = FillEngine()
    position = 0.0
    out: list[int] = []
    has_bracket = False
    bar_count = 0
    entry_bar = None
    values = rsi(list(bars.close), 14)
    start = datetime(2024, 1, 1)
    for index, close in enumerate(bars.close):
        bar = BarData(start + timedelta(minutes=index), bars.open[index], bars.high[index], bars.low[index], close, 1e9)
        for fill in engine.process_bar("SPY", bar):
            position += fill.quantity if fill.side == OrderSide.BUY else -fill.quantity
        market = None
        if key == "qj/O15":
            value = values[index]
            if value is not None:
                if position == 0 and has_bracket:
                    has_bracket = False
                if value < 30 and position == 0 and not has_bracket:
                    engine.submit(Order("SPY", OrderSide.BUY, 1, OrderType.BRACKET, bracket=BracketSpec(
                        take_profit_price=round(close * 1.006, 2), stop_loss_price=round(close * 0.996, 2))))
                    has_bracket = True
                    market = True
        elif index >= 12:
            bar_count += 1
            if position > 0:
                if bar_count - (entry_bar or 0) >= 8:
                    engine.cancel_all(instrument="SPY")
                    engine.submit(Order("SPY", OrderSide.SELL, position, OrderType.MARKET))
                    entry_bar = None
                    market = False
            else:
                prior_high = max(bars.high[index - 12:index])
                engine.submit(Order("SPY", OrderSide.BUY, 1, OrderType.STOP, stop_price=round(prior_high * 1.001, 2),
                                    expires_after_bars=3))
                entry_bar = bar_count
        # The shares held (more than 1 would be a second stop filling), or the side of a market order of the bar.
        out.append(int(position) if market is None else int(market))
    return out


def main() -> None:
    checkout = Path(sys.argv[1]).expanduser().resolve()
    sys.path.insert(0, str(checkout))
    commit = subprocess.run(["git", "-C", str(checkout), "rev-parse", "--short", "HEAD"], capture_output=True,
                            text=True, check=True).stdout.strip()
    runs = [{"key": key, "seed": seed, "vol": vol,
             "stance": "".join(map(str, upstream(random_walk_bars(seed, BARS, vol), key)))}
            for key in ("qj/O15", "qj/O16") for seed in SEEDS for vol in VOLS]
    document = {"source": f"quantjourney-bt {commit} backtester.execution.FillEngine", "bars": BARS, "runs": runs}
    OUT.write_text(json.dumps(document, indent=1) + "\n")
    print(f"wrote {OUT}: {len(runs)} runs")


if __name__ == "__main__":
    main()
