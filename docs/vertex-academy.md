# Vertex Academy (Define Your Risk lessons)

The Academy turns every Define Your Risk (DYR) Instagram transcript into a lesson page: a chart
video with color-coded captions, an interactive example, data tables, the transcript and, for
tradeable strategies, a modeled backtest and a gated paper deployment request.

## Placement

- Portal route `/academy` (gallery with thumbnails and filters) and `/academy/<slug>` (lesson).
- Navigation: **Strategies & Backtests → Academy**, directly after **Strategy library**. The
  library header has an "Academy lessons" link, and each library strategy with a `dyr-` slug has an
  "Academy lesson" link back to its lesson.
- Operator-only, like the strategy library: the pages show private transcripts. The backtest and
  deploy procedures are operator-only on the server too.
- The Academy is dark by default. The light/dark toggle on the Academy pages is stored in the
  browser (`localStorage["vertex-academy-theme"]`) and does not change the portal theme.

## Parts

| Part | Location |
| --- | --- |
| Lesson specs (one JSON per transcript) | `packages/academy/src/lessons/specs/<slug>.json` |
| Transcripts with estimated timestamps | `packages/academy/src/lessons/sources.json` (`scripts/academy/build-sources.ts`) |
| Classification pass 1 (judge model) | `packages/academy/src/lessons/classification.json` |
| Spec contract | `packages/academy/src/schema.ts` |
| Scenes, tables, formulas, timeline/VTT | `packages/academy/src/{scenes,tables,formulas,timeline}.ts` |
| Shared chart (web and video) | `packages/academy/src/chart/lesson-chart.tsx` |
| Modeled backtest | `packages/academy/src/backtest.ts`, `structures.ts` |
| Deploy gates | `packages/academy/src/gates.ts` |
| API | `packages/api/src/contracts/academy.ts`, `packages/api/src/server/academy.ts` |
| Pages | `apps/web/src/app/(portal)/academy/`, `apps/web/src/components/portal/academy/` |
| Video renderer | `apps/academy-video` (Remotion) |

## Media

`apps/academy-video` renders `lesson.mp4` (1280x720, 30 fps, H.264), `captions.vtt` and
`thumb.jpg` for each lesson into `apps/web/public/academy-media/<slug>/` and records path, size,
SHA-256 and the spec hash in `packages/academy/src/lessons/media-manifest.json`. The media files
are not committed (about 1 MB per lesson). Set `VERTEX_ACADEMY_MEDIA_BASE_URL` to an absolute
HTTPS base URL when the web app must load media from an external host, such as the rig's tailnet
reports route. The app appends each manifest path; leave the setting empty for same-origin paths.
An invalid value (not HTTPS, credentials, query or fragment) is ignored and the same-origin paths
are used. The player loads the video with `crossOrigin="anonymous"`, so an external host must send
CORS headers (`Access-Control-Allow-Origin` for the app origin, and Range support) on the MP4 and
thumbnail as well as on `captions.vtt`. A build that ships neither the files nor a base URL shows
broken videos; where media is hosted is an open owner decision.

```sh
cd apps/academy-video && bun src/render.ts --all            # only changed specs
cd apps/academy-video && bun src/render.ts <slug> --force    # one lesson
```

Captions: each cue is `<c.dyr-COLOR.el-ELEMENT>text</c>`. The page shows the active cue below the
video in the same color as the element that the video draws in that step.

## Deploy gates and the override

`academy.deployRequest` creates a **paper** request in the existing deployment-requests flow
(status `requested`, approved in Deployments). It never routes orders. Gates
(`packages/academy/src/gates.ts`): NLV known, options only (owner rule), X03 defined risk, X09
reward:risk at least 2:1, no 0DTE, premium (max loss) per position plus premium already open in the
name within the owner cap (2% NLV, LEAPS cap from `OWNER_RISK_CAPS`), total Academy allocation at
most 100% of NLV, X02 stop or premium sizing, X01/X10 staged entries, plus X06 and C093 warnings.
NLV and open premium come only from the live portfolio feed (`VERTEX_PORTFOLIO_URL`); a typed NLV
is shown and recorded only. A conflict needs the owner's account password (Better Auth
`verifyPassword`, session-bound) and an explanation of at least 40 characters that names every
broken rule. Both the request and the override are written to `audit_records`
(`academy.deploy.request`, `academy.deploy.override`); the password is never stored.

## Authoring a lesson spec

Validate while writing: `bun scripts/academy/build-lesson-index.ts --only <slug>[,<slug>]`.
Regenerate the index after all specs exist: `bun scripts/academy/build-lesson-index.ts`.

Rules:

- Rule 1: `slug`: short kebab-case name of the lesson idea, equal to the file name. `sourceId` is the
   transcript shortcode (file name in the knowledge base). One spec per transcript.
- Rule 2: `kind`: `strategy` only when the transcript describes a concrete tradeable structure that maps
   to one of the backtest structures below. Everything else is `concept` (no `backtest`).
- Rule 3: `title` (max 90 chars): plain description of the idea, not the clickbait caption. `summary`
   (max 400 chars): what the speaker teaches, in plain words.
- Rule 4: `tags`: `regime` (1-3 of any, bullish, bearish, range, high-vol, low-vol, regime-change, event),
   `instruments` (max 5 of single-stock, etf, index-options, 0dte, futures, leaps, spreads,
   covered-calls, cash-secured-puts, hedging, synthetics, volatility, portfolio), `timeframe`
   (intraday, days, weeks, months, years), `risk` (defined, undefined, hedged, stock-like, none),
   `topics` (max 6 free words).
- Rule 5: `scene`: pick the chart that teaches the idea best.

| Scene | Use for | Element ids for steps | Params it reads |
| --- | --- | --- | --- |
| `payoff` (legs, `view` 2d/3d) | one position's P&L vs price; 3d adds a P&L surface over price x time | axes, spot, strikes, legs, expiry, now, zones, breakeven, maxProfit, maxLoss, surface (3d only) | spot, iv, rate, leg refs |
| `compare` (a, b) | two positions side by side or equivalent | axes, spot, a, b, diff, breakeven | spot, iv, rate, leg refs |
| `greeks` (legs) | delta, gamma, theta, vega vs price (four panels) | axes, spot, delta, gamma, theta, vega, strikes | spot, iv, rate, leg refs |
| `distribution` (legs optional) | price distribution, expected move, POP, EV | axes, spot, pdf, band1, band2 (+ with legs: breakeven, pop, ev) | spot, iv, dte (no legs), drift, rate |
| `ivrv` | implied vs realized vol, volatility premium | axes, price, rv, iv, vrp | spot, rvBase, ivPremium, volOfVol, drift, days, seed |
| `gex` (`view` 2d/3d) | dealer gamma by strike, flip level, walls | axes, bars, spot, flip, callWall, putWall, surface (3d) | spot, iv, dte, callWall, putWall, oiScale |
| `portfolio` mode `equity` | position sizing, Kelly, drawdown paths | axes, paths, median, drawdown | capital, riskPct, winRate, payoffRatio, trades, seed |
| `portfolio` mode `recovery` | loss and the gain needed to recover | axes, curve, marker | lossPct |
| `portfolio` mode `allocation` | core holdings + options sleeve + cash | axes, core, options, cash, maxLoss, marker | corePct, optionsPct, leverage |
| `pricepath` (legs, events) | a position managed along a price path (rolls, adjustments, behavior) | axes, price, strikes, events, pnl, spot | spot, iv, realizedVol, drift, seed, rate, leg refs |

- Rule 6: `params`: every number the viewer may change. Use ids `spot`, `iv` (percent), `rate` (percent),
   `dte`, strike ids (`strike`, `longStrike`, `shortStrike`, `putShort`...), `contracts`. Give
   `min`, `max`, `step`, `unit`. Leg fields `strike`, `dte`, `qty`, `iv` may be numbers or param ids.
   Option legs need `strike` and `dte`. Stock legs: `{ "kind": "stock", "side": "long", "qty": 1 }`
   (100 shares per qty).
- Rule 7: `steps` (3-9): one drawing step each. `element` is from the table above; `color` uses the
   palette meaning: green = profit, bullish, long; red = loss, bearish, risk; blue = current value or
   second position; amber = breakeven or key level; violet = volatility, Greeks or difference;
   cyan = spot, realized volatility or time; gold = the main payoff or the main idea; gray = reference.
   The first step that reveals an element sets that element's color everywhere (video, captions,
   interactive chart). `caption` (max 160 chars) says what the drawing shows, with numbers from the
   transcript where it gives them. `time: [from, to]` animates the scrubber (0 = entry, 1 = horizon).
- Rule 8: `formulas` (1-6): blackScholes, delta, gamma, theta, vega, putCallParity, breakevenCall,
   breakevenPut, verticalMaxProfit, expectedMove, probabilityOfProfit, expectedValue, realizedVol,
   vrp, gex, kelly, recovery, positionSize, extrinsic, annualizedYield.
- Rule 9: `takeaways` (2-5) are faithful to the transcript. `caveats` mark promotional or unverified claims
   (for example the speaker's VAY score or product), events, and owner-rule conflicts.
- Rule 10: `backtest` (strategy only): `structure` from the list below, 1-5 `tickers` from the stored
    universe (SPY, QQQ, IWM, DIA, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AMD, ON, KO, JPM, XLE,
    GLD, TLT, SMH, NFLX, COST, PG, XOM), a `scenario` inside 2011-01-01..2026-10-27, `rules` limited to
    the structure's keys, and a one-line `note`.

| Structure | Rule keys (besides profitTakePct, stopLossPct, exitDte, riskPct, ivMult, costPerContract, slippagePct, slipCap) |
| --- | --- |
| long_call, long_put | dte, longDelta |
| call_debit_spread, put_debit_spread, put_credit_spread, call_credit_spread | dte, longDelta, shortDelta |
| iron_condor | dte, shortPutDelta, longPutDelta, shortCallDelta, longCallDelta |
| iron_butterfly | dte, atmPut, atmCall, wingPutDelta, wingCallDelta |
| long_straddle | dte, callDelta, putDelta |
| short_strangle | dte, shortPutDelta, shortCallDelta |
| covered_call | dte, shortDelta |
| cash_secured_put | dte, shortDelta |
| collar | dte, putDelta, callDelta |
| protective_put | dte, putDelta |
| pmcc | coreDte, coreDelta, coreExitDte, dte, shortDelta |
| deep_itm_call | coreDte, coreDelta, coreExitDte |
| synthetic_long | dte, atmCall, atmPut |
| ratio_call_spread | dte, longDelta, shortDelta |
| calendar_call | coreDte, coreExitDte, dte, atmCall |

Put deltas are negative. `profitTakePct` and `stopLossPct` are percent of the entry premium.

Price-path lessons can set `scene.waypoints` (`[{ "day": 15, "movePct": -12 }, ...]`, moves in percent from
the entry price). The path passes through each waypoint, so the drawn story matches the events.
