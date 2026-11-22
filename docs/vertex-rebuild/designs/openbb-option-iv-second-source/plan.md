# Plan: a second source for the Core 7 option IV snapshot while Cboe blocks the delayed-quotes path

![Before and after. Before: Cboe answers HTTP 403; the Core 7 IV panel shows a blocked notice and old rows. After: the job reads every listed expiration from Yahoo through the pinned yfinance client and computes delta and gamma with Black-Scholes. It writes the same two tables and names the source in the run warning and on the panel.](plan-overview.png)

- Card: `vertex-openbb-option-iv-fallback` (feature, follow-up of `vertex-openbb-cboe-403`; the
  predecessor plan listed this as a non-goal:
  `docs/vertex-rebuild/designs/openbb-blocked-upstream/plan.md`).
- Baseline: commit `3a9a353d` on `vertex/rebuild-darkfactory-20260921`. Every "today" statement
  below describes that commit.
- Scope: research data only. This change touches no order, execution, arming or risk path. It adds
  no paid source and no new cost. The task file's rig rule reads: "no Tailscale exit node on the
  rig; no proxy or browser impersonation to pass the Cboe block." This plan obeys it: nothing here
  targets the Cboe block; the second source is a different host (Yahoo).
- Review: nine EGM goldfish reviewers (consolidated full flow). Findings and resolutions:
  `consolidated_review_report.md`, `goldfish_review_report.md` (this revision applies every
  PROPOSE FIX).

## Problem Statement

Checked again on 2026-11-21 from the rig:

- `https://cdn-api.cboe.com/api/global/delayed_quotes/options/SPY.json` still answers HTTP 403
  (Cloudflare block page). The job `cboe-option-iv` (SPY QQQ DIA IWM GLD SLV USO) therefore records
  `blocked_upstream` runs and writes no rows to `openbb_option_iv_daily` / `openbb_option_iv_term`.
  The Markets panel "Core 7 implied volatility" shows the blocked notice above the rows of the last
  good run (session 2026-11-19).
- The job needs, per contract of every expiration: implied volatility, delta, gamma, open interest
  and volume (`services/openbb/vertex_openbb/options_math.py`). Delta drives the 25-delta IV; gamma
  and open interest drive net GEX, the gamma flip and the walls.
- The block's duration is unknown (active since at least 2026-11-19). The IV percentile needs a
  continuous daily history; every blocked day is a hole in it.

## Terms

- **The rig**: the owner's dedicated Linux research/ingest host (`omarchy-rig`), where
  `vertex-openbb.service` runs. Setup: `infra/openbb/rig/install.sh`.
- **Card**: a work item in the FIRSTMATE tracker (`fm` CLI,
  `~/Documents/reports/web/firstmate/items.json` on the rig). The card text is the task file
  `~/Documents/reports/web/firstmate/tasks/vertex-openbb-option-iv-fallback-task.md`.
- **Core 7**: the seven ETFs SPY, QQQ, DIA, IWM, GLD, SLV, USO (`CORE7` in the fetcher).
- **Chain**: the list of every option contract of one underlying, all expirations, calls and puts.
- **Snapshot**: one `cboe-option-iv` run: the chains of the Core 7 at run time, reduced to one
  `option_iv_daily` row and one `option_iv_term` row per expiration per symbol.
- **Table names**: the fetcher writes the document tables `option_iv_daily` / `option_iv_term`;
  the database tables are `openbb_option_iv_daily` / `openbb_option_iv_term`. Each name is used
  only in its own layer below.
- **Fetcher document**: the JSON the fetcher prints on stdout (`openbb-batch.v1`): `job`,
  `schemaVersion`, `openbbVersion`, `tables` (rows per table), `warnings` (string array), and
  `blocked` (`{host, httpStatus}` only when every source was refused by its host). The tick client
  validates it, writes the rows, and records the run.
- **Tick client / run ledger / step**: `scripts/openbb/tick.ts` runs one job, posts the document
  through `openbb.ingest`, and records the run (status, warnings, row counts, start/finish times)
  through `openbb.recordRun` into the run ledger (Postgres). Run statuses: `ok` (no warnings),
  `partial` (warnings, at least one source ok), `failed`, `blocked_upstream` (every source refused;
  the document's `blocked` key is set). A step is one line of `infra/openbb/rig/vertex-openbb.steps`
  (name, timeout, interval, stage, command); tick-runner executes steps. The tick's blocked backoff
  (1 h after the first blocked run, then 6 h) and the 7-day escalation apply only to
  `blocked_upstream` streaks.
- **CFE fallback precedent**: `cboe-vx-curve` already has a second source: when the Cboe curve call
  fails (any failure except `empty`), `_settlement_fallback`
  (`services/openbb/vertex_openbb/jobs/cboe.py`) reads the CFE (Cboe Futures Exchange) daily
  settlement file, writes the rows, and adds a warning with the fixed marker
  `CFE_FALLBACK_NOTE = "used the CFE settlement file"`; the run becomes `partial`. This plan copies
  that pattern.
- **Run warning**: a string in the document's `warnings` array; the tick stores it with the run and
  `openbb.status` returns it to the Markets page.
- **Vertex portal / `optionsChain` / Quant Data**: Vertex is this repository's web app
  (`apps/web` + `packages/api`). `optionsChain` is its read-only options-chain API
  (`packages/api/src/contracts/options-chain.ts`), merged from Quant Data (the paid options-data
  vendor, first source), IBKR live quotes, and Yahoo. Its greeks are computed by
  `packages/api/src/options-chain-greeks.ts` (Black-Scholes-Merton).
- **Yahoo IV column**: the `impliedVolatility` field Yahoo sends per contract. It is Yahoo's own
  model output; the call and the put at one strike can carry different values.
- **BSM greeks**: delta and gamma computed from the Black-Scholes-Merton formula with a continuous
  dividend yield, the same formula and rate as `optionsChain` (see the method section for the one
  convention that differs).
- **OCC symbol**: the Options Clearing Corporation contract symbol, for example
  `SPY261124C00734000`; parsed by `options_math.OCC`.
- **GEX / gamma flip / walls**: net GEX = Σ gamma·OI·100·S²·0.01 (dollars per 1% move, calls
  positive, puts negative); the gamma flip is the strike where cumulative net GEX changes sign;
  the call/put wall is the strike with the largest call/put gamma·OI
  (`options_math.summarize` docstring).
- **Vol point**: 1 vol point = 0.01 of decimal IV (1 percentage point of implied volatility).
- **Record → trim → replay harness**: `services/openbb/tests/record.py` runs a job live with
  `RecordingUpstream` (every upstream call and result kept), trims the payloads (still real data),
  and writes `tests/fixtures/upstream/<job>.json` (input) and `tests/fixtures/<job>.json` (expected
  document). Tests replay with `ReplayUpstream`, which answers from the recording and raises on an
  unrecorded call; no test touches the network. A "helper call" is `ctx.up.helper(key, func)`: one
  recorded upstream unit whose key is `helper:<key>`.
- **Job context API**: `ctx.warn(text)` adds a warning; `ctx.failed(source, error)` counts the
  source failed and warns the error's message (a `blocked`-kind error also records host+status);
  `ctx.take(source, data, build, sink)` builds rows and counts the source ok only when `build`
  succeeds — one bad payload never drops the other sources (`context.py`).
- **Agent viewer account**: the read-only portal account for agent live checks
  (`~/.config/vertex/agent-viewer.env`, mode 0600); headless Chrome on the rig signs in with it
  (pattern: `~/Github/tools/vertex-shot/vertex-technicals.mjs`). Never JEV for portal pages.

## Goals & Non-Goals

Goals (requirements of the card):

1. When every Cboe chain of the run is blocked, the job reads a free second source, writes the same
   two tables, and the run has a warning that names the source (the CFE fallback pattern).
2. The Markets panel names the source while the newest run used it, and shows no source note when
   Cboe works again.
3. The request count and the load are stated and bounded: no load on the IBKR gateway, no Quant
   Data quota spend.
4. The plan states how the values differ from the Cboe series and how a source change is marked so
   the stored history (IV percentile) stays interpretable.
5. Tests replay recorded real payloads; no test touches the network.

Non-goals:

- No change to the Cboe path itself, to `cboe-vol-indices` or `cboe-vx-curve`.
- No new paid data source; no Quant Data quota spend from the ingest job; no IBKR gateway request.
- No proxy, exit node or browser impersonation to pass the Cboe block (the task file's rig rule,
  quoted above). The Yahoo client below is the pinned `yfinance` library the rig already runs
  twice per trading day for `infra/option-chain`; it targets Yahoo, not Cboe.
- No backfill of the blocked days: Yahoo only serves the current chain, so the holes between the
  last Cboe row and the first fallback row stay holes.
- No schema change to `openbb_option_iv_daily` / `openbb_option_iv_term`.
- No new IV method: the Yahoo IV column is used as sent (with the sentinel floor below); the
  composite parity-mid refinement is recorded in Alternatives Considered, not built.

## Source choice

Measured live from the rig on 2026-11-21 (Saturday; quotes of the Friday 2026-11-20 close). The
canonical rejection list with full rationales is Alternatives Considered below; this table only
compares the candidates.

| Candidate | Fields it gives | Cost and load | Verdict |
| --- | --- | --- | --- |
| Vertex `optionsChain` read (Quant Data first) | IV, delta, OI, order-flow aggregates; greeks computed by the merge | Paid quota shared with the portal; 179 expiration reads through the web API per snapshot | Rejected — Alternatives #1 |
| Vertex `optionsChain` read (IBKR quotes) | bid/ask only | Loads the IBKR gateway; target is none | Rejected — Alternatives #2 |
| Raw Yahoo v7 endpoint with `requests` | same payload as yfinance | Measured HTTP 429 from the rig on 2026-11-21 | Rejected — Alternatives #3 |
| `openbb-yfinance` provider | yfinance through OpenBB | Requires yfinance>=1.3 (conflicts with the proven 0.2.66 pin) plus GUI/router packages the lock excludes | Rejected — Alternatives #4 |
| Read the stored `infra/option-chain` CSVs | monthly expirations 30–75 DTE only | No full chain; local data directory the app must not read | Rejected — Alternatives #5 |
| Yahoo through the pinned `yfinance` client | IV column, strike, expiration (OCC symbol), OI, volume, spot, dividend yield, quote time | Free public endpoint; 179 HTTP requests per full snapshot; delta and gamma computed locally (BSM) | **Chosen** |

The chosen client is `yfinance==0.2.66`, the exact pin `infra/option-chain/vertex-option-chain-run`
already runs on this rig twice per trading day (its 2026-11-20 runs completed for all 7 symbols).
It talks to `query2.finance.yahoo.com` through `curl_cffi` with Chrome TLS impersonation
(`yfinance/data.py:81`) — the same access the owner's option-chain timer already uses, against
Yahoo, not against the Cboe block.

Measured full-snapshot numbers (2026-11-21, one pass over all 7 symbols, every listed expiration,
the fetch sequence of the Architecture section, 0.1 s spacing between expiration requests):

| Symbol | Expirations | Contracts (sent) | Fetch time |
| --- | --- | --- | --- |
| SPY | 30 | 9,930 | 5.4 s |
| QQQ | 29 | 8,689 | 3.2 s |
| DIA | 18 | 2,857 | 1.9 s |
| IWM | 29 | 3,508 | 2.5 s |
| GLD | 26 | 5,283 | 2.4 s |
| SLV | 25 | 3,909 | 1.8 s |
| USO | 22 | 4,505 | 1.5 s |
| **Total** | **179** | **38,681** | **≈20 s** (sum 18.7 s; 30.7 s with 0.1 s spacing, second pass) |

The second pass (with spacing and the sentinel floor) read 40,057 contract rows including 0-DTE
and dropped 4,793 sentinel IVs (12%); the first pass counted 38,681 rows after yfinance's own
frame shaping. Both passes are one sample each; the table's per-symbol counts are from the first
pass.

Request count per snapshot: `t.option_chain()` (no date) returns the quote, the expiration list
and the first expiration's chain in one request; then one request per remaining expiration =
179 requests total (measured). The public `.options` property would discard the first chain and
cost 186; the fetch sequence below avoids it.

Load bound: the job's window is `mon-fri@16:20-21:00` (New York; `infra/openbb/rig/vertex-openbb.steps`),
5 hourly slots. A successful fallback run is `partial`, so the blocked backoff does not apply;
without a guard every slot would re-fetch the full snapshot (≤ 895 requests/day). The
once-per-session guard (Architecture) cuts the steady state to one full snapshot plus 4 Cboe-only
probe runs ≈ 207 requests/day. When all sources fail, the run is `blocked_upstream` and the tick
backoff (1 h, then 6 h) reduces the count further. For scale: the research snapshot sends ~14
chain requests per run (7 symbols × 1 expiration), twice per trading day — the fallback's
full-chain burst is larger than that proven pattern, and its tolerance is unproven beyond the two
measured passes; the spacing, the session guard and the blocked-state degradation below bound the
exposure. IBKR gateway load: none. Quant Data quota: none.

## How the values differ from the Cboe series

- **IV source**: Cboe sends its own per-contract IV, delta and gamma (exchange model, American
  exercise, its own rate/dividend assumptions). Yahoo sends its own IV column; delta and gamma do
  not exist in the payload and are computed here with BSM (European, continuous dividend yield).
- **Call/put disagreement**: measured on the 2027-01-15 expiration within 3% of spot: the median
  `|call IV − put IV|` at one strike is 0.053 for SPY and 0.032 for GLD. The existing ATM rule (mean
  of call and put IV at the nearest strike with both) averages the two sides; the 25-delta
  interpolation uses each side separately, as with Cboe.
- **Level difference, measured**: on the 2027-01-15 expiration, ATM IV from the Yahoo column is
  0.2736 (SPY) and 0.3004 (GLD) against 0.2681 and 0.2947 from the research snapshot's Black-76 on
  parity-forward mids of the same day (`research/backtests/option-chain/snapshot.py` method):
  +0.55 and +0.57 vol points at 56 days. The difference against the Cboe exchange series is unknown
  while Cboe is blocked; model and quote time differ.
- **Boundary jump, measured**: the last stored Cboe session (2026-11-19, live `openbb.volContext`
  read) against the Yahoo-method values of the 2026-11-20 close:

  | Symbol | Cboe 11-19 atmIv30d | Yahoo-method 11-20 | Δ (vol points) |
  | --- | --- | --- | --- |
  | SPY | 0.2325 | 0.3056 | +7.3 |
  | QQQ | 0.3222 | 0.4058 | +8.4 |
  | DIA | 0.2100 | 0.2611 | +5.1 |
  | IWM | 0.2514 | 0.3220 | +7.1 |
  | GLD | 0.2628 | 0.3205 | +5.8 |
  | SLV | 0.4850 | 0.5596 | +7.5 |
  | USO | 0.4693 | 0.5113 | +4.2 |

  The jump mixes one session of real market move (11-19 → 11-20) with the method difference; it
  cannot be decomposed while Cboe is blocked. It is larger than the one-expiration comparison
  above because the full-chain 30-day figure also changes expiration coverage. The plan states
  this number instead of judging it "small".
- **Greeks**: delta = carry·N(d1) (calls), gamma = carry·φ(d1)/(S·σ·√T), with carry = e^(−q·T),
  q = Yahoo's `trailingAnnualDividendYield` (0 when absent; present in the measured payload for
  SPY 0.0079, QQQ 0.0027, IWM 0.0076), rate fixed 0.04 — the same formula and rate as
  `optionsChain` (`OPTIONS_CHAIN_RISK_FREE_RATE = 0.04`,
  `packages/api/src/options-chain-merge.ts`). T differs: this job uses whole days (dte/365) from
  the session date, a stated approximation of the portal's fractional years to the 16:00 New York
  expiry close (`yearsToExpiry`, ACT/365). Python uses exact `math.erf`; the TS reference uses the
  Abramowitz–Stegun erf approximation (error < 1.5e-7), so cross-language parity is tested at
  2e-7, not 1e-9. Cboe's gamma is per 1 point of the underlying, the same unit, so
  `options_math.summarize` (GEX, flip, walls) works unchanged.
- **Open interest and volume**: Yahoo's per-contract counts, same meaning as Cboe's.
- **Sentinel IV**: Yahoo sends IV ≈ 1e-5 as a placeholder (measured: 220 of 2,225 contracts in the
  rig's stored 2026-11-20 research payload, 9.9%; 4,793 of 40,057 in the live full snapshot, 12%).
  The conversion drops IV < 0.01 to `iv=None` (the contract stays for OI/volume, with
  `delta=gamma=None`), mirroring how `parse_contracts` keeps IV≤0 Cboe contracts with `iv=None`.
  Without the floor a near-ATM sentinel would halve the ATM mean and explode BSM gamma.
- **0 DTE**: `summarize` already excludes contracts expiring on the snapshot date.

## How a source change is marked

- The run warning carries a fixed marker, the CFE pattern:
  `YAHOO_FALLBACK_NOTE = "used the Yahoo option chain"` in the fetcher, mirrored as
  `OPENBB_YAHOO_FALLBACK_NOTE` in `packages/api/src/contracts/openbb.ts`; tests on both sides pin
  the exact text. Full warning per symbol:
  `cboe chain SPY: <Cboe error>; used the Yahoo option chain (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)`.
- The panel note (exact text, pinned in the view-model and panel tests):
  `Source of the newest rows: Yahoo option chain for <symbols> (Yahoo implied volatility, Black-Scholes greeks), because the Cboe chain read failed. Values differ from the Cboe series of earlier rows; the IV percentile mixes the two methods across the boundary.`
  `ivSourceNotice` derives `<symbols>` from the per-symbol warnings that carry the marker
  (`cboe chain <SYM>: …`), sorted and comma-separated, so a mixed run names only the Yahoo
  symbols. The note names state, reason and consequence (the status-language gate's rule); no
  allowlist entry is expected — the gate run verifies this.
- The stored rows keep the same schema. The source of each session is recoverable from the newest
  row-writing run for that session in the run ledger: a fallback run's status is `partial`
  (warnings present), never `ok`, and its warnings carry the marker. A later all-blocked run
  writes no rows, so earlier Yahoo rows can outlive the note — the same accepted edge as the CFE
  precedent. No row-level source column is added (a schema change would touch the shared row
  contract).
- The IV percentile keeps using the stored history unchanged (252-session window,
  `OPENBB_IV_PERCENTILE_SESSIONS`; it displays only from 20 sessions,
  `OPENBB_IV_PERCENTILE_MIN_SESSIONS` — today the store holds 9, so it shows "n/a"). A percentile
  across the boundary mixes two methods; the note says so while the fallback runs. **Known limit**:
  after Cboe recovers, the note disappears (goal 2) while Yahoo-model sessions stay in the window
  until they age out; the run ledger remains the durable provenance record. A ledger-derived
  history caveat (`lastFallbackAt` on `openbb.status`) is a follow-up card, not this change.
- `asOf` comes from the Yahoo quote's `regularMarketTime`: epoch seconds, converted to the
  America/New_York date inside `yahoo_chains` (`datetime.fromtimestamp(ts, NEW_YORK)`), then capped
  at today (the Cboe `_as_of` cap). A missing or unparseable quote time fails the symbol — it never
  silently defaults to today. On the normal 16:20+ window this is the same session; a Saturday
  manual run stamps Friday.

## Proposed Architecture

```text
cboe-option-iv run:
  for each Core 7 symbol:
    Cboe chain call (unchanged)
      ok            -> chain_rows -> option_iv_daily / option_iv_term   (no note)
      kind "empty"  -> unchanged today's behavior (ctx.failed; no fallback, CFE pattern)
      other failure -> Yahoo fallback for this symbol, unless the session guard or the
                       deadline-aware fallback gate says skip:
        t.option_chain()            (1 request: quote + expirations + first chain)
        t.option_chain(expiry)      (1 request per remaining expiry, 0.1 s spacing)
        -> plain JSON payload -> contracts (OCC parse, Yahoo IV with 0.01 floor,
           BSM delta/gamma, OI, volume)
        -> options_math.summarize (unchanged) -> same two tables
        -> warning "<cboe error>; used the Yahoo option chain (...)" -> run status partial
      Yahoo also fails -> ctx.warn("<source>: yahoo chain: <yahoo error>")
                          then ctx.failed(source, cboe error)  (blocked stays blocked)
  Markets panel: newest run warnings contain the marker -> source note under the panel title
```

- The fallback triggers per symbol on any Cboe failure of that symbol's chain call except `empty`
  (the CFE pattern: `_settlement_fallback` runs on every failure except `empty`). When Cboe is
  blocked it is blocked for all 7, so the acceptance case "every Cboe chain blocked" is covered; a
  mixed run marks each Yahoo symbol in its own warning.
- **Session guard (once per session)**: the tick passes the newest `cboe-option-iv` run's summary
  (`status`, `startedAt`, `warnings`, `rowsWritten`) to the fetcher on stdin via the existing
  `--state-stdin` mechanism (today sec-form4 only; extended to this job in `cli.py` and
  `scripts/openbb/tick.ts`, the `stateFor` pattern). When that run carries the marker, wrote rows,
  and started on the current New York date, the job still probes Cboe (recovery detection) but
  skips the Yahoo re-fetch: the source counts ok with no new rows and one warning
  `cboe chain <SYM>: Yahoo rows of <session> already stored; skipped the re-fetch`. A manual run
  (no state) always fetches. Post-close quotes are frozen, so the session date is the correct key;
  no quote-time comparison is needed.
- **Fallback gate (slow-upstream guard, deadline-aware)**: `YAHOO_FALLBACK_RESERVE_S = 100` in
  `jobs/cboe.py`. Before each Yahoo helper call, `option_iv` checks the monotonic time left to
  the job deadline (`ctx.deadline_at`, set by `cli.run` from the same `OPENBB_DEADLINE_S` value
  it passes to `asyncio.wait_for`; None in direct-call tests → no gate). The call starts only
  when at least `YAHOO_FALLBACK_RESERVE_S` seconds remain — the reserve covers one full helper
  call (`CALL_TIMEOUT_S = 90`) plus margin. Otherwise the symbol skips the fetch and takes
  `ctx.failed(source, cboe_error)` with the warning
  `<source>: less than 100 s to the job deadline; skipped the Yahoo fallback`. The gate counts
  ALL elapsed job time, so slow Cboe probes (each also capped at 90 s) consume the same clock.
  Guarantee, stated precisely: while the Cboe refusals are fast (the observed 403 case), no
  Yahoo slowness can push the run into the deadline path (`failed`, exit 3) — the last possible
  fallback starts by 140 s and ends by 230 s < 240 s.
  **Accepted regression case (explicit)**: when Cboe itself is slow, a started Yahoo fallback
  can consume time that a later Cboe success would have used. Example: Cboe 90 s + Yahoo 90 s
  (fails) leaves 60 s; a later Cboe call needing 70 s then misses the deadline, where without
  the fallback it would have finished at 160 s. The gate does not prevent this; reserving time
  for every remaining Cboe probe (7 × 90 s) would forbid every fallback, so the trade is
  accepted: the fallback's value (rows on the normal fast-refusal path) outweighs the rare
  slow-Cboe mixed case, whose outcome is the pre-existing deadline behavior (partial tables or
  exit 3 when no source finished), never fake rows. A replay test pins this exact sequence so
  the behavior is deliberate, not silent. No per-expiry or per-symbol retry is added;
  yfinance's own internal cookie-strategy retry stays as pinned.
- New module `services/openbb/vertex_openbb/yahoo_chains.py`: the yfinance access (import inside
  the function, like `_cboe_chain` does for OpenBB) and the payload → `Contract` conversion. Pure
  math lives in `options_math.py` (new `bsm_delta_gamma`, new `RISK_FREE_RATE = 0.04` next to the
  other model conventions, with a comment cross-referencing `OPTIONS_CHAIN_RISK_FREE_RATE` in
  `packages/api/src/options-chain-merge.ts`).
- **Fetch sequence and payload** (pinned): `fetch_symbol(symbol)` calls `yf.Ticker(symbol)`;
  `first = t.option_chain()` (no date — one request; fills `t._expirations`); then
  `t.option_chain(e)` for each remaining ISO expiration in `sorted(t._expirations)`, 0.1 s apart.
  It returns a plain JSON-serializable dict (never DataFrames — `jsonable` would stringify them):
  `{quote: {regularMarketPrice, regularMarketTime, trailingAnnualDividendYield},
  expirations: [ISO strings], chains: {<ISO expiry>: {calls: [rows], puts: [rows]}}}`; each row is
  `to_dict("records")` restricted to `contractSymbol`, `strike`, `impliedVolatility`,
  `openInterest`, `volume`. An expiration whose chain is empty (`calls is None`) is skipped and
  counted; one warning per symbol names the count. No spot or no chains at all fails the symbol.
- **Conversion** (`contracts_of(payload, as_of)`): OCC parse via `options_math.OCC`; IV from
  `impliedVolatility` with the 0.01 floor (below → `iv=None`, contract kept, `delta=gamma=None`);
  `bsm_delta_gamma(spot, strike, dte/365, iv, RISK_FREE_RATE, q, is_call)` with q from the quote
  (negative → 0); OI/volume via `count`. Spot = `num(quote["regularMarketPrice"])`, fail the
  symbol when absent or ≤ 0 (mirrors `chain_rows`). The job computes `as_of` (epoch → NY date,
  cap at today) and passes it in. Conversion reference for the normalization rules:
  `packages/api/src/server/options-chain-yahoo.ts`.
- The upstream wrapper records one `helper:yahoo:options_chain:<symbol>` call per symbol; the key
  stays one per symbol, independent of the expiration list.
- Deadline: the job keeps the default 240 s budget and the 420 s step timeout. Measured full
  fallback ≈ 31 s with spacing; the envelope arithmetic is in the fallback-gate bullet above.
- `--warm` imports `yfinance` (added to `PROVIDER_MODULES` in `cli.py`) so a missing or
  incompatible `yfinance` import fails the install, not a timed step.
- Dependency: `yfinance==0.2.66` added to `services/openbb/requirements-openbb.in` and the
  hash-locked `services/openbb/requirements-openbb-linux-py312.lock` (regenerated with the
  `uv pip compile` command in the `.in` header, same `--exclude-newer 2026-11-08`). Its largest
  dependencies (pandas, numpy, curl_cffi, beautifulsoup4, websockets, platformdirs, requests) are
  already in the lock at the same pins; the new pins are yfinance plus multitasking, frozendict,
  peewee, protobuf, pytz. `services/openbb/pyproject.toml` gets the same pin. The rig installer
  (`uv pip sync` from the lock) picks it up with no installer change. The yfinance pin decision is
  shared with the research runner, but the two environments resolve independently (the runner
  compiles with `--exclude-newer 2026-11-11`, the lock with 2026-11-08); an upgrade updates both
  anchors, and the Phase 1 scratch-venv sync + `--warm` check validates the ingest resolution.

## Acceptance check

1. With Cboe still blocked, a live rig run of `cboe-option-iv` writes `openbb_option_iv_daily` and
   `openbb_option_iv_term` rows for the newest session for all 7 symbols, the run warning contains
   `used the Yahoo option chain`, the run status is `partial`, and the Markets panel shows the
   source note. Verify live after the rig install and the web deploy.
2. With Cboe open again (tests: the recorded Cboe payload), the job uses Cboe, makes no Yahoo
   call, and the panel shows no source note.
3. Request bound: one full snapshot makes 179 Yahoo requests and zero IBKR/Quant Data calls (the
   replay tests request no other upstream key); the session guard holds the steady state to one
   full snapshot per session.
4. Mixed run: one symbol Cboe ok, one blocked→Yahoo; both rows present, only the Yahoo symbol's
   warning carries the marker, and the panel note names only that symbol.
5. Degradation: with fast Cboe refusals, Yahoo refusing (429) or slow (gate skip) leaves the run
   `blocked_upstream` with the blocked notice — never `failed`, never fake rows.
6. Python tests replay recorded real Yahoo payloads (trimmed, the `_trim_chain` pattern in
   `services/openbb/tests/record.py`) through the same job code; the TypeScript contract test
   parses the new document fixture; the web view-model and panel tests pin the exact note text.

## Alternatives Considered

1. **Quant Data through the portal `optionsChain` read** — rejected: paid quota, a web-app
   dependency for a rig timer, and its IV/delta come from term-structure prints, not a full chain
   snapshot.
2. **IBKR quotes** — rejected by the card (gateway load target: none).
3. **Raw Yahoo v7 with `requests` + cookie/crumb** (the portal adapter's method) — measured 429
   from the rig on 2026-11-21. Making it work needs the same TLS-level Chrome impersonation
   yfinance performs, but as hand-maintained cookie/crumb code in the fetcher; yfinance is already
   pinned, hash-locked, and deployed on this rig by the owner's option-chain timer. The rejection
   is maintenance and the measured refusal, not impersonation itself (the chosen client
   impersonates Chrome against Yahoo via curl_cffi; the rig rule forbids impersonation to pass
   the Cboe block, which neither path does).
4. **`openbb-yfinance` provider** — rejected: version 2.1.0 requires `yfinance>=1.3` (conflicts
   with the proven 0.2.66 pin) and pulls `openbb-charting`, `pywry`, `fastmcp`,
   `openbb-platform-api` — GUI/router dependencies the lock's header explicitly excludes.
5. **Read the stored `infra/option-chain` CSVs instead of fetching** — rejected: that snapshot
   only covers monthly expirations 30–75 DTE (no full chain, no GEX/flip/walls), runs only during
   market hours, and its files are a local data directory the app must not read (owner rule: data
   lives in Postgres, served through oRPC — AGENTS.md golden rule 13). It informed the IV-method
   comparison only.
6. **Compute IV from Yahoo bid/ask mids (Black-76, parity forward) like the research snapshot** —
   rejected for this card: it computes IV from tradeable bid/ask mids instead of a vendor model
   column, but needs the parity-forward calculation per expiration and drops every contract
   without a two-sided quote, which would remove most far-strike contracts from GEX and the wall
   calculation. The Yahoo IV column is present for every contract; zero, missing or sentinel
   values are dropped to `iv=None` as described. A future refinement (recorded, not built): a
   composite chain — parity-mid IV near spot (where the percentile and skew read), Yahoo column
   at one-sided far strikes (where GEX reads) — or an ATM-only parity correction. Cost: the
   parity machinery in the ingest job, two IV methods inside one chain, and a delta-consistency
   invariant across the method boundary. The card asks for a marked second source, not a new IV
   method.

## Risks & Mitigations

- **Yahoo rate-limits the rig later** (it already returns HTTP 429 to the plain `requests`
  client): the fallback uses the same pinned client as the twice-per-trading-day research
  snapshot, but its full-chain burst (~179 requests) is larger than that pattern (~14/run) and
  unproven beyond two measured passes. Mitigations: 0.1 s inter-request spacing; the
  once-per-session guard (steady state ≈ 207 requests/day); on failure the run stays
  `blocked_upstream` (today's state) and the tick's blocked backoff (1 h, then 6 h) limits
  retries. The warning names the Yahoo error.
- **Slow Yahoo (delay, not refusal)**: the deadline-aware fallback gate (100 s reserve against
  the job deadline, counting all elapsed job time including slow Cboe probes) keeps every
  started fallback inside the deadline with per-source accounting intact — `blocked_upstream`,
  never the deadline's `failed` path, while the Cboe refusals are fast. **Accepted regression
  case**: with slow Cboe calls, a started fallback can consume time a later Cboe success would
  have used (the Architecture section's 90+90+70 example); the outcome is the pre-existing
  deadline behavior, never fake rows. Reserving for every remaining probe would forbid every
  fallback; the trade is accepted and pinned by a replay test.
- **Method discontinuity in the IV history**: marked by the run warning + panel note; the
  one-expiration gap (+0.55/+0.57 vol points) and the boundary jump (+4.2 to +8.4 vol points,
  market move included) are measured and stated above; no silent mixing (a fallback run is always
  `partial`). Known limit: after recovery the note disappears while Yahoo sessions remain in the
  252-session percentile window; the run ledger is the durable provenance; the ledger-derived
  caveat is a follow-up card. The percentile displays only from 20 sessions (today: 9).
- **Lost 7-day blocked escalation**: while the fallback works, runs are `partial`, so the
  predecessor design's 7-day blocked-streak alarm never fires even if the Cboe outage is
  self-inflicted and lasts months. Accepted: the panel note and the `partial` status keep the
  degradation visible on every visit, and the hourly Cboe probe recovers automatically. No new
  escalation rule is added in this change.
- **Known Yahoo IV column issues** (call/put disagreement, stale far-strike values, sentinel
  IV ≈ 1e-5): the ATM rule averages both sides; `summarize` excludes 0 DTE; the 0.01 IV floor
  removes sentinels (12% of contracts in the measured pass); the row validator bounds the summary
  IV to [0, 10]; contracts without a usable IV keep OI/volume with `iv=None`, as in the Cboe path.
- **yfinance dependency drift**: pinned exactly, hash-locked, `--exclude-newer` held; `--warm`
  imports it at install time; the top-level pin matches the research runner (the two
  `--exclude-newer` anchors differ; an upgrade moves both).
- **A future yfinance payload change**: the conversion validates every field it reads; a bad
  payload fails that symbol's source with a warning (the `ctx.take` pattern), never the job.

## Implementation Plan

### Files

| File | Change |
| --- | --- |
| `services/openbb/requirements-openbb.in` | add the `yfinance==0.2.66` pin |
| `services/openbb/requirements-openbb-linux-py312.lock` | regenerate with the `uv pip compile` command in the `.in` header |
| `services/openbb/pyproject.toml` | add the pin to `dependencies` |
| `services/openbb/vertex_openbb/options_math.py` | add `RISK_FREE_RATE = 0.04` and `bsm_delta_gamma(spot, strike, years, iv, rate, dividend_yield, is_call)` (no I/O) |
| `services/openbb/vertex_openbb/yahoo_chains.py` | new module: the yfinance fetch helper and the payload-to-contract conversion |
| `services/openbb/vertex_openbb/jobs/cboe.py` | `YAHOO_FALLBACK_NOTE`, `YAHOO_FALLBACK_RESERVE_S = 100`; `_yahoo_fallback` in `option_iv`, modeled on `_settlement_fallback` in the same file; session guard; deadline-aware fallback gate |
| `services/openbb/vertex_openbb/context.py` | `option_iv_state` field (the newest-run summary from `--state-stdin`); `deadline_at` field (monotonic job deadline) |
| `services/openbb/vertex_openbb/cli.py` | `--state-stdin` accepted for `cboe-option-iv`; `ctx.deadline_at` set from the deadline; `PROVIDER_MODULES` gains `yfinance` (imported by `warm()`) |
| `scripts/openbb/tick.ts` | `stateFor` passes the newest `cboe-option-iv` run summary from the status reply |
| `services/openbb/tests/record.py` | `_trim_yahoo` + the `helper:yahoo:options_chain:` dispatch branch |
| `services/openbb/tests/fixtures/upstream/cboe-option-iv.json`, `services/openbb/tests/fixtures/cboe-option-iv.json` | re-record: Cboe blocked + Yahoo fallback (real payloads) |
| `services/openbb/tests/test_jobs.py` | add the fallback tests listed under Tests; update the four blocked-path tests and `test_option_iv_rows_are_consistent` |
| `services/openbb/tests/test_units.py` | add `test_bsm_delta_gamma` and the `contracts_of` conversion tests |
| `packages/api/src/contracts/openbb.ts` | `OPENBB_YAHOO_FALLBACK_NOTE` constant |
| `apps/web/src/features/openbb/view-model.ts` | `ivSourceNotice(runs)` (the `vxSourceNotice` pattern, with the symbol list) |
| `apps/web/src/features/openbb/openbb-panels.tsx` | add the note to the Core 7 IV block notices |
| `apps/web/src/features/openbb/view-model.test.ts`, `apps/web/src/features/openbb/openbb-panels.test.tsx` | assert the exact note text when the marker is present and no note when it is absent; extend the existing notices-array test |
| `scripts/openbb/tick.test.ts` | the session-guard state passing |
| `docs/vertex-rebuild/openbb.md` | document the second source, the warning, the method difference |
| `CHANGELOG.md` | one Unreleased entry |

### Phase 1: dependency and math

1. Add the pin, regenerate the lock, then verify `uv pip sync` completes in a scratch venv and
   `--warm` prints `warm: ok <version>`.
2. Implement `bsm_delta_gamma` in `options_math.py`. It returns `(delta, gamma)`, or
   `(None, None)` when any of spot, strike, years, iv is non-positive or non-finite (the TS
   `blackScholes` domain rule); a negative dividend yield clamps to 0. Test it against the
   known-value table below (tolerance 1e-9) and against a checked-in JSON table of
   `blackScholes` outputs recorded from the TS function (tolerance 2e-7 — the TS A&S erf
   approximation's own error bound; Python uses exact `math.erf`).
   Check: `bash scripts/ci/research-python.sh` (focused while iterating:
   `cd services/openbb && python -m pytest tests/test_units.py`).

   Known-value rows (rate 0.04; computed with exact `math.erf`, verified 2026-11-21; the test
   pins these values at 1e-6 and the relations at 1e-9):

   | spot | strike | years | iv | q | call | delta | gamma |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | 100 | 100 | 1.0 | 0.2 | 0 | yes | 0.617911 | 0.019069 |
   | 100 | 100 | 1.0 | 0.2 | 0 | no | −0.382089 | 0.019069 |
   | 100 | 130 | 0.5 | 0.3 | 0.01 | yes | 0.143847 | 0.010669 |
   | 100 | 70 | 0.08 | 0.25 | 0 | no | −1.49e-7 | 1.12e-7 |
   | 100 | 100 | 0.0 | 0.2 | 0 | yes | None | None |

   (The test also asserts the relations — call delta − put delta = e^(−q·T), equal put/call
   gamma — at 1e-9, and the checked-in TS `blackScholes` output table at 2e-7.)

### Phase 2: the fallback, the guard, and the fixtures (one CI landing)

1. `yahoo_chains.py`: add `fetch_symbol(symbol)` — one helper call that returns the JSON payload
   (the pinned fetch sequence and schema of the Architecture section). Add
   `contracts_of(payload, as_of)` — parse the OCC symbol with `options_math.OCC`, read the Yahoo
   IV with the 0.01 floor, compute the BSM greeks, read OI and volume, and take spot and dividend
   from the quote object.
2. In `option_iv`, when the Cboe call for a symbol fails (except `empty`): check the session guard
   and the deadline-aware fallback gate; otherwise read Yahoo through
   `ctx.up.helper(f"yahoo:options_chain:{symbol}", ...)`, build rows with
   `options_math.summarize`, and call `ctx.warn` with the marker. If the Yahoo call also fails,
   call `ctx.warn(f"{source}: yahoo chain: {yahoo_exc.message}")` and then
   `ctx.failed(source, cboe_exc)` — the Cboe error keeps the blocked classification; the Yahoo
   error is never passed to `ctx.failed`. `_yahoo_fallback` catches `UpstreamError` only (live
   `ctx.up.helper` always classifies; an unrecorded replay key must keep raising).
3. Extend `--state-stdin` to `cboe-option-iv` (`cli.py`, `context.py`) and pass the newest run
   summary in `scripts/openbb/tick.ts` (`stateFor`, from the status reply the tick already reads
   for backoff; a manual run passes no state).
4. Before re-recording, copy the current trimmed Cboe calls from
   `services/openbb/tests/fixtures/upstream/cboe-option-iv.json` into `test_option_iv_cboe_ok_never_calls_yahoo`
   as inline `call()` records. Then record the new fixture live (Cboe is blocked as of
   2026-11-21, so a live recording on that date captures the fallback path); the recording
   universe stays `--symbols SPY,GLD`; `_trim_yahoo` reuses `_trim_chain`'s expiration selection
   (two nearest, the two bracketing 30 days, one near 60 days) and the 4%-of-spot strike filter,
   whitelists the payload fields, keeps the quote intact, and keeps one non-OCC row for the skip
   path. Contingency: if Cboe answers 200 at recording time, record the Yahoo payloads directly
   via `RecordingUpstream` calling `yahoo_chains.fetch_symbol` for SPY and GLD and assemble the
   upstream fixture with blocked Cboe error records (real Yahoo results, real blocked-error
   shape).
5. Update the four existing blocked-path tests (`test_every_source_blocked_upstream_is_exit_0_with_the_host`,
   `test_blocked_sources_with_another_failure_still_exit_3`,
   `test_a_blocked_error_without_a_host_is_a_plain_failure`,
   `test_deadline_with_only_blocked_sources_exits_3`): append a Yahoo error record after each
   blocked Cboe record and extend the warning assertions to name both errors. Update
   `test_option_iv_rows_are_consistent`: keep the {SPY, GLD} and OI/volume-consistency assertions;
   assert the Yahoo marker; keep the OCC-skip assertion (the trimmed non-OCC row).
   Check: `bash scripts/ci/research-python.sh`.

### Phase 3: contract and panel

1. `OPENBB_YAHOO_FALLBACK_NOTE` in the API contract; `ivSourceNotice` in the view model (the exact
   note of the marking section, with the sorted symbol list from the warnings); the note in the
   panel's `notices` array after `blockedNotice` (null on a partial run; the existing exact-array
   test stays green because null entries are filtered).
   Check: `pnpm exec vitest run --config vitest.config.ts --project unit packages/api/src/openbb-server.test.ts apps/web/src/features/openbb apps/web/src/status-language.test.ts`
   (the status-language gate must pass without a new allowlist entry; the note names state,
   reason and consequence).

### Phase 4: docs and full verification

1. `docs/vertex-rebuild/openbb.md`: a second-source paragraph modeled on the CFE paragraph (the
   warning text, the method difference, the session guard, the fallback gate), the UI paragraph (the
   Core 7 IV panel names the Yahoo source), and the job-table row. `CHANGELOG.md`: one Unreleased
   entry.
2. Run the Python tests (replay and synthetic edge cases), the TypeScript contract fixture test,
    and the web view-model and panel tests.
    Check: `bash scripts/ci/research-python.sh` and the Phase 3 vitest command; then
    `bun run verify:prepush` at push time.

### Tests

- `test_jobs.py` `test_option_iv_uses_yahoo_when_cboe_is_blocked`: replay the recorded fallback
  fixture; rows for both recorded symbols (SPY, GLD), warning contains the exact marker, status
  `partial`, no `blocked` key.
- `test_jobs.py` `test_option_iv_yahoo_failure_keeps_blocked`: Cboe blocked + Yahoo error → exit 0,
  empty tables, `blocked` present, one warning names the Yahoo error and one the Cboe error.
- `test_jobs.py` `test_option_iv_cboe_ok_never_calls_yahoo`: replay the inline Cboe payload from
  step 6; no Yahoo helper call is made (`ReplayUpstream` raises `LookupError` on an unrecorded
  call), and no marker appears in the warnings.
- `test_jobs.py` `test_option_iv_mixed_sources`: one symbol Cboe ok, one blocked→Yahoo; both rows
  present, only the Yahoo symbol's warning carries the marker.
- `test_jobs.py` `test_option_iv_session_guard_skips_refetch`: state says the newest run wrote
  Yahoo rows today → Cboe probed, no Yahoo helper call, the skip warning present; state from
  yesterday → Yahoo fetched.
- `test_jobs.py` `test_option_iv_slow_yahoo_stays_blocked`: `ReplayUpstream(delay_s=…)` with a
  small deadline (`OPENBB_DEADLINE_S`) → the first fallback runs, later symbols skip with the
  gate warning, exit 0, `blocked` present, never exit 3.
- `test_jobs.py` `test_option_iv_slow_cboe_then_yahoo_gate`: delayed Cboe calls consume the
  clock; a symbol whose remaining time is below the reserve skips the Yahoo fetch (no Yahoo
  helper call recorded for it) — never a fallback started inside the reserve.
- `test_jobs.py` `test_option_iv_slow_cboe_mixed_regression`: the accepted case, pinned —
  symbol 1: Cboe delayed ~90 s then blocked, Yahoo delayed ~90 s then error (gate allowed it);
  symbol 2: Cboe delayed ~70 s then ok, with the deadline at ~240 s scaled down proportionally
  (e.g. 9/9/7 s calls, 24 s deadline, reserve scaled via the constant): the run hits the
  deadline before symbol 2 finishes and prints the partial tables (or exit 3 when no source
  finished) — the same outcome class as today's deadline path, asserted explicitly so the
  regression is deliberate.
- `test_jobs.py` weekend `asOf`: a Friday quote timestamp replayed on Saturday stamps Friday.
- `test_units.py` `test_bsm_delta_gamma`: the known-value rows and relations at 1e-9; the
  checked-in TS `blackScholes` output table at 2e-7; `(None, None)` outside the domain; negative
  dividend clamps to 0.
- `test_units.py` `contracts_of`: OCC parse, sentinel IV floor (a near-ATM 1e-5 contract keeps
  OI/volume with `iv=delta=gamma=None` and does not move the ATM mean), missing fields, empty
  chain skip.
- `view-model.test.ts`: `ivSourceNotice` returns the exact note only when the newest
  `cboe-option-iv` run's warnings contain the marker, with the sorted symbol list; null for a run
  with only the CFE marker and for an ok run.
- `openbb-panels.test.tsx`: extend the existing iv-block notices test — a partial fallback run
  renders `[ivSourceNotice]`; the blocked-run case stays `[blockedNotice]`.
- `tick.test.ts`: the tick passes the newest-run summary for `cboe-option-iv` and no state for a
  manual run.
- The updated deadline test (step 7) keeps exit 3 with only blocked sources and no ok source
  before the deadline; the slow-Yahoo tests above prove the gate keeps a fast-refusal run out
  of that path.

## Deploy order and revert

1. Merge through `scripts/merge-pr` (CI green on the reviewed head).
2. Deploy the web app on the QuantVPS per `infra/quantvps/README.md`: build the merged SHA in a
   rig worktree (`pnpm install --frozen-lockfile && bun run build`, record
   `apps/web/dist/DEPLOYED_SHA`), copy `dist/` and `.wrangler/deploy/config.json`, run
   `infra/quantvps/stage-runtime.sh`, then `infra/quantvps/restart-when-idle.sh` (waits for idle,
   restarts only `vertex-web`, checks health, rolls back a failed build). Operator rule: no
   deploy during market hours (after 16:00 ET or before 08:30 ET). No migration in this change;
   the old fetcher works with the new server, so this order is safe.
3. Install the fetcher on the rig: `infra/openbb/rig/install.sh <merged SHA>` (holds the
   tick-runner run lock; the venv sync adds yfinance; `--warm` confirms the import).
4. Live check: `vertex-openbb-run cboe-option-iv` inside the job window
   (`mon-fri@16:20-21:00` New York) or manually after it; verify the rows in the fetcher
   document, the warning, the stored run status `partial` (`openbb.status`), and the Markets
   panel note (headless Chrome on the rig, agent viewer account, dark mode, 1440 px and 375 px).
5. Revert: install the earlier SHA on the rig first (the venv sync removes yfinance; while Cboe
   remains blocked, the job returns to the blocked state), then revert the web commit and
   redeploy the earlier build with the same script. No data loss: the fallback rows stay stored
   and remain marked by their run warnings.
