# Leveraged ETF share fallback: proposed order-policy change (not applied)

Status: proposal only. No file of the live order gate is changed by this document or by the work of card
`vertex-leveraged-etf-options`. No order is placed. Nautilus stays disarmed. The change needs an owner decision first.

## Why

Owner rule of 2026-11-11: leveraged ETFs (2x, 3x, any leverage) are allowed for 24 to 48 hour windows. Options on them
come first. Shares are a fallback for a fund whose options are too thin, as a temporary holding. The 2% max-loss gate of
2026-11-02 stays: a share position can lose its whole value and a stop does not cover a gap, so the whole share position
is at most 2% of the account.

Every order layer refuses a new share buy today:

| Layer | Where | Today |
| --- | --- | --- |
| A, exec node | `infra/quant-vps/exec-node/runtime/nautilus/arm_gate.py`, policy `options_only_defined_risk_v2` | refuses with `new_share_buy` |
| B, Vertex order screen | `packages/api/src/server/vertex-orders-rules.ts`, `final-order-gate.ts` | shares can only be closed or reduced |
| C, order bridge (repository market-watch-bot) | `ops/ibkr_reentry_gateway.py` (`OPTIONS_ONLY`), `ops/max_loss_gate.py` | every share entry aborts |

Which fund needs the fallback is a fact in Postgres: table `leveraged_etf_universe`, column `option_gate`
([leveraged-etf-universe.md](../../vertex-rebuild/leveraged-etf-universe.md)). `fail` = the options are too thin for the
window. `pass` = trade options, no shares. `spread-not-measured` = undecided until a chain is read during the session.

## Proposed rules (exec node, layer A)

One new allowance, `leveraged_share_open`. Everything else of the policy stays: combos, option rules, closes, the
snapshot rules, arming and the kill switch. A BUY of shares is allowed only when all rules hold.

| # | Rule | Value |
| --- | --- | --- |
| 0 | Switch | `NAUTILUS_ORDER_POLICY_ALLOW_LEVERAGED_SHARES` is on only with the value `owner-decision:<link to the owner's message>`. Off is the default and equals today's behavior. No environment value arms the node. |
| 1 | Allow-list | `NAUTILUS_ORDER_POLICY_LEVERAGED_SHARE_SYMBOLS`: explicit tickers, copied from `leveraged_etf_universe` rows with `option_gate = 'fail'` that the owner approved. An invalid entry refuses every leveraged share buy. |
| 2 | Order form | Limit order, day order, USD, sized by share count. |
| 3 | Size cap | Share count x limit price is at most 2% of the account value (the setting of the option cap; it can only be lowered). |
| 4 | No adding | One open per fund. A second buy of a fund that has an open record or a held position is refused. Averaging down is not possible. |
| 5 | Count cap | At most 3 funds at one time, so at most 6% of the account in share fallbacks. |
| 6 | Time box | 48 hours from the first order. The gate keeps one record per fund with the open time. While any fund is held longer than 48 hours, every new leveraged share buy is refused. A held fund without a record counts as overdue. Closes are never blocked. |
| 7 | Record end | A record ends when IBKR reported the order final and a later snapshot shows no position, when the position was closed through the gate, or when the owner releases it with an audited command. It never ends by time alone. |

The gate does not sell. The exec node has no trade-intent source (owner 2026-11-04), so the time box blocks new buys and
reports the overdue funds; it does not close them. An automatic exit after 48 hours is a separate owner decision.

## Proof that the rules can be built

The rules were written as code and tested in a scratch copy of `infra/quant-vps/exec-node` on the rig, against policy v2
(repository commit `342f20ef`). Nothing in the repository was changed.

- `test_order_policy.py`: 106 tests before, 155 after (49 new). No existing assertion was changed. The other four
  exec-node suites pass unchanged.
- With the switch off, every existing test passes unchanged: the default equals today's behavior.
- The patch (1806 lines) and the full engineering report are in the rig reports directory `vertex-leveraged-etf/gate/`
  (`leveraged-share-fallback.patch`, `gate-report.md`). `git apply --check` passes on commit `342f20ef`.

## What a real change needs after an owner approval

1. Layer A: rebase the patch on policy v3 (defined-risk vertical spreads, card `vertex-golive-spread-gate`). v3 brings an
   open-risk ledger, a per-name cap and a total risk cap. The share notional is the position's maximum loss, so it must
   count in that ledger; the ledger then replaces the size bookkeeping of this patch. The open time, the overdue rule,
   the count cap and the allow-list stay.
2. Layer A deploy: a changed `arm_gate.py` changes the image version. After the rebuild the node is disarmed until the
   owner arms it again.
3. Layer B: `evaluateOrder` sends every share order to `evaluateShareClose`; `classifyStructure` refuses every leg that is
   not an option. Both need the share open with the same rules, and the 2% check on the whole position.
4. Layer C (market-watch-bot): `OPTIONS_ONLY` aborts every share entry, and `stock_max_loss` counts only the distance to
   a stop. For this exception the maximum loss must be the full position value.
5. One owner of the open time. Owner orders go from layer B to layer C today, not through the exec node. A share
   position opened there has no record in layer A.

## Open risks

- Orders placed outside the gate (TWS, the bridge path) are not visible to the exec node. Such a position counts as
  overdue in layer A and has no time box in layers B and C until they carry the same rules.
- No exit and no alert: 48 hours only refuses new share buys. Nothing publishes the overdue list yet.
- The records depend on order statuses that the gate sees in its own process. A day order that expires while the client
  is disconnected keeps its record until the owner releases it. Three such records lock the allowance. The lasting fix is
  IBKR open orders in the account snapshot.
- After a close, the same fund can be bought again at once with a new 48 hour clock.
- The allow-list is copied by hand from the table.
- Shares and options are capped apart: 2% in shares of a fund and 2% in options on the same fund are both allowed.

## Owner decision

The proposal was sent to the owner as one menu. This section records the answer when it arrives.
