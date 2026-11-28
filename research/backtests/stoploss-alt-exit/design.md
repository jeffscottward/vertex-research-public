# Dry-Run Study of Alternative Exit Rules (Card `stoploss-alt-exit-dryrun`)

> **Status:** Research / dry-run only (owner decision 2026-11-27, owner Discord message (private): keep all 3 live exit rules unchanged; start dry-run study of alternatives). No live order path, arming flag, size, cap, gate, or risk setting is changed by this study.

## Background and Inputs

In PR #489 (`stoploss-stopping-premium-backtests`), the Kaminski-Lo (2014) stopping-premium backtests evaluated the three live exit rules:

| Live Rule | PR #489 Headline Result | Primary Gap in PR #489 |
| --- | --- | --- |
| **A — Share stop ladder** (5-rung, 1×ATR, intraday) | **Fail** (−3.8%/yr, MDD 49.1% → 46.5%) | Survivorship bias (current SP100 list only) |
| **B — 📅 LEAPS exit ladder** (5-rung, 1×ATR, intraday) | **Paid insurance** (−8.9%/yr at 25% premium book, MDD 39.1% → 11.4%) | Black-Scholes model prices; expensive insurance (~0.32 pp/yr per 1 pp MDD removed) |
| **C — Pre-expiry loss close** (close losers at T−3) | **Fail** (−3.5%/yr on 45-day options) | Black-Scholes model prices; no real bid-ask spreads at T−3 vs T−0 |

This dry-run study tests concrete alternative exit rules across all three families while addressing both major data gaps from PR #489 using **free public datasets**:

1. **Survivorship-free point-in-time (PIT) equity universe (`pit.py`):**
   - Historical S&P 500 constituent snapshots (`1996-01-02` to `2026-08-18`, SHA-256 `36326709...`) from `fja05680/sp500`.
   - Every stock is eligible for holding or signal entry **only** while it is an active S&P 500 constituent, including 163 removed-still-trading former constituents that left the index after drawdowns.
   - Explicit coverage accounting (`coverage_summary`) reports **661 / 977 ever-constituents (67.7%)** covered from 2005-01-03 through 2026-11-27 (498 current + 163 removed-still-trading; 316 older delisted tickers lack free Yahoo daily bars, explicitly flagged with `distress haircut = 0%`).
   - Side-by-side non-PIT current-constituent comparison (`A-alt-current`, 498 current constituents) directly measures the survivorship-bias delta.

2. **Free real historical option quotes (`real_quotes.py`):**
   - End-of-day (4:00 PM ET) historical US options chains for **SPY (2008–2025)**, **QQQ (2011–2025)**, and **IWM (2008–2025)** — **15.63 million real contract-day quotes loaded** (SPY 6,744,839; QQQ 4,666,147; IWM 4,222,000; 801 crossed quotes filtered out) from `anahatsingh-ui/options-dataset-hist` (MIT preservation mirror of Philipp D. Dubach's `options-dataset-hist`, recovered from Git LFS and verified byte-for-byte).
   - **Provenance caveat:** The original upstream repository went offline in 2026 and did not document its own underlying market-data vendor; the mirror is used strictly for research reproducibility and is never committed to this repository.
   - **Inherent survivorship-freedom:** SPY, QQQ, and IWM track the point-in-time S&P 500, Nasdaq-100, and Russell 2000 indices over 2008–2025, automatically capturing every constituent addition, removal, and failure.
   - **Real execution friction:** Entries buy long legs at real `ask + commission` and sell short legs at real `bid - commission`. Exits liquidate at real `bid - commission`. Close-confirmed rules execute at exact EOD real bid; intraday rungs anchor from the prior session's close, real bid, and real delta. OTM options on expiry day expire at `$0` with `$0` closing commission; ITM options close at real expiry-day bid (reflecting a 15:45 ET closeout, never exercise), plus a **2× expiry-day spread stress test** (`C0s`).

## Candidate Matrix

Every candidate is evaluated BOTH (1) against **no exit rule** using PR #489's fixed Kaminski-Lo rubric (Δμ after costs, 90% circular block-bootstrap CI, time halves, ±25% threshold stability check, relative MDD cut, insurance cost per 1 pp MDD removed, fixed verdict) AND (2) **head-to-head against the current live rule** (`vsLive`: Δμ vs live, 90% CI vs live, MDD difference, insurance-cost ratio vs live).

### Family A — Share Stop Alternatives (`A-alt-pit`, `A-alt-current`)

- `A0`: **No share stop (buy & hold)** — directly tests removing the share stop.
- `A1` *(LIVE anchor)*: Live 5-rung intraday ladder (`1×ATR`).
- `A2` / `A3`: Wider 5-rung intraday ladders (`2×ATR`, `3×ATR` floor).
- `A4`: Close-confirmed 5-rung ladder (`2×ATR`, triggers only on daily close).
- `A5` / `A6` / `A7`: Single wider trailing ATR stops (`3×`, `4×`, `5×ATR` below peak close, close-confirmed, 50-day SMA reentry).
- `A8` / `A9`: Reference anchors (Kaminski-Lo 21-day −10% window stop; 10-month SMA trend filter).

### Family B — Cheaper 📅 LEAPS Ladder Variants (`B-alt-real`, `B-alt-model-pit`)

- `B0`: **No LEAPS ladder** (time exit T−2 only, zero-cost reference).
- `B1` *(LIVE anchor)*: Live 5-rung intraday ladder (`1×ATR`, 10/15/20/25/30%).
- `B2`: Close-confirmed 5-rung ladder (`1×ATR`, same levels, close-only trigger).
- `B3` / `B4`: Wider 5-rung ladder (`2×ATR` floor, `1.5×` stop distance), intraday vs close-confirmed.
- `B5`: Back-loaded 3-rung close ladder (`1.5×ATR`, 15/30/55%).
- `B6`: Wide 2-rung close ladder (`2×ATR`, 30/70%).
- `B7`: Single deep close stop (`3×ATR` / `2×` stop, 100%).
- `B8`: Grace-period 5-rung close ladder (10-session post-entry grace, `1×ATR`).
- `B9` / `B10`: Single close-confirmed option premium stop (`40%` and `50%` loss of debit).
- `B11`: 2-step premium ladder (`35%` / `55%` loss, 35/65% weights).

### Family C — Pre-Expiry Loss Close Alternatives (`C-alt-real`, `C-alt-model-pit`)

Tested across **45-day calls (0.50 delta)**, **45-day call debit spreads (0.50/0.30 delta)**, and **📅 LEAPS calls (0.75 delta)**:

- `C0`: **Hold losing options to 15:45 expiry-day close (T−0)** (never exercise; OTM expires at `$0` / `$0` comm; ITM closes at real expiry-day bid).
- `C0s`: **Hold to 15:45 expiry-day close with 2× expiry spread stress**.
- `C1` *(LIVE anchor)*: Live T−3 loser close (`T−2` / `T−4` threshold check).
- `C2`: T−1 loser close (1 session before expiry).
- `C3` / `C4`: Deep-loser-only close at T−3 (close only if loss ≥ 50% or ≥ 75% of debit).
- `C5`: Salvage-filtered T−3 loser close (close loser only if executable bid ≥ $0.10 and spread ≤ 25%).

## Empirical Results

Executed on `2026-11-28` (`671.6 s`, `dataEnd = 2026-11-27`, `681` loaded symbols / `661` stocks, `3` non-contiguous tickers skipped: `CPWR`, `GR`, `PARA`; `15.63M` real option quotes loaded across SPY/QQQ/IWM).

### Executive Summary (Dry-Run Takeaways — No Live Change)

1. **Family A (Share Stop):** On the survivorship-free PIT S&P 500 universe, **removing the share stop (`A0`) beats the live 5-rung 1× ATR ladder (`A1`) by `+2.60%/yr` `[+0.96%, +4.22%]`** (MDD `−56.5%` vs `−53.6%`). Removing survivorship bias reduces the live ladder's drag by `+0.82 pp/yr` (from `−3.42%/yr` on current constituents to `−2.60%/yr` on PIT), but **`A1` still fails** (`−3.19%` first half, `−2.01%` second half). Wider 5-rung ladders (`A2`–`A4`) also **fail** and *worsen* MDD (`−59.8%` to `−62.0%`) due to monthly re-entry whipsaw. Only **trailing ATR stops with 50-day MA re-entry (`A5`–`A7`)** flip to **`pass: paid insurance`** (cutting MDD by `26.9%–38.0%` at `0.31–0.34 pp/yr` per 1 pp MDD removed), while the reference **10-month MA trend filter (`A9`)** achieves the cheapest share protection (`0.13 pp/yr` per 1 pp MDD removed, `70.3%` MDD cut).
2. **Family B (📅 LEAPS Ladder):** Real historical option quotes (`749` SPY/QQQ/IWM trades, 2008–2025) **confirm PR #489**: live `B1` is `pass: paid insurance` (`−12.30%/yr`, MDD `−54.6% → −14.9%`, `0.31 pp/yr` per 1 pp MDD removed). The standout alternative is **`B2` (close-confirmed 5-rung 1× ATR ladder)**, which **strictly dominates live `B1` on real quotes on BOTH return and drawdown**: **`+1.26%/yr` `[+0.64%, +1.85%]`** over live, deeper MDD cut (`−12.2%` vs `−14.9%`, `77.6%` vs `72.7%`), and the **lowest insurance cost of all 11 variants (`0.26 pp/yr` per 1 pp MDD removed)** — holding across all three exposures (`6%`, `25%`, `100%`) and confirmed on model-priced PIT stocks (`+0.82%/yr` `[+0.48%, +1.14%]`). For fewer orders, **`B5` (3-rung close 1.5× ATR)** and **`B6` (2-rung close 2× ATR)** save **`+1.97%/yr`** and **`+2.43%/yr`** over live at `0.29 pp/yr` insurance cost with `49%–68%` fewer stop fills.
3. **Family C (Pre-Expiry Loss Close):** On model-priced PIT stocks (`9,406` calls, `9,193` spreads), **holding losers to 15:45 expiry close (`C0`) beats live T−3 (`C1`) significantly**: **`+2.18%/yr` `[+0.37%, +3.78%]`** on 45-day calls and **`+3.05%/yr` `[+1.19%, +4.74%]`** on 45-day debit spreads (live T−3 fails on both; holding still beats live under 2× expiry spread stress `C0s`). On **real SPY/QQQ/IWM quotes** (`839` calls, `822` spreads, `749` LEAPS; `99.6%` real expiry quotes), point estimates agree for 45-day options (**`+3.30%/yr`** on calls, **`+2.46%/yr`** on spreads), but **90% CIs cross zero** (`[−6.54%, +14.75%]` and `[−5.35%, +12.36%]`) because real T−3 spreads are wide (mean `18.4%` calls, `35.1%` spreads) and per-trade recovery is skewed (`8.98%` of 45-day call losers recover to profit, while `67.2%` expire worthless). On real-quote **📅 LEAPS**, live T−3 is near zero (`+0.06%/yr`), and only **`C5` (salvage-filtered T−3: bid ≥ $0.10, spread ≤ 25%)** passes `adds return` (`+0.24%/yr [+0.02%, +0.49%]`, 152 stops).

### Family A — Share Stop Alternatives (PIT S&P 500 vs Current Constituents, 2005–2026)

| Variant | PIT Verdict | PIT Δμ/yr (90% CI) | PIT MDD (Hold → With) | PIT Cut | PIT Cost | PIT Δμ vs Live (90% CI) | Current Δμ/yr | Bias Δ (PIT − Cur) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A0`: No share stop (hold) | not enough data | `+0.00%` | `−56.5% → −56.5%` | `0.0%` | – | **`+2.60%` `[+0.96%, +4.22%]`** | `+0.00%` | `0.00 pp` |
| `A1`: Live 5-rung 1× ATR *(LIVE)* | **fail** | `−2.60%` `[−4.25%, −0.97%]` | `−56.5% → −53.6%` | `+5.3%` | `0.87 pp` | `0.00%` | `−3.42%` | **`+0.82 pp`** |
| `A2`: Wider 5-rung 2× ATR (intraday) | **fail** | `−2.54%` `[−3.77%, −1.33%]` | `−56.5% → −59.8%` | `−5.8%` | – | `+0.06%` `[−0.81%, +0.82%]` | `−3.28%` | `+0.74 pp` |
| `A3`: Wider 5-rung 3× ATR (intraday) | **fail** | `−2.37%` `[−3.42%, −1.43%]` | `−56.5% → −62.0%` | `−9.6%` | – | `+0.23%` `[−1.29%, +1.55%]` | `−2.90%` | `+0.53 pp` |
| `A4`: Close-confirmed 5-rung 2× ATR | **fail** | `−2.55%` `[−3.77%, −1.39%]` | `−56.5% → −60.2%` | `−6.5%` | – | `+0.05%` `[−1.10%, +1.03%]` | `−3.10%` | `+0.55 pp` |
| `A5`: Trailing 3× ATR (close, 50d MA) | **paid insurance** | `−6.69%` `[−10.09%, −2.88%]` | `−56.5% → −35.1%` | `+38.0%` | `0.31 pp` | `−4.09%` `[−6.81%, −1.20%]` | `−7.65%` | `+0.96 pp` |
| `A6`: Trailing 4× ATR (close, 50d MA) | **paid insurance** | `−5.90%` `[−9.15%, −2.40%]` | `−56.5% → −37.8%` | `+33.2%` | `0.31 pp` | `−3.30%` `[−5.92%, −0.58%]` | `−6.75%` | `+0.85 pp` |
| `A7`: Trailing 5× ATR (close, 50d MA) | **paid insurance** | `−5.21%` `[−8.19%, −2.05%]` | `−56.5% → −41.3%` | `+26.9%` | `0.34 pp` | `−2.61%` `[−5.02%, −0.24%]` | `−5.98%` | `+0.77 pp` |
| `A8`: 21d −10% window stop *(ref)* | **paid insurance** | `−4.16%` `[−7.08%, −0.95%]` | `−56.5% → −41.4%` | `+26.7%` | `0.28 pp` | `−1.56%` `[−3.96%, +0.86%]` | `−4.94%` | `+0.78 pp` |
| `A9`: 10-month MA trend *(ref)* | **paid insurance** | `−5.33%` `[−9.56%, −0.62%]` | `−56.5% → −16.8%` | **`+70.3%`** | **`0.13 pp`** | `−2.73%` `[−6.38%, +1.23%]` | `−6.57%` | `+1.24 pp` |

### Family B — Cheaper 📅 LEAPS Ladder Variants (25% Premium Bucket)

#### B-alt-real: Real Historical Option Quotes (`749` SPY/QQQ/IWM LEAPS Trades, 2008–2025)

| Variant | Verdict | Δμ/yr vs Hold (90% CI) | MDD (Hold → With) | MDD Cut | Cost / 1pp MDD | Stops | Δμ/yr vs Live (90% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `B0`: No ladder (T−2 only) | not enough data | `+0.00%` | `−54.6% → −54.6%` | `0.0%` | – | 0 | `+12.30%` `[+5.33%, +19.44%]` |
| `B1`: Live 5-rung intraday 1× ATR *(LIVE)* | paid insurance | `−12.30%` `[−19.48%, −5.36%]` | `−54.6% → −14.9%` | `+72.7%` | `0.31 pp` | 3,154 | `0.00%` |
| **`B2`: Close 5-rung 1× ATR** | **paid insurance** | **`−11.04%` `[−17.80%, −4.74%]`** | **`−54.6% → −12.2%`** | **`+77.6%`** | **`0.26 pp`** | **2,942** | **`+1.26%` `[+0.64%, +1.85%]`** |
| `B3`: Wider 5-rung intraday 2× ATR | paid insurance | `−10.60%` `[−16.89%, −4.91%]` | `−54.6% → −17.9%` | `+67.2%` | `0.29 pp` | 2,663 | `+1.71%` `[+0.07%, +3.32%]` |
| `B4`: Wider 5-rung close 2× ATR | paid insurance | `−9.78%` `[−15.57%, −4.59%]` | `−54.6% → −22.4%` | `+59.0%` | `0.30 pp` | 2,470 | `+2.52%` `[+0.36%, +4.54%]` |
| `B5`: 3-rung close 1.5× ATR (15/30/55%) | paid insurance | `−10.34%` `[−16.58%, −4.63%]` | `−54.6% → −18.7%` | `+65.8%` | `0.29 pp` | 1,613 | `+1.97%` `[+0.54%, +3.35%]` |
| `B6`: 2-rung close 2× ATR (30/70%) | paid insurance | `−9.88%` `[−15.74%, −4.57%]` | `−54.6% → −20.1%` | `+63.1%` | `0.29 pp` | 1,010 | `+2.43%` `[+0.45%, +4.32%]` |
| `B7`: Single deep close 3× ATR | paid insurance | `−9.10%` `[−14.62%, −4.24%]` | `−54.6% → −26.1%` | `+52.2%` | `0.32 pp` | 431 | `+3.21%` `[+0.38%, +5.94%]` |
| `B8`: 10-session grace 5-rung close | paid insurance | `−10.82%` `[−17.41%, −4.87%]` | `−54.6% → −20.8%` | `+62.0%` | `0.32 pp` | 2,732 | `+1.48%` `[+0.02%, +2.76%]` |
| `B9`: Single 40% premium stop | paid insurance | `−8.91%` `[−14.54%, −3.97%]` | `−54.6% → −27.0%` | `+50.6%` | `0.32 pp` | 394 | `+3.39%` `[−0.23%, +6.58%]` |
| `B10`: Single 50% premium stop | paid insurance | `−7.82%` `[−12.73%, −3.49%]` | `−54.6% → −31.8%` | `+41.8%` | `0.34 pp` | 353 | `+4.48%` `[+0.24%, +8.15%]` |
| `B11`: 2-step 35%/55% premium ladder | paid insurance | `−8.21%` `[−13.35%, −3.80%]` | `−54.6% → −29.4%` | `+46.1%` | `0.33 pp` | 760 | `+4.09%` `[+0.08%, +7.56%]` |

*Exposure check (`B2` vs `B1` on real quotes):* at `6%` NLV (`−2.7%` vs `−3.0%/yr`, MDD `−2.6%` vs `−2.6%`), at `25%` bucket (`−11.0%` vs `−12.3%/yr`, MDD `−12.2%` vs `−14.9%`), at `100%` premium (`−44.2%` vs `−49.2%/yr`, MDD `−48.6%` vs `−52.5%`).

#### B-alt-model-pit Cross-Check (`9,752` PIT Stock LEAPS Trades, Model Prices, 2005–2026)

| Variant | Verdict | Δμ/yr vs Hold | MDD (Hold → With) | MDD Cut | Cost / 1pp MDD | Δμ/yr vs Live (90% CI) |
| --- | --- | --- | --- | --- | --- | --- |
| `B1`: Live 5-rung intraday *(LIVE)* | paid insurance | `−10.23%` | `−48.3% → −13.3%` | `+72.4%` | `0.29 pp` | `0.00%` |
| **`B2`: Close 5-rung 1× ATR** | **paid insurance** | **`−9.41%`** | **`−48.3% → −15.0%`** | **`+68.9%`** | **`0.28 pp`** | **`+0.82%` `[+0.48%, +1.14%]`** |
| `B4`: Wider 5-rung close 2× ATR | paid insurance | `−7.91%` | `−48.3% → −24.7%` | `+48.9%` | `0.33 pp` | `+2.32%` `[+1.20%, +3.40%]` |
| `B5`: 3-rung close 1.5× ATR | paid insurance | `−8.68%` | `−48.3% → −20.5%` | `+57.6%` | `0.31 pp` | `+1.54%` `[+0.76%, +2.33%]` |
| `B6`: 2-rung close 2× ATR | paid insurance | `−8.10%` | `−48.3% → −23.0%` | `+52.4%` | `0.32 pp` | `+2.13%` `[+1.11%, +3.11%]` |
| `B10`: Single 50% premium stop | paid insurance | `−5.94%` | `−48.3% → −33.5%` | `+30.6%` | `0.40 pp` | `+4.28%` `[+2.27%, +6.27%]` |

### Family C — Pre-Expiry Loss Close Alternatives

#### Real-Quote Spread & T−3 Loser Recovery Diagnostics (`C-alt-real`, SPY/QQQ/IWM 2008–2025)

| Structure | Trades | Real Expiry Quote % | Median Entry ½-Spread | Mean / p90 T−3 Full Spread | Mean / p90 Expiry ITM Spread | T−3 Losers | Recovered to Profit | Finished > T−3 Bid | Expired $0 | Mean T−3 Bid vs Expiry Payout (% Debit) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 45d Call (0.50Δ) | 839 | `99.6%` | `0.76%` | `18.4%` / `66.7%` | `8.2%` / `18.4%` | 412 (`49.1%`) | `8.98%` (37) | `20.4%` (84) | `67.2%` (277) | `24.9%` vs `23.2%` (`−1.7 pp`) |
| 45d Spread (0.50/0.30Δ) | 822 | `99.6%` | `2.36%` | `35.1%` / `60.0%` | `18.2%` / `38.7%` | 343 (`41.7%`) | `7.87%` (27) | `15.2%` (52) | `77.6%` (266) | `24.0%` vs `19.5%` (`−4.5 pp`) |
| 📅 LEAPS Call (0.75Δ) | 749 | `98.9%` | `1.52%` | `5.9%` / `5.2%` | `3.0%` / `6.6%` | 194 (`25.9%`) | `6.19%` (12) | `25.8%` (50) | `41.8%` (81) | `34.5%` vs `36.9%` (`+2.4 pp`) |

#### Head-to-Head Results vs Live T−3 Close (`C-alt-real` and `C-alt-model-pit`)

| Structure & Variant | Real Quotes Verdict | Real Quotes Δμ vs Hold | Real Quotes Δμ vs Live (90% CI) | Model PIT Verdict | Model PIT Δμ vs Live (90% CI) |
| --- | --- | --- | --- | --- | --- |
| **45d Call** — `C0`: Hold to 15:45 expiry (T−0) | not enough data | `0.00%` | `+3.30%` `[−6.54%, +14.75%]` | not enough data | **`+2.18%` `[+0.37%, +3.78%]`** |
| **45d Call** — `C0s`: Hold to 15:45 (2× spread) | not enough data | `0.00%` | `+1.85%` `[−8.13%, +13.51%]` | not enough data | `+1.38%` `[−0.38%, +2.92%]` |
| **45d Call** — `C1`: Live T−3 loser close *(LIVE)* | inconclusive | `−3.30%` | `0.00%` | **fail** | `0.00%` |
| **45d Call** — `C2`: T−1 loser close | inconclusive | `−0.75%` | `+2.55%` `[−3.87%, +9.51%]` | inconclusive | **`+1.81%` `[+0.24%, +3.32%]`** |
| **45d Call** — `C4`: Deep-loser T−3 (≥75% loss) | inconclusive | `+1.84%` | `+5.14%` `[−2.64%, +15.08%]` | fail | `+0.46%` `[−0.89%, +1.73%]` |
| **45d Call** — `C5`: Salvage-filtered T−3 | inconclusive | `−5.27%` | `−1.97%` `[−5.72%, +0.02%]` | inconclusive | **`+1.44%` `[+0.83%, +2.10%]`** |
| **45d Spread** — `C0`: Hold to 15:45 expiry (T−0) | not enough data | `0.00%` | `+2.46%` `[−5.35%, +12.36%]` | not enough data | **`+3.05%` `[+1.19%, +4.74%]`** |
| **45d Spread** — `C0s`: Hold to 15:45 (2× spread) | not enough data | `0.00%` | `+1.08%` `[−7.37%, +10.92%]` | not enough data | **`+1.95%` `[+0.14%, +3.60%]`** |
| **45d Spread** — `C1`: Live T−3 loser close *(LIVE)* | inconclusive | `−2.46%` | `0.00%` | **fail** | `0.00%` |
| **45d Spread** — `C2`: T−1 loser close | inconclusive | `−2.36%` | `+0.10%` `[−7.01%, +8.04%]` | inconclusive | **`+2.54%` `[+0.85%, +4.11%]`** |
| **45d Spread** — `C4`: Deep-loser T−3 (≥75% loss) | inconclusive | `+0.85%` | `+3.31%` `[−4.01%, +13.04%]` | fail | `+0.53%` `[−0.75%, +1.74%]` |
| **📅 LEAPS** — `C0`: Hold to 15:45 expiry (T−0) | not enough data | `0.00%` | `−0.06%` `[−0.40%, +0.35%]` | – | – |
| **📅 LEAPS** — `C1`: Live T−3 loser close *(LIVE)* | inconclusive | `+0.06%` | `0.00%` | – | – |
| **📅 LEAPS** — `C5`: Salvage-filtered T−3 | **pass: adds return** | **`+0.24%`** | `+0.18%` `[−0.00%, +0.55%]` | – | – |

### Limitations and Remaining Gaps

- **Older delisted S&P 500 stocks:** Free Yahoo Finance bars cover `661 / 977` ever-constituents (`67.7%`, including `163` removed-still-trading names), while `316` older delisted/acquired/bankrupt tickers lack free bars. Because bankruptcies favour holding less and stopping more, the true survivorship-free drag of `A1` is bounded slightly above `−2.60%/yr`, though even a large bankruptcy correction would not rescue the monthly-reset ladder's whipsaw cost (`217,635` stop events).
- **Single-stock real option quotes:** Free real historical option quotes cover broad index ETFs (SPY, QQQ, IWM — inherently survivorship-free and covering 18 years, 0–1,081 DTE), not individual single-stock option chains. Single-stock option cross-checks remain Black-Scholes model-priced (3% half-spread); paid historical single-stock OPRA data would remain a separate owner cost decision if ever needed.
- **Intraday option fill model:** Real option quotes are 4:00 PM ET snapshots. Close-confirmed rules (`B2`, `B4`–`B11`, `C0`–`C5`) execute at exact real EOD quotes; intraday rung fills (`B1`, `B3`) use the prior session's close, real bid, and real delta to avoid look-ahead bias, which may understate intraday volatility spike slippage.
- **Model-PIT bar-end exclusions:** Entries whose stock history ended before option expiry (delisting or data-end) are dropped from the model cross-check (`leaps=0`, `call45=346`, `spread45=559`).

## Reproducibility

```sh
# 1. Fetch free public datasets outside the repository
uv run --no-project --python 3.12 --with yfinance --with duckdb python \
    research/backtests/stoploss-alt-exit/fetch_data.py \
    --out /tmp/stoploss-alt-data --pit-start 2005-01-01

# 2. Run the full dry-run study and generate dark charts + index.html outside the repo
uv run --no-project --python 3.12 --with pydantic==2.13.4 --with duckdb --with matplotlib==3.10.7 python \
    research/backtests/stoploss-alt-exit/run.py \
    --data /tmp/stoploss-alt-data --out /tmp/stoploss-alt-out --pit-start 2005-01-03

# 3. Run unit & integration tests (CI base suite, pure stdlib + pydantic)
cd services/research && uv run --no-project --python 3.12 --with pydantic==2.13.4 --with pytest \
    python -m pytest -q tests/test_stoploss_premium.py tests/test_stoploss_alt_exit.py
```

## Pathway to Any Future Live Decision

This study is strictly research/dry-run and makes **no live change**. Candidate options supported by this evidence for a future owner decision (each requiring explicit owner approval in a separate PR touching live execution config):

- **Share stop (Family A):** Remove the live 5-rung share stop ladder (`A0`) or replace it with a regime/trend brake (`A9` 10-month MA or `A6` trailing 4× ATR with 50-day MA re-entry).
- **📅 LEAPS ladder (Family B):** Switch the live 5-rung intraday ladder (`B1`) to **daily close confirmation (`B2`)** (strictly dominates live on real quotes: `+1.26%/yr` and deeper MDD cut at `0.26 pp/yr` per 1 pp MDD removed) or a **2- to 3-rung close ladder (`B5`/`B6`)** for lower churn.
- **Pre-expiry loss close (Family C):** On 45-day options, evidence points toward removing unconditional T−3 close in favour of **15:45 expiry-day close (`C0`)** or **deep-loser-only T−3 (`C4`)**, though single-ETF real-quote CIs remain wide; on **📅 LEAPS**, a **salvage-filtered T−3 close (`C5`)** is the only variant that passed `adds return` on real quotes.
