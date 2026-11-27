import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const driver = vi.hoisted(() => {
  type DatabaseErrorListener = (error: unknown) => void;
  interface ClientDouble {
    connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
    connection: { stream: { destroy: Mock } };
    emitError: (error: unknown) => void;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    options: unknown;
  }
  const clients: ClientDouble[] = [];
  const pools: Array<{
    options: unknown;
    end: ReturnType<typeof vi.fn>;
  }> = [];
  const databases: Array<{
    client: unknown;
    transaction: ReturnType<typeof vi.fn>;
  }> = [];
  let nextConnectionError: unknown;
  let nextEndError: unknown;
  let nextConstructionError: unknown;

  class Client {
    options: unknown;
    private readonly errorListeners: DatabaseErrorListener[] = [];
    on = vi.fn((event: string, listener: DatabaseErrorListener) => {
      if (event === "error") this.errorListeners.push(listener);
      return this;
    });
    emitError = (error: unknown): void => {
      for (const listener of this.errorListeners) listener(error);
    };
    connect = vi.fn(async () => {
      if (nextConnectionError !== undefined) {
        const error = nextConnectionError;
        nextConnectionError = undefined;
        throw error;
      }
      return;
    });
    end = vi.fn(async () => undefined);
    connection = { stream: { destroy: vi.fn() } };

    constructor(options: unknown) {
      if (nextConstructionError !== undefined) {
        const error = nextConstructionError;
        nextConstructionError = undefined;
        throw error;
      }
      this.options = options;
      if (nextEndError !== undefined) {
        this.end.mockRejectedValueOnce(nextEndError);
        nextEndError = undefined;
      }
      clients.push(this);
    }
  }

  class Pool {
    options: unknown;
    end = vi.fn(async () => undefined);

    constructor(options: unknown) {
      this.options = options;
      pools.push(this);
    }
  }
  const drizzle = vi.fn(({ client }: { client: unknown }) => {
    const database = {
      client,
      transaction: vi.fn(),
    };
    databases.push(database);
    return database;
  });
  const runMigrations = vi.fn(async () => undefined);

  const failNextConnection = (error: unknown): void => {
    nextConnectionError = error;
  };
  const failNextEnd = (error: unknown): void => {
    nextEndError = error;
  };
  const failNextConstruction = (error: unknown): void => {
    nextConstructionError = error;
  };

  const resetFailures = (): void => {
    nextConnectionError = undefined;
    nextEndError = undefined;
    nextConstructionError = undefined;
  };

  return {
    Client,
    clients,
    databases,
    drizzle,
    failNextConnection,
    failNextConstruction,
    failNextEnd,
    Pool,
    pools,
    resetFailures,
    runMigrations,
  };
});

vi.mock("pg", () => ({ Client: driver.Client, Pool: driver.Pool }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: driver.drizzle }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: driver.runMigrations,
}));

import { migrate } from "@darkfactory/db/server/migration";
import {
  createNodeDatabase,
  createRequestDatabase,
  REQUEST_DATABASE_CLOSE_TIMEOUT_MILLISECONDS,
  RequestDatabaseCapacityError,
  withTransaction,
} from "./client.ts";
import { normalizePlanetScaleSystemRoot } from "./connection-string.ts";
import {
  REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS,
  REQUEST_DATABASE_POOL_MAX_CONNECTIONS,
  REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS,
  REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS,
} from "./request-slots.ts";

const CONNECTION_STRING = "postgresql://localhost/darkfactory_test";
const PLANETSCALE_SYSTEM_ROOT_CONNECTION_STRING =
  "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system&application_name=darkfactory";
const NORMALIZED_PLANETSCALE_CONNECTION_STRING =
  "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&application_name=darkfactory";

const WORKER_DIRECT_NEGOTIATION_ERROR =
  "Cloudflare database connections do not support sslnegotiation=direct with the pinned pg driver";
const PRIVATE_CONNECTION_STRING =
  "postgresql://worker:credential-that-must-not-leak@aws.connect.psdb.cloud/darkfactory";

/** A full pool rejects only after the bounded capacity wait; fake timers skip the 2 s. */
const expectCapacityRejectionAfterWait = async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const rejected = expect(
      createRequestDatabase({ connectionString: CONNECTION_STRING })
    ).rejects.toBeInstanceOf(RequestDatabaseCapacityError);
    await vi.advanceTimersByTimeAsync(
      REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS - 1
    );
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
};

describe("database client factories", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Node.js" });
    vi.stubEnv("PGSSLNEGOTIATION", undefined);
    driver.databases.length = 0;
    driver.clients.length = 0;
    driver.pools.length = 0;
    driver.drizzle.mockClear();
    driver.runMigrations.mockClear();
    return driver.resetFailures();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    return vi.unstubAllEnvs();
  });

  describe.each([
    { create: createNodeDatabase, name: "Node pool" },
    { create: createRequestDatabase, name: "request client" },
  ])("$name runtime negotiation", ({ create }) => {
    it.each([
      "?sslnegotiation=direct",
      "?sslmode=verify-full&sslrootcert=system&sslnegotiation=direct",
      "?sslnegotiation=postgres&sslnegotiation=direct",
      "?sslnegotiation=postgres&ssl%6Eegotiation=%64irect",
      "?application_name=two words&sslnegotiation=%64irect",
      "?application_name=bad%ZZ&sslnegotiation=direct",
      "?sslnegotiation=direct#sslnegotiation=postgres",
    ])(
      "rejects effective Worker direct negotiation before construction: %s",
      async (query) => {
        vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
        await expect(async () => {
          return create({
            connectionString: PRIVATE_CONNECTION_STRING + query,
          });
        }).rejects.toThrow(new TypeError(WORKER_DIRECT_NEGOTIATION_ERROR));
        expect(driver.clients).toHaveLength(0);
        expect(driver.pools).toHaveLength(0);
        return expect(driver.drizzle).not.toHaveBeenCalled();
      }
    );

    it("rejects the pg empty-authority fallback without exposing credentials", async () => {
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      await expect(async () => {
        return create({
          connectionString:
            "postgresql://worker:credential-that-must-not-leak@/darkfactory?sslnegotiation=direct",
        });
      }).rejects.toThrow(new TypeError(WORKER_DIRECT_NEGOTIATION_ERROR));
      expect(driver.clients).toHaveLength(0);
      expect(driver.pools).toHaveLength(0);
      return expect(driver.drizzle).not.toHaveBeenCalled();
    });

    it.each([
      "postgresql://worker:credential-that-must-not-leak@[invalid/darkfactory?sslnegotiation=direct",
      PRIVATE_CONNECTION_STRING +
        "?application_name=bad \ud800&sslnegotiation=direct",
    ])(
      "redacts invalid Worker URLs before construction",
      async (connectionString) => {
        vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
        await expect(async () => {
          return create({ connectionString });
        }).rejects.toThrow(
          new TypeError("Cloudflare database connection string is invalid")
        );
        expect(driver.clients).toHaveLength(0);
        expect(driver.pools).toHaveLength(0);
        return expect(driver.drizzle).not.toHaveBeenCalled();
      }
    );

    it.each([
      "",
      "?sslmode=verify-full",
      "?sslnegotiation=postgres",
      "?sslnegotiation=direct&sslnegotiation=postgres",
      "?sslnegotiation=direct&sslnegotiation=",
      "?sslnegotiation=direct&ssl%6Eegotiation=postgres",
      "?application_name=two words&ssl%6Eegotiation=direct",
      "?application_name=sslnegotiation%3Ddirect",
      "?SSLNEGOTIATION=direct",
      "?sslnegotiation=postgres#?sslnegotiation=direct",
      "/sslnegotiation=direct",
    ])("preserves supported Worker URL configuration: %s", async (query) => {
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      const connectionString = PRIVATE_CONNECTION_STRING + query;
      const resource = await create({ connectionString });
      const transports = [...driver.clients, ...driver.pools];
      expect(transports).toHaveLength(1);
      expect(transports[0]?.options).toMatchObject({ connectionString });
      for (const client of driver.clients) {
        expect(client.connect).toHaveBeenCalledOnce();
      }
      await resource.close();
      return expect(transports[0]?.end).toHaveBeenCalledOnce();
    });

    it("retains Worker system-root normalization for postgres negotiation", async () => {
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      const resource = await create({
        connectionString:
          PLANETSCALE_SYSTEM_ROOT_CONNECTION_STRING +
          "&sslnegotiation=postgres",
      });
      expect([...driver.clients, ...driver.pools][0]?.options).toMatchObject({
        connectionString: `${NORMALIZED_PLANETSCALE_CONNECTION_STRING}&sslnegotiation=postgres`,
      });
      return await resource.close();
    });

    it.each([
      `${CONNECTION_STRING}?sslnegotiation=direct`,
      `${PLANETSCALE_SYSTEM_ROOT_CONNECTION_STRING}&sslnegotiation=direct`,
    ])(
      "preserves direct negotiation on actual Node runtimes: %s",
      async (connectionString) => {
        const resource = await create({ connectionString });
        expect([...driver.clients, ...driver.pools][0]?.options).toMatchObject({
          connectionString: normalizePlanetScaleSystemRoot(connectionString),
        });
        return await resource.close();
      }
    );

    it.each([
      CONNECTION_STRING,
      `${CONNECTION_STRING}?sslnegotiation=`,
      `${CONNECTION_STRING}?sslnegotiation=postgres&sslnegotiation=`,
      "/var/run/postgresql darkfactory",
    ])(
      "rejects Worker environment-selected direct negotiation: %s",
      async (connectionString) => {
        vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
        vi.stubEnv("PGSSLNEGOTIATION", "direct");
        await expect(async () => {
          return create({ connectionString });
        }).rejects.toThrow(new TypeError(WORKER_DIRECT_NEGOTIATION_ERROR));
        expect(driver.clients).toHaveLength(0);
        expect(driver.pools).toHaveLength(0);
        return expect(driver.drizzle).not.toHaveBeenCalled();
      }
    );

    it("allows a Worker URL to override the direct environment with postgres", async () => {
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      vi.stubEnv("PGSSLNEGOTIATION", "direct");
      const connectionString = `${CONNECTION_STRING}?sslnegotiation=postgres`;
      const resource = await create({ connectionString });
      expect([...driver.clients, ...driver.pools][0]?.options).toMatchObject({
        connectionString,
      });
      return await resource.close();
    });

    it.each([undefined, null, "not-a-navigator", {}, { userAgent: 42 }])(
      "uses pg's legacy Worker Response probe without a navigator user agent",
      async (navigatorValue) => {
        vi.stubGlobal("navigator", navigatorValue);
        class WorkerResponse {
          readonly cf = { thing: true };
        }
        vi.stubGlobal("Response", WorkerResponse);
        await expect(async () => {
          return create({
            connectionString: `${CONNECTION_STRING}?sslnegotiation=direct`,
          });
        }).rejects.toThrow(new TypeError(WORKER_DIRECT_NEGOTIATION_ERROR));
        expect(driver.clients).toHaveLength(0);
        expect(driver.pools).toHaveLength(0);
        return expect(driver.drizzle).not.toHaveBeenCalled();
      }
    );

    it.each([undefined, null, "not-cf", {}, { thing: false }])(
      "does not classify a non-Worker Response as Cloudflare",
      async (cf) => {
        vi.stubGlobal("navigator", undefined);
        class NonWorkerResponse {
          readonly cf = cf;
        }
        vi.stubGlobal("Response", NonWorkerResponse);
        const resource = await create({
          connectionString: `${CONNECTION_STRING}?sslnegotiation=direct`,
        });
        return await resource.close();
      }
    );

    it("retains Node direct negotiation without navigator or Response globals", async () => {
      vi.stubGlobal("navigator", undefined);
      vi.stubGlobal("Response", undefined);
      const resource = await create({
        connectionString: `${CONNECTION_STRING}?sslnegotiation=direct`,
      });
      return await resource.close();
    });

    it("retains Node direct negotiation when Response has no cf metadata", async () => {
      vi.stubGlobal("navigator", undefined);
      class NonWorkerResponse {
        readonly status = 200;
      }
      vi.stubGlobal("Response", NonWorkerResponse);
      const resource = await create({
        connectionString: `${CONNECTION_STRING}?sslnegotiation=direct`,
      });
      return await resource.close();
    });

    return it("uses navigator precedence rather than probing Response on Node", async () => {
      const response = vi.fn(() => {
        throw new Error("Response must not be probed");
      });
      vi.stubGlobal("Response", response);
      const resource = await create({
        connectionString: `${CONNECTION_STRING}?sslnegotiation=direct`,
      });
      expect(response).not.toHaveBeenCalled();
      return await resource.close();
    });
  });

  it("creates one private Node pool and closes it through a neutral resource", async () => {
    const resource = createNodeDatabase({
      connectionString: CONNECTION_STRING,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 12_000,
      maxConnections: 7,
    });

    expect(driver.pools).toHaveLength(1);
    expect(driver.pools[0]?.options).toEqual({
      connectionString: CONNECTION_STRING,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 12_000,
      max: 7,
    });
    expect(resource.db).toBe(driver.databases[0]);
    expect(resource).not.toHaveProperty("pool");

    await resource.close();
    return expect(driver.pools[0]?.end).toHaveBeenCalledOnce();
  });

  it.each([
    [
      PLANETSCALE_SYSTEM_ROOT_CONNECTION_STRING,
      NORMALIZED_PLANETSCALE_CONNECTION_STRING,
    ],
    [
      "postgres://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system",
      "postgres://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full",
    ],
    [
      "postgresql://worker:p%2520word@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system&application_name=dark factory%ZZ",
      "postgresql://worker:p%2520word@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&application_name=dark factory%ZZ",
    ],
    [
      "postgresql://worker:credential@aws.connect.psdb.cloud:5432/darkfactory?sslmode=verify-full&sslrootcert=system",
      "postgresql://worker:credential@aws.connect.psdb.cloud:5432/darkfactory?sslmode=verify-full",
    ],
    [
      "postgresql://worker:credential@aws-us-east-1.horizon.psdb.cloud:6432/darkfactory?sslrootcert=system&sslmode=verify-full&sslnegotiation=direct",
      "postgresql://worker:credential@aws-us-east-1.horizon.psdb.cloud:6432/darkfactory?sslmode=verify-full&sslnegotiation=direct",
    ],
  ])(
    "uses runtime system roots for %s",
    async (connectionString, normalized) => {
      expect(normalizePlanetScaleSystemRoot(connectionString)).toBe(normalized);
      const nodeResource = createNodeDatabase({ connectionString });
      const requestResource = await createRequestDatabase({ connectionString });

      expect(driver.clients[0]?.options).toEqual({
        connectionString: normalized,
        connectionTimeoutMillis: 10_000,
        query_timeout: 10_000,
      });
      expect(driver.pools[0]?.options).toEqual({
        connectionString: normalized,
      });

      await nodeResource.close();
      return await requestResource.close();
    }
  );
  it.each([
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=custom.pem",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=require&sslrootcert=system",
    "not a PostgreSQL URL?sslmode=verify-full&sslrootcert=system",
    "postgresql://worker:credential@example.com/darkfactory?sslmode=verify-full&sslrootcert=system",
    "https://aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system&sslrootcert=system",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=SYSTEM",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslmode=verify-full&sslrootcert=system",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslmode=disable&sslrootcert=system",
    "postgresql://worker:credential@aws.connect.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system&host=attacker.example",
    "postgresql://worker:credential@%2Ftmp.psdb.cloud/darkfactory?sslmode=verify-full&sslrootcert=system&query_timeout_extra=0&application_name=dark factory%ZZ",
  ])(
    "preserves non-PlanetScale system-root configuration %s",
    async (connectionString) => {
      expect(normalizePlanetScaleSystemRoot(connectionString)).toBe(
        connectionString
      );
      const nodeResource = createNodeDatabase({ connectionString });
      const requestResource = await createRequestDatabase({ connectionString });

      expect(driver.clients[0]?.options).toEqual({
        connectionString,
        connectionTimeoutMillis: 10_000,
        query_timeout: 10_000,
      });
      expect(driver.pools[0]?.options).toEqual({ connectionString });

      await nodeResource.close();
      return await requestResource.close();
    }
  );

  it.each([
    "postgresql://example.pg.psdb.cloud",
    "postgresql://example.pg.psdb.cloud/database",
    "POSTGRESQL://example.pg.psdb.cloud/database?sslmode=verify-full&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full&sslrootcert=system#fragment",
    "postgresql://example.pg.psdb.cloud:06432/database?sslmode=verify-full&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud./database?sslmode=verify-full&sslrootcert=system",
    "postgresql://psdb.cloud/database?sslmode=verify-full&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud.evil.test/database?sslmode=verify-full&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud/database?sslrootcert=system",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full&sslrootcert=./system",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full&sslrootcert=%73ystem",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full&sslroot%63ert=system",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify%2Dfull&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud/database?ssl%6Dode=verify-full&sslrootcert=system",
    "postgresql://example.pg.psdb.cloud/database?sslmode=verify-full&sslrootcert=system&sslrootcert=custom.pem",
  ])(
    "does not repair ambiguous or noncanonical connection strings %s",
    (connectionString) => {
      return expect(normalizePlanetScaleSystemRoot(connectionString)).toBe(
        connectionString
      );
    }
  );

  it.each([
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout=0",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?application_name=darkfactory&query_timeout=10000",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout=10000&query_timeout=0",
    "postgresql://worker:credential-that-must-not-leak@%2Fvar%2Frun%2Fpostgresql/darkfactory?query%5Ftimeout=0",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout=0#client-fragment",
  ])(
    "rejects request query timeout URL overrides before constructing a client",
    async (connectionString) => {
      let rejection: unknown;
      try {
        await createRequestDatabase({ connectionString });
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(TypeError);
      expect((rejection as Error).message).toBe(
        "Request database connection strings cannot set query_timeout"
      );
      expect((rejection as Error).message).not.toContain(
        "credential-that-must-not-leak"
      );
      expect(driver.pools).toHaveLength(0);
      expect(driver.clients).toHaveLength(0);
      return expect(driver.drizzle).not.toHaveBeenCalled();
    }
  );

  it.each([
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_\ntimeout=0",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_\ttimeout=0",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_\rtimeout=0",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout\u0000",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout\u001f",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?query_timeout ",
    "postgresql://worker:credential-that-must-not-leak@localhost/darkfactory?application_name=darkfactory\u000b&pool=worker",
  ])(
    "rejects raw URL controls before constructing a client",
    async (connectionString) => {
      let rejection: unknown;
      try {
        await createRequestDatabase({ connectionString });
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(TypeError);
      expect((rejection as Error).message).toBe(
        "Request database connection strings cannot contain raw URL controls"
      );
      expect((rejection as Error).message).not.toContain(
        "credential-that-must-not-leak"
      );
      expect(driver.pools).toHaveLength(0);
      expect(driver.clients).toHaveLength(0);
      return expect(driver.drizzle).not.toHaveBeenCalled();
    }
  );

  it("creates one client per production request and ends each socket on close", async () => {
    const first = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
      connectionTimeoutMillis: 3000,
    });
    const second = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
      connectionTimeoutMillis: 3000,
    });

    expect(driver.pools).toHaveLength(0);
    expect(driver.clients.map(({ options }) => options)).toEqual([
      {
        connectionString: CONNECTION_STRING,
        connectionTimeoutMillis: 3000,
        query_timeout: 10_000,
      },
      {
        connectionString: CONNECTION_STRING,
        connectionTimeoutMillis: 3000,
        query_timeout: 10_000,
      },
    ]);
    expect(driver.databases[0]?.client).toBe(driver.clients[0]);
    expect(driver.databases[1]?.client).toBe(driver.clients[1]);

    await first.close();
    await first.close();
    await second.close();
    expect(driver.clients[0]?.end).toHaveBeenCalledOnce();
    return expect(driver.clients[1]?.end).toHaveBeenCalledOnce();
  });

  it("contains production client background errors through a fixed secret-safe diagnostic", async () => {
    const diagnosticSink = vi.fn();
    const resource = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
      diagnosticSink,
    });
    const backgroundError = new Error(
      `client failed for ${CONNECTION_STRING}; select private_value`
    );

    expect(() => driver.clients[0]!.emitError(backgroundError)).not.toThrow();
    expect(driver.clients[0]!.on).toHaveBeenCalledWith(
      "error",
      expect.any(Function)
    );
    expect(driver.clients[0]!.on.mock.invocationCallOrder[0]).toBeLessThan(
      driver.clients[0]!.connect.mock.invocationCallOrder[0]!
    );
    expect(diagnosticSink).toHaveBeenCalledWith({
      code: "REQUEST_DATABASE_CLIENT_ERROR",
    });
    expect(Object.isFrozen(diagnosticSink.mock.calls[0]![0])).toBe(true);
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      CONNECTION_STRING
    );
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      "private_value"
    );

    diagnosticSink.mockImplementation(() => {
      throw new Error("diagnostic sink failed");
    });
    expect(() => driver.clients[0]!.emitError(backgroundError)).not.toThrow();
    return await resource.close();
  });

  // Workers (pg-cloudflare): after client.end() the socket read loop rejects with
  // "This socket has been closed." and pg re-emits it as a client error on every request.
  it("does not report socket errors raised by the request's own close as client failures", async () => {
    const diagnosticSink = vi.fn();
    let finishEnd!: () => void;
    const resource = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
      diagnosticSink,
    });
    const client = driver.clients[0]!;
    client.end.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishEnd = resolve))
    );
    const closing = resource.close();

    expect(() =>
      client.emitError(new TypeError("This socket has been closed."))
    ).not.toThrow();
    finishEnd();
    await closing;
    expect(() =>
      client.emitError(new TypeError("This socket has been closed."))
    ).not.toThrow();

    return expect(diagnosticSink).not.toHaveBeenCalled();
  });

  it("isolates diagnostics between concurrent request resources", async () => {
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const [first, second] = await Promise.all([
      createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink: firstSink,
      }),
      createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink: secondSink,
      }),
    ]);

    driver.clients[0]!.emitError(new Error("first private error"));
    driver.clients[1]!.emitError(new Error("second private error"));

    expect(firstSink).toHaveBeenCalledOnce();
    expect(secondSink).toHaveBeenCalledOnce();
    expect(firstSink).toHaveBeenCalledWith({
      code: "REQUEST_DATABASE_CLIENT_ERROR",
    });
    expect(secondSink).toHaveBeenCalledWith({
      code: "REQUEST_DATABASE_CLIENT_ERROR",
    });
    return await Promise.all([first.close(), second.close()]);
  });

  it("releases production capacity only after a successful close", async () => {
    const resources = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      )
    );
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      return (resolveClose = resolve);
    });
    driver.clients[0]!.end.mockReturnValueOnce(closePromise);

    await expectCapacityRejectionAfterWait();
    expect(driver.clients).toHaveLength(REQUEST_DATABASE_POOL_MAX_CONNECTIONS);

    const firstClose = resources[0]!.close();
    const concurrentClose = resources[0]!.close();
    expect(concurrentClose).toBe(firstClose);
    expect(driver.clients[0]!.end).toHaveBeenCalledOnce();
    await expectCapacityRejectionAfterWait();

    resolveClose();
    await firstClose;
    const replacement = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
    });
    expect(driver.clients).toHaveLength(
      REQUEST_DATABASE_POOL_MAX_CONNECTIONS + 1
    );
    return await Promise.all([
      ...resources.slice(1).map(({ close }) => close()),
      replacement.close(),
    ]);
  });

  it("preserves connection failures and releases admission after confirmed end", async () => {
    const connectionFailure = new Error("connection failed");
    driver.failNextConnection(connectionFailure);

    await expect(
      createRequestDatabase({ connectionString: CONNECTION_STRING })
    ).rejects.toBe(connectionFailure);
    expect(driver.clients[0]?.end).toHaveBeenCalledOnce();

    const resources = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      )
    );
    return await Promise.all(resources.map(({ close }) => close()));
  });

  it("preserves production initialization failures after confirmed client end", async () => {
    const databaseFailure = new Error("database initialization failed");
    driver.drizzle.mockImplementationOnce(() => {
      throw databaseFailure;
    });

    await expect(
      createRequestDatabase({ connectionString: CONNECTION_STRING })
    ).rejects.toBe(databaseFailure);
    expect(driver.clients[0]?.end).toHaveBeenCalledOnce();

    const replacement = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
    });
    return await replacement.close();
  });

  it("releases admission, destroys the socket, and reports secret-safe diagnostics when client end rejects", async () => {
    const diagnosticSink = vi.fn();
    const resources = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({
          connectionString: CONNECTION_STRING,
          diagnosticSink,
        })
      )
    );
    const closeFailure = new Error(
      `close failed for ${CONNECTION_STRING}; select private_close_value`
    );
    driver.clients[0]!.end.mockRejectedValueOnce(closeFailure);

    const firstClose = resources[0]!.close();
    const concurrentClose = resources[0]!.close();
    expect(concurrentClose).toBe(firstClose);
    // The dying socket's own error is not a second, CLIENT_ERROR diagnostic.
    driver.clients[0]!.emitError(new TypeError("This socket has been closed."));
    const closeResults = await Promise.allSettled([
      firstClose,
      concurrentClose,
    ]);
    expect(closeResults).toEqual([
      { reason: closeFailure, status: "rejected" },
      { reason: closeFailure, status: "rejected" },
    ]);
    const repeatedClose = resources[0]!.close();
    expect(repeatedClose).toBe(firstClose);
    await expect(repeatedClose).rejects.toBe(closeFailure);
    expect(driver.clients[0]!.end).toHaveBeenCalledOnce();
    expect(driver.clients[0]!.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(diagnosticSink).toHaveBeenCalledTimes(1);
    expect(diagnosticSink).toHaveBeenLastCalledWith({
      code: "REQUEST_DATABASE_CLIENT_CLOSE_ERROR",
    });
    const replacement = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
    });
    await expectCapacityRejectionAfterWait();

    await Promise.all(
      [...resources.slice(1), replacement].map(({ close }) => close())
    );

    const initializationFailure = new Error("database initialization failed");
    const initializationEndFailure = new Error(
      `end failed for ${CONNECTION_STRING}; select private_init_end_value`
    );
    driver.drizzle.mockImplementationOnce(() => {
      throw initializationFailure;
    });
    driver.failNextEnd(initializationEndFailure);
    await expect(
      createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink,
      })
    ).rejects.toBe(initializationFailure);
    expect(
      driver.clients[REQUEST_DATABASE_POOL_MAX_CONNECTIONS + 1]?.end
    ).toHaveBeenCalledOnce();
    expect(diagnosticSink).toHaveBeenCalledTimes(2);
    expect(diagnosticSink).toHaveBeenLastCalledWith({
      code: "REQUEST_DATABASE_CLIENT_CLOSE_ERROR",
    });

    const connectionFailure = new Error("connection failed");
    const connectEndFailure = new Error(
      `end failed for ${CONNECTION_STRING}; select private_end_value`
    );
    driver.failNextConnection(connectionFailure);
    driver.failNextEnd(connectEndFailure);
    await expect(
      createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink,
      })
    ).rejects.toBe(connectionFailure);
    expect(
      driver.clients[REQUEST_DATABASE_POOL_MAX_CONNECTIONS + 2]?.end
    ).toHaveBeenCalledOnce();
    expect(diagnosticSink).toHaveBeenCalledTimes(3);
    expect(diagnosticSink).toHaveBeenLastCalledWith({
      code: "REQUEST_DATABASE_CLIENT_CLOSE_ERROR",
    });
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      CONNECTION_STRING
    );
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      "private_close_value"
    );
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      "private_end_value"
    );
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain(
      "private_init_end_value"
    );

    const fullCapacity = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      )
    );
    await expectCapacityRejectionAfterWait();
    return await Promise.all(fullCapacity.map(({ close }) => close()));
  });

  it("hands a released slot to waiting requests in FIFO order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const resources = await Promise.all(
        Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
          createRequestDatabase({ connectionString: CONNECTION_STRING })
        )
      );
      const order: string[] = [];
      const first = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      }).then((resource) => {
        order.push("first");
        return resource;
      });
      const second = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      }).then((resource) => {
        order.push("second");
        return resource;
      });
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS - 1
      );
      expect(driver.clients).toHaveLength(
        REQUEST_DATABASE_POOL_MAX_CONNECTIONS
      );

      await resources[0]!.close();
      const firstResource = await first;
      expect(order).toEqual(["first"]);
      await resources[1]!.close();
      const secondResource = await second;
      expect(order).toEqual(["first", "second"]);
      expect(driver.clients).toHaveLength(
        REQUEST_DATABASE_POOL_MAX_CONNECTIONS + 2
      );

      // Both waiters own handed-over slots: the pool is still full.
      const timedOut = expect(
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      ).rejects.toBeInstanceOf(RequestDatabaseCapacityError);
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS
      );
      await timedOut;
      await Promise.all(
        [...resources.slice(2), firstResource, secondResource].map(
          ({ close }) => close()
        )
      );
      return expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a timed-out waiter so the next release frees the slot", async () => {
    const resources = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      )
    );
    await expectCapacityRejectionAfterWait();
    await resources[0]!.close();
    const replacement = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
    });
    return await Promise.all(
      [...resources.slice(1), replacement].map(({ close }) => close())
    );
  });

  it("destroys a hung client socket and releases admission after the close timeout", async () => {
    vi.useFakeTimers();
    try {
      const diagnosticSink = vi.fn();
      const resources = await Promise.all(
        Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
          createRequestDatabase({
            connectionString: CONNECTION_STRING,
            diagnosticSink,
          })
        )
      );
      const hungClient = driver.clients[0]!;
      hungClient.end.mockReturnValueOnce(new Promise<void>(() => undefined));

      const outcome = resources[0]!.close().then(
        () => "resolved",
        (error: unknown) => error
      );
      const waiting = expect(
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      ).rejects.toBeInstanceOf(RequestDatabaseCapacityError);
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS
      );
      await waiting;
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CLOSE_TIMEOUT_MILLISECONDS -
          REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS -
          1
      );
      expect(hungClient.connection.stream.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toEqual(
        new Error("Request database client end timed out")
      );
      expect(hungClient.connection.stream.destroy).toHaveBeenCalledOnce();
      expect(diagnosticSink).toHaveBeenCalledExactlyOnceWith({
        code: "REQUEST_DATABASE_CLIENT_CLOSE_ERROR",
      });
      const replacement = await createRequestDatabase({
        connectionString: CONNECTION_STRING,
      });
      await Promise.all(
        [...resources.slice(1), replacement].map(({ close }) => close())
      );
      return expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases admission even when destroying a failed client socket throws", async () => {
    const resources = await Promise.all(
      Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      )
    );
    const closeFailure = new Error("close failed");
    driver.clients[0]!.end.mockRejectedValueOnce(closeFailure);
    driver.clients[0]!.connection.stream.destroy.mockImplementationOnce(() => {
      throw new Error("socket already gone");
    });

    await expect(resources[0]!.close()).rejects.toBe(closeFailure);
    const replacement = await createRequestDatabase({
      connectionString: CONNECTION_STRING,
    });
    return await Promise.all(
      [...resources.slice(1), replacement].map(({ close }) => close())
    );
  });

  describe("slot leases", () => {
    const MINUTE = 60_000;
    type Resource = Awaited<ReturnType<typeof createRequestDatabase>>;
    // Fills the pool; the first slot is a minute older than the other seven.
    const openFull = async (
      first: Readonly<{ route: string; diagnosticSink?: () => void }>
    ): Promise<Resource[]> => {
      const oldest = await createRequestDatabase({
        connectionString: CONNECTION_STRING,
        ...first,
      });
      await vi.advanceTimersByTimeAsync(MINUTE);
      const rest = await Promise.all(
        Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS - 1 }, () =>
          createRequestDatabase({
            connectionString: CONNECTION_STRING,
            route: "/api/orpc/flow/collect",
          })
        )
      );
      return [oldest, ...rest];
    };
    // A request whose workerd context ended: its own timers (the age limit) never run.
    const withoutOwnTimers = async <Value>(
      open: () => Promise<Value>
    ): Promise<Value> => {
      const spy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(
          () => 0 as unknown as ReturnType<typeof setTimeout>
        );
      try {
        return await open();
      } finally {
        spy.mockRestore();
      }
    };
    // Under this block's fake clock: a full pool rejects after the 2 s wait.
    const expectCapacityRejection = async (): Promise<void> => {
      const rejected = expect(
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      ).rejects.toBeInstanceOf(RequestDatabaseCapacityError);
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS
      );
      await rejected;
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("ends a slot whose request never closes at the maximum age, from that request's own timer", async () => {
      // A canceled request whose work never settles keeps its scope open: before the age limit,
      // every later request got DATABASE_CAPACITY until the process restarted.
      const ownerSink = vi.fn();
      const resources = await openFull({
        diagnosticSink: ownerSink,
        route: "/api/orpc/optionsChain/chain",
      });
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS -
          MINUTE -
          REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS -
          1
      );
      await expectCapacityRejection();
      expect(ownerSink).not.toHaveBeenCalled();

      // The socket is gone already: the destroy throws, and the slot is freed anyway.
      driver.clients[0]!.connection.stream.destroy.mockImplementationOnce(
        () => {
          throw new Error("socket already gone");
        }
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(ownerSink).toHaveBeenCalledExactlyOnceWith({
        ageSeconds: REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS / 1000,
        code: "REQUEST_DATABASE_SLOT_RECLAIMED",
        route: "/api/orpc/optionsChain/chain",
      });
      expect(
        driver.clients[0]!.connection.stream.destroy
      ).toHaveBeenCalledOnce();
      const admitted = await createRequestDatabase({
        connectionString: CONNECTION_STRING,
      });

      // The late close ends nothing more and frees nothing: the pool is still full.
      await resources[0]!.close();
      expect(driver.clients[0]!.end).not.toHaveBeenCalled();
      expect(ownerSink).toHaveBeenCalledOnce();
      await expectCapacityRejection();
      await Promise.all(
        [...resources.slice(1), admitted].map(({ close }) => close())
      );
      return expect(vi.getTimerCount()).toBe(0);
    });

    // The oldest request's context ended (its own timers never run); seven younger ones are alive
    // and end their slots a minute after its reclaim age.
    const openFullWithDeadOldest = async (
      route: string
    ): Promise<[Resource, Resource[]]> => {
      const oldest = await withoutOwnTimers(() =>
        createRequestDatabase({ connectionString: CONNECTION_STRING, route })
      );
      await vi.advanceTimersByTimeAsync(MINUTE);
      const rest = await Promise.all(
        Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS - 1 }, () =>
          createRequestDatabase({ connectionString: CONNECTION_STRING })
        )
      );
      return [oldest, rest];
    };

    it("lets another request reclaim a slot whose own timer never ran", async () => {
      const [oldest, rest] = await openFullWithDeadOldest(
        "/api/orpc/optionsAnalytics/snapshot"
      );
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS -
          MINUTE -
          REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS -
          1
      );
      await expectCapacityRejection();
      await vi.advanceTimersByTimeAsync(1);
      const diagnosticSink = vi.fn();
      const admitted = await createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink,
      });
      expect(diagnosticSink).toHaveBeenCalledExactlyOnceWith({
        ageSeconds: REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS / 1000,
        code: "REQUEST_DATABASE_SLOT_RECLAIMED",
        route: "/api/orpc/optionsAnalytics/snapshot",
      });
      // The late close of the reclaimed slot frees nothing: the pool is still full.
      await oldest.close();
      await expectCapacityRejection();
      return await Promise.all([...rest, admitted].map(({ close }) => close()));
    });

    it("reclaims for a waiting request when a slot passes the reclaim age during its wait", async () => {
      const [oldest, rest] = await openFullWithDeadOldest(
        "/api/orpc/flow/events"
      );
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS - MINUTE - 1000
      );
      const diagnosticSink = vi.fn();
      const waiting = createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink,
      });
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS
      );
      const admitted = await waiting;
      expect(diagnosticSink).toHaveBeenCalledExactlyOnceWith({
        ageSeconds:
          (REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS + 1000) / 1000,
        code: "REQUEST_DATABASE_SLOT_RECLAIMED",
        route: "/api/orpc/flow/events",
      });
      return await Promise.all(
        [oldest, ...rest, admitted].map(({ close }) => close())
      );
    });

    it("names an unknown route and keeps admitting when the reclaim report throws", async () => {
      const resources = await withoutOwnTimers(async () => [
        await createRequestDatabase({
          connectionString: CONNECTION_STRING,
          route: "/named",
        }),
        ...(await Promise.all(
          Array.from(
            { length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS - 1 },
            () => createRequestDatabase({ connectionString: CONNECTION_STRING })
          )
        )),
      ]);
      await vi.advanceTimersByTimeAsync(
        REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS
      );
      const diagnosticSink = vi.fn(() => {
        throw new Error("sink failed");
      });
      const admitted = await createRequestDatabase({
        connectionString: CONNECTION_STRING,
        diagnosticSink,
      });
      // Every slot passed the reclaim age: all eight are reported and freed.
      expect(diagnosticSink).toHaveBeenCalledTimes(
        REQUEST_DATABASE_POOL_MAX_CONNECTIONS
      );
      expect(diagnosticSink).toHaveBeenCalledWith({
        ageSeconds: REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS / 1000,
        code: "REQUEST_DATABASE_SLOT_RECLAIMED",
        route: "unknown",
      });
      expect(diagnosticSink).toHaveBeenCalledWith(
        expect.objectContaining({ route: "/named" })
      );
      return await Promise.all(
        [...resources, admitted].map(({ close }) => close())
      );
    });

    it("lets a waiter's timeout remove only itself when clearTimeout from another request does nothing", async () => {
      // In workerd a release runs in the releasing request, where clearTimeout cannot see the
      // waiter's timer, so the timer of a waiter that got a slot still fires.
      vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
      const resources = await openFull({ route: "/a" });
      const first = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      });
      await vi.advanceTimersByTimeAsync(500);
      const second = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      });
      await vi.advanceTimersByTimeAsync(100);
      await resources[0]!.close();
      const firstResource = await first;
      // The first waiter's timer fires now; it must not drop the second waiter.
      await vi.advanceTimersByTimeAsync(1500);
      await resources[1]!.close();
      const secondResource = await second;
      return await Promise.all(
        [...resources.slice(2), firstResource, secondResource].map(
          ({ close }) => close()
        )
      );
    });

    it("skips a waiter whose own wait timer never ran, so the next waiter gets the slot", async () => {
      const resources = await openFull({ route: "/a" });
      // Its request context ended before its timer ran: in workerd that timer never fires.
      vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(
        () => 0 as unknown as ReturnType<typeof setTimeout>
      );
      const skipped = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      }).then(
        () => "admitted",
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(3000);
      const live = createRequestDatabase({
        connectionString: CONNECTION_STRING,
      });
      await vi.advanceTimersByTimeAsync(1);
      await resources[0]!.close();
      const liveResource = await live;
      // Skipped, it ends with DATABASE_CAPACITY (dropped in workerd when its context is gone).
      expect(await skipped).toBeInstanceOf(RequestDatabaseCapacityError);
      return await Promise.all(
        [...resources.slice(1), liveResource].map(({ close }) => close())
      );
    });

    it("frees the slot when the client cannot be constructed", async () => {
      const failure = new TypeError("invalid connection parameters");
      driver.failNextConstruction(failure);
      await expect(
        createRequestDatabase({ connectionString: CONNECTION_STRING })
      ).rejects.toBe(failure);
      const resources = await Promise.all(
        Array.from({ length: REQUEST_DATABASE_POOL_MAX_CONNECTIONS }, () =>
          createRequestDatabase({ connectionString: CONNECTION_STRING })
        )
      );
      return await Promise.all(resources.map(({ close }) => close()));
    });
  });

  it("runs migrations from the package folder unless explicitly overridden", async () => {
    const resource = createNodeDatabase({
      connectionString: CONNECTION_STRING,
    });

    await migrate(resource.db);
    expect(driver.runMigrations).toHaveBeenCalledWith(
      resource.db,
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/migrations$/),
      })
    );

    await migrate(resource.db, {
      migrationsFolder: "/tmp/darkfactory-migrations",
    });
    return expect(driver.runMigrations).toHaveBeenLastCalledWith(resource.db, {
      migrationsFolder: "/tmp/darkfactory-migrations",
    });
  });

  it("returns transaction results and preserves rollback rejections", async () => {
    const successfulDatabase = {
      transaction: vi.fn(
        async (operation: (tx: { marker: string }) => unknown) => {
          return operation({ marker: "transaction" });
        }
      ),
    };
    const result = await withTransaction(
      successfulDatabase as never,
      async (transaction) =>
        (transaction as unknown as { marker: string }).marker
    );
    expect(result).toBe("transaction");

    const rollbackError = new Error("roll back");
    const failingDatabase = {
      transaction: vi.fn(async () => {
        throw rollbackError;
      }),
    };
    return await expect(
      withTransaction(failingDatabase as never, async () => "unreachable")
    ).rejects.toBe(rollbackError);
  });

  it("propagates private Node pool close failures", async () => {
    const poolResource = createNodeDatabase({
      connectionString: CONNECTION_STRING,
    });
    const poolFailure = new Error("pool close failed");
    driver.pools[0]!.end.mockRejectedValueOnce(poolFailure);
    return await expect(poolResource.close()).rejects.toBe(poolFailure);
  });

  return it("propagates migration-provider failures without rewriting them", async () => {
    const resource = createNodeDatabase({
      connectionString: CONNECTION_STRING,
    });
    const migrationFailure = new Error("migration provider failed");
    driver.runMigrations.mockRejectedValueOnce(migrationFailure);

    await expect(migrate(resource.db)).rejects.toBe(migrationFailure);
    return expect(driver.runMigrations).toHaveBeenCalledWith(
      resource.db,
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/packages\/db\/migrations$/),
      })
    );
  });
});
