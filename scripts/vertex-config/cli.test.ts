import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizedNames,
  localDefaults,
  parseAssignments,
  serialize,
} from "./core.ts";

const effects = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: effects.spawnSync }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: effects.mkdirSync,
  writeFileSync: effects.writeFileSync,
  openSync: effects.openSync,
}));

const directories: string[] = [];
beforeEach(async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const child =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  effects.spawnSync.mockReset().mockImplementation(child.spawnSync);
  effects.mkdirSync.mockReset().mockImplementation(fs.mkdirSync);
  effects.writeFileSync.mockReset().mockImplementation(fs.writeFileSync);
  effects.openSync.mockReset().mockImplementation(fs.openSync);
  return;
});

const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "vertex-cli-orchestration-"));
  directories.push(base);
  const root = join(base, "trading", "vertex-research-platform");
  const sourceRoot = join(base, "trading", "gamma-forge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRoot, { mode: 0o700 });
  mkdirSync(join(base, "tools"), { mode: 0o700 });
  const initialized = effects.spawnSync("git", ["init", "--quiet", root], {
    stdio: "pipe",
  });
  expect(initialized.status).toBe(0);
  writeFileSync(join(root, ".gitignore"), ".env\nprivate/\n");
  const names = [
    ...new Set([...Object.keys(localDefaults()), ...authorizedNames]),
  ];
  writeFileSync(
    join(root, ".env.example"),
    names.map((name) => `${name}=\n`).join("")
  );
  const sourcePath = join(sourceRoot, ".env");
  const sourceContent =
    "QUANTDATA_API_KEY=fixture-consolidated\nIBKR_ACCOUNT_ID=fixture-excluded-from-projection\nUNRELATED_KEY=fixture-ignored\n";
  writeFileSync(sourcePath, sourceContent, { mode: 0o600 });
  const configuration = join(root, "private", "configuration");
  return {
    root,
    sourcePath,
    sourceContent,
    configuration,
    master: join(configuration, ".env"),
    report: join(configuration, "inventory.json"),
  };
};

const writeMaster = (root: string, content: string): void => {
  mkdirSync(join(root, "private", "configuration"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(root, "private", "configuration", ".env"), content, {
    mode: 0o600,
  });
};

const projectionArgs = (
  environment = "test",
  service = "research",
  names = "QUANTDATA_API_KEY"
) => {
  return [
    "project",
    "--environment",
    environment,
    "--service",
    service,
    "--keys",
    names,
  ];
};

const valuesAt = (path: string) => {
  return Object.fromEntries(
    parseAssignments(readFileSync(path, "utf8")).map(({ name, value }) => [
      name,
      value,
    ])
  );
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  return;
});

describe("Vertex configuration CLI boundary", () => {
  it("does not read, write, spawn, authenticate, or fetch on import", async () => {
    vi.resetModules();
    const network = vi.spyOn(globalThis, "fetch");
    const output = vi.spyOn(process.stdout, "write");
    await import("./cli.ts");
    expect(effects.spawnSync).not.toHaveBeenCalled();
    expect(effects.mkdirSync).not.toHaveBeenCalled();
    expect(effects.writeFileSync).not.toHaveBeenCalled();
    expect(effects.openSync).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    return expect(output).not.toHaveBeenCalled();
  });

  it("rejects unexpected arguments without touching source or destination files", async () => {
    const root = mkdtempSync(join(tmpdir(), "vertex-cli-test-"));
    directories.push(root);
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(["consolidate", "--source", "unapproved"], root, output)).toBe(
      1
    );
    expect(readdirSync(root)).toEqual([]);
    return expect(effects.spawnSync).not.toHaveBeenCalled();
  });

  return it("does not create partial files or disclose unknown filesystem errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "vertex-cli-test-"));
    directories.push(root);
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    effects.spawnSync.mockImplementationOnce(() => {
      throw new Error("fixture-sensitive-error");
    });
    expect(run(["consolidate"], root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: operation-failed\n"
    );
    expect(existsSync(join(root, ".env"))).toBe(false);
    return expect(readdirSync(root)).toEqual([]);
  });
});

describe("synthetic repository consolidation", () => {
  it("publishes private master, safe local defaults and a redacted inventory without altering sources", async () => {
    const { root, sourcePath, sourceContent, master, report, configuration } =
      fixture();
    const before = lstatSync(sourcePath);
    const output = { write: vi.fn() };
    const { run } = await import("./cli.ts");
    expect(run(["consolidate"], root, output)).toBe(0);
    expect(valuesAt(master)).toEqual({
      IBKR_ACCOUNT_ID: "fixture-excluded-from-projection",
      QUANTDATA_API_KEY: "fixture-consolidated",
    });
    expect(valuesAt(join(root, ".env"))).toEqual(localDefaults());
    const presence = JSON.parse(readFileSync(report, "utf8"));
    expect(presence).toMatchObject({
      blocked: false,
      validation: "not-performed",
      rejectedSources: [],
    });
    expect(presence.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "QUANTDATA_API_KEY",
          status: "selected",
          sources: ["gamma-forge/.env"],
        }),
      ])
    );
    expect(presence.missingSources).toContain("darkfactory/.env");
    expect(readFileSync(report, "utf8")).not.toContain("fixture-consolidated");
    expect(output.write).toHaveBeenCalledWith(
      "private/configuration/inventory.json: local credential-presence inventory; provider validation not performed.\n"
    );
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceContent);
    expect(lstatSync(sourcePath)).toMatchObject({
      ino: before.ino,
      mode: before.mode,
      mtimeMs: before.mtimeMs,
    });
    expect(readdirSync(configuration).sort()).toEqual([
      ".env",
      "inventory.json",
    ]);
    for (const path of [master, report, join(root, ".env")]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    return;
  });

  it("converges without rewriting unchanged files and preserves matching master entries", async () => {
    const { root, master, report } = fixture();
    const { consolidate } = await import("./cli.ts");
    consolidate(root);
    const originalMaster = lstatSync(master);
    const originalRoot = lstatSync(join(root, ".env"));
    consolidate(root);
    const stableReport = lstatSync(report);
    const reportContent = readFileSync(report, "utf8");
    consolidate(root);
    expect(lstatSync(master)).toMatchObject({
      ino: originalMaster.ino,
      mtimeMs: originalMaster.mtimeMs,
    });
    expect(lstatSync(join(root, ".env"))).toMatchObject({
      ino: originalRoot.ino,
      mtimeMs: originalRoot.mtimeMs,
    });
    expect(lstatSync(report)).toMatchObject({
      ino: stableReport.ino,
      mtimeMs: stableReport.mtimeMs,
    });
    expect(readFileSync(report, "utf8")).toBe(reportContent);
    return expect(JSON.parse(reportContent).entries[0].sources).toContain(
      "private/configuration/.env"
    );
  });

  it("atomically extends an existing master without removing previously selected credentials", async () => {
    const { root, sourcePath, master } = fixture();
    writeMaster(root, "QUANTDATA_API_KEY=fixture-consolidated\n");
    const before = lstatSync(master);
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const { consolidate } = await import("./cli.ts");
    consolidate(root);
    expect(valuesAt(master)).toEqual({
      QUANTDATA_API_KEY: "fixture-consolidated",
      IBKR_ACCOUNT_ID: "fixture-excluded-from-projection",
    });
    expect(lstatSync(master).ino).not.toBe(before.ino);
    return expect(readFileSync(sourcePath, "utf8")).toBe(sourceBefore);
  });

  it.each(["missing", "incomplete"])(
    "refuses a %s local schema before creating private files",
    async (kind) => {
      const { root, configuration } = fixture();
      if (kind === "missing") {
        rmSync(join(root, ".env.example"));
      } else writeFileSync(join(root, ".env.example"), "QUANTDATA_API_KEY=\n");
      const { run } = await import("./cli.ts");
      const output = { write: vi.fn() };
      expect(run(["consolidate"], root, output)).toBe(1);
      expect(output.write).toHaveBeenCalledWith(
        `vertex-config: ${kind === "missing" ? "missing-schema" : "local-schema-gap"}\n`
      );
      expect(existsSync(configuration)).toBe(false);
      return expect(existsSync(join(root, ".env"))).toBe(false);
    }
  );

  it("refuses a differing local configuration without overwriting it or publishing a master", async () => {
    const { root, master, report } = fixture();
    const original = "APP_URL=https://fixture.localhost\n";
    writeFileSync(join(root, ".env"), original, { mode: 0o600 });
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(["consolidate"], root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: existing-local-configuration-differs\n"
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(original);
    expect(existsSync(master)).toBe(false);
    return expect(existsSync(report)).toBe(false);
  });

  it("reports malformed sources without publishing even otherwise valid credentials", async () => {
    const { root, sourcePath, master, report } = fixture();
    const invalid =
      "QUANTDATA_API_KEY=fixture-must-not-publish\ninvalid assignment\n";
    writeFileSync(sourcePath, invalid);
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(["consolidate"], root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: consolidation-blocked\n"
    );
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
      blocked: true,
      rejectedSources: ["gamma-forge/.env"],
    });
    expect(readFileSync(report, "utf8")).not.toContain(
      "fixture-must-not-publish"
    );
    expect(existsSync(master)).toBe(false);
    expect(existsSync(join(root, ".env"))).toBe(false);
    return expect(readFileSync(sourcePath, "utf8")).toBe(invalid);
  });

  it("updates only the redacted report when a source conflicts with an existing master", async () => {
    const { root, master, report } = fixture();
    writeMaster(root, "QUANTDATA_API_KEY=fixture-existing\n");
    writeFileSync(report, "{}\n", { mode: 0o600 });
    writeFileSync(join(root, ".env"), serialize(localDefaults()), {
      mode: 0o600,
    });
    const originalRoot = lstatSync(join(root, ".env"));
    const originalMaster = lstatSync(master);
    const { run } = await import("./cli.ts");
    expect(run(["consolidate"], root, { write: vi.fn() })).toBe(1);
    expect(readFileSync(master, "utf8")).toBe(
      "QUANTDATA_API_KEY=fixture-existing\n"
    );
    expect(lstatSync(master).ino).toBe(originalMaster.ino);
    expect(lstatSync(join(root, ".env")).ino).toBe(originalRoot.ino);
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
      blocked: true,
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: "QUANTDATA_API_KEY",
          status: "conflict",
        }),
      ]),
    });
    return expect(readFileSync(report, "utf8")).not.toMatch(
      /fixture-existing|fixture-consolidated/
    );
  });

  return it("serializes the entire master before publishing any partial output", async () => {
    const { root, sourcePath, master, report } = fixture();
    writeFileSync(sourcePath, "QUANTDATA_API_KEY=fixture'\"`\n");
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(["consolidate"], root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: unrepresentable-value\n"
    );
    for (const path of [master, report, join(root, ".env")]) {
      expect(existsSync(path)).toBe(false);
    }
    return;
  });
});

describe("synthetic repository projection", () => {
  it("projects selected keys with disabled controls and never injects or executes them", async () => {
    const { root, master } = fixture();
    writeMaster(
      root,
      "QUANTDATA_API_KEY=fixture-projection\nIBKR_ACCOUNT_ID=fixture-broker\n"
    );
    const sourceBefore = readFileSync(master, "utf8");
    const network = vi.spyOn(globalThis, "fetch");
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(
      run(
        projectionArgs("test", "research", ",QUANTDATA_API_KEY,,"),
        root,
        output
      )
    ).toBe(0);
    const destination = join(
      root,
      "private/configuration/projections/test-research.env"
    );
    expect(valuesAt(destination)).toMatchObject({
      QUANTDATA_API_KEY: "fixture-projection",
      APP_ENV: "test",
      VERTEX_ORDER_SUBMISSION: "disabled",
      IBKR_RUNTIME_STATE: "disabled",
    });
    expect(valuesAt(destination)).not.toHaveProperty("IBKR_ACCOUNT_ID");
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    expect(output.write).toHaveBeenCalledWith(
      "private/configuration/projections/test-research.env: explicit disabled-runtime projection; not injected or executed.\n"
    );
    expect(readFileSync(master, "utf8")).toBe(sourceBefore);
    expect(network).not.toHaveBeenCalled();
    return expect(
      effects.spawnSync.mock.calls.every(([command]) => command === "git")
    ).toBe(true);
  });

  it("allows credential-free browser output in an existing projection directory but never overwrites it", async () => {
    const { root } = fixture();
    writeMaster(root, "");
    const destinationDirectory = join(
      root,
      "private/configuration/projections"
    );
    mkdirSync(destinationDirectory, { mode: 0o700 });
    const { run } = await import("./cli.ts");
    expect(
      run(projectionArgs("development", "browser", ""), root, {
        write: vi.fn(),
      })
    ).toBe(0);
    const destination = join(destinationDirectory, "development-browser.env");
    const before = readFileSync(destination, "utf8");
    const output = { write: vi.fn() };
    expect(
      run(projectionArgs("development", "browser", ""), root, output)
    ).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: target-changed\n"
    );
    expect(readFileSync(destination, "utf8")).toBe(before);
    return expect(readdirSync(destinationDirectory)).toEqual([
      "development-browser.env",
    ]);
  });

  it.each(["schema", "master"])(
    "requires the %s before constructing projection output",
    async (missing) => {
      const { root } = fixture();
      if (missing === "schema") {
        writeMaster(root, "QUANTDATA_API_KEY=fixture-only\n");
        rmSync(join(root, ".env.example"));
      }
      const { run } = await import("./cli.ts");
      const output = { write: vi.fn() };
      expect(run(projectionArgs(), root, output)).toBe(1);
      expect(output.write).toHaveBeenCalledWith(
        "vertex-config: missing-configuration\n"
      );
      return expect(
        existsSync(join(root, "private/configuration/projections"))
      ).toBe(false);
    }
  );

  it("rejects a conflicting master before deriving a destination", async () => {
    const { root } = fixture();
    writeMaster(
      root,
      "QUANTDATA_API_KEY=fixture-one\nQUANTDATA_API_KEY=fixture-two\n"
    );
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(projectionArgs(), root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: invalid-master\n"
    );
    return expect(
      existsSync(join(root, "private/configuration/projections"))
    ).toBe(false);
  });

  it.each([
    ["production", "research", "QUANTDATA_API_KEY", "invalid-environment"],
    ["test", "../../escape", "QUANTDATA_API_KEY", "forbidden-service"],
    ["test", "browser", "QUANTDATA_API_KEY", "forbidden-key"],
    ["test", "research", "FINANCIAL_DATASETS_API_KEY", "missing-key"],
  ])(
    "rejects unsafe projection %s/%s before filesystem publication",
    async (environment, service, names, error) => {
      const { root } = fixture();
      writeMaster(root, "QUANTDATA_API_KEY=fixture-only\n");
      const { run } = await import("./cli.ts");
      const output = { write: vi.fn() };
      expect(
        run(projectionArgs(environment, service, names), root, output)
      ).toBe(1);
      expect(output.write).toHaveBeenCalledWith(`vertex-config: ${error}\n`);
      return expect(
        existsSync(join(root, "private/configuration/projections"))
      ).toBe(false);
    }
  );

  it("refuses a destination that Git does not ignore", async () => {
    const { root } = fixture();
    writeMaster(root, "QUANTDATA_API_KEY=fixture-only\n");
    writeFileSync(join(root, ".gitignore"), ".env\n");
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(projectionArgs(), root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: destination-not-private\n"
    );
    return expect(
      existsSync(join(root, "private/configuration/projections"))
    ).toBe(false);
  });

  it("rejects a projection-directory symlink without writing into its target", async () => {
    const { root, master } = fixture();
    writeMaster(root, "QUANTDATA_API_KEY=fixture-only\n");
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "sentinel"), "fixture-original", {
      mode: 0o600,
    });
    symlinkSync(outside, join(root, "private/configuration/projections"));
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(projectionArgs(), root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: destination-not-private\n"
    );
    expect(readdirSync(outside)).toEqual(["sentinel"]);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe(
      "fixture-original"
    );
    return expect(readFileSync(master, "utf8")).toBe(
      "QUANTDATA_API_KEY=fixture-only\n"
    );
  });

  it("redacts projection-directory creation errors and leaves the master intact", async () => {
    const { root, master } = fixture();
    writeMaster(root, "QUANTDATA_API_KEY=fixture-only\n");
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    const destination = join(root, "private/configuration/projections");
    effects.mkdirSync.mockImplementation((path, options) => {
      if (path === destination)
        throw Object.assign(new Error("fixture-private-detail"), {
          code: "EACCES",
        });
      return original.mkdirSync(path, options);
    });
    const { run } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(run(projectionArgs(), root, output)).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: directory-failed\n"
    );
    expect(readFileSync(master, "utf8")).toBe(
      "QUANTDATA_API_KEY=fixture-only\n"
    );
    return expect(existsSync(destination)).toBe(false);
  });

  return it.each([0, 1, 3, 5])(
    "requires the exact projection command and flags at position %s",
    async (position) => {
      const root = mkdtempSync(join(tmpdir(), "vertex-cli-argv-"));
      directories.push(root);
      const args = projectionArgs();
      args[position] = "unexpected";
      const { run } = await import("./cli.ts");
      const output = { write: vi.fn() };
      expect(run(args, root, output)).toBe(1);
      expect(output.write).toHaveBeenCalledWith(
        expect.stringContaining("vertex-config: usage:")
      );
      expect(readdirSync(root)).toEqual([]);
      return expect(effects.spawnSync).not.toHaveBeenCalled();
    }
  );
});

describe("configuration process entrypoint", () => {
  it.each([false, undefined])(
    "keeps non-main imports inert even with invalid module metadata: %s",
    async (isMain) => {
      const { runConfigurationEntrypoint } = await import("./cli.ts");
      const output = { write: vi.fn() };
      const exitState = { exitCode: 7 };
      runConfigurationEntrypoint({
        isMain,
        argv: ["node", "cli", "consolidate"],
        moduleUrl: "invalid-url",
        output,
        exitState,
      });
      expect(exitState.exitCode).toBe(7);
      expect(output.write).not.toHaveBeenCalled();
      expect(effects.spawnSync).not.toHaveBeenCalled();
      expect(effects.mkdirSync).not.toHaveBeenCalled();
      expect(effects.openSync).not.toHaveBeenCalled();
      return expect(effects.writeFileSync).not.toHaveBeenCalled();
    }
  );

  it("derives the root from its module URL, strips the executable arguments, and propagates success", async () => {
    const { root, master } = fixture();
    const { runConfigurationEntrypoint } = await import("./cli.ts");
    const output = { write: vi.fn() };
    const exitState = { exitCode: 7 };
    const moduleUrl = pathToFileURL(
      join(root, "scripts", "vertex-config", "cli.ts")
    ).href;
    runConfigurationEntrypoint({
      isMain: true,
      argv: ["synthetic-runtime", "synthetic-entrypoint", "consolidate"],
      moduleUrl,
      output,
      exitState,
    });
    expect(exitState.exitCode).toBe(0);
    expect(valuesAt(master)).toMatchObject({
      QUANTDATA_API_KEY: "fixture-consolidated",
    });
    expect(valuesAt(join(root, ".env"))).toEqual(localDefaults());
    return expect(output.write).toHaveBeenCalledWith(
      "private/configuration/inventory.json: local credential-presence inventory; provider validation not performed.\n"
    );
  });

  it("propagates failure from the actual CLI without substituting a successful exit", async () => {
    const { root, master } = fixture();
    const { runConfigurationEntrypoint } = await import("./cli.ts");
    const output = { write: vi.fn() };
    const exitState = { exitCode: 0 };
    const moduleUrl = pathToFileURL(
      join(root, "scripts", "vertex-config", "cli.ts")
    ).href;
    runConfigurationEntrypoint({
      isMain: true,
      argv: ["synthetic-runtime", "synthetic-entrypoint", ...projectionArgs()],
      moduleUrl,
      output,
      exitState,
    });
    expect(exitState.exitCode).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      "vertex-config: missing-configuration\n"
    );
    expect(existsSync(master)).toBe(false);
    return expect(existsSync(join(root, "private"))).toBe(false);
  });

  it.each([undefined, "", "/synthetic/other-checkout"])(
    "denies reviewed modes when VERTEX_APPROVED_CHECKOUT is %j",
    async (approved) => {
      const { runVertexConfigCli } = await import("./cli.ts");
      const output = { write: vi.fn() };
      expect(
        runVertexConfigCli(
          ["bun", "scripts/vertex-config.ts", "consolidate", "--dry-run"],
          output,
          { VERTEX_APPROVED_CHECKOUT: approved }
        )
      ).toBe(1);
      expect(output.write).toHaveBeenCalledWith(
        "vertex-config: unapproved-inspection-location\n"
      );
      return expect(effects.openSync).not.toHaveBeenCalled();
    }
  );

  it("binds the root entry to this module and returns the exit code", async () => {
    const { runVertexConfigCli } = await import("./cli.ts");
    const output = { write: vi.fn() };
    expect(
      runVertexConfigCli(["bun", "scripts/vertex-config.ts", "project"], output)
    ).toBe(1);
    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining("vertex-config: usage:")
    );
    expect(effects.spawnSync).not.toHaveBeenCalled();
    expect(effects.mkdirSync).not.toHaveBeenCalled();
    return expect(effects.writeFileSync).not.toHaveBeenCalled();
  });
});
