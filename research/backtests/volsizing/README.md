# Vol-target position sizing (Carver method) for Vertex debit spreads

Research only: no orders, no broker calls, nothing promoted to paper or live trading. No
pysystemtrade (GPL-3.0) code is used; `volsizing.py` implements the published method in our own
code. Card `vertex-volsizing-research`; the note is `~/Documents/reports/web/vertex-volsizing/index.html`.

- `volsizing.py`: Nautilus engine of record (`services/research/nautilus_backtest`) produces the
  entries and exits of library strategies O01, O02 and O12 on the Core 7 ETF twins; an options
  overlay expresses each trade as the Vertex proposal call debit spread (120 DTE, 0.60/0.30 delta)
  and sizes it five ways inside the 2% NLV max-loss gate: current fixed 0.50% NLV max loss,
  risk-matched vol target, risk-matched vol target with weekly buffered resizing, a shrink-only
  vol brake, and Carver's default 16% vol target.
- `results.json`: derived statistics only (dummy $1,000,000 account, public Yahoo bars that are not
  in the repository).
- `render_note.py`: writes the dark HTML note with the chart from `results.json`.
- `test_volsizing.py`: unit tests (option math, gate, sizing, buffer, IDM, vol estimators) and
  synthetic-market tests of `simulate()` (entry, rolls, exit, cash, gate at entry/roll/add).

```sh
uv run --no-project --python 3.12 --with yfinance==0.2.66 \
  python research/backtests/volsizing/fetch_ivx.py --out ~/Documents/reports/vertex-core7/data
<nautilus-venv>/bin/python research/backtests/volsizing/volsizing.py \
  --data ~/Documents/reports/vertex-core7/data --out research/backtests/volsizing/results.json
npx biome format --write research/backtests/volsizing/results.json
python3 research/backtests/volsizing/render_note.py research/backtests/volsizing/results.json \
  ~/Documents/reports/web/vertex-volsizing/index.html
<nautilus-venv>/bin/python -m pytest research/backtests/volsizing/test_volsizing.py -q
```

Finding: with fixed-delta strikes the current fixed-risk rule already sizes close to vol parity
(every signal entry implies a vol target of about 4%, coefficient of variation 0.11 with the vol
proxy and 0.16 with the Cboe implied-vol indices), so vol targeting changes Sharpe only within
noise (paired block-bootstrap CIs) and buffered resizing adds orders for no clear gain.
Recommendation: not worth building as a hot-swap tool. The finding depends on fixed-delta strikes
and on option prices that track implied vol; with a stale 252-day vol in the prices, or
fixed-width strikes, the current rule would drift further from vol parity.

`fetch_ivx.py` fetches the Cboe implied-vol indices (VIX, VXN, VXD, GVZ, OVX) for the robustness
run into `<data>/ivx/` (not in the repository); IWM and SLV have no Yahoo history and keep the
proxy.
