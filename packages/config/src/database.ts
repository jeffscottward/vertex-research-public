// What: Database provider profiles and request endpoint validation (local vs Hyperdrive/production).
// Used by: apps/web/src/server/database-binding.ts, apps/web/src/server/request-scope.ts, apps/operator/src/server/operator-auth.ts.
// See: docs/debugging.md#symptom--where-to-look (validateRequestDatabaseEndpoint); docs/deploy.md#hyperdrive.
import type { AppEnvironment } from "./environment.ts";

export const DATABASE_PROVIDERS = [
  "postgres",
  "planetscale",
  "hyperdrive",
] as const;
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number];
export type DatabaseDeploymentProfile = "managed" | "standard";

/** The four parsed server env fields the database profile reads; ServerEnv satisfies it. */
export type DatabaseEnv = Readonly<{
  APP_ENV: AppEnvironment;
  DATABASE_PROVIDER: DatabaseProvider;
  DATABASE_URL?: string | undefined;
  DATABASE_ALLOWED_HOSTS: readonly string[];
}>;

export type DatabaseCompositionMetadata = Readonly<{
  provider: DatabaseProvider;
  deployment: DatabaseDeploymentProfile;
}>;

export type DatabaseConnectionContract = Readonly<{
  protocol: "postgresql";
  connectionString: string;
}>;

/** Structural request input so runtime bindings do not leak platform-specific types. */
export type DatabaseRequestBinding = Readonly<{
  connectionString: string;
  trustedPlatform: "cloudflare-hyperdrive";
}>;

export type DatabaseCompositionProfile = Readonly<{
  composition: DatabaseCompositionMetadata;
  connection: DatabaseConnectionContract;
}>;

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(`Invalid database configuration: ${message}`);
    this.name = "DatabaseConfigurationError";
  }
}

export type RequestDatabaseEndpointConfiguration = Readonly<{
  appEnvironment: AppEnvironment;
  provider: DatabaseProvider;
  /** DATABASE_URL; absent when a Hyperdrive binding supplies the connection. */
  connectionString: string | undefined;
  /** DATABASE_ALLOWED_HOSTS; production postgres must name its exact database host here. */
  allowedHosts?: readonly string[] | undefined;
}>;

export class RequestDatabaseEndpointError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string) {
    super(`Invalid request database endpoint: ${diagnostic}`);
    this.name = "RequestDatabaseEndpointError";
    this.diagnostic = diagnostic;
  }
}

const PLANETSCALE_POOLED_HOST_SUFFIXES = [
  ".pg.psdb.cloud",
  ".horizon.psdb.cloud",
] as const;
const PLANETSCALE_PGBOUNCER_PORT = "6432";
const POSTGRES_PRODUCTION_PORTS: Readonly<Record<string, true>> = {
  "5432": true,
  "6432": true,
};
// pg lets these query parameters replace the URL authority or credentials, which
// would bypass the host, port and allow-list checks.
const AUTHORITY_OVERRIDE_PARAMETERS: Readonly<Record<string, true>> = {
  host: true,
  hostaddr: true,
  port: true,
  user: true,
  password: true,
};
const DATABASE_ALLOWED_HOSTS_MAX_LENGTH = 8192;
const DATABASE_ALLOWED_HOSTS_MAX_COUNT = 32;
const DATABASE_HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const isTrustedDatabaseHostname = (hostname: string): boolean =>
  hostname.length <= 253 &&
  DATABASE_HOSTNAME_PATTERN.test(hostname) &&
  !hostname.endsWith(".localhost");

/** Operator-supplied trust only: never infer allowed hosts from DATABASE_URL. */
export const parseDatabaseAllowedHosts = (value: string): readonly string[] => {
  if (
    value.length > DATABASE_ALLOWED_HOSTS_MAX_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this rejects.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RequestDatabaseEndpointError(
      "DATABASE_ALLOWED_HOSTS must be at most 8192 characters without control characters"
    );
  }
  if (value.trim() === "") return Object.freeze([]);

  const entries = value.split(",");
  if (entries.length > DATABASE_ALLOWED_HOSTS_MAX_COUNT) {
    throw new RequestDatabaseEndpointError(
      "DATABASE_ALLOWED_HOSTS must contain at most 32 exact DNS hostnames"
    );
  }
  const hosts = entries.map((entry) => entry.trim().toLowerCase());
  if (
    hosts.some((hostname) => !isTrustedDatabaseHostname(hostname)) ||
    new Set(hosts).size !== hosts.length
  ) {
    throw new RequestDatabaseEndpointError(
      "DATABASE_ALLOWED_HOSTS must contain unique exact DNS hostnames; empty entries, IP addresses, localhost names, wildcards and URL components are not allowed"
    );
  }
  return Object.freeze(hosts);
};

const parsePostgresUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0
    ) {
      return url;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Canonical host as a socket would see it, or undefined when it is not a plain host.
 * postgres: URLs keep opaque hosts, so re-parse through a special scheme to apply
 * percent-decoding (as pg does) and IPv4 normalisation (127.1, 0x7f.1 → 127.0.0.1).
 */
const canonicalHostname = (hostname: string): string | undefined => {
  try {
    const host = new URL(`http://${decodeURIComponent(hostname)}/`);
    if (
      host.username !== "" ||
      host.password !== "" ||
      host.port !== "" ||
      host.pathname !== "/" ||
      host.search !== "" ||
      host.hash !== ""
    ) {
      return undefined;
    }
    const canonical = host.hostname.toLowerCase();
    return (canonical.endsWith(".") ? canonical.slice(0, -1) : canonical)
      .replace(/^\[/u, "")
      .replace(/\]$/u, "");
  } catch {
    return undefined;
  }
};

/** Loopback, `*.localhost`, unspecified and link-local hosts; anything unparseable counts as local. */
export const isLocalHostname = (hostname: string): boolean => {
  const host = canonicalHostname(hostname);
  return (
    host === undefined ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host) ||
    /^169\.254(?:\.\d{1,3}){2}$/u.test(host) ||
    /^::ffff:(?:7f[0-9a-f]{2}|a9fe):/u.test(host) ||
    /^fe[89ab][0-9a-f]:/u.test(host)
  );
};

const requireVerifiedUrl = (connectionString: string | undefined): URL => {
  const url =
    connectionString === undefined
      ? undefined
      : parsePostgresUrl(connectionString);
  if (url === undefined) {
    throw new RequestDatabaseEndpointError(
      "DATABASE_URL must be a PostgreSQL URL"
    );
  }

  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0]?.toLowerCase() !== "verify-full") {
    throw new RequestDatabaseEndpointError(
      "DATABASE_URL must use sslmode=verify-full in production"
    );
  }
  for (const name of url.searchParams.keys()) {
    if (AUTHORITY_OVERRIDE_PARAMETERS[name.toLowerCase()] !== true) continue;
    throw new RequestDatabaseEndpointError(
      "DATABASE_URL must not override connection authority through query parameters in production"
    );
  }
  return url;
};

const requirePlanetScalePooledEndpoint = (url: URL): void => {
  const hostname = url.hostname.toLowerCase();
  if (
    !PLANETSCALE_POOLED_HOST_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length
    )
  ) {
    throw new RequestDatabaseEndpointError(
      "Production PlanetScale DATABASE_URL must use a provider-managed hostname ending in .pg.psdb.cloud or .horizon.psdb.cloud"
    );
  }
  if (url.port !== PLANETSCALE_PGBOUNCER_PORT) {
    throw new RequestDatabaseEndpointError(
      "Production PlanetScale DATABASE_URL must use the provider-managed PgBouncer endpoint on port 6432; direct port 5432 is not allowed"
    );
  }
};

const requireAllowedPostgresHost = (
  url: URL,
  allowedHosts: readonly string[] | undefined
): void => {
  if (
    !Array.isArray(allowedHosts) ||
    allowedHosts.length === 0 ||
    allowedHosts.length > DATABASE_ALLOWED_HOSTS_MAX_COUNT ||
    allowedHosts.some(
      (host) => typeof host !== "string" || !isTrustedDatabaseHostname(host)
    ) ||
    new Set(allowedHosts).size !== allowedHosts.length
  ) {
    throw new RequestDatabaseEndpointError(
      "Production DATABASE_PROVIDER=postgres requires a nonempty, explicitly reviewed DATABASE_ALLOWED_HOSTS list of unique canonical DNS hostnames"
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    !(isTrustedDatabaseHostname(hostname) && allowedHosts.includes(hostname))
  ) {
    throw new RequestDatabaseEndpointError(
      "Production PostgreSQL DATABASE_URL authority must exactly match DATABASE_ALLOWED_HOSTS"
    );
  }
  if (POSTGRES_PRODUCTION_PORTS[url.port] !== true) {
    throw new RequestDatabaseEndpointError(
      "Production PostgreSQL DATABASE_URL must explicitly use port 5432 or PgBouncer port 6432"
    );
  }
};

export type DatabaseProviderProfile = Readonly<{
  deployment: DatabaseDeploymentProfile;
  /** What a passing production configuration guarantees; deploy checks print it. */
  productionRequirement: string;
  /** Throws RequestDatabaseEndpointError when DATABASE_URL breaks the production contract. */
  validateProductionUrl: (
    connectionString: string | undefined,
    allowedHosts: readonly string[] | undefined
  ) => void;
}>;

/** One row per provider: adding a provider means adding its production contract here. */
export const DATABASE_PROVIDER_PROFILES: Readonly<
  Record<DatabaseProvider, DatabaseProviderProfile>
> = Object.freeze({
  postgres: {
    deployment: "standard",
    productionRequirement:
      "Production web DATABASE_URL uses a non-local PostgreSQL host listed in DATABASE_ALLOWED_HOSTS on port 5432 or 6432 with sslmode=verify-full",
    validateProductionUrl: (connectionString, allowedHosts) => {
      const url = requireVerifiedUrl(connectionString);
      if (isLocalHostname(url.hostname)) {
        throw new RequestDatabaseEndpointError(
          "Production postgres DATABASE_URL must use a non-local host; loopback, *.localhost, unspecified and link-local addresses are rejected"
        );
      }
      requireAllowedPostgresHost(url, allowedHosts);
    },
  },
  planetscale: {
    deployment: "managed",
    productionRequirement:
      "Production web DATABASE_URL uses the provider-managed PlanetScale PgBouncer endpoint on port 6432 with sslmode=verify-full",
    validateProductionUrl: (connectionString) => {
      requirePlanetScalePooledEndpoint(requireVerifiedUrl(connectionString));
    },
  },
  hyperdrive: {
    deployment: "managed",
    productionRequirement:
      "Production web connects through the Cloudflare Hyperdrive HYPERDRIVE binding and DATABASE_URL is absent",
    validateProductionUrl: (connectionString) => {
      // A second, direct origin URL next to the binding would be a silent bypass of Hyperdrive.
      if (connectionString === undefined) return;
      throw new RequestDatabaseEndpointError(
        "DATABASE_URL must be absent in production when DATABASE_PROVIDER=hyperdrive; the HYPERDRIVE binding supplies the connection"
      );
    },
  },
});

export const isDatabaseProvider = (value: unknown): value is DatabaseProvider =>
  (DATABASE_PROVIDERS as readonly unknown[]).includes(value);

const profileFor = (provider: DatabaseProvider): DatabaseProviderProfile => {
  if (isDatabaseProvider(provider)) return DATABASE_PROVIDER_PROFILES[provider];
  throw new DatabaseConfigurationError(
    `DATABASE_PROVIDER must be one of ${DATABASE_PROVIDERS.join(", ")}`
  );
};

export const validateRequestDatabaseEndpoint = (
  configuration: RequestDatabaseEndpointConfiguration
): void => {
  const profile = profileFor(configuration.provider);
  if (configuration.appEnvironment !== "production") return;
  profile.validateProductionUrl(
    configuration.connectionString,
    configuration.allowedHosts
  );
};

const getConnectionString = (
  env: DatabaseEnv,
  requestBinding?: DatabaseRequestBinding
): string => {
  if (
    requestBinding &&
    requestBinding.trustedPlatform !== "cloudflare-hyperdrive"
  ) {
    throw new DatabaseConfigurationError(
      "request binding must declare the trusted Cloudflare Hyperdrive platform"
    );
  }
  if (env.DATABASE_PROVIDER !== "hyperdrive") {
    if (requestBinding) {
      throw new DatabaseConfigurationError(
        `a HYPERDRIVE request binding requires DATABASE_PROVIDER=hyperdrive, not ${env.DATABASE_PROVIDER}`
      );
    }
    if (env.DATABASE_URL !== undefined) return env.DATABASE_URL;
    throw new DatabaseConfigurationError(
      `DATABASE_URL is required when DATABASE_PROVIDER=${env.DATABASE_PROVIDER}`
    );
  }
  if (!requestBinding) {
    throw new DatabaseConfigurationError(
      "DATABASE_PROVIDER=hyperdrive requires the HYPERDRIVE request binding"
    );
  }

  const connectionString = requestBinding.connectionString.trim();
  if (parsePostgresUrl(connectionString) !== undefined) return connectionString;

  throw new DatabaseConfigurationError(
    "request binding connectionString must be a PostgreSQL URL"
  );
};

export const composeDatabaseProfile = (
  env: DatabaseEnv,
  requestBinding?: DatabaseRequestBinding
): DatabaseCompositionProfile => {
  validateRequestDatabaseEndpoint({
    appEnvironment: env.APP_ENV,
    provider: env.DATABASE_PROVIDER,
    connectionString: env.DATABASE_URL,
    allowedHosts: env.DATABASE_ALLOWED_HOSTS,
  });
  return {
    composition: {
      provider: env.DATABASE_PROVIDER,
      deployment: profileFor(env.DATABASE_PROVIDER).deployment,
    },
    connection: {
      protocol: "postgresql",
      connectionString: getConnectionString(env, requestBinding),
    },
  };
};
