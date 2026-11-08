# UI click log

Card `vertex-click-log` (owner request 2026-11-03). The signed-in portal records clicks and form submits so an operator can see what a user did before a problem. The data is for debugging only. It is kept 14 days.

## What is recorded

One row per event in `ui_click_events` (migration `0046_click_log`):

|Field|Meaning|
|---|---|
|`occurred_at`|Browser time of the click. A time more than 10 minutes from the server clock is replaced by the server time.|
|`received_at`|Server time of the insert. Retention uses this column.|
|`user_id`|From the session. The browser never sends it.|
|`tab_id`|Random id of one page load, so one tab's events read in order.|
|`kind`, `role`|`click` or `submit`; `button`, `link`, `menuitem`, `tab`, `option`, `checkbox`, `radio`, `switch`, `summary` or `form`.|
|`label`, `test_id`|The redacted label (see below) and the element's `data-testid`.|
|`route`, `target_route`|Path of the page; for a link, the path it opens (other sites: origin only). The browser and the server both drop query strings and hashes.|
|`important`, `request_ids`|See "Important actions".|
|`record_request_id`|Correlation id of the `clickLog.record` request that stored the row.|
|`build_sha`|The commit the browser bundle was built from (Vite define `__VERTEX_BUILD_SHA__`: `VERTEX_BUILD_SHA`, else git `HEAD`, else `unknown`). The root `bun run build` sets `VERTEX_BUILD_SHA` to `HEAD`, and `turbo.json` keys the web build cache on it, so a cache hit through `bun run build` never carries an older SHA (a bare `turbo run build` does not set it).|

## Privacy rules

- The listener records only clickable elements. Text fields, text areas, selects and editable regions are never recorded, not even as a click. The code never reads an element's `value`.
- Label order: `data-click-label`, then `aria-label`, `aria-labelledby`, the label element of a checkbox or radio, the visible text, `title`.
- Visible text (the fallback) is kept only when it has at most 5 words and 40 characters; longer text is stored as `[text]`. This is a backstop for a container that misses `data-click-private`; authored labels are not limited.
- Inside an element with `data-click-private`, only `data-click-label` is used; otherwise the label is `[private]`. Put this attribute on every list, table or form that shows text a user typed (thread titles, to-do titles and tags, basket names, campaign names, strategy and preset names, API key names, paper titles, agent task titles). The user menu trigger has `data-click-label="User menu"`.
- `redactClickText` (`packages/api/src/click-log-redaction.ts`) runs in the browser and again on the server: numbers with currency signs, separators and percent become `#`, email addresses become `[email]`, runs of 24 or more token characters that contain a digit become `[redacted]`, and the text is cut to 80 characters. Route segments of 40 or more token characters become `[redacted]`.

When you add a component that shows user-entered text inside a button, link or menu item, add `data-click-private` to its container.

## Important actions

Labels that start with Stop, Send, Approve, Reject, Confirm, Cancel, Pause, Submit, Buy, Sell, Arm or Disarm, labels that contain "order" or "liquidat", and every form submit are important. The browser holds an important event for 5 seconds and adds up to 8 correlation ids (`x-request-id`) to `request_ids`:

Limit: an id is added only when the server's response headers arrive within those 5 seconds. A slow call, or a call aborted before its headers arrive (for example Stop pressed before `assistant.send` answers), has no id in the click log. Match such events to server logs by user and time.

- the oRPC calls still open at the click (Stop ends a streamed `assistant.send` that started earlier), newest first;
- the oRPC calls that started within 3 seconds after the click (Send, order buttons, the reload after Stop). Background polling that starts in the same 3 seconds is attached too.

The same id is in the server's evlog lines and OTel spans for that request, so the event can be matched to server logs. `observeApiCalls` in `packages/api/src/client.ts` reports each call's open and close.

## Flow

1. `ClickLogListener` (`apps/web/src/features/click-log/`) is mounted by the portal shell. It uses capture-phase `click` and `submit` listeners.
2. Events are sent with `clickLog.record` in batches of at most 25: after 5 seconds, at 20 waiting events, when the page is hidden (`keepalive` request) and when the portal shell unmounts. A failed send is dropped; there is no retry.
3. `clickLog.record` takes the user from the session (agent API keys are refused), redacts again, inserts the rows and deletes rows received more than 14 days ago.
4. `clickLog.query` is operator-only (session or operator API key, read access is enough). It never returns rows received more than 14 days ago, even before the next prune.

Limit: `clickLog.record` has no per-user rate limit. Only signed-in users can write, each request holds at most 25 events, and rows expire after 14 days. Add a limit if the portal gets untrusted users.

## Query

From a repository checkout, with an operator API key:

```sh
VERTEX_ORIGIN=https://quant-vps-host.example-tailnet.ts.net:3451 VERTEX_AGENT_API_KEY=... \
  bun run vertex:clicks -- --user owner@example.test --since 2h
bun run vertex:clicks -- --user <email or user id> --from 2026-11-03T18:00:00Z --to 2026-11-03T19:00:00Z --json
```

`--since` takes `30m`, `2h` or `1d`; `--to` defaults to now; `--limit` is 1-1000 (default 500). Without `--user` it reads every user. Output: one line per event (time, user, kind, role, label, route, target, test id, request ids, important, build). Exit codes: 0 success, 2 usage error or missing setting, 1 any other failure. The key is never printed.

## Database

Migration `0046_click_log` creates `ui_click_events` (foreign key to `user` with `ON DELETE CASCADE`) and gives the app role `vertex_research` `SELECT, INSERT, DELETE`. Rollback: `packages/db/rollback/0046_click_log.down.sql` (refuses while the table has rows).

## Tests

- Redaction, record and query procedures, API call observation: `packages/api/src/click-log.test.ts`, `packages/api/src/client.test.ts`.
- Repository and migration: `packages/db/src/server/click-log.test.ts`, `packages/db/src/server/click-log-migration.test.ts`, real Postgres `tests/integration/database/click-log.test.ts`.
- Browser: `apps/web/src/features/click-log/*.test.ts(x)`.
- CLI: `scripts/click-log/query.test.ts`.
