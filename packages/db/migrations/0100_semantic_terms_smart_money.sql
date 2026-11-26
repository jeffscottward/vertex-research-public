ALTER TABLE "semantic_sql_attributes" DROP CONSTRAINT "semantic_sql_attributes_grain_check";--> statement-breakpoint
ALTER TABLE "semantic_sql_attributes" ADD CONSTRAINT "semantic_sql_attributes_grain_check" CHECK ("semantic_sql_attributes"."grain" in ('strategy', 'run_spec', 'candidate', 'request', 'monitor', 'ticker', 'filing_trade', 'issuer_cluster', 'filer_position', 'ticker_session'));--> statement-breakpoint
-- Read-only SELECT grants for the semantic-layer reader role on the 11 smart-money tables
-- (card vertex-smart-money-assistant-terms, design docs/vertex-rebuild/designs/smart-money/plan-assistant-terms.md).
-- Preserves the plain-login safety guard from 0056_semantic_layer.sql; grants SELECT only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = 'vertex_semantic_reader') THEN
    RAISE EXCEPTION 'role vertex_semantic_reader must be a plain login: no superuser, bypassrls, createrole, createdb or replication attribute and no membership in another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vertex_semantic_reader') THEN
    GRANT SELECT ON TABLE "flow_market_premium", "flow_market_premium_sessions", "openbb_congress_trades", "openbb_congress_filings", "openbb_sec_form4_filings", "openbb_sec_form4_transactions", "openbb_sec_form4_owners", "openbb_sec_13f_filings", "openbb_sec_13f_holdings", "openbb_cusip_symbols", "openbb_short_volume_daily" TO "vertex_semantic_reader";
  ELSE
    RAISE WARNING 'role vertex_semantic_reader is missing: certified smart-money SQL terms answer unknown until an operator creates it and re-runs these grants';
  END IF;
END
$$;
--> statement-breakpoint
-- Seed: five certified smart-money semantic terms (card vertex-smart-money-assistant-terms; owner picks 2026-11-11).
INSERT INTO "semantic_terms" ("id", "label", "description", "synonyms", "source", "feed_path", "mapped_columns", "unit", "params", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('large_options_premium_ranking', 'Large options premium ranking', 'Market-wide ranking of tickers by large-trade option premium (>= 100,000 USD per trade) from QuantData gainers-losers, summed over the newest 1 to 20 stored trading sessions (default 1; excludes holiday sessions with fewer than 50 tickers), sorted by net bullish premium (bullish minus bearish). Every row carries source, newest_session_date, session_status (complete or partial), as_of (capture time) and data_delay (~15 min intraday; final totals after the close). Call openbb_smart_money_ranking or openbb_status for real-time overdue state and history completeness. Research input only; not a trade instruction.', '["what is big money buying", "big money buying", "smart money options", "large options trades", "unusual options premium", "smart money ranking"]'::jsonb, 'postgres', null, '["flow_market_premium.ticker", "flow_market_premium.bullish_premium", "flow_market_premium.bearish_premium", "flow_market_premium.premium", "flow_market_premium.captured_at", "flow_market_premium_sessions.session_date", "flow_market_premium_sessions.status"]'::jsonb, 'USD', '[{"name": "sessions", "type": "number", "required": false, "description": "Number of newest stored sessions to sum (1 to 20; default 1)."}, {"name": "ticker", "type": "text", "required": false, "description": "One ticker symbol (for example NVDA or SPY). Omit for market-wide top tickers."}]'::jsonb, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('congress_trades', 'Congress trades (STOCK Act PTRs)', 'U.S. House Clerk and Senate eFD STOCK Act periodic transaction reports (parsed filings only) within a lookback window of 1 to 365 days from the newest stored parsed filing date (default 30), newest filing first. Optional ticker and member name substring filters. Every row carries source, as_of (filed_on), filing_delay_days (filed_on minus transaction_date), data_delay (members may file up to 45 days after a trade) and source_url. Call openbb_congress_trades or openbb_status for unparsed-filing counts and per-chamber overdue status. Research input only; not a trade instruction.', '["who in Congress traded", "congressional trades", "senate trades", "house trades", "politician trades", "STOCK Act"]'::jsonb, 'postgres', null, '["openbb_congress_trades.member", "openbb_congress_trades.chamber", "openbb_congress_trades.ticker", "openbb_congress_trades.transaction_type", "openbb_congress_trades.amount_label", "openbb_congress_trades.transaction_date", "openbb_congress_trades.filed_on", "openbb_congress_filings.url"]'::jsonb, 'USD', '[{"name": "ticker", "type": "text", "required": false, "description": "Ticker symbol (for example NVDA). Omit for all tickers."}, {"name": "member", "type": "text", "required": false, "description": "Substring of member name. Omit for all members."}, {"name": "days", "type": "number", "required": false, "description": "Lookback in filing days from the newest stored parsed filing date (1 to 365; default 30)."}]'::jsonb, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('insider_cluster_buys', 'Insider cluster buys (SEC Form 4)', 'Issuers where at least 3 distinct reporting-person filing signatures made open-market purchases (SEC Form 4 code P, acquired, non-derivative, excluding 4/A amendments) accepted within a 10-calendar-day window ending inside the last 1 to 90 days from the newest stored parsed Form 4 filing (default 7). Every row carries source, first_accepted_at, as_of (last_accepted_at) and data_delay (previous business day EDGAR daily index; insiders file within 2 business days of the trade). Call openbb_insider_clusters or openbb_status for transitive joint-filer union-find, per-filing EDGAR links and sec-form4 overdue state. Research input only; not a trade instruction.', '["insider cluster buys", "insider cluster buys this week", "insider buying clusters", "form 4 cluster buys", "multiple insiders buying"]'::jsonb, 'postgres', null, '["openbb_sec_form4_filings.issuer_cik", "openbb_sec_form4_filings.issuer_symbol", "openbb_sec_form4_filings.issuer_name", "openbb_sec_form4_filings.accepted_at", "openbb_sec_form4_transactions.shares", "openbb_sec_form4_transactions.price", "openbb_sec_form4_owners.owner_name"]'::jsonb, 'USD', '[{"name": "days", "type": "number", "required": false, "description": "Lookback in days from the newest stored parsed Form 4 filing (1 to 90; default 7)."}, {"name": "symbol", "type": "text", "required": false, "description": "Issuer ticker symbol. Omit for market-wide clusters."}]'::jsonb, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('institutional_13f_changes', '13F quarter-over-quarter changes (SEC Form 13F-HR)', 'Quarter-over-quarter 13F position changes (new, added, reduced or sold; unchanged excluded) across tracked filers'' two newest consecutive full SEC Form 13F-HR books, sorted by the larger of current and previous dollar value. Ticker matches the holding symbol or any SEC FTD CUSIP-to-symbol mapping. Every row carries source, period, previous_period, as_of (filed_on), delay_days (filed_on minus period) and data_delay (due 45 days after quarter end). Call openbb_13f_changes, openbb_sec or openbb_status for filer coverage and sec-13f overdue state. Research input only; not a trade instruction.', '["13F changes", "13F quarter-over-quarter changes", "institutional buying", "hedge fund 13F", "13F new positions", "13F added"]'::jsonb, 'postgres', null, '["openbb_sec_13f_filings.filer_name", "openbb_sec_13f_filings.period_ending", "openbb_sec_13f_filings.filed_on", "openbb_sec_13f_holdings.cusip", "openbb_sec_13f_holdings.symbol", "openbb_sec_13f_holdings.shares", "openbb_sec_13f_holdings.value", "openbb_cusip_symbols.symbol"]'::jsonb, 'USD', '[{"name": "ticker", "type": "text", "required": false, "description": "Ticker symbol (matched on holding symbol or SEC FTD CUSIP map). Omit for market-wide largest changes."}, {"name": "change", "type": "text", "required": false, "description": "Filter by quarter-over-quarter change kind. Omit or use all for every change except unchanged.", "options": ["all", "new", "added", "reduced", "sold"]}]'::jsonb, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('short_volume', 'Daily short volume (FINRA Reg SHO)', 'Daily FINRA Reg SHO short sale volume, short exempt volume, total volume and short_ratio_percent for one ticker over the last 1 to 365 calendar days from the newest stored FINRA session across the market (default 30; thinly-traded or delisted symbols with no recent sessions return no rows rather than stale data), newest session first. Short volume is daily short selling reported through off-exchange/reporting facilities; it is not bi-monthly short interest. Every row carries source, as_of (trading session date) and data_delay (end-of-day, typically next business morning). Call openbb_shorts or openbb_status for short interest, weekly OTC, SEC FTD and finra-short-volume overdue state. Research input only; not a trade instruction.', '["short volume", "FINRA short volume", "short ratio", "daily short volume", "Reg SHO short volume"]'::jsonb, 'postgres', null, '["openbb_short_volume_daily.symbol", "openbb_short_volume_daily.date", "openbb_short_volume_daily.short_volume", "openbb_short_volume_daily.short_exempt_volume", "openbb_short_volume_daily.total_volume"]'::jsonb, 'shares', '[{"name": "symbol", "type": "text", "required": true, "description": "Ticker symbol (for example NVDA or SPY)."}, {"name": "days", "type": "number", "required": false, "description": "Lookback in calendar days from the newest stored FINRA session (1 to 365; default 30)."}]'::jsonb, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "semantic_sql_attributes" ("id", "term_id", "grain", "description", "sql", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('large_options_premium_ranking', 'large_options_premium_ranking', 'ticker', 'Market-wide ranking of tickers by large-trade (>= 100,000 USD) option premium summed over the newest N stored trading sessions.', $sql$with chosen_sessions as (
  select s.session_date, s.status, s.captured_at
  from flow_market_premium_sessions s
  where s.status in ('complete', 'partial')
    and not (s.status = 'complete' and s.tickers < 50)
  order by s.session_date desc
  limit least(greatest(coalesce(floor($1::numeric), 1), 1), 20)::integer
),
newest as (
  select session_date as newest_session_date, status as session_status
  from chosen_sessions
  order by session_date desc
  limit 1
),
per_ticker as (
  select
    p.ticker,
    sum(p.bullish_premium)::double precision as bullish_premium_usd,
    sum(p.bearish_premium)::double precision as bearish_premium_usd,
    sum(p.bullish_premium - p.bearish_premium)::double precision as net_premium_usd,
    sum(p.premium)::double precision as total_premium_usd,
    sum(p.trade_count)::integer as trade_count,
    sum(p.volume)::bigint as volume,
    count(distinct p.session_date)::integer as sessions_present,
    max(p.captured_at) as as_of
  from flow_market_premium p
  join chosen_sessions s on s.session_date = p.session_date
  where p.filter_profile = 'premium-gte-100k.v1'
  group by p.ticker
),
ranked as (
  select
    row_number() over (order by net_premium_usd desc, total_premium_usd desc, ticker asc)::integer as rank,
    per_ticker.*
  from per_ticker
)
select
  r.rank,
  r.ticker,
  r.bullish_premium_usd,
  r.bearish_premium_usd,
  r.net_premium_usd,
  r.total_premium_usd,
  r.trade_count,
  r.volume,
  r.sessions_present,
  n.newest_session_date::text as newest_session_date,
  n.session_status,
  r.as_of,
  'QuantData gainers-losers (option trades with premium >= 100,000 USD each)'::text as source,
  'QuantData, intraday: captured about every 15 minutes while options trade; final totals after the session day'::text as data_delay
from ranked r
cross join newest n
where ($2::text is null or upper(r.ticker) = upper($2::text))
order by r.rank asc$sql$, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('congress_trades', 'congress_trades', 'filing_trade', 'Parsed House Clerk and Senate eFD STOCK Act periodic transaction report trades, newest filing first.', $sql$with anchor as (
  select max(filed_on) as newest_filed_on
  from openbb_congress_filings
  where status = 'parsed'
)
select
  t.member,
  t.chamber,
  t.ticker,
  t.asset,
  t.asset_type,
  t.transaction_type,
  t.holder,
  t.amount_label,
  t.amount_low,
  t.amount_high,
  t.transaction_date::text as transaction_date,
  t.filed_on::text as as_of,
  case when t.transaction_date is not null then (t.filed_on - t.transaction_date)::integer else null end as filing_delay_days,
  f.amends,
  f.url as source_url,
  'U.S. House Clerk and Senate eFD STOCK Act periodic transaction reports'::text as source,
  'Members may file up to 45 days after a trade; filing_delay_days shows actual delay'::text as data_delay
from openbb_congress_trades t
join openbb_congress_filings f
  on f.chamber = t.chamber and f.doc_id = t.doc_id
cross join anchor a
where f.status = 'parsed'
  and t.row_number <= f.row_count
  and a.newest_filed_on is not null
  and t.filed_on >= a.newest_filed_on - least(greatest(coalesce(floor($3::numeric), 30), 1), 365)::integer
  and ($1::text is null or t.ticker = upper($1::text))
  and ($2::text is null or t.member ilike '%' || replace(replace(replace($2::text, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\')
order by t.filed_on desc, t.transaction_date desc nulls last, t.doc_id asc, t.row_number asc$sql$, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('insider_cluster_buys', 'insider_cluster_buys', 'issuer_cluster', 'Issuers with >= 3 distinct Form 4 open-market purchase reporting-person signatures accepted within 10 calendar days.', $sql$with anchor as (
  select max(accepted_at) as newest_accepted_at
  from openbb_sec_form4_filings
  where status = 'parsed' and form_type = '4' and accepted_at is not null
),
params as (
  select least(greatest(coalesce(floor($1::numeric), 7), 1), 90)::integer as lookback_days
),
purchase_filings as (
  select
    f.accession_number,
    f.issuer_cik,
    f.issuer_symbol,
    f.issuer_name,
    f.accepted_at,
    fo.person_key,
    fo.owner_names,
    sum(coalesce(tx.shares, 0))::double precision as shares,
    sum(case when tx.shares is not null and tx.price is not null then tx.shares * tx.price else 0 end)::double precision as value_usd,
    bool_or(tx.shares is null or tx.price is null) as value_incomplete
  from openbb_sec_form4_filings f
  cross join anchor a
  cross join params p
  join openbb_sec_form4_transactions tx on tx.accession_number = f.accession_number
  join lateral (
    select
      string_agg(distinct o.owner_cik, ',' order by o.owner_cik) as person_key,
      string_agg(distinct o.owner_name, '; ' order by o.owner_name) as owner_names
    from openbb_sec_form4_owners o
    where o.accession_number = f.accession_number
    having count(*) > 0
  ) fo on true
  where a.newest_accepted_at is not null
    and f.status = 'parsed'
    and f.form_type = '4'
    and f.accepted_at is not null
    and f.accepted_at >= a.newest_accepted_at - make_interval(days => p.lookback_days + 10)
    and f.issuer_cik is not null
    and tx.row_number <= f.row_count
    and tx.transaction_code = 'P'
    and tx.acquired_disposed = 'A'
    and tx.derivative = false
  group by f.accession_number, f.issuer_cik, f.issuer_symbol, f.issuer_name, f.accepted_at, fo.person_key, fo.owner_names
),
windows as (
  select
    e.issuer_cik,
    e.issuer_symbol,
    e.issuer_name,
    e.accepted_at as last_accepted_at,
    e.accession_number as anchor_accession,
    min(w.accepted_at) as first_accepted_at,
    count(distinct w.person_key)::integer as distinct_insiders,
    count(*)::integer as filing_count,
    sum(w.shares)::double precision as total_shares,
    sum(w.value_usd)::double precision as total_value_usd,
    bool_or(w.value_incomplete) as value_incomplete,
    string_agg(distinct w.owner_names, ' | ' order by w.owner_names) as owners
  from purchase_filings e
  cross join anchor a
  cross join params p
  join purchase_filings w
    on w.issuer_cik = e.issuer_cik
   and w.accepted_at <= e.accepted_at
   and w.accepted_at >= e.accepted_at - interval '10 days'
  where e.accepted_at >= a.newest_accepted_at - make_interval(days => p.lookback_days)
  group by e.issuer_cik, e.issuer_symbol, e.issuer_name, e.accepted_at, e.accession_number
  having count(distinct w.person_key) >= 3
),
newest_per_issuer as (
  select distinct on (issuer_cik) *
  from windows
  order by issuer_cik, last_accepted_at desc, anchor_accession desc
)
select
  issuer_cik,
  issuer_symbol,
  issuer_name,
  distinct_insiders,
  filing_count,
  total_shares,
  total_value_usd,
  value_incomplete,
  first_accepted_at,
  last_accepted_at as as_of,
  owners,
  'SEC EDGAR Form 4 (daily index, every issuer; open-market code P, non-derivative, excluding 4/A)'::text as source,
  'Previous business day: EDGAR publishes the daily index after about 22:00 ET; insiders file within 2 business days of the trade'::text as data_delay
from newest_per_issuer
where ($2::text is null or issuer_symbol = upper($2::text))
order by as_of desc, total_value_usd desc, issuer_cik asc$sql$, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('institutional_13f_changes', 'institutional_13f_changes', 'filer_position', 'Quarter-over-quarter 13F position changes across tracked filers'' two newest consecutive full 13F-HR books.', $sql$with dedup_books as (
  select distinct on (filer_cik, period_ending)
    accession_number,
    filer_cik,
    filer_name,
    period_ending,
    filed_on
  from openbb_sec_13f_filings
  order by filer_cik, period_ending, filed_on asc, accession_number asc
),
ranked_books as (
  select
    dedup_books.*,
    row_number() over (partition by filer_cik order by period_ending desc) as rn
  from dedup_books
),
pairs as (
  select
    cur.filer_cik,
    cur.filer_name,
    cur.accession_number as cur_accession,
    cur.period_ending as period,
    cur.filed_on,
    prev.accession_number as prev_accession,
    prev.period_ending as previous_period
  from ranked_books cur
  join ranked_books prev
    on prev.filer_cik = cur.filer_cik
   and cur.rn = 1
   and prev.rn = 2
  where (extract(month from cur.period_ending) = 3 and extract(day from cur.period_ending) = 31 and prev.period_ending = make_date(extract(year from cur.period_ending)::integer - 1, 12, 31))
     or (extract(month from cur.period_ending) = 6 and extract(day from cur.period_ending) = 30 and prev.period_ending = make_date(extract(year from cur.period_ending)::integer, 3, 31))
     or (extract(month from cur.period_ending) = 9 and extract(day from cur.period_ending) = 30 and prev.period_ending = make_date(extract(year from cur.period_ending)::integer, 6, 30))
     or (extract(month from cur.period_ending) = 12 and extract(day from cur.period_ending) = 31 and prev.period_ending = make_date(extract(year from cur.period_ending)::integer, 9, 30))
),
cur_h as (
  select p.filer_cik, p.filer_name, p.cur_accession, p.period, p.filed_on, p.previous_period,
    h.cusip, h.option_type, h.issuer, h.symbol, h.shares, h.value
  from pairs p
  join openbb_sec_13f_holdings h
    on h.filer_cik = p.filer_cik
   and h.period_ending = p.period
   and h.accession_number = p.cur_accession
),
prev_h as (
  select p.filer_cik, p.filer_name, p.cur_accession, p.period, p.filed_on, p.previous_period,
    h.cusip, h.option_type, h.issuer, h.symbol, h.shares, h.value
  from pairs p
  join openbb_sec_13f_holdings h
    on h.filer_cik = p.filer_cik
   and h.period_ending = p.previous_period
   and h.accession_number = p.prev_accession
),
joined as (
  select
    coalesce(c.filer_cik, pr.filer_cik) as filer_cik,
    coalesce(c.filer_name, pr.filer_name) as filer_name,
    coalesce(c.cur_accession, pr.cur_accession) as accession_number,
    coalesce(c.period, pr.period) as period,
    coalesce(c.previous_period, pr.previous_period) as previous_period,
    coalesce(c.filed_on, pr.filed_on) as filed_on,
    coalesce(c.cusip, pr.cusip) as cusip,
    coalesce(c.option_type, pr.option_type) as option_type,
    coalesce(c.issuer, pr.issuer) as issuer,
    coalesce(c.symbol, pr.symbol, cm.symbol) as ticker,
    c.shares,
    pr.shares as previous_shares,
    c.value as value_usd,
    pr.value as previous_value_usd,
    case
      when pr.cusip is null then 'new'
      when c.cusip is null then 'sold'
      when c.shares is not null and pr.shares is not null then
        case when c.shares > pr.shares then 'added' when c.shares < pr.shares then 'reduced' else 'unchanged' end
      else
        case when c.value > pr.value then 'added' when c.value < pr.value then 'reduced' else 'unchanged' end
    end as change_kind
  from cur_h c
  full outer join prev_h pr
    on pr.filer_cik = c.filer_cik
   and pr.cusip = c.cusip
   and pr.option_type = c.option_type
  left join lateral (
    select cs.symbol
    from openbb_cusip_symbols cs
    where cs.cusip = coalesce(c.cusip, pr.cusip)
    order by cs.last_seen desc, cs.symbol asc
    limit 1
  ) cm on true
)
select
  filer_name,
  filer_cik,
  ticker,
  issuer,
  cusip,
  option_type,
  change_kind as change,
  shares,
  previous_shares,
  value_usd,
  previous_value_usd,
  period::text as period,
  previous_period::text as previous_period,
  filed_on::text as as_of,
  (filed_on - period)::integer as delay_days,
  accession_number,
  'SEC EDGAR Form 13F-HR full quarterly holdings across tracked filers (sec-13f)'::text as source,
  'SEC Form 13F-HR, due 45 days after quarter end; delay_days is filing date minus quarter end'::text as data_delay
from joined
where change_kind <> 'unchanged'
  and (
    $1::text is null
    or upper(ticker) = upper($1::text)
    or exists (
      select 1 from openbb_cusip_symbols cs
      where cs.cusip = joined.cusip and cs.symbol = upper($1::text)
    )
  )
  and ($2::text is null or $2::text = 'all' or change_kind = $2::text)
order by greatest(coalesce(value_usd, 0), coalesce(previous_value_usd, 0)) desc, filer_cik asc, cusip asc, option_type asc$sql$, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('short_volume', 'short_volume', 'ticker_session', 'Daily FINRA Reg SHO short sale volume and short ratio for one ticker.', $sql$with anchor as (
  select max(date) as newest_date from openbb_short_volume_daily
)
select
  s.symbol,
  s.date::text as as_of,
  s.short_volume,
  s.short_exempt_volume,
  s.total_volume,
  case when s.total_volume > 0 then round((s.short_volume::numeric / s.total_volume::numeric) * 100, 2)::double precision else null end as short_ratio_percent,
  'FINRA Reg SHO daily short sale volume (off-exchange / reporting facilities; not short interest)'::text as source,
  'End-of-day: FINRA publishes daily Reg SHO short volume files after market close (typically next business morning)'::text as data_delay
from openbb_short_volume_daily s
cross join anchor a
where a.newest_date is not null
  and upper(s.symbol) = upper($1::text)
  and s.date >= a.newest_date - least(greatest(coalesce(floor($2::numeric), 30), 1), 365)::integer
order by s.date desc$sql$, true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "semantic_relationships" ("id", "from_table", "from_column", "to_table", "to_column", "cardinality", "description", "certified", "certified_at", "certified_by", "certification_note") VALUES
  ('flow_market_premium_session', 'flow_market_premium', 'session_date', 'flow_market_premium_sessions', 'session_date', 'many_to_one', 'Per-ticker large-trade option premium row to its QuantData session ledger entry (complete or partial).', true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('congress_trades_filing', 'openbb_congress_trades', 'doc_id', 'openbb_congress_filings', 'doc_id', 'many_to_one', 'Congressional STOCK Act trade row to its filing ledger entry (joined with chamber and doc_id; filter status = parsed and row_number <= row_count).', true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('form4_transactions_filing', 'openbb_sec_form4_transactions', 'accession_number', 'openbb_sec_form4_filings', 'accession_number', 'many_to_one', 'SEC Form 4 transaction line to its filing metadata (issuer, form_type, accepted_at, status).', true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('form4_owners_filing', 'openbb_sec_form4_owners', 'accession_number', 'openbb_sec_form4_filings', 'accession_number', 'many_to_one', 'SEC Form 4 reporting-owner row to its filing metadata (joint filers share one accession_number).', true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).'),
  ('sec_13f_holdings_filing', 'openbb_sec_13f_holdings', 'accession_number', 'openbb_sec_13f_filings', 'accession_number', 'many_to_one', 'SEC Form 13F-HR holding row to its full-book filing ledger entry (only ledger books are full quarter books).', true, now(), 'migration 0100', 'Smart-money assistant terms (owner picks 2026-11-11; card vertex-smart-money-assistant-terms, plan-assistant-terms.md).')
ON CONFLICT ("id") DO NOTHING;
