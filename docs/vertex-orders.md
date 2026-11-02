# Owner order screen (Portfolio > Orders)

Owner decision 2026-10-22: a submit/cancel screen for option orders, with a confirm step for
every order and every cancel. Port of the Gamma Forge order screen.

## Safety model

- **Off by default.** Live orders need BOTH `VERTEX_ORDERS_ENABLED=true` and the repo-wide
  submission gate `VERTEX_ORDER_SUBMISSION` open (a config literal `"disabled"` today, so a
  reviewed code change is also needed). Otherwise the server selects the in-memory mock
  gateway for every call. Nothing reaches IBKR. The screen shows "Orders disabled".
  Turning the flag on in production is the owner's decision.
- **Server-side rules** (`packages/api/src/server/vertex-orders-rules.ts`), applied on preview
  and again on submit from a fresh account snapshot:
  - options only (share and ETF orders are refused);
  - limit orders only;
  - calls only (the IBKR gateway `place_option` mode places calls only);
  - premium per name, including held option premium and resting BUY option orders (share
    positions are not counted): the LEAPS cap for LEAPS and the short-dated cap for shorter
    expiries; a short-dated buy must also keep the name's total option premium within the LEAPS
    cap. The caps are not set in Vertex. Each account snapshot carries `caps`
    (`leapsMinDays`, `leapsPct`, `shortPct`): the bridge reports the live gateway's effective
    values (`market_watch/premium_caps.py`), so the screen never promises more than the gateway
    accepts. Before market-watch-bot b218d58 is live the gateway uses 2% for LEAPS too. The mock
    reports 365 days / 6% / 2%;
  - SELL only closes held contracts (no naked short);
  - the kill switch blocks all new orders; `OPTIONS_ONLY` must be reported on;
  - unknown net liquidation, an expired date or a duplicate open order for the contract block
    the order.
- **Confirm step.** `vertexOrders.preview` returns the review and a signed confirm token (HMAC,
  2 minutes, one use, bound to the user and the exact order). `vertexOrders.submit` refuses a
  missing, changed, expired or reused token. Cancel uses the same two steps
  (`cancelPreview`, `cancel`). There is no bulk send.
- **Access.** Owner only: operator allow-list (`VERTEX_OPERATOR_EMAILS`) AND the admin role. Agent API keys and MCP tools
  cannot reach `vertexOrders.*`. The oRPC handler origin check blocks cross-site POSTs (CSRF).
- **Rate limit.** Per user and per minute: 20 previews, 5 submits or cancels (in-process).
- **Replay.** The used-nonce list is per process (per Worker isolate). The nonce is also the
  IBKR `orderRef` (`leaps-vertex-<nonce>`). A replay on another isolate is blocked ONLY if the
  bridge refuses an `orderRef` that was already used, as `mode_place_option` does today. This is a
  hard requirement for the bridge.
- **Audit.** Previews and results are emitted as `vertex.orders.*` semantic events (user id,
  contract, side, quantity, limit, mode, result; never account numbers). Submit and cancel first
  write a `submitIntent`/`cancelIntent` record; if that write fails (no event port, sink error,
  sink reports failed) the request is refused with `AUDIT_UNAVAILABLE` and nothing reaches the
  gateway. The record goes to the structured log sink (evlog), not to Postgres.
- Only option orders can be cancelled here. Share stop orders protect positions and are shown
  as "Not cancellable here".

## Live bridge (used only when the flag is on)

`VERTEX_ORDER_BRIDGE_URL` must be a plain `http` loopback URL. The bridge wraps the
market-watch-bot IBKR gateway and is not part of this repository. Its contract:

|Request|Body|Reply|
|---|---|---|
|`GET /account`|none|`{netLiquidation, positions[{symbol, secType, expiry, strike, right, quantity, premium}], openOrders[...], gates{killSwitch, optionsOnly}, caps{leapsMinDays, leapsPct, shortPct}}`|
|`POST /orders`|order fields plus `orderRef` (`vertex-<nonce>`)|`{state, permId, message}`|
|`POST /cancel`|`{permId}`|`{state, permId, message}`|

**Not built yet (follow-up).** No bridge exists, so there is no live transport. The bridge must
map a Vertex order to `ibkr_reentry_gateway.py place_option`: keep the `leaps-vertex-<nonce>`
orderRef, set `maxPremium` from the cap check, and supply the fields a BUY needs there (`stop`,
`undLast`, `atr14`, `rungs` exit ladder, `killSwitchClear`). The stop and exit-ladder policy is an
owner decision that is still open. The bridge must read the bot's kill switch (`state/REENTRY_DISABLED`) and `OPTIONS_ONLY`, never
change them, and apply the gateway's own guards. Until the bridge is deployed and reviewed, the
flag stays off.
