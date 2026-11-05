# Owner order screen (Portfolio > Orders)

Owner decision 2026-10-22: a submit/cancel screen for option orders, with a confirm step for
every order and every cancel. It grew out of the order screen of Gamma Forge, the earlier version of Vertex.

## Safety model

- **Off by default.** Live orders need BOTH `VERTEX_ORDERS_ENABLED=true` and the repo-wide
  submission gate `VERTEX_ORDER_SUBMISSION=enabled` (default `disabled`), plus
  `VERTEX_ORDER_BRIDGE_URL` and `VERTEX_ORDER_BRIDGE_TOKEN`. Otherwise the server selects the
  in-memory mock gateway for every call. Nothing reaches IBKR. The screen shows "Orders
  disabled". Turning the flags on in production is the owner's decision (owner chose the live
  path on 2026-11-04; the flip itself needs one more FIRSTMATE ask).
- **Server-side rules** (`packages/api/src/server/vertex-orders-rules.ts`), applied on preview
  and again on submit from a fresh account snapshot:
  - options only for NEW positions; held shares (STK, which includes ETFs) can always be closed or
    reduced (owner 2026-11-04: every held position has a working Close); closing and reducing is
    never blocked by `OPTIONS_ONLY`, unknown NLV, the max-loss gate or the kill switch, only by a
    resting order on the same contract or shares (for example a stop or a conditional exit: cancel
    it first) or a working combo on the name;
  - limit orders only;
  - calls and puts (the Vertex order tail places both);
  - no legging out: on a name with two or more option legs and at least one short leg (a
    spread), a single-leg closing order is refused; the spread closes as one combo;
  - premium per name, including held option premium and resting BUY option orders (share
    positions are not counted): the LEAPS cap for LEAPS and the short-dated cap for shorter
    expiries; a short-dated buy must also keep the name's total option premium within the LEAPS
    cap. The caps are not set in Vertex. Each account snapshot carries `caps`
    (`leapsMinDays`, `leapsPct`, `shortPct`): the bridge reports the live gateway's effective
    values (`market_watch/premium_caps.py`), so the screen never promises more than the gateway
    accepts. Before market-watch-bot b218d58 is live the gateway uses 2% for LEAPS too. The mock
    reports 365 days / 6% / 2%;
  - max loss (owner hard gate 2026-11-02): an opening BUY whose premium is above 2% NLV is
    refused, even inside the per-name cap; closing orders are exempt;
  - SELL only closes held contracts (no naked short): sell-to-open is only allowed as a leg of a
    defined-width spread, which a single order never is;
  - the kill switch blocks opening and increasing orders only; every close (single, share or
    combo) stays available (owner 2026-11-04: "close button no matter what"); `OPTIONS_ONLY`
    must be reported on for new positions;
  - unknown net liquidation, an expired date or a duplicate open order for the contract block
    the order.
- **Confirm step.** `vertexOrders.preview` returns the review and a signed confirm token (HMAC,
  2 minutes, one use, bound to the user and the exact order). `vertexOrders.submit` refuses a
  missing, changed, expired or reused token. Cancel uses the same two steps
  (`cancelPreview`, `cancel`). There is no bulk send.
- **Access.** Owner only: operator allow-list (`VERTEX_OPERATOR_EMAILS`) AND the admin role. Agent API keys and MCP tools
  cannot reach `vertexOrders.*`. The oRPC handler origin check blocks cross-site POSTs (CSRF).
- **Rate limit.** Per user and per minute: 20 previews, 5 submits or cancels (in-process).
- **One placement at a time.** While a `submit` or `comboSubmit` is placing, a second one is
  refused with `RATE_LIMITED` and keeps its confirm token. Each placement reads the account after
  the previous order is placed, so parallel submits cannot pass a per-name cap or the 2% max-loss
  gate together on one stale snapshot. The guard is a lease that ends after the bridge timeout
  plus 30 s, so a cancelled request cannot block placements for longer. Cancels are not gated.
- **Replay.** The used-nonce list is per process (per Worker isolate). The nonce is also the
  IBKR `orderRef` (`vertex-<nonce>`). A replay on another isolate is blocked ONLY if the
  bridge refuses an `orderRef` that was already used, as `mode_place_option` does today. This is a
  hard requirement for the bridge.
- **Audit.** Previews and results are emitted as `vertex.orders.*` semantic events (user id,
  contract, side, quantity, limit, mode, result; never account numbers). Submit and cancel first
  write a `submitIntent`/`cancelIntent` record; if that write fails (no event port, sink error,
  sink reports failed) the request is refused with `AUDIT_UNAVAILABLE` and nothing reaches the
  gateway. The record goes to the structured log sink (evlog), not to Postgres.
- **Unknown outcome** (state-machine audit 2026-11-03). Submit writes an order intent to Postgres
  (`audit_records`, entity type `vertex_order`, `packages/db/src/server/order-intents.ts`) before the
  gateway call, then a result row: `placed`, or `unknown` when the call fails or times out (the
  order may still reach IBKR). Live mode refuses preview and submit with `AUDIT_UNAVAILABLE` when the
  intent store is missing or the intent row fails. Every preview and submit first reconciles unknown
  intents from the last 7 days against the fresh account: the `orderRef` in open orders resolves as
  `open` at once. After 10 minutes a changed position in the contract resolves as `position-changed`,
  an unchanged one as `not-found`. Submits are placed one at a time (see "One placement at a time"). While an intent is still unknown, every new order is refused with a reason that
  names it.
- Only option orders can be cancelled here. Share stop orders protect positions and are shown
  as "Not cancellable here".

## Position buttons (Portfolio > Positions and Options)

Owner decision 2026-11-04: each position row has an Actions column with Close, Buy and Sell
(`apps/web/src/components/portal/position-actions.tsx`). The buttons use the same
`vertexOrders.preview` and `vertexOrders.submit` calls, the same rules and the same confirm token.

- **Defaults.** Close = the full held quantity on the closing side (SELL for a long, BUY for a
  short). Buy and Sell = 1 contract. Limit = the IBKR mark from the monitor feed (it has no
  bid/ask, so the mark is the mid estimate). Close starts with "Marketable limit" on: mark - 5% for
  a sell, mark + 5% for a buy. Quantity and limit can be edited. Options are never exercised.
- **Confirm.** A click opens a dialog with symbol, side, quantity, order type, limit and the
  estimated cost or proceeds. "Review order" runs the server rules. Only an accepted review shows
  the send button. Cancel (focused first) or Escape closes the dialog and sends nothing.
- **Gates.** The kill switch (from `vertexOrders.status`) and unknown gates disable Buy and Sell.
  Close always stays enabled. Share rows (STK) have Close only (full holding, mark − 1% for a sale). Rows of
  other security types (for example futures) show "Not supported here". Spread legs: see below.
- **Closing orders** (rules change, same date): a SELL against a long or a BUY that covers a short
  is a closing order. It has no premium cap and may trade on expiry day. Opening orders still need
  an expiry after today and keep every cap.

## Spread close: one combo order (owner 2026-11-04)

A Close click on any leg of a spread opens one combo dialog for all legs of that name. Buy and
Sell are disabled on spread legs. The dialog closes the whole spread: each leg reverses its held
size (quantity = the greatest common divisor of the leg sizes, ratio = leg size / quantity). Only
the net limit per combo can be edited (+ debit / − credit; default the net of the marks, with
"Marketable" 5% toward a fill). `vertexOrders.comboPreview` and `vertexOrders.comboSubmit` follow
the same confirm, intent and unknown-outcome rules as single orders. `evaluateCombo` refuses any
leg that does not close its held size exactly, duplicate legs, past expiries, a resting order on
a leg or a working combo on the name; the kill switch does not block it. Options are never exercised.

## Live bridge (used only when the flags are on)

The bridge is `market_watch/vertexbridge.py` in market-watch-bot (`python -m market_watch.vertexbridge`,
127.0.0.1:3470 on QuantVPS, unit `vertex-order-bridge.service`). It runs
`ops/vertex_order_tail.py` (appended to `ops/ibkr_reentry_gateway.py` after the 2% max-loss gate
source) in the IBKR container as its own client id 211 (never 194/196/197/198). Every request
needs header `X-Vertex-Bridge-Token` equal to its 0600 token file; no token file refuses all. The
kill switch is the execution engine stop file (`/opt/vertex-exec-node/data/KILL_SWITCH`); it
blocks opening and increasing orders only. Closes and cancels stay allowed. Before a close, any live order of any client on the
same contract (for example a client-196 conditional LEAPS exit) must be cancelled first; the tail
refuses otherwise, so a resting exit cannot later open a short.

|Request|Body|Reply|
|---|---|---|
|`GET /account`|none|`{netLiquidation, positions[...], openOrders[...], gates{killSwitch, optionsOnly}, caps{...}}`|
|`POST /orders`|single order fields plus `orderRef` (`vertex-<nonce>`)|`{state, permId, message}`|
|`POST /combos`|combo fields (`symbol`, `quantity`, `limitPrice`, `legs[]`) plus `orderRef`|`{state, permId, message}`|
|`POST /cancel`|`{permId}` (Vertex orders of client 211 only)|`{state, permId, message}`|

`state` `unconfirmed` (sent, IBKR has not acknowledged) is stored as an unknown outcome.
