# OpenBB data sources

Card `vertex-openbb` (stack vertex). Research only: nothing here places, changes or cancels orders.
Inventory of every OpenBB provider, extension and command with a have/add/skip decision:
`~/Documents/reports/web/vertex-openbb/inventory.md` (rig report). This page covers the "add" set.

## Data path

```text
rig user timer vertex-openbb.timer (every 5 min) -> tick-runner, steps file (one step per job)
  -> bun scripts/openbb/tick.ts <job>
       -> services/openbb (pinned OpenBB Platform, python -I) prints one JSON document per table
       -> Zod contract (packages/api/src/contracts/openbb.ts) checks every row
       -> oRPC openbb.ingest (agent WRITE key, operator only), chunks of <= 2,000 rows
            -> Drizzle repository (packages/db/src/server/openbb.ts) -> Postgres (upsert by key)
       -> oRPC openbb.recordRun (one row in openbb_ingest_runs per job run)
reads: oRPC openbb.* (operator, read-only) -> /markets, /flow, /stock/[symbol], MCP tools
```

No Python process opens Postgres and no JSON data file is written (AGENTS.md rule 6, owner rule).
The Python fetcher only reads public upstreams and prints to stdout.
The job `cme-futures-oi` reads the CME public FTP server through its own adapter
(`services/openbb/vertex_openbb/cme_ftp.py`); no other job uses FTP.

## Fetcher CLI (services/openbb)

`python -I -m vertex_openbb <job> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--symbols A,B] [--filers CIK,CIK]`

- Output: stdout, one JSON document `{"schemaVersion": "openbb-batch.v1", "job": "<job>",
  "openbbVersion": "<openbb-core version>", "tables": [{"table": "<table>", "rows": [...]}],
  "warnings": ["..."]}`. Row keys are camelCase and match the Zod row schemas below exactly. Dates are
  `YYYY-MM-DD`, numbers are JSON numbers or null, never NaN or Infinity.
- Exit codes: 0 ok (warnings allowed, including a partial document at the deadline) or blocked
  upstream (see below), 1 internal error, 2 bad arguments or missing/malformed SEC contact, 3 upstream
  failed for every source of the job and at least one failure is not a block. Errors go to stderr. No
  secret is printed.
- Blocked upstream: the host refused the request before it gave data (HTTP 403 or 429 from an OpenBB
  fetcher, or an HTML page with a status below 400 where JSON was expected, for example a Cloudflare
  bot check; error kind `blocked` with the HTTP status and the host). An HTML error page with another
  status (404, 502) and every failure of a plain HTTP file (`http_text`: 429 and 5xx are kind `error`)
  are plain failures. When every source of a job is blocked, the fetcher exits 0 and prints the
  document with empty tables and `"blocked": {"host": "<host>", "httpStatus": <code>}` (the first
  blocked source). The key is absent in every other document. The FINRA rule for HTTP 403 on a plain
  file (kind `forbidden`, "not published") is separate and is not a block.
- `cboe-vx-curve` second source: when the Cboe curve call fails for a reason other than "no data", the
  job reads the CFE daily settlement file
  (`https://www.cboe.com/us/futures/market_statistics/settlement/csv?dt=<day>`, columns `Product,Symbol,
  Expiration Date,Price`) of the session and, when that file has no VX rows, of the 4 calendar days
  before it, newest first. It takes the monthly VX contracts (`VX/<month code><year digit>`; weekly
  contracts are left out); `asOf` is the day of the file. The run then has the warning
  `...; used the CFE settlement file of <day>`. The CFE file holds the official daily settlement price;
  the Cboe curve holds the end-of-day quote (difference about 0.3 % on 2026-11-06: 23.6945 against
  23.75 for the 2026-11 contract). Without CFE rows the source fails with the Cboe error.
- `cboe-option-iv` second source: when a symbol's Cboe chain call fails for a reason other than
  "no data", the job reads the Yahoo option chain through the pinned `yfinance==0.2.66` client
  (the same pin as `infra/option-chain/vertex-option-chain-run`; free public quotes, no IBKR
  gateway call, no Quant Data quota). One request returns the quote, the expiration list and the
  first chain; each remaining expiration costs one request (179 requests for a full Core 7
  snapshot, measured 2026-11-21), 0.1 s apart. IV is Yahoo's per-contract column with a 0.01
  sentinel floor (Yahoo sends ~1e-5 placeholders; below the floor the contract keeps OI/volume
  with no IV/greeks); delta and gamma are computed with Black-Scholes-Merton (rate 4%, Yahoo's
  trailing dividend yield, whole days/365 — the formula of `packages/api/src/options-chain-greeks.ts`,
  whose erf approximation bounds cross-language parity at 2e-7). `asOf` is the New York date of
  the quote's `regularMarketTime` (epoch seconds), capped at today; a missing quote time fails
  the symbol. The run then has the warning
  `cboe chain <SYM>: <Cboe error>; used the Yahoo option chain (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)`
  and the status `partial`. Values differ from the Cboe exchange series (measured boundary jump
  2026-11-19 → 11-20: +4.2 to +8.4 vol points on atmIv30d, market move included; see
  `docs/vertex-rebuild/designs/openbb-option-iv-second-source/plan.md`). When Yahoo also fails,
  the source fails with the Cboe error, so a blocked Cboe path stays `blocked_upstream`.
  Session guard: a timer run passes the newest run's summary on stdin (`--state-stdin`); a
  symbol whose Yahoo rows are already stored for the current New York session skips the re-fetch
  (warning `... used the Yahoo option chain earlier this session; skipped the re-fetch`, so the
  marker and the panel note persist); a manual run always fetches. Fallback gate: a Yahoo call
  starts only when at least 100 s remain to the job deadline (`YAHOO_FALLBACK_RESERVE_S`), so a
  slow Yahoo cannot push a fast-refusal run into the deadline's failed path; with slow Cboe
  calls a started fallback can still consume a later symbol's time (accepted, tested).
- Time limits: each upstream call has a 90 s limit; `OPENBB_DEADLINE_S` (default 240; every step
  timeout is at least this + 90 s, SEC steps + 110 s, checked by `infra/openbb/rig/install.test.ts`;
  the rig wrapper unsets any override so the default holds) bounds the whole job and prints the rows fetched so far with a warning.
- One failing source never drops the others: it is reported as a warning and its rows are left out.
  A source that returns records but no valid row warns `none gave a row (format change?)`.
- `--warm` imports every fetcher the jobs use, checks the SEC guard hooks and prints
  `warm: ok <openbb-core version>` (run by the installer).
- Event keys are stable: `fedcal:<kind>:<date>[:<HH:MM>]`, `fedrel:<date>:<release code>`,
  `fomcdoc:<url>`, `auction:<cusip>:<date>`, `auction-result:<cusip>:<date>`.
- Option figures (IV, OI/volume totals, GEX, walls, flip, term rows) leave out contracts that expire
  on the snapshot date.
- SEC requests send `User-Agent: vertex-research openbb (personal research; <VERTEX_RESEARCH_CONTACT_EMAIL>)`
  and stay under 10 requests/s. With no contact email the SEC jobs exit 2 (never invent one).
  The congress jobs send `vertex-research congress (personal research; <VERTEX_RESEARCH_CONTACT_EMAIL>)`
  from the same variable, exit 2 without it, and remove the address from warnings.
- `--until` (optional; only `congress-house`, `congress-senate`, `sec-form4` and `cme-futures-oi`; default today, America/New_York) ends the date window. Other jobs exit 2 with "takes no --until". Without `--since` it must not be before the default window start (today minus 21 days; `sec-form4` 40 days, `cme-futures-oi` 4 days).
  The congress jobs use it for backfills in chunks, because each run stops at the deadline. It must
  not be after today or before `--since` (exit 2).
- Defaults: `--since` is job specific (see the job table); `--symbols` defaults to
  `OPENBB_STOCK_UNIVERSE` from the environment, else the default universe below.

Default universe:

- Core 7 ETFs: SPY QQQ DIA IWM GLD SLV USO.
- Stock universe (stock pages, SEC, FINRA): AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO COST NFLX.

## Jobs and schedule

One rig user timer (`infra/openbb/rig/vertex-openbb.timer`, 5 minutes after the previous run ends) starts
`vertex-openbb.service`, which runs `tick-runner vertex-openbb ~/.local/share/vertex-openbb/vertex-openbb.steps`.
The steps file (`infra/openbb/rig/vertex-openbb.steps`, format `name timeout_s every_s stage command`)
holds one step per job: tick-runner runs a step when `every_s` has passed since its last run, steps
of one stage in parallel and stages one after another (stage 1 Cboe/CFTC/Fed, stage 2
Treasury/OECD/FRED/FINRA/Fama-French/Congress/CME, SEC jobs alone in stages 3-6). Each step runs the wrapper
`vertex-openbb-run <job> [--window <days>@<HH:MM>-<HH:MM>]`; outside its window the tick prints
`skip: outside window` and exits 0. The wrapper holds `~/.cache/vertex-openbb/sec.lock` for `sec-*`
jobs, so a manual SEC backfill never overlaps the timer's SEC stages: a manual run waits for the lock;
a timer run (the service sets `VERTEX_OPENBB_TIMER=1`; `INVOCATION_ID` is no marker because desktop
session shells on the rig set it too) waits 20 s (`flock -w 20 -E 75`), then prints
`skip: SEC lock held (manual run in progress)` and exits 0. The service sets `MemoryHigh=2560M`,
`MemoryMax=3G` and `OOMPolicy=continue` (an out-of-memory kill ends one step, not the run);
`TimeoutStartSec` covers the stage maxima plus 10 s per stage. Every step timeout is at least the
fetcher deadline `OPENBB_DEADLINE_S` (default 240 s) + 90 s, and SEC steps another 20 s for the lock
wait (350 s; `sec-13f` 600 s), so the fetcher prints what it has and the tick posts it before
tick-runner stops the step (`infra/openbb/rig/install.test.ts` checks both). The wrapper unsets
`OPENBB_DEADLINE_S`, because the step budget assumes the default.
The tick gives each openbb.* call 60 s and refuses fetcher output over 64 MiB (a failed run).
It also kills the fetcher when it still runs 10 s after its deadline (250 s by default) and records a
failed run, also when a descendant keeps stdout open; tick-runner kills the rest of the step's process
group when the step ends.
When the fetcher exits but a descendant still holds stdout, the tick waits 2 s and then uses the
output it has.
Install: `infra/openbb/rig/install.sh <sha> [--enable]` (needs tick-runner and user lingering; it
waits up to 600 s for tick-runner's run lock `~/.local/state/tick-runner/vertex-openbb/run.lock` and
holds it until the files are in place, releasing it before the systemctl calls, locks the checkout
worktree so bulk worktree cleanup leaves it intact, and syncs the venv with `uv pip sync --require-hashes --only-binary :all:
--no-config`).

| Job | Source | Tables | Step: stage, every, `--window` (America/New_York), timeout | Default `--since` |
| --- | --- | --- | --- | --- |
| `cboe-vol-indices` | `index/price/historical` (cboe) | `daily_series` | 1, 1 h, `mon-fri@16:45-24:00+tue-sat@00:00-06:00`, 240 s | 10 days (backfill: 1990-01-01) |
| `daily-prices` | IBKR history, then Yahoo (`services/research/ibkr_history.py`); Shiller workbook | `daily_series`, `daily_bars` | 2, 20 min, `tue-sat@00:30-06:00`, 240 s | 7 days before the stored last date |
| `cboe-vx-curve` | `derivatives/futures/curve` (cboe) | `vx_curve` | 1, 1 h, `mon-fri@16:30-24:00`, 180 s | today (snapshot) |
| `cboe-option-iv` | `derivatives/options/chains` (cboe); second source: Yahoo chains (pinned yfinance) | `option_iv_daily`, `option_iv_term` | 1, 1 h, `mon-fri@16:20-21:00`, 420 s | today (snapshot) |
| `cftc-cot` | `cftc/cot` | `cot_positions` | 1, 1 h, `fri,sat,mon@15:45-24:00`, 300 s | 8 weeks (backfill: 2010-01-01) |
| `fed-rates` | `fixedincome/rate/{effr,sofr,overnight_bank_funding}`, `fixedincome/government/treasury_rates` (federal_reserve) | `macro_points` | 1, 4 h, any time, 240 s | 30 days (backfill: 2000-01-01) |
| `fed-regime` | NFCI and ANFCI from keyless FRED `fredgraph.csv`; KC FSI, NY nowcast, NY GSCPI, NY CBDI, Cleveland inflation nowcast, `economy/central_bank_holdings` | `macro_points` | 1, 6 h, any time, 300 s | 400 days (backfill: full) |
| `fed-events` | `economy/fomc_documents`, `federal_reserve/release_calendar`; upcoming auctions from TreasuryDirect public JSON (not OpenBB) | `event_calendar` | 1, 6 h, any time, 240 s | 30 days back, all future |
| `treasury-tga` | `ustreasury/daily_statement`; auction results from TreasuryDirect public JSON (not OpenBB) | `macro_points`, `event_calendar` | 2, 4 h, any time, 240 s | 30 days (backfill: 2015-01-01) |
| `oecd-cli` | `economy/composite_leading_indicator` (oecd, USA) | `macro_points` | 2, 24 h, any time, 240 s | 3 years (backfill: 1960-01-01) |
| `fred-keyless` | FRED observations via keyless `fredgraph.csv` (OpenBB fred needs a key; owner pick pending) | `macro_points` | 2, 6 h, any time, 240 s | 400 days (backfill: full) |
| `finra-otc` | `equity/darkpool/otc` (finra) | `finra_otc_weekly` | 2, 6 h, any time, 240 s | 8 weeks (backfill: available) |
| `finra-short-interest` | `equity/shorts/short_interest` (finra) | `short_interest` | 2, 12 h, any time, 240 s | 60 days (backfill: available) |
| `finra-short-volume` | FINRA Reg SHO daily file `cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt` (not in OpenBB); every symbol of the file (FINRA symbol rule `^[A-Za-z0-9./^=-]{1,16}$`, smart-money PR 5) | `short_volume_daily` | 2, 3 h, any time, 240 s | 5 days (backfill: 1 year) |
| `sec-filings` | `equity/fundamental/filings` (sec) | `sec_filings` | 3, 2 h, `mon-fri@07:00-22:00`, 300 s | 30 days (backfill: 2 years) |
| `sec-insider` | `equity/ownership/insider_trading` (sec) | `sec_insider_trades` | not scheduled (retired by `sec-form4`; job and table kept until the new data covers 30 days) | 30 days (backfill: 2 years) |
| `sec-form4` | EDGAR daily form index `daily-index/<YYYY>/QTR<q>/form.<YYYYMMDD>.idx` and each full submission `<accession>.txt` (not OpenBB; OpenBB's `clean_xml` and transaction code map) | `sec_form4_transactions`, `sec_form4_owners`, `sec_form4_filings`, `sec_form4_index_days` | 4, 10 min, any time, 350 s | 40 days (`--until` default today; `--since` for history) |
| `sec-ftd` | SEC fails-to-deliver files, file list read from the SEC FTD listing page; every (CUSIP, symbol) pair of the files feeds the CUSIP-to-ticker map | `sec_ftd`, `cusip_symbols` | 5, 12 h, any time, 300 s | 60 days (backfill: 2 years) |
| `sec-13f` | `equity/ownership/form_13f` (sec): full books of 23 filers (`FILERS` in `jobs/sec.py`); filings already in the ledger are skipped (`--skip-accessions` from `openbb.sec13fAccessions`); at most 40,000 rows per run | `sec_13f_holdings`, `sec_13f_filings` | 6, 24 h, any time, 600 s | 2 quarters (backfill: 8 quarters) |
| `famafrench` | `famafrench/factors` (daily + monthly, 5 factors + momentum) | `factor_returns` | 2, 24 h, any time, 240 s | 120 days (backfill: full) |
| `congress-house` | House Clerk yearly index `financial-pdfs/<YEAR>FD.zip` and PTR PDFs `ptr-pdfs/<YEAR>/<docId>.pdf` (not OpenBB) | `congress_trades`, `congress_filings` | 2, 6 h, any time, 330 s | 21 days (`--until` default today) |
| `congress-senate` | Senate eFD search (`efdsearch.senate.gov`, report type 11 = PTR) and PTR pages (not OpenBB) | `congress_trades`, `congress_filings` | 2, 6 h, any time, 330 s | 21 days (`--until` default today) |
| `cme-futures-oi` | CME "Daily Volume and Open Interest" workbook, anonymous FTP `ftp.cmegroup.com`, `/daily_volume/daily_volume_<YYYYMMDD>.xlsx` (not OpenBB): preliminary open interest of the ES and NQ futures, all contract months | `macro_points` | 2, 2 h, `mon-fri@05:00-09:00`, 330 s | 4 days: today and the 4 days before (`--until` default today; at most 370 days per run) |

`flow.control` reads the `openbb_event_calendar` rows of kind `fomc_meeting` and source `federal_reserve` for the session date to set `session.event`; when the job has not run there is no FOMC mark, and the document says "not read" only when the read itself failed.

Vol index ids (kind `index`, source `cboe`): VIX VIX1D VIX9D VIX3M VIX6M VIX1Y VVIX SKEW VXN VXD RVX
GVZ OVX VXSLV. They go to the existing `market_daily_series` / `market_daily_points` tables, so the
strategy gates (`vixTermStructure`, `volRegime`, the DSL's min-max `ivRank`) read Cboe's own closes without a
manual import.

Provenance rule (`upsertPoints`; it and `replaceSeries` take
`pg_advisory_xact_lock(hashtextextended('market_daily_series:' || id, 0))` first): for Cboe vol
indices a series missing from storage is created with source `cboe` (`createIfMissing: true`),
while for `daily-prices` price series `openbb.ingest` passes `createIfMissing: false` and refuses
a missing series with `BAD_REQUEST`; a series whose source matches the writer gets a full upsert
by date; a series another source owns (a `vertex:series:import` file) keeps its source and its
stored closes, and openbb.ingest only appends dates after its `last_date`. After every write
`point_count`, `first_date`, `last_date` and `source_sha256` are recomputed in SQL; the digest is
sha256 over the stored rows, one `date|open|high|low|close|adj_close` line per date in date order
(dates as `to_char(date, 'YYYY-MM-DD')`, floats in shortest exact text with `extra_float_digits = 1`
set in the transaction, so session settings do not change it)
(null as empty), so it describes the stored series. Re-running `vertex:series:import` replaces the
whole series (its own source again); the next `cboe-vol-indices` tick re-appends newer dates.

COT markets (code, report type): ES 13874A tff, NQ 209742 tff, YM 124603 tff, RTY 239742 tff,
VX 1170E1 tff, ZN 043602 tff, DX 098662 tff, GC 088691 disaggregated, SI 084691 disaggregated,
CL 067651 disaggregated. Categories: tff = dealer, asset_manager, leveraged_funds, other_reportables,
nonreportable; disaggregated = producer_merchant, swap_dealer, managed_money, other_reportables,
nonreportable.

Macro series ids (`macro_points.seriesId`, unit in brackets):

- fed-rates: `EFFR`, `SOFR`, `OBFR` [percent]; `UST1M` `UST3M` `UST6M` `UST1Y` `UST2Y` `UST5Y` `UST10Y` `UST30Y` [percent].
- fed-regime: `NFCI`, `ANFCI`, `KCFSI`, `GSCPI`, `CBDI`, `CBDI_IG`, `CBDI_HY` [index]; `NY_GDP_NOWCAST` [percent];
  `CLEV_CPI_NOWCAST`, `CLEV_CORE_CPI_NOWCAST` [percent]; `SOMA_TOTAL` [usd].
- treasury-tga: `TGA` [usd, closing balance].
- oecd-cli: `OECD_CLI_USA` [index].
- fred-keyless: `HY_OAS` (BAMLH0A0HYM2), `IG_OAS` (BAMLC0A0CM), `T10Y3M`, `T10Y2Y`, `RRP` (RRPONTSYD),
  `WALCL`, `DTWEXBGS`, `ICSA`, `STLFSI4` [as FRED reports them].
- cme-futures-oi: `CME_ES_OI`, `CME_NQ_OI` [contracts; preliminary open interest of the future, all contract months,
  one point per CME trade date].

Rates are stored in percent (OpenBB returns decimals: multiply by 100).

CME open interest (`cme-futures-oi`): one run opens one FTP session and reads one workbook per weekday of
its date range, newest first, with a 0.2 s pause between files. A `550` reply to `RETR` means that CME
did not publish the day (a holiday, or the file is not there yet): no row and no warning. A date range of
3 or more weekdays without any file fails the run, so a moved directory does not look like a holiday
week. The job reads the sheet "CME Group Vol and OI by Product", finds the columns by header text and
checks the trade date against the file name; a failed check stores no value from that file or product
and adds a warning that names the file. The figure is the preliminary one (CME publishes the final
figure the next morning in another report). The timer runs the step one or two times on a weekday
morning; the 5-date default range reads a missed day again on the next runs. A date range of more than
370 days exits 2. Backfill of one year: `vertex-openbb-run cme-futures-oi --since "$(date -d '369 days ago' +%F)"`
(the longest range one run accepts, about 252 files; when the run reports that it reached its time
limit, run it again with `--until` set to the oldest date it stored).

## Daily prices (daily-prices)

Design: `docs/vertex-rebuild/designs/daily-series-refresh/plan.md`. The job appends the finished
sessions to the 17 stored price series (`OPENBB_PRICE_SERIES_KINDS`: the Core 7 ETFs, their 7
futures, IRX, TNX and the derived EY_TNX_RATIO) and to the 14 stored `1d` bar series (ETFs and
futures). A stored row never changes.

- **State:** the tick reads `openbb.dailyPricesState` (the last date, close and adj_close of each
  price series; the last date and close of each `1d` bar series) and passes it on stdin
  (`--state-stdin`). A failed read fails the run. A dry run has no state: it prints the rows of the
  last 10 days without a seam check and with a warning.
- **Units:** TNX (with EY_TNX_RATIO), IRX, the ETFs, the futures. A unit whose series and bar
  series hold the last NYSE session before today (New York) makes no request. A unit starts only
  when 100 s remain to the 240 s deadline; units left over are done by the next run.
- **Sources:** IBKR first, with no paced retry; Yahoo when IBKR fails. A paced IBKR answer ends the
  run (the next run continues). After the first IBKR error, the other units of the run read Yahoo
  at once. Without `VERTEX_HISTORY_URL` and `VERTEX_DEPLOY_STATUS_TOKEN` in
  `~/.config/vertex/openbb.env` only Yahoo is read. The tick gives these two variables and
  `OPENBB_RESEARCH_DIR` to this job's fetcher only; the fetcher scrubs them from its output.
- **Finished sessions:** only rows dated before today (New York) are accepted, so the job runs
  after midnight.
- **Seam check:** the fetched close on the stored last date must be within 2 % of the stored close
  (futures: 10 %). The series and the bar series of a unit are checked separately. A unit that
  fails, has no fetched row on the stored last date, or would append Treasury fallback rows writes
  nothing and warns (run status `partial`); repair it with `vertex:series:import` /
  `vertex:bars:import`.
- **adj_close:** ETF: fetched adj_close x (stored adj_close on the seam / fetched adj_close on the
  seam). Futures: the close. Indices and EY_TNX_RATIO: null. Index rows store the close only.
- **EY_TNX_RATIO:** 100 x earnings / price of the Shiller month 6 months back, divided by the TNX
  close (`eyTnxRatio` of `scripts/market-series/import.ts`). Rows stop at the first date whose
  lagged Shiller month is not published or whose TNX close is missing / `<= 0`, and the run warns
  with the stopped date, reason and count of rows not appended. Rows are derived only from TNX rows
  that passed the seam check in the same run (or in a dry run). A revised workbook (more than 2 %
  off on the stored last date, when rows are appended) gives one warning.
- **Rows without holes:** the rows of a unit stop at the first row that cannot be stored (the row
  schema refuses it, or an ETF row has no adj_close); the run warns with the date. After a failed
  chunk of `daily_series` or `daily_bars` the tick posts no later chunk of that table.
- **Bars:** `openbb.ingest` appends `daily_bars` rows with `appendBars`: only bars after the stored
  last bar; `bar_count`, `last_t` and `source_sha256` (sha256 over the stored bars, one
  `t|o|h|l|c|v` line per bar in time order, null volume as empty) are recomputed. `source` keeps
  the text of the base import. A backtest run in flight while its bar series is appended is refused
  by the existing "stored bars changed" check; start it again.
- **Fixture:** the test fixture holds made-up prices (IBKR and Yahoo rows are not redistributed).

## Congress trades (congress-house, congress-senate)

STOCK Act periodic transaction reports (PTRs) of members of Congress. Each job prints
`congress_trades` first, then `congress_filings` (the tick stores tables in that order, so the
trades exist before the ledger counts them). The window is filing date from `--since` to `--until`.

- House: the yearly index `<YEAR>FD.zip` for every year from the window start to the window end
  (zip at most 8 MiB, index text at most 32 MiB); rows with `FilingType` `P`. Document ids that
  start with `2` are electronic: the PDF (at most 10 MiB) is read with pdfplumber
  (`extract_text(layout=True)`, at most 40 pages). Other ids are scanned paper filings: ledger row
  only, no download. 0.5 s between House requests.
- Senate: one session: the home page, then the statement-of-understanding form
  (`prohibition_agreement=1`), then the search (`report_types=[11]`, 100 rows per page, at most 100 pages, else the source fails; `submitted_end_date` is sent when the window ends before today),
  then each `/search/view/ptr/<uuid>/` page. By accepting that statement, the user agrees that the
  data is not used for a commercial purpose, credit rating or fundraising; Vertex is a private
  research tool and uses the data only for research. `/search/view/paper/<uuid>/` links are scanned
  paper filings. 1 s between Senate requests.
- Upstream keys (tests replay them): `congress:house-index:<year>` (index text),
  `congress:house-pdf:<docId>` (PDF text), `congress:senate-search:<since>` or `congress:senate-search:<since>:<until>` (search rows),
  `congress:senate-ptr:<uuid>` (transactions table HTML).
- Outcomes: a failed index or search download fails that source (existing `partial`/`failed`
  rules; a House index that is not published yet (HTTP 404) is a warning only). A failed PDF or
  page download is a warning and gives no row for that filing, so a stored parsed filing is never
  replaced. Scanned or unreadable filings are ledger rows, not warnings.
- Ledger `reason` (null exactly when `status` is `parsed`; `rowCount` is 0 when unparsed):
  `scanned_image` (paper filing, no text), `no_transactions` (the report lists no transaction),
  `layout_unknown` (the parser cannot read every row completely; nothing is guessed).
- Mappings: House holder codes blank/SP/JT/DC and Senate Self/Spouse/Joint/Child give
  `self`/`spouse`/`joint`/`dependent` (other Senate values: null). House types P, S, S (partial), E
  and Senate Purchase, Sale (Full), Sale (Partial), Exchange give `purchase`, `sale`,
  `sale_partial`, `exchange`; others `other`. `Over $X` gives `amountLow` X+1 and `amountHigh` null.
  House member = prefix, first, last, suffix; Senate member = first name and last name. House
  filings have `amends` false (the index has no amendment flag); Senate `amends` is true when the
  report title says "Amendment".
- Parser versions `house.v1`, `senate.v1` are stored per filing; change them when parsing changes.
- Backfill: `vertex-openbb-run congress-house --since 2026-01-01 --until 2026-01-31`, one month per
  run, then the same for `congress-senate`.
- Test fixtures are synthetic (fictional members and documents in the recorded format):
  edit `tests/fixtures/upstream/congress-*.json` and run `python tests/record.py --replay`.

## Form 4 market-wide (sec-form4)

Design: [designs/smart-money/plan-pr3.md](designs/smart-money/plan-pr3.md). For each weekday of the
window the job reads the EDGAR daily form index, keeps the distinct accessions of form `4` and `4/A`
(the index lists one line per filer), and fetches each full submission once: the SEC header gives
the acceptance time (America/New_York) and the Form 4 XML gives issuer CIK, name and symbol, the
reporting owners (CIK, name, roles, officer title), the 10b5-1 flag and the transaction rows
(non-derivative first, then derivative; holding rows are not stored). Six downloads run at once
through the `sec_guard` limit of 8 requests/s.

- **Ledger:** one `sec_form4_filings` row per accession: `parsed`, or `unparsed` with reason
  `no_xml`, `too_large` (over 4 MiB), `not_found` (HTTP 404) or `layout_unknown`. A download
  failure writes no row, so the next run tries again. One `sec_form4_index_days` row per index day
  counts listed and done accessions; `complete` is true when they are equal.
- **Resume:** the tick reads `openbb.form4State` for the window and passes it on stdin
  (`--state-stdin`): complete days get no request, done accessions are not fetched again, and a
  `layout_unknown` filing is read again when the parser version changed. An index that answers 404, or 403 with the archive's XML `AccessDenied` body (how EDGAR answers a missing file; a block is an HTML page),
  (a holiday, or the day before about 22:00 ET) writes nothing.
- **Order:** transactions and owners, then filings, then index days; the tick skips a table when a
  table it requires failed (`OPENBB_TABLE_REQUIRES`).
- **Reads:** a transaction or owner counts only while its filing is parsed (and `row_number <=
  row_count`). `openbb.sec` reads insider rows from these tables (by issuer symbol). Insider
  clusters use parsed form `4` filings only.
- **History:** `vertex-openbb-run sec-form4 --since <day> --until <day>`, about 1,500 filings per
  business day.

## Tables (migration 0064_openbb_sources.sql)

All tables grant SELECT/INSERT/UPDATE/DELETE to `vertex_research` with the guarded `DO $$` block
(pattern 0039). Primary keys make every ingest an idempotent upsert (the last duplicate key in one
chunk wins). 0064 also grants UPDATE on `market_daily_series` and `market_daily_points` (0060 granted
none; `upsertPoints` needs it); the rollback `packages/db/rollback/0064_openbb_sources.down.sql`
refuses while any OpenBB row exists, revokes that UPDATE grant and leaves the vol index points.
Every table has one CHECK constraint (`<table>_check`): finite doubles, non-negative counts, enums,
symbol/CUSIP/CIK/accession patterns, `expiration >= as_of`, `finished_at >= started_at`.

Nullable beyond the columns marked null below: `atm_iv_30d`, `put_iv_25d_30d`, `call_iv_25d_30d`,
`net_gex`, `gamma_flip`, `call_wall`, `put_wall` (option IV daily), `atm_strike`, `atm_iv` (IV term),
`spreading` (COT: `nonreportable` and the disaggregated `producer_merchant` category report none), `last_updated` (FINRA OTC), and `previous_short_interest`,
`avg_daily_volume`, `days_to_cover` (short interest).

Units: IV columns (`atm_iv_30d`, `put_iv_25d_30d`, `call_iv_25d_30d`, `atm_iv`) are decimals
(0.153 = 15.3%; Zod bounds them to 0..10); `underlying_price` and the VX `price` are > 0. `net_gex`
(dollars per 1% move), `gamma_flip`, `call_wall` and `put_wall` exclude same-day expirations. 13F
`value` is in dollars (filings before 2023 reported thousands; the fetcher scales them x1000). Rows
stored before that scaling, for periods with filings before 2023-01-03, are 1000 x too small and must
be refetched once: `vertex-openbb-run sec-13f --since 2022-01-01`.

Daily IV rows store provenance in `openbb_option_iv_daily.source` as `cboe`, `yahoo_fallback`, or `unknown`. A new Python producer row must use one of the named provider sources. Legacy API rows without `source` are stored as `unknown`. Legacy source is not backfilled: `cboe-option-iv` is a snapshot job and cannot re-fetch a missed session, so old rows stay `unknown`; same-key upserts replace the source and IV values together. The public read contract does not expose the stored source; it returns a coarse `historyState` derived from the same newest-252-row sample used for the IV percentile. `affected` means at least one sampled row is Yahoo-derived, `clean` means a non-empty sample is entirely Cboe-derived, and `source_unverified` means no sampled row is Yahoo-derived and at least one sampled row has an `unknown` source. An underlying with no stored rows returns no `ivDaily` row.

| Table | Primary key | Columns |
| --- | --- | --- |
| `openbb_ingest_runs` | `id` uuid | job, started_at, finished_at, status (`ok`/`partial`/`failed`/`blocked_upstream`, the last from migration 0087, which also adds the index on job, started_at), rows_received, rows_written, warnings text[], error text, openbb_version |
| `openbb_vx_curve` | (as_of, contract_month) | as_of date, contract_month text `YYYY-MM`, price double |
| `openbb_option_iv_daily` | (as_of, underlying) | source (`cboe`/`yahoo_fallback`/`unknown`), underlying_price, atm_iv_30d, put_iv_25d_30d, call_iv_25d_30d, call_oi, put_oi, call_volume, put_volume, net_gex, gamma_flip, call_wall, put_wall, contracts |
| `openbb_option_iv_term` | (as_of, underlying, expiration) | dte, atm_strike, atm_iv, call_oi, put_oi, call_volume, put_volume |
| `openbb_cot_positions` | (report_date, market_code, category) | market, report_type, long, short, spreading, open_interest |
| `openbb_macro_series` | id | source, name, unit, frequency, first_date, last_date, point_count, updated_at |
| `openbb_macro_points` | (series_id, date) | value double |
| `openbb_event_calendar` | (source, event_key) | date, time text null, kind, title, detail text null |
| `openbb_finra_otc_weekly` | (week_start, symbol, venue) | venue (`ats`/`non_ats`), tier, shares, trades, last_updated |
| `openbb_short_interest` | (settlement_date, symbol) | short_interest, previous_short_interest, avg_daily_volume, days_to_cover |
| `openbb_short_volume_daily` | (date, symbol) | short_volume, short_exempt_volume, total_volume |
| `openbb_sec_filings` | (accession_number, symbol) | cik, form_type, filing_date, report_date null, url, description |
| `openbb_sec_insider_trades` | (accession_number, row_number) | symbol, filing_date, transaction_date null, owner_name, owner_title null, transaction_code null, shares null, price null, shares_after null, acquired_disposed (`A`/`D`/null), url null |
| `openbb_sec_ftd` | (settlement_date, symbol) | cusip, quantity, price null |
| `openbb_sec_13f_holdings` | (filer_cik, period_ending, cusip, option_type) | symbol null (indexed; ticker from the fetcher's verified CUSIP map of the universe), filer_name, issuer, asset_class null, shares null, value (dollars), weight null, accession_number null and filed_on null (0086; null on rows stored before it); option_type is `put`, `call` or `''`; index on cusip |
| `openbb_sec_13f_filings` (0086) | (accession_number) | filer_cik, filer_name, period_ending, filed_on, rows; one row per fully stored 13F-HR book (openbb.ingest stores it only when the stored holdings count of the accession equals `rows`) |
| `openbb_cusip_symbols` (0086) | (cusip, symbol) | last_seen (newest settlement date; the upsert keeps the greater); from the SEC fails-to-deliver files, seeded from `openbb_sec_ftd` |
| `openbb_congress_trades` (0085) | (chamber, doc_id, row_number) | member, filed_on, holder null, ticker null, asset, asset_type null, transaction_type, transaction_date null, amount_label, amount_low null, amount_high null, first_seen_at (default now(), not updated on conflict) |
| `openbb_congress_filings` (0085) | (chamber, doc_id) | member, state_district null, filed_on, url, status (`parsed`/`unparsed`), reason null, row_count, parser_version, amends, first_seen_at (as above) |
| `openbb_sec_form4_filings` (0089) | (accession_number) | index_day, form_type (`4`/`4/A`), status, reason null, accepted_at null, issuer_cik null, issuer_name null, issuer_symbol null, period_of_report null, plan_10b5_1 null, row_count, parser_version, url, first_seen_at |
| `openbb_sec_form4_transactions` (0089) | (accession_number, row_number) | derivative, security_title, transaction_date null, transaction_code null, acquired_disposed null, shares null, price null, shares_after null, direct_indirect null, first_seen_at |
| `openbb_sec_form4_owners` (0089) | (accession_number, owner_cik) | owner_name, is_director, is_officer, is_ten_percent_owner, is_other, officer_title null, first_seen_at |
| `openbb_sec_form4_index_days` (0089) | (index_day) | entries_listed, entries_done, complete, updated_at |
| `openbb_factor_returns` | (date, frequency, factor) | frequency `daily`/`monthly`, factor (`mkt_rf` `smb` `hml` `rmw` `cma` `rf` `mom`), value percent |

## API (packages/api/src/contracts/openbb.ts)

Writes (operator + agent API key, like `sectorRotation.collect`):

- `openbb.ingest` input `{ job, batch }` (BAD_REQUEST when the job does not write that table, per the
  Jobs table, `OPENBB_JOB_TABLES`, or when a vol index point is refused) where `batch` is a discriminated union on `table`
  (`daily_series`, `vx_curve`, `option_iv_daily`, `option_iv_term`, `cot_positions`, `macro_points`,
  `event_calendar`, `finra_otc_weekly`, `short_interest`, `short_volume_daily`, `sec_filings`,
  `sec_insider_trades`, `sec_ftd`, `sec_13f_holdings`, `sec_13f_filings`, `cusip_symbols`, `factor_returns`) with `rows` (1..2,000).
  `option_iv_daily` accepts legacy rows without `source` and stores them as `unknown`; new Python producer rows require `cboe` or `yahoo_fallback`.
  `macro_points` rows carry `{seriesId, date, value, source, name, unit, frequency}`; the server
  upserts `openbb_macro_series` from them. `daily_series` rows carry `{seriesId, date, open, high,
  low, close, adjClose}` (`adjClose` may be absent: null) and go through the market daily series
  repository (`upsertPoints`; a vol index id passes `createIfMissing: true` with kind `index`,
  source `cboe`; a `daily-prices` id passes `createIfMissing: false` with its kind and the
  `daily-prices` source and is refused with `BAD_REQUEST` when missing). A job may send only
  its own ids. `daily_bars` rows carry `{symbol, date, open, high, low, close, volume}` and go
  through the market bars repository (`appendBars`, timeframe `1d`). Output `{ table, received, written }`; for `daily_series`, `written` counts the points
  stored (an imported series takes only dates after its `last_date`).
- `openbb.dailyPricesState` input `{}`: the stored last rows of the price series and the `1d` bar
  series (daily-prices tick only).
- `openbb.form4State` input `{ from, to }` (at most 400 days): complete index days, done accessions and
  `layout_unknown` accessions with their parser version of the incomplete days (sec-form4 tick only).
- `openbb.recordRun` input `{ job, startedAt, finishedAt, status, rowsReceived, rowsWritten, warnings, error, openbbVersion }`.
  Status (set by tick.ts): `failed` when the fetcher exits non-zero, prints a document that fails the
  schema or answers another job, or every ingest chunk fails; `partial` when the document has warnings
  or some chunks fail; `blocked_upstream` when the document has `blocked` and no rows (`error` is then
  `HTTP <code> from <host>`); else `ok`. tick.ts exits 0 for ok, warnings-only partial and
  blocked_upstream, 1 for any failed chunk or failed recordRun, 2 for bad arguments. A job whose
  sources are all blocked therefore does not fail `vertex-openbb.service`.
  Blocked streak: the newest recorded runs of a job that are all `blocked_upstream`. A timer run
  (`VERTEX_OPENBB_TIMER=1`) first reads `openbb.status`; while the job is in a blocked streak and the
  retry time (minus a 5-minute tolerance) is not reached, it prints `skip: blocked upstream (...)`,
  records nothing and exits 0. The retry time is 1 hour after the start of the newest blocked run when
  the streak has 1 run and 6 hours when it has 2 or more (`openbbBlockedRetryAt`). A manual run always
  tries and does not read the status. If the status read fails, the run tries. The streak is counted in
  7-day periods from its start: the first timer run of each later period records the run and exits 1,
  so a lasting block or a wrong URL is seen as a failed unit one time each 7 days. A manual blocked run, or a
  timer run whose status read failed, earlier in the same period moves the exit 1 to the next period. `--window <days>@<HH:MM>-<HH:MM>` (New York time,
  days `mon-fri`, `daily` or a list like `fri,sat`; start inclusive, end exclusive) prints
  `skip: outside window` and exits 0 outside it. The agent key is not passed to the Python process.

Reads (operator, read-only):

- `openbb.status`: per job last run and status, per-source overdue evaluation (`checkedAt`,
  `overdueCount`, `sources[]` covering all 23 `OPENBB_JOBS` via `OPENBB_JOB_METADATA` plus QuantVPS
  flow sources via `FLOW_SOURCE_METADATA`, with `market_premium` read from
  `flow_market_premium_sessions` and the remaining 5 flow sources read from SPY `flow_samples`),
  per table newest date and row count, and nullable `lastFallbackAt`. The newest run of a job in a blocked streak has
  `blocked: { since, attempts, nextRetryAt }`; every other run has `blocked: null`.
- `openbb.changes13f` `{ change?, limit?, ticker? }`: market-wide quarter-over-quarter 13F changes
  (new, added, reduced or sold; unchanged omitted) across tracked filers' two newest consecutive
  full 13F-HR books, ordered by max(value, previousValue) desc, with matched `symbol` from the
  holding or newest `openbb_cusip_symbols` entry and `sec-13f` coverage (`overdue`, `overdueSince`,
  `filersWithTwoBooks`, `totalFilers`).
- `openbb.checkSourceOverdue` `{ dryRun? }` and `openbb.recordSourceOverdueChat`
  `{ eventId, delivery }` (scheduler, agent write key): QuantVPS 15-minute overdue alert check
  (`infra/openbb-overdue/quantvps/vertex-openbb-overdue.timer`, `scripts/openbb-overdue/tick.ts`)
  monitoring the 22 non-retired OpenBB jobs + `flow:market_premium` via `price_freshness_state`
  (`monitor = "openbb-overdue"`), sending one alert per incident via `sendPriceAlertsNtfy` (with
  `#omp-alerts` fallback outbox) and one recovery notice when all overdue sources catch up.
- `openbb.volContext` `{ asOf? }`: latest vol index closes (within 30 calendar days of `asOf`) with
  VIX9D/VIX, VIX/VIX3M, VIX3M/VIX6M ratios (null unless both closes are from the same session, like
  the DSL's `termRatioSeries`), VX curve (latest and 5 sessions earlier), Core 7 IV daily rows
  (`ivDaily`, whose `ivPercentile` of `atm_iv_30d` requires a full 252-session window, else null,
  and each returned daily row also has `historyState`, derived from those same 252 stored rows,
  including rows with null IV; raw row source is not returned), labelled 1-year IV percentile and IV
  rank per Core 7 ETF (`ivOneYear`), and the term rows of the latest date.
  `historyState` is `affected` when any selected row is `yahoo_fallback`, `clean` only when the
  non-empty sample is all `cboe`, and `source_unverified` otherwise, including legacy rows without
  proven source. An underlying with no stored daily rows has no `ivDaily` result or history state.
  This field does not change the IV values or percentile.
  Each `ivOneYear` entry evaluates two independent 252-session bases without mixing them:
  `own` (`openbb_option_iv_daily.atm_iv_30d`, decimal) and `proxy` (the Cboe volatility index in
  `market_daily_series`: `SPY -> VIX`, `QQQ -> VXN`, `DIA -> VXD`, `IWM -> RVX`, `GLD -> GVZ`,
  `SLV -> VXSLV`, `USO -> OVX`, vol points, loaded over a 420-day lookback and sliced to the newest
  252 sessions). Selection picks `own_atm_iv` once own history reaches 252 valid sessions, else
  `vol_index_proxy` while the proxy has 252 sessions, else `basis: null` with combined reasons.
  IV percentile = 100 x (window values strictly below the latest) / (window values - 1);
  IV rank = clamped 100 x (latest - min) / (max - min) (null with reason on a flat range).
  Below 252 valid sessions, a basis returns `ivPercentile: null`, `ivRank: null`, and a `reason`.
- `openbb.ivHistory` `{ symbol, sessions?: 63|126|252|504 (default 252), asOf? (>= 1900-01-01) }`:
  daily rolling 252-session IV rank (0–100, null when flat) and IV percentile (0–100) history for
  one ticker, reusing the exact window math and strict basis separation of `openbb.volContext`.
  Selects `own_atm_iv` once own contiguous rolling history covers `requestedSessions` (or when no
  proxy exists), otherwise selects the mapped Cboe `vol_index_proxy` (`market_daily_points`,
  Core 7 ETFs only) so multi-month history does not collapse on day 252 of own collection, else
  returns `basis: null` with explicit combined reasons.
- `openbb.cot` `{ market?, weeks (1..520, default 52) }`: net (long - short) per category per week.
  The /markets 4-week change compares the latest report with the report 4 rows earlier for the same
  market and category (newest first), accepted only when it is 28 ± 3 days older (holiday weeks move
  the report date); else null. The page requests 8 weeks.
- `openbb.macro` `{ ids?, from? }`: series metadata and points from `from` (default today - 400 days; echoed as `from`;
  an explicit `from` before 1900-01-01 is BAD_REQUEST, as for factors).
- `openbb.events` `{ from?, to?, kinds? }` (default today-7 .. today+30; a lone `from` gets
  `to` = the later of today+30 and from+30; `from` after `to` is BAD_REQUEST).
- `openbb.shorts` `{ symbol, days (default 60) }`: short volume daily (with `shortRatio` = short / total,
  null when total is 0), short interest, OTC weekly, FTD.
- `openbb.insiderClusters` `{ days: 7|14|30 (default 7) }`: issuers with open-market purchases (code
  P, non-derivative) by at least 3 reporting persons (owners that file jointly count as one
  person) in parsed form `4` filings accepted within 10 calendar days, newest purchase inside the
  lookback; with coverage (`overdue` when no ok or partial run in 30 h, an index day before
  yesterday is incomplete, yesterday is incomplete after 10:00 ET, or no index day of the last 7
  days is complete), source and delay. A run with every day already complete is `ok` with no rows.
- `openbb.sec` `{ symbol }`: latest 25 filings, latest 50 insider trades (from the Form 4 tables), latest-period 13F rows of tracked filers, FTD,
  and `changes13f`: quarter-over-quarter change per (filer, CUSIP, option type) between each filer's two newest
  ledger books of consecutive quarters (`new`, `added`, `reduced`, `sold`, `unchanged`; shares, else value),
  with filing date, accession and `delayDays` (filing date minus quarter end).
  A later 13F batch with a null `symbol` keeps a stored one (`coalesce(excluded.symbol, symbol)`).
  13F holders match by `symbol`; rows with a null symbol fall back to the symbol's CUSIPs in
  `openbb_cusip_symbols` and its `openbb_sec_ftd` rows.
- `openbb.sec13fAccessions` `{}` (scheduler, agent write key): the newest 5,000 accessions of the 13F ledger;
  the tick passes them to `sec-13f` as `--skip-accessions` and records a failed run when the read fails.
- `openbb.factors` `{ frequency, from? }`: default `from` today - 400 days (daily) or - 10 years (monthly); echoed as `from`.

## MCP tools (read-only, existing agent-key route)

The in-app assistant (`/assistant`) does not list these tools yet: its semantic-layer eval replay keys
every recorded model call by the exact tool list, so `openbb_*` joins the assistant catalogue when that
eval is re-recorded (`ASSISTANT_DEFERRED_TOOL_PATTERN` in `assistant-runtime.ts`). Research agents get
them now over `/api/mcp`.
Defined in `packages/api/src/server/mcp.ts` (`readOnly: true`); each forwards to the read procedure of
the same name with the caller's agent key (read keys allowed; `openbb.*` is an agent-key root):

| Tool | Procedure |
| --- | --- |
| `openbb_status` | `openbb.status` |
| `openbb_vol_context` | `openbb.volContext` |
| `openbb_iv_history` | `openbb.ivHistory` (bounded to newest 63 points + horizon extremes) |
| `openbb_cot` | `openbb.cot` |
| `openbb_macro` | `openbb.macro` |
| `openbb_events` | `openbb.events` |
| `openbb_shorts` | `openbb.shorts` |
| `openbb_sec` | `openbb.sec` |
| `openbb_factors` | `openbb.factors` |
| `openbb_congress_trades` | `congressTrades.feed` (bounded to newest 50 trades) |
| `openbb_smart_money_ranking` | `smartMoney.ranking` (bounded to 50 rows) |
| `openbb_insider_clusters` | `openbb.insiderClusters` (optional `symbol`, bounded to 50 clusters) |
| `openbb_13f_changes` | `openbb.changes13f` (bounded to 50 rows, text capped at 300 chars) |

Descriptions name the sources and say the data is research input, not a trade signal. No tool
writes, and no tool places or changes orders.

## UI

- `/markets`: "Vol, positioning and macro" section: vol term strip and ratios, VX curve, Core 7 IV
  table (ATM IV 30d, 1-year IV percentile / IV rank "IV pctl / rank (1y)", labelled "1y basis" with
  own ATM IV or Cboe proxy index, session count and as-of date or unavailable reason, per-underlying
  IV history, 25-delta skew, gamma flip, call / put wall), an IV rank and percentile history chart
  (`IvRankHistoryPanel`) with Core 7 ticker tabs (`SPY`–`USO`), `3M`/`6M`/`1Y`/`2Y` horizon
  selector, 80/20 high/low IV reference bands, and 50 midpoint line (also mounted on
  `/stock/<symbol>?tab=analytics` and `/charts?symbol=<symbol>` as an independent sibling of
  `OptionsAnalyticsPanel`), COT net positioning (latest and 4-week change), macro regime table with
  as-of dates, events in the next 14 days. The three Cboe panels (vol term strip:
  `cboe-vol-indices`, VX curve: `cboe-vx-curve`, Core 7 IV: `cboe-option-iv`) read `openbb.status`
  and show `Blocked upstream: HTTP <code> from <host> since <time>. Next retry: the first ingest run
  after <time>. The rows below are from the last good run.` while their job is in a blocked streak.
  The VX curve panel names the CFE settlement file when the newest run took its rows from it.
  The Core 7 IV panel names the Yahoo option chain and its symbols when the newest run used the
  second source (`ivSourceNotice`, marker `OPENBB_YAHOO_FALLBACK_NOTE`), and shows each underlying's
  `historyState` from the sampled rows (`affected` -> "Yahoo IV in sample", `clean` -> "Cboe only",
  `source_unverified` -> "Source not verified").
- `openbb.status.lastFallbackAt`: audit timestamp (`finishedAt ?? startedAt`) of the newest
  qualifying `cboe-option-iv` run (`status = 'ok'`, `rows_written > 0`, and `note` contains
  `OPENBB_YAHOO_FALLBACK_NOTE`: `Yahoo option chain (IV: Yahoo column; greeks: Black-Scholes, rate
  4%, trailing dividend yield)`). Order by `finishedAt DESC, startedAt DESC, id DESC`. This audit
  timestamp does not identify current sample membership or clear the caveat. A carry-forward skip,
  zero-row run, incomplete write, failed run, or blocked run does not qualify. `null` means no
  qualifying run record, not clean history.
- Rollout order for the daily IV `source` column: apply migration 0095 first, then deploy the API
  that accepts payloads with and without `source`, then update the producer that sends `source`.
  An old strict API refuses the new producer payload. To roll back, roll the producer back before
  the API; run `packages/db/rollback/0096_common_mikhail_rasputin.down.sql` last. It refuses to run
  while any row has a known source.
- `/flow`: "Short and off-exchange (FINRA/SEC)" panel for SPY: daily short volume ratio, weekly
  off-exchange shares, short interest and days to cover, fails-to-deliver.
- `/smart-money`: per-source freshness strip (Options premium, Form 4, Congress House, Congress Senate, SEC 13F — no blended score), shared ticker filter, and four independent source panels: large options trades (QuantData), insider cluster buys (SEC Form 4, 7 days), Congress trades (House and Senate PTRs, 30 days, Purchases/All toggle), and 13F quarter-over-quarter changes (SEC Form 13F-HR).
- `/stock/[symbol]`: tab `filings`: SEC filings, insider trades, tracked 13F holders, 13F quarter-over-quarter changes, FTD and FINRA short data, plus three isolated smart-money sections for the symbol (large options premium 5 sessions, insider cluster buys 30 days, Congress trades 90 days).
- `/charts`: pane "OI change" under the daily candles of ES and NQ (continuous or dated contract at
  CME): one bar per trading day from `CME_ES_OI` or `CME_NQ_OI`, read with `openbb.macro` and an id
  list. The page computes the change against the trading day before; it draws no bar after a
  quarterly expiry or when the day before has no figure
  ([design](designs/futures-oi-change-bars/design.md)). The macro regime table of `/markets` lists
  the two series as whole numbers of contracts.

## Terms

OpenBB Platform is Apache-2.0 (notice kept in `services/openbb/NOTICE`). Data terms per source:
Cboe delayed data for personal, non-commercial use; CFTC, Fed, Treasury, SEC, FINRA public data
(SEC fair access: declared User-Agent, <= 10 requests/s); OECD and Ken French data library with
attribution. CME Group publishes its "Daily Volume and Open Interest" report on its public FTP
server; Vertex stores two figures per file for research and does not redistribute the file.
Paid providers are not used.
