import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));
const resolveServerWith = (conditions: readonly string[]) => {
  return spawnSync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
      "--input-type=module",
      "--eval",
      'process.stdout.write(import.meta.resolve("@darkfactory/db/server"))',
    ],
    { cwd: packageDirectory, encoding: "utf8" }
  );
};

describe("database package boundaries", () => {
  it("poisons browser-only resolution without importing Node or database vendors", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    );
    expect(manifest.exports["./server"]).toMatchObject({
      workerd: "./src/server/index.ts",
      worker: "./src/server/index.ts",
      browser: "./src/server/unsupported.ts",
    });
    expect(manifest.exports["./server/migration"]).toEqual({
      import: "./src/server/migration.ts",
      default: "./src/server/migration.ts",
    });
    expect(manifest.sideEffects).toEqual(["./src/server/unsupported.ts"]);

    const poisonSource = await readFile(
      new URL("./unsupported.ts", import.meta.url),
      "utf8"
    );
    expect(poisonSource).not.toMatch(/^\s*import\s/m);
    expect(poisonSource).not.toMatch(/drizzle|postgres|\bpg\b|node:/i);

    const result = resolveServerWith(["browser"]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(result.stdout).toMatch(/\/src\/server\/unsupported\.ts$/);
    return await expect(import("./unsupported.ts")).rejects.toThrow(
      "@darkfactory/db/server is unavailable in browser bundles"
    );
  });

  it("resolves the real server for workerd or worker before browser", () => {
    const workerd = resolveServerWith(["workerd", "browser"]);
    const worker = resolveServerWith(["worker", "browser"]);

    expect({ status: workerd.status, stderr: workerd.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(workerd.stdout).toMatch(/\/src\/server\/index\.ts$/);
    expect({ status: worker.status, stderr: worker.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    return expect(worker.stdout).toMatch(/\/src\/server\/index\.ts$/);
  });

  it("keeps Node-only migration code out of the Worker runtime entry", async () => {
    const [entrySource, clientSource] = await Promise.all([
      readFile(new URL("./index.ts", import.meta.url), "utf8"),
      readFile(new URL("./client.ts", import.meta.url), "utf8"),
    ]);
    expect(entrySource).not.toMatch(/\bmigrate\b|migration\.ts/);
    return expect(clientSource).not.toMatch(
      /node:url|node-postgres\/migrator|fileURLToPath|\brunMigrations\b/
    );
  });

  it("leaves operator workflow code to @darkfactory/jobs", async () => {
    const sourceDirectory = new URL("../", import.meta.url);
    const self = fileURLToPath(import.meta.url);
    const sources = (
      await readdir(sourceDirectory, { recursive: true, withFileTypes: true })
    ).filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const entry of sources) {
      const path = `${entry.parentPath}/${entry.name}`;
      if (path === self) continue;
      if (/workflow/i.test(await readFile(path, "utf8"))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    );
    return expect(Object.keys(manifest.exports).join()).not.toMatch(
      /workflow/i
    );
  });

  return it("keeps the schema export free of Node and PostgreSQL client imports", async () => {
    const schemaSource = await readFile(
      new URL("../schema/index.ts", import.meta.url),
      "utf8"
    );
    expect(schemaSource).not.toMatch(/from\s+["']node:/);
    return expect(schemaSource).not.toMatch(/from\s+["'](?:pg|postgres)["']/);
  });
});

describe("Drizzle CLI connection configuration", () => {
  let fixtureDirectory = "";

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "drizzle-config-"));
    await mkdir(join(fixtureDirectory, "src/server"), { recursive: true });
    await copyFile(
      join(packageDirectory, "src/server/connection-string.ts"),
      join(fixtureDirectory, "src/server/connection-string.ts")
    );
    await copyFile(
      join(packageDirectory, "drizzle.config.ts"),
      join(fixtureDirectory, "drizzle.config.ts")
    );
    await symlink(
      join(packageDirectory, "node_modules"),
      join(fixtureDirectory, "node_modules"),
      "dir"
    );
    await writeFile(
      join(fixtureDirectory, "package.json"),
      '{"type":"module"}'
    );
  });

  afterAll(async () => {
    if (fixtureDirectory !== "") {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("loads the real config in pinned Bun and parses strict TLS without connecting", async () => {
    const bunVersion = (
      await readFile(
        new URL("../../../../.bun-version", import.meta.url),
        "utf8"
      )
    ).trim();
    const connectionString =
      "postgresql://example:fixture@aws-us-east-1.horizon.psdb.cloud:6432/example?sslmode=verify-full&sslrootcert=system&application_name=fixture";
    const normalized =
      "postgresql://example:fixture@aws-us-east-1.horizon.psdb.cloud:6432/example?sslmode=verify-full&application_name=fixture";
    const result = spawnSync(
      "bun",
      [
        "--no-env-file",
        "--eval",
        `
          const assert = require("node:assert/strict");
          assert.equal(Bun.version, ${JSON.stringify(bunVersion)});
          const config = require("./drizzle.config.ts").default;
          assert.equal(config.dialect, "postgresql");
          assert.equal(config.strict, true);
          assert.equal(config.verbose, true);
          assert.equal(config.dbCredentials.url, ${JSON.stringify(normalized)});
          const { Client } = require("pg");
          const client = new Client({ connectionString: config.dbCredentials.url });
          assert.deepEqual(client.connectionParameters.ssl, {});
          assert.equal(client.connectionParameters.port, 6432);
          assert.equal(client._connecting, false);
          assert.equal(client._connected, false);
          process.stdout.write("drizzle-cli-system-roots-parsed");
        `,
      ],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], DATABASE_URL: connectionString },
        timeout: 30_000,
      }
    );
    expect({
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }).toEqual({
      status: 0,
      stderr: "",
      stdout: "drizzle-cli-system-roots-parsed",
    });
  });

  it.each([
    [
      "unrelated-host",
      "postgresql://localhost/example?sslmode=verify-full&sslrootcert=system",
    ],
    [
      "certificate-filename",
      "postgresql://example.pg.psdb.cloud/example?sslmode=verify-full&sslrootcert=custom.pem",
    ],
    [
      "non-strict-mode",
      "postgresql://example.pg.psdb.cloud/example?sslmode=require&sslrootcert=system",
    ],
    [
      "host-override",
      "postgresql://example.pg.psdb.cloud/example?sslmode=verify-full&sslrootcert=system&host=other.test",
    ],
  ])(
    "preserves unrelated or unsafe CLI connection options %s",
    (name, connectionString) => {
      const completionMarker = `drizzle-cli-preserved:${name}`;
      const result = spawnSync(
        "bun",
        [
          "--no-env-file",
          "--eval",
          `
          const assert = require("node:assert/strict");
          const config = require("./drizzle.config.ts").default;
          assert.equal(config.dbCredentials.url, process.env.DATABASE_URL);
          process.stdout.write(${JSON.stringify(completionMarker)});
        `,
        ],
        {
          cwd: fixtureDirectory,
          encoding: "utf8",
          env: { PATH: process.env["PATH"], DATABASE_URL: connectionString },
          timeout: 30_000,
        }
      );
      expect({
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      }).toEqual({
        status: 0,
        stderr: "",
        stdout: completionMarker,
      });
    }
  );

  it("keeps a missing DATABASE_URL as a CLI error without loading any environment file", () => {
    const result = spawnSync(
      "bun",
      [
        "--no-env-file",
        "--eval",
        `
          const assert = require("node:assert/strict");
          assert.equal(Object.hasOwn(process.env, "DATABASE_URL"), false);
          try {
            const config = require("./drizzle.config.ts").default;
            assert.equal(config.dialect, "postgresql");
          } catch (error) {
            assert.equal(Object.hasOwn(process.env, "DATABASE_URL"), false);
            assert.ok(error instanceof Error);
            assert.equal(error.message, "DATABASE_URL is required for Drizzle commands");
            process.stderr.write(error.message);
            process.stdout.write("drizzle-cli-missing-url-rejected");
            process.exit(1);
          }
        `,
      ],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] },
        timeout: 30_000,
      }
    );
    expect({
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }).toEqual({
      status: 1,
      stderr: "DATABASE_URL is required for Drizzle commands",
      stdout: "drizzle-cli-missing-url-rejected",
    });
  });
});
