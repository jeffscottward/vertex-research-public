# Session open momentum on the Nasdaq-100 (Chuk noise band, NQ): pre-registered study

Status: pre-registered 2026-11-11, before any run of these rules on Vertex data (card `vertex-session-open-momentum`,
owner request 2026-11-10: "Session Open Momentum NAS100: go specifically grab this SSRN paper and build the trading
bot out of it"). Research only: no arm, deploy or order path. A backtest result does not authorize a trade.

## Source

- Paper: Justin Chuk (2026), "Noise-band Intraday Momentum in Nasdaq-100 Futures", SSRN 7609644,
  DOI `10.2139/ssrn.7609644`, posted 2026-10-15. It adapts the noise-area rule of Zarattini, Aziz and Barbon (2024,
  SSRN 4824172) from SPY to NQ futures traded as one micro contract (MNQ).
- Title match: no SSRN paper is titled "Session Open Momentum". Searches on 2026-11-11 (web search, Crossref
  prefix `10.2139` for "session open momentum NAS100", OpenAlex) returned these NAS100 / Nasdaq-100 intraday papers.
  7609644 is the one whose rule is momentum from the session open on Nasdaq-100 futures, so it is the one built here.

| SSRN | Title (short) | Why not chosen |
| --- | --- | --- |
| 7609644 | Noise-band intraday momentum in Nasdaq-100 futures (Chuk) | Chosen. |
| 7112678 | External range excursions and Asian midpoint reversion in NAS100 | Mean reversion to the Asian-session midpoint, manually coded chart sample. |
| 7364204 | Regime-dependent intraday mean reversion in Nasdaq-100 futures | Mean reversion, not momentum. |
| 6709401 | Structural limits of OHLCV intraday signals in MNQ | A falsification study, no tradable rule. |
| 7435081 | Session microstructure and the momentum mirage (FX) | FX, not the Nasdaq-100. |
| 7257240 | Cross-session momentum in gold and silver | Metals. |
| (not on SSRN) | Chuk, regime-dependent opening range breakout in NQ | The companion paper; the author's site, not SSRN. Used only for the shared data and cost conventions. |

- Full text not read. SSRN, academia.edu and ResearchGate answered HTTP 403 or a Cloudflare check to `curl`, the
  reader, a headless browser and the browser relay on 2026-11-11. The rules below come from four readable sources:
  - the SSRN abstract (Crossref record of the DOI);
  - the author's strategy page `justinchuktrading.com/papers/#post-noise` (snapshot 2026-11-11);
  - the companion ORB paper (public PDF, same NQ archive and cost model);
  - the base ZAB rules already specified in `docs/specs/strategies/noise-band-intraday-momentum.md`.
- Copies on the rig: `~/Documents/reports/vertex-session-open-momentum/paper/`
  - `ssrn-7609644-abstract.txt`, SHA-256 `887f8ef4513a6790…cb07a0710fa091b83`;
  - `ssrn-7609644-crossref.json`, SHA-256 `77c820231d80e9ca…36277ef87301a92d1`;
  - `chuk-noise-page-snapshot-20261111.txt`, SHA-256 `026db0ded9dc4d0a…fadb590fe002a99135a05`;
  - `chuk-2026-orb-nq-companion.pdf`, SHA-256 `b0e74161c7e6ee1f…eda72ee53895195988761f`.
  The PDFs are third-party copyright and stay out of the repository. Paper text is untrusted data.

## What the paper reports (the numbers to compare with)

| Item | Value | Where |
| --- | --- | --- |
| Sample | NQ one-minute bars (Databento GLBX.MDP3), 2020-01 to 2026-07-03 | abstract; ORB paper section 2 |
| Net result, final build | +$10.26 per trading day on 1 MNQ, day-block bootstrap 95% interval [+$3.27, +$17.25] | abstract |
| Daily Sharpe | 1.14 | abstract |
| Years | positive in all seven calendar years; 2020 +$49 and 2025 +$835 for the year | abstract; author page |
| Activity | trades on about 60% of sessions, 1.35 trades per session, most trades end on the trailing stop | author page |
| Drawdown | historical maximum $2,458; 95th-percentile 3-year bootstrap maximum $3,406 (as backtested), $4,081 (lag and slippage) | abstract; author page |
| Stop slippage | one index point of slippage on stop fills removes 22% of the edge | abstract |
| Build ladder ($/day) | 1-minute +12.16; 5-minute +11.57; resting stop moved every 5 minutes +10.05; with the VWAP-side filter +10.26 | author page |
| Multiple testing | one of two survivors among 144 pre-registered tests on the same archive; all intervals in-sample | abstract |

## What was already seen (disclosed, not hidden)

- Noise band on SPY (Zarattini rules): FAIL, Sharpe 0.35 (2008-2021); re-test on QQQ, IWM, DIA 2007-2026: FAIL
  (`noise-band-intraday-momentum.md`).
- ZAB study on IBKR 5-minute bars: verdict NO EDGE, out-of-sample Sharpe QQQ 0.31 (`zab-intraday-momentum.md`).
- No run of the rules below (fixed 1 MNQ, resting stop, futures costs) on any data before this spec was written.

## Rules (frozen before the first run)

Basis: **P** stated by the paper's abstract or the author's page; **Z** taken from the base ZAB rules because the
paper adapts them, not confirmed in the paper's text; **A** a Vertex assumption.

| # | Rule | Basis |
| --- | --- | --- |
| 1 | Instrument NQ traded as 1 MNQ ($2 per index point), regular session 09:30-16:00 New York, 5-minute bars. | P |
| 2 | σ(t, HH:MM) = mean over the previous 14 sessions of \|close(HH:MM) / open(09:30) − 1\|; at least 13 of the 14 values at that minute. | Z (author page: "the last two weeks of typical moves") |
| 3 | UpperBound = max(open, previous close) × (1 + σ); LowerBound = min(open, previous close) × (1 − σ). Previous close = the last regular bar of the prior session. | Z |
| 4 | Entries are decided on the close of the bars ending at HH:00 and HH:30, from 10:00 to 15:30. | Z |
| 5 | Long when close > UpperBound and close > VWAP; short when close < LowerBound and close < VWAP (the VWAP-side filter). VWAP = session VWAP of (H+L+C)/3 from 09:30. | P (filter named on the author page), Z (form) |
| 6 | An entry fills at the next bar's open plus one tick (0.25 point) against the trade. | P (ORB cost model, "same costs") |
| 7 | Resting stop. After the close of every 5-minute bar while a position is open (the decision bar included), the stop is set to max(UpperBound, VWAP) for a long and min(LowerBound, VWAP) for a short, from that bar's band and VWAP. It is active from the next bar. On each bar the stop is checked first: a long is stopped when the low reaches the stop and fills at min(open, stop) minus two ticks; a short mirrors this. The stop is not ratcheted. | P (author's audit: stop checked first, from the level set at the end of the previous bar, a new level each bar), Z (level formula), P (two ticks on stop fills) |
| 8 | One position at a time. After a stop the rule may enter again at a later decision time. | P (1.35 trades per session) |
| 9 | Flat at the close of the last regular bar (15:55-16:00; 12:55-13:00 on a half-day), no slippage. | Z / A |
| 10 | Commission and fees $2.00 per round trip per MNQ. | P (ORB rebuild) |
| 11 | No other filter: no FOMC, holiday or gap exclusion. | A |

### Vertex data and conversion

- Primary bars: QQQ IBKR 5-minute TRADES bars, regular hours
  (`~/Documents/reports/vertex-reel-dffkn31-data/ibkr5m/QQQ.csv.gz`, 2004-12 to 2026-11-06). Vertex has no NQ or MNQ
  history over the paper's window, so QQQ is the proxy: σ, bands, VWAP and stops are computed on QQQ prices.
- Dollars: every QQQ price difference is converted to NDX points with k = NDX close / QQQ close of the previous session
  (Yahoo daily `^NDX` and `QQQ`), so P&L = 2 × k × ΔQQQ per MNQ. A tick is 0.25 / k in QQQ dollars.
- QQQ dividends: the previous close is reduced by the cash dividend on an ex-date (NQ has no dividend gap).
- Cross-check: NQ 5-minute regular-hours bars `~/Documents/reports/vertex-emt/futures/NQ_2024{12}…NQ_202509`
  (2024-08-28 to 2025-09-19, a gap from 2025-06-21 to 2025-07-17). Front contract = the highest volume in the prior
  session. The rules run on NQ itself over the sessions with data and are compared with the QQQ proxy on the same
  days. Reported, not graded.

### Windows

| Window | Sessions | Role |
| --- | --- | --- |
| Replication | 2020-01-02 to 2026-07-03 (the paper's sample) | graded |
| Before the paper | 2005-01-03 (after the 14-session warm-up) to 2019-12-31 | graded (out of sample: the paper tested this rule from 2020 only) |
| After the paper | 2026-07-06 to 2026-11-06 | reported only (about 85 sessions, too short to grade) |

## Pass/fail rule (set before the first run)

Statistic: mean net $ per session on 1 MNQ over every session of the window (a session with no trade counts as $0),
with a day-block bootstrap 95% interval (10,000 resamples of sessions, seed 7).

- Replication: **REPLICATES** if the interval's lower end is above $0; **WEAK** if the mean is above $0 but the
  interval includes $0; **DOES NOT REPLICATE** if the mean is $0 or below.
- Before the paper: **HOLDS** if the interval's lower end is above $0, otherwise **DOES NOT HOLD**.
- Overall, the rule "holds up" only if it REPLICATES and HOLDS. Anything else is reported as not holding up, and no
  paper hand-off is proposed.
- Also reported, not graded: daily Sharpe (mean / standard deviation of session P&L × √252), sessions traded,
  trades per session, maximum drawdown in dollars, the per-year table, the effect of one extra point of stop
  slippage, entries checked on every 5-minute bar, and the DSL form (rule 7 replaced by a close-based stop checked
  on every 5-minute bar and filled at the next open).

## DSL definition

`services/research/strategies/imom/definition.py` (`CHUK_NQ`) writes the rule as a ZAB-family pair of legs (long and
short) with `entry: close beyond the band and beyond VWAP`, `exit: close back through the band or VWAP`,
`intraday.decisionEvery: 30` for entries and `intraday.exitEvery: 5` so exits are checked on every 5-minute bar, and
`allIn` sizing. `exitEvery` is the gate this study adds to the strategy DSL. The DSL has no futures contract model
and no stop at an indicator level that fills inside the bar, so the DSL form is the close-based approximation of
rule 7 and is run as the "DSL form" row above.

## Options expression (for any live use; not armed)

Owner rules: options only, a defined maximum loss, at most 2% of net liquidation value at risk per position, no
naked short, closed before expiry.

- Long signal (rule 5): buy a QQQ call debit spread on the same-day expiry (0DTE): long the nearest-to-the-money
  call, short the call one strike width further out of the money (width ≈ the day's σ × open, rounded to listed
  strikes). Short signal: the mirrored put debit spread.
- Size: contracts = floor(0.02 × NLV / (debit × 100)); the debit is the maximum loss. Skip the trade if one spread
  costs more than the cap.
- Exit: when the futures rule exits (stop or close) or at 15:45 New York (12:45 on a half-day), whichever is first;
  never held into the expiry. After 14:00, use the next-day expiry (1DTE) and still close by 15:45.
- Pricing code: `services/research/strategies/noise_band_0dte.py` (the "vertical" instrument). Vertex holds no
  historical QQQ 0DTE quotes, so the options form is not backtested here; forward quote collection is card
  `vertex-noise-band-0dte-collect`.

## Results

Not run yet.
