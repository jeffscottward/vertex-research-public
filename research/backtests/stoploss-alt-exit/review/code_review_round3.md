# Code Review Round 3 — `stoploss-alt-exit-dryrun`

Fresh-context delta review verifying all 4 Round 2 fixes (`services/research/strategies/stoploss_premium/alternatives.py`, `services/research/strategies/stoploss_premium/real_quotes.py`, `research/backtests/stoploss-alt-exit/run.py`, `services/research/tests/test_stoploss_alt_exit.py`).

## Verdict

**ZERO open findings remain.** All 4 Round 2 findings are resolved cleanly with no regressions.

## Finding-by-Finding Verification

| # | Severity | Area | Verification |
| --- | --- | --- | --- |
| 1 | High | `alternatives.py` (`flex_ladder_levels`) | Guard updated to `if cap < eff_stop - 1e-9:`. Live anchor `B1` (`min_atr=1.0, stop_scale=1.0`) matches `optiontests.ladder_levels` bit-for-bit on `1× ATR`-floored entries while `min_atr > stop_scale` variants still widen `eff_stop`. Covered by `test_round2_regressions_live_b1_parity_and_spread_short_zero_ask`. |
| 2 | Medium | `real_quotes.py` (`_structure_quote`) | Short-leg expiry branch mirrors the long-leg intrinsic fallback (`is_expiry and leg_intr > 0.0 and q.ask <= 0.0` -> `(intr, max(0.0, intr - comm), 0.0, None, False)`), preventing spread payouts from exceeding spread width on pulled `0.0/0.0` quotes. Covered by `test_round2_regressions_live_b1_parity_and_spread_short_zero_ask`. |
| 3 | Low | `real_quotes.py` / `run.py` | `RealTrade.exit_bid` docstring and `real_bias` string in `run.py` both accurately describe prior-day close and prior real bid/delta intraday anchoring; no stale `"from EOD bid"` text remains. |
| 4 | Low | `alternatives.py` / `run.py` / tests | Unused imports removed (AST check confirmed 0 unused imports across all 4 files), `build_model_pit_sets` return type matches `(sets, dropped)` tuple, PEP 8 blank lines fixed. |

## Test Verification

```sh
cd services/research && uv run --no-project --python 3.12 --with pydantic==2.13.4 --with pytest --with pyarrow python -m pytest -q tests/test_stoploss_premium.py tests/test_stoploss_alt_exit.py
```

Result: `84 passed in 0.50s` (0 failures, 0 warnings).
