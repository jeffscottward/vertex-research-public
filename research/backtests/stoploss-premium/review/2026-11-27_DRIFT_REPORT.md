# Drift report, 2026-11-27 (egm-drift-report, fresh egm-codebase-details agent)

Resolution after the report: code fixed for the F delta band (now enforced), the F missing-quote close (now holds at the last mid), p0 of the G books (now the value sold by stops over the book value) and the run guard (now also watches `strategies/qc_ports` and `indicators`). Every other item was documented in `design.md` (row count 37, E counting, start dates after the 260-session warm-up, 45-day expiry window, D LEAPS time exit, IV floor and dropped trades, roll details, G/H sizing and rebalancing, stop step per test, rf, bar cleaning, rotation details, output).

## design.md

### Blockers (the document states behaviour the code does not have)

- **Test F delta band is never checked.** design.md:187 says the strike is the one whose model |delta| is nearest 0.25 *inside 0.15–0.30*. In csp.py:27, `DELTA_BAND = (0.15, 0.30)` is defined but never used. `open_put` (csp.py:63–76) takes the grid strike nearest −0.25 from `strike_for_delta` and only checks credit ≥ $0.10. A strike outside 0.15–0.30, for example on the coarse grid of a low-priced name, is still opened.
- **p₀ is a count, not a capital share, in the G books.** design.md:47 defines p₀ as "the average share of the account that the rule holds in T-bills". In books.py:228, `res.out` is `len(stopped) / wanted_n`: the number of stopped names over the number of wanted names, with no weighting. study.py `_book_legs` uses this as `Legs.out`. So the reported p₀ and `impliedStoppedReturn` (E[r | stopped] = rf − Δμ/p₀) for both G book rows do not follow the documented definition.
- **The row count is wrong.** design.md:105 says "About 60 result rows come from one run", and the page repeats it in report.py:41. study.py produces 37 variants:
  - A: 4
  - B: 9
  - C: 10
  - D: 6
  - F: 2
  - G: 3
  - H: 2
  - E: 1

  The multiple-testing argument built on "about 60" does not match the code.
- **Test E uses a different event count and a fixed result.** design.md:74 and :80 say test E is a data count and gives "not enough data" because there are 8 closed trades.
  - Its "stop events" are not closed trades. They are the desk notes that match the regex `close[sd]? (?:below|under)` (run.py:59).
  - The result is hard-coded to `premium.NOT_ENOUGH` whatever the counts are (study.py:501).
  - When the Crown directory is missing, `crown_counts` silently returns zeros.

  None of this is in the document.

### Major (code logic the document does not describe)

- **The dirty-code guard does not cover imported code.** run.py:31 checks only the two `WATCHED` directories. The study also imports `strategies.qc_ports` (option model, calendar, data loaders, metrics) and `indicators.core` (ATR, SMA, z-score, realized volatility), and neither is checked. design.md:233 and :288 say run.py "refuses uncommitted study code" but never say which paths count. An uncommitted change in the shared option model would go undetected.
- **Test A ladder rules are left out** (design.md:176–186):
  - Rung 3 is also capped at r1 × (1 − 2%) (shares.py:59).
  - Rung 2 becomes the midpoint of r1 and r3 when the 20-day low is not at least 1% from both (shares.py:64).
  - Rung 1 also requires today's low to be at least 1% below the close (shares.py:56).
  - The month gets no ladder at all when the levels collapse, when `spaced_five` fails, or when ATR14 is not yet available (shares.py:173, `ladder` returns None). On those months the name is simply held.
  - A reclaim re-buy needs enough cash (shares.py:195) and never happens on the day of the sale.
- **The 260-row warm-up shifts start dates.** The design gives fixed starts: A "held from 2000-01-03", F "from 2011-01-03", B entries "2005-01-03", the 10-month rule. Every one of these also requires the name's own index to be at least `WARMUP` = 260 (study.py:165, 210 and the F/G loops). Names with less history start later. The design mentions 260 only as a loading filter (design.md:126).
- **The 45-day structures are not exactly 45 days.** design.md:72–73 says "45-day call" and "45-day debit spread". The code uses the monthly expiry nearest 45 days inside a 30–60-day window (study.py:254, 262). A spread is dropped when k2 ≤ k1.
- **The test D "no stop" leg for LEAPS is not held to expiry.** design.md:73 says the comparison is "No stop". The LEAPS set is built with `last_chance=LAST_CHANCE_DAYS` (study.py:250, 299), so for D on LEAPS both legs end with the time exit at T−2.
- **Undocumented IV floor and trade exclusions in the option model** (design.md:138–148):
  - ATM IV is floored at `MIN_IV = 0.08` (options.py:39, 123, 125).
  - A trade is silently dropped when its expiry is after the data end (options.py:203), when any session from entry to exit has no IV (options.py:211), or when the entry mid is ≤ 0.
- **Undocumented roll behaviour in test F** (design.md:189–191):
  - The strike search stops at 50% of the current strike (csp.py:91).
  - A roll attempt is counted as a stop event even when no credit roll exists and the put is held to assignment (csp.py:136).
  - After 3 rolls the loss check closes the put at the ask, which the design does not say.
  - In the roll variant, the leg without the rule earns rf while the rolled leg is still open (`pair`). The design only describes the rule leg earning rf.
- **A missing quote closes the put at zero cost.** In csp.py:119, a missing put quote sets mid = 0 and ask = 0. That passes the take-profit check, so the put is closed for nothing. The design does not mention this.
- **Undocumented sizing and rebalancing in the G/H books** (design.md:193–200):
  - Position size always uses 2 × ATR (`SIZE_ATR`, books.py:191), including the 1.5 × and 2.5 × ATR threshold runs, where only the stop moves.
  - Held names are resized to their new target at every month-end decision.
  - A trade smaller than 1% of equity is skipped (books.py:209).
  - Purchases are limited to the cash on hand (books.py:212).
  - Closes and ATRs are carried forward over a name's missing calendar days (books.py:54).
- **The stop step is fixed for some rows.** design.md:102–103 defines the step as the median number of days from entry to the first stop event ("21 days for monthly rules"). The code uses a fixed 21 for the A ladder (study.py:182), the window stop (:187), the 10-month rule (:465) and H (:487). G and the option and put books use the median.

### Nits

- **Index files.** design.md:123–124 lists 8 index files. `INDEX_FILES` (study.py:22) also has VIX3M, VIX6M and TNX; they are excluded from the names and loaded, but never used.
- **rf details.** design.md:49 does not say how rf is computed. bars.py:72 uses IRX / 100 / 252 (simple), carries it forward without limit (the 5-session limit applies only to IV indexes), and uses 0 before the first IRX value.
- **Bar cleaning.** Total-return bars also widen high and low to include the open and close, and rows with a non-positive value are skipped (bars.py:44–53). Not documented.
- **Rotation details.** The 3- and 6-month returns are 63 and 126 sessions; SPY is excluded as the benchmark; ties in the top 8 break alphabetically (books.py:103, 110). Not documented.
- **H stop days.** For H, `stop_days` is set equal to the number of brake starts (study.py:484), not counted as distinct days.
- **Types section.** Each variant also carries a `headline` key (study.py:134), which design.md:271–275 does not list. The E variant lacks `perTrade` and `exposure`.
- **Output.** `results.json` `inputs` also hashes `intro.html` (run.py:196). `index.html` ends with a fixed "Method" section (report.METHOD_HTML) that the output description does not mention. An unknown `--tests` ID is silently ignored.

The 63 tests in `services/research/tests/test_stoploss_premium.py` pass.
