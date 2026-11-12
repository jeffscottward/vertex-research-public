# Go-live draft queue

Updated: 2026-11-11. The go-live draft queue lists the defined-risk vertical orders that the allocation plan in force wants for one trading day. Vertex computes each draft; the owner approves or rejects it.

## Records only

The queue stores decisions. It sends nothing.

- The API has four procedures: `goLiveDrafts.queue`, `goLiveDrafts.collect`, `goLiveDrafts.approve` and `goLiveDrafts.reject`. There is no send route.
- The service (`packages/api/src/server/golive-drafts.ts`) imports no order route, no order gateway and no confirm module. A test reads the source and fails on such an import.
- An approval is a stored owner decision with the node badge read at that moment. The owner places an approved order through the existing order screen (Portfolio > Orders).
- Every queue answer carries `sendsOrders: false`.

## Access

| Procedure | Who |
| --- | --- |
| `queue` | An operator session, an agent viewer session, or an agent API key (read or write). A key does not see the account value. |
| `collect` | An operator's agent API key with write access (the rig generator). A session is refused. |
| `approve`, `reject` | The owner in a browser session: on the operator list and with the admin role. Agent API keys are refused. |

An agent API key never learns the account value. For a key caller the queue does not read the account: `account.netLiquidation` is empty with the reason `account value is not shown to API keys`, every draft has the sizing reason `nlv_unavailable`, and no budget, limit, max loss or order is returned. Sessions (operator and agent viewer) see the full queue.

No procedure approves a plan. The plan record is written by the seed script.

## Trading day

A draft belongs to the session in which its order would be placed:

- today's New York date, when today is an NYSE trading day and the New York time is before 16:00;
- otherwise the next NYSE trading day (weekends and NYSE holidays are skipped).

`queue` uses this day when no `tradingDay` is given. `collect` accepts only this day and refuses any other with the accepted day in the message, because a late run for a past day would bring that day's expired drafts back. `approve` finds a draft only in the queue of this day.

Limit: on a half-day the exchange closes at 13:00, and the rule still uses 16:00.

## States

```text
proposed -> approved
proposed -> rejected
proposed -> expired
```

`collect` creates proposed drafts and expires proposed drafts that the generator no longer wants. `approve` and `reject` decide a proposed draft once. Approved, rejected and expired drafts never change.

## Limit price

The limit comes from the mid prices of the two legs of the stored quote.

- Debit vertical: long mid minus short mid, rounded down to a cent. The limit is never above the mid.
- Credit vertical: short mid minus long mid, rounded up to a cent, stored as a negative number. The credit asked is never below the mid.
- No limit (and so no size) when a bid or ask is missing, when a bid is above its ask, or when the net is not strictly between 0 and the strike width.

## Sizing

Quantity, limit and max loss are computed when the queue is read, from the account value (NLV) of the portfolio monitor. They are never stored.

```text
budget              = positionRiskPct% × NLV
max loss per spread = limit × 100                    (debit)
                    = (width − credit) × 100         (credit)
quantity            = floor(budget ÷ max loss per spread)
```

The max loss arithmetic is the arithmetic of the web final order gate (`final-order-gate.ts`); a test checks that both agree.

Then the caps apply in this fixed order. Approved drafts are sized first, so they keep their room. After them, drafts are taken by sleeve order in the plan, then by symbol.

1. Sleeve budget: the max loss in one sleeve stays at or below `budgetPct`% of NLV.
2. Name cap: the max loss in one symbol stays at or below `nameRiskCapPct`% of NLV.
3. Open risk cap: the total max loss stays at or below `openRiskCapPct`% of NLV.
4. Max positions: the number of sized drafts stays at or below `maxPositions`.

A draft that does not fit whole gets quantity 0 and the reason of the first cap it breaks. It is not reduced to a smaller size.

| Sizing reason | Meaning |
| --- | --- |
| `sized` | Quantity is above 0. |
| `budget_below_one_spread` | One spread costs more than the position budget. Also used when no plan is in force (budget 0). |
| `nlv_unavailable` | The portfolio monitor did not give a fresh account value. Every money field is empty, never 0. |
| `no_quote` | No usable quote (see Limit price). |
| `sleeve_budget_used` | Cap 1. Also used for a sleeve that is not in the plan in force. |
| `name_cap_reached` | Cap 2. |
| `open_risk_cap_reached` | Cap 3. |
| `max_positions_reached` | Cap 4. |

The account value is used only when the portfolio monitor is connected, its data time is at most 15 minutes old and its NLV is above 0. This is the rule of the Academy sizing.

Limits of this version:

- Positions already held in the account are not counted against the four caps. Only the drafts of the trading day are.
- Rejected and expired drafts are sized on the position budget alone, to show what was proposed. They use no cap room.
- Exit drafts are not derived yet. The sizing treats every draft as an entry.

## Why a draft cannot be approved

`approve` refuses a draft while its `notApprovable` list is not empty, and names the reasons.

| Reason | Cause |
| --- | --- |
| `PLAN_NOT_APPROVED` | No plan is in force, the plan is not approved, or the draft belongs to another plan or plan version. |
| `LATE_ENTRY_NOT_TESTED` | The backtest model holds the position and the account does not. A late entry is not in the backtest. |
| `NO_LIVE_IBKR_QUOTE` | The quote is missing, is not from `ibkr_live`, is older than 120 seconds, or is dated more than 60 seconds in the future. |
| `NLV_UNAVAILABLE` | No fresh account value. |
| `SIZED_TO_ZERO` | Quantity is 0 (see the sizing reason). |
| `PRECHECK_DENIED` | The web final order gate denies the sized order. |
| `DRAFT_NOT_PROPOSED` | The draft is approved, rejected or expired. |
| `DRAFT_EXPIRED` | The draft is expired. |

`approve` also refuses when the order in the request is not exactly the order the server sized: same symbol, quantity, limit and legs. One cent or one contract of difference refuses. The owner must have seen the exact order.

## Live quotes do not exist yet

No code reads option quotes from IBKR. The rig generator sends delayed indicative quotes (`yahoo_delayed_snapshot`). Such a draft is listed with its indicative limit and size, and carries `NO_LIVE_IBKR_QUOTE`. So no draft can be approved until a live IBKR option quote source exists.

## Pre-check

`preCheck.webFinalGate` is the web final order gate run dry on the sized order. It is empty when the quantity is 0.

- The account value is the NLV used for sizing.
- The JEV verdict is the cached verdict of the shared store. Without a fresh verdict the gate denies.
- Held positions are not read: the order is checked as a new position.
- The kill switch and the OPTIONS_ONLY setting are not read here. The order screen checks them when an order is sent.

The dry web gate is run without the account's positions and without the kill-switch and options-only gates, so the real order review in Portfolio > Orders can still refuse an order that the pre-check allowed.

`preCheck.enginePolicy` is always `not_evaluated_not_in_web_order_path`: the engine policy (`arm_gate.py`) is not part of the web order path.

## Node badge and the arm state

The queue shows the Nautilus node badge (`running-disarmed`, `running-armed`, `down`, `unknown`) through the read-only `nautilusArm.status` procedure. Any failure gives `unknown`. That procedure refuses agent API keys, so a key caller always sees `unknown`.

The badge is information only. The order bridge checks only the kill switch. It does not read the Nautilus arm record. A disarmed node therefore does not stop an order that is sent through the order screen. Any later send route for drafts must check the arm state itself and hold when the badge is not exactly `running-armed`.

## Exit rule

Every draft carries the owner's standing exit rule (`owner_standing_rule_v1`): winners may run to expiry, losers close 3 trading days before expiry, and open winners close at 15:45 New York time on the expiry day.

The backtest closes 3 calendar days before expiry. The two rules give the same day for a Friday expiry in a week without a holiday. They differ when a weekend or a holiday falls inside the three days; then the owner rule closes earlier. The backtest results do not include this difference.

## Market notes

This branch has no market-notes store. The queue answers `marketNotes: "feature_not_deployed"` and every draft has an empty `notes` list. The service has a small optional reader for notes, so they can be attached later.
