# Signal alerts and watch mode

LuxAlgo gap phase P4 (card vertex-luxalgo-p4). Research only: nothing here places orders or tells
anyone to trade.

## What it does

- **Signal and strategy alerts.** A rule compares two lines on one symbol's bars: price (close,
  open, high, low), a fixed value, an SMA or EMA, the N-bar high or low before the bar, or the
  session opening range (New York day, first N minutes). Operators: crossing up, crossing down,
  crossing either way, above, below. The page offers the built-in strategies as presets (SMA cross,
  breakout above the N-bar high, breakdown below the N-bar low, opening range breakout) and a custom
  price level. Timeframes: 5m, 15m, 1h, 1d. Futures are written as Yahoo continuous contracts (`NQ=F`,
  `ES=F`); a bare root stays a stock ticker (CL is Colgate, not crude oil). The watch parser reads
  the unambiguous roots NQ, MNQ, MES and RTY as contracts.
- **Frequencies** (LuxAlgo wording): Only once (fires on the first matching bar, then the rule is
  done), Once per bar (the forming bar may fire; each bar fires at most once), Once per bar close
  (closed bars only).
- **Backfill.** "Preview backfill" counts how often the condition held on the closed history Yahoo
  serves for that interval (5m: 30 days, 15m: 60 days, 1h: 1 year, 1d: 2 years): "Would have fired
  N times in the last D days".
- **Watch mode.** "Ask Quant to watch" turns a plain-language request into a proposed watch card
  (Quant suggests a watch, with its backfill): `Watch NQ and wake me when a 15m bar closes above the
  opening range`. The parser is deterministic (no model call): it reads the symbol after "watch",
  the timeframe, above/below, "closes" (per bar close) or "crosses"/"breaks", and a target (a number,
  the opening range, an N SMA/EMA, or the N-bar high/low). It says what is missing instead of
  guessing. Agents with an operator write key can also propose a structured watch with
  `priceAlerts.signals.propose`. A proposed watch runs only after **Start watching**; **Dismiss**
  stops it.
- **Notifications.** Every fire is stored as an event (insert-once per rule and bar) and shown under
  Recent fires. The page polls new fires every minute and, once the owner allows it, shows a
  browser/OS notification while a Vertex tab is open. A run also sends one fixed-text ntfy push per
  owner to the price alert destination (`VERTEX_PRICE_ALERTS_NTFY_*`); symbols, prices and
  conditions never leave Vertex in the push.

## Procedures (`priceAlerts.signals.*`, operator-only)

| Procedure | Who | Notes |
| --- | --- | --- |
| `list`, `events`, `backfill` | session or read key | Owner's rules, recent fires (`since` for polling), history count |
| `propose`, `dismiss`, `remove` | session or write key | At most 50 rules per owner |
| `create`, `start` | session only | Activating a rule is the owner's click; agents propose |
| `check` | session or write key | Evaluates the caller's active rules now |
| `tick` | write key only | Scheduler: up to 100 active rules of every operator owner |

A run fetches each symbol/timeframe series once (at most 20 series per run; other rules wait and
move to the back of the queue), evaluates arithmetically and never fires a bar from before the rule
existed. At most three fires per rule per run, so a long gap never floods the owner. A stored
condition that no longer parses is listed as unreadable and skipped.

## Scheduler

`bun run vertex:signal-alerts:tick` (`scripts/vertex-signal-alerts-tick.ts`, the same client as the
price alert tick) calls `priceAlerts.signals.tick` with `VERTEX_ORIGIN` and an operator write key in
`VERTEX_AGENT_API_KEY`. User units: `infra/price-alerts/vertex-signal-alerts.service` and `.timer`
(every 5 minutes, weekdays 13-21 UTC), reusing `~/.config/vertex/price-alerts.env`. Not enabled by
default.

## Storage

Migration `0049_signal_alerts` adds `signal_alert_rules` (condition as validated JSON, status
proposed/active/done/dismissed, cursor and fire counters) and `signal_alert_events` (unique by rule
and bar). Guarded rollback: `packages/db/rollback/0049_signal_alerts.down.sql` (refuses while any
rule exists).

## Not yet

- Alerts on user scripts from the quant coding agent (LuxAlgo P2) are not wired; P2 scripts are not
  merged on this line. When they land, a script output becomes another source line.
- Background web push (service worker and VAPID keys) is not set up; browser notifications need an
  open Vertex tab, and the phone push goes through ntfy.
