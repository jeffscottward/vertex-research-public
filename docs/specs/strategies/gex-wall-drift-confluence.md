# GEX wall x net drift read: pre-registered study

Status: research only, `accruing`. No live or paper orders. No broker changes. NautilusTrader stays disarmed. The read
is shown on `/flow` and `/stock` as a description, never as a trade signal. The rules, the event, the outcomes and the
pass/fail rule below were fixed on 2026-11-25 before any run. The freeze is the commit that adds this file. The rules
block below must equal `GEX_WALL_DRIFT_RULES` in `packages/api/src/gex-wall-drift-rules.ts`; the unit test
`packages/api/src/gex-wall-drift-spec.test.ts` fails when they differ. A change to a rule value needs a new rules
version and a new spec; it never edits this one.

Design and reasons: `docs/vertex-rebuild/designs/gex-wall-drift-confluence/design.md`.

## Question

When price touches a dealer GEX wall, does the session net options premium drift of the last 15 minutes, together with
the side of the gamma flip, separate touches that hold from touches that break?

- H1 (`break-risk`): touches read `break-risk` break more often than touches read `no-read` with code `flat`.
- H2 (`hold-A`): touches read `hold-A` hold more often than touches read `no-read` with code `flat`.

## Source

- Idea: an owner reel (2026-11-25): call wall = usual ceiling, put wall = usual floor; above the gamma flip walls tend
  to hold, below it they tend to break; at a wall, flow against the wall means it holds, flow through it means it breaks,
  flat flow means no read.
- Trading knowledge bases consulted on 2026-11-25 (Skydweller, QuantFinanceToGo; the dealer gamma base gave no
  answer): they do not set a touch distance, drift window or outcome horizon. Skydweller notes that below the flip
  walls act as targets, which supports grading a hold above the flip only. The values below are therefore Vertex
  choices, listed with their origin in "Rule provenance".
- Vendor data is for personal use and is not redistributed. Data and reports stay outside the repository.

## Data

- Walls and flip: stored `flow_gex` rows only (QuantData chain and open interest estimate, about every 14 minutes,
  730-day retention). No other gamma source (OpenBB, market-watch-bot, on-demand options analytics) is mixed in.
  Stored rows start 2026-11-08 (SPY, ES) and 2026-11-15 (QQQ, NQ).
- Net drift: stored `flow_net_drift` rows, filter profile `otm-clean.v1`, part `total` (the vendor total), the same
  rows that `flow.control` reads for the live badge. A minute without a `total` row is a gap; no other part fills it
  (the collector stores `total` and `zero_dte` only).
- Price: the `underlying_price` of the same net drift minute.
- Tickers: the read pairs each options ticker with its own levels: SPY, SPX (the ES view), QQQ, NDX (the NQ view).
  SPY/SPX and QQQ/NDX are the same markets, so the verdict uses one ticker per group: SPX for sp500 and QQQ for
  nasdaq100. SPY and NDX are reported alone.
- Sessions: regular New York sessions 09:30 to 16:00; early closes and FOMC decision days are reported alone.

## Rules

Rules version `gex-wall-drift-rules.v1` (the rules object, exactly):

```json
{
  "maxDriftAgeMinutes": 5,
  "maxGexAgeMinutes": 30,
  "maxScaleGapPct": 2,
  "minBuckets": 10,
  "nearWallPct": 0.25,
  "risingShare": 0.3,
  "version": "gex-wall-drift-rules.v1",
  "windowMinutes": 15,
  "windowToleranceMinutes": 3
}
```

- Read time: the end of a settled one-minute net drift bucket `m`.
- Levels: the newest `flow_gex` row of the ticker at or before `m`, at most 30 minutes old.
- Window: the baseline is the newest settled minute at or before `m - 15`. No baseline: `no-data` (`window_short`).
  A baseline older than `m - 18`: `no-data` (`window_gap`). Fewer than 10 settled minutes after the baseline:
  `no-data` (`thin_window`).
- Changes: call change and put change are the changes of the cumulative net call and net put premium from the
  baseline to `m`. Gross is the sum of the absolute per-minute changes of both lines. Zero gross: `no-data`.
- Shares: call share = call change / gross; put share = put change / gross. A side is rising at share >= 0.30.
- Price: the underlying price of the newest minute `m` (none: `no_price`); it must be within 2% of the GEX spot
  (`price_scale_mismatch`). The vendor `stockPrice` of a bucket is taken as that minute's last price; this is not
  verified against a consolidated tape.
- Walls: a GEX row with neither a call nor a put wall gives `no-data` (`gex_no_walls`).
- Wall: the call wall must be above the put wall (`wall_geometry`). Price is at a wall when |price - wall| <= 0.25% of
  price. Both walls in the band: `no-read` (`both_walls_near`). Neither: `no-read` (`not_at_wall`).
- Flip side: `above` when price >= flip, `below` when price < flip, `no_flip` without a flip; a `no-data` read that
  stops before price is known has `not_read`.
- Truth table (push side = put at the put wall, call at the call wall; hold side = the other one):

| Wall | Flip side | Push side rising only | Hold side rising only | Both rising | Neither |
| --- | --- | --- | --- | --- | --- |
| put or call | above | `break-risk` | `hold-A` | `no-read` (`both_rising`) | `no-read` (`flat`) |
| put or call | below | `break-risk` | `no-read` (`hold_below_flip`) | `no-read` (`both_rising`) | `no-read` (`flat`) |
| put or call | no flip | `break-risk` | `no-read` (`hold_no_flip`) | `no-read` (`both_rising`) | `no-read` (`flat`) |

## Rule provenance

| Value | Origin |
| --- | --- |
| `windowMinutes` 15 | The 15-minute net drift slope already on `/flow` (`FLOW_NET_DRIFT_SLOPE_MINUTES`). In the failed `flow-control-continuation` study a 15-minute window was variant V1 (not a pass); that study chose its 30-minute primary window on 13 sessions. |
| `risingShare` 0.30 | Equal to the enter ratio of `flow-control-rules.v1`. |
| `minBuckets` 10 | Equal to `flow-control-rules.v1`. |
| `nearWallPct` 0.25 | Vertex choice: about one to two strikes on SPY and QQQ. Not fitted. |
| `maxDriftAgeMinutes` 5, `maxGexAgeMinutes` 30 | Equal to the `FLOW_SOURCE_METADATA` limits of `net_drift` and `gex` on 2026-11-25; written as numbers so that a later collector change cannot move them. |
| `windowToleranceMinutes` 3 | Vertex choice: one late collector run (net drift is fetched every 2 minutes). |
| `maxScaleGapPct` 2 | Vertex choice: guards against a level and a price of different tickers. |

The 10 trials of `flow-control-continuation` used the same net drift data. They are listed here as context; the
thresholds of this study correct only for its own two hypotheses.

## Event

- The band is 0.25% of price on each side of a wall strike (about 1.5 points on SPY at 600, 15 points or three 5-point
  strikes on SPX at 6000).
- A touch is a read time at which the read is not `no-data`, the wall is `call` or `put`, and price entered the band
  from the inside: for the put wall the previous minute's price was above the put wall plus the band; for the call wall
  it was below the call wall minus the band.
- After a touch, the same wall (same side and strike) gives no new touch until price has been outside the band for 30
  minutes in a row. A wall that moves to a new strike is a new wall. A session can therefore have several touches.
- The wall of a touch is the one of the newest `flow_gex` row at the touch minute; its strike stays fixed for the
  outcome, even when a later GEX row moves the wall.
- A minute in which price moves from the inside straight past the far edge of the band is not a read time (price is
  never in the band). Such jump-throughs are counted and reported per wall; they are not touches.
- Touches from 09:30 to 09:44 (the window cannot be full) and after 15:25 (no full horizon) are not counted.
- Recorded per touch: ticker, time, wall, strike, flip side, read, code, shares, gross, `zeroDteShare` of the GEX row,
  the read time's minute of the session.

## Outcomes

- Horizon: 30 minutes after the touch (also reported at 60 minutes; the verdict uses 30).
- Break: a minute close beyond the wall by more than the band within the horizon (put wall: price < wall - band; call
  wall: price > wall + band).
- Hold: no break within the horizon.

## Pass/fail rule

- Counted touches: SPX and QQQ (the verdict tickers), regular full sessions only, from the first session after the
  commit that adds this file (2026-11-26). Touches before that date, on early-close and FOMC decision days, and on SPY
  and NDX are reported but never counted toward the stopping rule or the verdict. No parameter is fitted, so every
  counted touch is out of sample.
- Looks before the run: counts of touches per class (no outcomes) may be printed at any time; a look at outcomes
  before the stopping rule is met is not allowed.
- Comparison groups. H1: `break-risk` against `flat`, matched by flip side (`above` and `below` are two strata;
  `no_flip` touches are reported only). H2: `hold-A` against `flat` touches with flip side `above` only.
- Size: a 15 percentage point difference from a 50% base needs about 170 touches per group for 80% power with a
  one-sided error of 0.025 (two-proportion normal approximation, before the session clustering below). The run
  happens when every compared group (`break-risk` and `flat` in each stratum used, `hold-A` and `flat` above the flip)
  has at least 170 counted touches, and not before 2027-03-01.
- End date: when the groups are not large enough on 2027-11-26, the run happens then and each hypothesis without
  enough touches is `needs-more-data` (final for this spec version).
- Test: the difference of rates (break rate for H1, combined over the two strata with Mantel-Haenszel weights; hold
  rate for H2) with a one-sided p-value from a session-block bootstrap (10,000 resamples of whole sessions, seed 20261125),
  so touches of the same session and of SPX and QQQ on the same day stay together. Holm-Bonferroni over H1 and H2 at a
  family error rate of 0.05: the smaller p-value must be below 0.025, the larger below 0.05.
- H1 passes when the combined break-rate difference is at least 10 percentage points and its Holm-adjusted test
  passes. H2 passes when the hold-rate difference is at least 10 percentage points and its Holm-adjusted test passes.
- `flat` means that neither side's share reached 0.30; it includes heavy selling of either side (for example put
  selling at the put wall), which is reported as its own row.
- Verdict per hypothesis: `supported`, `not-supported` or `needs-more-data`. A supported hypothesis is research
  evidence only; it never arms anything or changes a risk setting.

## Golden cases

The rule module must return these reads under `gex-wall-drift-rules.v1` (16 settled minutes one minute apart, the
newest 2 minutes before the read time; each minute adds `call` and `put` USD; GEX 10 minutes old; walls call 610, put
600; spot 600.4). `gex-wall-drift-spec.test.ts` runs every case.

```json
[
  { "price": 600.5, "flip": 590, "call": 100000, "put": 0, "read": "hold-A", "code": null },
  { "price": 600.5, "flip": 590, "call": 0, "put": 100000, "read": "break-risk", "code": null },
  { "price": 600.5, "flip": 605, "call": 100000, "put": 0, "read": "no-read", "code": "hold_below_flip" },
  { "price": 600.5, "flip": null, "call": 100000, "put": 0, "read": "no-read", "code": "hold_no_flip" },
  { "price": 600.5, "flip": 590, "call": 100000, "put": 100000, "read": "no-read", "code": "both_rising" },
  { "price": 600.5, "flip": 590, "call": 20000, "put": -80000, "read": "no-read", "code": "flat" },
  { "price": 609.5, "flip": 590, "call": 0, "put": 100000, "read": "hold-A", "code": null },
  { "price": 609.5, "flip": 590, "call": 100000, "put": 0, "read": "break-risk", "code": null },
  { "price": 605, "flip": 590, "call": 100000, "put": 0, "read": "no-read", "code": "not_at_wall" },
  { "price": 600.5, "flip": 590, "call": 0, "put": 0, "read": "no-data", "code": "zero_premium" }
]
```

## Reported, not in the verdict

- The share of read times by flip side per ticker (QQQ flips were 8 to 11% above spot on 2026-11-20, so `above` can be
  rare there).
- Live coverage: the share of read times by `no-data` code per ticker.
- Rates by wall side, by flip side, by gross tercile and by `zeroDteShare` tercile; SPY and NDX alone.
- Minutes without a `total` row (gaps) per ticker and session.

## Known limits

- Walls sum open interest over all expiries; intraday drift is mostly same-day options.
- The GEX sign assumes customers sell calls and buy puts.
- Stored walls are short: the study accrues forward.
- QuantData may revise a minute after it was first stored; the stored row keeps the newest values, so the study grades
  final values while the live badge saw early ones. Revisions are not measured in v1.
- The `/stock` badge uses on-demand options analytics levels, a source this study does not test.
- No dollar floor on gross premium in v1; gross is a reported covariate.

## Code and tests

- Rule: `packages/api/src/gex-wall-drift-rules.ts` (tests `gex-wall-drift-rules.test.ts`, spec check
  `gex-wall-drift-spec.test.ts`).
- The study runner is not written yet; it must read the rules block of this file and refuse to run when it differs
  from the rule module.

## Results

None yet (status `accruing`).
