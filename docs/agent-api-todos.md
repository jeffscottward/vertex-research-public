# Agent API example: Todos

`/todos` is the owner's private to-do list (title, note, due date, tags, source URL; open first, then by due date). Each signed-in user sees only their own rows (table `todos`, migration `0030_todos`, guarded rollback `packages/db/rollback/0030_todos.down.sql`).

Agents add a to-do with an agent API key (create one on `/agents`). The key needs **write** access and its owner must be in `VERTEX_OPERATOR_EMAILS`; the to-do belongs to the key owner. A read key may call only `todos.list`. POSTs must send the app origin (CSRF gate).

```sh
curl -sS "$VERTEX_APP_URL/api/orpc/todos/create" \
  -H "x-api-key: $VERTEX_AGENT_API_KEY" \
  -H "origin: $VERTEX_APP_URL" \
  -H "content-type: application/json" \
  -d '{"json":{"title":"Check API keys","dueDate":"2026-10-30","tags":["research"],"sourceUrl":"https://example.com/item"}}'
```

Other procedures: `todos/list` (optional body `{"json":{"tag":"research"}}`), `todos/update` (`{"json":{"id":"…","status":"done"}}`), `todos/remove` (`{"json":{"id":"…"}}`).
