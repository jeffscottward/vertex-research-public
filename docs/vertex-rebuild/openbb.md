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

## Fetcher CLI (services/openbb)

`python -I -m vertex_openbb <job> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--symbols A,B] [--filers CIK,CIK]`

- Output: stdout, one JSON document `{"schemaVersion": "openbb-batch.v1", "job": "<job>",
  "openbbVersion": "<openbb-core version>", "tables": [{"table": "<table>", "rows": [...]}],
  "warnings": ["..."]}`. Row keys are camelCase and match the Zod row schemas below exactly. Dates are
  `YYYY-MM-DD`, numbers are JSON numbers or null, never NaN or Infinity.
- Exit codes: 0 ok (warnings allowed, including a partial document at the deadline), 1 internal
  error, 2 bad arguments or missing/malformed SEC contact, 3 upstream failed for every source of the
  job. Errors go to stderr. No secret is printed.
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
- `--until` (optional; only `congress-house` and `congress-senate`; default today, America/New_York) ends the date window. Other jobs exit 2 with "takes no --until". Without `--since` it must not be before the default window start (today minus 21 days).
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
Treasury/OECD/FRED/FINRA/Fama-French, SEC jobs alone in stages 3-6). Each step runs the wrapper
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
Install: `infra/openbb/rig/install.sh <sha> [--enable]` (needs tick-runner and user lingering; it
waits up to 600 s for tick-runner's run lock `~/.local/state/tick-runner/vertex-openbb/run.lock` and
holds it until the files are in place, releasing it before the systemctl calls, and syncs the venv with `uv pip sync --require-hashes --only-binary :all:
--no-config`).

| Job | Source | Tables | Step: stage, every, `--window` (America/New_York), timeout | Default `--since` |
| --- | --- | --- | --- | --- |
| `cboe-vol-indices` | `index/price/historical` (cboe) | `daily_series` | 1, 1 h, `mon-fri@16:45-24:00`, 240 s | 10 days (backfill: 1990-01-01) |
| `cboe-vx-curve` | `derivatives/futures/curve` (cboe) | `vx_curve` | 1, 1 h, `mon-fri@16:30-24:00`, 180 s | today (snapshot) |
| `cboe-option-iv` | `derivatives/options/chains` (cboe) | `option_iv_daily`, `option_iv_term` | 1, 1 h, `mon-fri@16:20-21:00`, 420 s | today (snapshot) |
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

`flow.control` reads the `openbb_event_calendar` rows of kind `fomc_meeting` and source `federal_reserve` for the session date to set `session.event`; when the job has not run there is no FOMC mark, and the document says "not read" only when the read itself failed.

Vol index ids (kind `index`, source `cboe`): VIX VIX1D VIX9D VIX3M VIX6M VIX1Y VVIX SKEW VXN VXD RVX
GVZ OVX VXSLV. They go to the existing `market_daily_series` / `market_daily_points` tables, so the
strategy gates (`vixTermStructure`, `volRegime`, the DSL's min-max `ivRank`) read Cboe's own closes without a
manual import.

Provenance rule (`upsertPoints`; it and `replaceSeries` take
`pg_advisory_xact_lock(hashtextextended('market_daily_series:' || id, 0))` first): a series
missing from storage is created with source `cboe`; a series whose source is `cboe` gets a full
upsert by date; a series another source owns (a `vertex:series:import` file) keeps its source and its
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

Rates are stored in percent (OpenBB returns decimals: multiply by 100).

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
  `layout_unknown` filing is read again when the parser version changed. An index that answers 404
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

| Table | Primary key | Columns |
| --- | --- | --- |
| `openbb_ingest_runs` | `id` uuid | job, started_at, finished_at, status (`ok`/`partial`/`failed`), rows_received, rows_written, warnings text[], error text, openbb_version |
| `openbb_vx_curve` | (as_of, contract_month) | as_of date, contract_month text `YYYY-MM`, price double |
| `openbb_option_iv_daily` | (as_of, underlying) | underlying_price, atm_iv_30d, put_iv_25d_30d, call_iv_25d_30d, call_oi, put_oi, call_volume, put_volume, net_gex, gamma_flip, call_wall, put_wall, contracts |
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
| `openbb_sec_form4_filings` (0087) | (accession_number) | index_day, form_type (`4`/`4/A`), status, reason null, accepted_at null, issuer_cik null, issuer_name null, issuer_symbol null, period_of_report null, plan_10b5_1 null, row_count, parser_version, url, first_seen_at |
| `openbb_sec_form4_transactions` (0087) | (accession_number, row_number) | derivative, security_title, transaction_date null, transaction_code null, acquired_disposed null, shares null, price null, shares_after null, direct_indirect null, first_seen_at |
| `openbb_sec_form4_owners` (0087) | (accession_number, owner_cik) | owner_name, is_director, is_officer, is_ten_percent_owner, is_other, officer_title null, first_seen_at |
| `openbb_sec_form4_index_days` (0087) | (index_day) | entries_listed, entries_done, complete, updated_at |
| `openbb_factor_returns` | (date, frequency, factor) | frequency `daily`/`monthly`, factor (`mkt_rf` `smb` `hml` `rmw` `cma` `rf` `mom`), value percent |

## API (packages/api/src/contracts/openbb.ts)

Writes (operator + agent API key, like `sectorRotation.collect`):

- `openbb.ingest` input `{ job, batch }` (BAD_REQUEST when the job does not write that table, per the
  Jobs table, `OPENBB_JOB_TABLES`, or when a vol index point is refused) where `batch` is a discriminated union on `table`
  (`daily_series`, `vx_curve`, `option_iv_daily`, `option_iv_term`, `cot_positions`, `macro_points`,
  `event_calendar`, `finra_otc_weekly`, `short_interest`, `short_volume_daily`, `sec_filings`,
  `sec_insider_trades`, `sec_ftd`, `sec_13f_holdings`, `sec_13f_filings`, `cusip_symbols`, `factor_returns`) with `rows` (1..2,000).
  `macro_points` rows carry `{seriesId, date, value, source, name, unit, frequency}`; the server
  upserts `openbb_macro_series` from them. `daily_series` rows carry `{seriesId, date, open, high,
  low, close}` and go through the market daily series repository (`upsertPoints`, kind `index`,
  source `cboe`). Output `{ table, received, written }`; for `daily_series`, `written` counts the points
  stored (an imported series takes only dates after its `last_date`).
- `openbb.form4State` input `{ from, to }` (at most 400 days): complete index days, done accessions and
  `layout_unknown` accessions with their parser version of the incomplete days (sec-form4 tick only).
- `openbb.recordRun` input `{ job, startedAt, finishedAt, status, rowsReceived, rowsWritten, warnings, error, openbbVersion }`.
  Status (set by tick.ts): `failed` when the fetcher exits non-zero, prints a document that fails the
  schema or answers another job, or every ingest chunk fails; `partial` when the document has warnings
  or some chunks fail; else `ok`. tick.ts exits 0 for ok and warnings-only partial, 1 for any failed
  chunk or failed recordRun, 2 for bad arguments. `--window <days>@<HH:MM>-<HH:MM>` (New York time,
  days `mon-fri`, `daily` or a list like `fri,sat`; start inclusive, end exclusive) prints
  `skip: outside window` and exits 0 outside it. The agent key is not passed to the Python process.

Reads (operator, read-only):

- `openbb.status`: per job last run and status, per table newest date and row count.
- `openbb.volContext` `{ asOf? }`: latest vol index closes with VIX9D/VIX, VIX/VIX3M, VIX3M/VIX6M ratios
  (null unless both closes are from the same session, like the DSL's `termRatioSeries`),
  VX curve (latest and 5 sessions earlier), Core 7 IV daily rows with a 252-session IV percentile (`ivPercentile`) of `atm_iv_30d`
  when at least 20 stored sessions exist (else null), and the term rows of the latest date.
  The field is `ivPercentile` (not the DSL's min-max `ivRank`).
  IV percentile = 100 x (window values strictly below the latest) / (window values - 1), over the newest
  252 stored sessions with a value; null when the latest value is missing.
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
| `openbb_cot` | `openbb.cot` |
| `openbb_macro` | `openbb.macro` |
| `openbb_events` | `openbb.events` |
| `openbb_shorts` | `openbb.shorts` |
| `openbb_sec` | `openbb.sec` |
| `openbb_factors` | `openbb.factors` |

Descriptions name the sources and say the data is research input, not a trade signal. No tool
writes, and no tool places or changes orders.

## UI

- `/markets`: "Vol, positioning and macro" section: vol term strip and ratios, VX curve, Core 7 IV
  table (ATM IV 30d, IV percentile "IV pctl", 25-delta skew, gamma flip), COT net positioning (latest and 4-week change),
  macro regime table with as-of dates, events in the next 14 days.
- `/flow`: "Short and off-exchange (FINRA/SEC)" panel for SPY: daily short volume ratio, weekly
  off-exchange shares, short interest and days to cover, fails-to-deliver.
- `/stock/[symbol]`: tab `filings`: SEC filings, insider trades, tracked 13F holders, FTD and FINRA short data.

## Terms

OpenBB Platform is Apache-2.0 (notice kept in `services/openbb/NOTICE`). Data terms per source:
Cboe delayed data for personal, non-commercial use; CFTC, Fed, Treasury, SEC, FINRA public data
(SEC fair access: declared User-Agent, <= 10 requests/s); OECD and Ken French data library with
attribution. Paid providers are not used.
