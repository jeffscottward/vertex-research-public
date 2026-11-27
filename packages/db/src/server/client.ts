// What: Postgres clients: createNodeDatabase for scripts/workers, createRequestDatabase with bounded pool per request.
// Used by: packages/db/src/server/request-scope.ts, scripts/database/index.ts, packages/jobs/src/server/pilot-worker.ts.
// See: docs/debugging.md#symptom--where-to-look (RequestDatabaseCapacityError, REQUEST_DATABASE_POOL_MAX_CONNECTIONS).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
// biome-ignore lint/performance/noNamespaceImport: Drizzle consumes the complete schema module object as its relational schema.
import * as schema from "../schema/index.ts";
import { normalizePlanetScaleSystemRoot } from "./connection-string.ts";
import {
  acquireRequestSlot,
  REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS,
  type RequestSlotLease,
  releaseRequestSlot,
} from "./request-slots.ts";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseExecutor = Database | Transaction;

export type DatabaseOptions = Readonly<{
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}>;

export type RequestDatabaseOptions = Pick<
  DatabaseOptions,
  "connectionString" | "connectionTimeoutMillis"
> &
  Readonly<{
    diagnosticSink?: RequestDatabaseDiagnosticSink;
    /** URL path of the request (no query string); named when its slot is reclaimed. */
    route?: string;
  }>;

export type DatabaseResource = Readonly<{
  db: Database;
  close: () => Promise<void>;
}>;

const drizzleDatabase = (client: Client | Pool): Database => {
  return drizzle({ client, schema });
};

const isCloudflareRuntime = (): boolean => {
  // Match pg 8.22's transport selection, including its legacy Response probe.
  if (
    typeof navigator === "object" &&
    navigator !== null &&
    typeof navigator.userAgent === "string"
  ) {
    return navigator.userAgent === "Cloudflare-Workers";
  }
  if (typeof Response !== "function") return false;
  const probeOptions = { cf: { thing: true }, status: 200 };
  const response = new Response(null, probeOptions);
  return (
    "cf" in response &&
    typeof response.cf === "object" &&
    response.cf !== null &&
    "thing" in response.cf &&
    Boolean(response.cf.thing)
  );
};

const parseSslNegotiation = (connectionString: string): string | undefined => {
  let negotiation: string | undefined;
  // Mirror pg-connection-string 2.14's URL preparation and last-value wins.
  // Do not invoke its full parser: that can read certificate files.
  if (connectionString.startsWith("/")) return negotiation;
  try {
    const prepared = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/iu.test(connectionString)
      ? encodeURI(connectionString).replace(/%25(\d\d)/gu, "%$1")
      : connectionString;
    let parsed: URL;
    try {
      parsed = new URL(prepared, "postgres://base");
    } catch {
      parsed = new URL(
        prepared.replace("@/", "@___DUMMY___/"),
        "postgres://base"
      );
    }
    for (const [key, value] of parsed.searchParams) {
      if (key === "sslnegotiation") negotiation = value;
    }
  } catch {
    throw new TypeError("Cloudflare database connection string is invalid");
  }
  return negotiation;
};

const assertSupportedRuntimeNegotiation = (connectionString: string): void => {
  if (!isCloudflareRuntime()) return;

  const negotiation = parseSslNegotiation(connectionString);
  // pg also uses this environment fallback for an absent or empty URL value.
  if ((negotiation || process.env["PGSSLNEGOTIATION"]) === "direct") {
    // pg-cloudflare 1.4 releases an outstanding reader during direct TLS.
    // Reject before Client/Pool construction; never weaken or rewrite TLS.
    throw new TypeError(
      "Cloudflare database connections do not support sslnegotiation=direct with the pinned pg driver"
    );
  }
};

export const createNodeDatabase = (
  options: DatabaseOptions
): DatabaseResource => {
  const connectionString = normalizePlanetScaleSystemRoot(
    options.connectionString
  );
  assertSupportedRuntimeNegotiation(connectionString);
  const pool = new Pool({
    connectionString,
    ...(options.maxConnections === undefined
      ? {}
      : { max: options.maxConnections }),
    ...(options.idleTimeoutMillis === undefined
      ? {}
      : { idleTimeoutMillis: options.idleTimeoutMillis }),
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
  });

  return {
    close: async () => {
      await pool.end();
    },
    db: drizzleDatabase(pool),
  };
};

const DEFAULT_REQUEST_CONNECTION_TIMEOUT_MILLISECONDS = 10_000;
const REQUEST_QUERY_TIMEOUT_MILLISECONDS = 10_000;
export const REQUEST_DATABASE_CLOSE_TIMEOUT_MILLISECONDS = 5000;
const UNSAFE_REQUEST_CONNECTION_STRING_PATTERN = /[\u0000-\u001f]|\u0020$/u;
// Reported for a request that names no route (the operator app, direct callers).
const ROUTE_NOT_GIVEN = "route-not-given";

export type RequestDatabaseDiagnostic =
  | Readonly<{
      code:
        | "REQUEST_DATABASE_CLIENT_ERROR"
        | "REQUEST_DATABASE_CLIENT_CLOSE_ERROR";
    }>
  | Readonly<{
      /** A slot older than REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS was taken back. */
      code: "REQUEST_DATABASE_SLOT_RECLAIMED";
      /** URL path of the request that held the slot; never a query string. */
      route: string;
      ageSeconds: number;
    }>;
export type RequestDatabaseDiagnosticSink = (
  diagnostic: RequestDatabaseDiagnostic
) => void;

const REQUEST_DATABASE_CLIENT_ERROR_DIAGNOSTIC =
  Object.freeze<RequestDatabaseDiagnostic>({
    code: "REQUEST_DATABASE_CLIENT_ERROR",
  });
const REQUEST_DATABASE_CLIENT_CLOSE_ERROR_DIAGNOSTIC =
  Object.freeze<RequestDatabaseDiagnostic>({
    code: "REQUEST_DATABASE_CLIENT_CLOSE_ERROR",
  });
const emitRequestDatabaseDiagnostic = (
  diagnosticSink: RequestDatabaseDiagnosticSink | undefined,
  diagnostic: RequestDatabaseDiagnostic
): void => {
  try {
    diagnosticSink?.(diagnostic);
  } catch {
    // A diagnostic failure must not turn a handled driver event into a crash.
  }
};

const assertSafeRequestConnectionString = (connectionString: string): void => {
  if (UNSAFE_REQUEST_CONNECTION_STRING_PATTERN.test(connectionString)) {
    throw new TypeError(
      "Request database connection strings cannot contain raw URL controls"
    );
  }

  const queryStart = connectionString.indexOf("?");
  if (queryStart === -1) return;

  const fragmentStart = connectionString.indexOf("#", queryStart + 1);
  const queryEnd =
    fragmentStart === -1 ? connectionString.length : fragmentStart;
  const queryParameters = new URLSearchParams(
    connectionString.slice(queryStart + 1, queryEnd)
  );
  if (queryParameters.has("query_timeout")) {
    throw new TypeError(
      "Request database connection strings cannot set query_timeout"
    );
  }
};

const endWithinCloseTimeout = async (client: Client): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.end(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Request database client end timed out"));
        }, REQUEST_DATABASE_CLOSE_TIMEOUT_MILLISECONDS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

type RequestClientLifecycle = Readonly<{
  close: () => Promise<void>;
  /** True once this request ends its client on purpose: socket errors after that are noise. */
  isClosing: () => boolean;
}>;

// Owns the end of one request client: `close` (end, and destroy when end fails or hangs) and
// the age limit. Both free the slot once.
const manageRequestClient = (
  client: Client,
  lease: RequestSlotLease,
  diagnosticSink: RequestDatabaseDiagnosticSink | undefined
): RequestClientLifecycle => {
  let closing = false;
  let closePromise: Promise<void> | undefined;
  // At the maximum age the request ends its own client. In workerd only the request that
  // opened a socket can end it, and its timers run while it is alive, also when its handler
  // waits for good on something another request owns.
  const ageLimit = setTimeout(() => {
    closing = true;
    // `close` clears this timer, so no close has started: a later close has nothing to end.
    closePromise = Promise.resolve();
    emitRequestDatabaseDiagnostic(diagnosticSink, {
      ageSeconds: REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS / 1000,
      code: "REQUEST_DATABASE_SLOT_RECLAIMED",
      route: lease.route,
    });
    try {
      client.connection.stream.destroy();
    } catch {
      // The socket is already unusable; freeing the slot is what matters.
    }
    releaseRequestSlot(lease);
  }, REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS);
  const close = (): Promise<void> => {
    closing = true;
    clearTimeout(ageLimit);
    closePromise ??= (async (): Promise<void> => {
      try {
        await endWithinCloseTimeout(client);
      } catch (error) {
        emitRequestDatabaseDiagnostic(
          diagnosticSink,
          REQUEST_DATABASE_CLIENT_CLOSE_ERROR_DIAGNOSTIC
        );
        try {
          // The forced disconnect pg's own end() uses for a hung query; nothing waits on the peer.
          client.connection.stream.destroy();
        } catch {
          // The socket is already unusable; releasing admission below is what matters.
        }
        throw error;
      } finally {
        // Release on every path: a rejected or hung end() used to leak the slot for the isolate's
        // lifetime. Release is once per lease, so a slot that was reclaimed is not freed twice.
        releaseRequestSlot(lease);
      }
    })();
    return closePromise;
  };
  return Object.freeze({ close, isClosing: () => closing });
};

export class RequestDatabaseCapacityError extends Error {
  override readonly name = "RequestDatabaseCapacityError";

  constructor() {
    super("Request database capacity is exhausted");
  }
}

export const createRequestDatabase = async (
  options: RequestDatabaseOptions
): Promise<DatabaseResource> => {
  assertSafeRequestConnectionString(options.connectionString);
  const diagnosticSink = options.diagnosticSink;
  const connectionString = normalizePlanetScaleSystemRoot(
    options.connectionString
  );
  assertSupportedRuntimeNegotiation(connectionString);
  const lease = await acquireRequestSlot({
    onReclaim: ({ ageSeconds, route }) =>
      emitRequestDatabaseDiagnostic(diagnosticSink, {
        ageSeconds,
        code: "REQUEST_DATABASE_SLOT_RECLAIMED",
        route,
      }),
    route: options.route ?? ROUTE_NOT_GIVEN,
  });
  if (lease === null) {
    throw new RequestDatabaseCapacityError();
  }
  const connectionTimeoutMillis =
    options.connectionTimeoutMillis ??
    DEFAULT_REQUEST_CONNECTION_TIMEOUT_MILLISECONDS;
  let client: Client;
  try {
    client = new Client({
      connectionString,
      connectionTimeoutMillis,
      query_timeout: REQUEST_QUERY_TIMEOUT_MILLISECONDS,
    });
  } catch (error) {
    releaseRequestSlot(lease);
    throw error;
  }
  const lifecycle = manageRequestClient(client, lease, diagnosticSink);
  client.on("error", () => {
    // The listener stays attached (an unhandled "error" event throws). Once this
    // request ends its own client, socket errors are teardown noise: on Workers
    // (pg-cloudflare 1.4.1), the read loop rejects "This socket has been closed." after
    // every end(). A real close failure is reported as CLIENT_CLOSE_ERROR instead.
    if (lifecycle.isClosing()) return;
    return emitRequestDatabaseDiagnostic(
      diagnosticSink,
      REQUEST_DATABASE_CLIENT_ERROR_DIAGNOSTIC
    );
  });
  const close = lifecycle.close;
  try {
    await client.connect();
  } catch (error) {
    try {
      await close();
    } catch {
      // The central close path reports the end failure.
    }
    throw error;
  }

  try {
    return {
      close,
      db: drizzleDatabase(client),
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
};

export const withTransaction = async <Result>(
  database: DatabaseExecutor,
  operation: (transaction: Transaction) => Promise<Result>
): Promise<Result> => database.transaction(operation);
