import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inventory,
  localDefaults,
  parseAssignments,
  project,
  serialize,
} from "./core.ts";
import { atomicPrivateWrite, writeProjection } from "./files.ts";
import {
  EnvironmentValidationError,
  getProviderCapabilities,
  parseServerEnv,
} from "../../packages/config/src/server.ts";

const directories: string[] = [];
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "vertex-config-test-"));
  directories.push(path);
  return path;
};

const schema =
  "QUANTDATA_API_KEY=\nFINANCIAL_DATASETS_API_KEY=\nIBKR_HOST=\nIBKR_PORT=\nIBKR_ACCOUNT_ID=\nDATABASE_URL=\nRESEND_API_KEY=\nJEV_API_TOKEN=\n";
const source = (content: string, label = "vertex-quant/.env") => ({
  label,
  content,
});

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
  return;
});

describe("Vertex credential inventory", () => {
  it("coalesces exact duplicate and quoted values without reporting material", () => {
    const result = inventory(schema, [
      source(
        "QUANTDATA_API_KEY='fixture-alpha'\nQUANTDATA_API_KEY=fixture-alpha\n"
      ),
    ]);
    expect(result.selected).toEqual({ QUANTDATA_API_KEY: "fixture-alpha" });
    expect(result.report.entries).toEqual([
      {
        name: "QUANTDATA_API_KEY",
        status: "selected",
        sources: ["vertex-quant/.env"],
        reference: false,
        present: true,
        equality: "identical",
      },
    ]);
    return expect(JSON.stringify(result.report)).not.toContain("fixture-alpha");
  });

  it("withholds conflicting duplicates within and across files", () => {
    const result = inventory(schema, [
      source(
        "QUANTDATA_API_KEY=fixture-alpha\nQUANTDATA_API_KEY=fixture-beta\n"
      ),
      source("QUANTDATA_API_KEY=fixture-alpha\n", "full-port/.env"),
    ]);
    expect(result.selected).toEqual({});
    expect(result.report.entries[0]).toEqual({
      name: "QUANTDATA_API_KEY",
      status: "conflict",
      sources: ["full-port/.env", "vertex-quant/.env"],
      reference: false,
      present: true,
      equality: "conflicting",
    });
    return expect(JSON.stringify(result.report)).not.toMatch(
      /fixture-alpha|fixture-beta/
    );
  });

  it("preserves 1Password references without resolving them and ignores example literals", () => {
    const result = inventory(schema, [
      source(
        "QUANTDATA_API_KEY=op://fixture/provider/key\n",
        "full-port/.env.schema"
      ),
      source(
        "FINANCIAL_DATASETS_API_KEY=example-key\n",
        "full-port/.env.example"
      ),
    ]);
    expect(result.selected).toEqual({
      QUANTDATA_API_KEY: "op://fixture/provider/key",
    });
    return expect(
      result.report.entries.find((entry) => entry.name === "QUANTDATA_API_KEY")
        ?.reference
    ).toBe(true);
  });

  it("keeps malicious shell text inert and round-trips dotenv values", () => {
    const root = directory();
    const marker = join(root, "must-not-exist");
    const value = `$(touch ${marker}); echo never-execute`;
    const entries = parseAssignments(
      `QUANTDATA_API_KEY='${value}'\nFINANCIAL_DATASETS_API_KEY="first\nsecond # literal"\n`
    );
    expect(entries[0]?.value).toBe(value);
    expect(
      parseAssignments(
        serialize(
          Object.fromEntries(entries.map((entry) => [entry.name, entry.value]))
        )
      )
    ).toEqual([...entries].sort((a, b) => a.name.localeCompare(b.name)));
    return expect(existsSync(marker)).toBe(false);
  });

  it("rejects malformed input atomically with redacted errors", () => {
    expect(() =>
      parseAssignments("QUANTDATA_API_KEY='fixture-secret' trailing\n")
    ).toThrow("invalid-dotenv");
    const result = inventory(schema, [
      source("QUANTDATA_API_KEY=fixture-alpha\nnot an assignment\n"),
    ]);
    expect(result.selected).toEqual({});
    return expect(result.report.rejectedSources).toEqual(["vertex-quant/.env"]);
  });

  it("does not copy live flags, SSH passwords, unsupported credentials, or old local DBs", () => {
    const result = inventory(schema, [
      source(
        "IBKR_TRADING_MODE=live\nQUANTVPS_SSH_PASSWORD=fixture-ssh\nIBKR_PASSWORD=fixture-login\nDATABASE_URL=postgresql://fixture:fixture@127.0.0.1:55432/darkfactory\nIB_GATEWAY_PORT=4002\n"
      ),
    ]);
    expect(result.selected).toEqual({ IBKR_PORT: "4002" });
    expect(
      result.report.entries.find((entry) => entry.name === "DATABASE_URL")
        ?.status
    ).toBe("ineligible");
    return expect(
      result.report.entries.find(
        (entry) => entry.name === "QUANTVPS_SSH_PASSWORD"
      )?.status
    ).toBe("excluded");
  });

  it("does not infer equality between a reference and a literal", () => {
    const result = inventory(schema, [
      source("QUANTDATA_API_KEY=op://fixture/provider/key\n"),
      source("QUANTDATA_API_KEY=fixture-alpha\n", "full-port/.env"),
    ]);
    expect(result.selected).toEqual({});
    return expect(result.report.entries[0]?.status).toBe("conflict");
  });

  it("blocks existing-master differences instead of silently replacing entries", () => {
    const result = inventory(
      schema,
      [source("QUANTDATA_API_KEY=fixture-alpha\n")],
      "QUANTDATA_API_KEY=fixture-beta\n"
    );
    expect(result.blocked).toBe(true);
    expect(result.selected).toEqual({});
    return expect(result.report.entries[0]?.status).toBe("conflict");
  });

  it("retains an exactly matching existing master entry", () => {
    const result = inventory(
      schema,
      [source("QUANTDATA_API_KEY=fixture-alpha\n")],
      "QUANTDATA_API_KEY=fixture-alpha\n"
    );
    expect(result.blocked).toBe(false);
    return expect(result.selected).toEqual({
      QUANTDATA_API_KEY: "fixture-alpha",
    });
  });

  it("requires canonical schema membership and safe source provenance", () => {
    expect(
      inventory("", [source("QUANTDATA_API_KEY=fixture-alpha\n")]).selected
    ).toEqual({});
    return expect(() =>
      inventory(schema, [
        source("QUANTDATA_API_KEY=fixture-alpha\n", "../../secret"),
      ])
    ).toThrow("invalid-source");
  });

  it("refuses serialization that cannot be losslessly represented", () => {
    expect(() => serialize({ QUANTDATA_API_KEY: "all quotes: '\"`" })).toThrow(
      "unrepresentable-value"
    );
    return expect(() =>
      serialize({ NEXT_PUBLIC_SECRET: "fixture-alpha" })
    ).toThrow("unsupported-name");
  });

  it("accepts BOM, blank lines, comments, exports and CRLF without inventing assignments", () => {
    expect(
      parseAssignments(
        "\uFEFF \t# fixture comment\r\n\r\n export QUANTDATA_API_KEY = 'fixture # literal' # ignored\r\n\t\n"
      )
    ).toEqual([{ name: "QUANTDATA_API_KEY", value: "fixture # literal" }]);
    expect(parseAssignments(" \t")).toEqual([]);
    return expect(parseAssignments("")).toEqual([]);
  });

  it.each([
    "QUANTDATA_API_KEY=fixture\0hidden",
    `QUANTDATA_API_KEY=${"x".repeat(1024 * 1024)}`,
    "QUANTDATA_API_KEY='fixture",
    'QUANTDATA_API_KEY="fixture\\',
    "QUANTDATA_API_KEY=`fixture",
  ])(
    "rejects bounded-parser violations without exposing content",
    (content) => {
      return expect(() => parseAssignments(content)).toThrow("invalid-dotenv");
    }
  );

  it("fails closed when a native dotenv parser would split one quoted assignment into extra keys", () => {
    const content =
      'QUANTDATA_API_KEY="fixture\\"\nUNRELATED_KEY=fixture-injection\n"\n';
    return expect(() => parseAssignments(content)).toThrow("invalid-dotenv");
  });

  it("distinguishes missing values from placeholders and malformed references", () => {
    const result = inventory(schema, [
      source(
        "QUANTDATA_API_KEY=\nFINANCIAL_DATASETS_API_KEY='   '\nRESEND_API_KEY=your_key\nJEV_API_TOKEN=op://incomplete\nDATABASE_URL=not-a-url\nUNRELATED_KEY=fixture-ignore\n"
      ),
    ]);
    expect(result.selected).toEqual({});
    expect(
      result.report.entries.map(({ name, status, equality }) => ({
        name,
        status,
        equality,
      }))
    ).toEqual([
      { name: "DATABASE_URL", status: "ineligible", equality: "unique" },
      {
        name: "FINANCIAL_DATASETS_API_KEY",
        status: "ineligible",
        equality: "absent",
      },
      { name: "JEV_API_TOKEN", status: "ineligible", equality: "unique" },
      { name: "QUANTDATA_API_KEY", status: "empty", equality: "absent" },
      { name: "RESEND_API_KEY", status: "ineligible", equality: "unique" },
    ]);
    return expect(
      result.report.entries.some(({ name }) => name === "UNRELATED_KEY")
    ).toBe(false);
  });

  it.each([
    "not an assignment",
    "UNRELATED_KEY=fixture-only\n",
    "AGNO_API_TOKEN=fixture-only\n",
    "QUANTDATA_API_KEY=\n",
    "QUANTDATA_API_KEY=placeholder\n",
    "DATABASE_URL=not-a-url\n",
  ])(
    "rejects an invalid existing master rather than dropping its values",
    (existing) => {
      return expect(() => inventory(schema, [], existing)).toThrow(
        "invalid-master"
      );
    }
  );

  it("accepts only the explicit PostgreSQL provider host boundary", () => {
    const accepted = inventory(schema, [
      source("DATABASE_URL=postgresql://fixture.pg.psdb.cloud/fixture\n"),
    ]);
    expect(accepted.selected["DATABASE_URL"]).toBe(
      "postgresql://fixture.pg.psdb.cloud/fixture"
    );
    for (const value of [
      "https://fixture.pg.psdb.cloud/fixture",
      "postgresql://fixture.pg.psdb.cloud.attacker.test/fixture",
      "postgresql://pg.psdb.cloud/fixture",
    ]) {
      expect(
        inventory(schema, [source(`DATABASE_URL=${value}\n`)]).selected
      ).toEqual({});
    }
    return;
  });

  return it("chooses a lossless alternative quote and never silently decodes escape sequences", () => {
    for (const value of [
      "fixture's value",
      "fixture's literal\\nsequence",
      "fixture'\"both",
      "fixture\\path",
    ]) {
      expect(parseAssignments(serialize({ QUANTDATA_API_KEY: value }))).toEqual(
        [{ name: "QUANTDATA_API_KEY", value }]
      );
    }
    expect(() => serialize({ QUANTDATA_API_KEY: "fixture\0value" })).toThrow(
      "unrepresentable-value"
    );
    return;
  });
});

describe("generated local runtime defaults", () => {
  const generatedEnv = () => ({
    ...Object.fromEntries(
      parseAssignments(serialize(localDefaults())).map(({ name, value }) => [
        name,
        value,
      ])
    ),
    DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:55478/vertex_fixture",
  });

  it("round-trips generated defaults through the server schema with only a synthetic database binding", () => {
    const env = parseServerEnv(generatedEnv());
    expect(env).toMatchObject({
      APP_ENV: "development",
      APP_URL: "https://darkfactory.localhost",
      BETTER_AUTH_URL: "https://darkfactory.localhost",
      DATABASE_PROVIDER: "postgres",
      VERTEX_MODE: "research",
      VERTEX_ACCESS_MODE: "read-only",
      VERTEX_ORDER_SUBMISSION: "disabled",
      IBKR_TRADING_MODE: "paper",
      IBKR_READ_ONLY: "true",
      IBKR_RECOVERY_POLICY: "human-trigger-only",
      EMAIL_TRANSPORT: "preview",
      STORAGE_ENABLED: false,
      OTEL_ENABLED: false,
    });
    const states = Object.entries(env).filter(([key]) =>
      key.endsWith("_RUNTIME_STATE")
    );
    expect(states).toHaveLength(10);
    expect(states.every(([_key, value]) => value === "disabled")).toBe(true);
    return expect(
      Object.values(getProviderCapabilities(env)).every((enabled) => !enabled)
    ).toBe(true);
  });

  // Since 9a805fc/e0cc088 the consumer schema admits plain HTTP only for a
  // portless *.localhost origin with APP_ENV=development; every other HTTP
  // origin, and *.localhost outside development, stays rejected.
  it("continues rejecting HTTP origins rather than weakening the consumer schema", () => {
    const issuesFor = (overrides: Record<string, string>) => {
      try {
        parseServerEnv({ ...generatedEnv(), ...overrides });
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentValidationError);
        return (error as EnvironmentValidationError).issues;
      }
      throw new Error("expected the HTTP origin to be rejected");
    };
    expect(
      issuesFor({
        APP_URL: "http://vertex.example.test",
        BETTER_AUTH_URL: "http://vertex.example.test",
        // A non-local APP_URL also refuses the public template secrets
        // (packages/config deployedSecretScope); keep this case on HTTPS only.
        BETTER_AUTH_SECRET: "independent-fixture-authentication-key-32",
        CONTACT_THROTTLE_SECRET: "independent-fixture-contact-throttle-key-32",
      })
    ).toEqual([
      { path: "APP_URL", message: "APP_URL must use HTTPS" },
      { path: "BETTER_AUTH_URL", message: "BETTER_AUTH_URL must use HTTPS" },
    ]);
    return expect(
      issuesFor({
        APP_ENV: "production",
        APP_URL: "http://darkfactory.localhost",
        BETTER_AUTH_URL: "http://darkfactory.localhost",
        DATABASE_PROVIDER: "planetscale",
        DATABASE_URL:
          "postgresql://fixture.pg.psdb.cloud:6432/vertex_fixture?sslmode=verify-full",
        BETTER_AUTH_SECRET: "independent-fixture-authentication-key-32",
        CONTACT_THROTTLE_SECRET: "independent-fixture-contact-throttle-key-32",
        EMAIL_PROVIDER: "disabled",
        EMAIL_TRANSPORT: "disabled",
      })
    ).toContainEqual({
      path: "APP_URL",
      message: "APP_URL may use http://*.localhost only in development",
    });
  });

  return it.each(["BETTER_AUTH_SECRET", "CONTACT_THROTTLE_SECRET"] as const)(
    "rejects the generated %s when promoted to production",
    (name) => {
      const value = localDefaults()[name]!;
      let failure: unknown;
      try {
        parseServerEnv({
          ...generatedEnv(),
          APP_ENV: "production",
          APP_URL: "https://vertex.example.test",
          BETTER_AUTH_URL: "https://vertex.example.test",
          DATABASE_PROVIDER: "planetscale",
          DATABASE_URL:
            "postgresql://fixture.pg.psdb.cloud:6432/vertex_fixture?sslmode=verify-full",
          BETTER_AUTH_SECRET: "independent-fixture-authentication-key-32",
          CONTACT_THROTTLE_SECRET:
            "independent-fixture-contact-throttle-key-32",
          EMAIL_PROVIDER: "disabled",
          EMAIL_TRANSPORT: "disabled",
          [name]: value,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EnvironmentValidationError);
      expect((failure as EnvironmentValidationError).issues).toEqual([
        {
          path: name,
          message: `${name} cannot use a development or public-template secret in production`,
        },
      ]);
      expect(JSON.stringify(failure)).not.toContain(value);
      return expect((failure as Error).message).not.toContain(value);
    }
  );
});

describe("explicit environment and service projection", () => {
  const bundle = {
    QUANTDATA_API_KEY: "fixture-data",
    IBKR_ACCOUNT_ID: "fixture-account",
    DATABASE_URL: "fixture-database",
    RESEND_API_KEY: "fixture-email",
  };

  it("only includes requested data keys and mandatory disabled controls", () => {
    const result = project(bundle, {
      environment: "development",
      service: "research",
      names: ["QUANTDATA_API_KEY"],
    });
    expect(result["QUANTDATA_API_KEY"]).toBe("fixture-data");
    expect(result["VERTEX_ORDER_SUBMISSION"]).toBe("disabled");
    expect(result["IBKR_RUNTIME_STATE"]).toBe("disabled");
    expect(result).not.toHaveProperty("DATABASE_URL");
    expect(result).not.toHaveProperty("RESEND_API_KEY");
    return expect(result).not.toHaveProperty("IBKR_ACCOUNT_ID");
  });

  it("prevents browser/client leakage and research broker/deployment access", () => {
    for (const service of ["browser", "research"]) {
      for (const name of [
        "IBKR_ACCOUNT_ID",
        "DATABASE_URL",
        "RESEND_API_KEY",
        "NEXT_PUBLIC_QUANTDATA_API_KEY",
      ]) {
        expect(() =>
          project(bundle, { environment: "test", service, names: [name] })
        ).toThrow("forbidden-key");
      }
    }
    return expect(() =>
      project(bundle, {
        environment: "test",
        service: "browser",
        names: ["QUANTDATA_API_KEY"],
      })
    ).toThrow("forbidden-key");
  });

  it("refuses forbidden services and invalid or production environments", () => {
    for (const service of [
      "broker",
      "deployment",
      "notification",
      "all",
      "__proto__",
    ]) {
      expect(() =>
        project(bundle, { environment: "development", service, names: [] })
      ).toThrow("forbidden-service");
    }
    for (const environment of [
      "production",
      "staging",
      "",
      "dev",
      "__proto__",
    ]) {
      expect(() =>
        project(bundle, { environment, service: "research", names: [] })
      ).toThrow("invalid-environment");
    }
    return;
  });

  it("does not produce partial output when any requested key is unavailable", () => {
    const target = join(directory(), ".env");
    expect(() =>
      writeProjection(target, bundle, {
        environment: "test",
        service: "research",
        names: ["QUANTDATA_API_KEY", "FINANCIAL_DATASETS_API_KEY"],
      })
    ).toThrow("missing-key");
    expect(existsSync(target)).toBe(false);
    return expect(readdirSync(join(target, ".."))).toEqual([]);
  });

  it.each([
    ["research", "QUANTDATA_API_KEY"],
    ["market-data", "FINANCIAL_DATASETS_API_KEY"],
    ["agno", "AGNO_API_TOKEN"],
    ["jev", "JEV_ALLOWED_ORIGINS"],
  ])(
    "permits only explicit selected keys for the %s service",
    (service, name) => {
      const values = {
        [name!]: "fixture-selected",
        QUANT_VPS_API_TOKEN: "fixture-never-project",
      };
      const selection = {
        environment: "test",
        service: service!,
        names: [name!],
      };
      expect(project(values, selection)).toMatchObject({
        APP_ENV: "test",
        [name!]: "fixture-selected",
        VERTEX_ACCESS_MODE: "read-only",
      });
      return expect(project(values, selection)).not.toHaveProperty(
        "QUANT_VPS_API_TOKEN"
      );
    }
  );

  return it("permits a credential-free browser projection and rejects inherited or blank keys", () => {
    expect(
      project(bundle, { environment: "test", service: "browser", names: [] })
    ).toMatchObject({ APP_ENV: "test", VERTEX_ORDER_SUBMISSION: "disabled" });
    const inherited = Object.create({
      QUANTDATA_API_KEY: "fixture-inherited",
    }) as Record<string, string>;
    for (const values of [
      inherited,
      { QUANTDATA_API_KEY: "" },
      { QUANTDATA_API_KEY: " \t" },
    ]) {
      expect(() =>
        project(values, {
          environment: "test",
          service: "research",
          names: ["QUANTDATA_API_KEY"],
        })
      ).toThrow("missing-key");
    }
    return;
  });
});

describe("atomic private files", () => {
  it("creates a complete 0600 file and leaves no temporary files", () => {
    const root = directory();
    const target = join(root, ".env");
    atomicPrivateWrite(target, "QUANTDATA_API_KEY=fixture-data\n", null);
    expect(readFileSync(target, "utf8")).toBe(
      "QUANTDATA_API_KEY=fixture-data\n"
    );
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    return expect(readdirSync(root)).toEqual([".env"]);
  });

  it("replaces an exactly expected target atomically while retaining 0600", () => {
    const root = directory();
    const target = join(root, ".env");
    writeFileSync(target, "original", { mode: 0o600 });
    atomicPrivateWrite(target, "replacement", "original");
    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    return expect(readdirSync(root)).toEqual([".env"]);
  });

  it("never changes an unexpected existing target", () => {
    const target = join(directory(), ".env");
    writeFileSync(target, "original", { mode: 0o600 });
    expect(() => atomicPrivateWrite(target, "replacement", null)).toThrow(
      "target-changed"
    );
    expect(() =>
      atomicPrivateWrite(target, "replacement", "unexpected")
    ).toThrow("target-changed");
    return expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("does not expose partial writes when preparation fails", () => {
    const root = directory();
    const target = join(root, ".env");
    writeFileSync(target, "original", { mode: 0o600 });
    const failBeforePublish = (): void => {
      throw new Error("fixture failure");
    };
    expect(() =>
      atomicPrivateWrite(target, "replacement", "original", failBeforePublish)
    ).toThrow("write-failed");
    expect(readFileSync(target, "utf8")).toBe("original");
    return expect(readdirSync(root)).toEqual([".env"]);
  });

  return it("rejects symlinks and insecure targets without modifying destinations", () => {
    const root = directory();
    const original = join(root, "original");
    writeFileSync(original, "original", { mode: 0o600 });
    symlinkSync(original, join(root, ".env"));
    expect(() =>
      atomicPrivateWrite(join(root, ".env"), "replacement", "original")
    ).toThrow("unsafe-path");
    expect(readFileSync(original, "utf8")).toBe("original");
    const insecure = join(root, "insecure");
    writeFileSync(insecure, "original", { mode: 0o644 });
    chmodSync(insecure, 0o644);
    return expect(() =>
      atomicPrivateWrite(insecure, "replacement", "original")
    ).toThrow("unsafe-path");
  });
});
