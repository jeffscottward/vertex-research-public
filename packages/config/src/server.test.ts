import { describe, expect, it, vi } from "vitest";
import { CANONICAL_APP_URL, toClientEnv } from "./client.ts";
import * as database from "./database.ts";
import {
  EnvironmentValidationError,
  getProviderCapabilities,
  parseServerEnv,
  serverEnvSchema,
} from "./server.ts";

const validCoreEnv = (): Record<string, string> => ({
  DATABASE_URL:
    "postgresql://database.pg.psdb.cloud:6432/darkfactory_test?sslmode=verify-full",
  // Production postgres requires an explicitly reviewed host allow-list.
  DATABASE_ALLOWED_HOSTS: "database.pg.psdb.cloud,db.example.com",
  BETTER_AUTH_SECRET: "a".repeat(32),
  CONTACT_THROTTLE_SECRET: "c".repeat(32),
});

const captureValidationError = (
  source: Record<string, string | undefined>
): EnvironmentValidationError => {
  try {
    parseServerEnv(source);
  } catch (error) {
    if (error instanceof EnvironmentValidationError) return error;
    throw error;
  }

  throw new Error("Expected environment validation to fail");
};

const developmentSecrets = [
  "vertex-local-development-only-not-a-production-secret",
  "vertex-local-development-only-contact-throttle-secret",
] as const;

const productionEnv = (): Record<string, string> => ({
  ...validCoreEnv(),
  APP_ENV: "production",
  APP_URL: "https://vertex.example.test",
  BETTER_AUTH_URL: "https://vertex.example.test",
  BETTER_AUTH_SECRET: "independent-fixture-authentication-key-32",
  CONTACT_THROTTLE_SECRET: "independent-fixture-contact-throttle-key-32",
  EMAIL_PROVIDER: "disabled",
  EMAIL_TRANSPORT: "disabled",
});

describe("parseServerEnv", () => {
  it.each(["BETTER_AUTH_SECRET", "CONTACT_THROTTLE_SECRET"] as const)(
    "rejects known development secrets in production %s with only field-specific diagnostics",
    (name) => {
      for (const secret of developmentSecrets) {
        for (const value of [secret, ` ${secret}\n`]) {
          const error = captureValidationError({
            ...productionEnv(),
            [name]: value,
          });
          expect(error.issues).toEqual([
            {
              path: name,
              message: `${name} cannot use a development or public-template secret in production`,
            },
          ]);
          expect(error.message).not.toContain(secret);
          expect(JSON.stringify(error.issues)).not.toContain(secret);
        }
      }
    }
  );

  it.each(["development", "test"])(
    "retains known local defaults under %s",
    (APP_ENV) => {
      const env = parseServerEnv({
        ...validCoreEnv(),
        APP_ENV,
        BETTER_AUTH_SECRET: developmentSecrets[0],
        CONTACT_THROTTLE_SECRET: developmentSecrets[1],
      });
      expect(env.BETTER_AUTH_SECRET).toBe(developmentSecrets[0]);
      return expect(env.CONTACT_THROTTLE_SECRET).toBe(developmentSecrets[1]);
    }
  );

  it.each(["BETTER_AUTH_SECRET", "CONTACT_THROTTLE_SECRET"] as const)(
    "rejects known development secrets in %s when a development build serves a non-local origin",
    (name) => {
      // QuantVPS serves the production build with APP_ENV=development on a
      // tailnet origin; public template secrets must not sign its sessions.
      const deployedOrigin = "https://vertex-host.example.test";
      for (const secret of developmentSecrets) {
        const error = captureValidationError({
          ...validCoreEnv(),
          APP_ENV: "development",
          APP_URL: deployedOrigin,
          BETTER_AUTH_URL: deployedOrigin,
          [name]: secret,
        });
        expect(error.issues).toEqual([
          {
            path: name,
            message: `${name} cannot use a development or public-template secret on a non-local APP_URL`,
          },
        ]);
        expect(error.message).not.toContain(secret);
      }
    }
  );

  it("accepts independent non-default synthetic production keys without enabling providers", () => {
    const source = productionEnv();
    const env = parseServerEnv(source);
    expect(env.BETTER_AUTH_SECRET).toBe(source["BETTER_AUTH_SECRET"]);
    expect(env.CONTACT_THROTTLE_SECRET).toBe(source["CONTACT_THROTTLE_SECRET"]);
    expect(env.BETTER_AUTH_SECRET).not.toBe(env.CONTACT_THROTTLE_SECRET);
    return expect(
      Object.values(getProviderCapabilities(env)).every((enabled) => !enabled)
    ).toBe(true);
  });

  it.each(["BETTER_AUTH_SECRET", "CONTACT_THROTTLE_SECRET"] as const)(
    "continues rejecting empty public-template %s fields in production",
    (name) => {
      const error = captureValidationError({ ...productionEnv(), [name]: "" });
      return expect(error.issues).toContainEqual({
        path: name,
        message: `${name} is required`,
      });
    }
  );
  it("accepts an optional absolute HTTPS Academy media base and rejects unsafe URLs", () => {
    const schema = serverEnvSchema.shape.VERTEX_ACADEMY_MEDIA_BASE_URL;
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("").success).toBe(true);
    expect(schema.safeParse("https://rig.example.test/reports").success).toBe(
      true
    );
    for (const value of [
      "/reports/academy-media",
      "http://rig.example.test/reports",
      "https://user:pass@rig.example.test/reports",
      "https://rig.example.test/reports?token=secret",
      "https://rig.example.test/reports#private",
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("keeps the Vertex baseline read-only with no runtime readiness claims", () => {
    const env = parseServerEnv(validCoreEnv());
    expect(env).toMatchObject({
      VERTEX_MODE: "research",
      VERTEX_ACCESS_MODE: "read-only",
      VERTEX_ORDER_SUBMISSION: "disabled",
      NAUTILUS_TRADING_MODE: "paper",
      IBKR_TRADING_MODE: "paper",
      IBKR_READ_ONLY: "true",
      IBKR_RECOVERY_POLICY: "human-trigger-only",
      NOTIFICATION_PROVIDER: "disabled",
      STORAGE_ENABLED: false,
    });
    const states = Object.entries(env).filter(([key]) =>
      key.endsWith("_RUNTIME_STATE")
    );
    expect(states).toHaveLength(10);
    return expect(states.every(([_key, value]) => value === "disabled")).toBe(
      true
    );
  });

  it.each([
    ["VERTEX_MODE", "live"],
    ["VERTEX_ACCESS_MODE", "read-write"],
    // "enabled" is a valid owner choice since 2026-11-04 (live order path); other values stay invalid.
    ["VERTEX_ORDER_SUBMISSION", "on"],
    ["NAUTILUS_TRADING_MODE", "live"],
    ["IBKR_TRADING_MODE", "live"],
    ["IBKR_READ_ONLY", "false"],
    ["IBKR_RECOVERY_POLICY", "automatic"],
    ["QUANT_RUNTIME_STATE", "ready"],
    ["JEV_RUNTIME_STATE", "available"],
  ])("rejects unsafe configuration %s", (key, value) => {
    const error = captureValidationError({ ...validCoreEnv(), [key]: value });
    return expect(error.issues.some(({ path }) => path === key)).toBe(true);
  });

  it("parses VERTEX_AGENT_VIEWER_EMAILS and refuses overlap with operators", () => {
    expect(
      parseServerEnv({
        ...validCoreEnv(),
        VERTEX_AGENT_VIEWER_EMAILS: "Viewer@Domain.test",
      }).VERTEX_AGENT_VIEWER_EMAILS
    ).toEqual(["viewer@domain.test"]);
    expect(parseServerEnv(validCoreEnv()).VERTEX_AGENT_VIEWER_EMAILS).toEqual(
      []
    );
    const overlap = captureValidationError({
      ...validCoreEnv(),
      VERTEX_OPERATOR_EMAILS: "op@domain.test",
      VERTEX_AGENT_VIEWER_EMAILS: "OP@domain.test",
    });
    expect(
      overlap.issues.some(({ path }) => path === "VERTEX_AGENT_VIEWER_EMAILS")
    ).toBe(true);
    const invalid = captureValidationError({
      ...validCoreEnv(),
      VERTEX_AGENT_VIEWER_EMAILS: "not-an-email",
    });
    return expect(
      invalid.issues.some(({ path }) => path === "VERTEX_AGENT_VIEWER_EMAILS")
    ).toBe(true);
  });

  it.each(["disabled", "unknown", "incompatible"])(
    "retains explicit runtime state %s without enabling providers",
    (runtimeState) => {
      const env = parseServerEnv({
        ...validCoreEnv(),
        QUANT_RUNTIME_STATE: runtimeState,
        QUANT_VPS_API_URL: "https://quant.example.test",
        QUANT_VPS_API_TOKEN: "fictional-token",
      });
      expect(env.QUANT_RUNTIME_STATE).toBe(runtimeState);
      expect(env.VERTEX_ORDER_SUBMISSION).toBe("disabled");
      return expect(getProviderCapabilities(env).ai).toBe(false);
    }
  );

  it("keeps configured provider names and local corpus paths out of client output", () => {
    const env = parseServerEnv({
      ...validCoreEnv(),
      QUANTDATA_API_KEY: "fictional-market-key",
      FINANCIAL_DATASETS_API_KEY: "fictional-financial-data-key",
      IBKR_ACCOUNT_ID: "fictional-paper-account",
      AGNO_API_TOKEN: "fictional-research-token",
      NTFY_TOPIC: "fictional-private-topic",
      JEV_API_TOKEN: "fictional-browser-token",
      RESEARCH_CORPUS_ROOT: "/private/example/corpora",
      SSRN_CORPUS_PATH: "/private/example/papers",
      QUANT_VPS_API_TOKEN: "",
    });
    expect(env.QUANTDATA_API_KEY).toBe("fictional-market-key");
    expect(env.QUANT_VPS_API_TOKEN).toBeUndefined();
    expect(Object.keys(toClientEnv(env))).toEqual([
      "APP_ENV",
      "APP_URL",
      "APP_NAME",
    ]);
    return expect(JSON.stringify(toClientEnv(env))).not.toMatch(
      /fictional|private/
    );
  });

  it("requires every R2 key when storage is enabled", () => {
    const error = captureValidationError({
      ...validCoreEnv(),
      STORAGE_ENABLED: "true",
      R2_BUCKET: "vertex-artifacts",
    });
    expect(error.issues.map(({ path }) => path)).toEqual([
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]);
    return expect(error.message).not.toContain("vertex-artifacts");
  });

  it.each([
    [
      "an invalid allow-list entry",
      { DATABASE_ALLOWED_HOSTS: "*.example.com" },
      "DATABASE_ALLOWED_HOSTS",
    ],
    [
      "a production postgres host outside the allow-list",
      {
        APP_ENV: "production",
        APP_URL: "https://vertex.example.test",
        BETTER_AUTH_URL: "https://vertex.example.test",
        EMAIL_PROVIDER: "disabled",
        EMAIL_TRANSPORT: "disabled",
        DATABASE_URL:
          "postgresql://other.example.com:5432/vertex?sslmode=verify-full",
      },
      "DATABASE_URL",
    ],
  ])("rejects %s", (_label, overrides, path) => {
    const error = captureValidationError({ ...validCoreEnv(), ...overrides });
    return expect(error.issues.some((issue) => issue.path === path)).toBe(true);
  });

  it("reports every missing core database and authentication variable", () => {
    const error = captureValidationError({});

    expect(error.message).toContain("DATABASE_URL");
    expect(error.message).toContain("BETTER_AUTH_SECRET");
    expect(error.message).toContain("CONTACT_THROTTLE_SECRET");
    return expect(error.issues.map(({ path }) => path)).toEqual([
      "BETTER_AUTH_SECRET",
      "CONTACT_THROTTLE_SECRET",
      "DATABASE_URL",
    ]);
  });

  it("reports a non-object environment at the stable root path", () => {
    const error = captureValidationError(null as never);

    expect(error.issues).toHaveLength(1);
    return expect(error.issues[0]?.path).toBe("environment");
  });

  it("rejects invalid core values without echoing their contents", () => {
    const invalidDatabaseUrl = "https://database.invalid/darkfactory";
    const shortAuthSecret = "s".repeat(8);
    const shortContactSecret = "c".repeat(8);
    const error = captureValidationError({
      DATABASE_URL: invalidDatabaseUrl,
      BETTER_AUTH_SECRET: shortAuthSecret,
      CONTACT_THROTTLE_SECRET: shortContactSecret,
    });

    expect(error.message).toContain("DATABASE_URL must be a PostgreSQL URL");
    expect(error.message).toContain(
      "BETTER_AUTH_SECRET must contain at least 32 characters"
    );
    expect(error.message).toContain(
      "CONTACT_THROTTLE_SECRET must contain at least 32 characters"
    );
    expect(error.message).not.toContain(invalidDatabaseUrl);
    expect(error.message).not.toContain(shortAuthSecret);
    return expect(error.message).not.toContain(shortContactSecret);
  });

  it("applies typed core defaults", () => {
    const env = parseServerEnv(validCoreEnv());

    expect(env).toMatchObject({
      APP_ENV: "development",
      APP_URL: CANONICAL_APP_URL,
      APP_NAME: "Vertex Research",
      DATABASE_PROVIDER: "postgres",
      BETTER_AUTH_URL: CANONICAL_APP_URL,
      AI_PROVIDER: "groq",
      EMAIL_PROVIDER: "resend",
      EMAIL_TRANSPORT: "preview",
      EMAIL_FROM: "Vertex Research <noreply@domain.test>",
      ANALYTICS_PROVIDER: "posthog",
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: "darkfactory-web",
    });
    return expect(typeof env.OTEL_ENABLED).toBe("boolean");
  });

  it("parses an optional bounded contact recipient and treats an empty value as disabled", () => {
    expect(
      parseServerEnv({
        ...validCoreEnv(),
        CONTACT_EMAIL_TO: "  support@example.test  ",
      }).CONTACT_EMAIL_TO
    ).toBe("support@example.test");
    return expect(
      parseServerEnv({
        ...validCoreEnv(),
        CONTACT_EMAIL_TO: "  ",
      }).CONTACT_EMAIL_TO
    ).toBeUndefined();
  });

  it.each([
    { label: "a malformed contact recipient", value: "not-an-email" },
    {
      label: "a contact recipient with injected headers",
      value: "support@example.test\r\nBcc: attacker@example.test",
    },
    {
      label: "an oversized contact recipient",
      value: `${"a".repeat(245)}@test.test`,
    },
  ])("rejects $label without echoing its value", ({ value }) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      CONTACT_EMAIL_TO: value,
    });

    expect(error.issues).toContainEqual({
      path: "CONTACT_EMAIL_TO",
      message:
        "CONTACT_EMAIL_TO must be a valid email address of at most 254 characters",
    });
    return expect(error.message).not.toContain(value);
  });

  it("accepts a mailbox or display mailbox sender and rejects header injection", () => {
    expect(
      parseServerEnv({
        ...validCoreEnv(),
        EMAIL_FROM: "DarkFactory Support <support@example.test>",
      }).EMAIL_FROM
    ).toBe("DarkFactory Support <support@example.test>");
    expect(
      parseServerEnv({
        ...validCoreEnv(),
        EMAIL_FROM: "support@example.test",
      }).EMAIL_FROM
    ).toBe("support@example.test");

    const injected =
      "DarkFactory <support@example.test>\r\nBcc: victim@example.test";
    const error = captureValidationError({
      ...validCoreEnv(),
      EMAIL_FROM: injected,
    });
    expect(error.issues).toContainEqual({
      path: "EMAIL_FROM",
      message: "EMAIL_FROM must be a header-safe mailbox or display mailbox",
    });
    return expect(error.message).not.toContain(injected);
  });

  it.each([
    ["an oversized sender", "x".repeat(401)],
    ["a sender without a mailbox", "DarkFactory Support"],
    ["an empty display name", "<support@example.test>"],
    ["an oversized display name", `${"x".repeat(101)} <support@example.test>`],
    ["an invalid display mailbox", "DarkFactory Support <invalid>"],
  ])("rejects $0 without reflecting it", (_label, value) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      EMAIL_FROM: value,
    });

    expect(error.issues).toContainEqual({
      path: "EMAIL_FROM",
      message: "EMAIL_FROM must be a header-safe mailbox or display mailbox",
    });
    return expect(error.message).not.toContain(value);
  });

  it.each([
    ["a malformed URL", "not a URL"],
    ["a PostgreSQL URL without a host", "postgresql:///darkfactory"],
  ])("rejects DATABASE_URL with $0", (_label, value) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      DATABASE_URL: value,
    });

    expect(error.issues).toContainEqual({
      path: "DATABASE_URL",
      message: "DATABASE_URL must be a PostgreSQL URL",
    });
    return expect(error.message).not.toContain(value);
  });

  it.each(["APP_URL", "BETTER_AUTH_URL"] as const)(
    "redacts a malformed credential-bearing %s",
    (name) => {
      const malformedUrl = "https://private-user:private-password@[invalid";
      const error = captureValidationError({
        ...validCoreEnv(),
        APP_ENV: "production",
        APP_URL: "https://app.darkfactory.example",
        BETTER_AUTH_URL: "https://app.darkfactory.example",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "r".repeat(32),
        [name]: malformedUrl,
      });

      expect(error.issues).toContainEqual({
        path: name,
        message: `${name} must be a valid URL`,
      });
      expect(error.message).not.toContain(malformedUrl);
      return expect(JSON.stringify(error.issues)).not.toContain(
        "private-password"
      );
    }
  );
  it("normalizes explicit booleans and rejects unsupported spellings", () => {
    expect(
      parseServerEnv({ ...validCoreEnv(), OTEL_ENABLED: " FALSE " })
        .OTEL_ENABLED
    ).toBe(false);
    expect(
      parseServerEnv({ ...validCoreEnv(), OTEL_ENABLED: "True" }).OTEL_ENABLED
    ).toBe(true);

    return expect(
      captureValidationError({
        ...validCoreEnv(),
        OTEL_ENABLED: "enabled",
      }).issues
    ).toContainEqual({
      path: "OTEL_ENABLED",
      message: "OTEL_ENABLED must be true or false",
    });
  });

  it("requires HTTPS before applying clean-origin validation", () =>
    expect(
      captureValidationError({
        ...validCoreEnv(),
        APP_URL: "http://app.domain.test",
        BETTER_AUTH_URL: "http://app.domain.test",
      }).issues
    ).toContainEqual({
      path: "APP_URL",
      message: "APP_URL must use HTTPS",
    }));
  it("keeps provider capabilities disabled when required variables are absent", () => {
    const env = parseServerEnv({
      ...validCoreEnv(),
      GROQ_API_KEY: "g".repeat(32),
      POSTHOG_KEY: "p".repeat(32),
    });

    expect(getProviderCapabilities(env)).toEqual({
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    });
    expect(env.GROQ_MODEL).toBeUndefined();
    expect(env.POSTHOG_HOST).toBeUndefined();
    return expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("parses disabled production email without a Resend key and reports delivery unavailable", () => {
    const env = parseServerEnv({
      ...validCoreEnv(),
      APP_ENV: "production",
      APP_URL: "https://staging.darkfactory.test",
      BETTER_AUTH_URL: "https://staging.darkfactory.test",
      EMAIL_PROVIDER: "disabled",
      EMAIL_TRANSPORT: "disabled",
      EMAIL_FROM: "DarkFactory Staging <noreply@darkfactory.test>",
    });

    expect(env.RESEND_API_KEY).toBeUndefined();
    return expect(getProviderCapabilities(env).emailDelivery).toBe(false);
  });

  it.each([
    {
      label: "disabled provider with an enabled transport",
      overrides: {
        EMAIL_PROVIDER: "disabled",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "r".repeat(32),
      },
    },
    {
      label: "enabled provider with the disabled transport",
      overrides: {
        EMAIL_PROVIDER: "resend",
        EMAIL_TRANSPORT: "disabled",
      },
    },
  ])("rejects $label", ({ overrides }) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      ...overrides,
    });

    return expect(error.issues).toContainEqual({
      path: "EMAIL_TRANSPORT",
      message: "EMAIL_PROVIDER and EMAIL_TRANSPORT must be disabled together",
    });
  });

  it("enables provider capabilities only after complete configuration", () => {
    const env = parseServerEnv({
      ...validCoreEnv(),
      GROQ_API_KEY: "g".repeat(32),
      GROQ_MODEL: "provider-model",
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
      POSTHOG_KEY: "p".repeat(32),
      POSTHOG_HOST: "https://analytics.invalid",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid/v1/traces",
    });

    return expect(getProviderCapabilities(env)).toEqual({
      ai: true,
      emailDelivery: true,
      analytics: true,
      telemetryExport: true,
    });
  });

  it("evaluates short-circuit capability operands without enabling partial providers", () => {
    const env = parseServerEnv(validCoreEnv());
    expect(getProviderCapabilities(env)).toEqual({
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    });

    const incompleteRuntimeEnv = {
      ...env,
      GROQ_MODEL: "configured-model",
      POSTHOG_HOST: "https://analytics.invalid",
      OTEL_ENABLED: false,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid/v1/traces",
      RESEND_API_KEY: "r".repeat(32),
    };
    return expect(getProviderCapabilities(incompleteRuntimeEnv)).toEqual({
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    });
  });

  it.each([
    {
      label: "an APP_URL with a trailing slash",
      overrides: { APP_URL: `${CANONICAL_APP_URL}/` },
      path: "APP_URL",
      message: "APP_URL must not have a trailing slash",
    },
    {
      label: "a BETTER_AUTH_URL with a trailing slash",
      overrides: { BETTER_AUTH_URL: `${CANONICAL_APP_URL}/` },
      path: "BETTER_AUTH_URL",
      message: "BETTER_AUTH_URL must not have a trailing slash",
    },
    {
      label: "an authentication URL that differs from the application URL",
      overrides: {
        BETTER_AUTH_URL: "https://auth.darkfactory.localhost",
      },
      path: "BETTER_AUTH_URL",
      message: "BETTER_AUTH_URL must match APP_URL",
    },
    {
      label: "an APP_URL with a path",
      overrides: { APP_URL: `${CANONICAL_APP_URL}/callback` },
      path: "APP_URL",
      message: "APP_URL must be a clean HTTPS origin",
    },
    {
      label: "an authentication URL with a query",
      overrides: {
        APP_URL: `${CANONICAL_APP_URL}?return=dashboard`,
        BETTER_AUTH_URL: `${CANONICAL_APP_URL}?return=dashboard`,
      },
      path: "BETTER_AUTH_URL",
      message: "BETTER_AUTH_URL must be a clean HTTPS origin",
    },
    {
      label: "remote email without its provider key",
      overrides: { EMAIL_TRANSPORT: "resend" },
      path: "RESEND_API_KEY",
      message: "RESEND_API_KEY is required when EMAIL_TRANSPORT is resend",
    },
    {
      label: "the preview email transport in production",
      overrides: { APP_ENV: "production" },
      path: "EMAIL_TRANSPORT",
      message: "EMAIL_TRANSPORT cannot use preview in production",
    },
  ])("rejects $label", ({ overrides, path, message }) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      ...overrides,
    });

    return expect(error.issues).toContainEqual({ path, message });
  });

  it.each([
    "https://darkfactory.localhost",
    "https://localhost",
    "https://127.0.0.1",
    "https://127.10.20.30",
    "https://0.0.0.0",
    "https://[::1]",
    "https://[::]",
    "https://localhost.",
    "https://app.darkfactory.localhost.",
    "https://[::ffff:127.0.0.1]",
    "https://169.254.169.254",
    "https://[fe80::1]",
  ])("rejects the local production origin %s", (applicationUrl) => {
    const error = captureValidationError({
      ...validCoreEnv(),
      APP_ENV: "production",
      APP_URL: applicationUrl,
      BETTER_AUTH_URL: applicationUrl,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
    });

    return expect(error.issues).toContainEqual({
      path: "APP_URL",
      message: "APP_URL cannot use a local origin in production",
    });
  });

  it.each([
    "postgresql://database.example/darkfactory",
    "postgresql://database.example/darkfactory?sslmode=disable",
    "postgresql://database.example/darkfactory?sslmode=require",
    "postgresql://database.example/darkfactory?sslmode=no-verify",
    "postgresql://database.example/darkfactory?sslmode=verify-ca",
    "postgresql://database.example/darkfactory?sslmode=verify-full&sslmode=disable",
  ])(
    "rejects production DATABASE_URL without verified TLS: %s",
    (databaseUrl) => {
      const applicationUrl = "https://app.darkfactory.example";
      const error = captureValidationError({
        ...validCoreEnv(),
        APP_ENV: "production",
        APP_URL: applicationUrl,
        BETTER_AUTH_URL: applicationUrl,
        DATABASE_URL: databaseUrl,
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "r".repeat(32),
      });

      return expect(error.issues).toContainEqual({
        path: "DATABASE_URL",
        message: "DATABASE_URL must use sslmode=verify-full in production",
      });
    }
  );

  it("requires the PlanetScale provider-managed PgBouncer endpoint in production", () => {
    const applicationUrl = "https://app.darkfactory.example";
    const directDatabaseUrl =
      "postgresql://private-user:private-password@database.pg.psdb.cloud:5432/darkfactory?sslmode=verify-full";
    const error = captureValidationError({
      ...validCoreEnv(),
      APP_ENV: "production",
      DATABASE_PROVIDER: "planetscale",
      APP_URL: applicationUrl,
      BETTER_AUTH_URL: applicationUrl,
      DATABASE_URL: directDatabaseUrl,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
    });

    expect(error.issues).toContainEqual({
      path: "DATABASE_URL",
      message: expect.stringMatching(/PgBouncer endpoint on port 6432/),
    });
    expect(error.message).not.toContain(directDatabaseUrl);
    return expect(error.message).not.toContain("private-password");
  });

  it.each([
    {
      label: "hyperdrive without DATABASE_URL in production",
      overrides: {
        APP_ENV: "production",
        DATABASE_PROVIDER: "hyperdrive",
        DATABASE_URL: undefined,
      },
      issue: undefined,
    },
    {
      label: "hyperdrive with a blank DATABASE_URL in production",
      overrides: {
        APP_ENV: "production",
        DATABASE_PROVIDER: "hyperdrive",
        DATABASE_URL: "  ",
      },
      issue: undefined,
    },
    {
      label: "hyperdrive without DATABASE_URL in development",
      overrides: { DATABASE_PROVIDER: "hyperdrive", DATABASE_URL: undefined },
      issue: undefined,
    },
    {
      label: "a remote verified postgres host in production",
      overrides: {
        APP_ENV: "production",
        DATABASE_URL:
          "postgresql://db.example.com:5432/darkfactory?sslmode=verify-full",
      },
      issue: undefined,
    },
    {
      label: "hyperdrive beside a direct DATABASE_URL in production",
      overrides: {
        APP_ENV: "production",
        DATABASE_PROVIDER: "hyperdrive",
        DATABASE_URL:
          "postgresql://db.example.com:5432/darkfactory?sslmode=verify-full",
      },
      issue:
        "DATABASE_URL must be absent in production when DATABASE_PROVIDER=hyperdrive; the HYPERDRIVE binding supplies the connection",
    },
    {
      label: "a loopback postgres host in production",
      overrides: {
        APP_ENV: "production",
        DATABASE_URL: "postgresql://127.1:5432/darkfactory?sslmode=verify-full",
      },
      issue:
        "Production postgres DATABASE_URL must use a non-local host; loopback, *.localhost, unspecified and link-local addresses are rejected",
    },
    {
      label: "postgres without DATABASE_URL",
      overrides: { DATABASE_PROVIDER: "postgres", DATABASE_URL: undefined },
      issue: "DATABASE_URL is required",
    },
    {
      label: "planetscale with a blank DATABASE_URL",
      overrides: { DATABASE_PROVIDER: "planetscale", DATABASE_URL: " " },
      issue: "DATABASE_URL is required",
    },
  ])("applies the database profile to $label", ({ overrides, issue }) => {
    const applicationUrl = "https://app.darkfactory.example";
    const source = {
      ...validCoreEnv(),
      APP_URL: applicationUrl,
      BETTER_AUTH_URL: applicationUrl,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
      ...overrides,
    };
    if (issue === undefined) {
      return expect(() => parseServerEnv(source)).not.toThrow();
    }
    return expect(captureValidationError(source).issues).toEqual([
      { path: "DATABASE_URL", message: issue },
    ]);
  });

  it("does not convert unexpected database endpoint validator failures", () => {
    const applicationUrl = "https://app.darkfactory.example";
    const unexpected = new Error("unexpected endpoint validator failure");
    const validate = vi
      .spyOn(database, "validateRequestDatabaseEndpoint")
      .mockImplementationOnce(() => {
        throw unexpected;
      });
    try {
      return expect(() =>
        parseServerEnv({
          ...validCoreEnv(),
          APP_ENV: "production",
          APP_URL: applicationUrl,
          BETTER_AUTH_URL: applicationUrl,
          EMAIL_TRANSPORT: "resend",
          RESEND_API_KEY: "r".repeat(32),
        })
      ).toThrow(unexpected);
    } finally {
      validate.mockRestore();
    }
  });

  it("redacts a malformed credential-bearing production database URL", () => {
    const malformedDatabaseUrl =
      "postgresql://private-user:private-password@[invalid";
    const applicationUrl = "https://app.darkfactory.example";
    const error = captureValidationError({
      ...validCoreEnv(),
      APP_ENV: "production",
      APP_URL: applicationUrl,
      BETTER_AUTH_URL: applicationUrl,
      DATABASE_URL: malformedDatabaseUrl,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
    });

    expect(error.issues).toContainEqual({
      path: "DATABASE_URL",
      message: "DATABASE_URL must be a PostgreSQL URL",
    });
    expect(error.message).not.toContain(malformedDatabaseUrl);
    return expect(JSON.stringify(error.issues)).not.toContain(
      "private-password"
    );
  });

  return it("accepts a complete production configuration", () => {
    const applicationUrl = "https://app.darkfactory.example";
    const env = parseServerEnv({
      ...validCoreEnv(),
      APP_ENV: "production",
      APP_URL: applicationUrl,
      BETTER_AUTH_URL: applicationUrl,
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "r".repeat(32),
    });

    expect(env.APP_URL).toBe(applicationUrl);
    return expect(getProviderCapabilities(env).emailDelivery).toBe(true);
  });
});

describe("toClientEnv", () =>
  it("returns an explicit public allowlist and redacts every server secret", () => {
    const databaseUrl = "postgresql://localhost/darkfactory_test";
    const authSecret = "a".repeat(32);
    const providerSecret = "g".repeat(32);
    const env = parseServerEnv({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: authSecret,
      CONTACT_THROTTLE_SECRET: "c".repeat(32),
      GROQ_API_KEY: providerSecret,
      GROQ_MODEL: "provider-model",
    });

    const clientEnv = toClientEnv(env);
    const serializedClientEnv = JSON.stringify(clientEnv);

    expect(clientEnv).toEqual({
      APP_ENV: "development",
      APP_URL: CANONICAL_APP_URL,
      APP_NAME: "Vertex Research",
    });
    expect(Object.keys(clientEnv)).toEqual(["APP_ENV", "APP_URL", "APP_NAME"]);
    expect(serializedClientEnv).not.toContain(databaseUrl);
    expect(serializedClientEnv).not.toContain(authSecret);
    expect(serializedClientEnv).not.toContain(providerSecret);
    expect(clientEnv).not.toHaveProperty("DATABASE_URL");
    expect(clientEnv).not.toHaveProperty("BETTER_AUTH_SECRET");
    return expect(clientEnv).not.toHaveProperty("GROQ_API_KEY");
  }));

describe("plain-HTTP localhost app origin", () => {
  const appUrlIssues = (
    APP_ENV: string,
    APP_URL: string
  ): readonly string[] => {
    try {
      parseServerEnv({
        ...validCoreEnv(),
        APP_ENV,
        APP_URL,
        BETTER_AUTH_URL: APP_URL,
      });
      return [];
    } catch (error) {
      if (!(error instanceof EnvironmentValidationError)) throw error;
      return error.issues
        .filter(
          (issue) =>
            issue.path === "APP_URL" || issue.path === "BETTER_AUTH_URL"
        )
        .map((issue) => `${issue.path}: ${issue.message}`);
    }
  };

  it("accepts http://*.localhost without a port in development", () =>
    expect(appUrlIssues("development", "http://vertex.localhost")).toEqual([]));

  it("rejects http://*.localhost outside development", () => {
    for (const environment of ["test", "production"]) {
      expect(appUrlIssues(environment, "http://vertex.localhost")).toContain(
        "APP_URL: APP_URL may use http://*.localhost only in development"
      );
    }
  });

  it("rejects other plain-HTTP origins in development", () => {
    for (const value of [
      "http://vertex.example",
      "http://vertex.localhost:3450",
    ]) {
      expect(appUrlIssues("development", value).length).toBeGreaterThan(0);
    }
  });
});

describe("development email capture", () => {
  const captureKey = Buffer.alloc(32, 7).toString("base64url");
  const captureEnv = (
    overrides: Record<string, string>
  ): Record<string, string> => ({
    ...validCoreEnv(),
    DEV_EMAIL_PREVIEW_ENDPOINT: "http://127.0.0.1:43123/v1/capture",
    DEV_EMAIL_PREVIEW_KEY: captureKey,
    ...overrides,
  });

  it("accepts an exact loopback capture URL and canonical key in development", () => {
    const env = parseServerEnv(captureEnv({}));
    return expect(env.DEV_EMAIL_PREVIEW_ENDPOINT).toBe(
      "http://127.0.0.1:43123/v1/capture"
    );
  });

  it.each([
    ["outside development", { APP_ENV: "test" }, "DEV_EMAIL_PREVIEW_ENDPOINT"],
    [
      "a non-preview transport",
      { EMAIL_TRANSPORT: "disabled", EMAIL_PROVIDER: "disabled" },
      "DEV_EMAIL_PREVIEW_ENDPOINT",
    ],
    [
      "a non-loopback capture host",
      { DEV_EMAIL_PREVIEW_ENDPOINT: "http://10.0.0.1:43123/v1/capture" },
      "DEV_EMAIL_PREVIEW_ENDPOINT",
    ],
    [
      "a non-canonical capture URL",
      { DEV_EMAIL_PREVIEW_ENDPOINT: "http://127.0.0.1:043123/v1/capture" },
      "DEV_EMAIL_PREVIEW_ENDPOINT",
    ],
    [
      "a short capture key",
      { DEV_EMAIL_PREVIEW_KEY: "short" },
      "DEV_EMAIL_PREVIEW_KEY",
    ],
  ])("rejects %s", (_label, overrides, path) => {
    const error = captureValidationError(captureEnv(overrides));
    expect(error.issues.some((issue) => issue.path === path)).toBe(true);
    return expect(error.message).not.toContain(captureKey);
  });
});
