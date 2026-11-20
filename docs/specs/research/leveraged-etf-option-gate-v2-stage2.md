# Leveraged ETF option gate version 2, stage 2: one label per expiry type

- **Status:** Accepted after EGM review (card `vertex-leveraged-etf-gate-v2-stage2`)
- **Author:** Vertex research agent (OMP)
- **Date:** 2026-11-19
- **Scope:** research only. Nothing here places, changes or cancels an order, arms trading, changes a risk setting or touches a trading unit.
- **Builds on:** [leveraged-etf-option-gate-v2.md](leveraged-etf-option-gate-v2.md) (stage 1: the collector, the store, the rule and the build step).

## Overview

Stage 1 reads the option quotes of the leveraged funds 3 times per NYSE session. A build step gives each fund a label from its 2 newest judged sessions. In the first 4 sessions (2026-11-16 to 2026-11-19), 4 funds passed on the monthly expiry of 2026-11-20 (TQQQ, SOXL, NVDL, TSLL). No fund passed on the weekly expiry of 2026-11-27, which is in the Thanksgiving week. Stage 2 gives each fund one label per expiry type (monthly, weekly). Each type label uses the chain facts and the sessions of its own type. A reader takes the type label of the expiry type that it trades. Each session also gets diagnostics. The rule stays in Python. Postgres rows move to stage 3.

## Terms

The terms of stage 1 keep their meaning: see [Terms](leveraged-etf-option-gate-v2.md#terms) and [The rule](leveraged-etf-option-gate-v2.md#the-rule). The short forms:

| Term | Meaning |
| --- | --- |
| Study | The short-window options study of `research/backtests/leveraged-etf/` that trades leveraged fund options for 24 to 48 hours. |
| Session expiry | The expiry that the study trades for an entry on a session day: the first Friday with at least 3 sessions after the day (the trading day before it when that Friday is closed). Example: 2026-11-17 trades 2026-11-20; 2026-11-18 trades 2026-11-27. |
| Cboe fact | What one stored Cboe chain says about a fund in one run: file timestamp, fetch time, whether it lists the session expiry of the run, the open interest within 10% of the fund price at that expiry, and whether it has a standard contract. |
| Half spread | `(ask - bid) / 2 / mid * 100` of one contract. |
| Measured contracts | The two-sided quotes (bid above 0, ask above bid) of the calls and puts at the 4 strikes nearest to the fund price at the session expiry: at most 8 contracts. |
| Counted read, quotable read, judged session | As in stage 1: a read whose quotes are from the entry hours of the session; a counted read with at least 3 two-sided quotes; a session with at least 2 counted reads of its source. |
| Expiry type | `monthly` when the session expiry is the standard monthly expiry of its month: the third Friday, else the trading day before it (`monthly_expiration` of `services/research/strategies/qc_ports/calendar.py`). Every other session expiry is `weekly`. |
| Monthly block | The sessions in a row whose session expiry is a monthly expiry: about 5 sessions, from the Wednesday of the week before the expiry to the Tuesday of its week. |
| Type label | The label (`pass`, `fail`, `spread-not-measured`) and reasons of a fund for one expiry type. |
| Dollar width | Ask minus bid of one measured contract, in USD. |
| Version 1 | The gate of the universe fetcher (`research/backtests/leveraged-etf/universe.py`). Its document is imported into the Postgres table `leveraged_etf_universe` (migration `0068_leveraged_etf_universe`) by an import command with a 2 MiB input limit. |
| Rig | The research host that runs the collector timer and keeps the store. |

## The Problem

- **P1.** The label changes with the expiry type. Built on Tuesday 2026-11-17 it shows 4 passes; built on Thursday 2026-11-19 it shows 0. On the 18 funds with values on all 4 days, the median half spread was 1.6 times wider on the weekly (16 of 18 wider).
- **P2.** One set of chain facts decides the label: the newest Cboe fact. On 2026-11-19, 403 funds did not list the weekly 2026-11-27 and failed with `no-window-expiry`, although they list the monthly.
- **P3.** The reads of one session differ: the median gap between the highest and the lowest read is 4.3 percentage points of half spread (90th percentile 12). The result does not show it.
- **P4.** For a cheap option, a small dollar width gives a large percent spread. The result does not show the dollar width.
- **P5.** The weekly data is from a holiday week only. A test in the stored chains separates the two causes (see "Evidence on the expiry type").

## Method decisions

The agent asked 8 trading knowledge bases one neutral question on 2026-11-19; 7 answered. The record is in the job folder on the rig (`~/Documents/reports/web/vertex-leveraged-etf-gate-v2/stage2/kb-consult/decision-record.md`), outside the repository. The count is the number of knowledge bases that picked the answer.

| ID | Question | Decision | Count |
| --- | --- | --- | --- |
| Q1 | The label changes with the expiry type | Judge monthly and weekly expiries separately and keep both results; the study uses the result of the expiry type it trades | 6 of 7 |
| Q2 | The reads of one session differ | No majority (2 keep the rule, 2 raise the minimum to 3 reads, 3 use the worst read). The agent keeps the stage 1 session rule and adds the worst read and the read range to each session. The session-rule review decides again after 10 sessions | 2, 2, 3 |
| Q3 | The cheap band held 2 of 9 funds | Keep the cheap band and add the dollar width | 7 of 7 |

## Evidence on the expiry type

A one-off check (job folder, `expiry_compare.py` and `expiry-compare.json`) measured, in the same stored Cboe chains of the runs of 2026-11-18 and 2026-11-19 (22 candidate funds), the median half spread at several expiries:

| Fund | 11-20 monthly | 11-27 holiday weekly | 12-04 weekly | 12-18 monthly |
| --- | --- | --- | --- | --- |
| TQQQ | 3.1 | 5.0 | 6.7 | 3.9 |
| SOXL | 3.4 | 6.2 | 7.2 | 3.7 |
| NVDL | 5.4 | 6.7 | 9.6 | 8.6 |
| TSLL | 5.9 | 4.8 | 4.0 | 6.4 |

Over the 22 funds, the ordinary weekly 2026-12-04 is a median 1.18 times as wide as the holiday weekly 2026-11-27, and 1.58 times as wide as the monthly 2026-12-18, which is 2 weeks further out. This suggests that the expiry type explains more of the gap than the holiday week. Limits: one source (Cboe), the candidate funds only, 2 days, and a different time to expiry per column.

## Goals

- **G1 (P1, P2).** Each fund has a type label for `monthly` and for `weekly`. The listing of the expiry and the open interest come from the newest Cboe fact of the type. The facts that do not depend on the expiry (a current file, a standard contract) and the freshness come from the newest Cboe fact of any type.
- **G2 (P1).** The result has no single label per fund. A reader takes the type label of the expiry type of its own trade day: `expiry_type(session_expiry(day))`.
- **G3 (P3, P4).** Each session reports its expiry type, worst read, read range and median dollar width.
- **G4 (Q3).** The cheap band is reported per type label.

## Non-Goals

- Postgres rows, a TypeScript copy of the rule and a migration: stage 3 (Alternatives A, B and C).
- A change of the 4% limit or of the session rule (Q2: no majority).
- A change of the collector (`spread_reads.py`, its unit and its timer): see Alternative G.
- An engine rule that reads the gate, any order, arming, risk setting or trading unit.
- The share test of SOXL, TSLL and NVDL (card `vertex-leveraged-etf-shares-test`).

## Open Questions

- **Does a holiday week need its own type?** The check above says the type matters more. The agent decides again when ordinary weekly sessions are judged. The first sessions that trade an ordinary weekly with no holiday in their span are 2026-11-27, 2026-11-30 and 2026-12-01 (expiry 2026-12-04).
- **Does the session rule change?** The session-rule review after 10 sessions (first possible on 2026-12-01) uses `worstReadPct` and `readRangePct`.

## Critical User Journeys (CUJs)

### CUJ 1: A person builds the result on a weekly day

A person runs `gate_v2.py --as-of 2026-11-19`. TQQQ shows a monthly type label `pass` (sessions 2026-11-17 and 2026-11-16) and a weekly type label `fail` with `spread-above-maximum` (sessions 2026-11-19 and 2026-11-18). A fund that lists only monthly options shows weekly `fail` with `no-window-expiry` and a monthly type label from the monthly runs.

### CUJ 2: A reader picks a label for a trade

The study plans an entry on 2026-11-17. `session_expiry(2026-11-17)` is 2026-11-20, a monthly expiry: the study reads the monthly type label. For an entry on 2026-11-18 it reads the weekly type label.

### CUJ 3: A fund has no sessions of one type

A fund with weekly sessions only (the first session in the store is later than the last monthly block) gets monthly `spread-not-measured` with `no-chain-in-store` (no monthly Cboe fact) or `fewer-than-2-judged-sessions`.

### CUJ 4: The collector pauses

When the newest Cboe fact of a fund is older than the newest 5 sessions, both type labels of a fund with listed options are `spread-not-measured` with `no-recent-chain`. A pause alone does not create a `fail`, and an old `pass` does not outlive it.

## Technical Plan (Architecture)

```text
store (stage 1, unchanged)            build step (gate_v2.py, no network)              result
<day>/<run>/run.json, cboe/, yahoo/ ─►  load the runs of the newest 25 sessions   ─┐
universe file (unchanged)           ─►  read the universe file                      │
                                        per fund: sessions with expiry type and     ├─► gate-v2.json
                                          diagnostics                               │   (schemaRevision 2)
                                        per fund and type: newest facts of any      │   gate-v2.md
                                          type, newest facts of the type, label    ─┘
```

### Stage 1 entry criteria and open questions

| Stage 1 item | State | Evidence |
| --- | --- | --- |
| The store has runs of at least 2 sessions | Met | 12 complete runs of 4 sessions, no Yahoo rate limit |
| A first result exists | Met | Builds of 2026-11-17 and 2026-11-19 in the job folder |
| The gap between Cboe and Yahoo is shown | Met | 77 sessions with both sources: median absolute gap 1.1 points; 2 sessions (both TSLL, near 4%) on different sides of the limit |
| Cheap band numbers | Answered | 9 funds had a session between 4% and 8%; 2 of them were cheap (TSLL, NVDX). Kept by Q3 |
| Age of Yahoo option quotes | Open | Yahoo gives no quote time; the two sources agree within the gap above |
| Timer: stays, changes or is removed after 10 sessions | Moved | The timer stays unchanged. The session-rule review (on or after 2026-12-01) decides it again |

### The rule (changes to stage 1)

#### Expiry type

`expiry_type(expiry)` is `monthly` when `expiry` equals `monthly_expiration(expiry.year, expiry.month)`, else `weekly`. `liquidity.py` already loads `qc_ports/calendar.py` by its file path for `is_nyse_holiday`; it now also takes `monthly_expiration` from the same loaded module. Examples: the June 2026 monthly is Thursday 2026-06-18 (Juneteenth closes the Friday); the April 2025 monthly is 2025-04-17 (Good Friday).

#### Lookback and freshness

- `sessionLookback` = 25 NYSE sessions up to the build day, for both types (stage 1: 5). A monthly block comes every 20 or 25 sessions. A test checks for every day of 2026 and 2027 that the lookback holds at least 2 weekly and 2 monthly sessions.
- `freshSessions` = 5: the newest Cboe fact of a fund (any type) must be from one of the newest 5 sessions. Else both type labels are `spread-not-measured` with the new reason `no-recent-chain`.
- The build loads the runs of the newest 25 sessions. A test checks that these sessions span at most 45 calendar days, the retention of the store.

#### Type label

In this order, for type `kind`:

1. The universe file says the fund has no listed options: `fail` with its reason (the same for both types).
2. The store has no Cboe fact of the fund: `spread-not-measured`, `no-chain-in-store`. The newest Cboe fact of any type is not from the newest 5 sessions: `spread-not-measured`, `no-recent-chain`.
3. No Cboe fact of type `kind` in the lookback: `spread-not-measured`, `no-chain-in-store`.
4. From the newest Cboe fact of any type: `stale-chain` (its file timestamp is more than 4 New York days before its own fetch time), `no-standard-contract` (`fail`).
5. From the newest Cboe fact of type `kind`: `no-window-expiry` (the chain does not list the session expiry of its run), `open-interest-below-minimum` (`fail`).
6. The 2 newest judged sessions of type `kind` in the lookback. Fewer than 2: `spread-not-measured`, `fewer-than-2-judged-sessions`.
7. A fail reason in either session: `fail` with those reasons. Else `pass`.

The type of a session is `expiry_type` of its session expiry. The 2 judged sessions of a type are usually 2 sessions next to each other with the same expiry.

#### Duplicate Cboe files

Cboe rewrites the delayed file of a fund only a few times per day. Two runs can therefore read the same file (the same file timestamp). As in stage 1, a Cboe file counts as a read only in the first session that reads it. A file counts for a session only when its quote time is inside the entry hours of that session, and a run folder holds the runs of one New York day. So a run of an earlier session cannot hold a file of a later session, and the build loads exactly the lookback.

#### Session diagnostics

Over the quotable counted reads of the session source; rounded to 4 decimals; null when no such read exists:

- `worstReadPct`: the highest half spread.
- `readRangePct`: the highest minus the lowest half spread (null with fewer than 2 such reads).
- `medianWidthUsd`: the median of the reads' median dollar widths. The median dollar width of one read is the median of the dollar widths of its measured contracts.
- `expiryType`: the expiry type of the session expiry.

No rule reads them. The session result, the 4% limit and the cheap band rule are those of stage 1. The cheap band of a type label uses the judged sessions of that type.

### The result document

`gate-v2.json` keeps `schema: "leveraged-etf-option-gate-v2"` and adds `schemaRevision: 2`. The schema string names the gate version (2), which does not change; the revision names the document shape. Stage 1 documents have no `schemaRevision`; a reader checks the field. Nothing in the repository reads the document.

| Field | Content |
| --- | --- |
| `gate` | `GATE_V2`: `sessionLookback` 25 and the new `freshSessions` 5 |
| Reasons | New `no-recent-chain` (see "Type label") |
| `funds[].typeLabels.monthly`, `.weekly` | `{label, reasons, inCheapBand, judgedSessions, facts}`. `judgedSessions`: the days of the judged sessions of the type in the lookback (at most 2, newest first). `facts`: the newest Cboe fact of the type (`chainFileTimestamp`, `chainFetchedAt`, `sessionExpiry`, `hasExpiry`, `bandOpenInterest`, `spot`) or null |
| `funds[].facts` | As in stage 1: the newest Cboe fact of any type. The freshness, `stale-chain` and `no-standard-contract` come from it |
| `funds[].optionGate`, `optionGateReasons`, `inCheapBand` | Removed (G2) |
| `funds[].sessions[]` | Adds `expiryType`, `worstReadPct`, `readRangePct`, `medianWidthUsd`. The sessions of all loaded runs, newest first |
| `funds[].sessions[].reads[]` | Adds `medianWidthUsd` |
| `counts` | `byType.<kind>`: `byLabel`, `byReason`, `cheapBand`; and, as in stage 1, `judgedSessionsBySource`, `countedReadsBySource` |

`gate-v2.md` shows the counts per type, the cheap band per type, and per fund both type labels with their judged days next to the sessions.

### Operation

- The timer `vertex-leveraged-etf-spreads.timer` stays as it is. The collector runs from its own checkout on the rig (`~/Github/trading/vertex-research-public-spreads-runner`), which this change does not update. The collector uses `session_expiry`, `cboe_observation`, `yahoo_observation` and `GATE_V2["minBandOpenInterest"]`, which do not change; `test_leveraged_etf_spread_reads.py` guards them.
- A person runs the build by hand after the last run of the day, as in stage 1. A build of the 4 sessions took 5 seconds on the rig.

### Entry criteria of stage 3

Stage 3 (the result in Postgres) starts when both hold: a reader of the type labels exists (the study charging the measured spread, or a page), and the session-rule review is done.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| A type label can be up to about 5 weeks old: a monthly label always between monthly blocks, a weekly label when its recent sessions are not judged. | Each type label lists its judged days. The freshness check makes both labels `spread-not-measured` (`no-recent-chain`) when the collector stops. |
| A fund changes (a stale file, a reverse split) while its last monthly run is old. | The fund-wide facts come from the newest fact of any type. |
| A special closure (not in the holiday list) shifts an expiry. | As in stage 1: the calendar decides; the market check stops the run of such a day. |
| The new field of `ExpiryMeasure` changes version 1 output. | The field has a default, and version 1 writes its document field by field. The shared version 1 fixture test runs unchanged and passes. |
| The rig disk `/home` has 4.3 GB free (df shows 100%). | The store needs about 0.3 GB (45 days of about 10 MB per session). A full disk makes runs incomplete and labels `spread-not-measured`; it does not make a `fail`. |
| A build for a past day after the store deleted its runs. | The `runs` list of the result shows which runs were used. AC1 is reproducible until 2026-12-31 (retention). |
| Security. | The build reads local files only, has no network and no secret, and validates fund symbols before it uses them as file names (stage 1). No engine reads the result. |

## Alternatives Considered

### Alternative A: Postgres rows in `leveraged_etf_universe` now (the stage 2 card plan)

- **Pros**: The version 2 labels replace the version 1 labels in Postgres.
- **Cons**: The table has no reader. The CHECK constraints of `0068_leveraged_etf_universe` need values that version 2 does not have. The result does not hold the fund identity (name, product type, leverage, exchange). A newer version 1 document would replace version 2 rows without a new database guard.
- **Reason for Rejection**: [AGENTS.md](../../../AGENTS.md) rule 12 says to add infrastructure "only for a current requirement". "Postgres first" applies when data is stored; no reader needs this data yet, and the rule can change at the session-rule review.

### Alternative B: A new table with the sessions as jsonb

- **Pros**: The version 1 table and its checks stay as they are; a version 1 document cannot replace version 2 rows because the tables are separate; rollback is a table drop.
- **Cons**: A second import command and its tests for no reader.
- **Reason for Rejection**: Deferred to stage 3, where it is the starting design.

### Alternative C: A full TypeScript copy of the rule with a shared fixture

- **Pros**: An import could check the labels before a write, as version 1 does.
- **Cons**: The import has no NYSE calendar; the document has no raw quotes to rerun the counted reads; Python and JavaScript round differently at halves.
- **Reason for Rejection**: No import step exists in stage 2 to run the check.

### Alternative D: One label per fund for the next traded session

- **Pros**: One field to read.
- **Cons**: The label still changes with the build day (the Tuesday of a monthly week gives the weekly label); the study is a backtest and trades both types.
- **Reason for Rejection**: The reader knows its trade day; it picks the type label.

### Alternative E: A third expiry type for holiday weeks

- **Pros**: Judges holiday weeks apart from ordinary weeks.
- **Cons**: The check above shows a larger type effect than holiday effect; more sessions are needed per label.
- **Reason for Rejection**: The holiday state of a session follows from its day and expiry, which the result stores; a split later needs no new data.

### Alternative F: Frozen per-session records instead of a full recompute

- **Pros**: Each session is computed once.
- **Cons**: A record format with its own version; records must be recomputed when the session-rule review changes the rule.
- **Reason for Rejection**: A full build reads 25 sessions; the 4-session build took 5 seconds.

### Alternative G: The collector also stores and reads the next monthly expiry

- **Pros**: A fresh monthly measure every session, for every candidate.
- **Cons**: More Cboe requests and stored chains per run (about 20 MB more per weekly day), a change of the collector unit and its tests, and a monthly measured at a different time to expiry than the study trades.
- **Reason for Rejection**: The study trades the session expiry; the type labels already give the monthly result from the monthly sessions.

### Alternative H: Buckets by sessions to expiry instead of the expiry type

- **Pros**: Separates time to expiry from the type.
- **Cons**: More buckets, fewer sessions per bucket; Q1 chose the expiry type.
- **Reason for Rejection**: Q1.

## Non-Functional Requirements

- The build has no network access, and the rule reads no clock (stage 1).
- `spread_gate.py` imports the standard library and `liquidity.py` only; `liquidity.py` loads `qc_ports/calendar.py` by its file path.
- The output of the version 1 universe fetcher does not change.
- The collector and its timer do not change.

## Additional Resources

- Stage 1 design: [leveraged-etf-option-gate-v2.md](leveraged-etf-option-gate-v2.md).
- First result, charts, knowledge-base record and EGM review reports: job folder `~/Documents/reports/web/vertex-leveraged-etf-gate-v2/stage2/` on the rig.

## Future Improvements

- **Stage 3, Postgres**: see "Entry criteria of stage 3"; starting design Alternative B.
- **Study cost from the gate**: the study charges the measured half spread or dollar width of the fund instead of a flat 4%.
- **Session-rule review** after 10 sessions.

## Acceptance checks of stage 2

- **AC1 (G1, G3).** The build `--as-of 2026-11-19` on the store of the rig writes `schemaRevision` 2; for TQQQ a monthly type label `pass` with judged sessions 2026-11-17 and 2026-11-16, and a weekly type label `fail` with `spread-above-maximum` (2026-11-19, 2026-11-18); each session has `expiryType`, `worstReadPct`, `readRangePct` and `medianWidthUsd`.
- **AC2 (G1).** In the same build, the 403 funds whose weekly fact does not list 2026-11-27 and whose newest chain is current have a weekly `fail` with `no-window-expiry`; their monthly type label comes from the monthly facts.
- **AC3 (G1, G3).** Unit tests cover the expiry type (2026-11-20, 2026-11-27, 2026-06-18, 2025-04-17), the lookback coverage and retention for 2026 and 2027, the freshness check, the fund-wide facts from the newest fact of any type, the per-type facts, and the diagnostics (including `readRangePct` null with 1 quotable read).
- **AC4 (G2, G4).** Tests of the document: `schemaRevision`, `typeLabels` with per-type facts and judged days, no fund-level label, `counts.byType` with the cheap band per type, the markdown header, counts and fund columns.
- **AC5.** The version 1 universe fixture test (`test_leveraged_etf_universe.py`) passes unchanged.
- **AC6.** The CI job `Verification (core)` (Python research tests) passes on the PR head, and a fresh-context code review of the diff has no open finding.

## Detailed Implementation Plan

### Target Files to Create/Modify

| File | Change |
| --- | --- |
| `docs/specs/research/leveraged-etf-option-gate-v2-stage2.md` | Create: this design. |
| `services/research/strategies/leveraged_etf/liquidity.py` | Modify: `_nyse_holiday_rule()` becomes `_nyse_calendar()` and returns the loaded module; `is_nyse_holiday` and the new `monthly_expiration` are taken from it. `ExpiryMeasure.median_width: float \| None = None`; `expiry_measure` sets it to the median of `ask - bid` of the measured contracts, rounded to 4 decimals. |
| `services/research/strategies/leveraged_etf/spread_gate.py` | Modify: `GATE_V2["sessionLookback"] = 25`, new `GATE_V2["freshSessions"] = 5`; new reason `no-recent-chain` in `REASONS_V2` after `no-chain-in-store`; `EXPIRY_TYPES = ("monthly", "weekly")`; new `expiry_type(expiry: date) -> str`; `Read.median_width: float \| None = None` (set in `counted_reads` from `measure.median_width`); `SessionResult` adds `expiry_type: str \| None = None`, `worst_read_pct`, `read_range_pct`, `median_width: float \| None = None` (set in `session_result`); `judged_sessions(sessions, build_day, kind)` keeps the sessions whose `expiry_type(session.expiry) == kind`; `fund_label(listed, universe_reasons, newest, facts, sessions, build_day, kind)` follows "Type label". |
| `research/backtests/leveraged-etf/gate_v2.py` | Modify: `SCHEMA_REVISION = 2`; `read_store` loads `sessions_back(build_day, GATE_V2["sessionLookback"])`; `read_entry` and `session_entry` write the new keys; new `newest_run(symbol, runs, kind=None) -> Run \| None`, `facts_entry(symbol, run)` and `type_label(fund, runs, sessions, build_day, kind)`; `fund_entry(fund, runs, build_day)` writes `facts` and `typeLabels`; `counts_of` writes `byType`; `build` writes `schemaRevision`; `markdown` and `main` show the counts per type. |
| `services/research/tests/test_leveraged_etf_spread_gate.py` | Modify: tests of AC3; the existing label tests use sessions of one type. |
| `services/research/tests/test_leveraged_etf_gate_v2.py` | Modify: tests of AC4; the shared store fixture keeps its monthly runs, and the per-type tests add weekly runs. |
| `research/backtests/leveraged-etf/README.md` | Modify: the type labels and the reader contract. |
| `docs/specs/research/leveraged-etf-option-gate-v2.md` | Modify: "Overview", "Non-Goals", Alternative A, "Operation" and "Future Improvements" point to this design (stage 2 is the type labels; Postgres is stage 3). |
| `docs/vertex-rebuild/leveraged-etf-universe.md` | Modify: the version 1 labels stay until stage 3. |
| `CHANGELOG.md` (repository root) | Modify: one entry. |
| `services/research/tests/fixtures/leveraged_etf/universe-document.json` | Must not change (AC5). |

### Order of work and commits

1. The rule, the build, their tests, the docs and the changelog in one commit (the signatures change together).
2. Fixes of the code review in a second commit.

### Verification Plan

- In `services/research`: `uv run --no-project --python 3.12 --with pytest --with pydantic python -m pytest -q tests/test_leveraged_etf_spread_gate.py tests/test_leveraged_etf_gate_v2.py tests/test_leveraged_etf_universe.py tests/test_leveraged_etf_spread_reads.py`. The parity test and the study tests need numpy and pandas; CI runs them with `requirements-linux-py312.lock`.
- AC1 and AC2: `uv run --no-project --python 3.12 python research/backtests/leveraged-etf/gate_v2.py --store ~/.local/share/vertex/leveraged-etf-spreads --universe ~/.local/share/vertex/leveraged-etf-spreads-universe.json --as-of 2026-11-19 --out ~/Documents/reports/web/vertex-leveraged-etf-gate-v2/stage2/build-s2-20261119`, then check the TQQQ entry and count the weekly `no-window-expiry` reasons.
- CI: the job `Verification (core)` runs the Python research tests; the numeric lane runs the parity test.
