# Pick-list portfolio construction (design)

Updated: 2026-11-05. Status: **design only**. Nothing in this document is implemented as an order path. Card `vertex-moby-propicks`.

This design describes how the buckets built from pick lists ([pick lists](pick-lists.md)) could be traded as one options book of more than 100 positions. It is a separate strategy from the futures scalping engines. Every number below is a proposal for the owner. A pick, a gate result or a rotation quadrant never authorizes a trade. Live trading, arming and risk settings stay owner decisions.

## Fixed owner rules (apply to every position)

| Rule | Source | Effect here |
| --- | --- | --- |
| Options only; no new shares, long or short | Owner 2026-10-16, 2026-11-04 | Every bucket member is expressed as an option structure. |
| Defined risk always; no naked short options | Owner 2026-11-04 | Allowed: long calls or puts, debit spreads, defined-width credit spreads. |
| Max possible loss of a new position at most 2% of account value (NLV) | Owner 2026-11-02 | The size of each structure is capped by its max loss, per position. |
| Premium cap per name: 6% NLV for LEAPS (expiry at least 365 days at entry), 2% NLV for shorter options, including premium already open in that name | Owner 2026-10-22 | Several positions in one name share one cap. The 2% max-loss gate above also applies: the max loss of a long LEAPS call is its whole premium, so one NEW LEAPS position may cost at most 2% NLV. The 6% cap limits the total LEAPS premium open in one name across several positions. |
| Exits: a winner may run to expiry; a loser closes 3 trading days before expiry; open winners close at 15:45 ET on expiry day (never exercise) | Owner 2026-11-03 | The exit ladder below respects these dates. |
| Vertex enforces the max-loss and options-only gates in `packages/api/src/server/vertex-orders-rules.ts` | Code | Any later order path reuses these checks; it never adds a parallel gate. |

## Book shape

- Buckets: one per Moby list, one per ProPicks strategy, one for the owner's wish list. A symbol in several buckets is one name for caps (premium and max loss add up across buckets).
- Target size: 100 to 150 open positions. A position is one structure (a single long option or one spread). One name may hold up to 3 structures (for example one LEAPS call plus one shorter call debit spread).
- Risk budget, proposed: total max loss of the book at most 40% of NLV; one bucket at most 10% of NLV; one sector (by sector ETF) at most 15% of NLV. With 120 positions at an average max loss of 0.3% NLV the book's total max loss is 36% NLV.
- Default structure per member, proposed:

| Situation | Structure | Expiry | Strikes |
| --- | --- | --- | --- |
| Screen pass and sector quadrant leading or improving | Call debit spread | 90 to 180 days | Long about 0.60 delta, short about 0.30 delta |
| Screen pass, long-horizon conviction (wish list, multi-month picks) | LEAPS call (or LEAPS call debit spread when premium is high) | At least 365 days | Long about 0.70 delta |
| Screen fail or unknown | No entry; watch only | - | - |
| Sector quadrant weakening or lagging | Half size, or wait for improving | - | - |

Bearish structures (put debit spreads) are only for a separate hedge sleeve; pick lists are long ideas.

## Smoothed (stepped) entries and exits

Entries come in tranches so one bad fill or one bad day does not set the whole position:

1. Tranche 1 (40% of target size) when the member first passes the screen.
2. Tranche 2 (30%) after 5 trading days if the screen still passes and the price is not more than 1 ATR14 above tranche 1.
3. Tranche 3 (30%) after a further 5 trading days with the same check, or on a pullback to EMA20 that keeps the trend gate.

Exits come in tranches too:

- Profit steps: close one third at +50% of max gain of a debit spread, one third at +75%, and let the rest run under the owner exit rule.
- Rotation step: when the sector quadrant moves to lagging, close one half at the next rebalance.
- Source step: when a member leaves its source list, stop adding; close at the next rebalance unless the member is also in another bucket.
- Loss rule: the owner's 3-trading-days-before-expiry close applies to the whole position.

## Rebalancing with the sector rotation map

- Weekly rebalance after the Friday close, never intraday. Input: the latest daily quadrant per sector ETF from `sectorRotation.snapshot` and the latest screen per bucket member.
- Bucket weights shift toward members whose sector is leading or improving: proposed multipliers leading 1.25, improving 1.0, weakening 0.75, lagging 0.5, then renormalized inside the bucket's 10% cap.
- A rebalance only acts when the target size of a position differs from the current size by more than 25% (a no-trade band). This keeps turnover low.

## Fee and cost model

Costs per round trip of one contract, proposed defaults (to be calibrated with the backtest cost profiles in `packages/api/src/contracts/backtest-cost-profiles.ts`):

| Cost | Default | Note |
| --- | --- | --- |
| Commission | USD 0.65 per contract per side, minimum USD 1.00 per order | IBKR tiered schedule estimate; regulatory and exchange fees add about USD 0.05 per contract. |
| Spread cost | Half the bid-ask spread per leg, per side, times 100 | A debit spread has two legs, so it pays four half-spreads per round trip. |
| Slippage buffer | 1% of premium per side | For limit orders filled away from the mid. |

Rules that keep fees affordable:

- Skip a structure whose estimated round-trip cost is more than 8% of its max gain.
- Skip options with a bid-ask spread above 10% of the mid, or open interest below 500 per leg.
- Batch the weekly rebalance into one session; use one combo order per spread (one commission minimum).
- Budget: total annual cost at most 3% of NLV. At 120 positions, 3 tranches in and 2 tranches out, 2 legs, about 5 contracts per tranche: 120 × 5 × 2 × 5 × 0.70 ≈ USD 4,200 commissions per year before spread costs. Size this against the account's NLV before going live.

## What exists and what does not

| Part | State |
| --- | --- |
| Pick lists, buckets, daily screen, rotation quadrants | Implemented ([pick lists](pick-lists.md)). |
| Max-loss and options-only gates for new positions | Implemented in the Vertex order rules; reused, never duplicated. |
| Option-chain selection (delta, liquidity filters) | Not implemented. Needs the options analytics contract and a chain source. |
| Tranche scheduler, rebalance job, cost estimator | Not implemented. Each needs its own card, tests and an owner decision before any order path. |
| Backtest of this book | Not done. Required before any paper or live use. |
