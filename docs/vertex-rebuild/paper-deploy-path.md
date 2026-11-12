# Paper deploy path (paper only)

Card `vertex-paper-deploy-path`. Fixes F1, F3, F4, F5 and F6 of the deployability rehearsal
(`research/backtests/allocation/deploy_rehearsal.py`). F2a (order policy v3 for defined-risk vertical
spreads) belongs to card `vertex-golive-spread-gate`.

The path:

```text
approved paper request -> paper strategy -> order policy -> simulated fill -> owner exit rule
```

Nothing in this path talks to a broker, a gateway, a database or the network. It arms nothing. It
cannot run live: every stage refuses a request whose mode is not `paper`, and the venue type is fixed
to the simulator.

## Where the code is, and why not in the node

Code: `services/execution/vertex_execution/paper_deploy/`.

It is not in the QuantVPS exec node (`infra/quant-vps/exec-node`). Reasons:

- Owner decision 2026-11-04: the node has no trade-intent source (`test_no_signal_intake.py`).
- The engine-link design (card `vertex-library-engine-link-design`) rejected a node that reads approved
  requests. Its first paper step is a runner with no send function and no network client.
- The path needs no deploy this way.

The path still uses the engine's real order policy: `ArmGatePolicy` calls
`arm_gate.check_order_policy` on a module that the caller injects.

| Module | Fix | Purpose |
| --- | --- | --- |
| `request.py` | F5 | Reads a deployment request record. Old records (no `options`) load. |
| `strategy.py` | F1 | `PaperSpreadStrategy`: request + intent + account value -> one combo order. No signal code. |
| `policy.py` | F1 | `PolicyPort`, and `ArmGatePolicy` for the engine policy (v2 and v3). |
| `venue.py` | F3 | `SimulatedPaperVenue` over the existing `PaperSimulator`. |
| `calendar.py` | F4 | NYSE sessions, holidays and early closes, by rule. |
| `exit_rule.py` | F4 | `decide_exit`: the owner standing rule of 2026-11-03. |
| `runner.py` | all | `PaperPath`: the stages in order, one `PathResult` per call. |

## F1: paper strategy

The strategy computes no signal. An intent (symbol, structure, expiry, strikes, net limit) comes from
the signal side. The strategy checks it against the approved request and sizes the order:
contracts = floor(`budgetPctOfAccount` % of the account / max loss of one contract), at most
`limits.maxOrderSize`.

Refusal codes: `mode_not_paper` (checked first), `request_not_approved`, `no_option_structure`,
`symbol_mismatch`, `sleeve_mismatch`, `structure_mismatch`, `expiry_outside_request`,
`max_loss_exceeded`, `sized_to_zero`, `multiplier_unsupported` (the contract multiplier must be 100).

The runner (`PaperPath.open`) adds four refusals of its own:

- `mode_not_paper`: a second check before the strategy runs.
- `signal_date_stale`: the signal date is after today (New York) or more than 5 calendar days old. The
  expiry window is measured from the signal date.
- `request_risk_exceeded`: the open max loss of all positions of one request plus the new order is above
  `maxLossPctOfAccount` (at most 2%) of the account.
- `max_position_exceeded`: the open contracts of one request plus the new order are above
  `limits.maxPosition`.

## F3: paper fill path, and the choice

Choice: the simulated venue first. The IBKR paper account is not used.

Evidence:

- No paper instance exists at IBKR for this system. There is one node and one gateway, both in live
  mode (engine-link design, 2026-11-11). A paper account needs a second gateway login.
- The repo already has a deterministic paper simulator with option legs
  (`services/execution/vertex_execution/simulator.py`). The venue is an adapter over it, not a second
  simulator.
- A simulated venue cannot touch a real account and has no gateway dependency.

What the simulated venue does not prove: real quotes and spreads, queue position, partial fills in a
real book, combo-book matching, assignment and exercise, IBKR margin and order rejections. The
rehearsal uses model quotes (study option model, mid plus and minus the model half-spread).

## F4: owner exit rule

`decide_exit` is a pure function. It reads no clock. Exit reason names are the same as in the go-live
draft queue.

- Expiry session: the last session on or before the expiry date.
- Exit time: the close minus 15 minutes. 15:45 ET, or 12:45 ET on an early-close day.
- `loser_3_trading_days_before_expiry`: one check, 3 sessions before the expiry session, at the exit
  time. A loss after the closing cost closes the spread. A missed check runs late and says so.
- `winner_expiry_day_1545_et`: on the expiry session at the exit time a spread with a leg in the money
  closes. Both legs out of the money: the spread expires, no order.
- `monthly_roll`: the monthly decision of the sleeve ended the position.

Differences to the research code (`qc_ports/allocation.py`): research counts 3 calendar days and uses
the daily close. The engine rule counts sessions and uses the clock.

## F5: deployment request with an options block

A request has a new optional field `options` (migration 0067, nullable column). Old requests stay
valid and readable.

```text
options: {
  structure: callDebitVertical | putDebitVertical | putCreditVertical | callCreditVertical,
  dte: {target, min},
  width: {unit: "sigma" | "price", value},
  anchorDelta,
  legs: [anchor, wing],
  budgetPctOfAccount,
  maxLossPctOfAccount,      // at most 2: enforced in the API, the repository, the database and python
  group: null | {key, symbols}
}
```

`POST /deployment-requests/group` makes one draft request per symbol, all or nothing, for a sleeve
that trades several ETFs (the rotation). The web form does not show the options block yet.

The request stays a record: `executionAuthorized: false`, `brokerSubmissionAllowed: false`,
`dispatch.state: "not-dispatched"`. Mode stays fixed to `paper`.

Deploy note: migration 0067 must run before the portal uses the new field. This job made no deploy.

## F6: the idle 1% of the vol-premium sleeve

`research/backtests/allocation/idle_budget.py` replays the funded pie with and without the move, over
the three rehearsal windows and the full history. The caps do not change (4% open risk, 2% per name,
at most 2% per position).

Result: the idle 1% stays in cash. Each move (to the rotation, to the long index, split) lowers the
Sharpe ratio and deepens the drawdown over the full history. The move helps only in rebound windows.
The script stays a research switch; the pie is unchanged.

## Rehearsal re-run

```text
python research/backtests/allocation/paper_path_rehearsal.py --data DIR --capital 360000 \
  --extra-window full-core7=2020-04-01:2020-09-30 --out FILE \
  [--policy-root DIR_WITH_ARM_GATE] [--spreads-decision OWNER_DECISION_LINK]
```

`--spreads-decision` sets the spreads switch of policy v3 in the environment of that process only.
Without it, or with policy v2, every combo stops at the policy with `combo_refused`.

## Limits

- The exit rule runs when a caller evaluates it. No scheduler exists yet.
- `limits.maxOrdersPerMinute`, `limits.dailyLossLimit` and the `group` are not enforced by the runner.
- The 4% open-risk cap over all requests is not enforced by the runner. The research allocation applies it
  before an intent exists.
- Fees are outside the max loss. One contract at exactly 2% costs slightly more than 2% with fees.
- A spread with both legs out of the money at the exit time leaves the book then, 15 minutes before the
  close. A move into the money in those minutes is not handled.
- A loser check with no fresh mark is skipped with a note, not an alert.
- The database check of migration 0067 is tested as text, not run on PostgreSQL in the unit tests. The
  API reads a stored options block without a second shape check.
- The position book is in memory.
- Contract ids are made up (`synthetic_con_id`). A real path needs qualified IBKR contracts.
