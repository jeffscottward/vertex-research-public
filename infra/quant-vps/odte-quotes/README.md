# SPY 0DTE option quote collector (QuantVPS, research only)

Collects the 1-minute `BID` and `ASK` bars of each day's expiring SPY options for the noise-band 0DTE test
(card `vertex-noise-band-0dte-collect`; spec: `docs/specs/strategies/noise-band-intraday-momentum.md`,
section "0DTE quote collection"). IBKR serves an expired option only on its expiry day, so each day is
collected that evening or lost.

|File|Role|
|---|---|
|`odte_quotes.py`|`collect` one day (default today, from 16:15 ET) and `check` for missed days. Read-only IBKR: `reqContractDetails` and `reqHistoricalData` only, IB client id 187|
|`test_odte_quotes.py`|Standard-library tests with a fake IBKR source; `python-odte-quotes.test.ts` runs them in CI|
|`vertex-odte-quotes.{service,timer}`|Collector, weekdays 16:20, 17:45 and 19:00 ET (later runs resume a stopped day; a complete day is a no-op)|
|`vertex-odte-quotes-check.{service,timer}`|Weekdays 20:30 ET: one #omp-alerts notice per missed weekday of the last 7 days|
|`resolve-gateway.sh`|Writes the ib-gateway bridge address to `/run/vertex-odte-quotes/gateway` (read-only `docker inspect`)|
|`vertex-odte-quotes-pull.{service,timer}`|Rig user timer, weekdays 21:00 ET: `rsync` copy to `~/.local/share/vertex/odte-quotes/`|
|`install.sh`|Run on the rig: tests on QuantVPS, backup, install, enable the timers. Refuses 08:30-16:00 ET on weekdays|

Data: `/var/lib/vertex-odte-quotes/<YYYY-MM-DD>/` holds `status.txt` (`state=complete|no_expiry|partial`),
`manifest.csv`, `underlying.csv.gz` (SPY 1-minute `TRADES`) and one `SPY-<YYYYMMDD>-<C|P>-<strike>.csv.gz`
per contract (`epoch,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close`; epoch =
bar start, UTC seconds). Read it with `FileQuoteBook` in `services/research/strategies/noise_band_0dte.py`.

Collect a day by hand (only on that day's evening; IBKR drops the expired contracts later), as root on
QuantVPS: `systemctl start vertex-odte-quotes` collects today (from 16:15 ET). For an earlier day of the
same evening (the date is New York time), run it as the unit's own user, so the files keep one owner:
`systemd-run --wait --collect -p DynamicUser=yes -p User=vertex-odte-quotes -p StateDirectory=vertex-odte-quotes
/opt/vertex-history/venv/bin/python -I /opt/vertex-odte-quotes/odte_quotes.py collect --day YYYY-MM-DD
--gateway /run/vertex-history/gateway`. A day already `complete` is
skipped; a `partial` day resumes.

States: `complete` (every selected contract stored), `no_expiry` (no SPY option expired and SPY did not
trade: a market holiday), `partial` (stopped on an IBKR error, or SPY traded but IBKR listed no expiring
option). The check treats every weekday that is not `complete` or `no_expiry` (including no folder) as
missed, alerts once per day and records it in `alerted.txt` in the same folder.
