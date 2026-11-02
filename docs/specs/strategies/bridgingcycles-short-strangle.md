# BridgingCycles short strangle (research definition)

Status: research only. No live or paper orders. No broker changes.

## Source

- Creator: Instagram @bridgingcycles (uploader id 77824923215).
- Reel: <https://www.instagram.com/reel/DeDxRuNgP2F/> — published 2026-10-04T04:26:36Z, 2:22. Caption: "Here’s how I trade short strangles".
- Knowledge base: `~/Github/knowledge-bases/trading/bridgingcycles-instagram/sources/DeDxRuNgP2F.md` (commit a1637798), with related concepts `volatility-pricing-and-option-selling` and `short-option-position-management`.
- Transcript: faster-whisper small.en, machine-generated and unverified. Quotes below are from that transcript. Timestamps are elapsed video time (m:ss).

## Rules

Each rule states what the creator said (S) or what Vertex assumes (A). Assumptions are not the creator's rules.

| # | Rule | Basis | Quote and timestamp |
| --- | ------ | ------- | --------------------- |
| 1 | Structure: sell one put and sell one call on the same underlying with the same expiration, equal quantity. | S | 0:07 "The short strangle is selling a put and selling a call on the same underlying expiring on the same expiration date." |
| 2 | Exposure: short vega, long theta, range-bound; profit if the underlying stays between the short strikes and IV falls. | S | 0:14 "It's a short vega trade"; 0:21 "we are also long theta"; 0:36 "It is a range bound trade where we want the underlying to stay between our two short strikes." |
| 3 | Underlying: any underlying that currently shows a variance risk premium. TLT is the worked example, not a fixed universe. | S (example) | 0:41 "Let's look at putting this trade on TLT"; 0:46 "We wanna look for an underlying that is currently exhibiting the variance risk premium." |
| 4 | Entry filter: implied volatility above recent realized volatility (VRP = IV − RV). Example: IV ≈ 18%, RV ≈ 10.25% over "the last month of trading days", gap ≈ 7.75 points. | S | 0:50 "This is basically just when implied volatility is higher than the underlying has realized recently"; 0:57 "TLT currently has an implied volatility of roughly 18%, but over the last month of trading days, it's only realized 10 and a quarter percent." |
| 5 | Entry timing: the VRP gap is extreme versus its own history; example rank ≈ 99.2nd percentile over the past 252 trading days, called "prime time". | S | 1:15 "the gap of the variance risk premium is in the 99.2nd percentile ... over the past 252 trading days"; 1:35 "So this would be a prime time to sell a strangle." |
| 5a | Numeric percentile threshold for entry. Vertex default: VRP percentile ≥ 90 over 252 days. | A | The creator gave only the 99.2 example; no threshold was stated. |
| 5b | RV window = 21 trading days; IV = ATM implied volatility of the selected expiry. | A | "last month of trading days" interpreted as 21; IV source/tenor not stated. |
| 6 | Expiry / DTE: the monthly expiration (example: November monthly, ≈ 45–55 DTE from 2026-10-04). | S (example) + A | 1:51 "if we go to the November monthly expiration". Vertex default: nearest standard monthly expiry with 30–60 DTE (assumption). |
| 7 | Strike selection: each short strike just outside the expected move of that expiry. Example: TLT 77.50, expected move ≈ $4, short put 73, short call 82. | S | 1:47 "I typically set my short strikes right outside the expected move"; 1:54 "it is roughly a $4 move up or down"; 1:58 "TLT is at 77 and a half, so I put my short put at 73 and I would put my short call at 82." |
| 7a | Expected move formula: spot × IV × sqrt(DTE/365); strikes = first listed strike beyond spot ± expected move. No delta rule. | A | The creator gave no formula or delta. |
| 8 | Execution: open both legs at the same time; do not leg in or out. | S | 2:07 "I intend on selling these at the same time. I do not lag [leg] in or out" |
| 9 | Exit: close both legs together "once I've gotten adequate premium". | S | 2:11 "then I will take them off at the same time once I've gotten adequate premium out of the options." |
| 9a | Numeric profit target: close at 50% of entry credit captured. Time stop: close at 21 DTE if still open. | A | "Adequate premium" is undefined. |
| 10 | Stop loss / adjustments. Vertex default: close both legs when the mark reaches 2× entry credit (loss = 1× credit) or at expiry; no rolling. | A | The creator stated no stop, no adjustment and no rolling rule in this Reel. |
| 11 | Sizing. Vertex default: fixed 1 contract per leg in research; record margin as unknown (undefined risk). | A | Not stated. |
| 12 | When not to trade: no VRP (IV ≤ RV) or VRP not extreme. | S (implied by 0:46–1:38) | The only stated condition is the VRP filter. Other exclusions (events, earnings, illiquid chains) are assumptions (A). |

## Risk notes

- A short strangle has undefined risk on both sides. The range-bound intent does not cap losses.
- The "one of my most profitable option strategies" claim (0:00) is unverified.
- Figures (IV, RV, percentile, strikes) are point-in-time readings from machine transcription.
