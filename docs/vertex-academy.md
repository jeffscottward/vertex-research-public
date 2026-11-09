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
| Course registry | `packages/academy/src/courses.ts` |
| Lesson specs (one per transcript) | `packages/academy/src/lessons/specs/<slug>.json` (dyr), other courses `specs/<course>/<slug>.ts` |
| Transcripts | `packages/academy/src/lessons/sources.json` (dyr, `scripts/academy/build-sources.ts`); database courses: the knowledge base only, read at import time (never committed) |
| Classification pass 1 (judge model) | `packages/academy/src/lessons/classification.json` |
| Spec contract | `packages/academy/src/schema.ts` |
| Scenes, tables, formulas, timeline/VTT | `packages/academy/src/{scene-kit,scenes,tables,formulas,mathml,timeline}.ts` |
| Quant scenes (`type: "quant"`) | `packages/academy/src/quant/` (one group per file: `<group>.ts` builders, `<group>-ids.ts` modes/elements/formula ids, `<group>-formulas.ts`; `index.ts` routes a mode to its group) |
| Shared chart (web and video) | `packages/academy/src/chart/lesson-chart.tsx` |
| Modeled backtest | `packages/academy/src/backtest.ts`, `structures.ts` |
| Deploy gates | `packages/academy/src/gates.ts` |
| API | `packages/api/src/contracts/academy.ts`, `packages/api/src/server/academy.ts` |
| Pages | `apps/web/src/app/(portal)/academy/`, `apps/web/src/components/portal/academy/` |
| Video renderer | `apps/academy-video` (Remotion) |

## Courses

A course is one creator's lesson series. The registry is `packages/academy/src/courses.ts`
(`@darkfactory/academy/courses`): id, title, short title, creator, platform, profile URL,
knowledge-base folder, tagline, disclaimer, `narrated`, transcript `timestamps`, strategy prefix,
library section and tag, spec folder and spec format. Gallery copy, lesson disclaimers, Academy
strategy slugs (`<prefix><lesson slug>`), library section/tag/name and the deployment-request
refusal all read it; nothing else hard-codes a course.

| Course | Store | Specs | Sources | Narrated | Strategy prefix |
| --- | --- | --- | --- | --- | --- |
| `dyr` (Define Your Risk, default) | `package` | `specs/<slug>.json` (no `course` field) | `sources.json` | yes | `dyr-` |
| `quantfinancetogo` | `database` | `scripts/academy/lessons/quantfinancetogo/specs/<slug>.ts` exporting `spec` with `course: "quantfinancetogo"` | knowledge base (`trading/quantfinancetogo/raw`), never committed; synthetic `sources.fixture.ts` for tests | no | `qftg-` |

Spec format (`specFormat` in the registry): AGENTS.md rule 13 forbids new JSON data files, so a new
course authors each spec as a TypeScript module (`export const spec = { ... } satisfies
LessonSpecInput;`). The Define Your Risk JSON specs and `sources.json` stay on the rule's pending list until that course moves to Postgres
too.

- Pages: `/academy` shows a course picker and one group per course (the default course keeps the
  URL filters, so old `/academy?q=...` links still work); `/academy/c/<course>` is one course's
  gallery; every lesson stays at `/academy/<slug>` (slugs are unique across courses). Previous and
  next links stay inside the lesson's course.
- Unnarrated courses have no MP4 and no narration timing: the lesson page plays the live chart
  animation and links the source reel. `apps/academy-video` `--all` renders narrated courses only.
- Every course's strategies (`dyr-*`, `qftg-*`) deploy only from the lesson page; the generic
  deployment-request path refuses all of them, and the Academy allocation total counts all courses.

To add a course:

1. Add its id to `COURSE_IDS` and an entry to `COURSES` (pick a strategy prefix that is not a prefix
   of another course's; `courses.test.ts` checks this).
2. Add a reader to `READERS` in `scripts/academy/build-sources.ts` for the knowledge-base note
   format. A database course commits no sources: add a synthetic fixture (ids, URLs, dates,
   placeholder text) to `SOURCE_ID_FILES` in `scripts/academy/course-files.ts` and its specs and
   fixture to `scripts/academy/lessons/index.ts`.
3. Write specs in `specs/<specDir>/<slug>.ts` with `course: "<id>"`, then run
   `bun scripts/academy/build-lesson-index.ts` (it checks the folder, the course of each source,
   and that slugs and sourceIds are unique across courses).

QuantFinanceToGo sources come from `trading/quantfinancetogo/raw/ig-<post id>.md`: frontmatter
(`post_id`, `url`, `published`, `duration`, `title`), the `## Caption` text block (becomes
`caption`) and `## Transcript` segments `- [mm:ss] text` with real start times.

### Private transcripts

Owner decision ([Discord, 2026-11-08](https://discord.com/channels/1511468532876185770/1569026480288301237/1569139130800021597)):
QuantFinanceToGo captions and transcripts stay out of this repository.

- `bun run vertex:academy:import` reads them from the knowledge base where it runs (the rig) and
  writes them to Postgres.
- `scripts/academy/lessons/quantfinancetogo/sources.fixture.ts` stands in for them in tests, CI and the
  E2E seed. It keeps each reel's public id, URL, date and length, with placeholder text only. A new
  reel needs a row there as well as its note in the knowledge base.
- `scripts/ci/private-academy-sources.test.ts` fails if a sources snapshot, a reel note or a
  non-synthetic fixture is committed; `.gitignore` covers `sources.generated.ts`.
- Lesson text is paraphrased. Rule: lowercase, split on any non-alphanumeric character (punctuation
  included), and no run of 12 or more consecutive words may match any note in the knowledge base's
  `trading/quantfinancetogo/raw`. On 2026-11-08 every tracked file was scanned locally with that rule
  and none matched. Keep it that way when authoring.
- Commits made on the PR branch before this decision still contain a snapshot
  (`sources.quantfinancetogo.generated.ts`, `sources.generated.ts`). Rewriting that history is an
  owner decision; nothing was force-pushed.

## Database storage

A course's `store` in the registry says where the app reads its lessons:

- `package`: shipped in `@darkfactory/academy` (Define Your Risk).
- `database`: Postgres (QuantFinanceToGo). Migration `0062_academy_content` adds
  `academy_lesson_sources` (one row per reel: transcript, caption, URL, keyed by `source_id`) and
  `academy_lesson_specs` (one row per lesson: slug, course, spec JSON and its hash, one spec per
  source). Rollback: `packages/db/rollback/0062_academy_content.down.sql`. The repository is
  `createAcademyContentRepository` in `@darkfactory/db/server`.

The web app reads both stores through the same operator-only contracts, `academy.lessons` and
`academy.lesson` (`packages/api/src/contracts/academy.ts`); the transcripts are private, so there is
no public read. The app never writes these tables: the specs under `scripts/academy/lessons/` and the
knowledge-base notes stay the authored source, and the importer copies them into Postgres.

Import (validates every spec with the repository parser and checks that each lesson draws, then
upserts; a re-import of unchanged content changes nothing). Source ids and slugs are unique across
courses: an import naming another course's source or lesson is refused before any write, never moved.
`academy.lessons` lists at most 500 lessons per course; a course with more answers `STORAGE_ERROR`.

Sources always come from the knowledge base. By default that is the course's notes folder in
`$ACADEMY_KB_ROOT`, or in `~/Github/knowledge-bases` when the variable is unset
(`trading/quantfinancetogo/raw`); `--kb <dir>` names the folder directly. A missing or empty folder
exits 2 with the path it looked for.

```sh
DATABASE_URL=postgres://... bun run vertex:academy:import            # every database course
bun run vertex:academy:import -- --course quantfinancetogo --dry-run  # validate only, no database
bun run vertex:academy:import -- --course quantfinancetogo --kb <dir>  # notes from another folder
bun run vertex:academy:import -- --prune                              # also delete rows no longer authored
```

The E2E global setup (`tests/e2e/global-setup.ts`) runs the same import into the test database
after migrating it, with the synthetic fixture sources (CI has no knowledge base). Browser tests see
the QuantFinanceToGo lessons with placeholder transcripts.

Deploy order: run steps 1-2 before deploying the web app (step 3), which reads these tables.

1. `bun run db:migrate` (applies 0062).
2. On the rig, against the production database, validate then import:
   `DATABASE_URL="$ORIGIN_DATABASE_URL" bun run vertex:academy:import -- --course quantfinancetogo --kb <rig KB>/trading/quantfinancetogo/raw --dry-run`,
   then the same command without `--dry-run`. Alternatively, set `ACADEMY_KB_ROOT=<rig KB>` and
   omit `--kb`. The transcripts never pass through the repository or CI.
3. Deploy the web app.

Local databases that ran this migration under an earlier number (`0058_academy_content` or
`0059_academy_content` or `0060_academy_content`, before the renumber to 0062): apply
`packages/db/rollback/0062_academy_content.down.sql` (delete academy rows first if it refuses),
delete the old academy ledger row (not the base's own 0058-0060 rows) from
`drizzle.__drizzle_migrations` (match its hash), run
`bun run db:migrate`, then re-run `bun run vertex:academy:import`.

If the web app ships first anyway, `/academy` still lists Define Your Risk, and a course whose read
fails (tables missing: `STORAGE_ERROR`) shows "Course unavailable" there. A database course with no
rows shows "Course content not imported yet" on `/academy` and on `/academy/c/<course>`. Until the
tables exist, `/academy/c/<course>` and `/academy/<slug>` of a database course reach the error
boundary.

Run the import again after any change to a database course's specs or sources. `--prune` refuses an
input with no lessons, so it can never empty a course.

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
| `quant` mode `walk` / `gbm` / `meanrev` | random walk and bets, GBM price fan, Ornstein-Uhlenbeck mean reversion | walk: axes, paths, mean, band, bars, pdf; gbm: + median; meanrev: axes, paths, mean, band, halfLife, decay | see `quant/process-ids.ts` |
| `quant` mode `compound` / `logreturns` / `drag` | present value, % vs log returns, volatility drag | `quant/growth-ids.ts` | `quant/growth-ids.ts` |
| `quant` mode `frontier` / `diversify` / `sml` / `riskparity` / `blend` | Sharpe and efficient frontier, correlation and diversification, CAPM/APT, risk parity, Black-Litterman | `quant/portfolio-ids.ts` | listed in `quant/portfolio-ids.ts` |
| `quant` mode `regression` / `factor` | beta, alpha, R², Fama-French/Carhart; factor sorts, crash, publication decay | `quant/statistics-ids.ts` | `quant/statistics-ids.ts` |
| `quant` mode `snooping` / `significance` | data snooping, t-stat of a Sharpe ratio | `quant/testing-ids.ts` | rules, years, seed; sharpe, years, alpha |
| `quant` mode `tail` / `volcluster` / `voltarget` / `filter` | fat tails, VaR/ES, GARCH/GJR, vol targeting, Kalman filter | `quant/volatility-ids.ts` | `quant/volatility-ids.ts` |
| `quant` mode `pairs` / `landscape` / `orderbook` | pairs trading, walk-forward Sharpe landscape, order book and slippage | `quant/trading-ids.ts` | listed in `quant/trading-ids.ts` |
| `quant` mode `smile` / `binomial` / `hedge` | implied vol by bisection and smile, CRR tree, delta hedging P&L | `quant/options-ids.ts` | `quant/options-ids.ts` |

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
   vrp, gex, kelly, recovery, positionSize, extrinsic, annualizedYield, plus the quant formulas of each
   group (`FORMULA_IDS` in `quant/<group>-ids.ts`, rendered from `quant/<group>-formulas.ts`).
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
