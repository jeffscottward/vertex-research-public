import { describe, expect, it, vi } from "vitest";

import {
  type ClickLogCliIo,
  formatClickLine,
  parseClickLogArgs,
  runClickLogQuery,
} from "./query.ts";

const NOW = new Date("2026-11-03T20:00:00.000Z");
const ENV = {
  VERTEX_AGENT_API_KEY: "vrk_test_key_value",
  VERTEX_ORIGIN: "https://vertex.test/ignored/path",
};

const event = {
  buildSha: "0123456789abcdef0123",
  id: "row-1",
  important: true,
  kind: "click" as const,
  label: "Stop",
  occurredAt: new Date("2026-11-03T19:59:00.000Z"),
  receivedAt: new Date("2026-11-03T19:59:01.000Z"),
  recordRequestId: "request-0",
  requestIds: ["send-1", "reload-1"],
  role: "button" as const,
  route: "/assistant",
  tabId: "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11",
  targetRoute: null,
  testId: null,
  userEmail: "owner@example.test",
  userId: "user-1",
};

/** oRPC RPC response body for `value` (dates travel as meta-tagged strings). */
const rpcBody = (value: unknown, meta: unknown[] = []) =>
  JSON.stringify({ json: value, meta });

const io = (
  argv: string[],
  respond: (request: Request) => Promise<Response>,
  env: ClickLogCliIo["env"] = ENV
) => {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn(respond);
  return {
    err,
    fetch,
    io: {
      argv,
      env,
      fetch,
      now: () => NOW,
      stderr: { write: (text: string) => err.push(text) },
      stdout: { write: (text: string) => out.push(text) },
    } satisfies ClickLogCliIo,
    out,
  };
};

describe("parseClickLogArgs", () => {
  it("reads a relative or absolute range, user, limit and json flag", () => {
    expect(parseClickLogArgs(["--since", "2h"], NOW)).toEqual({
      from: new Date("2026-11-03T18:00:00.000Z"),
      json: false,
      limit: 500,
      to: NOW,
    });
    expect(
      parseClickLogArgs(
        [
          "--from",
          "2026-11-03T00:00:00Z",
          "--to",
          "2026-11-03T01:00:00Z",
          "--user",
          "owner@example.test",
          "--limit",
          "10",
          "--json",
        ],
        NOW
      )
    ).toEqual({
      from: new Date("2026-11-03T00:00:00.000Z"),
      json: true,
      limit: 10,
      to: new Date("2026-11-03T01:00:00.000Z"),
      user: "owner@example.test",
    });
    expect(parseClickLogArgs(["--since", "30m"], NOW).from).toEqual(
      new Date("2026-11-03T19:30:00.000Z")
    );
    expect(parseClickLogArgs(["--since", "1d"], NOW).from).toEqual(
      new Date("2026-11-02T20:00:00.000Z")
    );
  });

  it("rejects bad usage", () => {
    for (const argv of [
      [],
      ["--since", "2h", "--from", "2026-11-03T00:00:00Z"],
      ["--since", "two hours"],
      ["--from", "yesterday"],
      ["--since", "2h", "--to", "later"],
      ["--since", "2h", "--limit", "0"],
      ["--since", "2h", "--limit", "1.5"],
      ["--since", "2h", "--limit", "5000"],
      ["--since", "2h", "--bogus"],
    ]) {
      expect(() => parseClickLogArgs(argv, NOW)).toThrow();
    }
  });
});

describe("formatClickLine", () => {
  it("shows one event per line without hiding request ids", () => {
    expect(formatClickLine(event)).toBe(
      '2026-11-03T19:59:00.000Z  owner@example.test  click  button  "Stop"  /assistant  -  -  req=send-1,reload-1  important  build=0123456789ab'
    );
    expect(
      formatClickLine({
        ...event,
        important: false,
        requestIds: [],
        targetRoute: "/dashboard",
        testId: "nav-dashboard",
        userEmail: null,
      })
    ).toBe(
      '2026-11-03T19:59:00.000Z  user-1  click  button  "Stop"  /assistant  -> /dashboard  testid=nav-dashboard  -  -  build=0123456789ab'
    );
  });
});

describe("runClickLogQuery", () => {
  const ok = async () =>
    new Response(
      rpcBody(
        {
          events: [
            {
              ...event,
              occurredAt: event.occurredAt.toISOString(),
              receivedAt: event.receivedAt.toISOString(),
            },
          ],
          truncated: true,
        },
        [
          [1, "events", 0, "occurredAt"],
          [1, "events", 0, "receivedAt"],
        ]
      ),
      { headers: { "content-type": "application/json" } }
    );

  it("calls clickLog.query with the operator key and prints lines", async () => {
    const run = io(["--since", "1h", "--user", "owner@example.test"], ok);
    await expect(runClickLogQuery(run.io)).resolves.toBe(0);
    const request = run.fetch.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://vertex.test/api/orpc/clickLog/query");
    expect(request?.headers.get("x-api-key")).toBe("vrk_test_key_value");
    expect(request?.headers.get("origin")).toBe("https://vertex.test");
    expect(run.out.join("")).toContain('"Stop"');
    expect(run.out.join("")).toContain("1 event(s) (truncated");
    expect(run.out.join("") + run.err.join("")).not.toContain(
      "vrk_test_key_value"
    );
  });

  it("prints JSON on request and an untruncated count", async () => {
    const json = io(["--since", "1h", "--json"], ok);
    await expect(runClickLogQuery(json.io)).resolves.toBe(0);
    expect(JSON.parse(json.out.join(""))).toMatchObject({ truncated: true });

    const empty = io(
      ["--since", "1h"],
      async () =>
        new Response(rpcBody({ events: [], truncated: false }), {
          headers: { "content-type": "application/json" },
        })
    );
    await expect(runClickLogQuery(empty.io)).resolves.toBe(0);
    expect(empty.out.join("")).toBe("0 event(s)\n");
  });

  it("returns 2 for usage errors and missing settings, 1 for server failures", async () => {
    const usage = io([], ok);
    await expect(runClickLogQuery(usage.io)).resolves.toBe(2);
    expect(usage.err.join("")).toContain("usage:");

    const missing = io(["--since", "1h"], ok, { VERTEX_ORIGIN: " " });
    await expect(runClickLogQuery(missing.io)).resolves.toBe(2);
    expect(missing.err.join("")).toContain("VERTEX_ORIGIN is required");

    const noKey = io(["--since", "1h"], ok, {
      VERTEX_ORIGIN: "https://vertex.test",
    });
    await expect(runClickLogQuery(noKey.io)).resolves.toBe(2);

    const failed = io(["--since", "1h"], async () => {
      throw new Error("network down");
    });
    await expect(runClickLogQuery(failed.io)).resolves.toBe(1);
    expect(failed.err.join("")).toContain("click log query failed");

    const thrown = io(["--since", "1h"], () => Promise.reject("plain failure"));
    await expect(runClickLogQuery(thrown.io)).resolves.toBe(1);
  });
});
