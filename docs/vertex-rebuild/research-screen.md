# Research screen

The research screen is a scheduled market and technical screen of the research catalog. It is research only: it sends no order, no alert and no notification, and no engine reads it. The design, with every rule, is in [the design document](designs/research-screen/design.md).

## What runs where

| Part | Place |
| --- | --- |
| Timer and tick script | QuantVPS: `vertex-research-screen.timer` starts `vertex-research-screen.service` every 5 minutes (`infra/research-screen/quantvps/`) |
| Slot decision, claim, price reads, screen | the web app, procedure `researchScreen.tick` (`packages/api/src/server/research-screen.ts`) |
| State | Postgres tables `research_screen_runs`, `research_screen_rows`, `research_screen_bars`, `research_screen_scheduler`, `research_screen_swinglytics` |
| Page | `/research/screen` (operators), procedure `researchScreen.status` |

Slots: 00, 04, 08, 12, 16 and 20 UTC on every day, and 09:00, 12:00, 30 minutes before the close and 2 hours after the close (New York time) on NYSE trading days.

## What the page states mean

| Scheduler state | Meaning | What to check |
| --- | --- | --- |
| Scheduler running | the last tick is at most 10 minutes old | nothing |
| Scheduler late | the last tick is 10 to 30 minutes old | a web restart or a long timer run; look again after 5 minutes |
| Scheduler silent | no tick for more than 30 minutes | the timer and the service on QuantVPS (commands below) |
| No tick yet | the timer was never installed or never reached the web app | the install step |

| Run status | Meaning |
| --- | --- |
| running | a run is in progress; the page shows "n of total" |
| completed | every report was screened |
| partial | some reports failed or were not reached before the 25-minute deadline; they are first in the next run |
| failed | no report was screened |
| interrupted | the run stopped and no tick continued it before its deadline |

A row with "No current data" keeps its last good values with their time when it has any. An action "Review entry" changes to "Watch" when its quote is older than 4 hours.

IBKR daily bars are read once per session, in the first run that starts 2 hours after the close, and stored. That run can take about 19 minutes. Every other run makes one Yahoo chart request per report.

## Commands on QuantVPS

```bash
systemctl status vertex-research-screen.timer vertex-research-screen.service
systemctl list-timers vertex-research-screen.timer
journalctl -u vertex-research-screen.service --since "1 hour ago"
```

The service prints one JSON line per tick. Exit code 0: done, nothing due, paused for a deploy, or the 28-minute wall limit. Exit code 1: the web app answered with an error. Exit code 2: no answer within 200 seconds.

A deploy does not need a stop of the timer: while the pause file of `infra/quantvps/restart-when-idle.sh` exists, the tick script makes no call, and the next timer run continues an open run.

## Install and rollback

Install, after the web build with the feature is live and the migration is applied:

1. Apply the migration file of the research screen (the file in `packages/db/migrations/` whose name ends in `research_screen.sql`) by hand with `psql -v ON_ERROR_STOP=1 --single-transaction`, as the [go-live draft queue runbook](golive-draft-queue.md) describes for its migration. Check that the 5 tables exist and that the role `vertex_research` has SELECT, INSERT and UPDATE on each.
2. Deploy the web build through `infra/quantvps/restart-when-idle.sh` ([QuantVPS web app](../../infra/quantvps/README.md)).
3. From a clean checkout of the deployed commit on the rig: `infra/research-screen/quantvps/install.sh`. It needs `/opt/vertex-autopilot/bin/node` and `/etc/vertex-autopilot/autopilot.env` on QuantVPS.

The first tick claims the newest due slot. In that first run every report reads its IBKR bars.

Rollback:

1. `systemctl disable --now vertex-research-screen.timer`
2. Restore the previous web build through the restart script.
3. Apply the down file (the file in `packages/db/rollback/` whose name ends in `research_screen.down.sql`) with `psql -v ON_ERROR_STOP=1`. It drops the 5 tables. Rows, bars and the snapshot are filled again by later runs; the history of runs is lost.

## Limits

- The calendar is a rule set that was checked against the official NYSE list for 2026 to 2028. A special closure that is not in the list of `packages/api/src/strategy-dsl-compile.ts` is treated as a trading day.
- Quotes come from Yahoo Finance and can be delayed. Bars come from IBKR where IBKR serves the instrument, else from Yahoo; each row names both sources.
- The Swinglytics panel is third-party context. It is never an input of the screen.
