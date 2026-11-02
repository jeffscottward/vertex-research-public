# Price alerts

Updated: 2026-11-01. Research only. A price alert tells the owner that a watchlist symbol reached a level. It is not an instruction to trade, it places no order and it has no broker client.

## Purpose

An operator keeps price, stop and target levels for symbols on their watchlist. A rule watches one symbol for a price at or above (`above`) or at or below (`below`) a level. The role (`price`, `stop`, `target`) is a label for the owner. A scheduler tick or the "Check now" button evaluates the active rules against public Yahoo quotes. When a rule reaches its level it triggers once, stores the trigger time and price, and sends one fixed-text ntfy notification. The portal page shows which rule triggered at what price.

The idea and the Yahoo fixtures come from `trader-alerts` in [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) (MIT, see `packages/api/src/fixtures/day-trader-skill/NOTICE.md`).

## Parts

| Part | File |
| --- | --- |
| oRPC contract `priceAlerts.list`, `.create`, `.remove`, `.check`, `.tick` | `packages/api/src/contracts/price-alerts.ts` |
| Pure logic: Yahoo chart parser, touch evaluator, run planner, notification text | `packages/api/src/price-alerts.ts` |
| Procedures, quote fetch and ntfy delivery | `packages/api/src/server/price-alerts.ts` |
| Table `price_alert_rules` and repository | `packages/db/src/schema/index.ts`, `packages/db/src/server/price-alerts.ts`, migration `0040_price_alert_rules`, rollback `packages/db/rollback/0040_price_alert_rules.down.sql` |
| Portal page `/price-alerts` | `apps/web/src/app/(portal)/price-alerts/page.tsx`, `apps/web/src/components/portal/price-alerts-workspace.tsx` |
| Scheduler client | `scripts/price-alerts/tick.ts`, `bun run vertex:alerts:tick` |
| User systemd units (not enabled) | `infra/price-alerts/vertex-price-alerts.{service,timer}` |

## Rules and states

- The symbol must be on the caller's watchlist. The page offers a select of watchlist symbols; there is no free text.
- The level is a positive decimal with at most 8 fractional digits.
- An owner keeps at most 100 rules (active and triggered).
- A rule state is a typed union: `active` (with `lastCheckedAt`) or `triggered` (with `triggeredAt`, `triggerPrice` and `delivery`). The table check makes the two shapes exclusive.
- `delivery` is `sent`, `not-configured` or `failed`. It is `pending` only between the trigger and the notification result; a rule that stays `pending` means the process stopped before the result was stored.
- When the migration runs as a role other than the app role, it grants the app role `vertex_research` (if it exists) `SELECT, INSERT, UPDATE, DELETE` on `price_alert_rules`, as `0039_app_role_grants` does for older tables.
- A triggered rule stays triggered. There is no re-arm; remove the rule and create a new one.

## How one run works

1. Pick the active rules, least recently checked or attempted first: the caller's rules for `check`, or for `tick` the rules of every owner who is still an operator (active, email-verified, email on `VERTEX_OPERATOR_EMAILS`), at most 200.
2. Quote each distinct symbol once (at most 25 symbols per run, 5 requests at a time) from `https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=1d&interval=5m`. The request is a bounded GET (8 s, 2 MiB, no redirects) through `fetchBoundedJson`, and the document is schema-parsed. A symbol whose quote fails is reported in `quoteErrors`; its rules keep their window for the next run but move to the back of the queue, so a symbol that keeps failing does not block the other rules.
3. Evaluate each rule over its window. On the first check the window holds the 5-minute bars that started at or after the rule's creation, so a move from before the rule existed never counts. On later checks it holds every bar that ends after the last check, including the bar that straddles it, so a touch between two checks counts. The first bar in the window that reaches the level wins: its high for `above`, its low for `below`. Otherwise the last price decides.
4. A rule that reached its level moves to `triggered` with delivery `pending`. The update requires the `active` state, so a concurrent check and tick cannot both trigger it.
5. Each owner with a trigger gets one ntfy notification, then the delivery outcome is stored on that owner's triggered rules.
6. The other evaluated rules get `lastCheckedAt` set to the run time. This step runs after the notifications, so a failed write can only repeat an evaluation; it cannot lose a notification.

## Notifications

The message goes through `createNtfyNotificationAdapter` from `@darkfactory/notifications`. The text is fixed:

- Title: "Vertex price alert"
- Body: "A price alert rule triggered. Open Vertex to review it. This is not an instruction to trade."

Symbols, levels, prices and URLs are never put in the message. The page shows the details.

Configuration (server env, all optional):

| Variable | Meaning |
| --- | --- |
| `VERTEX_PRICE_ALERTS_NTFY_ORIGIN` | Bare https origin of the ntfy server, for example `https://ntfy.sh` |
| `VERTEX_PRICE_ALERTS_NTFY_TOPIC` | ntfy topic (letters, digits, `_`, `-`) |
| `VERTEX_PRICE_ALERTS_NTFY_TOKEN` | Optional ntfy access token |

With the origin or topic unset, rules still trigger and show on the page, with delivery `not-configured`. The topic and token stay on the server; they are never returned by an API or logged. One topic serves the deployment, so price alerts are operator-only.

## Access

All procedures require an operator (`VERTEX_OPERATOR_EMAILS`). A session operator lists, creates, removes and checks their own rules. Agent API keys may call `priceAlerts.*`: a read key may call `priceAlerts.list`; `create`, `remove`, `check` and `tick` need a write key. `tick` runs every owner's rules, so it accepts only an agent API key (the scheduler); a session operator uses `check`.

## Scheduler

`bun run vertex:alerts:tick` calls `priceAlerts.tick`. The client reads `VERTEX_ORIGIN` and `VERTEX_AGENT_API_KEY` (an operator write key) from the environment, sends one HTTP request and never prints the key.

The units in `infra/price-alerts/` are not installed or enabled. To run the tick every 5 minutes on weekdays from 13:00 to 21:55 UTC:

```sh
install -m 0600 /dev/null ~/.config/vertex/price-alerts.env   # then add VERTEX_ORIGIN and VERTEX_AGENT_API_KEY
cp infra/price-alerts/vertex-price-alerts.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vertex-price-alerts.timer
```

The service expects the checkout at `~/Github/trading/vertex-research-platform`; edit `WorkingDirectory` for another path.
