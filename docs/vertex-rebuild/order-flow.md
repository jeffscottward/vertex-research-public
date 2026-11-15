# Order flow on /charts

LuxAlgo gap phase P5 (card vertex-luxalgo-p5). Research only: nothing here places orders, and no
view tells anyone to trade. The owner chose on 2026-11-06 to build on the market data the IBKR
account already has; no new paid feed was added.

## What it does

The "Order flow" panel sits under "Return analysis" on `/charts` for stocks and futures. It loads
nothing until you press **Load order flow**, because tick requests share the IBKR pacing budget
with chart bars. Each tab has its own Refresh and its own error state, so one missing permission
does not hide the other views.

- **Time & Sales.** The most recent trade prints (50 to 1000, default 500) with time in the
  exchange time zone, price, size, venue and side. Side comes from the quote rule (at or above the
  ask is a buy, at or below the bid is a sell, using the last quote at or before the print) and
  falls back to the tick rule. Each row says which rule signed it; the header counts both.
- **Order book.** A one-shot depth snapshot as a price ladder with bid and ask sizes and the
  cumulative size. Futures read the exchange book (CME depth works on the account). Stocks read
  IBKR SMART depth: today that is IEX full depth plus the top of book from other venues. The panel
  lists the venues with depth, the venues with top of book only and the venues that need a market
  data subscription, as IBKR reports them (notice 2152). Stock sizes arrive in round lots and are
  multiplied by IBKR's `mdSizeMultiplier`. When the account has no depth for the instrument, the
  tab says so (ENTITLEMENT) and shows no prices.
- **Footprint.** The fetched prints bucketed by time and price: sell (bid-hit) and buy (ask-lift)
  volume per cell, delta and the point of control per bucket.
- **Delta / CVD.** Delta per bucket and cumulative volume delta over the same prints.
  Under the delta bars, exhaustion runs are listed: 3+ consecutive buckets that make new highs
  (lows) while volume and the delta in that direction both shrink ("higher price, less fuel").
  A heuristic research flag, not a signal.
- **TPO.** Market profile from 30-minute bars of the last five sessions (regular hours): one letter
  per period at every price the period traded, point of control, 70% value area, initial balance
  (first two periods) and single prints. TPO needs only bars, so it works when ticks fail.

Footprint and delta cover only the fetched tick window (one IBKR request returns at most 1000
prints, which is seconds to minutes for SPY or ES). The panel shows the covered time range.

## Data path

`marketData.ticks` (GET `/market-data/ticks`) and `marketData.depth` (GET `/market-data/depth`)
are operator-only reads in `packages/api/src/server/market-data.ts`. They call the QuantVPS history
service (`infra/quant-vps/history/vertex_history.py`, version 1.1.0) through `VERTEX_HISTORY_URL`,
like `marketData.bars`.

- `/ticks`: `reqHistoricalTicks` TRADES, then BID_ASK over the same window when quotes are asked
  for. Both go through the historical pacer (at least 10 s apart), so a request with quotes takes
  10 s or more. Cache 15 s; a stale copy is served for up to 15 minutes while paced.
- `/depth`: `reqMktDepth` for 2 s, then `cancelMktDepth` always runs. One depth subscription at a
  time, at least 3 s apart, cache 5 s.
- The service still makes no order calls; the static scan in `test_vertex_history.py` checks it.

## Deploy

The web part ships with the normal QuantVPS web deploy. The history service is installed on
QuantVPS under `/opt/vertex-history`: back up the folder, run `test_vertex_history.py` with
`/opt/vertex-history/venv/bin/python`, copy `vertex_history.py`, restart `vertex-history` and check
`/vertex-history/v1/health`. The tailnet Caddy route `/vertex-history/v1/*` already covers the new
paths.

## Paid depth (owner decision)

More stock depth needs an IBKR subscription the owner buys in Client Portal (non-professional,
per month, 2026-11-06): NASDAQ TotalView-OpenView $16.50 plus EDS $1.00 for API use, NYSE
ArcaBook $11.00, NYSE OpenBook $25.00. The ladder shows any added book with no code change.
