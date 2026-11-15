// `await tick()` ends the current turn: continuations that are already queued run first.
import { setImmediate as tick } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { runTeardown, type TeardownStep } from "./teardown.ts";

/**
 * The proxy route file as portless 0.15.12 handles it: a removal reads the file without the lock,
 * and a write leaves the file empty for a moment (truncate, then write).
 */
const fakeRouteFile = (initial: readonly string[]) => {
  let aliases: readonly string[] | "half-written" = initial;
  return {
    aliases: (): readonly string[] | "half-written" => aliases,
    remove: async (alias: string): Promise<void> => {
      await tick();
      if (aliases === "half-written" || !aliases.includes(alias)) {
        throw new Error(`No alias found for "${alias}"`);
      }
      const remaining = aliases.filter((entry) => entry !== alias);
      aliases = "half-written";
      await tick();
      aliases = remaining;
    },
  };
};

type FakeConnection = Readonly<{ end: () => Promise<void> }>;
type FakeDatabase = Readonly<{
  connect: () => FakeConnection;
  drop: () => Promise<void>;
  isDropped: () => boolean;
}>;

/** A database that refuses the drop while a connection is open, as Postgres does. */
const fakeDatabase = (): FakeDatabase => {
  let connections = 0;
  let dropped = false;
  return {
    connect: () => {
      connections += 1;
      return {
        end: async (): Promise<void> => {
          await tick();
          connections -= 1;
        },
      };
    },
    drop: async (): Promise<void> => {
      await tick();
      if (connections > 0) {
        throw new Error("database is being accessed by other users");
      }
      dropped = true;
    },
    isDropped: (): boolean => dropped,
  };
};

/** A server that holds one pooled database connection until it has closed. */
const fakeServer = (database: FakeDatabase) => {
  const connection = database.connect();
  let listening = true;
  return {
    close: async (): Promise<void> => {
      await tick();
      await connection.end();
      listening = false;
    },
    isListening: (): boolean => listening,
  };
};

describe("runTeardown", () => {
  it("resolves when there is no step", async () => {
    await expect(runTeardown([])).resolves.toBeUndefined();
  });

  it("drops the database only after the server that uses it has closed", async () => {
    const database = fakeDatabase();
    const server = fakeServer(database);
    // Registration order of the global setup: the database exists before the server starts.
    const steps: TeardownStep[] = [
      { name: "drop the test database", run: database.drop },
      { name: "close the server", run: server.close },
    ];

    await expect(runTeardown(steps)).resolves.toBeUndefined();

    expect(server.isListening()).toBe(false);
    expect(database.isDropped()).toBe(true);
  });

  it("removes two proxy aliases without a concurrent read of the half-written route file", async () => {
    const routes = fakeRouteFile(["assistant-model", "ibkr-recovery"]);
    const steps: TeardownStep[] = [
      {
        name: "remove proxy alias ibkr-recovery",
        run: () => routes.remove("ibkr-recovery"),
      },
      {
        name: "remove proxy alias assistant-model",
        run: () => routes.remove("assistant-model"),
      },
    ];

    await expect(runTeardown(steps)).resolves.toBeUndefined();

    expect(routes.aliases()).toEqual([]);
  });

  it("runs one step at a time, the last registered step first", async () => {
    const events: string[] = [];
    const step = (name: string): TeardownStep => ({
      name,
      run: async () => {
        events.push(`${name} starts`);
        await tick();
        events.push(`${name} ends`);
      },
    });

    await runTeardown([step("first"), step("second"), step("third")]);

    expect(events).toEqual([
      "third starts",
      "third ends",
      "second starts",
      "second ends",
      "first starts",
      "first ends",
    ]);
  });

  it("runs every step after a failure, also after a synchronous throw", async () => {
    const ran: string[] = [];
    const rejection = new Error("drop failed");
    const thrown = new Error("close failed");
    const steps: TeardownStep[] = [
      {
        name: "remove the run directory",
        run: () => {
          ran.push("directory");
          return Promise.resolve();
        },
      },
      {
        name: "drop the test database",
        run: () => {
          ran.push("database");
          return Promise.reject(rejection);
        },
      },
      {
        name: "close the capture server",
        run: () => {
          ran.push("capture");
          throw thrown;
        },
      },
    ];

    const failure: unknown = await runTeardown(steps).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(ran).toEqual(["capture", "database", "directory"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([thrown, rejection]);
  });

  it("names each failed step and its causes, one indented line for each message line", async () => {
    // The rejection of promisify(execFile): the message holds the command and its stderr.
    const aliasFailure = new Error(
      [
        "Command failed: node_modules/.bin/portless alias --remove assistant-model",
        "Corrupted routes file (invalid JSON): /tmp/portless/routes.json",
        'Error: No alias found for "assistant-model.localhost".',
        "",
      ].join("\n")
    );
    const dropFailure = new AggregateError(
      [
        new Error('database "e2e" is being accessed by other users', {
          cause: new Error("Connection terminated"),
        }),
      ],
      "Postgres test database cleanup failed"
    );
    const steps: TeardownStep[] = [
      { name: "remove the run directory", run: () => Promise.resolve() },
      {
        name: "drop the test database",
        run: () => Promise.reject(dropFailure),
      },
      {
        name: "close the capture server",
        run: () => Promise.reject("socket hang up"),
      },
      {
        name: "close the fake assistant model",
        run: () => Promise.reject({ code: "ERR_SERVER_NOT_RUNNING" }),
      },
      {
        name: "remove the proxy alias assistant-model",
        run: () => Promise.reject(aliasFailure),
      },
    ];

    const failure: unknown = await runTeardown(steps).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      [
        "E2E teardown failed in 4 of 5 steps",
        "- remove the proxy alias assistant-model:",
        "  Error: Command failed: node_modules/.bin/portless alias --remove assistant-model",
        "  Corrupted routes file (invalid JSON): /tmp/portless/routes.json",
        '  Error: No alias found for "assistant-model.localhost".',
        "- close the fake assistant model:",
        "  { code: 'ERR_SERVER_NOT_RUNNING' }",
        "- close the capture server:",
        "  socket hang up",
        "- drop the test database:",
        "  AggregateError: Postgres test database cleanup failed",
        '    Error: database "e2e" is being accessed by other users',
        "      Error: Connection terminated",
      ].join("\n")
    );
  });

  it("ends the report of an error whose cause chain is a cycle", async () => {
    const cyclic = new Error("loop");
    cyclic.cause = cyclic;

    const failure: unknown = await runTeardown([
      { name: "close", run: () => Promise.reject(cyclic) },
    ]).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      [
        "E2E teardown failed in 1 of 1 steps",
        "- close:",
        "  Error: loop",
        "    Error: loop",
        "      Error: loop",
        "        Error: loop",
        "          Error: loop",
      ].join("\n")
    );
  });
});
