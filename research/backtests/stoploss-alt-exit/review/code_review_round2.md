# Code Review Round 2 — `stoploss-alt-exit-dryrun`

Fresh-context verification of all 15 Round 1 fixes and the `options.py` negative-IRX rate floor fix.

## Round 2 Findings and Resolutions

Round 2 verified 13 of 15 Round 1 fixes completely and surfaced 4 remaining findings (1 High, 1 Medium, 2 Low), all fixed and covered by regression tests (`84 passed` in `test_stoploss_premium.py` + `test_stoploss_alt_exit.py`):

| # | Severity | Area | Finding | Resolution |
| --- | --- | --- | --- | --- |
| 1 | High | `alternatives.py` | `if cap <= eff_stop + 0.01:` fired when `cap == eff_stop`, widening live anchor `B1` (`min_atr=1.0, stop_scale=1.0`) from `1× ATR` to `2× ATR` on `1× ATR`-floored entries | Changed guard to `if cap < eff_stop - 1e-9:`, restoring exact bit-for-bit parity with `optiontests.ladder_levels` on `B1` while preserving the `min_atr > stop_scale` fix; added regression test |
| 2 | Medium | `real_quotes.py` | Pulled `0.0/0.0` quote on an ITM short leg of a vertical spread at expiry lacked the symmetric intrinsic fallback of the long leg | Mirrored the expiry ITM zero-ask fallback on the short-leg branch (`from_real_quote=False`) so spread payout never exceeds spread width; added regression test |
| 3 | Low | `real_quotes.py` / `run.py` | `RealTrade.exit_bid` docstring and `real_bias` still said "from EOD bid" instead of prior-day close / prior real bid & delta | Updated both strings to match the prior-day anchor implementation |
| 4 | Low | `alternatives.py` / `run.py` / tests | Unused imports (`trade_returns`, `premium`), PEP 8 blank line before `test_underlying_rate_floors_negative_irx`, and `build_model_pit_sets` return type annotation mismatch | Removed unused imports, fixed blank line, and typed `build_model_pit_sets` as returning `(sets, dropped)` tuple |
