# Flow control signals: implementation plan for pull request 3 (continuation study)

- **Author:** Jeff Scott Ward
- **Status:** Reviewed and resolved (2026-11-16)
- **Date:** 2026-11-15

This plan lists the file changes of pull request 3 of [design.md](design.md) (Technical Plan, sections 9 and 10). Research only: the study places no order and its verdict gives no trading authority.

## Detailed Implementation Plan

Path rule: `bun run docs:check` (`scripts/docs/docs.ts:316-426`, `findBrokenDocPaths`) rejects an inline code span that looks like a repository path and names no tracked or git-ignored file. A file that does not exist yet is therefore written with `(new)` after a space inside the same code span; the space matches `NOT_A_PATH` (line 320), so the checker skips the span. Files of pull requests 1 and 2 carry `(PR 1)` or `(PR 2)` in the same way. The suffix is a notation of this plan only: it is never part of a value written to code, SQL or the spec, and the commit that creates a file removes the suffix from this plan.

### PR 3: Options-side continuation study (offline) and Strategy Library entry

Read in the checkout at `1e175b7a`:

- Precedent: Trend Trio shipped as a code commit (`accbb474`: package, runner, README, tests, suite lists), then a run on the research machine, then a results commit (`3f5aa32e`: migration 0073, journal, snapshot, rollback, two tests, spec results). This plan keeps that order.
- The newest migration on the branch is `0076_research_screen` (`packages/db/migrations/0076_research_screen.sql`, `packages/db/migrations/meta/_journal.json`).
- Python files are not in the Vitest coverage gate: `scripts/ci/research-python.sh` runs pytest without a coverage option, and `services/research/tests/ci-suites.txt` must list every test file (`docs/testing.md:119`). Each new Python module below names its test file. No tool measures Python branch coverage, so the reviewer checks each test list against the branches of the module. "Core lane, base run" below means the suites of `services/research/tests/ci-suites.txt` in the environment without nautilus-trader (`docs/testing.md:119-121`).

Inputs from pull requests 1 and 2 (not in the checkout; fixed in `plan-pr1.md` and `plan-pr2.md` of this design):

- `packages/api/src/flow-control-rules.ts (PR 1)` exports `FLOW_CONTROL_RULES` (`version`, `windowMinutes` 30, `enterRatio` 0.30, `exitRatio` 0.10, `minMinutes` 5, `minBuckets` 10; no other field), `optionsRatio`, `foldControlState(minutes, rules)`, `groupOptionsState` and `FLOW_CONTROL_STUDY_RULES_ITEM = "Rules version"`.
- The committed fixture `packages/api/src/fixtures/flow-control-golden.fixture.json (PR 1)` has the shape `{ schemaVersion: "flow-control-golden.v1", studyRulesItem, filterProfile, netDriftRequests: { total, zero_dte }, rules, optionsCases, groupCases }`. `optionsCases[i]` is `{ name, rules?: { windowMinutes }, minutes: [{ minute, netCallPremium, netPutPremium }], expected: [{ minute, ratio, state, noDataReason, sinceMinute }] }` (`minute` counts from 09:30 New York; a missing minute is a gap; one expected entry per minute). `groupCases[i]` is `{ name, primary, check, expected }`. `netDriftRequests` holds the two full POST bodies for `sessionDate` `"YYYY-MM-DD"` and ticker `"T"`: `total` (no `dte` filter) and `zero_dte`. Pull request 3 only reads this file.
- Table `flow_net_drift` of pull request 1: `ticker`, `part` (`total` or `zero_dte`), `minute timestamptz`, `net_call_premium`, `net_put_premium`, `net_call_volume`, `net_put_volume`, `underlying_price`. Table `flow_large_trades` of pull request 2: `symbol`, `second timestamptz`, `seq`, `side` (`buy` or `sell`), `size`, `price`.
- Gates: commit 2 starts only after pull request 1 is merged into the base branch (the fixture and the rules module are its inputs). Commit 7 takes the next free migration number at build time (`CONVENTIONS.md:90-92`). The expected number is 0080: `0076_research_screen` exists, pull request 1 takes 0077 and pull request 2 takes 0078 and 0080 (design section 9); this plan writes 0080. With another number at merge time, replace 0080 in entries 24 to 29 and 32; no test names a neighbour's tag.

Values chosen by this plan:

- Study id and slug `flow-control-continuation`. Data folder `~/Documents/reports/vertex-flow-control-data` (override: environment variable `VERTEX_FLOW_CONTROL_DATA` or `--data`). Report folder `~/Documents/reports/web/vertex-flow-control-continuation/run` (`--out`). Both are outside the repository.
- The study tests the options side only, with modelled fills. No text of the study claims a test of the futures and options agreement.
- "Out-of-sample part" means the validation part and the test part together, without the window-choice sessions (entry 8).

#### 1. `services/research/strategies/flow_control/__init__.py (new)` (Create)

- **Type / Scope**: Python package marker.
- **Proposed Changes**: an empty file, same as `services/research/strategies/trend_trio/__init__.py` (0 lines).

#### 2. `services/research/strategies/flow_control/control.py (new)` (Create)

- **Type / Scope**: pure module. Python port of the options side of `packages/api/src/flow-control-rules.ts (PR 1)`. No file or network access.
- **Proposed Changes**:
  - `@dataclass(frozen=True) class ControlRules`: `version: str`, `window_minutes: int`, `enter_ratio: float`, `exit_ratio: float`, `min_minutes: int`, `min_buckets: int`; method `to_json() -> dict` with the TypeScript key names.
  - `RULES = ControlRules("flow-control-rules.v1", 30, 0.30, 0.10, 5, 10)`. It equals the fixture `rules`.
  - `@dataclass(frozen=True) class DriftMinute`: `minute: int` (minutes after 09:30 New York), `net_call_premium: float`, `net_put_premium: float` (expiry part `total`). `@dataclass(frozen=True) class ControlStep`: `minute: int`, `ratio: float | None`, `state: str` (`buyers`, `sellers`, `balanced`, `no_data`), `no_data_reason: str | None` (`session_start`, `gap`), `since_minute: int | None`.
  - `options_ratio(window: Sequence[DriftMinute]) -> float`: sum of (call minus put) divided by sum of (absolute call plus absolute put); `0.0` when the divisor is 0.
  - `fold_control_state(minutes: Sequence[DriftMinute], rules: ControlRules) -> list[ControlStep]`: same argument order and statement order as `foldControlState`; "Pseudocode A" below is the normative text. The reason `stale` and the rule "leave out the minute in progress" exist only in the live reader; in the study every minute is closed, so neither has an effect here.
  - `group_options_state(primary: str, check: str) -> str`: `no_data` when the primary is `no_data`; `mixed` when primary and check control opposite sides; else the primary state (a check ticker without data leaves it).
  - Equality with TypeScript is checked on the golden vectors: the Python test replays every case of the fixture and must give the same `ratio` (absolute difference at most `1e-12`), `state`, `noDataReason` and `sinceMinute`. Pull request 1 asserts the same file from TypeScript. The fixture cases are the acceptance test of the port.
  - Test file: `services/research/tests/test_flow_control_control.py (new)`.

Pseudocode A (`fold_control_state`; the algorithm of the rules module entry of `plan-pr1.md` with the no-data reasons of design section 5; the fixture cases decide any difference):

```text
rows = minutes sorted by minute; last = largest minute of rows
state = balanced; since = None; buy_run = sell_run = 0; buy_start = sell_start = None
for m in 0..last:                                  # one step per minute, gaps included
  window = rows with m - windowMinutes < minute <= m
  if count(window) < minBuckets:
    reason = session_start if m + 1 < minBuckets else gap     # minutes passed since 09:30 (design section 5, no-data reasons)
    emit(m, ratio None, no_data, reason, sinceMinute None)
    buy_run = sell_run = 0; next m                 # the carried state and since are kept
  ratio = options_ratio(window)
  if (state == buyers and ratio < exitRatio) or (state == sellers and ratio > -exitRatio): state = balanced; since = None   # equal to the exit limit keeps control
  if state == balanced:
    if ratio >= enterRatio: sell_run = 0; buy_run += 1; buy_start = m when buy_run == 1     # equal counts
    elif ratio <= -enterRatio: buy_run = 0; sell_run += 1; sell_start = m when sell_run == 1
    else: buy_run = sell_run = 0
    if buy_run == minMinutes: state = buyers; since = buy_start; buy_run = 0   # sell_run mirrors: sellers, sell_start
  emit(m, ratio, state, None, since)
```

#### 3. `services/research/strategies/flow_control/fomc.py (new)` (Create)

- **Type / Scope**: pure constant module. The repository has no historical FOMC calendar for Python: `grep -ri fomc services/research` matches no module, and the `event_calendar` feed keeps 30 days back only (`docs/vertex-rebuild/openbb.md:89`).
- **Proposed Changes**:
  - `FOMC_SOURCE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"`, `FOMC_READ_ON = "2026-11-15"`, `FOMC_YEARS = (2025, 2026)`. `FOMC_DECISION_DAYS: frozenset[str]` (second day of each scheduled meeting, read from the source page on 2026-11-15): `2025-01-29`, `2025-03-19`, `2025-05-07`, `2025-06-18`, `2025-07-30`, `2025-09-17`, `2025-10-29`, `2025-12-10`, `2026-01-28`, `2026-03-18`, `2026-04-29`, `2026-06-17`, `2026-07-29`, `2026-09-16`, `2026-10-28`, `2026-12-09`.
  - `is_fomc_day(day: str) -> bool`; raises `ValueError` for a year outside `FOMC_YEARS`, so a session of a year outside the list stops the run.
  - Test file: `services/research/tests/test_flow_control_rules.py (new)`.

#### 4. `services/research/strategies/flow_control/rules.py (new)` (Create)

- **Type / Scope**: pure module. The frozen study rule (trend rule, entry, exit) and the spec hash. Modelled on `services/research/strategies/trend_trio/rules.py:26-38` and `:295-308`.
- **Proposed Changes**:
  - `SPEC = <repo>/docs/specs/strategies/flow-control-continuation.md` (a `Path`), `SPEC_SHA256 = "<64 hex>"` (set in the same commit as the spec), `RESULTS_HEADING = "## Results"`, `spec_sha256(path: Path = SPEC) -> str`.
  - Constants, in minutes after 09:30 New York: `ENTRY_FIRST = 15` (09:45), `ENTRY_LAST = 120` (11:30), `ENTRY_LAST_LATE = 360` (15:30), `TIME_EXIT = 385` (15:55), `BARS = 386`, `TREND_LOOKBACK = 30`, `HARD_STOP_PCT = 0.40`, `OPEN_MINUTE_OF_DAY = 570`. Bar time rule: bar `b` of a session is the minute that opens at `ms_at(day, OPEN_MINUTE_OF_DAY + b)` (`services/research/strategies/imom/data.py:457`); `price[b]` is the vendor's `stockPrice` of the bucket with that key. A decision at the end of minute `m` reads buckets up to `m` and fills at `price[m + 1]`.
  - `@dataclass(frozen=True) class Params`: `window_minutes: int = 30`, `entry_last: int = ENTRY_LAST`, `skip_fomc: bool = True`. `@dataclass(frozen=True) class Session`: `day: str`, `price: tuple[float, ...]` (the instrument's price ticker; exactly `BARS` values, none missing; entry 5 guarantees this), `trend_price: tuple[float, ...]` (the same for the group's primary ticker, design section 10), `primary: tuple[DriftMinute, ...]`, `check: tuple[DriftMinute, ...]`. `@dataclass(frozen=True) class Trade`: `day: str`, `side: int` (+1 or -1), `entry_bar: int`, `exit_bar: int`, `entry_price: float`, `exit_price: float`, `exit_reason: str` (`state`, `stop` or `time`), `points: float` (`side * (exit_price - entry_price)`).
  - `trend(price: Sequence[float], minute: int) -> int`: +1 when `price[minute]` is above `price[0]` and above `price[max(0, minute - TREND_LOOKBACK)]`; -1 for the mirror; else 0. The rule calls it with `session.trend_price`; fills and the stop use `session.price`.
  - `group_states(session: Session, rules: ControlRules) -> list[str]`: `BARS` entries; entry `m` is `group_options_state` of the two fold steps at minute `m`; a minute after a ticker's last step counts as `no_data` for that ticker.
  - `session_trade(session: Session, params: Params) -> Trade | None`: "Pseudocode B" below. At most one trade per session (the first).
  - `trades(sessions: Sequence[Session], params: Params) -> list[Trade]`: skips days with `is_fomc_day` when `params.skip_fomc`; the control window comes from `dataclasses.replace(RULES, window_minutes=params.window_minutes)`.
  - `signal_arrays(session: Session, trade: Trade | None, side: int) -> tuple[list[int], list[int], list[int]]`: three lists of `BARS` values. Entry flag 1 at `entry_bar - 1` and exit flag 1 at `exit_bar - 1` (no exit flag for the reason `time`) when the trade has that side; all zero for `None` or the other side. The close flag is 1 at bar `TIME_EXIT` in every session.
  - Test file: `services/research/tests/test_flow_control_rules.py (new)`.

Pseudocode B (`session_trade`):

```text
states = group_states(session, rules); price = session.price; tp = session.trend_price
for m in ENTRY_FIRST..params.entry_last:
  side = +1 when states[m] == buyers and trend(tp, m) == +1; -1 when sellers and trend(tp, m) == -1; otherwise next m
  entry_bar = m + 1; entry_price = price[entry_bar]
  for k in entry_bar..TIME_EXIT - 1:
    if side * (price[k] / entry_price - 1) <= -HARD_STOP_PCT / 100: reason = stop
    elif states[k] != states[m]: reason = state
    else: next k
    return Trade(exit_bar = k + 1, exit_price = price[k + 1], exit_reason = reason)
  return Trade(exit_bar = TIME_EXIT, exit_price = price[TIME_EXIT], exit_reason = time)
return None
```

#### 5. `services/research/strategies/flow_control/data.py (new)` (Create)

- **Type / Scope**: loader for the downloaded files. Reads only under the data folder; never writes.
- **Proposed Changes**:
  - `DATA_ENV = "VERTEX_FLOW_CONTROL_DATA"`, `DEFAULT_ROOT = Path.home() / "Documents" / "reports" / "vertex-flow-control-data"`, `PARTS = ("total", "zero_dte")`, `FALLBACK_PARTS = ("zero_dte", "longer")`, `TICKERS = ("SPX", "SPY", "QQQ", "NDX")`, `FIELDS = ("netCallPremium", "netPutPremium", "netCallVolume", "netPutVolume", "stockPrice")`, `MAX_PRICE_CARRY_MINUTES = 5`, `MIN_TOTAL_MINUTES = 300`, `SKIP_REASONS = ("missing", "empty", "thin", "no_open_price", "missing_price")`. `class DataError(ValueError)`.
  - `bucket_path(root: Path, ticker: str, part: str, day: str) -> Path`: `<root>/net-drift/<TICKER>/<part>/<YYYY-MM-DD>.json`. This is the only line of the package that names a JSON file; it carries `# json-data-ignore: vendor download on the research machine, outside the repository; the app never reads it` (same mark as `services/research/strategies/trend_trio/study.py:529`).
  - `parse_part(text: str) -> dict[int, tuple[float, float, float, float, float | None]]`: the file is the vendor's `data` object; each key is epoch milliseconds as a decimal string and a multiple of 60000; each value has the five `FIELDS` as finite numbers (`stockPrice` may be null). Any other shape raises `DataError` with the key.
  - `@dataclass(frozen=True) class TickerSession`: `ticker: str`, `day: str`, `minutes: tuple[DriftMinute, ...]` (part `total`, minutes 0 to 389), `price: tuple[float, ...]` (`BARS` values), `derived_total: bool`, `files: tuple[Path, ...]`.
  - `read_ticker(root: Path, ticker: str, day: str) -> TickerSession | str` returns the session or one of `SKIP_REASONS`, tested in this order. `missing`: no `total` file and not both `FALLBACK_PARTS` files; with the `total` file its buckets are used, and without it the total of a minute is the sum of the two fallback parts where both have the minute (price of `zero_dte`, else of `longer`) and `derived_total` is true (the fallback exists because a first download holds the layout `zero_dte` plus `longer`). `empty`: the object has no bucket. `thin`: fewer than `MIN_TOTAL_MINUTES` buckets in minutes 0 to 389; minutes come from `strategies.imom.data.local_times` (`services/research/strategies/imom/data.py:436`). `no_open_price`: bar 0 has no price. `missing_price`: after carrying the last price forward for at most `MAX_PRICE_CARRY_MINUTES` minutes, a bar from 1 to 385 has no price. `load_ticker(root: Path, ticker: str, day: str) -> TickerSession | None` gives the session, or `None` when `read_ticker` gives a reason.
  - `@dataclass(frozen=True) class Loaded`: `days: tuple[str, ...]`, `sessions: Mapping[str, Mapping[str, TickerSession]]` (day, then ticker), `skipped: tuple[dict, ...]`, `early_close_days: int`, `derived_total_days: int`, `files: tuple[Path, ...]`. `load_all(root: Path) -> Loaded`. Candidate days: every file stem under `<root>/net-drift/<ticker>/<part>/` for a ticker of `TICKERS`, that is a weekday and for which `is_closed(date.fromisoformat(day))` is false (`services/research/strategies/imom/data.py:223`). Days with `is_early_close(date.fromisoformat(day))` (line 227) are counted in `early_close_days` and left out. A day is usable only when all four tickers load; otherwise it adds one `{day, ticker, reason}` to `skipped` per failing ticker. `days` holds the usable days in order; `derived_total_days` counts usable days with at least one derived total; `files` holds the files read for usable days.
  - `data_manifest(files: Sequence[Path]) -> list[dict]` (`path`, `bytes`, `sha256`) and `data_hash(manifest: Sequence[Mapping]) -> str` (SHA-256 of the sorted JSON text, same as `services/research/strategies/trend_trio/document.py:206-207`).
  - Test file: `services/research/tests/test_flow_control_data.py (new)`.

#### 6. `services/research/strategies/imom/options.py` (Modify)

- **Type / Scope**: structure-only refactor, its own commit. It must not change behaviour; acceptance: `services/research/tests/test_imom_study.py` passes without edits.
- **Proposed Changes**: extract `price_at(event: OptionEvent, spot: float, exit_ms: float, exit_spot: float, market: Market) -> Spread | str` from `price_event` (today lines 123-177). `price_event` keeps lines 124 to 131 (the day and the two clock lookups) and returns `price_at(event, spot, exit_ms, exit_spot, market)`. `price_at` computes `day` again from `event.entry_ms` and holds lines 132 to 177 (previous-close IV and rate, `weekly_expiry`, `choose_strikes`, Black-Scholes legs, fees, `Spread`).

#### 7. `services/research/strategies/flow_control/options.py (new)` (Create)

- **Type / Scope**: the modelled debit vertical spread on SPY and QQQ. It uses the existing option model and adds no pricing code.
- **Proposed Changes**:
  - Reused: `price_at`, `OptionEvent`, `Spread`, `book`, `weekly_expiry` and `MAX_LOSS_PCT = 2.0` of `services/research/strategies/imom/options.py`; `ms_at` (`services/research/strategies/imom/data.py:457`); `Market` and `load_market` (`services/research/strategies/qc_ports/data.py:72`, `:234`; previous-close VIX for SPY, VXN for QQQ, and the T-bill rate IRX); `COMMISSION = 0.65` (`services/research/strategies/qc_ports/options.py:34`). Inside `price_at`: the expiry is the nearest Friday weekly with at least one trading day left (1 to 5 trading days); strikes by `choose_strikes` (`services/research/strategies/qc_ports/book.py:295`); prices by `bs_price` and `smile_iv` (`services/research/strategies/qc_ports/options.py:76`, `:110`); costs by `leg_cost` and `worst_exit_cost`; size by `contracts_for` (`services/research/strategies/qc_ports/book.py:228`), so the maximum loss is the debit plus costs and at most 2% of the account.
  - `ACCOUNT = 100_000.0` (one account per symbol), `SPREAD_STRESS = 2.0`, `LEG_COMMISSIONS = 2 * COMMISSION`.
  - `price_trades(symbol: str, trades: Sequence[Trade], market: Market) -> tuple[list[Spread], list[dict]]`: per trade `OptionEvent(market=symbol, twin=symbol, side="long" or "short", entry_ms=ms_at(day, 570 + entry_bar))`, `spot = entry_price`, `exit_ms = ms_at(day, 570 + exit_bar)`, `exit_spot = exit_price`; a text result of `price_at` goes to the skipped list as `{day, symbol, reason}`.
  - `stress_costs(spread: Spread, multiple: float = SPREAD_STRESS) -> Spread` (`dataclasses.replace`): `entry_fee = round(LEG_COMMISSIONS + multiple * (entry_fee - LEG_COMMISSIONS), 2)`, the same for `exit_fee`, and `max_loss = round(entry_price + new entry_fee + LEG_COMMISSIONS + multiple * (max_loss - entry_price - entry_fee - LEG_COMMISSIONS), 2)`. Only the spread part of each cost is multiplied; commissions stay.
  - `book_form(spreads: Sequence[Spread], days: Sequence[str], *, nautilus: bool) -> dict`: the result of `book(spreads, [ms_at(day, 960) for day in days], ACCOUNT, nautilus=nautilus)` plus the key `result` (the `nautilus` entry when `nautilus` is true, else `ledger`).
  - `session_pnl_from_equity(points: Sequence[tuple[str, float]], days: Sequence[str], capital: float = ACCOUNT) -> list[float]`: per day, the equity of its point minus the equity before it (start: `capital`); 0 for a day without a point. `trade_nets(result) -> list[float]`: `record["pnl"]` of each entry of `result.trades` (`services/research/strategies/qc_ports/ledger.py:74`).
  - Test file: `services/research/tests/test_flow_control_options.py (new)`.

#### 8. `services/research/strategies/flow_control/study.py (new)` (Create)

- **Type / Scope**: the study: instruments, trials, futures ledger, split, statistics, verdict, Nautilus fill check, checks of stored rows, result document. Modelled on `services/research/strategies/trend_trio/study.py`.
- **Proposed Changes**:
  - `SCHEMA = "flow-control-continuation-study-v1"`. `INSTRUMENTS` (key, form, price ticker, primary, check): `ES` (`F`, SPX, SPX, SPY), `NQ` (`F`, NDX, QQQ, NDX), `SPY` (`O`, SPY, SPX, SPY), `QQQ` (`O`, QQQ, QQQ, NDX). `build_session(key: str, day: str, tickers: Mapping[str, TickerSession]) -> Session` takes `price` from the price ticker, `trend_price` from the primary ticker, and `primary` and `check` from the `minutes` of those tickers.
  - Futures model: `POINT_USD = {"ES": 50.0, "NQ": 20.0}`, `TICK_USD = {"ES": 12.50, "NQ": 5.00}`, `FEES_USD = 4.50` per round turn, `SLIPPAGE_TICKS = (0, 1, 2)`, `BASE_TICKS = 1`, `STRESS_TICKS = 2`, `CAPITAL = 100_000.0` per contract, `SESSIONS_PER_YEAR = 252`, `SESSION_MINUTES = 390`. The NQ values equal `services/research/strategies/trend_trio/study.py:56-63`. The repository has no ES fee; the ES fee equals the NQ fee by decision of this plan, and the spec lists it under "Futures model". `trade_net(trade: Trade, key: str, slip_ticks: int) -> float`: `points * POINT_USD[key] - FEES_USD - 2 * slip_ticks * TICK_USD[key]`. `session_pnl(trades: Sequence[Trade], days: Sequence[str], key: str, slip_ticks: int) -> list[float]` (a session without a trade counts 0).
  - Trials: `CONFIGS` = `C0` (`Params()`), `V1` (window 15), `V2` (window 60), `V3` (`entry_last = ENTRY_LAST_LATE`), `V4` (`skip_fomc = False`); each changes one value. `FORMS = ("F", "O")`. `N_TRIALS = 10` (5 configurations times 2 forms; slippage levels and the cost stress are not trials). `PRIMARY = "C0-F"`. The table "Rows" below fixes capital and sources per row.
  - Split: `SPLIT = (0.6, 0.2, 0.2)`, `GAP_SESSIONS = 5`, `MIN_SESSIONS = 30`, `WINDOW_CHOICE = ("2026-10-28", "2026-11-13")`. `@dataclass(frozen=True) class Split`: `train`, `validation`, `test`, `window_choice` (tuples of days) and the property `out_of_sample` (validation followed by test). `split_sessions(days: Sequence[str]) -> Split` on all usable days, in order: `usable = n - 2 * GAP_SESSIONS`; train is the first `floor(0.6 * usable)` days; 5 days are dropped; validation is the next `floor(0.2 * usable)` days; 5 days are dropped; test is the rest. Fewer than `MIN_SESSIONS` days raises `ValueError`. Then the days inside `WINDOW_CHOICE` (both ends included; 13 sessions) are taken out of the part that holds them and form `window_choice`, because they were used to choose the 30-minute window (count of state changes only). The split runs once on `Loaded.days`; every instrument uses it. No parameter is fitted on any part, so the out-of-sample part decides the verdict; train, validation, test and window-choice are reported separately.
  - Statistics: `sharpe` and `moments` are imported from `services/research/strategies/trend_trio/study.py:612-628`; drawdown from `max_drawdown_usd` (`services/research/strategies/noise_band_futures_run.py:185`); `capital_curve(days: Sequence[str], pnl: Sequence[float], capital: float) -> dict` (`cagr`, `maxDrawdown`, `months`) with the formula of `services/research/strategies/trend_trio/study.py:631-646`; `row_stats(nets: Sequence[float], pnl: Sequence[float], days: Sequence[str], capital: float, held_minutes: float, instruments: int) -> dict` with the keys `trades` (count of `nets`), `netUsd`, `winRate` (share of `nets` above 0; 0 without trades), `profitFactor` (sum of gains over sum of losses; `None` without a loss), `sessionSharpe`, `sharpe` (`sessionSharpe * sqrt(252)`), `cagr`, `maxDrawdown`, `timeInMarket` (`held_minutes / (instruments * SESSION_MINUTES * len(days))`).
  - `deflated_sharpe(series: Mapping[str, Sequence[float]], primary: str = PRIMARY, n_trials: int = N_TRIALS) -> dict`: calls the existing `deflated_sharpe_ratio(sharpe, n_trials, sharpe_variance, n_observations, skew, kurtosis)` of `services/research/backtesting/optimizer.py:842` on the per-session dollars of the out-of-sample part; the variance is taken over the per-session Sharpe ratios of the 10 trial series; same result keys as `services/research/strategies/trend_trio/study.py:852-865` (`probability: None` and `error` when the function raises).
  - Verdict: `MIN_OOS_TRADES = 100`, `DSR_PASS = 0.95`. `verdict_of(oos_trades: int, oos_net: float, dsr: Mapping) -> tuple[str, str]` on the out-of-sample part of `PRIMARY` at `BASE_TICKS`: fewer than 100 trades gives `needs-more-data`; else `edge` when the net is above 0 and the probability is at least 0.95; else `no-edge` (also when the probability is `None`). Reason texts (`{net}` formatted by `usd`; after one space every text ends with the sentence `Options-side rule with modelled fills.`): `Needs more data: {n} out-of-sample trades, 100 needed.`; `Edge: {n} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe {p:.3f} (bar 0.95, N = 10).`; `No edge: {n} out-of-sample trades, net {net} at 1 tick per side, deflated Sharpe {p:.3f} (bar 0.95, N = 10).`; without a probability `No edge: deflated Sharpe not computable: {error}. {n} out-of-sample trades, net {net} at 1 tick per side.`
  - `nautilus_check(sessions: Mapping[str, Sequence[Session]], trades: Mapping[str, Sequence[Trade]], tolerance: float = 1e-6) -> dict`: new function, modelled on `services/research/strategies/trend_trio/study.py:746-798`. It checks the `C0` trades of all four instruments on all usable days. Per instrument and side (+1, -1): one `run_signal_backtest` over the joined bars. Join rule: `offset = session_index * BARS`; bar time `int(ms_at(day, 570 + bar))`; open, high, low and close all equal `price[bar]`; the three arrays of `signal_arrays(session, trade, side)` are placed at the offset; `Compiled(signals, exits, None, None, close_at=...)`; `RunOptions(cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None, side="short" if side < 0 else None)`. An engine index maps back by `divmod(index, BARS)`. It compares `entryIndex`, `exitIndex`, `entryPrice` and `exitPrice` with the rule trades of that side in day order. Result keys: `status` (`ran`, or `not run` with `reason` when `engine.require()` raises), `engine` (`engine.ENGINE_ID`), `trades`, `booked`, `same` (no mismatch and `booked == trades`), `mismatches` (at most 20), `optionsMaxGap` (largest `maxGap` of the two `book_form` calls, or `None`).
  - `two_sided_description(deep_trades: Sequence[Mapping], sessions: Sequence[Session]) -> list[dict]`: input rows have the keys `symbol`, `second_s` (epoch seconds), `side` (`buy` or `sell`), `size`, `price`; only `symbol == "ES"` rows on usable days and in minutes 0 to 389 count. `sessions` are the `ES` sessions (group sp500: primary SPX, check SPY). Per day with rows: `day`, `trades` (row count), `buyVolume`, `sellVolume`, `netVolume`, `controlMinutes` (minutes where the `C0` group state is `buyers` or `sellers`), `tradeMinutes` (control minutes with at least one row), `sameSignMinutes` (control minutes where buy size minus sell size is above 0 under `buyers` or below 0 under `sellers`). No verdict is computed from it.
  - `LIVE_ROW_TOLERANCE = 0.01`. `live_rows_check(rows: Sequence[Mapping], root: Path) -> dict`: input rows have the keys `ticker`, `part`, `minute_ms`, `net_call_premium`, `net_put_premium`. Per (ticker, part) of the rows it reads the downloaded file of the New York day of the first row and returns `{status: "ran", day, pairs: [{ticker, part, stored, downloaded, common, equal, maxAbsDiffUsd, onlyStored, onlyDownloaded}]}`; a row is `equal` when both premiums differ by at most `LIVE_ROW_TOLERANCE`. Without rows: `{status: "not provided"}`.
  - `run(loaded: Loaded, root: Path, *, markets: Mapping[str, Market], market_files: Sequence[Path] = (), deep_trades: Sequence[Mapping] = (), live_rows: Sequence[Mapping] = (), nautilus: bool = True) -> dict`: the results document with the keys `schema`, `data` (`days`, `first`, `last`, `skipped`, `earlyCloseDays`, `derivedTotalDays`, `files`, `marketFiles`, `dataHash`), `split` (per part `first`, `last`, `sessions`), `rows` (per row of the table below: `row_stats` for `whole`, `train`, `validation`, `test`, `outOfSample` and `windowChoice`; futures rows per slippage level), `series` (out-of-sample per-session dollars of the 10 trials), `deflatedSharpe`, `verdict`, `verdictReason`, `diagnostics` (`nautilus`, `twoSided`, `liveRows`, `fomc`, `optionsSkipped`, `optionsStress`), `curve` (months of `C0-F`, whole period). `whole` means all usable days. `dataHash` is `data_hash` over the net-drift manifest followed by the market manifest. With `nautilus=False`, `diagnostics.nautilus` is `{"status": "not run", "reason": "disabled"}`. The runner adds `provenance` (entry 13).
  - Test files: `services/research/tests/test_flow_control_study.py (new)` and `services/research/tests/test_flow_control_nautilus.py (new)`.

Rows (`x` is one of `C0`, `V1` to `V4`):

| Row | Instruments | Capital | Per-session dollars | Per-trade nets | Held minutes |
| --- | --- | --- | --- | --- | --- |
| `x-F` | ES and NQ | 200,000 | sum of `session_pnl` of ES and NQ | `trade_net` of both | `exit_bar - entry_bar` of all trades; 2 instruments |
| `x-F-ES`, `x-F-NQ` | one future | 100,000 | `session_pnl` | `trade_net` | of its trades; 1 instrument |
| `x-O` | SPY and QQQ, one `book_form` and one account each | 200,000 | sum of `session_pnl_from_equity` of both | `trade_nets` of both results | of the priced trades; 2 instruments |
| `x-O-SPY`, `x-O-QQQ` | one symbol | 100,000 | `session_pnl_from_equity` | `trade_nets` | of its priced trades; 1 instrument |
| `C0-O-stress` | as `C0-O`, every spread through `stress_costs` | 200,000 | as `C0-O` | as `C0-O` | as `C0-O` |

#### 9. `services/research/strategies/flow_control/document.py (new)` (Create)

- **Type / Scope**: builds the study document for the importer. The schema is `StrategyBacktestStudySchema` (`packages/api/src/contracts/research-studies.ts:385-500`); it is strict, so unknown keys are rejected.
- **Proposed Changes**:
  - `STUDY_ID = "flow-control-continuation"`, `SPEC_PATH = "docs/specs/strategies/flow-control-continuation.md (new)"` (value without the suffix), `RULES_VERSION_ITEM = "Rules version"`, `FILTER_PROFILE_ITEM = "Filter profile"`, `SOURCE_URL = "https://quantdata.us/api/docs/endpoints/net-drift"`, `TITLE`, `RULE_ITEMS`, `GAPS` (texts below). `usd(value: float | None) -> str` same as `services/research/strategies/trend_trio/document.py:59-60`. `nautilus_text(results: Mapping) -> str`: `NautilusTrader entry/exit bars and fill prices vs the rule module: {same | NOT the same | not run} ({booked} of {trades} trades).`
  - `study_document(results: Mapping) -> dict`. It raises `ValueError` in this order, with these messages: `The study ran with uncommitted code; its document names a commit without that code` (rule of `services/research/strategies/trend_trio/document.py:200-203`); `The NautilusTrader fill check did not run; the document needs one engine` (engine rule of lines 168-172); `The NautilusTrader fill check found different fills; the study has no document` (new rule); `The equity curve has fewer than 2 months; the study has no document` (new rule).
  - Test file: `services/research/tests/test_flow_control_study.py (new)`.

Field mapping (every field the importer validates; text is trimmed and non-empty unless noted; every cut text is `text[:limit].strip()`). The whole document must stay under 262,144 bytes of compact JSON (`:25`) and stdin under 1,048,576 bytes (`scripts/research-studies/import.ts:38`).

| Field | Type and limit | Value |
| --- | --- | --- |
| `id` | lowercase slug, at most 64 characters, equal to the spec slug (`:17-19`, `:492-499`) | `flow-control-continuation` |
| `kind` | literal `strategy-backtest` (`:288`) | fixed |
| `spec` | matches `docs/specs/strategies/<slug>.md`, at most 300 (`:301-302`) | `SPEC_PATH` |
| `ran` | calendar date `YYYY-MM-DD` (`:51-57`) | `provenance.ran` |
| `title` | text, at most 200 | `Options-side continuation rule (modelled fills): net drift state with trend on ES, NQ, SPY and QQQ` |
| `source` | `{ label` at most 200, `url` https and at most 300 `}` (`:477-482`) | `SOURCE_URL`; label `QuantData net drift (vendor documentation); rule by Vertex` |
| `verdict` | `edge`, `no-edge` or `needs-more-data` (`:488`) | `results["verdict"]` |
| `verdictReason` | text, at most 1000 (`:489`) | `results["verdictReason"]`, cut |
| `rules` | 1 to 30 of `{ item` 60, `rule` 400, `source` 200 `}` | the 12 entries of `RULE_ITEMS`, in order |
| `gaps` | 0 to 30 of `{ gap` 300, `choice` 400 `}` | the 6 entries of `GAPS` |
| `forms` | 1 to 4, distinct `key` in `underlying`, `options`; `label` 120, `description` 600, 1 to 80 `runs` | texts below; the form `options` is left out when no spread was priced |
| run fields | `symbol` 40, `market` 60, `from` and `to` dates (`from` not after `to`), `trades` integer from 0, `cagr` at least -1, `sharpe` number, `maxDrawdown` -1 to 0, `profitFactor` at least 0 or null, `winRate` and `exposure` 0 to 1, `buyHoldCagr`, `buyHoldSharpe`, `oosCagr`, `oosSharpe` number or null (`:320-344`) | `row_stats` of `whole`; `oosCagr` and `oosSharpe` from `outOfSample`; `buyHold*` null; `exposure` is `min(1, timeInMarket)`; `maxDrawdown` is `min(0, value)` |
| `robustness` | 0 to 20 of `{ check` 80, `pass` boolean or null, `result` 300 `}` | the 11 rows below |
| `sensitivity` | 0 to 80 of `{ param` 60, `value` 40, `sharpe`, `cagr` at least -1, `maxDrawdown` -1 to 0, `trades }` | 9 rows below, statistics of `whole` |
| `comparison` | 0 to 30 of `{ name` 80, `kind` in `buy-and-hold`, `library`, `strategy`; `sharpe`, `cagr`, `maxDrawdown }` | two `strategy` rows below |
| `equity` | 2 to 400 of `{ month` `YYYY-MM`, `value` at least -1, `drawdown` -1 to 0 `}`, months rising (`:400-421`) | `results["curve"]`, last 400 |
| `equityLabel` | text, at most 200 | `C0 on 1 ES and 1 NQ contract (modelled from index prices), 1 tick per side and fees, on $200,000` |
| `provenance` | `commit` 7 to 40 lowercase hex; `dataHash`, `engine`, `runId` text at most 80 (`:362-372`) | `provenance.commit`; `sha256:<dataHash>`; `"nautilus_trader " + engine.removeprefix("nautilus-trader-")`; `flow-control-continuation-<ran>-<commit 8>` |
| `notes` | text, at most 4000, may be empty | template below, cut |

Exact texts. Numbers in the texts are written from the constants; the texts below show the values of `C0`. `source` of every rule is `Spec: <section>`.

| `item` (`RULE_ITEMS`) | `rule` | Spec section |
| --- | --- | --- |
| `Rules version` | `flow-control-rules.v1` | Rules |
| `Filter profile` | `otm-clean.v1` | Data |
| `Trend` | `Long only when the price of the group's primary ticker (SPX or QQQ) is above its 09:30 price and above its price 30 minutes earlier; short only when it is below both. Before 10:00 the earlier price is the 09:30 price.` | Rules |
| `Options state` | `Net drift ratio of the total of all expiries over the last 30 minutes: buyers after 5 minutes in a row at or above 0.30, lost below 0.10; sellers is the mirror. The check ticker on the opposite side gives mixed.` | Rules |
| `Entry` | `Between 09:45 and 11:30 New York, at the end of a minute with the group state buyers (long) or sellers (short) and the trend on the same side. Fill at the price of the next minute. At most one trade per instrument and session.` | Rules |
| `Exit` | `When the group state is no longer the entry state (fill at the price of the next minute), or at 15:55 New York at the price of that minute.` | Rules |
| `Hard stop` | `Exit when the price at the end of a minute is 0.40% of the entry price or more against the position; fill at the price of the next minute.` | Rules |
| `FOMC days` | `The 16 scheduled FOMC decision days of 2025 and 2026 are skipped in the main run.` | Rules |
| `Futures model` | `1 ES and 1 NQ contract from the SPX and NDX index price per minute: $50 and $20 per point, $4.50 fees per round turn, slippage of 0, 1 or 2 ticks per side ($12.50 and $5.00 per tick).` | Futures model |
| `Option position` | `Debit vertical on SPY and QQQ, nearest Friday weekly expiry with at least one trading day left, long leg near 0.50 delta, Black-Scholes prices from the previous close of VIX or VXN, maximum loss 2% of a $100,000 account per symbol.` | Option position |
| `Split` | `60% train, 20% validation and 20% test by time with gaps of 5 sessions. The 13 sessions from 2026-10-28 to 2026-11-13 are taken out of their part and reported alone.` | Split |
| `Verdict bar` | `At least 100 trades in the out-of-sample part (validation and test), net above 0 at 1 tick per side and a deflated Sharpe ratio of at least 0.95 with N = 10 trials.` | Pass/fail rule |

`GAPS` (`gap`, then `choice`): `Size of the hard stop`: `0.40% of the entry price, tested on minute prices.` `Trend level in the first 30 minutes`: `The 09:30 price is used as the earlier price.` `Number of trades per session`: `At most one per instrument and session: the first entry.` `Futures prices and fees`: `No futures bar is read. ES and NQ results are modelled from the SPX and NDX index price per minute. The ES fee equals the NQ fee of $4.50 by decision.` `Futures and options agreement`: `Not tested: large-trade history exists for days only. This study tests the options side alone.` `Sessions used to choose the 30-minute window`: `The 13 sessions from 2026-10-28 to 2026-11-13 are not in the out-of-sample part.`

| Place | Text |
| --- | --- |
| form `underlying`, `label` | `1 ES and 1 NQ contract (modelled from index prices)` |
| form `underlying`, `description` | `Futures results are modelled: SPX and NDX index points per minute times $50 and $20 per point, $4.50 fees per round turn and slippage per side. No futures bar and no real fill is used. Returns are fractions of $100,000 per contract. {nautilus_text}` |
| `underlying` runs (`symbol`; `market`) | `ES + NQ (modelled from SPX and NDX)` with `C0, {t} ticks/side, fees $4.50` for `t` = 0, 1, 2; then `ES (modelled from SPX)` and `NQ (modelled from NDX)`, each with `C0, 1 ticks/side, fees $4.50` |
| form `options`, `label` | `Debit verticals on SPY and QQQ (modelled option prices)` |
| form `options`, `description` | `One debit vertical per trade of the rule on SPY or QQQ, priced with Black-Scholes on the previous close of VIX or VXN (no option quotes), $0.65 per contract and half the modelled spread per leg. Maximum loss 2% of a $100,000 account per symbol; returns are fractions of $200,000.` |
| `options` runs (`symbol`; `market`) | `SPY + QQQ debit verticals (modelled)`, `SPY debit verticals (modelled)`, `QQQ debit verticals (modelled)`, each with `C0, modelled option prices and costs` |
| `sensitivity` (`param`; `value`) | `V1 window 15 min`, `V2 window 60 min`, `V3 entry until 15:30`, `V4 FOMC days included`, each once with `, futures` and once with `, debit verticals`; then `C0 debit verticals, twice the spread cost`; `value` is `net {net}` |
| `comparison` `name` | `Options-side rule C0, ES + NQ modelled, 1 tick/side`; `Options-side rule C0, SPY + QQQ debit verticals (modelled)` |
| `notes` | `Options-side rule only: the futures and options agreement is not tested. Futures results are modelled from index prices; option prices are modelled. Out-of-sample part: {first} to {last}, {sessions} sessions. Data: QuantData net drift, filter profile otm-clean.v1, {days} sessions from {first} to {last}, {derived} with a derived total. Vendor data is for personal use and is not redistributed. Research only: no order, no deployment.` |

| `robustness` `check` | `pass` | `result` |
| --- | --- | --- |
| `Out-of-sample trades at least 100` | boolean | `{n} trades in {sessions} sessions ({first} to {last})` |
| `Deflated Sharpe at least 0.95 (N = 10)` | boolean | `{p:.3f}; per-session Sharpe {s:.3f}, expected maximum {e:.3f}` or `not computable: {error}` (then false) |
| `Out-of-sample net above 0 at 1 tick per side` | boolean | `net {net}` |
| `Out-of-sample net at 2 ticks per side` | null | `net {net}` |
| `Net by part at 1 tick per side` | null | `train {net}, validation {net}, test {net}` |
| `Window-choice sessions 2026-10-28 to 2026-11-13 (not in the verdict)` | null | `{sessions} sessions, {n} trades, net {net}` |
| `NautilusTrader fill check (C0, four instruments)` | `same` | `nautilus_text` |
| `FOMC days included (V4, out-of-sample)` | null | `net {net} on {n} trades` |
| `Option form at twice the spread cost (out-of-sample)` | null | `net {net} on {n} trades; at the modelled cost {net}` |
| `Stored net drift rows against the download` | null, or boolean when provided (all rows equal) | `{day}: {equal} of {common} rows equal, largest difference {net}` or `not provided` |
| `Futures and options agreement` | null | `Not tested: large-trade history exists for {n} stored ES sessions only.` |

#### 10. `services/research/strategies/flow_control/report.py (new)` (Create)

- **Type / Scope**: one HTML page from the results document, with the `STYLE` sheet of `services/research/strategies/triple_rsi/report.py`; no script, no external request.
- **Proposed Changes**: `render(results: Mapping) -> str`. Reuses `STYLE`, `_e`, `_mark` and `_table` (`services/research/strategies/triple_rsi/report.py:15-88`), the same import as `services/research/strategies/trend_trio/report.py:7`. Page heading: `Options-side continuation rule (modelled fills)`. Sections in order: verdict and reason; data (sessions, first and last date, skipped days by reason, early-close days, days with a derived total, data hash); rules (every number of `control.RULES` and of `rules.py`); split with the window-choice sessions; `C0-F` for train, validation, test, the out-of-sample part and the window-choice sessions, per slippage; instruments; option form with skipped reasons and the row at twice the spread cost; variants; deflated Sharpe; Nautilus fill check; FOMC days; "Stored rows against the downloaded values" (the pairs of `live_rows_check`, or "not provided"); "Futures and options agreement: not tested" with the table of `two_sided_description` (or "not provided"); limits. The text names no JSON file, so no ignore mark is needed. Test file: `services/research/tests/test_flow_control_study.py (new)`.

#### 11. `services/research/strategies/flow_control/download.py (new)` (Create)

- **Type / Scope**: pure core of the history download: request bodies, plan, checks, pacing. The network call is an argument, so the tests use no network. The key never enters this module: `post` is built by the script, and no log line holds the key, a header or a body.
- **Proposed Changes**:
  - `BASE_URL = "https://api.quantdata.us"` (`packages/api/src/server/quantdata-client.ts:20`), `ENDPOINT = "/v1/options/tool/net-drift"` (design section 2), `KEY_ENV = "QUANTDATA_API_KEY"`, `FILTER_PROFILE = "otm-clean.v1"`, `FIRST_DAY = "2025-01-02"`, `REQUEST_INTERVAL_SECONDS = 3.75` (16 request starts per minute), `COOLDOWN_SECONDS = 60` (`packages/api/src/server/quantdata-client.ts:16`). New values of this plan: `MAX_RETRIES = 5`, `REQUEST_TIMEOUT_SECONDS = 30`, `ERROR_WAIT_SECONDS = 15`, `EMPTY_STOP = 10`.
  - `NET_DRIFT_REQUESTS: dict[str, dict]`: the two POST bodies (`total`, `zero_dte`) with the placeholders `"YYYY-MM-DD"` and `"T"`, copied from the fixture header `netDriftRequests`. `request_body(part: str, day: str, ticker: str) -> dict`. `class AuthError(Exception)`.
  - `plan(root: Path, last_day: str, first_day: str = FIRST_DAY) -> list[tuple[str, str, str, str]]`: (ticker, part, day, status) for every ticker of `TICKERS`, part of `PARTS` and weekday for which `is_closed(date.fromisoformat(day))` is false, newest day first. `status` is `data` (the file exists and `parse_part` gives buckets), `empty` (the file is the empty object) or `pending` (no file, or a file that does not parse).
  - `outside_repository(path: Path, repo: Path) -> Path`: raises `SystemExit` when the resolved path is the repository or inside it.
  - `fetch_all(items, root: Path, post: Callable[[dict], tuple[int, object, Mapping[str, str]]], sleep: Callable[[float], None], log: Callable[[str], None]) -> dict`: walks `items` in order with `REQUEST_INTERVAL_SECONDS` between request starts and follows the table below (`post` returns status 0 for a timeout or a connection error, and body `None` when the body is not JSON). Per (ticker, part) it counts empty sessions in a row, existing files included; a `data` file resets the count. At `EMPTY_STOP` the older days of that pair are dropped; the oldest day with data is then the first date of the study. A valid body is written to `<file>.tmp`, then renamed. Returns `{written, empty, failed, dropped, pending, stopped}`: files written with buckets; files written as the empty object; files not written after an error; planned files left out by `EMPTY_STOP`; files not tried because the run stopped; and whether it stopped.
  - Test file: `services/research/tests/test_flow_control_download.py (new)`.

| Result of `post` | Action | Counter |
| --- | --- | --- |
| 200, `data` object passes `parse_part` and has buckets | write the `data` object | `written` |
| 200, `data` is the empty object | write the empty object; counts toward `EMPTY_STOP` | `empty` |
| 200, body `None`, no `data` object, or `parse_part` raises | write nothing; go on with the next file; no retry | `failed` |
| 401 or 403 | raise `AuthError` at once | none |
| 429 | wait `Retry-After` seconds, else `COOLDOWN_SECONDS`; retry the same file at most `MAX_RETRIES` times; then stop the run | `stopped`, rest `pending` |
| 5xx or status 0 | wait `ERROR_WAIT_SECONDS`; retry the same file at most `MAX_RETRIES` times; then go on | `failed` |
| any other status | write nothing; go on | `failed` |

#### 12. `research/backtests/flow-control-continuation/fetch_net_drift.py (new)` (Create)

- **Type / Scope**: resumable download script for the research machine. Python by precedent: study fetchers are Python scripts under `research/backtests/<study>/` (for example `research/backtests/imom/fetch_data.py` and `research/backtests/imom/fetch_ibkr.py`).
- **Proposed Changes**: arguments `--data` (default `DEFAULT_ROOT`), `--to` (default: yesterday in New York), `--from` (default `FIRST_DAY`), `--dry-run` (prints the count of pending files and the estimate `pending * REQUEST_INTERVAL_SECONDS` in hours; sends nothing). It reads the key only from the process environment variable `QUANTDATA_API_KEY`; it reads no `.env` file and no repository file. It builds `post` with `urllib.request` (header `authorization: Bearer <key>` same as `packages/api/src/server/quantdata-client.ts:249`, timeout `REQUEST_TIMEOUT_SECONDS`): `urllib.error.HTTPError` becomes `(error.code, None, error.headers)`; `urllib.error.URLError` and `TimeoutError` become `(0, None, {})`. It calls `outside_repository` and `fetch_all`. Exit codes: 0 when `failed` and `pending` are 0; 1 otherwise; 2 for a missing key, `AuthError` or a data folder inside the repository. Loaded by path in `services/research/tests/test_flow_control_download.py (new)`, the same way as `services/research/tests/test_trend_trio_study.py:194-201`.
- **No JSON data files rule**: `research/` is outside `RUNTIME_ROOTS` (`scripts/ci/json-data.ts:57`), so the scan does not read this script. The scan reads `services/research/strategies/flow_control/data.py (new)`; its single file-name line carries the ignore mark. No list in `scripts/ci/json-data-allowlist.ts` changes. The download writes only under `--data`, and the script refuses a folder inside the repository. The only JSON files this pull request commits are the generated journal and snapshot (class `generated`, `scripts/ci/json-data.ts:34-38`).

#### 13. `research/backtests/flow-control-continuation/run.py (new)` (Create)

- **Type / Scope**: study runner for the research machine, modelled on `research/backtests/trend-trio/run.py`. Unlike that runner it has no timing run on one year and no worker pool: all sessions (at most 466) run in one process.
- **Proposed Changes**:
  - Arguments: `--data`; `--market-data` (default `strategies.qc_ports.data.data_root()`: `VERTEX_QC_PORTS_DATA` or `~/Documents/reports/vertex-qc-ports/data`, `services/research/strategies/qc_ports/data.py:29-30`, `:48-52`); `--out`; `--deep-trades <csv>` and `--live-rows <csv>` (optional); `--dry-run`; `--allow-dirty`; `--render-only`.
  - `WATCHED = ("services/research", "research/backtests/flow-control-continuation", "docs/specs/strategies/flow-control-continuation.md (new)")` (value without the suffix).
  - Markets: `load_market("SPY", root)` and `load_market("QQQ", root)`; `market_files` are `SPY.csv`, `QQQ.csv`, `VIX.csv`, `VXN.csv` and `IRX.csv` under that root (the files `load_market` reads for the two symbols, `services/research/strategies/qc_ports/data.py:131-163`, `:234-246`). They enter `data.marketFiles` and the data hash. CSV inputs: `read_csv(path: Path, columns: Sequence[str]) -> list[dict]` with `csv.DictReader`; a missing column raises `SystemExit`. `--deep-trades` columns: `symbol`, `second_s`, `side`, `size`, `price`. `--live-rows` columns: `ticker`, `part`, `minute_ms`, `net_call_premium`, `net_put_premium`, `net_call_volume`, `net_put_volume`, `underlying_price`. Numbers are parsed with `int` or `float`.
  - Flow, with the logic of `spec_status`, `git_state` and `write_outputs` (`research/backtests/trend-trio/run.py:80-96`, `:202-211`): refuse when the spec above "## Results" differs from `rules.SPEC_SHA256`; refuse uncommitted watched code unless `--allow-dirty`; refuse an `--out` inside the repository (`outside_repository`); `load_all`; write `data.json` (same step as `research/backtests/trend-trio/run.py:255`); `study.run`; set `results["provenance"] = {"commit": <40 hex>, "dirtyFiles": [...], "ran": <UTC date>, "specSha256": rules.SPEC_SHA256, "seconds": <int>}` (same as lines 214-216 and 241-244); write the outputs.
  - Outputs in `--out`: `data.json` (`{root, marketRoot, days, first, last, skipped, earlyCloseDays, derivedTotalDays, files, marketFiles, dataHash}`), `results.json` (the results document), `study.json` (`study_document`; not written when it raises, and the message is logged) and `index.html` (`report.render`).
  - `--dry-run` loads the data and prints sessions, split, skipped counts and the data hash; it writes nothing. `--render-only` reads `results.json` from `--out` and writes `study.json` and `index.html` again. `--allow-dirty` records the changed files in `dirtyFiles`; `study.json` is then not written. Exit codes: 0 when every output was written (for `--dry-run`: when the data loaded); 1 for a refusal (`SystemExit` with the message, same as the precedent) or when `study.json` was not written.

#### 14. `research/backtests/flow-control-continuation/README.md (new)` (Create)

- **Type / Scope**: operator guide, same sections as `research/backtests/trend-trio/README.md`.
- **Proposed Changes**: purpose (options-side rule, modelled fills) and "research only" line; code table; data layout `<data dir>/net-drift/<TICKER>/<total|zero_dte>/<YYYY-MM-DD>.json` and the statement that the data and the report stay outside the repository and are not redistributed; virtual environment `~/.cache/vertex-academy-nautilus-venv/bin/python`; the commands of "Study run and import" below; the two exports below; tests. The exports run with psql in the `vertex-postgres` container on the trading server (user `postgres` as in `infra/quantvps/vertex-web.service:9`; the database name is not verified in the repository documents) and write CSV to stdout:

```sql
\copy (select symbol, extract(epoch from second)::bigint as second_s, side, size, price from flow_large_trades where symbol = 'ES' order by second, seq) to stdout csv header
\copy (select ticker, part, (extract(epoch from minute) * 1000)::bigint as minute_ms, net_call_premium, net_put_premium, net_call_volume, net_put_volume, underlying_price from flow_net_drift where minute >= '<YYYY-MM-DD> 09:30 America/New_York' and minute < '<YYYY-MM-DD> 16:00 America/New_York' order by ticker, part, minute) to stdout csv header
```

#### 15. `services/research/tests/test_flow_control_control.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run. Reads `packages/api/src/fixtures/flow-control-golden.fixture.json (PR 1)` through `Path(__file__).resolve().parents[3]`.
- **Proposed Changes**: tests `test_rules_object_equals_the_fixture_rules`, `test_every_options_case_gives_the_fixture_states` (one parametrized case per `optionsCases` entry; windows 15, 30 and 60, a gap, ties at both limits, zero divisor), `test_every_group_case_gives_the_fixture_state`, `test_fixture_schema_version_is_known`, `test_options_ratio_by_hand`, `test_session_start_and_gap_reasons_by_hand`, `test_no_data_step_keeps_the_state_and_resets_the_runs`.

#### 16. `services/research/tests/test_flow_control_rules.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run; synthetic sessions only. It exports the helper `synthetic_session(day: str, drift: Mapping[int, tuple[float, float]], prices: Sequence[float], check: Mapping[int, tuple[float, float]] | None = None) -> Session` (`check` defaults to `drift`). Other test files import it with `from .test_flow_control_rules import synthetic_session` (same import as `services/research/tests/test_trend_trio_nautilus.py:18`).
- **Proposed Changes**: tests `test_spec_hash_matches_the_frozen_spec`, `test_trend_needs_open_and_lookback`, `test_trend_reads_the_primary_ticker_price_and_fills_use_the_instrument_price`, `test_trend_before_1000_uses_the_open`, `test_long_entry_fills_at_the_next_minute`, `test_short_entry_is_the_mirror`, `test_no_entry_against_the_trend`, `test_no_entry_before_0945_or_after_the_last_entry_minute`, `test_one_trade_per_session`, `test_exit_when_the_state_is_lost`, `test_exit_at_the_hard_stop_before_the_state`, `test_exit_at_1555`, `test_mixed_or_no_data_group_state_blocks_entry`, `test_window_variant_changes_only_the_window`, `test_fomc_days_are_skipped_unless_included`, `test_fomc_list_has_16_days_and_rejects_other_years`, `test_signal_arrays_mark_entry_exit_and_close_for_one_side`.

#### 17. `services/research/tests/test_flow_control_data.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run; writes small files under `tmp_path`.
- **Proposed Changes**: tests `test_bucket_path_layout`, `test_parse_part_reads_the_five_fields`, `test_parse_part_rejects_a_missing_field_a_non_finite_value_and_a_bad_key`, `test_total_file_is_used_when_present`, `test_total_is_derived_from_zero_dte_and_longer_and_counted`, `test_each_skip_reason` (parametrized over `SKIP_REASONS`), `test_price_is_carried_at_most_five_minutes`, `test_minutes_outside_the_session_are_dropped`, `test_day_is_usable_only_when_all_four_tickers_load`, `test_closed_days_are_left_out_and_early_close_days_are_counted`, `test_manifest_and_hash_are_stable`.

#### 18. `services/research/tests/test_flow_control_options.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run (`nautilus=False`); synthetic `Market` rows.
- **Proposed Changes**: tests `test_long_trade_prices_a_call_debit_vertical`, `test_short_trade_prices_a_put_debit_vertical`, `test_exit_is_priced_at_the_exit_minute`, `test_expiry_is_one_to_five_trading_days`, `test_stale_or_missing_iv_is_skipped_with_a_reason`, `test_max_loss_is_at_most_two_percent_of_the_account`, `test_stress_costs_doubles_the_spread_part_only`, `test_session_pnl_from_equity_points`, `test_trade_nets_come_from_the_booked_result`.

#### 19. `services/research/tests/test_flow_control_study.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run; synthetic data; loads `run.py` by path. The base run has no nautilus-trader, so tests that need a document call `run(..., nautilus=False)` and then set `results["diagnostics"]["nautilus"]` to `{"status": "ran", "engine": "nautilus-trader-1.227.0", "trades": n, "booked": n, "same": True, "mismatches": [], "optionsMaxGap": 0.0}` (method of `write_nautilus`, `services/research/tests/test_trend_trio_study.py:217-224`).
- **Proposed Changes**: tests `test_ledger_arithmetic_for_es_and_nq_at_0_1_2_ticks`, `test_session_pnl_counts_sessions_without_trades_as_zero`, `test_split_60_20_20_with_two_gaps_of_five`, `test_split_takes_the_window_choice_sessions_out_of_their_part`, `test_split_refuses_too_few_sessions`, `test_out_of_sample_part_is_validation_then_test`, `test_trials_are_five_configurations_times_two_forms`, `test_row_capital_and_sources_follow_the_rows_table`, `test_deflated_sharpe_uses_the_ten_trial_series_of_the_out_of_sample_part`, `test_verdict_needs_more_data_below_100_out_of_sample_trades`, `test_verdict_edge_and_no_edge`, `test_verdict_without_a_probability_is_no_edge`, `test_two_sided_description_by_hand`, `test_live_rows_check_by_hand_and_not_provided`, `test_run_document_and_report_end_to_end` (document keys, limits, the 12 rule items, months rising, the title starts with `Options-side continuation rule (modelled fills)`), `test_rules_item_text_equals_the_fixture_header` (reads `studyRulesItem`), `test_document_refuses_each_of_the_four_cases` (asserts the four messages), `test_cut_text_has_no_outer_space`, `test_options_form_is_left_out_without_spreads`, `test_runner_refuses_a_changed_spec_dirty_code_and_an_out_folder_in_the_repository`, `test_runner_sets_provenance_and_writes_the_four_files`, `test_runner_exit_code_is_1_without_a_study_document`, `test_render_only_rebuilds_the_page`.

#### 20. `services/research/tests/test_flow_control_download.py (new)` (Create)

- **Type / Scope**: pytest, core lane, base run; fake `post` and `sleep`; no network.
- **Proposed Changes**: tests `test_request_bodies_equal_the_fixture_header` (reads `netDriftRequests`), `test_filter_profile_equals_the_fixture_header`, `test_request_body_fills_day_and_ticker`, `test_plan_marks_data_empty_and_pending_and_skips_weekends_and_closed_days`, `test_writes_through_a_temporary_file`, `test_rate_is_one_request_per_interval`, `test_429_waits_retry_after_then_retries`, `test_429_stops_after_max_retries_and_a_second_run_resumes`, `test_5xx_and_network_errors_retry_then_count_as_failed`, `test_401_and_403_raise_auth_error`, `test_invalid_body_is_not_written_and_counts_as_failed`, `test_empty_sessions_end_a_ticker_part_and_existing_empty_files_count`, `test_refuses_a_folder_inside_the_repository`, `test_script_exit_codes_0_1_2`, `test_script_turns_http_and_network_errors_into_tuples`, `test_no_log_line_holds_the_key_a_header_or_a_body`, `test_dry_run_sends_nothing_and_prints_the_estimate`.

#### 21. `services/research/tests/test_flow_control_nautilus.py (new)` (Create)

- **Type / Scope**: pytest, Nautilus lane; skip rule and `VERTEX_REQUIRE_NAUTILUS` handling copied from `services/research/tests/test_trend_trio_nautilus.py:21-32`.
- **Proposed Changes**: tests `test_engine_entry_exit_bars_and_fills_equal_the_rule_module` (long, short, each exit reason, two sessions joined), `test_nautilus_check_reports_same_and_maps_indices_back_to_days`, `test_option_form_ledger_and_engine_agree` (`book_form(..., nautilus=True)`, `maxGap` below 0.01).

#### 22. `services/research/tests/ci-suites.txt` (Modify)

- **Type / Scope**: suite list of the core lane; the script stops when a test file is missing here.
- **Proposed Changes**: append seven lines after line 160, each in the line format `tests/<file name>` (relative to `services/research`), one per test file of entries 15 to 21. Each line is added in the commit that adds its test file.

#### 23. `services/research/tests/ci-suites-nautilus.txt` (Modify)

- **Type / Scope**: suite list of the Nautilus lane.
- **Proposed Changes**: append one line for the test file of entry 21 after line 17, in the same line format.

#### 24. `packages/db/migrations/0080_strategy_catalog_flow_control_continuation.sql (new)` (Create)

- **Type / Scope**: data migration, one row, written after the study ran. Same structure as `packages/db/migrations/0063_strategy_catalog_market_intraday_momentum.sql` (ten columns; `priority` takes its default `normal`, `packages/db/src/schema/index.ts:955-958`; `external_validation` stays NULL because no outside result is claimed). The file is created empty by the command of entry 25 and then filled.
- **Proposed Changes**: three comment lines (line 1: spec path and study id; line 2: research only, options-side rule with modelled fills; line 3: existing slugs are never overwritten), then `INSERT INTO "strategies" ("id", "slug", "name", "description", "kind", "status", "source_ref", "tags", "section", "params") VALUES (...) ON CONFLICT ("slug") DO NOTHING;` with:
  - `id` `strategy-seed-flow-control-continuation`; `slug` `flow-control-continuation`; `name` `Options-side continuation rule (modelled fills): net drift state with trend (ES, NQ, SPY, QQQ)`.
  - `description` (at most 2000 characters), with the values of `study.json`: `Options-side continuation rule with modelled fills. Trend in place (price of the group's primary ticker above its 09:30 price and above its level 30 minutes earlier, or below both) and the options net drift state of rules flow-control-rules.v1 on the same side: enter between 09:45 and 11:30 New York, exit when the state is lost, at a 0.40% stop or at 15:55. Data: QuantData net drift, filter profile otm-clean.v1, <days> sessions from <first> to <last>. Vertex test (<ran>): <verdictReason> The futures and options agreement is not tested. Research only.`
  - `kind` `python`; `status` `backtested`; `source_ref` `docs/specs/strategies/flow-control-continuation.md (new)` (value without the suffix); `section` `Entry timing` (precedent: `packages/db/src/server/strategy-catalog-triple-rsi-migration.test.ts:52`); `params` `[]`.
  - `tags`: `["research-only","backtest-study","options-flow","net-drift","intraday","continuation","futures","es","nq","spy","qqq","debit-vertical"]`, plus `"failed"` only when the verdict is `no-edge` (rule of migration 0073, comment line 3). `backtest-study` links the badge (`packages/api/src/strategy-study-tags.ts:13`).

#### 25. `packages/db/migrations/meta/_journal.json` (Modify)

- **Type / Scope**: generated; never edited by hand.
- **Proposed Changes**: one entry `{ "idx": <next>, "version": "7", "when": <now>, "tag": "<next>_strategy_catalog_flow_control_continuation", "breakpoints": true }`, written by the command below (drizzle-kit 0.31.11; `generate --help` lists `--custom`, "Prepare empty migration file for custom SQL", and `--name`). `packages/db/drizzle.config.ts` throws without `DATABASE_URL`; the command needs the variable but does not connect (`CONVENTIONS.md:105`). The command writes the empty SQL file of entry 24, this journal entry and the snapshot of entry 26. Evidence that 0073 was made this way: `0074_snapshot.json` differs from `0073_snapshot.json` only in `id` and `prevId` (both in `packages/db/migrations/meta/`), which is what a custom migration writes; the commit message of `3f5aa32e` does not record the command (not verified). If drizzle-kit rejects a flag or writes any SQL statement into the new file, stop and report; do not write the journal or the snapshot by hand.

```sh
cd packages/db && DATABASE_URL=postgres://unused:unused@localhost:5432/unused \
  bunx --bun --no-install drizzle-kit generate --config drizzle.config.ts --custom --name strategy_catalog_flow_control_continuation
```

#### 26. `packages/db/migrations/meta/0080_snapshot.json (new)` (Create)

- **Type / Scope**: generated snapshot; the schema is unchanged, so only `id` and `prevId` differ from the snapshot before it.
- **Proposed Changes**: written by the command of entry 25. `DATABASE_URL=postgres://unused:unused@localhost:5432/unused pnpm db:generate` must then print "No schema changes".

#### 27. `packages/db/rollback/0080_strategy_catalog_flow_control_continuation.down.sql (new)` (Create)

- **Type / Scope**: guarded reversal; not the rollback path of the deploy (design section 9).
- **Proposed Changes**: a copy of `packages/db/rollback/0073_strategy_catalog_trend_trio.down.sql` with the migration tag in header line 1, the study id in header line 4 and the id `strategy-seed-flow-control-continuation` in two places: own `BEGIN` and `COMMIT`, lock, refusal `catalog strategy has operator edits or linked rows; refusing rollback` when the row was edited or one of the seven tables references it, then the delete. The stored study is kept.

#### 28. `packages/db/src/server/strategy-catalog-flow-control-continuation-migration.test.ts (new)` (Create)

- **Type / Scope**: Vitest unit test on the SQL text, modelled on `packages/db/src/server/strategy-catalog-market-intraday-momentum-migration.test.ts` (ten-column `ROW` pattern, lines 28-29) and `packages/db/src/server/strategy-catalog-trend-trio-migration.test.ts`.
- **Proposed Changes**: tests `inserts one research-only row that passes the repository field rules` (id, slug, kind, status `backtested`, `source_ref` exists as a file, section `Entry timing`, `params` is an array, the name starts with `Options-side continuation rule (modelled fills)`, tags pass `normalizeStrategyTags` and contain `research-only` and `backtest-study` and not `validated`; the description and the `failed` tag are not asserted), `never overwrites an existing slug`, `is the last journal entry and follows the entry before it` (the entry with this tag is the last one and its `idx` is the `idx` of the entry before it plus 1; no neighbour tag is asserted), `rolls back only the unedited row while nothing references it`.

#### 29. `tests/integration/database/strategy-catalog-flow-control-continuation.test.ts (new)` (Create)

- **Type / Scope**: Vitest integration test on Postgres, same structure as `tests/integration/database/strategy-catalog-trend-trio.test.ts`.
- **Proposed Changes**: tests `inserts the research-only row once, for its backtest study` (new name; selects `id`, `section`, `status`, the tags `backtest-study` and `research-only`, and `external_validation is null`; runs the SQL a second time and still counts 1), then the three names of the precedent (lines 85, 99, 114): `refuses the rollback while the row was edited`, `refuses the rollback while a backtest run references the row`, `deletes the row when nothing references it`.

#### 30. `docs/specs/strategies/flow-control-continuation.md (new)` (Create, then Modify with the results)

- **Type / Scope**: the pre-registered spec; the only spec file. There is no separate `-design.md`: the reasons are in the design document of this feature.
- **Proposed Changes**: title `Options-side continuation rule (modelled fills): pre-registered study`. Sections above "## Results" (frozen by `SPEC_SHA256`): status line; Source; Data (tickers; parts `total` and `zero_dte`, the rule reads `total`; filter profile; folder layout; "from 2025-01-02; the first session with data is found by the download and reported under Results"; usable-day rule and skip reasons of entry 5); Rules (every constant of entries 2 to 4 and Pseudocode B); Variants (N = 10); Futures model (with the decided ES fee); Option position (with the cost stress row); Split (with the window-choice sessions); Pass/fail rule (decided on the out-of-sample part); Known limit (the futures and options agreement is not tested); Code and tests. The frozen part names code only as `services/research/strategies/flow_control/ (new)` (value without the suffix) and the test pattern `services/research/tests/test_flow_control_*.py`, which exist in the freeze commit. The last commit appends "## Results": run date, commit, data hash, first session with data, usable and skipped days, verdict table, results by part, variants, option form, Nautilus check, report location.

#### 31. `docs/vertex-rebuild/flow-pipeline.md` (Modify)

- **Type / Scope**: pipeline guide; `AGENTS.md:42` requires the doc update in the same commit.
- **Proposed Changes**: new section "## Continuation study" before "## Deploy" (line 169): where the code, spec and README are; that the study tests the options side with modelled fills; that the panel's study line reads the stored study `flow-control-continuation`; the import command; that the download and the study never run on the trading server.

#### 32. `docs/vertex-rebuild/strategy-inventory.md` (Modify)

- **Type / Scope**: two tables: "Where strategies are listed" (columns Source and What it holds; the catalog migrations are lines 14-23) and "Other strategy specs" (six columns, line 93).
- **Proposed Changes**: one row at the end of each table, in this order (values in angle brackets come from `study.json`; the card id is not known to this plan):

```text
|`packages/db/migrations/0080_strategy_catalog_flow_control_continuation.sql`|Data migration added by card <card id> (owner request 2026-11-15): the options-side continuation rule with modelled fills (section `Entry timing`, tags `research-only` and `backtest-study`). Insert-if-missing by slug; guarded rollback in `packages/db/rollback/0080_strategy_catalog_flow_control_continuation.down.sql`.|
|Options-side continuation rule ([spec](../specs/strategies/flow-control-continuation.md))|spec; library entry|`services/research/strategies/flow_control/`; runner `research/backtests/flow-control-continuation/run.py`|yes|yes, MODELLED (futures from index prices, Black-Scholes verticals): <verdict> (`research_studies` id `flow-control-continuation`)|Built (<verdict>). Not tested: the futures and options agreement|
```

#### 33. `CHANGELOG.md` (Modify)

- **Type / Scope**: `## [Unreleased]`, list "Added" (heading at line 7; bullets start at line 9).
- **Proposed Changes**: one bullet, placed first at line 9: options-side continuation study with modelled fills (research only), package, runner, download script and the library row.

#### Commit order

1. `refactor(research): extract price_at from the intraday option form` (entry 6; structure only; existing tests pass without edits).
2. `feat(research): flow control rule port, study rule and frozen spec` (entries 1 to 4, 15, 16, the frozen part of 30, two lines of 22). Starts only after pull request 1 is merged.
3. `feat(research): net drift history loader and resumable download` (entries 5, 11, 12, 17, 20, two lines of 22).
4. `feat(research): flow control debit vertical form on the option model` (entries 7, 18, one line of 22).
5. `feat(research): continuation study ledger, split, document, report and runner` (entries 8, 9, 10, 13, 14, 19, 21, two lines of 22, entry 23).
6. Run the study on the research machine (next section). No commit.
7. `feat(db): flow control continuation library row and study results` (entries 24 to 29, the results part of 30, 31, 32, 33). Takes the next free migration number at that time.

#### Study run and import (research machine)

Request count: 4 tickers times 2 parts times D trading days. From 2025-01-02 to 2026-11-13, D is 469 (weekdays that are not closed, counted with `is_closed`), so at most 3,752 requests and 3,752 times 3.75 s = 3.9 hours; the dry run prints the exact count. The key is set for the one download process by the secret manager of the repository rules (`op run`, `docs/security.md:34`); `<env file>` is a file outside the repository with the one line `QUANTDATA_API_KEY=op://<vault>/<item>/<field>`.

```sh
PY=~/.cache/vertex-academy-nautilus-venv/bin/python
DATA=~/Documents/reports/vertex-flow-control-data
OUT=~/Documents/reports/web/vertex-flow-control-continuation/run
# 1. Plan of the download: pending files and time. Sends nothing.
$PY research/backtests/flow-control-continuation/fetch_net_drift.py --data $DATA --dry-run
# 2. Download. Exit code 1 means files are pending or failed: run it again to resume.
op run --env-file=<env file> -- $PY research/backtests/flow-control-continuation/fetch_net_drift.py --data $DATA
# 3. Daily SPY, QQQ, VIX, VXN and T-bill rows for the option model (command of research/backtests/qc-ports/fetch_data.py).
uv run --no-project --python 3.12 --with yfinance==0.2.66 --with xlrd==2.0.2 \
    python research/backtests/qc-ports/fetch_data.py --out ~/Documents/reports/vertex-qc-ports/data
# 4. Sessions, split, skipped days and data hash. Runs nothing.
$PY research/backtests/flow-control-continuation/run.py --data $DATA --dry-run
# 5. Study. Writes data.json, results.json, study.json and index.html into $OUT. Optional: --deep-trades <csv> --live-rows <csv>.
$PY research/backtests/flow-control-continuation/run.py --data $DATA --out $OUT
# 6. Check the document without a database.
bun run vertex:research-studies:import --dry-run < $OUT/study.json
# 7. Store it after the dry run of the import prints no error and the fresh-context review of the report has no open finding.
DATABASE_URL=postgres://... bun run vertex:research-studies:import < $OUT/study.json
```

Production order: apply the migration of entry 24 alone with `psql -v ON_ERROR_STOP=1 --single-transaction` in the `vertex-postgres` container (design section 9), then run step 7 against the production database. The entry shows at `/library?id=strategy-seed-flow-control-continuation&tab=backtests`. With the panel of pull request 1 deployed, its study line changes from "not tested yet" to "Options-side continuation rule (modelled fills): <verdict text>"; the stored study gives that line its verdict (`verdict`), date (`ran`) and rules version (the `rules` entry `Rules version`).

#### Verification

| Command | Proves |
| --- | --- |
| `cd services/research && ~/.cache/vertex-academy-nautilus-venv/bin/python -m pytest tests/test_flow_control_control.py tests/test_flow_control_rules.py tests/test_flow_control_data.py tests/test_flow_control_download.py tests/test_flow_control_options.py tests/test_flow_control_study.py tests/test_flow_control_nautilus.py tests/test_imom_study.py -q` | The Python port gives the fixture values on every golden vector; the tests of entries 15 to 21 pass; the engine books the same bars and fill prices as the rule module; the tests of the code moved in entry 6 still pass |
| `VERTEX_RESEARCH_PYTHON="$(uv python find 3.12)" bash scripts/ci/research-python.sh` (`docs/testing.md:119`) | Every new test file is listed and passes in the locked environments of the core lane, including the Nautilus run |
| `bun run test:json-data` (`package.json:55`) | No JSON data file and no unmarked JSON name entered the repository |
| `pnpm --filter @darkfactory/db exec vitest run --config ../../vitest.config.ts --project unit src/server/strategy-catalog-flow-control-continuation-migration.test.ts` (same command pattern as `packages/db/package.json:64`) | The SQL text inserts one row with the planned values, the journal entry is the last one, and the rollback text holds the guard |
| `bun scripts/with-test-env.ts pnpm exec vitest run --config vitest.config.ts --project integration tests/integration/database/strategy-catalog-flow-control-continuation.test.ts` (same command pattern as `package.json:51`; needs `bun run db:test:up`) | On Postgres the migration inserts the row once, and the rollback refuses an edited or referenced row and deletes an unedited one |
| `DATABASE_URL=postgres://unused:unused@localhost:5432/unused pnpm db:generate` (`package.json:116`) | It prints "No schema changes": the snapshot describes the whole schema |
| `bun run vertex:research-studies:import --dry-run < $OUT/study.json` (`package.json:79`) | The study document passes `ResearchStudyDocumentSchema` |
| `bun run docs:check` and `bun run lint:markdown` (`package.json:65`, `:41`) | Every backticked path in the new documents exists, and the Markdown rules pass |
| `bun run verify:prepush` (`package.json:60`) | Format, lint, typecheck, generated artifacts and the unit, contract and operations suites pass |
