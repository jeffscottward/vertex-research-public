// UI click log reader (card vertex-click-log). Reads clicks through the operator-only oRPC
// procedure clickLog.query with an operator agent API key (read access is enough).
// Usage: VERTEX_ORIGIN=https://vertex.example VERTEX_AGENT_API_KEY=... \
//   bun run vertex:clicks -- [--user <email|user id>] (--since 2h | --from <ISO>) [--to <ISO>] [--limit N] [--json]
// The key is never printed. Exit codes: 0 success, 2 usage error, 1 any other failure.
import { parseArgs } from "node:util";

import {
  CLICK_LOG_QUERY_LIMIT_MAX,
  type ClickLogEvent,
} from "@darkfactory/api";
import { createApiClient } from "@darkfactory/api/client";

export type ClickLogCliIo = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetch: (request: Request) => Promise<Response>;
  now: () => Date;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

class UsageError extends Error {}

const USAGE =
  "usage: vertex:clicks -- [--user <email|id>] (--since <N>m|h|d | --from <ISO>) [--to <ISO>] [--limit N] [--json]";
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

const parseSince = (value: string, now: Date): Date => {
  const match = /^(\d{1,4})([mhd])$/u.exec(value);
  if (match === null)
    throw new UsageError("--since must look like 30m, 2h or 1d");
  const unit = match[2] as keyof typeof UNIT_MS;
  return new Date(now.getTime() - Number(match[1]) * UNIT_MS[unit]);
};

const parseTime = (name: string, value: string): Date => {
  const time = new Date(value);
  if (Number.isNaN(time.getTime()))
    throw new UsageError(`${name} must be an ISO time`);
  return time;
};

export type ClickLogCliQuery = Readonly<{
  from: Date;
  to: Date;
  limit: number;
  user?: string;
  json: boolean;
}>;

export const parseClickLogArgs = (
  argv: readonly string[],
  now: Date
): ClickLogCliQuery => {
  const options = {
    from: { type: "string" },
    json: { type: "boolean" },
    limit: { type: "string" },
    since: { type: "string" },
    to: { type: "string" },
    user: { type: "string" },
  } as const;
  const parse = () => {
    try {
      return parseArgs({ args: [...argv], options, strict: true });
    } catch (error) {
      throw new UsageError(String(error));
    }
  };
  const { from, json, limit, since, to, user } = parse().values;
  const oneOf = "give exactly one of --from or --since";
  let start: Date | undefined;
  if (since !== undefined && from === undefined) start = parseSince(since, now);
  if (from !== undefined && since === undefined)
    start = parseTime("--from", from);
  if (start === undefined) throw new UsageError(oneOf);
  const end = to === undefined ? now : parseTime("--to", to);
  const count = limit === undefined ? 500 : Number(limit);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > CLICK_LOG_QUERY_LIMIT_MAX
  )
    throw new UsageError(`--limit must be 1-${CLICK_LOG_QUERY_LIMIT_MAX}`);
  return {
    from: start,
    json: json === true,
    limit: count,
    to: end,
    ...(user === undefined ? {} : { user }),
  };
};

const required = (
  env: ClickLogCliIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new UsageError(`${name} is required`);
  return value;
};

/** One readable line per event: time, user, kind, role, label, route, target, request ids, build. */
export const formatClickLine = (event: ClickLogEvent): string =>
  [
    event.occurredAt.toISOString(),
    event.userEmail ?? event.userId,
    event.kind,
    event.role,
    JSON.stringify(event.label),
    event.route,
    event.targetRoute === null ? "-" : `-> ${event.targetRoute}`,
    event.testId === null ? "-" : `testid=${event.testId}`,
    event.requestIds.length === 0 ? "-" : `req=${event.requestIds.join(",")}`,
    event.important ? "important" : "-",
    `build=${event.buildSha.slice(0, 12)}`,
  ].join("  ");

/** Runs the reader and returns the process exit code. */
export const runClickLogQuery = async (io: ClickLogCliIo): Promise<number> => {
  try {
    const query = parseClickLogArgs(io.argv, io.now());
    const origin = new URL(required(io.env, "VERTEX_ORIGIN")).origin;
    const apiKey = required(io.env, "VERTEX_AGENT_API_KEY");
    const client = createApiClient({
      baseUrl: origin,
      fetch: (request) => {
        request.headers.set("origin", origin);
        request.headers.set("x-api-key", apiKey);
        return io.fetch(request);
      },
    });
    const result = await client.clickLog.query({
      from: query.from.toISOString(),
      limit: query.limit,
      to: query.to.toISOString(),
      ...(query.user === undefined ? {} : { user: query.user }),
    });
    if (query.json) {
      io.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const event of result.events)
        io.stdout.write(`${formatClickLine(event)}\n`);
      io.stdout.write(
        `${result.events.length} event(s)${result.truncated ? " (truncated: raise --limit or narrow the range)" : ""}\n`
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`click log query failed: ${message}\n`);
    if (error instanceof UsageError) {
      io.stderr.write(`${USAGE}\n`);
      return 2;
    }
    return 1;
  }
};
