# Code Review Round 1 — `stoploss-alt-exit-dryrun`

Fresh-context technical review of all 6 new modules/scripts (`pit.py`, `real_quotes.py`, `alternatives.py`, `test_stoploss_alt_exit.py`, `fetch_data.py`, `run.py`) against their `stoploss_premium` dependencies.

## Findings and Resolutions

All 15 findings (4 High, 7 Medium, 4 Low) were fixed before the final empirical run and covered by regression tests in `services/research/tests/test_stoploss_alt_exit.py`:

| # | Severity | Area | Finding | Resolution |
| --- | --- | --- | --- | --- |
| 1 | High | `real_quotes.py` | Intraday rung fill anchored on same-day EOD bid + fallback same-day delta leaked EOD IV spikes and biased crash-day fills upward | Anchored strictly to prior-day close (`prev_bid + prev_delta * (spot - prev_close)`), zero same-day EOD leak |
| 2 | High | `alternatives.py` | `C0s` (2× expiry spread stress) compared against `1×` `live_legs`, penalizing `C0s` on T−3 winners | Built matching `live_stress_legs` at `expiry_spread_mult=2.0` for apples-to-apples comparison |
| 3 | High | `real_quotes.py` | Zero-bid ITM options on expiry liquidated at `$0.00`; timestamp dates compared before `[:10]`; `mark` unclamped | Fall back to `intrinsic - commission` (`has_real_expiry_quote=False`) on zero-bid ITM at expiry; slice dates before compare; clamp `mark` within `[bid, ask]` |
| 4 | High | `run.py` | Chart variant filters omitted parenthetical delta text in `study.CALL45`/`study.SPREAD45`, dropping Family C bars | Built chart prefixes directly from `study.CALL45` and `study.SPREAD45` |
| 5 | Medium | `alternatives.py` | `flex_ladder_levels` violated `min_atr` floor and collapsed rungs upward when `min_atr > stop_scale` | Enforced `cap = und_limit - min_atr * atr14` and spaced deeper rungs by `0.25 * atr14` when `cap <= eff_stop` |
| 6 | Medium | `run.py` | Model-priced PIT option tests silently dropped entries whose bars ended before expiry | Counted and logged `droppedCounts` explicitly in `B-alt-model-pit` / `C-alt-model-pit` bias notes |
| 7 | Medium | `real_quotes.py` / `run.py` | LEAPS expiring past `book.last_date` silently carried stale quotes forward | Exposed `QuoteBook.last_date`, derived dynamically in `run.py`, and rejected trades in `open_real_trade` when `exit_date > book.last_date` |
| 8 | Medium | `real_quotes.py` | DuckDB SQL broke on puts (`delta BETWEEN 0.15 AND 0.90`), stripped post-entry lifecycle on `min_dte_filter`, and cast `date::VARCHAR` directly | Used `ABS(raw.delta)`, applied DTE filter only to `picked` CTE, cast `date::DATE::VARCHAR` |
| 9 | Medium | `real_quotes.py` | `monthly_only` heuristic accepted Thursday 0DTE/weekly expiries and 2nd-Friday-the-14th | Matched exact OCC standard monthly expiry via `options.expiration(y, m)` (plus pre-2015 Saturday OCC date) |
| 10 | Medium | `alternatives.py` | `loser_recovery_stats` computed dollar-debit-weighted ratios instead of equal-capital per-trade means | Averaged `b_early / t.debit` and `b_exp / t.debit` per losing trade |
| 11 | Medium | `fetch_data.py` | `pit_symbols` omitted the latest PIT snapshot `<= start` | Included latest snapshot `<= start` matching `PitMembership.ever_members` |
| 12 | Low | `fetch_data.py` | Single-ticker `yfinance` MultiIndex batch could raise `KeyError` | Indexed `df[sym] if sym in df.columns else df` |
| 13 | Low | `pit.py` | `coverage_summary` `byYear` checked `dates[-1] >= Jan 1` instead of `>= probe` | Checked `dates[-1] >= probe` |
| 14 | Low | `alternatives.py` | `C5` threshold checks moved `min_bid` and `max_spread_pct` in opposite restrictiveness directions | Paired looser (`0.075`, `0.3125`) vs tighter (`0.125`, `0.1875`) consistently |
| 15 | Low | `test_stoploss_alt_exit.py` | Missing PEP 8 blank lines and regression test coverage for findings 1–14 | Fixed formatting and added full regression tests (83 passing) |

Also fixed on the spot during initial empirical execution: `options.Underlying.rate()` now floors at `0.0` because Yahoo `^IRX` briefly went negative in March 2020 and `qc_ports.options.bs_price` requires `r >= 0` (regression test added).
