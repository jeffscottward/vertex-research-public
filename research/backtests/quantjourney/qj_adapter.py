"""Run one unchanged QuantJourney example strategy on Vertex's local Yahoo data.

Research only. This adapter is the ONLY Vertex file that imports the QuantJourney ``backtester``
package (Apache-2.0, pinned clone; see research/backtests/quantjourney/README.md). It places no
orders, sends no data to QuantJourney and needs no QuantJourney account. Checked 2026-10-31:
all 46 runs complete inside a Linux network namespace with no interface up (`sudo unshare --net`).

How it works:
* The strategy file from the pinned clone is imported unchanged.
* ``_fetch_market_data`` (normally ``POST /bt/prepare`` on api.quantjourney.cloud) is replaced by a
  builder that returns the same payload shape from the local CSV files written by ``fetch_data.py``.
* Benchmark downloads are replaced by the local benchmark CSV.
* Bars are dividend-adjusted (open/high/low/close scaled by adj_close/close), like QuantJourney's data.
* ``QJ_NO_REPORTS=1`` turns off plots and text reports. The strategy keeps its own cost settings.

Run (rig, in the pinned clone's locked environment):
  uv run --project ~/Github/tools/quantjourney-bt --frozen --extra wf python \
      research/backtests/quantjourney/qj_adapter.py --clone ~/Github/tools/quantjourney-bt \
      --data ~/Documents/reports/vertex-quantsmd/data --out ~/Documents/reports/vertex-quantsmd/runs \
      [--only O01,W01] [--cost-bps 10]

Output: runs/<ID>.json with the net daily returns, the NAV and QuantJourney's own summary numbers.
``--cost-bps`` adds a Vertex cost case: weight-mode strategies get a fixed cost per traded
notional; order-mode strategies get the same fixed slippage (their commission stays).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.util
import io
import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import pandas as pd

os.environ.setdefault("QJ_NO_REPORTS", "1")
os.environ.setdefault("QJ_QUIET", "1")
os.environ.setdefault("QJ_API_KEY", "vertex-local-adapter-no-network")
os.environ.pop("QJ_SAMPLE_DATA", None)

# Contract metadata normally returned by qj-api for O19/O20/W23-W25. Exchange-standard values.
INSTRUMENT_SPECS: dict[str, dict[str, Any]] = {
    **{pair: {"asset_class": "fx", "base_currency": pair[:3], "quote_currency": "USD",
              "lot_size": 100_000.0, "multiplier": 1.0, "tick_size": 0.00001}
       for pair in ("EURUSD=X", "GBPUSD=X", "AUDUSD=X", "NZDUSD=X")},
    "MES=F": {"asset_class": "future", "multiplier": 5.0, "tick_size": 0.25, "currency": "USD"},
    "MNQ=F": {"asset_class": "future", "multiplier": 2.0, "tick_size": 0.25, "currency": "USD"},
    "CL=F": {"asset_class": "future", "multiplier": 1000.0, "tick_size": 0.01, "currency": "USD"},
    "GC=F": {"asset_class": "future", "multiplier": 100.0, "tick_size": 0.1, "currency": "USD"},
    "ZN=F": {"asset_class": "future", "multiplier": 1000.0, "tick_size": 0.015625, "currency": "USD"},
    "ZC=F": {"asset_class": "future", "multiplier": 50.0, "tick_size": 0.25, "currency": "USD"},
}
FIELDS = ("open", "high", "low", "close", "adj_close", "volume")


def _frame_payload(df: pd.DataFrame) -> dict[str, Any]:
    safe = df.astype(object).where(pd.notna(df), None)
    return {
        "columns": [{"instrument": str(i), "field": str(f)} for i, f in df.columns.to_list()],
        "index": [idx.isoformat() for idx in df.index],
        "data": safe.values.tolist(),
    }


def _series_payload(series: pd.Series) -> dict[str, Any]:
    safe = series.astype(object).where(pd.notna(series), None)
    return {"index": [idx.isoformat() for idx in series.index], "data": safe.tolist()}


def load_bars(data: Path, symbol: str, granularity: str) -> pd.DataFrame:
    """Read one CSV and scale open/high/low/close by adj_close/close (dividend-adjusted bars).

    QuantJourney's provider data behaves as adjusted bars: with raw split-only bars the order
    examples miss the dividends (O01 101.7% instead of the published 126.7%); with adjusted
    bars O01 and O17 match their dashboards to 0.1 point (checked 2026-10-31).
    """
    folder = "daily" if granularity == "1d" else "hourly"
    path = data / folder / f"{symbol}.csv"
    frame = pd.read_csv(path)
    key = "date" if folder == "daily" else "timestamp"
    index = pd.to_datetime(frame[key], utc=True)
    frame = frame.drop(columns=[key])
    frame.index = index
    frame = frame.astype(float)
    ratio = frame["adj_close"] / frame["close"]
    for column in ("open", "high", "low", "close"):
        frame[column] = frame[column] * ratio
    return frame


def build_payload(data: Path, instruments: list[str], start: str, end: str, granularity: str) -> dict[str, Any]:
    """Return a /bt/prepare-shaped payload (same shape as backtester.sample_data) from local CSV files."""
    lo, hi = pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC")
    bars = {s: load_bars(data, s, granularity) for s in instruments}
    bars = {s: b[(b.index >= lo) & (b.index < hi)] for s, b in bars.items()}
    index = sorted(set().union(*[set(b.index) for b in bars.values()]))
    index = pd.DatetimeIndex(index)
    price_frames, metric_frames, parameter_frames, returns = [], [], [], {}
    for symbol in instruments:
        raw = bars[symbol].reindex(index)
        traded = raw["close"].notna()
        filled = raw.ffill()
        filled["volume"] = raw["volume"].fillna(0.0)
        price_frames.append(pd.DataFrame({(symbol, f): filled[f] for f in FIELDS}, index=index))
        ret = filled["adj_close"].pct_change(fill_method=None).fillna(0.0)
        returns[symbol] = ret
        nav = (1.0 + ret).cumprod()
        metric_frames.append(pd.DataFrame({
            (symbol, "returns"): ret,
            (symbol, "volatility"): ret.rolling(20, min_periods=2).std().fillna(0.0),
            (symbol, "daily_pnl"): ret,
            (symbol, "transaction_costs"): 0.0,
            (symbol, "net_asset_value"): nav,
            (symbol, "gross_asset_value"): nav,
            (symbol, "daily_net_return"): ret,
            (symbol, "drawdown"): nav / nav.cummax() - 1.0,
        }, index=index))
        listed = filled["close"].notna()
        parameter_frames.append(pd.DataFrame({
            (symbol, "exchange"): 0.0,
            (symbol, "units"): 0.0,
            (symbol, "eligibility"): listed.astype(float),
            (symbol, "active"): listed.astype(float),
            (symbol, "forecasts"): 0.0,
            (symbol, "is_trading_day"): traded.astype(float),
            (symbol, "day_type"): 1.0,
        }, index=index))

    def combine(frames: list[pd.DataFrame]) -> pd.DataFrame:
        out = pd.concat(frames, axis=1)
        out.columns = pd.MultiIndex.from_tuples(out.columns, names=["instrument", "field"])
        return out

    nav = 100.0 * (1.0 + pd.DataFrame(returns).mean(axis=1)).cumprod()
    specs = {s: INSTRUMENT_SPECS[s] for s in instruments if s in INSTRUMENT_SPECS}
    return {
        "session_id": "vertex-local",
        "dataset_id": "vertex-yahoo",
        "instrument_names": instruments,
        "instrument_specs": specs,
        "prices": _frame_payload(combine(price_frames)),
        "metrics": _frame_payload(combine(metric_frames)),
        "parameters": _frame_payload(combine(parameter_frames)),
        "nav": _series_payload(nav),
        "summary": {"source": "vertex-yahoo", "instruments": len(instruments), "dates": len(index),
                    "start": index[0].date().isoformat(), "end": index[-1].date().isoformat()},
    }


def install(data: Path, captured: list[Any], cost_bps: float | None) -> None:
    """Replace the network data fetch and benchmark download; capture the strategy instance."""
    from backtester import Backtester
    from backtester.engines import benchmark as bench_mod
    from backtester.mixins import sdk_client

    async def fetch(self) -> None:  # replaces POST /bt/prepare
        self._api_response = build_payload(data, list(self.instruments), self.backtest_period.start,
                                           self.backtest_period.end, self._granularity)
        self.session_id = self._api_response["session_id"]
        self.dataset_id = self._api_response["dataset_id"]
        self._validate_data_completeness_response()
        captured.append(self)

    async def benchmark(returns_index, symbol="SPY", start_date=None, end_date=None, sdk_client=None):
        try:
            frame = load_bars(data, symbol, "1d")
        except FileNotFoundError:
            return None
        ret = frame["adj_close"].pct_change(fill_method=None).dropna()
        ret.index = ret.index.normalize()
        return bench_mod._align_benchmark_returns(ret, returns_index)

    for klass in Backtester.__mro__:
        if "_fetch_market_data" in vars(klass):
            setattr(klass, "_fetch_market_data", fetch)
    sdk_client.SDKClientMixin._fetch_market_data = fetch  # type: ignore[attr-defined]
    bench_mod.get_benchmark_returns = benchmark

    if cost_bps is not None:
        from backtester.execution.slippage import FixedBpsSlippage
        from backtester.portfolio.weight_cost import FixedBpsWeightCostModel
        original = Backtester.__init__

        def init(self, *args, **kwargs):
            if kwargs.get("execution_mode", "weights") == "orders":
                kwargs["slippage_model"] = FixedBpsSlippage(bps=cost_bps)
            else:
                kwargs["weight_cost_model"] = FixedBpsWeightCostModel(total_bps=cost_bps)
            original(self, *args, **kwargs)

        Backtester.__init__ = init


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def run_one(clone: Path, data: Path, entry: dict, cost_bps: float | None) -> dict:
    captured: list[Any] = []
    install(data, captured, cost_bps)
    path = clone / "strategies" / entry["file"]
    spec = importlib.util.spec_from_file_location(f"qj_{entry['id']}", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    started = time.time()
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        if asyncio.iscoroutinefunction(module.main):
            asyncio.run(module.main())
        else:  # WF04/WF05 drive their own event loops
            module.main()
    if not captured:
        raise RuntimeError("strategy did not fetch data")
    bt = captured[-1]
    pdata = bt.portfolio_data
    nav = pdata.net_asset_value
    ret = pdata.returns
    days = [ts.isoformat() for ts in nav.index]
    return {
        "id": entry["id"],
        "file": entry["file"],
        "cost_bps_override": cost_bps,
        "seconds": round(time.time() - started, 2),
        "period": [days[0], days[-1]],
        "returns": [_num(v) for v in ret.reindex(nav.index).fillna(0.0).tolist()],
        "nav": [_num(v) for v in nav.tolist()],
        "index": days,
        "qj_summary": {
            "sharpe": _num(getattr(pdata, "sharpe_ratio", None)),
            "total_return": _num(nav.iloc[-1] / nav.iloc[0] - 1.0),
            "max_drawdown": _num(pdata.drawdown.min()) if pdata.drawdown is not None else None,
        },
        "stdout_tail": log.getvalue()[-2000:],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clone", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--library", type=Path, default=Path(__file__).with_name("library.json"))
    parser.add_argument("--only", default="")
    parser.add_argument("--cost-bps", type=float, default=None)
    args = parser.parse_args()
    library = json.loads(args.library.read_text())["strategies"]
    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    args.out.mkdir(parents=True, exist_ok=True)
    suffix = "" if args.cost_bps is None else f".cost{args.cost_bps:g}"
    for entry in library:
        if wanted and entry["id"] not in wanted:
            continue
        if entry["rerun"]["status"] != "run":
            continue
        target = args.out / f"{entry['id']}{suffix}.json"
        try:
            result = run_one(args.clone, args.data, entry, args.cost_bps)
            status = "ok"
        except Exception as exc:  # noqa: BLE001 - report every failure, keep going
            result = {"id": entry["id"], "error": f"{type(exc).__name__}: {exc}",
                      "trace": traceback.format_exc()[-3000:]}
            status = "error"
        target.write_text(json.dumps(result) + "\n")
        print(f"{entry['id']}: {status} {result.get('qj_summary', result.get('error'))}", flush=True)


if __name__ == "__main__":
    main()
