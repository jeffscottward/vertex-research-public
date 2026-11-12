# Go-live draft queue

Updated: 2026-11-12. The go-live draft queue lists the defined-risk vertical orders that the allocation plan in force wants for one trading day. Vertex computes each draft; the owner approves or rejects it.

## Records only

The queue stores decisions. It sends nothing.

- The API has four procedures: `goLiveDrafts.queue`, `goLiveDrafts.collect`, `goLiveDrafts.approve` and `goLiveDrafts.reject`. There is no send route.
- The service (`packages/api/src/server/golive-drafts.ts`), its sizing rules (`golive-drafts-sizing.ts`) and the store (`packages/db/src/server/golive-drafts.ts`) import no order route, no order gateway and no confirm module. A test reads the three sources. It fails on such an import, on a dynamic `import(...)`, on a module name written as a template literal, and on a name of the order path (`vertexOrders`, `orderGateway`, `orderBridge`, `confirmToken`). The test reads these three files only, not the files they import.
- An approval is a stored owner decision: the exact order that was approved (`approvedOrder`) and the node badge read at that moment. The owner places an approved order through the existing order screen: the "Vertex orders" tab of the Portfolio page (`/portfolio`).
- Every queue answer carries `sendsOrders: false`.

## Access

| Procedure | Who |
| --- | --- |
| `queue` | An operator session, an agent viewer session, or an agent API key (read or write). A key does not see the account value. |
| `collect` | An operator's agent API key with write access (the rig generator). A session is refused. |
| `approve`, `reject` | The owner in a browser session: on the operator list and with the admin role. Agent API keys are refused. |

An agent API key never learns the account value. For a key caller the queue does not read the account: `account.netLiquidation` is empty with the reason `account value is not shown to API keys`, every draft has the sizing reason `nlv_unavailable`, and no budget, limit, max loss or order is returned.

A key caller also gets no approved order: `approvedOrder` is empty for a key, also on an approved draft. The quantity of an approved order was sized from the account value, and a key sees the plan's risk percentages, so quantity × limit would bound the account value. Sessions (owner, operator and agent viewer) see the full queue, with the approved order.

`canDecide` in the queue answer tells the caller whether it may approve and reject. It is true only for the owner in a browser session. It is false for an operator without the admin role, for an agent viewer and for every agent API key. The value comes from the same check that `approve` and `reject` run. It is information for the page; `approve` and `reject` run the check again on every call.

No procedure approves a plan. The plan record is written by the seed script.

The plan's two links are checked again when the queue is read: the owner link must be a Discord message link and the evidence link must start with the text `https://`. The seed script checks this before it writes. If a stored plan still fails the check, `queue` answers `STORAGE_ERROR` and names the plan, its version and the failing fields, without the stored value. It does not return the plan, so a bad link never reaches the page. `approve` refuses in the same way and stores nothing. `reject` still works. To repair, write the plan again with the seed script (`scripts/golive/seed-plan.ts`).

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
expired  -> proposed   (same trading day, wanted again by a later run)
```

`collect` creates proposed drafts and expires proposed drafts that the generator no longer wants. A later run of the same trading day gives a draft without a decision its new quote, facts and entry basis (see Later runs of the day). `approve` and `reject` decide a proposed draft once. Approved and rejected drafts never change. An expired draft of an earlier trading day never changes.

`reject` needs a note. The note is trimmed first, so blanks alone are refused.

## Approved order

`approve` stores the approved order with the decision, in the same database statement that moves the draft from proposed to approved. The stored order is the order the server sized at that moment: symbol, quantity, limit and legs. The order in the request is only compared with it (see Why a draft cannot be approved). `reject` stores no order. The table check `golive_drafts_approved_order_check` requires an order on an approved draft and allows none on any other draft.

The queue returns the stored order as `approvedOrder`. It is empty for a proposed, rejected or expired draft, and for an agent API key caller (see Access). The page shows it as the approved order.

`sizing` and `order` are still computed at every read, also for an approved draft. They are the current indicative sizing. They can differ from `approvedOrder` later, for example when the account value has changed. The approved order does not change.

`approve` writes only while the draft is as the request read it. If a later run changed the draft between the read and the write, `approve` answers `CONFLICT` ("The draft changed after the queue was read") and stores nothing. The owner reloads the queue and sees the draft as it is now. The store compares the `updated_at` time of the draft for this. `reject` has no such condition, because a rejection does not depend on what the draft holds.

An approved draft holds the room of its stored order, whatever the account value is later (see Sizing).

If an approved draft has no stored order, a stored value that is not an order, or an order that is not the order of that draft (another symbol, other legs, a limit outside the strike width or not in whole cents, a quantity no order can hold), `queue` answers `STORAGE_ERROR` and names the draft. `approve` refuses in the same way. The room of an approved draft is computed from its stored order, so no draft of that trading day is sized until the row is corrected. The table check and the service prevent this, so it can only follow a manual change of the row.

## What a batch must hold

`collect` refuses the whole batch when one candidate fails a check. Nothing is stored and nothing is expired.

- The trading day is the order session day (see Trading day).
- The plan id and version are those of the plan in force.
- The sleeve is in the plan, the symbol belongs to the sleeve, and the structure is the sleeve's structure.
- The strikes are the right way round for the structure. A call debit vertical and a put credit vertical buy the lower strike and sell the higher one. A put debit vertical and a call credit vertical buy the higher strike and sell the lower one.
- The expiry is a real calendar day (`20261399` is refused) and is after the trading day.
- No quote carries the label `ibkr_live` (see Live quotes do not exist yet).
- No quote is dated more than 60 seconds after the server clock. A quote dated ahead would count as live later without being read again. 60 seconds is the clock difference the approval rule allows.
- Every time (`generatedAt` and the `asOf` of a quote) is ISO-8601 date-time text with `Z` or a numeric offset, for example `2026-11-11T20:45:02Z`. Nothing is coerced: `null`, `true`, a number and a time without an offset are refused.
- The trading day holds at most 200 drafts after the run (`GOLIVE_DRAFT_LIST_MAX`), counting every state. A batch that would go above it is refused, so the queue always lists every draft of the day.

The strike rule exists because the limit and the max loss use the strike width without its sign. A call debit vertical with swapped strikes is really a call credit vertical with another max loss, and it would be sized as the position it is not.

A stored draft with its strikes the wrong way round gets no size and no order. No sizing reason says "wrong strikes", so the sizing fails on it instead of giving a reason that is not true. `queue` and `approve` answer `STORAGE_ERROR` and name the draft. No draft of that trading day is listed until the row is corrected in the database, also when the draft is rejected or expired. `reject` stores the rejection and then answers the same error with the words "The rejection of draft ... was stored". The rule in `collect` prevents such a row, so it can only be older than the rule or changed by hand.

## Later runs of the day

The generator runs three times on a trading day. A draft has the same id in every run of the day (plan, plan version, trading day, sleeve, symbol, structure, expiry and strikes), so a later run adds no second draft. For a candidate whose id is stored:

- The draft is proposed, and its quote, its facts or its entry basis differ from the candidate: the three fields are replaced. A draft first sent as `signal_today` and later sent as `model_holds_account_does_not` is a late entry from then on, and cannot be approved.
- The draft was expired by an earlier run of the same trading day: it goes back to proposed, with the content of this run.
- The draft is proposed and nothing differs: nothing is written.
- The draft is approved or rejected: nothing is written, whatever the run sends.

The answer of `collect` counts every candidate once, and separately the drafts the run expired:

| Counter | Meaning |
| --- | --- |
| `created` | The id was new. A proposed draft was stored. |
| `updated` | A stored draft got the new quote, facts or entry basis, or came back from expired. |
| `unchanged` | Nothing was written: the stored draft is the same, or it is approved or rejected. |
| `expired` | Stored proposed drafts that this run expired: drafts of earlier trading days, and entries of this trading day that the run does not send. |

## Limit price

The limit comes from the mid prices of the two legs of the stored quote.

- Debit vertical: long mid minus short mid, rounded down to a cent. The limit is never above the mid.
- Credit vertical: short mid minus long mid, rounded up to a cent, stored as a negative number. The credit asked is never below the mid.
- No limit (and so no size) when a bid or ask is missing, when a bid is 0 (nobody bids, so the mid is not a price), when a bid is above its ask, or when the rounded limit is not at least one cent above 0 and one cent below the strike width.

## Sizing

Quantity, limit and max loss are computed when the queue is read, from the account value (NLV) of the portfolio monitor. They are not stored. The one stored order is the order of an approval (see Approved order).

```text
budget              = positionRiskPct% × NLV, rounded down to the cent
max loss per spread = limit × 100                    (debit)
                    = (width − credit) × 100         (credit)
quantity            = floor(budget ÷ max loss per spread)
```

Money is counted in whole cents. The budget and every cap are rounded down to the cent, and a max loss is compared with them without a tolerance. So a max loss is never a cent above its budget or a cap. A percentage is read to six decimals.

The max loss arithmetic is the arithmetic of the web final order gate (`final-order-gate.ts`); a test checks that both agree.

One order holds at most 10,000 spreads (the quantity limit of the combo order; the code reads the number from that rule). When the budget buys more, the draft gets quantity 0 and the reason `quantity_above_order_limit`. It is not reduced.

Cap room is given in two steps.

- First, every approved draft holds one position and the max loss of its stored order: the approved quantity × the max loss per spread at the approved limit. It holds this in its sleeve, in its name and in the open risk, whatever the account value and the quote are now. Example: a draft approved at NLV 50,000 as 6 × 147 = 882 still counts 882 at NLV 10,000, and still holds its position at NLV 7,000, where one spread costs more than the budget. No cap is checked for an approved draft: the owner approved it.
- Then the proposed drafts with the entry basis `signal_today` are taken by sleeve order in the plan, then by symbol, then by id. Each must pass the four caps below, in this fixed order.

The caps:

1. Sleeve budget: the max loss in one sleeve stays at or below `budgetPct`% of NLV.
2. Name cap: the max loss in one symbol stays at or below `nameRiskCapPct`% of NLV.
3. Open risk cap: the total max loss stays at or below `openRiskCapPct`% of NLV.
4. Max positions: the number of approved drafts plus sized proposed drafts stays at or below `maxPositions`.

A draft that does not fit whole gets quantity 0 and the reason of the first cap it breaks. It is not reduced to a smaller size.

| Sizing reason | Meaning |
| --- | --- |
| `sized` | Quantity is above 0. |
| `budget_below_one_spread` | One spread costs more than the position budget. Also used when no plan is in force (budget 0). |
| `quantity_above_order_limit` | The budget buys more spreads than one order may hold. Quantity 0. |
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
- A late entry (`model_holds_account_does_not`) is sized on the position budget alone and uses no cap room. It can never be approved (`LATE_ENTRY_NOT_TESTED`) and the account does not hold it, so it must not take a sleeve, name, open-risk or position room from a `signal_today` draft.
- The `sizing` and `order` of an approved draft show what the position budget would buy today. No cap is applied to these two figures, because the draft already holds its approved room. They can be 0 while the draft still holds its room.
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

`approve` trusts the label `ibkr_live` on a stored quote. In this version nothing can give that label truthfully, so `collect` refuses a batch in which a quote carries it (`BAD_REQUEST`). Nothing is stored and nothing is expired. The refusal is a default in the server code, not an environment setting. It is to be lifted in the same change that adds a live IBKR option quote source.

## Rig generator and collect script

The drafts of a day are computed on the rig and stored through `collect`. Three units in `infra/golive-drafts/` run the wrapper `vertex-golive-drafts-run` on weekdays at 07:15, 12:40 and 15:40 New York time.

1. Data refresh. The wrapper fetches the daily data with `research/backtests/qc-ports/fetch_data.py` (public market data) into a work directory and moves the files in only after a complete fetch. The fetch runs without the write key, for at most 600 seconds. A failed refresh is reported and the collect still runs; the generator then decides on the data that is there. `GOLIVE_SKIP_REFRESH=1` skips the refresh.
2. Generator (`python -m golive` in `services/research`). It runs the signal code of the backtest (`strategies.qc_ports` and `funded_pie.sleeve_definitions`) and prints one JSON document. It has no network access and gets no key.
3. Collect (`scripts/golive/collect.ts`). It reads the plan in force, runs the generator, checks the document and posts it.

The generator refuses the run (exit 1, nothing printed) in these cases:

- The bars, or any series a sleeve reads (gates, signal inputs, the volatility index of each symbol, the rate), have no value dated the last data day itself. A carried-forward value does not count. A gap must never look like "the plan wants nothing today".
- The option-chain store or a chain file cannot be read.
- A candidate breaks an output rule: strikes equal or the wrong way round for the structure, an expiry on or before the trading day, a number that is not finite, a quote label other than `yahoo_delayed_snapshot`.

A chain snapshot gives a quote only when its New York fetch day is the last data day or later. Every candidate carries fact lines with the dates of the values that set its strikes and gates.

The collect script posts nothing and ends with a non-zero exit in these cases:

- `VERTEX_ORIGIN` is not `https:` (loopback hosts excepted, for tests), or a request is answered with a redirect. The key is never sent to a second host.
- The generator exits non-zero, is killed, runs longer than 300 seconds, or writes to stderr together with an empty candidate list.
- The document fails `GoLiveCollectInputSchema`, or a quote label is not `yahoo_delayed_snapshot`.
- The answer of the server is not a `collect` answer (for example a 200 page of HTML). The message then says that the stored state is not known.

Limits:

- A refused run stores nothing. The page then shows "the generator has not reported" for that day, the same as before the first run. The journal of `vertex-golive-drafts.service` on the rig says which it is.
- One volatility index that stops being published refuses every run until the plan or the data changes. The backtest skipped such a symbol; the generator is stricter.

## Seed script

`scripts/golive/seed-plan.ts` is the only writer of a plan record. An approved plan always needs the owner message link and `--approved-by`. A plan approved by delegation also needs the evidence link. The real links are given as arguments at deploy time and are never committed.

- `--write` reads the plan in force first and prints what it retires and what it writes.
- When the plan in force is equal to the new document, nothing is written.
- An approved plan in force is replaced by a proposed one only with `--replace-approved`.
- Every real write makes a new version. Proposed drafts of the retired version cannot be approved until the next collect. Drafts already approved under the retired version stay approved.
- Run one seed at a time: the read and the write are two database steps.

## Pre-check

`preCheck.webFinalGate` is the web final order gate run dry on the sized order. It is empty when the quantity is 0.

- The account value is the NLV used for sizing.
- The JEV verdict is the cached verdict of the shared store. Without a fresh verdict the gate denies.
- Held positions are not read: the order is checked as a new position.
- The kill switch and the OPTIONS_ONLY setting are not read here. The order screen checks them when an order is sent.

The dry web gate is run without the account's positions and without the kill-switch and options-only gates, so the real order review in the "Vertex orders" tab of the Portfolio page (`/portfolio`) can still refuse an order that the pre-check allowed.

`preCheck.enginePolicy` is always `not_evaluated_not_in_web_order_path`: the engine policy (`arm_gate.py`) is not part of the web order path.

## Node badge and the arm state

The queue shows the Nautilus node badge (`running-disarmed`, `running-armed`, `down`, `unknown`) through the read-only `nautilusArm.status` procedure. Any failure gives `unknown`. That procedure refuses agent API keys, so a key caller always sees `unknown`.

The badge is information only. The order bridge checks only the kill switch. It does not read the Nautilus arm record. A disarmed node therefore does not stop an order that is sent through the order screen. Any later send route for drafts must check the arm state itself and hold when the badge is not exactly `running-armed`.

## Exit rule

Every draft carries the owner's standing exit rule (`owner_standing_rule_v1`): winners may run to expiry, losers close 3 trading days before expiry, and open winners close at 15:45 New York time on the expiry day.

The backtest closes 3 calendar days before expiry. The two rules give the same day for a Friday expiry in a week without a holiday. They differ when a weekend or a holiday falls inside the three days; then the owner rule closes earlier. The backtest results do not include this difference.

## Market notes

This branch has no market-notes store. The queue answers `marketNotes: "feature_not_deployed"` and every draft has an empty `notes` list. The service has a small optional reader for notes, so they can be attached later.
