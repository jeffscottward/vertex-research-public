# "Who is in control" signals on /flow

- **Author:** Jeff Scott Ward
- **Date:** 2026-11-15

## Overview

The operator trades continuation moves only when the futures tape and the options premium flow show the same side in control. `/flow` gets a control panel per index group (S&P 500: ES, SPY, SPX; Nasdaq 100: NQ, QQQ, NDX). The options side comes from the already-paid vendor's net drift series. The futures side comes from large aggressive trades on ES and NQ ("deep trades"). Each side has one named state with its reason, start time, measured ratio and coverage. An offline study tests one continuation rule and stores its verdict in the Strategy Library. Research only: nothing here places, changes or cancels an order.

## Analysis

Seven goldfish reviewers read the concept on 2026-11-15 (reports in `../goldfish/`). All seven ran. Their findings, merged:

1. **Budgets break first.** With four full symbols the tick rotation gives each symbol one fetch per 440 to 480 s. That is past the 350 s "starved" limit, so `/charts` loses its priority for good, and coverage halves. One collect run could need 40 QuantData requests against a client limit of 30 per minute that refuses instead of waiting. Resolution: split "symbol" into three sets (tick instruments, option tickers, groups). QQQ gets no tick sampling and QQQ and NDX get no option-print paging. Net drift is one small request per ticker and part, read first in the run, with a per-run request cap.
2. **A sum over a sample is not a session total.** The futures tape is seen for 19% to 40% of regular-session seconds (ES, measured). A running sum grows with coverage, and "no large trade seen" is not "no large trade". Resolution: the futures state uses a ratio over the seconds that were seen, takes coverage as an input, and returns the named state "Not enough tape seen" below a floor. Every figure says "sampled" and gives its coverage. Each stored trade records how it was captured.
3. **Two verdicts on one page confuse.** The page already has a three-vote "confluence" line with the words "agree" and "disagree". Resolution: the control panel is the one headline. The confluence block stays in the snapshot document, moves below the panel as "Short-term factors", and its badge becomes a count. The word "agree" is used only for futures against options.
4. **"Buyers in control" is not definite for options.** A put buyer is a seller of the market. Resolution: every label names its instrument and the market direction ("SPX options: bearish, put buying leads"), the contract carries an enum state, a direction, a no-data reason and a detail sentence built from one rules object, and the measured ratio is shown next to its limit in place of an invented strength score.
5. **Session values must not depend on the chart window.** The state and its start time are computed from the session open and do not change with the `minutes` input.
6. **Rollout safety.** Seven check constraints fix the symbol list, the collector does not catch storage errors, and migrations on the trading server are applied by hand. An app deployed before its migration would stop SPY and ES sampling. Resolution: migrations only widen (old app runs on the new database), storage errors become `unavailable` samples per source, the control data is a new read procedure so the existing `flow-snapshot.v1` document and its readers do not change, and rollback means "previous app on the new database".
7. **One home for each fact.** Symbol facts are spread over about 20 places with two-way branches that would silently misclassify QQQ and NQ. Thresholds would exist in code, labels, docs, catalog and study. Resolution: one instrument and group registry, one versioned rules object, a rule version in the control document and in the study verdict.
8. **The study can start now.** The vendor serves the net drift history, so the test needs no product code. Its verdict is shown on the panel so that the label does not claim more than the test found.
9. **History facts corrected.** The vendor history starts between 2024-12-16 and 2025-02-14, so about 440 sessions exist, not 190. The download runs from the research machine at about 16 requests per minute.
10. **Inventive resolution for the tape:** fetch futures trades without the quote request (one IBKR request in place of two) if tick-rule signing agrees with quote-rule signing, which adds NQ at no extra budget; and complete each session off-hours from IBKR history. Both leave the live budget unchanged. Streaming stays an owner decision.

## Goals vs. Non-Goals

- **In-Scope Goals:**
  - Net drift for SPY, QQQ, SPX and NDX: per-minute net call and put premium and volume, same-day expiry and longer as separate series, cumulative lines, current value, slope.
  - Deep trades for ES and NQ: large aggressive trades (single prints at or above a size limit), their signed running sum over the seen tape, and absorption marks from the existing rule.
  - One control panel per index group with a futures state, an options state, their agreement, the reasons, start times and freshness, on `/flow` and through an agent tool.
  - Semantic catalog terms that name the three ideas and point to the agent tool.
  - An offline continuation study with a stored verdict and a Strategy Library entry.
- **Out-of-Scope Non-Goals:**
  - Streaming tick-by-tick data (owner decision, asked separately).
  - Marker types that need market-by-order data (resting-order size).
  - Tick sampling and option-print paging for QQQ and NDX.
  - Any order, arming, sizing or risk change. No new paid data.
  - Automatic adaptation of the size limit (needs a full tape to measure without sampling bias).

## Alternatives Weighed

- **Extend the confluence line and build no panel.** Rejected by author: the task requires a futures state and an options state with "since when" per side; the confluence votes use other data and horizons. The panel becomes the headline and the confluence block is kept as supporting rows.
- **Wait for streaming before showing deep trades.** Rejected by author: the owner asked for the view now. The sampled view ships with a coverage floor and named states; streaming and off-hours completion are offered as one owner decision.
- **Four full flow symbols (ticks, depth, prints, GEX for QQQ and NQ).** Rejected by author: it exceeds the IBKR and QuantData budgets (measured constants: 110 s stagger, 350 s starved limit, 30 requests per minute).
- **Net drift computed only from stored option prints.** Rejected by author: stored prints are a paged, unfiltered subset; the vendor series is complete and filtered. The stored prints give only a direction cross-check for SPY and SPX.
- **No expiry split.** Rejected by author: the task requires same-day and longer expiries as separate series; the cost is one extra request per ticker and cycle.
- **Add the new fields to `flow-snapshot.v1`.** Rejected by author: every schema is strict, so old readers would reject new keys; a separate `flow.control` procedure ships and rolls back alone.
- **Store per-minute sums and state transitions.** Rejected by author for the first version: sums are derived on read from stored trades; the control document carries its inputs and rule version, which explains the current state. A stored transition log is a later improvement.
- **SQL or feed terms in the semantic catalog.** Rejected by author: the reader role has no grant on flow tables and feed readers are bound to the account feed; vocabulary terms that point to the agent tool follow the existing pattern of migration 0074.
- **Run the study on four instruments at once.** Rejected by author in part: thresholds are frozen first and every variant counts as a trial; the option position is modelled and reported separately.
- **Download history through the trading server's collector.** Rejected by author: the trading server must stay free of research batch work; the research machine downloads at a low fixed rate and the run is resumable.

## Key Decisions & Staging for Next Steps

1. Three sets in one registry: flow symbols (SPY, QQQ, ES, NQ), option tickers (SPY, QQQ, SPX, NDX) and groups (sp500, nasdaq100). Per symbol the registry lists its sources; QQQ has depth, GEX and net drift only.
2. Tick schedule inside today's IBKR share (2 of 6 requests per 120 s): SPY keeps trades plus quotes; ES and NQ fetch trades only. Measured after the review (regular session of 2026-11-13): the quote request signs only 6% to 17% of futures prints today, so dropping it changes little and adds NQ at no extra request.
3. Net drift table keyed by option ticker, expiry part and minute, with a filter profile id; each cycle re-reads the session and upserts changed rows; no gap table. New source `net_drift` with its own due and stale times; freshness from the newest stored bucket.
4. Deep trades in their own table keyed by symbol, second and an order number, with size limit, signing method and capture mode; sums derived on read. Measured after the review: adding same-second prints marks price runs, not single orders (136 groups against 3 single prints on ES), so a deep trade is one print. One size limit per market from measured data (ES 40, NQ 10 contracts), shared with the existing `large_print` event; the `absorption` rule is unchanged.
5. New procedure `flow.control({ group })` with document `flow-control.v1` and an MCP tool; `flow.snapshot` keeps its document.
6. One rules object with a version: 15-minute window, enter and exit limits, minimum minutes, coverage floor. Options state from call-minus-put net premium as a share of the premium that traded; primary ticker per group (SPX, QQQ) with the second ticker as a check. Futures state from net large-trade volume with price progress.
7. Retention map per table: two years for net drift, deep trades and tick minutes; 14 days for the rest.
8. Method choices come from the knowledge-base consult of 2026-11-15 (`../kb-consult/decision-record.md`).
9. Three pull requests: (1) registry refactor, net drift, control procedure and panel; (2) deep trades, futures state, agreement, catalog terms; (3) study and Strategy Library entry.
10. One owner decision, asked with a chart and not blocking: how to complete the futures tape (streaming time-and-sales on two ordinary market-data lines, off-hours completion from history, or sampled only).
