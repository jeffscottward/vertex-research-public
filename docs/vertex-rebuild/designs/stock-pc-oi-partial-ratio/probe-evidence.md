# Probe evidence: Put/call OI coverage of live chains

This file holds the read-only scripts behind the numbers of [plan.md](plan.md) and their complete output. The scripts are evidence, not product code; they are kept here as text so that the measurement can be repeated.

- **Measured:** 2026-11-26 03:27 to 03:50 UTC (2026-11-25, 22:27 to 22:50 New York time), after the US close, the evening before a market holiday.
- **Access:** the coverage script and the two page scripts use the read-only viewer account of the deployed app, in headless Chrome. They read market data only (the options-chain API and the `/stock` page). They read the sign-in values from a local file outside the repository and never print them. The second-source script reads public option-chain data of the Nasdaq site, one request per chain.
- **Sample:** 48 chains in four coverage runs.

## How to run

Save the code blocks under the names of their headings in a folder outside the repository, and run them from a checkout that has the Playwright package installed:

```sh
node coverage-probe.mjs run-default.json
node coverage-probe.mjs run-last-expiry.json SPY,QQQ,IWM,NVDA,AAPL,TSLA,PLTR,F -1
node coverage-probe.mjs run-smaller.json ETSY,CHWY,CLF,WEN 0,3,-1
node coverage-probe.mjs run-ended.json SPY,QQQ,NVDA,AAPL 0 <the expiry that ended today, YYYY-MM-DD>
node second-source-probe.mjs second-source.json run-default.json run-last-expiry.json run-smaller.json run-ended.json
node analysis-probe.mjs second-source.json run-default.json run-last-expiry.json run-smaller.json run-ended.json
node live-tile-check.mjs <output folder> <SYMBOL> <expiry, YYYY-MM-DD>
```

The fourth coverage run needs an expiry that ended on the day of the run; leave it out on a day without one. The analysis works on the saved answers only.

## Output: coverage, default symbols (24 chains)

```text
SPY 2026-11-27 dte 1 | calls 212/213 (99.5%) | puts 190/192 (99.0%) | ratio of reported 0.6584
SPY 2026-12-02 dte 6 | calls 149/165 (90.3%) | puts 122/122 (100.0%) | ratio of reported 1.3515
SPY 2026-12-09 dte 13 | calls 0/28 (0.0%) | puts 0/25 (0.0%) | ratio of reported null
QQQ 2026-11-27 dte 1 | calls 227/240 (94.6%) | puts 220/226 (97.3%) | ratio of reported 0.9046
QQQ 2026-12-02 dte 6 | calls 130/147 (88.4%) | puts 130/139 (93.5%) | ratio of reported 0.9091
QQQ 2026-12-09 dte 13 | calls 0/27 (0.0%) | puts 0/23 (0.0%) | ratio of reported null
IWM 2026-11-27 dte 1 | calls 98/100 (98.0%) | puts 83/83 (100.0%) | ratio of reported 1.9319
IWM 2026-12-02 dte 6 | calls 40/41 (97.6%) | puts 39/41 (95.1%) | ratio of reported 2.5806
IWM 2026-12-09 dte 13 | calls 1/22 (4.5%) | puts 0/21 (0.0%) | ratio of reported null
NVDA 2026-11-27 dte 1 | calls 121/122 (99.2%) | puts 108/108 (100.0%) | ratio of reported 0.6637
NVDA 2026-12-04 dte 8 | calls 117/125 (93.6%) | puts 101/101 (100.0%) | ratio of reported 0.6563
NVDA 2026-12-24 dte 28 | calls 42/43 (97.7%) | puts 44/46 (95.7%) | ratio of reported 0.6697
AAPL 2026-11-27 dte 1 | calls 78/78 (100.0%) | puts 78/78 (100.0%) | ratio of reported 1.3849
AAPL 2026-12-04 dte 8 | calls 66/68 (97.1%) | puts 78/78 (100.0%) | ratio of reported 1.1279
AAPL 2026-12-24 dte 28 | calls 40/40 (100.0%) | puts 45/45 (100.0%) | ratio of reported 1.5677
TSLA 2026-11-27 dte 1 | calls 135/137 (98.5%) | puts 111/111 (100.0%) | ratio of reported 1.5501
TSLA 2026-12-04 dte 8 | calls 130/136 (95.6%) | puts 100/100 (100.0%) | ratio of reported 0.9695
TSLA 2026-12-24 dte 28 | calls 72/72 (100.0%) | puts 54/55 (98.2%) | ratio of reported 0.6412
PLTR 2026-11-27 dte 1 | calls 100/101 (99.0%) | puts 103/103 (100.0%) | ratio of reported 0.5615
PLTR 2026-12-18 dte 22 | calls 88/90 (97.8%) | puts 94/94 (100.0%) | ratio of reported 0.9862
PLTR 2027-02-19 dte 85 | calls 51/51 (100.0%) | puts 43/43 (100.0%) | ratio of reported 0.5882
F 2026-11-27 dte 1 | calls 28/28 (100.0%) | puts 30/30 (100.0%) | ratio of reported 0.3754
F 2026-12-18 dte 22 | calls 61/61 (100.0%) | puts 55/55 (100.0%) | ratio of reported 1.2264
F 2027-03-19 dte 113 | calls 23/23 (100.0%) | puts 20/20 (100.0%) | ratio of reported 0.7484
chains read: 24 of 24
```

## Output: coverage, last listed expiry (8 chains)

```text
SPY 2029-01-19 dte 785 | calls 189/198 (95.5%) | puts 147/147 (100.0%) | ratio of reported 1.0014
QQQ 2029-01-19 dte 785 | calls 163/163 (100.0%) | puts 129/130 (99.2%) | ratio of reported 0.83
IWM 2029-01-19 dte 785 | calls 53/54 (98.1%) | puts 47/47 (100.0%) | ratio of reported 1.0284
NVDA 2029-01-19 dte 785 | calls 78/78 (100.0%) | puts 78/78 (100.0%) | ratio of reported 0.5283
AAPL 2029-01-19 dte 785 | calls 83/83 (100.0%) | puts 74/74 (100.0%) | ratio of reported 0.6799
TSLA 2029-01-19 dte 785 | calls 89/89 (100.0%) | puts 91/91 (100.0%) | ratio of reported 1.7171
PLTR 2029-06-15 dte 932 | calls 26/33 (78.8%) | puts 8/20 (40.0%) | ratio of reported 0.2463
F 2029-01-19 dte 785 | calls 10/10 (100.0%) | puts 10/10 (100.0%) | ratio of reported 4.7878
chains read: 8 of 8
```

## Output: coverage, smaller chains (12 chains)

```text
ETSY 2026-11-27 dte 1 | calls 49/50 (98.0%) | puts 42/42 (100.0%) | ratio of reported 0.5574
ETSY 2026-12-18 dte 22 | calls 40/41 (97.6%) | puts 35/39 (89.7%) | ratio of reported 0.2118
ETSY 2029-01-19 dte 785 | calls 27/27 (100.0%) | puts 20/20 (100.0%) | ratio of reported 0.1081
CHWY 2026-11-27 dte 1 | calls 33/33 (100.0%) | puts 28/31 (90.3%) | ratio of reported 0.2171
CHWY 2026-12-18 dte 22 | calls 29/32 (90.6%) | puts 26/27 (96.3%) | ratio of reported 0.8865
CHWY 2029-01-19 dte 785 | calls 13/13 (100.0%) | puts 13/13 (100.0%) | ratio of reported 0.5907
CLF 2026-11-27 dte 1 | calls 30/30 (100.0%) | puts 36/36 (100.0%) | ratio of reported 0.9934
CLF 2026-12-18 dte 22 | calls 32/34 (94.1%) | puts 36/37 (97.3%) | ratio of reported 0.4105
CLF 2029-01-19 dte 785 | calls 14/14 (100.0%) | puts 12/12 (100.0%) | ratio of reported 0.9919
WEN 2026-11-27 dte 1 | calls 18/18 (100.0%) | puts 15/17 (88.2%) | ratio of reported 0.7845
WEN 2026-12-18 dte 22 | calls 12/12 (100.0%) | puts 9/10 (90.0%) | ratio of reported 0.1859
WEN 2029-01-19 dte 785 | calls 6/6 (100.0%) | puts 4/4 (100.0%) | ratio of reported 0.0108
chains read: 12 of 12
```

## Output: coverage, the expiry that ended that day (4 chains)

```text
SPY 2026-11-25 dte 0 | calls 0/139 (0.0%) | puts 1/121 (0.8%) | ratio of reported null
QQQ 2026-11-25 dte 0 | calls 0/165 (0.0%) | puts 0/161 (0.0%) | ratio of reported null
NVDA 2026-11-25 dte 0 | calls 1/85 (1.2%) | puts 1/76 (1.3%) | ratio of reported 1.2273
AAPL 2026-11-25 dte 0 | calls 1/40 (2.5%) | puts 0/43 (0.0%) | ratio of reported null
chains read: 4 of 4
```

## Output: second source

Columns: calls and puts with an OI value of the contracts in the returned chain; contracts with no OI value; what the second source shows for these contracts (no value / 0 / a value above 0 / strike not listed); the OI that the second source adds to the calls and to the puts; the ratio of the reported OI; the ratio with the second-source values added; the move between the two.

```text
second source: Nasdaq option-chain data; chains compared: 48 of 48
symbol expiry | calls | puts | contracts without OI value | second source: no value / 0 / above 0 / not listed | OI the second source adds calls/puts | ratio of reported | ratio with the second-source values | move
SPY 2026-11-27 | 212/213 | 190/192 | 3 | 3 / 0 / 0 / 0 | 0/0 | 0.6584 | 0.6584 | 0.00%
SPY 2026-12-02 | 149/165 | 122/122 | 16 | 16 / 0 / 0 / 0 | 0/0 | 1.3515 | 1.3515 | 0.00%
SPY 2026-12-09 | 0/28 | 0/25 | 53 | 53 / 0 / 0 / 0 | 0/0 | none | none | n/a
QQQ 2026-11-27 | 227/240 | 220/226 | 19 | 19 / 0 / 0 / 0 | 0/0 | 0.9046 | 0.9046 | 0.00%
QQQ 2026-12-02 | 130/147 | 130/139 | 26 | 26 / 0 / 0 / 0 | 0/0 | 0.9091 | 0.9091 | 0.00%
QQQ 2026-12-09 | 0/27 | 0/23 | 50 | 50 / 0 / 0 / 0 | 0/0 | none | none | n/a
IWM 2026-11-27 | 98/100 | 83/83 | 2 | 2 / 0 / 0 / 0 | 0/0 | 1.9319 | 1.9319 | 0.00%
IWM 2026-12-02 | 40/41 | 39/41 | 3 | 3 / 0 / 0 / 0 | 0/0 | 2.5806 | 2.5806 | 0.00%
IWM 2026-12-09 | 1/22 | 0/21 | 42 | 42 / 0 / 0 / 0 | 0/0 | none | none | n/a
NVDA 2026-11-27 | 121/122 | 108/108 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.6637 | 0.6637 | 0.00%
NVDA 2026-12-04 | 117/125 | 101/101 | 8 | 8 / 0 / 0 / 0 | 0/0 | 0.6563 | 0.6563 | 0.00%
NVDA 2026-12-24 | 42/43 | 44/46 | 3 | 3 / 0 / 0 / 0 | 0/0 | 0.6697 | 0.6697 | 0.00%
AAPL 2026-11-27 | 78/78 | 78/78 | 0 | 0 / 0 / 0 / 0 | 0/0 | 1.3849 | 1.3849 | 0.00%
AAPL 2026-12-04 | 66/68 | 78/78 | 2 | 2 / 0 / 0 / 0 | 0/0 | 1.1279 | 1.1279 | 0.00%
AAPL 2026-12-24 | 40/40 | 45/45 | 0 | 0 / 0 / 0 / 0 | 0/0 | 1.5677 | 1.5677 | 0.00%
TSLA 2026-11-27 | 135/137 | 111/111 | 2 | 2 / 0 / 0 / 0 | 0/0 | 1.5501 | 1.5501 | 0.00%
TSLA 2026-12-04 | 130/136 | 100/100 | 6 | 6 / 0 / 0 / 0 | 0/0 | 0.9695 | 0.9695 | 0.00%
TSLA 2026-12-24 | 72/72 | 54/55 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.6412 | 0.6412 | 0.00%
PLTR 2026-11-27 | 100/101 | 103/103 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.5615 | 0.5615 | 0.00%
PLTR 2026-12-18 | 88/90 | 94/94 | 2 | 2 / 0 / 0 / 0 | 0/0 | 0.9862 | 0.9862 | 0.00%
PLTR 2027-02-19 | 51/51 | 43/43 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.5882 | 0.5882 | 0.00%
F 2026-11-27 | 28/28 | 30/30 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.3754 | 0.3754 | 0.00%
F 2026-12-18 | 61/61 | 55/55 | 0 | 0 / 0 / 0 / 0 | 0/0 | 1.2264 | 1.2264 | 0.00%
F 2027-03-19 | 23/23 | 20/20 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.7484 | 0.7484 | 0.00%
SPY 2029-01-19 | 189/198 | 147/147 | 9 | 9 / 0 / 0 / 0 | 0/0 | 1.0014 | 1.0014 | 0.00%
QQQ 2029-01-19 | 163/163 | 129/130 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.8300 | 0.8300 | 0.00%
IWM 2029-01-19 | 53/54 | 47/47 | 1 | 1 / 0 / 0 / 0 | 0/0 | 1.0284 | 1.0284 | 0.00%
NVDA 2029-01-19 | 78/78 | 78/78 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.5283 | 0.5283 | 0.00%
AAPL 2029-01-19 | 83/83 | 74/74 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.6799 | 0.6799 | 0.00%
TSLA 2029-01-19 | 89/89 | 91/91 | 0 | 0 / 0 / 0 / 0 | 0/0 | 1.7171 | 1.7171 | 0.00%
PLTR 2029-06-15 | 26/33 | 8/20 | 19 | 19 / 0 / 0 / 0 | 0/0 | 0.2463 | 0.2463 | 0.00%
F 2029-01-19 | 10/10 | 10/10 | 0 | 0 / 0 / 0 / 0 | 0/0 | 4.7878 | 4.7878 | 0.00%
ETSY 2026-11-27 | 49/50 | 42/42 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.5574 | 0.5574 | 0.00%
ETSY 2026-12-18 | 40/41 | 35/39 | 5 | 5 / 0 / 0 / 0 | 0/0 | 0.2118 | 0.2118 | 0.00%
ETSY 2029-01-19 | 27/27 | 20/20 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.1081 | 0.1081 | 0.00%
CHWY 2026-11-27 | 33/33 | 28/31 | 3 | 3 / 0 / 0 / 0 | 0/0 | 0.2171 | 0.2171 | 0.00%
CHWY 2026-12-18 | 29/32 | 26/27 | 4 | 4 / 0 / 0 / 0 | 0/0 | 0.8865 | 0.8865 | 0.00%
CHWY 2029-01-19 | 13/13 | 13/13 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.5907 | 0.5907 | 0.00%
CLF 2026-11-27 | 30/30 | 36/36 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.9934 | 0.9934 | 0.00%
CLF 2026-12-18 | 32/34 | 36/37 | 3 | 3 / 0 / 0 / 0 | 0/0 | 0.4105 | 0.4105 | 0.00%
CLF 2029-01-19 | 14/14 | 12/12 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.9919 | 0.9919 | 0.00%
WEN 2026-11-27 | 18/18 | 15/17 | 2 | 2 / 0 / 0 / 0 | 0/0 | 0.7845 | 0.7845 | 0.00%
WEN 2026-12-18 | 12/12 | 9/10 | 1 | 1 / 0 / 0 / 0 | 0/0 | 0.1859 | 0.1859 | 0.00%
WEN 2029-01-19 | 6/6 | 4/4 | 0 | 0 / 0 / 0 / 0 | 0/0 | 0.0108 | 0.0108 | 0.00%
SPY 2026-11-25 | 0/139 | 1/121 | 259 | 20 / 0 / 239 / 0 | 227442/174375 | none | none | n/a
QQQ 2026-11-25 | 0/165 | 0/161 | 326 | 64 / 0 / 262 / 0 | 164001/161904 | none | none | n/a
NVDA 2026-11-25 | 1/85 | 1/76 | 159 | 11 / 0 / 148 / 0 | 362733/244320 | 1.2273 | 0.6754 | -44.97%
AAPL 2026-11-25 | 1/40 | 0/43 | 82 | 8 / 0 / 74 / 0 | 45654/78846 | 0.0000 | 1.4399 | n/a
contracts without an OI value in the compared chains: 1115
second source shows no value: 392; shows 0: 0; shows a value above 0: 723; does not list the strike: 0
contracts whose OI value the app took from Yahoo: 5624; the second source shows the same number (or no value for a 0): 5438
incomplete chains with a ratio of reported OI: 27; largest move of the ratio with the second-source values: 44.97%
```

## Output: analysis of the 48 chains

```text
chains: 48; coverage measured 2026-11-26T03:27:53.272Z, 2026-11-26T03:30:22.944Z, 2026-11-26T03:30:48.287Z, 2026-11-26T03:48:20.236Z; second source read 2026-11-26T03:50:08.658Z

== rules: chains with a ratio | of them incomplete | of the incomplete ones checked at the second source | largest move of the ratio with the second-source values | chains with a ratio and a Quant Data 0 value
baseline: every contract has an OI value: 15 of 48 | 0 | 0 | 0.00% | 0
floor 95% of each side: 30 of 48 | 15 | 15 | 0.00% | 6
floor 90% of each side: 37 of 48 | 22 | 22 | 0.00% | 6
floor 75% of each side: 40 of 48 | 25 | 25 | 0.00% | 6
floor 50% of each side: 40 of 48 | 25 | 25 | 0.00% | 6
floor 25% of each side: 41 of 48 | 26 | 26 | 0.00% | 6
no floor: one OI value on each side: 42 of 48 | 27 | 27 | 44.97% | 6

== bands by the coverage of the lower side: chains | lowest and highest coverage in the band | chains with a ratio of the reported OI (one OI value on each side, call total above 0)
100%: 15 | 100.0% to 100.0% | 15
95% to below 100%: 15 | 95.1% to 99.2% | 15
75% to below 95%: 10 | 88.2% to 94.6% | 10
50% to below 75%: 0 | none | 0
10% to below 50%: 1 | 40.0% to 40.0% | 1
below 10%: 7 | 0.0% to 1.2% | 1

== chains below 50% on a side: symbol expiry | days to expiry | calls | puts | ratio of the reported OI
SPY 2026-12-09 | 13 | 0/28 | 0/25 | none
QQQ 2026-12-09 | 13 | 0/27 | 0/23 | none
IWM 2026-12-09 | 13 | 1/22 | 0/21 | none
PLTR 2029-06-15 | 932 | 26/33 | 8/20 | 0.25
SPY 2026-11-25 | 0 | 0/139 | 1/121 | none
QQQ 2026-11-25 | 0 | 0/165 | 0/161 | none
NVDA 2026-11-25 | 0 | 1/85 | 1/76 | 1.23
AAPL 2026-11-25 | 0 | 1/40 | 0/43 | none

== Quant Data 0 values: symbol expiry | 0 values | lower-side coverage
SPY 2026-11-27 | 5 | 99.0%
IWM 2026-11-27 | 2 | 98.0%
IWM 2026-12-09 | 1 | 0.0%
NVDA 2026-11-27 | 3 | 99.2%
NVDA 2026-12-24 | 1 | 95.7%
TSLA 2026-11-27 | 5 | 98.5%
TSLA 2026-12-24 | 1 | 98.2%
chains with a Quant Data 0 value: 7 of 48; of them complete: 0
incomplete chains at or above 50% with no Quant Data 0 value: 19
```

## Output: lines of the detail text in the live tile

The script replaced the text of the detail element of the tile in its own browser session and measured the lines at the four target widths.

```text
text | lines at 375 px | 768 px | 1024 px | 1440 px | tile width at 375 px
counts sentence, row 1 (74 characters) | 4 | 3 | 4 | 3 | 166 px
earlier candidate with a prefix (not used) (76 characters) | 4 | 3 | 4 | 3 | 166 px
below-floor sentence, row 2 (115 characters) | 7 | 5 | 6 | 4 | 166 px
below-floor sentence with the word half (not used) (116 characters) | 7 | 5 | 6 | 4 | 166 px
```

## Output: live tile check before the change

The deployed app at the time of the measurement has the tile from before the baseline change, so the check fails as expected.

```text
AAPL 2026-12-04: row 1 expected | value shown "No put/call ratio: call open interest reported for 66 of 68 contracts; put open interest 68,310" expected "1.13" | detail shown "Open interest, this expiry" expected "OI reported for 66 of 68 calls and 78 of 78 puts in the returned chain" | FAIL
```

## Quant Data `0` values on SPY 2026-11-27

The trace of card vertex-chain-oi-quantdata-zero (2026-11-26 03:24 UTC) compared the Quant Data print OI with the Yahoo OI of the same contracts. For SPY 2026-11-27, Quant Data sent `0` for five contracts:

| Contract | Quant Data OI | Yahoo OI |
| --- | --- | --- |
| 700 put | 0 | 35,063 |
| 705 put | 0 | 9,740 |
| 710 put | 0 | 14,377 |
| 715 put | 0 | 6,874 |
| 720 call | 0 | 11,938 |

The returned chain of the default run has a call total of 465,781 and a put total of 306,680: ratio 0.66. With the Yahoo values of the five contracts: (306,680 + 66,054) / (465,781 + 11,938) = 0.78.

## coverage-probe.mjs

```js
// Coverage probe for card vertex-stock-pc-ratio-partial-oi: how many contracts of a live options
// chain have no open interest (OI) value, where those contracts are, and what puts / calls of the
// reported OI gives. Headless Chrome on the rig as the read-only agent viewer (no JEV).
// Market data only. Reads ~/.config/vertex/agent-viewer.env (0600); never prints it.
// Usage: node coverage-probe.mjs <outFile> [SYMBOL,SYMBOL...]   (run from a checkout with @playwright/test)
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

const file = `${process.env.HOME}/.config/vertex/agent-viewer.env`;
if ((statSync(file).mode & 0o077) !== 0)
  throw new Error(`${file} must be mode 0600`);
const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ])
);
const BASE = env.VERTEX_URL;
const out = process.argv[2] ?? "/tmp/pc-coverage.json";
const symbols = (process.argv[3] ?? "SPY,QQQ,IWM,NVDA,AAPL,TSLA,PLTR,F").split(
  ","
);
// Default: the nearest expiry, then the 4th and the 9th listed expiry (when the list is that long).
// A 4th argument replaces the list; a negative index counts from the end (-1 = the last expiry).
// A 5th argument is one explicit expiry date (YYYY-MM-DD) that is read for every symbol instead.
const EXPIRY_INDEXES = (process.argv[4] ?? "0,3,8").split(",").map(Number);
const EXPLICIT_EXPIRY = process.argv[5];

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  const page = await browser.newPage({ colorScheme: "dark" });
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel(/email/i).fill(env.VERTEX_AGENT_VIEWER_EMAIL);
  await page
    .getByLabel(/password/i)
    .first()
    .fill(env.VERTEX_AGENT_VIEWER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page
    .waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 20000,
    })
    .catch(() => {});

  // The same read-only call the page makes (oRPC RPC protocol: POST {json: input}).
  const readChain = (input) =>
    page.evaluate(async (json) => {
      const response = await fetch("/api/orpc/optionsChain/chain", {
        body: JSON.stringify({ json }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await response.json().catch(() => null);
      return { body, status: response.status };
    }, input);

  const side = (chain, name) => {
    const legs = chain.rows
      .filter((row) => row[name] !== null)
      .map((row) => ({ oi: row[name].openInterest, strike: row.strike }));
    const reported = legs.filter((leg) => typeof leg.oi === "number");
    const missing = legs.filter((leg) => leg.oi === null);
    return {
      contracts: legs.length,
      // Distance of each contract without OI from spot, in percent of spot (sign: strike - spot).
      missing: missing.map((leg) => ({
        fromSpotPct:
          chain.spot === null
            ? null
            : Math.round(((leg.strike - chain.spot) / chain.spot) * 1000) / 10,
        strike: leg.strike,
      })),
      reported: reported.length,
      total: reported.reduce((sum, leg) => sum + leg.oi, 0),
    };
  };

  const summarize = (symbol, chain) => {
    const calls = side(chain, "call");
    const puts = side(chain, "put");
    return {
      calls,
      // Every contract as sent: strike, OI (null = no value) and the source of the OI value.
      contracts: chain.rows.map((row) => ({
        call: row.call === null ? undefined : row.call.openInterest,
        callSource: row.call?.sources?.openInterest ?? undefined,
        put: row.put === null ? undefined : row.put.openInterest,
        putSource: row.put?.sources?.openInterest ?? undefined,
        strike: row.strike,
      })),
      dte: chain.dte,
      expiry: chain.expiry,
      puts,
      ratioOfReported:
        calls.total > 0 && calls.reported > 0 && puts.reported > 0
          ? Math.round((puts.total / calls.total) * 10000) / 10000
          : null,
      sources: (chain.sources ?? []).map((item) => `${item.source}:${item.status}`),
      spot: chain.spot,
      symbol,
    };
  };

  for (const symbol of symbols) {
    if (EXPLICIT_EXPIRY !== undefined) {
      const one = await readChain({ expiry: EXPLICIT_EXPIRY, symbol });
      results.push(
        one.status === 200
          ? summarize(symbol, one.body.json ?? one.body)
          : { error: `HTTP ${one.status}`, expiry: EXPLICIT_EXPIRY, symbol }
      );
      await page.waitForTimeout(1500);
      continue;
    }
    const first = await readChain({ symbol });
    if (first.status !== 200) {
      results.push({ error: `HTTP ${first.status}`, symbol });
      continue;
    }
    const nearest = first.body.json ?? first.body;
    if (EXPIRY_INDEXES.includes(0)) results.push(summarize(symbol, nearest));
    for (const index of EXPIRY_INDEXES.filter((item) => item !== 0)) {
      const expiry = nearest.expiries?.at(index)?.date;
      if (expiry === undefined || expiry === nearest.expiry) continue;
      await page.waitForTimeout(1500);
      const next = await readChain({ expiry, symbol });
      results.push(
        next.status === 200
          ? summarize(symbol, next.body.json ?? next.body)
          : { error: `HTTP ${next.status}`, expiry, symbol }
      );
    }
    await page.waitForTimeout(1500);
  }
} finally {
  await browser.close();
}
writeFileSync(
  out,
  JSON.stringify({ results, takenAt: new Date().toISOString() }, null, 1)
);
const share = (part) =>
  part.contracts === 0 ? "n/a" : ((part.reported / part.contracts) * 100).toFixed(1);
for (const row of results) {
  if (row.error) {
    console.log(`${row.symbol} ${row.expiry ?? ""} ${row.error}`);
    continue;
  }
  console.log(
    `${row.symbol} ${row.expiry} dte ${row.dte} | calls ${row.calls.reported}/${row.calls.contracts} (${share(row.calls)}%) | puts ${row.puts.reported}/${row.puts.contracts} (${share(row.puts)}%) | ratio of reported ${row.ratioOfReported}`
  );
}
console.log(`chains read: ${results.filter((row) => !row.error).length} of ${results.length}`);
```

## second-source-probe.mjs

```js
// Second-source check for card vertex-stock-pc-ratio-partial-oi: for every contract of the saved
// chains that has no open interest (OI) value, read the OI that the public Nasdaq option-chain
// page data shows for the same contract, and compute how far the ratio of the reported OI is from
// the ratio with those values added. Read-only, public market data, one request per chain.
// Usage: node second-source-probe.mjs <out.json> <coverage-probe.json> [more.json ...]
import { readFileSync, writeFileSync } from "node:fs";

const ETFS = new Set(["SPY", "QQQ", "IWM"]);
const out = process.argv[2];
const files = process.argv.slice(3).map((file) => JSON.parse(readFileSync(file, "utf8")));
const chains = files.flatMap((file) => file.results).filter((row) => !row.error);

const headers = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://www.nasdaq.com",
  referer: "https://www.nasdaq.com/",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};
const read = async (symbol, expiry) => {
  const url = `https://api.nasdaq.com/api/quote/${symbol}/option-chain?assetclass=${ETFS.has(symbol) ? "etf" : "stocks"}&limit=2000&fromdate=${expiry}&todate=${expiry}&excode=oprac&callput=callput&money=all&type=all`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) return { error: `HTTP ${response.status}` };
  const body = await response.json();
  const rows = (body?.data?.table?.rows ?? []).filter((row) => row.strike !== null);
  if (rows.length === 0) return { error: "no rows" };
  const number = (text) =>
    text === null || text === undefined || text === "--" ? null : Number(String(text).replaceAll(",", ""));
  return {
    byStrike: new Map(
      rows.map((row) => [
        Number(row.strike),
        { call: number(row.c_Openinterest), put: number(row.p_Openinterest) },
      ])
    ),
  };
};

const results = [];
for (const chain of chains) {
  const second = await read(chain.symbol, chain.expiry).catch((error) => ({
    error: String(error).slice(0, 80),
  }));
  await new Promise((done) => setTimeout(done, 1200));
  if (second.error) {
    results.push({ error: second.error, expiry: chain.expiry, symbol: chain.symbol });
    continue;
  }
  const side = (name) => {
    const missing = chain.contracts.filter((row) => row[name] === null);
    const values = missing.map((row) => ({
      second: second.byStrike.has(row.strike) ? second.byStrike.get(row.strike)[name] : undefined,
      strike: row.strike,
    }));
    return {
      // Contracts with no OI value in the app's chain, split by what the second source shows.
      missing: missing.length,
      secondNoValue: values.filter((item) => item.second === null).length,
      secondNotListed: values.filter((item) => item.second === undefined).length,
      secondPositive: values.filter((item) => typeof item.second === "number" && item.second > 0)
        .length,
      secondSum: values.reduce((sum, item) => sum + (item.second ?? 0), 0),
      secondZero: values.filter((item) => item.second === 0).length,
    };
  };
  const calls = side("call");
  const puts = side("put");
  // Contracts with an OI value in the app's chain: does the second source show the same number?
  const both = ["call", "put"].flatMap((name) =>
    chain.contracts
      .filter((row) => typeof row[name] === "number" && row[`${name}Source`] === "yahoo")
      .map((row) => ({ app: row[name], second: second.byStrike.get(row.strike)?.[name] }))
  );
  const ratio = chain.calls.total > 0 ? chain.puts.total / chain.calls.total : null;
  const withSecond =
    ratio === null
      ? null
      : (chain.puts.total + puts.secondSum) / (chain.calls.total + calls.secondSum);
  results.push({
    agree: both.filter((item) => item.app === item.second || (item.app === 0 && item.second === null)).length,
    calls,
    callsReported: `${chain.calls.reported}/${chain.calls.contracts}`,
    expiry: chain.expiry,
    move: ratio === null || ratio === 0 ? null : withSecond / ratio - 1,
    puts,
    putsReported: `${chain.puts.reported}/${chain.puts.contracts}`,
    ratio,
    symbol: chain.symbol,
    withBoth: both.length,
    withSecond,
  });
}
writeFileSync(out, JSON.stringify({ results, takenAt: new Date().toISOString() }, null, 1));

const ok = results.filter((row) => !row.error);
console.log(`second source: Nasdaq option-chain data; chains compared: ${ok.length} of ${results.length}`);
console.log("symbol expiry | calls | puts | contracts without OI value | second source: no value / 0 / above 0 / not listed | OI the second source adds calls/puts | ratio of reported | ratio with the second-source values | move");
let missing = 0;
let none = 0;
let zero = 0;
let positive = 0;
let notListed = 0;
for (const row of results) {
  if (row.error) {
    console.log(`${row.symbol} ${row.expiry} | ${row.error}`);
    continue;
  }
  const sum = (key) => row.calls[key] + row.puts[key];
  missing += sum("missing");
  none += sum("secondNoValue");
  zero += sum("secondZero");
  positive += sum("secondPositive");
  notListed += sum("secondNotListed");
  console.log(
    `${row.symbol} ${row.expiry} | ${row.callsReported} | ${row.putsReported} | ${sum("missing")} | ${sum("secondNoValue")} / ${sum("secondZero")} / ${sum("secondPositive")} / ${sum("secondNotListed")} | ${row.calls.secondSum}/${row.puts.secondSum} | ${row.ratio === null ? "none" : row.ratio.toFixed(4)} | ${row.withSecond === null ? "none" : row.withSecond.toFixed(4)} | ${row.move === null ? "n/a" : `${(row.move * 100).toFixed(2)}%`}`
  );
}
console.log(`contracts without an OI value in the compared chains: ${missing}`);
console.log(`second source shows no value: ${none}; shows 0: ${zero}; shows a value above 0: ${positive}; does not list the strike: ${notListed}`);
const withBoth = ok.reduce((sum, row) => sum + row.withBoth, 0);
const agree = ok.reduce((sum, row) => sum + row.agree, 0);
console.log(`contracts whose OI value the app took from Yahoo: ${withBoth}; the second source shows the same number (or no value for a 0): ${agree}`);
const incomplete = ok.filter((row) => row.calls.missing + row.puts.missing > 0 && row.move !== null);
const worst = incomplete.reduce((max, row) => Math.max(max, Math.abs(row.move)), 0);
console.log(`incomplete chains with a ratio of reported OI: ${incomplete.length}; largest move of the ratio with the second-source values: ${(worst * 100).toFixed(2)}%`);
```

## analysis-probe.mjs

```js
// Analysis for card vertex-stock-pc-ratio-partial-oi over the saved answers (no network):
// which chains show a put/call ratio under each candidate coverage floor, how the chains spread
// by coverage, where Quant Data sent 0, and what the second source says about the contracts
// with no open interest (OI) value.
// Usage: node analysis-probe.mjs <second-source.json> <coverage-probe.json> [more.json ...]
import { readFileSync } from "node:fs";

const second = JSON.parse(readFileSync(process.argv[2], "utf8"));
const files = process.argv.slice(3).map((file) => JSON.parse(readFileSync(file, "utf8")));
const chains = files.flatMap((file) => file.results).filter((row) => !row.error);
const secondOf = (chain) =>
  second.results.find(
    (row) => row.symbol === chain.symbol && row.expiry === chain.expiry && !row.error
  );

const quantDataZero = (chain) =>
  chain.contracts.reduce(
    (count, row) =>
      count +
      (row.callSource === "quantdata" && row.call === 0 ? 1 : 0) +
      (row.putSource === "quantdata" && row.put === 0 ? 1 : 0),
    0
  );
const complete = (side) => side.contracts > 0 && side.reported === side.contracts;
const covered = (percent) => (side) =>
  side.contracts > 0 && side.reported > 0 && side.reported * 100 >= side.contracts * percent;
const lower = (chain) =>
  Math.min(
    chain.calls.reported / chain.calls.contracts,
    chain.puts.reported / chain.puts.contracts
  ) * 100;
const ratio = (chain) => (chain.calls.total > 0 ? chain.puts.total / chain.calls.total : null);
const name = (chain) => `${chain.symbol} ${chain.expiry}`;

console.log(`chains: ${chains.length}; coverage measured ${files.map((file) => file.takenAt).join(", ")}; second source read ${second.takenAt}`);

console.log("\n== rules: chains with a ratio | of them incomplete | of the incomplete ones checked at the second source | largest move of the ratio with the second-source values | chains with a ratio and a Quant Data 0 value");
const rules = [
  ["baseline: every contract has an OI value", (c, p) => complete(c) && complete(p)],
  ["floor 95% of each side", (c, p) => covered(95)(c) && covered(95)(p)],
  ["floor 90% of each side", (c, p) => covered(90)(c) && covered(90)(p)],
  ["floor 75% of each side", (c, p) => covered(75)(c) && covered(75)(p)],
  ["floor 50% of each side", (c, p) => covered(50)(c) && covered(50)(p)],
  ["floor 25% of each side", (c, p) => covered(25)(c) && covered(25)(p)],
  ["no floor: one OI value on each side", (c, p) => covered(0)(c) && covered(0)(p)],
];
for (const [label, rule] of rules) {
  const shown = chains.filter((chain) => rule(chain.calls, chain.puts) && ratio(chain) !== null);
  const partial = shown.filter((chain) => !(complete(chain.calls) && complete(chain.puts)));
  const checked = partial.map(secondOf).filter((row) => row !== undefined);
  const worst = checked.reduce((max, row) => Math.max(max, Math.abs(row.move ?? 0)), 0);
  const zero = shown.filter((chain) => quantDataZero(chain) > 0).length;
  console.log(`${label}: ${shown.length} of ${chains.length} | ${partial.length} | ${checked.length} | ${(worst * 100).toFixed(2)}% | ${zero}`);
}

console.log("\n== bands by the coverage of the lower side: chains | lowest and highest coverage in the band | chains with a ratio of the reported OI (one OI value on each side, call total above 0)");
const bands = [
  ["100%", (value) => value === 100],
  ["95% to below 100%", (value) => value >= 95 && value < 100],
  ["75% to below 95%", (value) => value >= 75 && value < 95],
  ["50% to below 75%", (value) => value >= 50 && value < 75],
  ["10% to below 50%", (value) => value >= 10 && value < 50],
  ["below 10%", (value) => value < 10],
];
for (const [label, test] of bands) {
  const inBand = chains.filter((chain) => test(lower(chain)));
  const values = inBand.map(lower);
  const withRatio = inBand.filter(
    (chain) => chain.calls.reported > 0 && chain.puts.reported > 0 && ratio(chain) !== null
  );
  console.log(`${label}: ${inBand.length} | ${inBand.length === 0 ? "none" : `${Math.min(...values).toFixed(1)}% to ${Math.max(...values).toFixed(1)}%`} | ${withRatio.length}`);
}

console.log("\n== chains below 50% on a side: symbol expiry | days to expiry | calls | puts | ratio of the reported OI");
for (const chain of chains.filter((item) => lower(item) < 50)) {
  const value =
    chain.calls.reported > 0 && chain.puts.reported > 0 && ratio(chain) !== null
      ? ratio(chain).toFixed(2)
      : "none";
  console.log(`${name(chain)} | ${chain.dte} | ${chain.calls.reported}/${chain.calls.contracts} | ${chain.puts.reported}/${chain.puts.contracts} | ${value}`);
}

console.log("\n== Quant Data 0 values: symbol expiry | 0 values | lower-side coverage");
const withZero = chains.filter((chain) => quantDataZero(chain) > 0);
for (const chain of withZero)
  console.log(`${name(chain)} | ${quantDataZero(chain)} | ${lower(chain).toFixed(1)}%`);
console.log(`chains with a Quant Data 0 value: ${withZero.length} of ${chains.length}; of them complete: ${withZero.filter((chain) => complete(chain.calls) && complete(chain.puts)).length}`);
const clean = chains.filter(
  (chain) =>
    covered(50)(chain.calls) &&
    covered(50)(chain.puts) &&
    !(complete(chain.calls) && complete(chain.puts)) &&
    ratio(chain) !== null &&
    quantDataZero(chain) === 0
);
console.log(`incomplete chains at or above 50% with no Quant Data 0 value: ${clean.length}`);
```

## live-tile-check.mjs

```js
// Live tile check for card vertex-stock-pc-ratio-partial-oi (acceptance check 7): does the
// Put/call OI tile of the deployed app show the value and the detail that the planned rule gives
// for the chain response of the same page load? Headless Chrome on the rig as the read-only agent
// viewer, dark mode. Market data only. Reads ~/.config/vertex/agent-viewer.env (0600); never
// prints it.
// Usage: node live-tile-check.mjs <outDir> <SYMBOL> [YYYY-MM-DD]   (from a checkout with @playwright/test)
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");

const MIN_OI_COVERAGE_PERCENT = 50;
const file = `${process.env.HOME}/.config/vertex/agent-viewer.env`;
if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be mode 0600`);
const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const [out, symbol, expiry] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

// The planned rule, written again here on purpose: the check must not import the code it checks.
const expected = (chain) => {
  const side = (name) => {
    const legs = chain.rows.filter((row) => row[name] !== null).map((row) => row[name].openInterest);
    const reported = legs.filter((value) => typeof value === "number");
    return {
      contracts: legs.length,
      reported: reported.length,
      total: reported.reduce((sum, value) => sum + value, 0),
    };
  };
  const calls = side("call");
  const puts = side("put");
  const covered = (item) =>
    item.contracts > 0 && item.reported * 100 >= item.contracts * MIN_OI_COVERAGE_PERCENT;
  const count = (item, name) => `${item.reported} of ${item.contracts} ${name}`;
  // The row numbers are the rows of the "Proposed display" table of the plan.
  const row = (number, value, detail) => ({ calls, detail, puts, row: number, value });
  if (calls.contracts === 0 && puts.contracts === 0)
    return row(5, "No ratio", "No contracts in the returned chain");
  if (calls.contracts === 0)
    return row(6, "No ratio", `No call contracts; OI reported for ${count(puts, "puts")} in the returned chain`);
  if (puts.contracts === 0)
    return row(7, "No ratio", `No put contracts; OI reported for ${count(calls, "calls")} in the returned chain`);
  const counts = `OI reported for ${count(calls, "calls")} and ${count(puts, "puts")} in the returned chain`;
  if (!(covered(calls) && covered(puts)))
    return row(2, "No ratio", `${counts}; a ratio needs at least ${MIN_OI_COVERAGE_PERCENT}% of each side`);
  if (calls.total === 0)
    return puts.total === 0
      ? row(3, "No ratio", "Reported call and put OI totals are 0")
      : row(4, "No ratio", "Reported call OI total is 0; a ratio needs call OI above 0");
  return row(1, (puts.total / calls.total).toFixed(2), counts);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const result = { expiry: expiry ?? "nearest", symbol, takenAt: new Date().toISOString() };
try {
  const page = await browser.newPage({ colorScheme: "dark", viewport: { height: 1100, width: 1440 } });
  await page.goto(`${env.VERTEX_URL}/sign-in`);
  await page.getByLabel(/email/i).fill(env.VERTEX_AGENT_VIEWER_EMAIL);
  await page.getByLabel(/password/i).first().fill(env.VERTEX_AGENT_VIEWER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20000 }).catch(() => {});

  // The last 200 answer of the chain call: the page asks again when the expiry in the URL differs.
  let body = null;
  page.on("response", async (response) => {
    if (response.url().includes("/api/orpc/optionsChain/chain") && response.status() === 200)
      body = await response.json().catch(() => body);
  });
  const query = expiry === undefined ? "tab=options" : `expiry=${expiry}&tab=options`;
  await page.goto(`${env.VERTEX_URL}/stock/${symbol}?${query}`);
  await page.waitForSelector("[data-options-chain]", { timeout: 90000 });
  await page.waitForTimeout(1500);
  const chain = body?.json ?? body;
  const card = page.locator("[data-stock-kpis] dl").filter({
    has: page.getByText("Put/call OI", { exact: true }),
  });
  const want = expected(chain);
  const shown = {
    detail: (await card.locator("dd").nth(1).textContent())?.trim(),
    value: (await card.locator("dd").first().textContent())?.trim(),
  };
  Object.assign(result, {
    chainExpiry: chain.expiry,
    pass: shown.value === want.value && shown.detail === want.detail,
    shown,
    want,
  });
  for (const width of [1440, 375]) {
    await page.setViewportSize({ height: width === 375 ? 812 : 1100, width });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ fullPage: true, path: `${out}/${symbol}-${chain.expiry}-${width}.png` });
  }
} finally {
  await browser.close();
}
writeFileSync(`${out}/${symbol}-${result.chainExpiry}-tile-check.json`, JSON.stringify(result, null, 1));
console.log(`${symbol} ${result.chainExpiry}: row ${result.want.row} expected | value shown "${result.shown.value}" expected "${result.want.value}" | detail shown "${result.shown.detail}" expected "${result.want.detail}" | ${result.pass ? "PASS" : "FAIL"}`);
process.exit(result.pass ? 0 : 1);
```

## wrap-measure.mjs

```js
// Wrap measurement for card vertex-stock-pc-ratio-partial-oi: how many lines the candidate detail
// texts take in the Put/call OI tile at the target widths. Headless Chrome on the rig as the
// read-only agent viewer; the text of the tile's detail element is replaced in this browser
// session only (nothing is sent to the app). Usage: node wrap-measure.mjs  (from a checkout with
// @playwright/test)
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require("@playwright/test");
const file = `${process.env.HOME}/.config/vertex/agent-viewer.env`;
if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be mode 0600`);
const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const TEXTS = {
  "counts sentence, row 1":
    "OI reported for 227 of 240 calls and 220 of 226 puts in the returned chain",
  "earlier candidate with a prefix (not used)": "Reported OI only: 227 of 240 calls and 220 of 226 puts in the returned chain",
  "below-floor sentence, row 2":
    "OI reported for 227 of 240 calls and 220 of 226 puts in the returned chain; a ratio needs at least 50% of each side",
  "below-floor sentence with the word half (not used)":
    "OI reported for 227 of 240 calls and 220 of 226 puts in the returned chain; a ratio needs at least half of each side",
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ colorScheme: "dark", viewport: { height: 1100, width: 1440 } });
  await page.goto(`${env.VERTEX_URL}/sign-in`);
  await page.getByLabel(/email/i).fill(env.VERTEX_AGENT_VIEWER_EMAIL);
  await page.getByLabel(/password/i).first().fill(env.VERTEX_AGENT_VIEWER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20000 }).catch(() => {});
  await page.goto(`${env.VERTEX_URL}/stock/AAPL?tab=options`);
  const card = page.locator("[data-stock-kpis] dl").filter({ has: page.getByText("Put/call OI", { exact: true }) });
  await card.waitFor({ timeout: 60000 });
  await page.waitForSelector("[data-options-chain]", { timeout: 60000 });
  // Put a short value into the value slot, as the baseline tile has.
  await card.locator("dd").first().evaluate((element) => {
    element.textContent = "No ratio";
  });
  const detail = card.locator("dd").nth(1);
  console.log("text | lines at 375 px | 768 px | 1024 px | 1440 px | tile width at 375 px");
  for (const [name, text] of Object.entries(TEXTS)) {
    const lines = [];
    let tile = 0;
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ height: 1100, width });
      const measured = await detail.evaluate((element, value) => {
        element.textContent = value;
        const rect = element.getBoundingClientRect();
        const box = element.closest("dl").getBoundingClientRect();
        return {
          inside: rect.left >= box.left && rect.right <= box.right,
          lines: rect.height / Number.parseFloat(getComputedStyle(element).lineHeight),
          tile: box.width,
        };
      }, text);
      lines.push(`${Math.round(measured.lines)}${measured.inside ? "" : " (outside the tile)"}`);
      if (width === 375) tile = Math.round(measured.tile);
    }
    console.log(`${name} (${text.length} characters) | ${lines.join(" | ")} | ${tile} px`);
  }
} finally {
  await browser.close();
}
```
