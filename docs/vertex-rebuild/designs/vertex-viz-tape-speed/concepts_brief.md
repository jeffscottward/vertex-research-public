# Tape speed chart for ES and NQ on /flow

- **Author:** Jeff Scott Ward
- **Date:** 2026-11-22

## Overview

The operator wants to see how fast the futures tape trades and when it speeds up suddenly. The page `/flow` gets a "Tape speed" panel for ES and NQ, the two futures with a streamed tape. The panel shows trades per second and contracts per second as bars over the page window, and a mark on each burst. A burst is a second, or a run of seconds, in which the number of trades is far above the rate of the minutes before it. The data comes from the tape that the collector already reads. Research only: nothing here places, changes or cancels an order, and nothing changes arming or a risk setting.

Terms used in this brief:

- **Print:** one trade report of the tape (`[exchange second, price, size, bid, ask]`). "Trades per second" counts prints. "Contracts per second" adds their sizes.
- **Collector:** the scheduled job `flow.collect`. It runs every 60 s on the trading server and stores per-minute rows computed from the tape.
- **Ring:** the memory buffer of the service `vertex-history` that holds the newest 200,000 prints per symbol. It is the only place where single prints exist.
- **Covered second:** an exchange second for which the service says its stream was live.
- **Operator:** the signed-in user role that may read `/flow`.

## Analysis

Seven goldfish reviewers read the concept on 2026-11-22. All seven ran. Their findings, merged:

1. **What is not stored when the minute is collected is lost.** Prints exist only in the ring. The ring is empty after a service restart, and the collector never reads back more than 10 minutes. The first burst rule is a design choice that a later study must test. A store that keeps only a mean or a peak per minute cannot be used to test another rule later. Resolution: store raw counts per exchange second, and nothing that a rule computed.
2. **"Gap, not zero" needs per-second coverage.** The collector reduces the covered intervals to one count per minute, and a minute row exists only for a minute with a print. A quiet covered second and an unseen second then look the same. Resolution: the new store keeps which of the 60 seconds were covered, and it has a row for every complete minute that is covered or has a print, also with zero trades.
3. **A research chart must not be able to harm the existing tape data.** `flow_minutes` feeds the futures side of the control panel and keeps 730 days. An error thrown inside the tape read turns the whole tape sample into "unavailable", and after 10 minutes the minute rows of that time are lost. Resolution: a new table, no change to `flow_minutes`; the new write runs after the existing writes in a guarded step; a failure is reported in the sample message and changes no status.
4. **Two stores of one minute can disagree.** The minute row and the per-second row are written by separate statements. Resolution: the per-second row holds its trade total, uses a replace rule of the same kind (more trades wins), and the read procedure compares the total with the minute row. A minute that disagrees is shown as "per-second counts not recorded".
5. **A burst mark must be explainable and stable.** A mark that depends on the page window, or on a stored result of an old rule, cannot be checked. Resolution: one pure rule module with a version; the rule works on exchange seconds only and reads a fixed lead-in before the window, so one second gets the same verdict in every window; marks are computed at read time and never stored; each burst carries its measured value, its baseline and the multiple; the document says for how many seconds the rule could not be evaluated.
6. **A relative rule misfires on small counts.** With about 2 trades per second, the busiest of 60 seconds is often 6 or more by chance. Resolution: the rule needs a multiple of the baseline and an absolute floor, and it marks trades per second only. Contracts per second are shown, not marked: one large print already appears as a large trade elsewhere on the page.
7. **The screen cannot draw seconds.** The windows hold 3,600 to 23,400 seconds. Resolution: the server makes the bars. The bucket length depends on the window only (never on the screen), each bar carries its counts and covered seconds, and a burst mark belongs to the bar that holds the burst second, so a short burst stays visible.
8. **The newest minute can still change.** The collector reads the previous minute again and replaces its row when the new read holds more prints. Resolution: bursts in the newest stored minute are flagged as provisional.
9. **Strict schemas.** A new key in `flow-snapshot.v1` breaks old readers and the agent tool. Resolution: a new procedure with its own document, as the design `flow-control-signals` did.
10. **SPY and QQQ have no streamed tape, and the page opens on SPY.** A panel that is silently absent cannot be found. Resolution: for SPY and QQQ the panel shows the future of the same index group and names it in its title.
11. **Rollout on a hand-migrated database.** Resolution: the migration only adds one table; the previous app runs on the migrated database; rollback is "deploy the previous app"; the deploy steps check the table and its grants with a query, because the collector's dry run does not write.
12. **Inventive resolutions that are adopted:** counts as a by-product of the read that already happens (no second read, no service change); values per bar that merge exactly (sums add, the peak is the maximum); a missing row has one meaning, "no data".

Measurements taken for this brief (read-only, 2026-11-22):

- Trading server: 27 GB of 78 GB disk free; the app database holds 1.3 GB.
- Ring content of Friday 2026-11-20, 15:26 to 17:00 New York time (ES 199,983 prints in 5,609 covered seconds; NQ 199,984 prints in 7,828 covered seconds):
  - ES trades per second: mean 35.6, median 13, 99th percentile 257, maximum 2,740. Contracts in one second: maximum 16,104.
  - NQ trades per second: mean 25.5, median 18, 99th percentile 135, maximum 1,439.
  - 6% of the covered seconds had no print. 3 seconds per symbol had prints and no coverage.
  - With a baseline of the trailing 600 seconds, a multiple of 8 and a floor of 20 trades, the rule marks about 7 bursts per hour (ES 10 runs, NQ 14 runs in the sample). A multiple of 5 marks about 21 per hour.

## Goals vs. Non-Goals

- **In-Scope Goals:**
  - Per-second counts of trades and contracts for ES and NQ, stored with per-second coverage for every complete minute, from the collector's existing tape read.
  - A read-only procedure `flow.tapeSpeed` with the document `flow-tape-speed.v1`: bars for the page window, bursts with their evidence, the rule with its version, coverage, and the freshness of the tape.
  - A "Tape speed" panel on `/flow`: two bar charts on one time axis (trades per second, contracts per second), burst marks with a shape, a list of the bursts, gaps for time without data, text for every state.
  - One versioned burst rule in one pure module.
  - Fixtures on `/lab/flow` for every state, dark and light mode, 375 to 1440 px.
  - Documentation of the table, the rule, the deploy steps and the triage commands.
- **Out-of-Scope Non-Goals:**
  - Any order, arming, sizing or risk change. No new paid data. No change to the service `vertex-history`.
  - A live view of the present second: the stored data is 1 to 2 minutes old, and the panel says so.
  - A baseline over past sessions (it needs a session calendar and weeks of history that do not exist yet).
  - A study that tests the burst rule. The stored counts make it possible later.
  - An agent tool or a catalog term for tape speed.
  - Structured telemetry for the flow pipeline, and a request id that reaches `vertex-history`. The flow code has neither today; adding them is a separate change.
  - A stored reason code per gap. The cause of a gap is in the sample message for 14 days.

## Alternatives Weighed

- **One row per second.** Rejected by author: about 165,000 rows per trading day for both symbols and tens of millions of rows per year, every row written twice by the re-read, and a row-by-row conflict rule could mix two reads of one minute.
- **Two or three peak numbers on the `flow_minutes` row.** Rejected by author: the peak says that a fast second happened, not when or for how long, and no other rule can be tested on it later. New columns on `flow_minutes` also enter every whole-row read of that table, and the previous app would leave them stale after a rollback.
- **No new storage: bars from the per-minute mean rate that the page already has.** Rejected by author: a 3-second burst at five times the normal rate raises the minute mean by 20%, so the chart could not show the bursts that the card asks for. It also cannot tell a quiet covered minute from an unseen minute.
- **Per-second arrays as new columns of `flow_minutes`.** Rejected by author: wide rows in every existing read, and a failure of the new columns would stop the existing minute rows.
- **One transaction for the minute row and the per-second row.** Rejected by author: a missing table or grant would then stop the minute rows and the control panel. Separate guarded writes with a read-time check keep the existing data safe.
- **A new key in `flow-snapshot.v1`.** Rejected by author: the schemas are strict, so old readers and the agent tool would reject the document.
- **Bursts stored as events.** Rejected by author: every rule change would leave old marks from the old rule or need a backfill on a hand-migrated database.
- **A baseline of the same time of day over 20 sessions.** Rejected by author for this version: the streamed tape started on 2026-11-20, holidays and contract rolls are not modelled, and it adds a read over many sessions to each page reload.
- **A rule on the median of single seconds.** Rejected by author: single-second counts are small integers in a quiet market, so the median is 0 to 2 and a multiple of it marks noise. The mean rate over the trailing 10 minutes with a floor is stable.
- **Buckets chosen from the screen width.** Rejected by author: the same data would give other bars at 375 px and at 1440 px, and marks and bars could disagree.
- **Panel for ES and NQ only.** Rejected by author: the page opens on SPY, so the panel would be hidden on the default view. The group's future with its name in the title uses the existing group table.
- **A live tail read from the ring at request time.** Rejected by author: it makes every page reload depend on the service and adds a "provisional" data path. The panel is a research view of settled minutes.
- **Retention of 730 days from the start.** Rejected by author: about 0.9 GB (estimate: 0.65 kB per row, 2,760 rows per trading day) on a server with 27 GB free and no reader yet. 365 days keeps a year of sessions for the later study at about 0.45 GB; the value is one constant, and nothing is deleted before November 2027.
- **Two pull requests (storage first, panel second).** Rejected by author: the market is closed until Sunday 18:00 New York time, so one deploy before the open starts the capture with no lost session; one pull request with ordered commits needs one migration step and one deploy.
- **A server cache per window.** Rejected by author: one call reads at most 400 narrow rows once per minute per open page.

## Key Decisions & Staging for Next Steps

1. New table `flow_tape_seconds`, key (symbol, minute): 60 trade counts, 60 contract counts, a 60-character coverage mask, the trade total, the contract name and a counting-method number. A row exists for each complete minute that has a covered second or a print. Retention 365 days.
2. Replace rule: a new row replaces the stored row when it has more trades, or the same trades and at least as many covered seconds.
3. Counting is one pure function over the prints, the covered intervals and the read range. `collectTape` calls it once after its existing writes, in a guarded step. Success leaves the sample message unchanged; a failure adds a short note; the status never changes.
4. Prints of an uncovered second are stored in the counts, but the rates, the peaks and the rule use covered seconds only.
5. Rule `flow-tape-speed-rules.v1`: a covered second is a burst second when its trades are at least 8 times the mean trades per second of the trailing 600 seconds and at least 20. The rule gives no verdict when fewer than 300 of those 600 seconds are covered. Consecutive burst seconds form one burst. The numbers come from the measurement above and are the first version, not a tested signal.
6. New procedure `flow.tapeSpeed({ symbol, minutes })` for ES and NQ, operator sessions only in version 1, with the document `flow-tape-speed.v1`. The window uses the same rule as `flow.snapshot`, so both charts show the same time range.
7. Bars: 10 s for the 60-minute window, 20 s for 120 minutes, 60 s for 240 and 390 minutes (at most 391 bars: the axis has one minute more than the window, like the order flow chart). A bar has a state: counted, no data, per-second counts not recorded, or not collected yet.
8. Panel: bars show the mean rate over the covered seconds of the bucket; burst marks sit on their bar and in a list with time, trades per second, baseline and multiple. The page loads the procedure as a third independent call; its failure shows inside the panel only.
9. Deploy in the daily break (17:00 to 18:00 New York time) or on a weekend: apply the one migration file, check table and grants with a query, deploy the app, run one collector run, check the stored rows and the page. Rollback: the previous app.
10. Method choices come from the knowledge-base consult of 2026-11-22 (decision record in the job report) and from the measurement above.
