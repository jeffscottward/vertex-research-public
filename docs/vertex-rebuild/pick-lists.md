# Pick lists

Updated: 2026-11-05. Research only. A pick list is a dated snapshot of an external stock-pick list (a newsletter's picks, a strategy's holdings, the owner's wish list), stored with provenance on every row. A list can become a bucket (an equal-weight basket), a daily screen reports trend gates and rotation quadrants per member, and a read-only buy proposal suggests one defined-risk option structure per bucket member. No procedure places an order, creates an intent or touches a broker; a pick, a passing gate or a quadrant never authorizes a trade.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `pickLists.import`, `.list`, `.proposal`, `.screen`, `.syncBucket` | `packages/api/src/contracts/pick-lists.ts` |
| Procedures | `packages/api/src/server/pick-lists.ts` |
| Pure screen math (gates, sector ETF map, quadrants) | `packages/api/src/pick-list-screen.ts` |
| Pure buy-proposal math (tier, size, call debit spread estimate) | `packages/api/src/pick-list-proposal.ts` |
| Data-source port, registry and adapters | `packages/api/src/pick-list-sources.ts` |
| Tables `pick_lists`, `pick_list_snapshots`, `pick_list_members` and repository | `packages/db/src/schema/index.ts`, `packages/db/src/server/pick-list-repository.ts`, migration `0048_pick_lists`, rollback in `packages/db/rollback/` |
| Portal page `/pick-lists` | `apps/web/src/app/(portal)/pick-lists/page.tsx`, `apps/web/src/components/portal/pick-lists-workspace.tsx`, `apps/web/src/components/portal/pick-list-proposal-panel.tsx` |
| Importer | `scripts/pick-lists/import.ts`, `scripts/vertex-pick-lists.ts`, `bun run vertex:pick-lists` |

## Provenance

- A list is identified per owner by `(source, slug)`. `source` is a slug (for example `wishlist`); `sourceLabel` and `name` are display text. Vendor names are data, never code.
- Each import stores one snapshot `(list, asOf)` with its `method` (`manual` for a file a person prepared, `adapter` for a source adapter) and `importedAt`. Importing the same date again replaces that snapshot; other dates are kept. Lists show their latest snapshot (newest `asOf`) and the snapshot count.
- A member row keeps the source's symbol, rank, weight (fraction 0-1, stored with up to 8 decimals), sector, rating, thesis, target price (up to 4 decimals) and the date the source added it. A snapshot holds 1 to 200 unique symbols.

## Access

- Every procedure is operator-only and scoped to the caller's user id. One exception: the read-only agent viewer (`VERTEX_AGENT_VIEWER_EMAILS`) has no lists of its own, so `pickLists.proposal` reads the buckets of the operator accounts (`VERTEX_OPERATOR_EMAILS`) for it (owner decision 2026-11-05, card vertex-bucket-buy-proposal). The viewer still cannot call any write procedure, and an API key always reads its owner's buckets.
- Agent keys: `pickLists.import` needs a write key (the importer); `pickLists.list`, `pickLists.proposal` and `pickLists.screen` accept a read key. `pickLists.syncBucket` is session-only, so a key never edits baskets.

## Buckets

`pickLists.syncBucket { id, bucketSymbol }` turns the latest snapshot into a basket:

- Members are ordered by rank (unranked last), then symbol. The first 50 (the basket limit) are kept at equal weights (`equalBasketWeights`); the rest are returned as `omitted`. Source weights are kept on the snapshot but not used.
- Ownership is by basket id: the list records the symbol and the id of the basket it created (`bucket_basket_id`, cleared when that basket is deleted). An existing basket with the requested symbol is updated only when it is that basket: its members and name are replaced (which clears its fixed base; see [baskets.md](baskets.md)). Any other basket with the symbol is a `CONFLICT`, even when the list once used the symbol (for example after its bucket was deleted and another list took the symbol). A missing bucket is created again.
- When the list cannot record a basket this call created (storage error, or the list was deleted meanwhile), the new basket is removed again (best effort) and the error is returned, so a retry does not meet its own orphan as a `CONFLICT`.
- The portal links to `/baskets?symbol=<symbol>`.

## Screen

`pickLists.screen { id }` reads one year of public Yahoo daily bars (unadjusted OHLCV, range `1y`, interval `1d`) for the first 60 members of the latest snapshot (`PICK_LIST_SCREEN_MAX_MEMBERS`; rank order, unranked last, then symbol), SPY and those members' sector ETFs: four requests at a time, 10-second timeout, 4 MiB cap, and a 10-minute in-process cache per symbol (at most 400 symbols; failures are not cached). Further members are returned with status `unknown`, gates `null` and the reason "Not screened: first 60 members per run".

The newest bar is dropped while its session is still running, so every gate uses completed daily bars. After the session Yahoo can leave the newest close empty for some hours; when its open, high and low exist, the quote price (`regularMarketPrice`) fills the close (as in sector rotation).

| Gate | Passes when | Needs |
| --- | --- | --- |
| `emaTrend` | close > EMA20 and EMA20 > EMA50 | 50 bars |
| `aboveVwap20` | close ≥ 20-day VWAP, VWAP = Σ(typical × volume) ÷ Σ volume, typical = (high + low + close) ÷ 3 | 20 bars; `null` when their total volume is 0 |
| `notOverextended` | close ≤ EMA20 + 2 × ATR14 | 20 bars |

- EMAs use alpha = 2 ÷ (span + 1), seeded with the first close. ATR14 is Wilder's average true range: the first value is the mean of the first 14 true ranges, then ATR = (13 × ATR + TR) ÷ 14.
- A gate with too little history is `null` ("not enough history"). Each gate's `detail` gives the numbers to 2 decimals.
- Status: `unknown` when bars are missing or any gate is `null`; `pass` when every gate holds; otherwise `fail`. `reason` explains missing bars.
- `quadrant` is the member's latest daily rotation quadrant against SPY, and `sectorQuadrant` the same for its sector ETF, both from the sector rotation formula with the daily parameters ([sector-rotation.md](sector-rotation.md)) on the same unadjusted closes as the gates (the sector rotation map uses adjusted closes, so a quadrant can differ around dividends). Either is `null` when the history is shorter than the warm-up or SPY could not be read; the gates are still computed.
- The sector ETF comes from the member's sector name, case-insensitive: Technology, Information Technology, Tech → XLK; Health Care, Healthcare → XLV; Consumer Discretionary, Consumer Cyclical → XLY; Consumer Staples, Consumer Defensive → XLP; Materials, Basic Materials → XLB; Communication Services, Communications, Communication, Telecommunications → XLC; Financials, Financial Services, Financial, Finance → XLF; Industrials, Industrial → XLI; Energy → XLE; Utilities → XLU; Real Estate → XLRE. Other names have no sector ETF.

## Buy proposal

`pickLists.proposal {}` builds a proposal from every list that has a bucket. Proposal only: the procedure has no order path, and the "Buy proposal" table on `/pick-lists` has no order control (its only button refreshes the proposal). A proposal never authorizes a trade; trading stays an owner decision.

- Members: each bucket basket's members (what `/baskets` shows; a re-import changes them only after Make or Refresh bucket; a list whose bucket basket was deleted has no bucket), merged across buckets into one row per symbol that lists every bucket holding it. The first 60 symbols (`PICK_LIST_SCREEN_MAX_MEMBERS`) are screened with the same bars, gates and quadrants as `pickLists.screen`; the rest are returned in `notProposed`.
- Tier and size (max loss as % NLV): `full` 0.50% when all 3 gates pass and the sector ETF quadrant (without a sector ETF: the member's own quadrant) is leading or improving; `half` 0.25% when all gates pass otherwise; `none` (watch only) when a gate fails or data is missing. Each size is also capped by the owner's max-loss gate (2% NLV per new position, owner 2026-11-02; the same constant as the order rules) and the premium cap per name for options under 365 DTE (`OWNER_RISK_CAPS.shortPremiumPct`).
- Structure: a call debit spread (defined risk: the max loss is the debit) on the first monthly expiry (third Friday) at least 120 DTE, inside the 90-180 DTE window; long the ~0.60 delta call, short the ~0.30 delta call. Strikes solve the Black-Scholes delta and are rounded to a typical strike spacing (0.5 below $25, 1 below $100, 2.5 below $250, else 5).
- Estimates: Black-Scholes without dividends, r = 4%, σ = annualized realized volatility of up to 252 daily log returns (needs 60; below 0.01% counts as flat, no estimate). DTE counts from the New York calendar date. Each row gives the estimated debit per share, the max loss and max profit per spread, and notes (why, and entry in 3 tranches 40/30/30). Live quotes, skew and dividends differ; strikes and expiry are picked from the live chain at entry.
- The page accepts an optional NLV that stays in the browser tab. It converts % NLV into dollars and a whole-spread count; it is never sent to the server.

## Sources and import

A source implements the port `PickListSource { id, label, load(): Promise<PickListImportInput[]> }`; `createPickListSourceRegistry` selects one by id and rejects duplicate ids. Adapters take their reader by injection:

- `json` (`jsonFileSource`): a document `{ source, sourceLabel, lists: [{ slug, name, asOf?, members }] }` or one `pickLists.import` body. Every snapshot is validated with the contract schema; the method is always `manual`.
- `wishlist` (`wishlistTomlSource`): the owner's wish-list TOML (repeated `[[symbol]]` tables with `symbol`, `enabled`, `note`). Enabled symbols only (a missing `enabled` counts as enabled); the note becomes the thesis; budgets are not imported. One list: source `wishlist`, label "Owner wish list", slug `wishlist`, name "Wish list".

```sh
VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
  bun run vertex:pick-lists -- import --adapter json|wishlist --file <path> [--as-of YYYY-MM-DD] [--dry-run]
```

- `--as-of` dates the wish-list snapshot (default: today in New York) and fills JSON lists without a date.
- Each snapshot is posted to `/api/orpc/pickLists/import` with the operator agent write key in `x-api-key`. The key is never printed.
- `--dry-run` prints the validated snapshots and sends nothing (no settings needed).
- Exit codes: 0 success, 2 usage error, 1 any other failure.

## Data sources and design

- [Moby stock picks](data-sources/moby.md): field mapping, terms of use, refresh and failure modes.
- [Investing.com ProPicks strategies](data-sources/investing-propicks.md): field mapping, terms of use, refresh and failure modes.
- [Portfolio construction design](pick-list-portfolio-construction.md): options-only, defined-risk book of more than 100 positions, stepped entries and exits, fee model (design only).
