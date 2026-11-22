# Gamma flip rule and gamma sources (card vertex-gamma-flip-sources)

![Before and after: gamma flip per source](before-after.png)

Status: implemented on branch `ws/gamma-flip-sources`. Merged card: gamma-volume-value-area.

## Problem

- `openbb_option_iv_daily.gamma_flip` was NULL on every row for SPY, QQQ and IWM from 2026-11-09 to 2026-11-20. Every NULL row had `net_gex` < 0.
- Cause (code, `services/openbb/vertex_openbb/options_math.py` before this change): the job added net GEX per strike from the lowest strike up and returned the strike where the running sum changed sign. When total net GEX is negative, the running sum can end negative without a sign change, so the result was NULL. A small call position at a deep strike gave a false early crossing far from spot (GLD flip 105 at spot 343.98; SLV flip 16 at spot 39.01).
- Three places show a gamma flip and walls, and they disagreed for QQQ on 2026-11-19 (flip 666.38 against 669.86; call wall 700 against 680).

## Method decision

Question sent to the trading knowledge bases: "How is the gamma flip level defined and computed: as the spot level where total dealer gamma, re-priced at that spot, changes sign, or as the strike where cumulative per-strike net GEX changes sign? How are call and put walls defined?"

- Knowledge-base answer: the KBs use the flip as a regime boundary ("Treat the zero-gamma flip as the regime boundary: above it levels tend to hold, below it the same levels accelerate moves", `trading-verrillo-aleks:regime:15`; "HVL is the strike where gamma flips", `trading-verrillo-aleks` GEX daily model). They give no computation rule. The answer comes from a direct search of `_master-rules/rules.jsonl` and `_master-rules/extracts/` on 2026-11-22; the KB-chat server was not used.
- Primary practice: vendors that publish a "zero gamma" level (SpotGamma, the market-watch-bot model in this stack) compute it as the spot level where the total dealer GEX profile, re-priced at hypothetical spots with each contract's IV held fixed, crosses zero. The per-strike cumulative rule is a shortcut that is undefined when the total is negative.
- Decision: use the spot sweep. It is defined for any sign of total GEX, a deep stray contract has almost no gamma near spot and does not move it, and it is the method the market-watch-bot source (S7) already uses, so two of the three sources now agree in method.

Rule now in `options_math.gamma_flip`:

1. Contracts with IV > 0, open interest > 0 and expiry after the session date (0 DTE is excluded, as before).
2. For 121 trial spots from 0.85 x spot to 1.15 x spot (step 0.25% of spot): re-price gamma of each contract with Black-Scholes-Merton (its own IV and days to expiry / 365, rate 4%, no dividend) and sum `gamma * OI * 100 * S^2 * 0.01`, calls positive, puts negative (dealers long calls, short puts).
3. Every sign change between two neighbouring trial spots gives a crossing by linear interpolation. The crossing nearest spot is the flip.
4. NULL when no crossing lies inside +/-15% of spot, when no contract has an IV, or when spot is not a positive number.

Walls are unchanged in the OpenBB job: call wall = strike with the largest call gamma x OI; put wall = strike with the largest put gamma x OI.

Runtime: about 1 s per underlying on a 10,000-contract chain (measured 2026-11-22 on omarchy-rig: SPY 1.1 s, QQQ 0.8 s, IWM 0.4 s). The job runs once per session per symbol, so this is acceptable.

## The three gamma sources

|Property|S7 `marketContext.get` (market-watch-bot `gex.json`)|S8 `flow_gex` (`gex-context.ts`)|OpenBB `openbb_option_iv_daily`|
|---|---|---|---|
|Data|QuantData open interest and IV, intraday|QuantData open interest and chain IV, intraday (every 15 min)|Cboe delayed chain (Yahoo chain as fallback while Cboe answers 403), end of day|
|Expiries in gamma|each expiry with its own time and IV|aggregate OI of all expiries, priced with the front expiry's years and IVs|each contract with its own days to expiry and IV|
|Flip rule|spot sweep +/-15%, 0.25% steps, IV fixed|spot sweep +/-30%, 120 steps (0.5%), IV fixed|spot sweep +/-15%, 0.25% steps, IV fixed (new)|
|Rate|0|0|4% (`RISK_FREE_RATE`, same as the portal greeks)|
|Call / put wall|strike with largest call / put GEX|strike with largest / most negative net GEX|strike with largest call / put gamma x OI|
|Dealer sign|long calls, short puts|long calls, short puts|long calls, short puts|

QQQ on session 2026-11-20 (values read on 2026-11-22):

|Source|Time|Spot|Flip|Call wall|Put wall|
|---|---|---|---|---|---|
|S7 market-watch-bot|20:53 UTC|610.76|659.56|700|610|
|S8 `flow_gex`|21:08 UTC|612.81|674.34|646|600|
|OpenBB stored row (old rule)|close|608.45|NULL|700|600|
|OpenBB recomputed (new rule, Yahoo chain)|close|608.45|655.20|700|600|

Reasons for the differences:

- S8 against S7 and OpenBB (flip about 15-19 points higher): S8 prices the OI of every expiry with the front expiry's time to expiry. Short time gives high gamma at the money and low gamma away from it, so the call gamma above spot takes over later and the crossing moves up. S7 and OpenBB use each expiry's own time.
- S7 against OpenBB (4.4 points): different snapshot (intraday 20:53 UTC against the close), different spot (610.76 against 608.45; the flip scales with spot), OI source (QuantData against Yahoo), and rate (0 against 4%).
- Walls: S8 uses net GEX per strike (calls minus puts at the same strike), so a strike with both large call and put OI ranks lower; S7 and OpenBB rank call and put gamma separately. S8's call wall moved from 670 (19:54 UTC) to 646 (21:08 UTC) as front-expiry IVs changed.

Reference source: the OpenBB row is the reference for daily research (one value per session, all expiries priced with their own time, stored with its source and as-of date). S7 is the intraday reference (same method). S8 stays an intraday estimate. Source labels: the OpenBB panel shows the row's as-of date and the source notice of the `cboe-option-iv` run (`openbb-panels.tsx`); the options analytics panel labels its flip "Gamma flip (est.)"; the flow page "GEX levels" panel shows "GEX as of" and, new in this change, a source line (QuantData open interest and IV, an estimate priced with the front expiry's time). `marketContext.get` returns `gex.asOf`. No contract change is needed.

## Old rows

The Cboe source gives only the current chain; it has no history, so stored sessions cannot be recomputed. Only sessions after the runner update get a flip. Rows from 2026-11-09 to the runner update keep NULL.

## `cboe-option-iv` partial status

All runs since 2026-11-09 are `partial`. The cause is the Yahoo fallback warning (Cboe answers 403; card vertex-openbb-cboe-403), which keeps the run partial on purpose. The "skipped 224 rows without a standard OCC symbol" warning for SPY counts adjusted contracts (for example `B1SPY...`, non-standard deliverables after a corporate action). Skipping them is expected. Decision: such skips are expected and should not make a run partial; the change lives in `services/openbb/vertex_openbb/jobs/cboe.py`, which card vertex-openbb-cboe-403 and card openbb-iv-history-caveat hold, so this job does not change it. The note is added to card vertex-openbb-cboe-403.

## Volume-weighted value area (merged card gamma-volume-value-area)

- Before: `services/research/gamma/features/market_structure_features.py` used the 30th-70th percentile of closes as the value area.
- KB answer: the value area is the 70% of volume around the point of control (POC), per auction market theory (`trading-verrillo-aleks` exits 9 and the "Volume Profile / Market Profile, session value area, POC" indicator entries).
- After: a volume profile from the OHLCV rows (each bar's volume spread evenly over the price bins from its low to its high; bin = 0.1% of the last close, at least $0.01), POC = largest bin, expanded by the larger neighbour until 70% of volume is inside. Ported from market-watch-bot `market_watch/auction/profile.py`. When any row has no positive volume, or no row has a valid range, the old close-distribution approximation is used and `raw.value_area_method` says which method ran.

## Tests

- `services/openbb/tests/test_gamma_flip.py`: negative total net GEX gives a flip inside +/-15% of spot; deep stray contracts do not move it; nearest crossing wins; NULL cases.
- `services/openbb/tests/test_units.py`: the summary test uses the new rule.
- `services/research/tests/test_value_area.py` and `test_boundaries.py`: profile, value area expansion and ties, fallbacks.

## Live check

After the runner update, the next `cboe-option-iv` run must make this query return 3:

```sql
select count(*) from openbb_option_iv_daily
where as_of = (select max(as_of) from openbb_option_iv_daily)
  and underlying in ('SPY','QQQ','IWM')
  and gamma_flip between underlying_price * 0.85 and underlying_price * 1.15;
```

Recompute on 2026-11-22 from the live Yahoo chain with the new code: SPY 733.51 (spot 689.81, +6.3%), QQQ 655.20 (spot 608.45, +7.7%), IWM 294.38 (spot 256.61, +14.7%). All three are inside the band.

Out of scope: changes to the `flow_gex` collection, new paid sources, any use of a gamma level as a trade trigger.
