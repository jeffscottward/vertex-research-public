# Stage 9: Implementation readiness

## egm-implementation-readiness

## Stage 9 Implementation Readiness review of `research/backtests/stoploss-premium/design.md`, lines 133–155

**Verdict: the plan does not meet `implementation-readiness-standard.md`.** The section lists files and gives a run command. But a new engineer working only from it would have to make many design choices. Its file list is incomplete for a write allowlist, it has no phases or checkpoints, and its test plan names no test cases.

The code has already been written (`git status` shows it untracked in the worktree). Comparing it with the plan shows that many decisions were made in code without being recorded in the design.

---

### 🔴 Blocker 1: the file list is not a complete write allowlist (lines 135–151)

- The table leaves out files the work actually touches:
  - `research/backtests/stoploss-premium/run.py` is named in prose (line 136) but is not in the table, and nothing describes its job.
  - `services/research/strategies/stoploss_premium/__init__.py` exists (6 lines) but is not listed.
  - `services/research/tests/ci-suites.txt` was changed (`+tests/test_stoploss_premium.py`). Line 151 only hints at this with "(CI base suite)"; the file is not named.
- No row says whether its file is created, modified or deleted.
- The generated output (`results.json`, `index.html`, `test-<id>-premium.png`, `test-<id>-curves.png`, and an optional `intro.html` that is read if present) has no path or glob. Line 155 just says "one premium chart and one curve chart per test".
- **Fix:** list every file, repository-relative, with create/modify. Add the `ci-suites.txt` one-line change, and give the output-name glob `test-[a-h]-{premium,curves}.png`.

### 🔴 Blocker 2: no test plan (line 151)

- "Hand-computed fixture tests" names no cases. The standard requires specific happy-path and edge-case tests.
- The code has about 37 tests (for example verdicts, bootstrap reproducibility, implied stopped return, value-weighted aggregation, ladder fills, window stop, entry proxies, CSP stop/roll on a crash, brake). None of them is in the plan, and neither are their expected values.
- **Fix:** list the tests per module, with inputs and expected outputs. At minimum:
  - one per verdict branch (not enough data / adds return / paid insurance / fail / inconclusive);
  - bootstrap with seed 7 reproducible;
  - total-return scaling;
  - rf carried forward;
  - intrinsic value on the expiry session;
  - the loser close firing at T−3;
  - premium stop at 50%;
  - CSP roll-for-credit and the no-credit case (hold to expiry);
  - brake at 10% and at 15%;
  - report page with one table per test.

### 🔴 Blocker 3: decisions left to the implementer (zero-decision rule)

Lines 140–150 give only a list of things per file. The following choices are made in code but appear in neither the detailed plan nor the feature range:

| Area | Decision found only in code | Where in code |
| --- | --- | --- |
| Test D 45-day structures | 30–60 DTE window with target 45; call at delta 0.50; spread long 0.50 / short 0.30, skipped when `k2 <= k1` | `study.py` `make_call45` / `make_spread45` |
| Option model | `MIN_IV = 0.08`; default skew slope −0.20; expiry falls back to the previous session on a holiday | `options.py` |
| Test F (CSP) entry | nearest 38 DTE inside 30–45; \|delta\| nearest 0.25 inside 0.15–0.30; minimum credit $0.10; sell at bid, buy back at ask; roll strike = lowest strike at or below the current one whose bid covers the buy-back ask | `csp.py` |
| Test A ladder rungs | rung 1 = highest of today's low and the 5-day low ≥1% below; rung 2 = 20-day low; rung 3 = min(50-day average, 2-bar swing low within 120 bars), at most 15% deep; rungs ≥0.25 × ATR apart; live put-OI levels dropped | `shares.py` |
| Test B ladder | nearest rung "at least half-way to the stop" | `optiontests.py` |
| Test G/H books | weight capped at 15% per name; risk 1% → 0.5%; rotation top 8; "falling 200-day" = lower than 10 sessions ago; 3- and 6-month relative-strength percentile; trend ATR over 20 days, rotation over 14 | `books.py` |
| Sample starts | A from 2000-01-03, F from 2011-01-03, G/H from 1999-12-31; option entries from 2005 | `study.py` |

Line 104 of the feature range says "0.25 delta, 30-45 days", which does not match the code's 0.15–0.30 / nearest-38 rule.

- **Fix:** add a per-module constants and algorithms table to the detailed plan, with the value and the source file in market-watch-bot (or "our choice") for each.

### 🟡 Major 4: ports name no source (lines 143, 146, 148)

- "`compute_levels` port" and "`ladder_levels` port" do not say which file or which commit is being ported. The live engines are not in this repository (grep finds no definitions outside `stoploss_premium`).
- The code docstrings name the paths:
  - `market_watch/reentry/harness.py` and `stops.new_ladder`
  - `market_watch/reentry/leaps.py`
  - `market_watch/copyrot/trend.py`
  - `market_watch/copyrot/rotation.py`
  - `market_watch/risk/__init__.py`
  - `market_watch/income/rules.py`
  - `market_watch/exit_rule.py`
- **Fix:** list each port with its source path and a pinned market-watch-bot commit, plus the parts left out on purpose.

### 🟡 Major 5: no signatures, data structures or output schema (lines 140–150)

- These are named but not defined: `Legs`, `PathReturns`, `Data`, `Underlying`, `Trade`, `Leg`, `EntryTrade`, `BookResult`, `Entry`. So are `aggregate(calendar, rf, paths, *, lo, hi, value_weighted, exposure)`, `evaluate`, `summary`, `verdict` and `insurance_cost`.
- The schema of `results.json` is unspecified. In code it is `generatedAt`, `code{commit,dirty}`, `dataDir`, `dataEnd`, `inputs{file: sha256}`, `seconds`, and `tests{id: {id, title, prices, universe, variants[{name, note, summary, thresholds, verdict, insuranceCost, drawdownCut, curve}]}}`.
- The `prices` label values (`"model price"` / `"real"` / `"none"`) are not specified either; the chart code depends on the exact string `"model price"`.
- `report.py` "the method text" has no content source.
- **Fix:** add a section on types and the output schema.

### 🟡 Major 6: the input data contract is missing (lines 141, 153–154)

- `--data <data dir>` is a placeholder. `run.py`'s own docstring uses `~/Documents/reports/web/vertex-calendar-spread-nautilus/data`, while line 51 says "qc-ports / options-forms data directory". The two do not agree.
- The loading rules are undocumented:
  - one `<SYM>.csv` per symbol with columns `date, open, high, low, close, adj_close`;
  - index files `<IDX>.csv` with `date, close`;
  - files skipped: names containing `=`, `.splits.csv` and `SHILLER`;
  - names below `WARMUP` rows dropped;
  - the calendar is taken from SPY's dates;
  - the universe is "every CSV in the folder", not a pinned 97 + 31 list.
- Test E's input (`--crown-dir`, default `~/.local/share/crown-cli`, reading `desk-notes.json` and `blotter.jsonl`, regex `close[sd]? (below|under)`) is not mentioned.
- **Fix:** specify the file naming, columns and filters.

### 🟡 Major 7: test E is not designed (line 103 against the code)

- The feature table promises a comparison: "Close when Crown's stated level breaks" against "Hold to the exit rule".
- The code's `test_e` only counts notes and trades, and always returns the verdict "not enough data".
- The detailed plan says nothing about how E is computed. **Fix:** state that E is a data count with a fixed verdict, or specify the comparison.

### 🟡 Major 8: no phases or checkpoints (lines 133–155)

- The standard requires phases that each leave the code buildable and testable.
- **Fix:** split into phases such as:
  1. `premium` and `bars` with their tests;
  2. `portfolio`, `shares` and test A;
  3. `options`, `entries`, `optiontests` and tests B–D;
  4. `csp` and test F;
  5. `books` and tests G/H;
  6. `study`, `report`, `run.py` and the CI listing.

### 🟡 Major 9: "No new dependency" contradicts the run command (lines 135 and 153)

- Line 135 says "pure Python, no new dependency", but the run command pins `pydantic==2.13.4` and `matplotlib==3.10.7` with `--no-project`.
- matplotlib is used by `run.py`'s `charts`. pydantic is never imported by the study code. It is probably needed only because `strategies/__init__.py` imports `.core` and other modules, which `strategies.qc_ports.options` pulls in; this is not explained.
- **Fix:** state that the package itself has no new dependency, that `run.py` needs matplotlib, and why pydantic is pinned. Also confirm the CI base suite needs neither.

### 🟢 Nit 10: undocumented CLI options and guards (lines 153–155)

- The plan does not mention:
  - `--tests` (default `B,A,C,D,G,H,F,E`), `--crown-dir`, `--allow-dirty`;
  - exit code 2 when the study code is uncommitted;
  - exit code 2 when `--out` is inside the repository.
- These are behaviour an implementer would otherwise have to invent.

### 🟢 Nit 11: the runtime claim is unbacked (line 155)

- "about 5 minutes" has no stated hardware or measured basis.

### 🟢 Nit 12: unexplained directory

- `research/backtests/stoploss-premium/review/` exists (empty) and is in neither the plan nor the file list.

## egm-codebase-details

## Stage 9 Implementation Readiness review: `research/backtests/stoploss-premium/design.md`, Detailed Implementation Plan (lines 133-155)

**Verdict: the plan fails the Implementation Readiness Standard.** I found 4 blockers, 9 majors and 4 nits. The document says the work is already implemented (line 3). Measured against that code, the plan contradicts what is there in four places, leaves out the CLI and file contracts, and has no phasing and no test cases.

The code changes while I review it. `run.py` and `report.py` were saved at 17:01:45, after `design.md` was saved at 17:00:46. My findings use the state at 17:03.

---

## 🔴 Blockers

### 1. The "method text" in `report.py` contradicts the design and the code (line 147, and lines 66-68 / 112)

- The plan says `report.py` holds "the method text".
- `report.METHOD_HTML` says: "Option books commit 100% of their capital to premium … so their volatility and drawdowns are per unit of premium."
- The design (lines 66-68, and the Decisions table at line 112) says 25% premium and 75% T-bills.
- The code agrees with the design: `study.OPTION_BOOK = {"value_weighted": True, "exposure": PREMIUM_BUCKET}` with `PREMIUM_BUCKET = 0.25`.
- So the published report page states a false method.
- Two smaller differences in the same text:
  - The half-spread is given as "3% for stocks, the qc-ports table for ETFs". It omits the 2% for other ETFs (`options.ETF_HALF_SPREAD`).
  - The realized volatility omits the 20-day / 60-day tenor split (`LONG_TENOR_YEARS = 0.5`).

### 2. The output list contradicts `run.py` (line 155)

- The plan says: "`results.json`, one premium chart and one curve chart per test, `index.html`".
- What `run.py` actually writes:
  - It also writes `summary.png` (`summary_chart`).
  - It puts a `report.overview(...)` table into the page intro.
  - `charts()` returns `[]` for a test with no `premium` in its summary, so test E gets no charts.
  - The curve chart is written only for variants that have a `curve`, and only for the first 6 of them (`[:6]`).
- `run.py` also reads an optional `<out>/intro.html` into the page. The plan does not mention it.

### 3. `study.py` does not "run each test" (line 146), and test E is not a backtest

- `study.test_e` simulates nothing.
- It returns a hard-coded `verdict: premium.NOT_ENOUGH`.
- Its `stopEvents` is a count of desk notes that match the regex `close[sd]? (?:below|under)` (`run.crown_counts`), not stop events and not the closed trades.
- The test table (line 104: "Close when Crown's stated level breaks | Hold to the exit rule") and Known limits (line 131: "test E has 8 closed trades") present E as a with/without comparison.
- The verdict is forced whatever the counts are.
- The inputs are not stated: the `--crown-dir` default `~/.local/share/crown-cli`, `desk-notes.json`, and the last line of `blotter.jsonl`.

### 4. "`results.json` records the SHA-256 of every input file" (lines 58-59) is false for `run.py`

- `run.manifest()` hashes only `data.glob("*.csv")`.
- These inputs are read but not hashed:
  - the Crown inputs `desk-notes.json` and `blotter.jsonl`
  - the optional `intro.html`
- The `results.json` schema itself is not specified anywhere in the plan: `generatedAt`, `code{commit,dirty}`, `dataDir`, `dataEnd`, `inputs`, `seconds`, `tests`.

---

## 🟡 Majors

### 5. The file boundary is not a usable write allowlist (lines 136-149)

- Paths are relative to the package directory. Only the test file has a repository-relative path.
- No path is marked `Create`, `Modify` or `Delete`.
- These real changes are missing:
  - `services/research/strategies/stoploss_premium/__init__.py` (created)
  - `services/research/tests/ci-suites.txt` (modified: `+tests/test_stoploss_premium.py`)
  - `research/backtests/stoploss-premium/run.py` (named only in prose at line 134, not in the table)
  - the `review/` directory

### 6. There is no phasing

- The standard requires incremental phases, each leaving the code buildable and testable.
- The plan is one flat file table.

### 7. The test plan has no cases (line 149)

- "Hand-computed fixture tests (CI base suite)" names nothing to implement.
- The existing file has 40 tests across `premium`, `bars`, `portfolio`, `shares`, `entries`, `options`, `csp`, `books` and `report`. The plan should list them.
- Nothing covers:
  - `study.py`: `evaluate`, `load`, `entry_list` with the 400-day end buffer, and `test_a`…`test_h`
  - `run.py`: the dirty-tree guard, the `--out`-inside-repository guard, `manifest`, and the `crown_counts` regex

### 8. The `run.py` CLI contract is missing (lines 152-154)

- These parts of `run.py` are not in the plan:
  - `--crown-dir`, with default `~/.local/share/crown-cli`
  - `--tests`, whose default order is `B,A,C,D,G,H,F,E` rather than A-H
  - `--allow-dirty`
  - exit code 2 when the watched paths are uncommitted
  - exit code 2 when `--out` resolves inside the repository
- The run command uses a `<data dir>` placeholder, while the `run.py` docstring gives the actual path `~/Documents/reports/web/vertex-calendar-spread-nautilus/data`. An implementer has to guess which.

### 9. The "pure Python, no new dependency" claim does not match the run command (lines 133, 153)

- `matplotlib==3.10.7` is new. No other runner under `research/backtests/*/run.py` uses it, and it is not in `services/research/pyproject.toml` or the lockfiles.
- `pydantic==2.13.4` is required for an unstated reason. Without it, importing `strategies.stoploss_premium` fails with `ModuleNotFoundError: pydantic`; the traceback ends in `strategies/__init__` → `backtesting/manifest.py`.
- Choosing a dependency is a decision the plan must record, together with its reason.

### 10. Reuse: `options.py` and `bars.py` build a second set of conventions, which the Decisions table rules out (line 111: "no second convention")

- **Strike grid.** `strike_for_delta` uses steps of 0.5 / 1 / 5 (with a $200 break). `qc_ports.options.strike_step` uses 0.5 / 1.0.
- **IV index gaps.** `Underlying.atm` carries the last IV-index level forward without limit (`bisect_right`). `qc_ports.data.align` stops after `MAX_FILL_DAYS = 5`; it was written for the VXSLV gaps.
- **Expiries.** `options.third_friday` / `monthly_expiries` ignore NYSE holidays. `qc_ports.calendar.monthly_expiration` / `expirations_after` exist and handle them. As a result, `years()` uses the holiday Friday.
- **Copied code that could be imported:**
  - `options.smile` copies `qc_ports.options.smile_iv`, with the literal values 3.0 and 0.5 in place of `SKEW_CLAMP` / `SKEW_FLOOR`.
  - `MIN_HALF_SPREAD` is redefined although `qc_ports.options` already has it.
  - The intrinsic value is reimplemented in `leg_mid`.
  - `bars.load_bars` / `load_index` parallel `qc_ports.data.load_bars` / `load_series`.

### 11. The ports are not identified and not exact

- The plan says "`compute_levels` port" and "`ladder_levels` port" but names no source.
- The sources are in the separate `market-watch-bot` repository, and no commit is pinned (current HEAD is `57a1b3b`). The modules involved:
  - `market_watch/reentry/harness.py`
  - `reentry/leaps.py`
  - `copyrot/trend.py` and `copyrot/rotation.py`
  - `risk/__init__.py`
  - `income/rules.py`
  - `exit_rule.py`
  - market-watch-bot `market_watch/research/backtests.py`
- `ladder_levels` matches its source line for line.
- `shares.compute_levels` differs from its source in three undocumented ways:
  - It drops the 2-decimal rounding.
  - It drops the `invalid level order` check.
  - It drops the put open-interest inputs. This is noted only in the `shares.py` docstring, not in the design.

### 12. An unstated edge case weakens fixed test 2

- When a variant has no threshold legs, `study.evaluate` calls `verdict(s, [s["premium"]])`. The −25%/+25% robustness requirement is then met by the base Δμ itself.
- This affects the test C T−1 and T−5 rows.
- Such a row can be labelled "pass: adds return" even though its note says "no threshold check".

### 13. The `study.load` data contract is undocumented

- `SPY.csv` is required (the calendar is SPY's dates, otherwise a `KeyError`).
- Names with 260 rows or fewer (`WARMUP`) are dropped.
- Every CSV that is not in `ETFS`, not an index file, and has no `=` in its name is treated as an SP100 stock.
- `*.splits.csv` and `SHILLER` are skipped.
- `VIX3M`, `VIX6M` and `TNX` are loaded but never used.
- The plan's "CSV loading" row (line 138) gives none of these rules.

---

## 🟢 Nits

**14. The direction of the sufficient-condition test is not stated (line 137).** The code uses `met = rho >= sharpe`; the plan only says ρ "against" the Sharpe ratio. Books (G and H) take their step from the median of `days_to_stop`, which is also not stated.

### 15. Duplicated helpers

- `premium.max_drawdown` duplicates `qc_ports.metrics.max_drawdown` and `sma_timing.max_drawdown`.
- `bars.month_ends` parallels `sector_rotation.month_ends`.

**16. Exit valuation at expiry is ambiguous.** At the expiry session, `optiontests.path` exits at `bid()`, which is the intrinsic value minus the half-spread and commission. Lines 61-62 say a position "is worth its intrinsic value", which reads as if no cost applies.

**17. Unverifiable figures.** "Runtime about 5 minutes" (line 155) and "32,851 entries" (line 90) depend on the data, so they cannot be checked from the repository.
