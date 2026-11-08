# Custom baskets

Updated: 2026-11-02. Tracking only. A basket is a private, named list of symbols with weights, shown as a price index ("fake ETF"). It places no order, creates no intent, holds no quantity and has no broker link.

## Purpose

An operator groups symbols into a basket, for example TITY = VSXY, ESTA and AVTR at equal weight. The portal shows the basket as one index line with a chart, a SPY comparison line and one row per member. Baskets also appear as rows on `/watchlist`.

## Parts

| Part | File |
| --- | --- |
| oRPC contract `baskets.list`, `.create`, `.update`, `.remove`, `.valuation` | `packages/api/src/contracts/baskets.ts` |
| Pure index math | `packages/api/src/basket-index.ts` |
| Procedures | `packages/api/src/server/baskets.ts` |
| History reads (one request at a time, short cache, per-view time budget) | `packages/api/src/server/basket-history.ts` |
| Tables `baskets`, `basket_members` and repository | `packages/db/src/schema/index.ts`, `packages/db/src/server/basket-repository.ts`, migrations `0041_baskets` and `0042_basket_benchmark_base`, rollbacks in `packages/db/rollback/` |
| Portal page `/baskets` and watchlist rows | `apps/web/src/app/(portal)/baskets/page.tsx`, `apps/web/src/components/portal/baskets-workspace.tsx`, `apps/web/src/components/portal/basket-watchlist-section.tsx` |
| Owner seed | `packages/db/src/server/basket-seed.ts`, `scripts/baskets/seed.ts`, `bun run vertex:baskets:seed` |

## Rules

- Every procedure is operator-only, and every query is scoped to the caller's user id. The navigation item and the watchlist rows are hidden from other users.
- A basket symbol matches `^[A-Z][A-Z0-9]{0,9}$` and is unique per owner. A name has 1 to 80 characters. A basket has at most 50 members.
- Member weights are greater than 0, at most 1, and sum to exactly 1 (checked in integer arithmetic).
- When the migration runs as a role other than the app role, it grants the app role `vertex_research` (if it exists) `SELECT, INSERT, UPDATE, DELETE` on both tables, as `0039_app_role_grants` does for older tables.
- The rollbacks refuse to run while they would discard data: `0041` while either table has rows, `0042` while any basket has a stored benchmark base price.

## Index

- `value(t) = sum(w_i * price_i(t) / price_i(base)) * baseValue`. `baseValue` defaults to 100.
- Prices are IBKR daily closes (1 year, regular trading hours) from the history service (`VERTEX_HISTORY_URL`).
- The base is fixed at the first full New York session close after the membership start (the same day if the membership started before 09:30). Before that the index is provisional. A member change clears the base. A rename keeps it.
- A date where a member close or a member base price is missing is stale: its value is `null`, never zero. Symbols whose history read failed or was deferred are listed in `unavailable`.
- SPY is normalized to the same base date as the benchmark line. The SPY close on the base date is stored with the base (`baskets.benchmark_base_price`), so the line stays after the base date leaves the one-year window (the history service allows at most 365 days of daily bars). A base fixed before `0042` gets this price at its next valuation while its base date is still in the window.
- The day change compares the latest value with the session just before it. If that session is stale, the day change is `null`.
- If a member change happens while a valuation is fixing the base, the base is not stored and the response reports `provisional`.

## History pacing

The history service allows about 6 requests per 120 s, at least 10 s apart, and waits at most 20 s. A valuation therefore:

- sends at most one history request at a time in the web process, also across concurrent valuations;
- reuses a successful result for 10 minutes and a failed one for 1 minute;
- requests SPY and never-loaded symbols first;
- starts no new request after 15 s and lists the rest as deferred ("History request deferred for IBKR pacing; reload in a minute"), or uses their last good closes (at most 24 h old).

A cold 21-member basket fills in over a few loads. The cache is in memory only, so a restart of vertex-web starts cold; the history service keeps its own disk cache.

## Seed

The owner's baskets (TITY and the "unique winners" tiers UW10Y, UW5Y, UW2Y, UW1Y) live in Postgres; production has every basket and member (checked 2026-11-08). The seed file is no longer in the repository (AGENTS.md rule 13): pass a private seed file to the command. The seed matches baskets by symbol and never changes an existing basket, so a rerun is safe.

```sh
DATABASE_URL=... VERTEX_BASKET_OWNER_EMAIL=... bun run vertex:baskets:seed -- /path/to/baskets.json --dry-run
```

## Known limits

- The seed matches baskets by symbol, so a ticker change (for example VSCO to VSXY on 2026-06-02) needs a member edit on existing baskets. A member whose ticker IBKR does not know is listed under "History unavailable" and the index stays empty. A seed basket that exists but is not in the first 200 listed baskets is skipped when its create conflicts.
