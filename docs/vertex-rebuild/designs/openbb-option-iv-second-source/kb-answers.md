# KB consultation evidence (saved answers and errors)

Recorded 2026-11-21 from the rig, kb-chat API at 127.0.0.1:8787. One neutral question per agent;
no account values. All three runs returned no answer: the model backend was at its usage limit.
The decision rests on `trading/_master-rules/rules.jsonl` (the standing rule's other named source);
see `kb-decision-record.md`.

## QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels)

- Agent id: `kb-quantfinancetogo-bdac178174f6`
- Thread: `44f55f28-f435-4b10-96e4-ebd5af161b89`
- Asked at: 2026-11-21T12:09:32Z
- Answer: (empty)
- Errors: The model usage limit has been reached. Try again after your access resets. No fallback was attempted.

Question (verbatim):

> A daily research pipeline stores 30-day constant-maturity ATM implied volatility for 7 ETFs from exchange (Cboe) option chains. The exchange feed is blocked, so a fallback reads Yahoo's per-contract implied-volatility column (a vendor model, calls and puts disagree at one strike by a median of ~3-5 vol points) and computes delta/gamma with Black-Scholes (rate 4%, trailing dividend yield). Measured level difference vs a bid/ask-mid Black-76 method: +0.5 vol points at 56 days; the stored-history boundary jump (one session of market move included) is +4 to +8 vol points. The IV percentile ranks the newest value against 252 stored sessions. Is it acceptable to mix the vendor-model segment into the percentile history if every fallback session is explicitly marked (run warning + panel note), or should the percentile exclude fallback sessions? What do your sources say about vendor IV columns vs mid-based IV for research time series?

## Skydweller Trades (futures order flow, market profile, gamma levels)

- Agent id: `kb-skydweller-07b18e4adfdd`
- Thread: `01c457aa-501c-4132-99bc-aa0a5b9cfa54`
- Asked at: 2026-11-21T12:09:52Z
- Answer: (empty)
- Errors: The model usage limit has been reached. Try again after your access resets. No fallback was attempted.

Question (verbatim):

> A daily research pipeline stores 30-day constant-maturity ATM implied volatility and gamma exposure (GEX) levels for 7 ETFs from exchange (Cboe) option chains. The exchange feed is blocked, so a fallback reads Yahoo's per-contract implied-volatility column (a vendor model) and computes delta/gamma with Black-Scholes. Is it acceptable for research (not order execution) to mix the vendor-model segment into the stored IV-percentile history if every fallback session is explicitly marked, or should the percentile exclude those sessions? How reliable are vendor IV columns vs exchange/mid-based IV for gamma levels?

## Andrea Cimitan

- Agent id: `kb-andrea-cimitan-1b25ed78a28b`
- Thread: `c906ef16-3465-491a-b323-8fc8638a1aee`
- Asked at: 2026-11-21T12:10:18Z
- Answer: (empty)
- Errors: The model usage limit has been reached. Try again after your access resets. No fallback was attempted.

Question (verbatim):

> A daily research pipeline stores 30-day ATM implied volatility and GEX levels for 7 ETFs from Cboe option chains. Cboe is blocked; a fallback would read Yahoo's vendor IV column and compute greeks with Black-Scholes, marking every fallback session. For research display (not orders): is a marked vendor-model segment acceptable in the IV-percentile history, or should those sessions be excluded? Your rule andrea-cimitan:indicator:3 prefers CBOE-sourced flow over naive OI GEX — does that argue against the fallback entirely?
